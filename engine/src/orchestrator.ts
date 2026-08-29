// ── Native Agent Engine multi-agent orchestrator ──────────────────────────
// GUARDS → TRIAGE → PLAN → EXPLORE → [EXECUTE step ⇄ tools → VERIFY(review)
// → PROPOSAL(diff)]* → stuck? RE-PLAN → TASK END.
// Small-model doctrine: one job per agent; each step gets MINIMAL context
// (system + AGENTS.md rules + step detail + retrieval hits + pinned refs +
// ≤3 relevant messages — never whole history); strict TOOL_CALL/FINAL text
// protocol instead of native tool-calling; graded stuck detection forces
// re-plans instead of silent loops. Run-state persists around every LLM/tool
// call so crashes and approval pauses resume exactly where they stopped.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTwoFilesPatch } from "diff";
import { ChangeProposal, ChatMessage, ContextRef, FileDiff, PlanStep, RouteDecision, Session, StuckEvent, TaskRecord, TraceKind } from "./types.js";
import { loadSettings, NON_INTERACTIVE_ENV } from "./config.js";
import { chat, chatRace, chatSweep, LlmError, registry } from "./providers.js";
import type { ChatResult, RaceError, StreamDelta } from "./providers.js";
import { log, logger } from "./logger.js";
import { trace } from "./trace.js";
import { wire, createDeltaThrottle } from "./bus.js";
import { getSession, projectRoots, saveSession, newSession, listSessions } from "./sessions.js";
import { decideRoute, effectiveBreakerState, effectivePenalty, largestCtxHealthyModel, recordEmptyOutcome, recordOutcome } from "./router.js";
import type { RouterRole } from "./router.js";
import { executeTool, toolRequiresApproval, TOOL_SPECS, toolSchemasForApi, normalizeTool, setDelegateRunner, type DelegateInput, type ExecuteToolResult } from "./tools.js";
import { buildSystemPrompt, estTokens, maybeCompact, renderContextBlock, resolvePinnedRefs } from "./context.js";
import { parseUnifiedPatch } from "./apply.js";
import { loadProjectRules } from "./rules.js";
import { putProposal, gatedAppliedPaths, resetGatedAppliedPaths, listProposals } from "./proposals.js";
import { ensureFresh, retrieve, beginTaskWindow, endTaskWindow } from "./retrieval.js";
import type { RetrievalHit } from "./retrieval.js";
import { PLANNER_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, EXPLORER_PROMPT, CONDUCTOR_PROMPT, CRITIC_PROMPT, SYNTHESIZER_PROMPT } from "./prompts.js";
import { computeRepoMap, renderRepoMap } from "./repomap.js";
import { extractAllActions, parseAction } from "./actions.js";
import { Compactor } from "./compaction.js";
import { feed as liveFeed, newLiveCodeState } from "./livecode.js";
import { recordCheckpointFile } from "./checkpoints.js";
import { auditStep, auditLabel, type AuditReport } from "./audit.js";
import {
  getWorker, workerToRole, poolManifest, parseConductorPlan, buildScopedContext,
  parseCriticVerdict, isActionLoop, clearActionHashes, buildWorkerSystemPrompt,
  type ConductorWorkflowStep, type WorkerSpec,
} from "./conductor.js";

const TASK_MAX_MS = 2_400_000; // wall-clock cap (2400s; eval allows 2700)
const PER_STEP_TIMEOUT_MS = 600_000; // per-step wall-clock cap (600s = 10 min)
const MAX_STEPS = 40;          // step-execution cap (attempts included)
const MAX_TOOL_CALLS = 20;     // per agent run (explorer uses fewer)
/** How many times a step may retry after an output was cut off at max_tokens. */
const MAX_TRUNCATION_RETRIES = 3;
const MAX_REPLANS = 3;
const STEP_ATTEMPTS_MAX = 3;
const RETRIEVAL_HITS = 6;
const PATCH_CHAR_CAP = 12_000;  // reviewer input budget (smart-truncated by truncatePatchForReview — never drops a file's existence)
const READONLY_TOOLS = new Set(["read_file", "read_range", "list_dir", "grep", "glob", "git_status", "git_diff", "web_search", "web_scrape"]);
// Wave 25: the explorer's pinned read-only allowlist (locator job only — it
// used to receive no allowlist, so despite "Read-only job" in its prompt it
// could call write_file/run_command). READONLY_TOOLS + semantic retrieval.
const EXPLORER_TOOLS = new Set([...READONLY_TOOLS, "retrieve_code"]);

/**
 * Native tool schemas to declare per role.
 *
 * The roster follows the ROLE, not the call site: a coder may use everything,
 * an explorer is pinned to the read-only set, and planner/reviewer/summarizer
 * declare nothing because they answer in JSON and must not call tools at all.
 *
 * Declaring these is what fixes tool-trained models. gpt-oss-20b emits a native
 * call whether or not tools are declared; with none declared the provider
 * rejects the request ("Tool choice is none, but model called a tool") and the
 * reply comes back with empty content, which the engine then mistook for prose.
 */
/**
 * Reasoning budget per role.
 *
 * The coder writes files, so its reasoning should decide the approach and stop
 * — a low budget stops it composing the file in reasoning first (observed:
 * 15-18s of thinking that contained the whole file, then a tool call that wrote
 * it again). The planner and reviewer produce judgement, not bulk text, so they
 * keep a normal budget.
 */
function reasoningEffortFor(role: RouterRole): "low" | "medium" | "high" | undefined {
  if (role === "coder" || role === "explorer") return "low";
  return undefined;
}

function nativeToolsFor(role: RouterRole): unknown[] | undefined {
  if (role === "coder") return toolSchemasForApi();
  if (role === "explorer") return toolSchemasForApi(EXPLORER_TOOLS);
  return undefined; // planner / reviewer / summarizer answer in JSON
}

type SysMsg = ChatMessage & { __sys?: string }; // carries system prompt out-of-band

/** Wave 25 streaming: push forwards live deltas to the wire; flush MUST be
 *  called right after the LLM call returns so the last coalesced chunk lands
 *  BEFORE the llm.call trace that tells the web store to seal the stream. */
interface StreamHook {
  /** Mirrors providers.StreamDelta — text, reasoning, and native tool-call
   *  argument fragments (the channel live-coding reads on tool-trained models). */
  push: (d: StreamDelta) => void;
  flush: () => void;
}
interface RunState {
  taskId: string; projectId: string; phase: "explore" | "step";
  stepIndex: number; attempts: number; partialMessages: ChatMessage[];
  pendingCall?: { name: string; args: Record<string, unknown> };
  savedAt: number;
}
const controllers = new Map<string, AbortController>();         // sessionId → cancel
const runStates = new Map<string, RunState>();
const snapshots = new Map<string, Map<string, string | null>>(); // taskId → relPath → pre-task content
const textHist = new Map<string, string[]>();                    // normalized assistant texts
const toolHist = new Map<string, { key: string; ok: boolean }[]>(); // "name:argsHash" outcomes
/**
 * taskId → files already credited to a salvaged step, so two parallel steps
 * cannot both claim authorship of the same file.
 */
const salvageClaims = new Map<string, Set<string>>();
const lastErrors = new Map<string, string[]>();                  // session-scoped, router input
/** Forge conductor: per-task step outputs for access-list scoped context.
 *  Keyed by taskId → stepId (numeric) → { workerId, output summary }. */
const stepOutputs = new Map<string, Map<number, { workerId: string; output: string }>>();
/** B44: per-task nudge queue. External actors (the router watchdog today; an
 *  HTTP route in wave 2) enqueue guidance for a RUNNING task; toolLoop drains
 *  the queue between LLM calls and injects each item as a user turn. */
const pendingNudges = new Map<string, string[]>();               // taskId → queued nudge texts
/** Live taskId → sessionId index, maintained by runTask/finalize. Lets
 *  enqueueNudge verify liveness without touching disk (runStates only exists
 *  while a toolLoop runs, so it alone would reject nudges queued during the
 *  planner/explore phases). */
const taskSessions = new Map<string, string>();

/** B44: queue a nudge for a running task. Returns true when the task is live
 *  in this process and the nudge was queued; false when there is nothing
 *  running to nudge (callers can surface that instead of pretending success).
 *  Wave 2 wires `POST /api/tasks/:id/message` to exactly this function — the
 *  signature is the contract. */
export function enqueueNudge(taskId: string, text: string): boolean {
  const t = text.trim();
  if (!taskId || !t) return false;
  const sessionId = taskSessions.get(taskId);
  if (!sessionId || !controllers.has(sessionId)) return false;
  const q = pendingNudges.get(taskId) ?? [];
  q.push(clip(t, 2_000));
  pendingNudges.set(taskId, q.slice(-10)); // bounded: last 10 nudges
  return true;
}

/** Drain (and clear) the queued nudges for one task. */
function drainNudges(taskId: string): string[] {
  const q = pendingNudges.get(taskId);
  if (!q || q.length === 0) return [];
  pendingNudges.delete(taskId);
  return q;
}

const uid = (): string => crypto.randomUUID();
const short = (): string => uid().slice(0, 8);
const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");
/** Hard-budget ceiling guard; null while under the cap. Cost caps alone are
 *  unenforceable on all-free catalogs (costUsd stays $0 forever — r2b-dash
 *  F-2), so Σ(in+out) tokens vs maxTokensPerTask trips the same abort path. */
export const budgetOver = (t: TaskRecord): string | null => {
  if (typeof t.budgetUsdCap === "number" && t.costUsd > t.budgetUsdCap)
    return `budget cap $${t.budgetUsdCap.toFixed(2)} exceeded ($${t.costUsd.toFixed(4)} used)`;
  const cap = t.maxTokensPerTask;
  if (typeof cap === "number") {
    const used = Object.values(t.tokensUsed ?? {}).reduce((n, u) => n + u.inTok + u.outTok, 0);
    if (used > cap) return `token cap ${cap} exceeded (${used} used)`;
  }
  return null;
};

interface EmitOpts {
  /** Span override: lifecycle PAIRS (agent.start/agent.end) share one span id
   *  so the dashboard's bucket-by-spanId close logic sees both halves (r4-tasks
   *  #5: per-event ids made agent.end land in a fresh bucket — spans never
   *  closed and pulsed "running" forever). */
  spanId?: string;
  parentId?: string; agentRole?: string; input?: unknown; output?: unknown;
  tokensIn?: number; tokensOut?: number; costUsd?: number; durationMs?: number; model?: string;
}
/** Critique #12: buildStepContext stashes each step's retrieval hits + pinned
 *  refs here (keyed by sessionId); emit() mirrors them onto agent.start and
 *  llm.call spans so the dashboard's "context per agent" lens is populated. */
const currentStepRefs = new Map<string, ContextRef[]>();
/** Trace-only emitter; returns span id for child linking. Undefined optional
 *  fields are dropped by JSON.stringify on persistence. SSE delivery happens
 *  exactly once via the trace→wire bridge in events.ts (B1/B2) — the manual
 *  wire.emit mirrors (trace + route) that used to live here are GONE, so
 *  tool.call/tool.result/llm.call/agent phases reach SSE once, not twice. */
function emit(session: Session, kind: TraceKind, label: string, o: EmitOpts = {}): string {
  const stepRefs = kind === "agent.start" || kind === "llm.call" ? currentStepRefs.get(session.id) : undefined;
  const full = trace.emit({
    sessionId: session.id, taskId: session.task?.id, spanId: o.spanId ?? short(), kind, label,
    // Same-span events must not self-parent (the forest builder would see a
    // cycle); parentId only links DISTINCT spans.
    parentId: o.spanId ? undefined : o.parentId, agentRole: o.agentRole, input: o.input, output: o.output,
    tokensIn: o.tokensIn, tokensOut: o.tokensOut, costUsd: o.costUsd,
    durationMs: o.durationMs, model: o.model,
    ...(stepRefs ? { contextRefs: stepRefs } : {}),
  });
  return full.spanId;
}
function pushError(sessionId: string, msg: string): void {
  lastErrors.set(sessionId, [...(lastErrors.get(sessionId) ?? []), clip(msg, 200)].slice(-10));
}
/** Critique #7/#8: task status transitions must reach the UI live; SSE
 *  consumers match on sessionId (taskId is an unrelated UUID). */
function emitTask(session: Session): void {
  const t = session.task;
  if (!t) return;
  wire.emit({ type: "task", task: t, sessionId: t.sessionId });
}
/** Stable hash of args (sorted keys) for repeat-call detection. */
function argsHash(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  return crypto.createHash("sha1").update(stable).digest("hex").slice(0, 12);
}
/** Normalized assistant text for identical-output loop detection. */
const normText = (t: string): string =>
  t.replace(/TOOL_CALL:[\s\S]*?(?=\n[A-Z_]+:|$)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Index of the '}' closing the '{' at `start`, respecting strings/escapes; -1 if unbalanced. */
export function matchJsonObjectEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/** JSON parse tolerant of fences, prose, and model "false starts". Free models
 *  ignore response_format and emit near-miss JSON like '{"{"steps":[…]}' (stray
 *  prefix) or '{"}steps":[…]}' (stray brace corrupting the opening key). We try
 *  the whole text, then a stray-brace repair, then every balanced '{…}' span
 *  (returning the LARGEST that parses, so a false start before the real object
 *  is skipped and a nested fragment never shadows the plan). */
export function parseJsonLoose<T>(text: string): T | null {
  const tryParse = (s: string): T | null => { try { return JSON.parse(s) as T; } catch { return null; } };
  const unthought = text
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<thought[\s\S]*?<\/thought>/gi, "");
  const stripped = unthought.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  // Repair a stray brace corrupting the opening key BEFORE parsing: '{"}steps":…}'
  // is technically valid JSON whose key is the garbage string "}steps", so it
  // would otherwise parse to the wrong shape and slip past the salvage.
  const t = stripped.replace(/\{"\}/g, '{"');
  const direct = tryParse(t);
  if (direct !== null) return direct;
  let best: { val: T; len: number } | null = null;
  for (let i = t.indexOf("{"); i !== -1; i = t.indexOf("{", i + 1)) {
    const end = matchJsonObjectEnd(t, i);
    if (end > i) {
      const val = tryParse(t.slice(i, end + 1));
      if (val !== null && (!best || end - i > best.len)) best = { val, len: end - i };
    }
  }
  return best ? best.val : null;
}

// ── Public surface ──────────────────────────────────────────────────────────
/** B9/B19: terminal = done | failed | stopped. Terminal tasks are never
 *  re-executed; they get archived to session.pastTasks when a new prompt
 *  starts (shared by runTask and ensureTask — ONE archiving rule). */
const isTerminalTask = (t: TaskRecord): boolean =>
  t.status === "done" || t.status === "failed" || t.status === "stopped";

/** B19: create (or reuse) the session's TaskRecord SYNCHRONOUSLY so HTTP
 *  responses carry the real task UUID before runTask starts. Reuses the B9
 *  archiving rule: a TERMINAL previous task is archived to pastTasks and a
 *  fresh record is created; a live/in-progress task is returned as-is.
 *  runTask's own `session.task ??=` then no-ops on the fresh record. */
export function ensureTask(session: Session, prompt: string): TaskRecord {
  const prev = session.task;
  if (prev && isTerminalTask(prev)) {
    session.pastTasks = [...(session.pastTasks ?? []), prev].slice(-25);
    session.task = undefined;
  }
  const now = Date.now();
  session.task ??= {
    id: uid(), sessionId: session.id, title: clip(prompt, 60), status: "planning",
    goal: prompt, createdAt: now, updatedAt: now,
    tokensUsed: {}, costUsd: 0, stepCount: 0, stuckEvents: [], meta: {},
  };
  return session.task;
}

export async function runTask(
  session: Session, userMessage: ChatMessage, opts?: { resumeFromStep?: number },
): Promise<{ done: boolean; aborted?: boolean; reason?: string }> {
  // B45: callers fire-and-forget runTask with .catch(trace-only) — a throw
  // BEFORE the try/finally block used to strand the freshly-created task in
  // "planning" forever (finally never runs, nothing marks it failed). Wrap
  // the WHOLE body so every early throw still lands in the finally that
  // reconciles status.
  try {
  if (controllers.has(session.id)) throw new Error(`task already running for session ${session.id}`);
  const settings = loadSettings();
  const startedAt = Date.now();
  // B9: a task in a TERMINAL status (done/failed/stopped) must never be
  // re-executed. Without this, a second prompt in the same session fell
  // through to drive() with the OLD plan and OLD goal, re-running every
  // already-done step and accumulating stepCount/budget across prompts.
  // Archive the finished record and start fresh for the new prompt.
  // (ensureTask — B19 — usually runs first via POST /api/tasks and has
  // already archived/created; this branch stays as the safety net for
  // callers that invoke runTask directly.)
  const prevTask = session.task;
  if (prevTask && isTerminalTask(prevTask) && opts?.resumeFromStep === undefined) {
    session.pastTasks = [...(session.pastTasks ?? []), prevTask].slice(-25);
    session.task = undefined;
  }
  if (!session.task?.plan?.length || opts?.resumeFromStep !== undefined) {
    session.task ??= {
      id: uid(), sessionId: session.id, title: clip(userMessage.content, 60), status: "planning",
      goal: userMessage.content, createdAt: startedAt, updatedAt: startedAt,
      tokensUsed: {}, costUsd: 0, budgetUsdCap: settings.budgetPerTaskUsd,
      stepCount: 0, stuckEvents: [], meta: {},
    };
  }
  const task = session.task;
  task.budgetUsdCap ??= settings.budgetPerTaskUsd;
  task.maxTokensPerTask ??= settings.maxTokensPerTask;
  // GUARD — hard budget ceiling (re-checked per step and per LLM call).
  const over = budgetOver(task);
  if (over) {
    // Low-item fix: this used to return silently — the UI showed a prompt go
    // nowhere with no explanation. Surface the halt in the transcript + trace.
    const haltMsg = `${over} — task halted before starting`;
    logger.warn("orchestrator", "task halted at budget ceiling before start", { sessionId: session.id, taskId: task.id, reason: over });
    emit(session, "error", haltMsg, { agentRole: "orchestrator", input: { budgetUsdCap: task.budgetUsdCap, costUsd: task.costUsd } });
    const m: ChatMessage = { id: uid(), role: "assistant", content: `**⚠ Task not started** — ${haltMsg}. Raise the budget/token cap in Settings or start a new session.`, at: Date.now(), meta: { errorCard: true } };
    session.messages.push(m);
    wire.emit({ type: "message", sessionId: session.id, message: m });
    saveSession(session);
    return { done: false, reason: `${over} — task halted` };
  }
  if (!session.messages.some((m) => m.id === userMessage.id)) session.messages.push(userMessage);

  const controller = new AbortController();
  controllers.set(session.id, controller);
  taskSessions.set(task.id, session.id); // B44: nudge liveness index
  logger.info("orchestrator", "task start", {
    sessionId: session.id, taskId: task.id, title: task.title,
    resumeFromStep: opts?.resumeFromStep ?? null, planSteps: task.plan?.length ?? 0,
  });
  emit(session, "task.start", `task: ${task.title}`, { input: { goal: task.goal, resumeFromStep: opts?.resumeFromStep ?? null } });
  // Wave 25: suppress retrieval drift-rebuilds while the task runs — the
  // agent's own writes used to trigger a FULL repo reindex before every step.
  // endTaskWindow (finally) rebuilds once if the project drifted.
  beginTaskWindow(session.projectId);
  try {
    const taskRoot = resolveProjectRoot(session);
    // Git workflow: isolate this task's commits on their own branch so the
    // user's branch is never written to and the whole task is one `checkout -`
    // away from being abandoned. Best-effort — non-git projects just proceed.
    const branchInfo = enterTaskBranch(taskRoot, task.id);
    if (branchInfo) {
      task.meta = { ...task.meta, gitBranch: branchInfo.branch, gitBranchFrom: branchInfo.from };
      emit(session, "task.start", `git: working on ${branchInfo.branch} (from ${branchInfo.from})`, {
        agentRole: "orchestrator", input: branchInfo,
      });
      logger.info("orchestrator", "task branch", { sessionId: session.id, taskId: task.id, ...branchInfo });
    }
    const ctx: RunCtx = { session, root: taskRoot, controller, deadline: startedAt + TASK_MAX_MS, startedAt, gitBaseline: captureGitBaseline(taskRoot) };
    // PLAN PHASE — complexity triage first: pure questions skip the planner.
    if (!task.plan?.length) {
      if (isChitchat(userMessage.content)) {
        await answerChitchat(ctx, userMessage);
        return finalize(session, "done", "greeting");
      }
      if (isTrivial(userMessage.content)) {
        await answerLite(ctx, userMessage);
        return finalize(session, "done", "answered directly (trivial ask)");
      }
      await planTask(ctx, false);
    }
    // EXPLORE PHASE — retrieval-grounded locator pass for multi-step plans in non-empty workspaces.
    let exploreDigest = "";
    const hasFiles = fs.existsSync(ctx.root) && (fs.readdirSync(ctx.root).filter((f) => !f.startsWith(".")).length > 2);
    if ((task.plan?.length ?? 0) > 1 && hasFiles && (task.meta?.complexity as string) !== "easy") {
      exploreDigest = await explorePhase(ctx);
    }
    return await drive(ctx, Math.max(0, opts?.resumeFromStep ?? 0), exploreDigest);
  } catch (err) {
    return handleError(session, controller, err);
  } finally {
    controllers.delete(session.id);
    runStates.delete(session.id);
    taskSessions.delete(task.id);
    if (session.task) session.task.updatedAt = Date.now();
    saveSession(session);
    // Wave 25: close the retrieval window; rebuild once if the task drifted
    // the project (its own writes). Fire-and-forget — never blocks finalize.
    void endTaskWindow(session.projectId).catch(() => {});
  }
  } catch (err) {
    // B45 outer catch: an early throw (controllers collision above all else)
    // must mark the stranded task failed — a "planning" task with no live run
    // is a zombie the UI can neither stop nor resume.
    const task = session.task;
    if (task && (task.status === "planning" || task.status === "running")) {
      task.status = "failed";
      if (task.meta) task.meta.runError = clip(String(err), 300); else task.meta = { runError: clip(String(err), 300) };
    }
    const m: ChatMessage = { id: uid(), role: "assistant", content: `**⚠ Task failed to start** — ${clip(String(err), 300)}`, at: Date.now(), meta: { errorCard: true } };
    session.messages.push(m);
    wire.emit({ type: "message", sessionId: session.id, message: m });
    emitTask(session);
    saveSession(session);
    return { done: false, reason: `runTask threw before start: ${clip(String(err), 200)}` };
  }
}

export function stopTask(sessionId: string): void {
  controllers.get(sessionId)?.abort(new Error("stopped by user"));
}

export function isRunning(sessionId: string): boolean {
  return controllers.has(sessionId);
}

/**
 * Resume a task parked on an approval (or crashed mid-step). No-op while the
 * task still runs — an in-flight executeTool owns the wait. Re-enters the
 * interrupted step from persisted partialMessages; a parked side-effect call
 * is NOT silently re-executed: the coder is told it was interrupted and must
 * re-issue it under a fresh approval gate, so double-application is impossible
 * even across a crash.
 */
export async function resumeAfterApproval(sessionId: string): Promise<void> {
  if (controllers.has(sessionId)) return;
  const memRs = runStates.get(sessionId);
  const session = memRs ? getSession(memRs.projectId, sessionId) : findSessionAny(sessionId);
  if (!session?.task) return;
  const t = session.task;
  // After a RESTART the in-memory runState map is empty — the crash anchor
  // lives on in task.meta.runState (boot reconciliation keeps it exactly for
  // this path). Without reading it back, POST /resume on a boot-reconciled
  // task reported {ok:true} and silently no-op'd.
  const diskRs = (t.meta as { runState?: RunState } | undefined)?.runState;
  const bootInterrupted = !!(t.meta as { bootInterrupted?: boolean } | undefined)?.bootInterrupted;
  const rs = memRs ?? diskRs;
  const resumable =
    t.status === "waiting-approval" ||
    ((t.status === "planning" || t.status === "running" || t.status === "reviewing") && !!rs) ||
    (t.status === "failed" && bootInterrupted && !!diskRs) ||
    // B11: boot reconciliation marks a crashed-mid-run task "stopped" (not
    // "failed"), so the resume predicate must accept that shape too —
    // stopped + bootInterrupted + a persisted runState anchor.
    (t.status === "stopped" && bootInterrupted && !!diskRs);
  if (!resumable) return;
  // Consumed: clear the boot-interrupted flag so a LATER normal failure of
  // this same task can't be mistakenly resumed again off a stale anchor.
  t.meta = { ...t.meta, bootInterrupted: false };
  t.budgetUsdCap ??= loadSettings().budgetPerTaskUsd;
  t.maxTokensPerTask ??= loadSettings().maxTokensPerTask;
  const over = budgetOver(t);
  if (over) { finalize(session, "failed", over); return; }

  const controller = new AbortController();
  controllers.set(sessionId, controller);
  taskSessions.set(t.id, sessionId); // B44: nudge liveness index
  emit(session, "task.start", "task resumed after approval", { input: { stepIndex: rs?.stepIndex ?? null } });
  try {
    const ctx: RunCtx = { session, root: resolveProjectRoot(session), controller, deadline: Date.now() + TASK_MAX_MS, startedAt: Date.now(), gitBaseline: captureGitBaseline(resolveProjectRoot(session)) };
    // B11: honor RunState.phase — a crash during the explore phase resumes the
    // explore (recomputing the locator digest) instead of jumping into step
    // execution with an empty digest.
    const exploreDigest = rs?.phase === "explore" ? await explorePhase(ctx) : "";
    await drive(ctx, rs?.stepIndex ?? t.currentStep ?? 0, exploreDigest, rs);
  } catch (err) {
    handleError(session, controller, err);
  } finally {
    controllers.delete(sessionId);
    runStates.delete(sessionId);
    taskSessions.delete(t.id);
    saveSession(session);
  }
}

// ── Internal driver ─────────────────────────────────────────────────────────
interface RunCtx {
  session: Session; root: string; controller: AbortController; deadline: number; startedAt: number;
  /** `git diff HEAD` captured at runTask start (r2b-review R2B-3): the
   *  dirty-worktree baseline that computeDiffs must NOT report as agent work. */
  gitBaseline?: string;
  /**
   * Give the per-step wall-clock timer back the time a human spent deciding.
   *
   * ctx.deadline was already refunded for approval waits, but the per-step
   * timer was not — so while the operator looked at a diff, the 600s step clock
   * kept running. It fired mid-approval, aborted the step, and left the
   * approval record `pending` with no consumer: clicking Approve then resolved
   * a waiter nobody was listening to and the task sat at WAITING-APPROVAL
   * forever. Human deliberation is not the agent working.
   */
  extendStepDeadline?: (ms: number) => void;
  /** B10: per-step abort signal, set by drive() for the duration of one step.
   *  Chained off the task controller, so it fires on BOTH a user Stop and the
   *  per-step wall-clock guard — a timed-out step must actually stop calling LLMs and
   *  writing files, not merely lose a Promise.race and keep running. */
  stepSignal?: AbortSignal;
}

/** Effective abort signal for the current work unit: the task controller and —
 *  while a step runs — the per-step controller (B10). Callers on the step path
 *  pass this into chat/tool calls so a step timeout aborts them in flight. */
function effSignal(ctx: RunCtx): AbortSignal {
  if (!ctx.stepSignal) return ctx.controller.signal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([ctx.controller.signal, ctx.stepSignal]);
  return ctx.stepSignal; // step controller is chained off the task controller
}

/** Baseline of pre-existing uncommitted changes, captured once at task start.
 *  computeDiffs's `git diff HEAD` fallback sweeps these into proposals and
 *  defeats the no-op guard — excluding baseline-identical chunks keeps the
 *  review panel honest in dirty worktrees. KNOWN LIMITATION (accepted):
 *  human edits made DURING the task to snapshot-untracked files are still
 *  attributed — only task-start state can be baselined cheaply. */
/**
 * Git workflow: every task runs on its own branch.
 *
 * Without this the agent commits straight onto whatever branch the user had
 * checked out, which makes "undo this whole task" a manual git archaeology
 * exercise. With it, abandoning a task is `git checkout -` and the user's own
 * branch was never touched.
 *
 * Deliberately best-effort and non-fatal: a project may not be a git repo at
 * all, may have an unborn HEAD, or may be mid-rebase. None of those are reasons
 * to refuse to work — the agent simply stays where it is and the checkpoint
 * store remains the undo mechanism.
 *
 * Branch names are derived from the task id, never from model output, so a
 * prompt can never inject git arguments.
 */
export function taskBranchName(taskId: string): string {
  return `agentzero/task-${taskId.slice(0, 8)}`;
}

function gitSync(root: string, args: string[], timeoutMs = 10_000): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["--no-pager", ...args], {
      cwd: root, encoding: "utf8", timeout: timeoutMs,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: String(err.stderr ?? err.stdout ?? err.message ?? "") };
  }
}

/** True when `root` is inside a git work tree with at least one commit. */
function gitUsable(root: string): boolean {
  if (!gitSync(root, ["rev-parse", "--is-inside-work-tree"]).ok) return false;
  return gitSync(root, ["rev-parse", "--verify", "HEAD"]).ok;
}

/**
 * Move onto the task's branch, creating it if needed. Returns the branch the
 * user was on so finalize can report it. No-op (returns null) when git is not
 * usable or the worktree is mid-operation.
 */
export function enterTaskBranch(root: string, taskId: string): { branch: string; from: string } | null {
  if (!gitUsable(root)) return null;
  const from = gitSync(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  if (!from || from === "HEAD") return null; // detached — leave it alone
  const branch = taskBranchName(taskId);
  if (from === branch) return { branch, from };
  // -B resets an existing branch of the same name to HEAD, which is what a
  // re-run of the same task id should do.
  const sw = gitSync(root, ["checkout", "-B", branch]);
  if (!sw.ok) return null;
  return { branch, from };
}

function captureGitBaseline(root: string): string | undefined {
  if (!fs.existsSync(path.join(root, ".git"))) return undefined;
  try {
    return execFileSync("git", ["--no-pager", "diff", "HEAD", "--unified=3"], { cwd: root, encoding: "utf8", timeout: 15_000 });
  } catch {
    return undefined; // unborn HEAD / not a repo / git missing
  }
}

/** Split a unified patch into per-path chunks (same split computeDiffs uses). */
function chunkByPath(patch: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!patch) return out;
  for (const chunk of patch.split(/\n(?=diff --git )/)) {
    const rel = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2];
    // Trimmed: both sides come from identically-flagged git output, so the
    // only byte difference possible is the trailing newline at chunk end.
    if (rel) out.set(rel, chunk.trim());
  }
  return out;
}

/** Reviewer-input truncation that never hides a changed file's existence.
 *  The old naive `clip(patchText, PATCH_CHAR_CAP)` sliced a large multi-file
 *  diff at the char cap, silently dropping later files — the reviewer then
 *  failed steps with "file X is missing from the diff" even though X was
 *  written (seen on a 6-file game build). This keeps EVERY changed path
 *  visible: a manifest lists all files, full hunks are included while the
 *  budget lasts, and elided files are explicitly marked present-on-disk so
 *  the reviewer judges them by path/status instead of reporting them missing. */
export function truncatePatchForReview(patchText: string, cap: number): string {
  if (patchText.length <= cap) return patchText;
  const chunks = chunkByPath(patchText);
  if (chunks.size === 0) return clip(patchText, cap);
  const entries = [...chunks.entries()];
  // Reserve room for the manifest + header before handing out diff budget.
  let budget = cap - 220 - entries.length * 96;
  const included: string[] = [];
  const elided = new Set<string>();
  for (const [p, ch] of entries) {
    if (budget >= ch.length) { included.push(ch); budget -= ch.length + 2; }
    else elided.add(p);
  }
  const manifest = entries.map(([p, ch]) => {
    const added = /--- \/dev\/null/.test(ch) ? "added" : "changed";
    const n = ch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const tag = elided.has(p) ? "hunks elided for budget — FILE IS PRESENT, do not report missing" : "full diff below";
    return `  - ${p} (${added}, ~${n} added lines; ${tag})`;
  }).join("\n");
  let out = `NOTE: the unified diff exceeds the review budget. ALL ${entries.length} changed files are listed below; full hunks are included where budget allowed.\nCHANGED FILES:\n${manifest}\n\n`;
  if (included.length) out += included.join("\n\n");
  return out;
}

function handleError(session: Session, controller: AbortController, err: unknown): { done: boolean; aborted?: boolean; reason?: string } {
  const msg = err instanceof Error ? err.message : String(err);
  pushError(session.id, msg);
  if (controller.signal.aborted) {
    logger.warn("orchestrator", "task aborted by user", { sessionId: session.id, error: clip(msg, 300) });
    emit(session, "error", "task aborted by user", { input: clip(msg, 500) });
    return finalize(session, "stopped", "stopped by user", true);
  }
  logger.error("orchestrator", "task crashed", { sessionId: session.id, taskId: session.task?.id, error: clip(msg, 500) });
  emit(session, "error", "task crashed", { input: clip(msg, 500) });
  return finalize(session, "failed", clip(msg, 300));
}

/**
 * Concurrent DAG step execution.
 *
 * Settings already exposed `budgets.max_parallel_subagents` and the UI let you
 * change it, but the scheduler ignored the value and always ran 2 — the control
 * did nothing. Read it here so the setting is real, clamped to a sane band.
 *
 * The ceiling is deliberately low. The failure mode of parallel coding agents
 * is conflicting edits, and the cost of that is a corrupted worktree the
 * reviewer then has to untangle — far more expensive than the wall-clock saved,
 * especially under a scoring formula that weights time at roughly half of cost.
 * Per-file locking (withFileLock) makes concurrent steps SAFE; this bound keeps
 * the contention window small enough that they are also FAST.
 */
const PARALLEL_STEPS_MIN = 1;
const PARALLEL_STEPS_MAX = 4;
const PARALLEL_STEPS_DEFAULT = 2;

/** Test seam: the clamp alone, without touching persisted settings. */
export function clampParallelForTest(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : PARALLEL_STEPS_DEFAULT;
  return Math.min(Math.max(n, PARALLEL_STEPS_MIN), PARALLEL_STEPS_MAX);
}

function maxParallelSteps(): number {
  const raw = (loadSettings() as { budgets?: { max_parallel_subagents?: unknown } }).budgets?.max_parallel_subagents;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : PARALLEL_STEPS_DEFAULT;
  return Math.min(Math.max(n, PARALLEL_STEPS_MIN), PARALLEL_STEPS_MAX);
}

async function drive(ctx: RunCtx, startIdx: number, exploreDigest: string, resume?: RunState): Promise<{ done: boolean; aborted?: boolean; reason?: string }> {
  const { session, controller } = ctx;
  const task = session.task!;
  const rules = loadProjectRules(ctx.root).rules;

  // Helper to cascade failures: if any prerequisite is failed or skipped, skip dependent pending steps
  const cascadeSkips = (steps: PlanStep[]): boolean => {
    let changed = false;
    const failedOrSkipped = new Set(
      steps.filter((s) => s.status === "failed" || s.status === "skipped").map((s) => s.id)
    );
    for (const s of steps) {
      if (s.status === "pending") {
        const blockedBy = (s.dependsOn ?? []).find((depId) => failedOrSkipped.has(depId));
        if (blockedBy) {
          s.status = "skipped";
          s.resultSummary = `prerequisite ${blockedBy} failed or skipped`;
          failedOrSkipped.add(s.id);
          changed = true;
        }
      }
    }
    return changed;
  };

  const executeOneStep = async (stepIndex: number, step: PlanStep, stepResume?: RunState): Promise<{ ok: boolean; reason?: string; stuck?: StuckEvent | null }> => {
    const stepCtl = new AbortController();
    const chainAbort = (): void => {
      try { stepCtl.abort(controller.signal.reason); } catch { /* already aborted */ }
    };
    controller.signal.addEventListener("abort", chainAbort, { once: true });
    let stepTimer: NodeJS.Timeout | undefined;
    try {
      // Deadline is tracked as an absolute time so an approval refund can push
      // it forward and the timer be rescheduled against the new value.
      let stepDeadline = Date.now() + PER_STEP_TIMEOUT_MS;
      const armStepTimer = (): void => {
        if (stepTimer) clearTimeout(stepTimer);
        stepTimer = setTimeout(() => {
          try { stepCtl.abort(new Error(`step ${step.id} wall-clock timeout`)); } catch { /* already aborted */ }
        }, Math.max(1, stepDeadline - Date.now()));
        if (typeof (stepTimer as unknown as { unref?: () => void }).unref === "function") {
          (stepTimer as unknown as { unref: () => void }).unref();
        }
      };
      armStepTimer();
      const stepCtx: RunCtx = {
        ...ctx,
        stepSignal: stepCtl.signal,
        extendStepDeadline: (ms: number) => {
          if (!Number.isFinite(ms) || ms <= 0) return;
          stepDeadline += ms;
          armStepTimer();
        },
      };
      task.currentStep = stepIndex;
      step.status = "running";
      task.status = "running";
      resetGatedAppliedPaths(session.id);
      saveSession(session);
      emitTask(session);
      wire.emit({ type: "session", session });

      await runStep(stepCtx, step, exploreDigest, rules, stepResume);

      const stuck = detectStuck(session, step);
      return { ok: (step.status as PlanStep["status"]) === "done", stuck };
    } catch (err) {
      if (controller.signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = stepCtl.signal.aborted;
      const reason = timedOut
        ? `step ${step.id} wall-clock timeout (${PER_STEP_TIMEOUT_MS / 1000}s cap)`
        : err instanceof LlmError ? `provider exhausted: ${clip(msg, 220)}` : `internal error: ${clip(msg, 220)}`;

      // SALVAGE: an error AFTER the work landed must not throw the work away.
      //
      // The failure that motivates this was observed end-to-end: the coder
      // wrote snake.py (3.5 KB, parses) and requirements.txt, every approval
      // was granted, and then a stalled provider stream tripped the hard cap.
      // The step was marked failed, and with both steps failing the task
      // reported "0/2 done" over a workspace containing a complete, working
      // program. Reporting failure over correct output is the single worst
      // outcome this system can produce.
      //
      // The auditor is the right authority here for the same reason it can
      // override the reviewer: it reads the filesystem, not the model. It costs
      // no tokens and cannot hallucinate. If it confirms the step's files are
      // present, non-empty and parsing, the work is done — the error was in the
      // scaffolding around it, and is recorded as a warning rather than erasing
      // the result. If the audit does NOT pass, nothing is salvaged and the
      // failure stands exactly as before.
      // A TIMEOUT is salvaged too. The first version of this guard excluded it,
      // on the reasoning that running out of clock implies unfinished work —
      // but the observed run wrote a complete, parsing 4.9 KB snake.py and then
      // hit the 600s cap during the review that followed. The audit is the
      // authority on what is finished, not the clock: if the files verify, the
      // code is real whether or not the step got to tidy up after itself.
      // The summary says plainly that it timed out, so neither the re-planner
      // nor the user mistakes this for a clean pass.
      // The applied-paths tracker is keyed by SESSION, not step, and parallel
      // steps share one working tree — so a file written by s1 is visible to a
      // concurrently-failing s2. Observed: s1 and s2 both salvaged citing the
      // same snake.py, and a step that had produced nothing was marked done.
      //
      // Plumbing a step id through every tool call site is the real fix; short
      // of that, a file may only be claimed ONCE per task. The first step to
      // salvage it takes the credit, and a step left with nothing unclaimed
      // gets no credit — which is the honest outcome, since there is no
      // evidence it produced anything.
      const claimed = salvageClaims.get(task.id) ?? new Set<string>();
      const touched = [...gatedAppliedPaths(session.id)].filter((f) => !claimed.has(f));
      if (touched.length > 0) {
        const salvage = await auditStep(ctx.root, touched).catch(() => null);
        if (salvage?.ok) {
          for (const f of touched) claimed.add(f);
          salvageClaims.set(task.id, claimed);
          const note = timedOut
            ? `partially complete — ${reason}; verified output kept, may be missing later work`
            : `completed, but ${reason}`;
          step.status = "done";
          step.resultSummary = `${note} — ${salvage.facts.join("; ")}`;
          logger.warn("orchestrator", "step errored after verified work — salvaged", {
            sessionId: session.id, taskId: task.id, stepId: step.id, reason, files: touched,
          });
          emit(session, "review", `step ${step.id} — ${auditLabel(salvage)}; error after the work landed, keeping it`, {
            agentRole: "auditor", input: { stepId: step.id, reason }, output: salvage.facts,
          });
          saveSession(session);
          emitTask(session);
          wire.emit({ type: "session", session });
          return { ok: true, reason: note };
        }
      }

      step.resultSummary = reason;
      markStepFailed(task, step, reason);
      pushError(session.id, `${step.id}: ${msg}`);
      logger.warn("orchestrator", "step failed — skip-and-continue", {
        sessionId: session.id, taskId: task.id, stepId: step.id, attempt: step.attempts,
        provider: err instanceof LlmError, timedOut, reason,
        remainingSteps: (task.plan?.length ?? 0) - stepIndex - 1,
      });
      emit(session, "error", `step ${step.id} failed (${timedOut ? "timeout" : err instanceof LlmError ? "provider exhausted" : "internal error"}) — continuing with remaining steps`, {
        agentRole: "orchestrator", input: { stepId: step.id, reason }, output: clip(msg, 300),
      });
      saveSession(session);
      emitTask(session);
      wire.emit({ type: "session", session });
      return { ok: false, reason };
    } finally {
      if (stepTimer) clearTimeout(stepTimer);
      controller.signal.removeEventListener("abort", chainAbort);
    }
  };

  const runningPromises = new Map<string, Promise<{ stepId: string; stepIndex: number; res: { ok: boolean; reason?: string; stuck?: StuckEvent | null } }>>();

  while (true) {
    if (controller.signal.aborted) return finalize(session, "stopped", "stopped by user", true);
    if (Date.now() > ctx.deadline) return finalize(session, "failed", `wall-clock cap ${TASK_MAX_MS / 1000}s exceeded`);
    const over = budgetOver(task);
    if (over) return finalize(session, "failed", `${over} — hard ceiling`);
    if (task.stepCount >= MAX_STEPS) return finalize(session, "failed", `step cap ${MAX_STEPS} reached`);

    if (cascadeSkips(task.plan ?? [])) {
      saveSession(session);
      emitTask(session);
    }

    const steps = task.plan ?? [];
    const doneIds = new Set(steps.filter((s) => s.status === "done").map((s) => s.id));
    const readySteps = steps
      .map((s, idx) => ({ step: s, idx }))
      .filter(({ step }) => step.status === "pending" && (step.dependsOn ?? []).every((dep) => doneIds.has(dep)));

    const parallelCap = maxParallelSteps();
    while (runningPromises.size < parallelCap && readySteps.length > 0) {
      const { step, idx } = readySteps.shift()!;
      step.status = "running";
      const stepResume = resume && resume.stepIndex === idx ? resume : undefined;
      const p = executeOneStep(idx, step, stepResume).then((res) => ({ stepId: step.id, stepIndex: idx, res }));
      runningPromises.set(step.id, p);
    }

    if (runningPromises.size === 0) {
      const remainingPending = steps.filter((s) => s.status === "pending");
      if (remainingPending.length > 0) {
        for (const s of remainingPending) {
          s.status = "skipped";
          s.resultSummary = "unresolvable dependency or cycle";
        }
        saveSession(session);
        emitTask(session);
      }
      break;
    }

    const finished = await Promise.race(runningPromises.values());
    runningPromises.delete(finished.stepId);

    if (finished.res.stuck) {
      const stuck = finished.res.stuck;
      logger.warn("orchestrator", "stuck detected", { sessionId: session.id, taskId: task.id, ...stuck });
      emit(session, "error", "stuck-detected", { agentRole: "orchestrator", input: stuck });
      task.stuckEvents.push(stuck);
      const replans = (task.meta?.replans as number | undefined) ?? 0;
      if (replans >= MAX_REPLANS) return finalize(session, "failed", `stuck (${stuck.kind}) after ${MAX_REPLANS} re-plans — halting instead of looping`);
      task.meta = { ...task.meta, replans: replans + 1 };
      logger.warn("orchestrator", "re-planning", { sessionId: session.id, taskId: task.id, replan: replans + 1, kind: stuck.kind });

      if (runningPromises.size > 0) {
        await Promise.allSettled(runningPromises.values());
        runningPromises.clear();
      }

      await planTask(ctx, true);
      return drive(ctx, firstPendingIndex(task), exploreDigest || (await explorePhase(ctx)));
    }
  }

  const planSteps = task.plan ?? [];
  const failedSteps = planSteps.filter((s) => s.status === "failed");
  const allFailed = planSteps.length > 0 && failedSteps.length === planSteps.length;
  const counts = `${planSteps.length - failedSteps.length}/${planSteps.length} done · ${failedSteps.length} failed`;
  return finalize(session, allFailed ? "failed" : "done", allFailed
    ? `all ${planSteps.length} step(s) failed: ${failedSteps.map((s) => s.id).join(", ")}`
    : failedSteps.length === 0
      ? `all ${(task.plan ?? []).length} step(s) completed`
      : `${counts}${failedSteps.some((s) => s.resultSummary?.startsWith("provider exhausted")) ? " (provider exhausted)" : ""}`);
}

/** Record a hard step failure on the task: status plus the meta.failedSteps
 *  entry the UI error card renders (r7-C). Does not touch resultSummary —
 *  callers set the user-facing summary themselves. */
function markStepFailed(task: NonNullable<Session["task"]>, step: PlanStep, reason: string): void {
  step.status = "failed";
  const prev = Array.isArray(task.meta?.failedSteps) ? (task.meta!.failedSteps as { id: string; title: string; reason: string }[]) : [];
  const next = prev.filter((f) => f.id !== step.id);
  next.push({ id: step.id, title: step.title, reason: clip(reason, 200) });
  task.meta = { ...task.meta, failedSteps: next };
}

/** B29: real LLM summarizer for tiered compaction (T2 rolling summary). The
 *  Compactor used to be constructed without one, so T2 could never summarize —
 *  it threw and every overflow silently fell through to the T3 floor. */
function makeSummarizer(ctx: RunCtx): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const span = emit(ctx.session, "agent.start", "summarizer · compaction", { agentRole: "summarizer" });
    try {
      const { res } = await routedLlm(ctx, "summarizer", [
        { role: "system", content: "You compress agent conversation history faithfully. Preserve every pinned/protected block verbatim; keep file paths, decisions, and outcomes." },
        { role: "user", content: prompt },
      ], span, 900);
      return res.text;
    } finally {
      emit(ctx.session, "agent.end", "summarizer done", { spanId: span, agentRole: "summarizer" });
    }
  };
}

/**
 * Execute ONE plan step end-to-end: context assembly → coder toolLoop →
 * no-op nudges → reviewer round(s) → status assignment. Throws on LLM/
 * internal failure so drive()'s skip-and-continue wrapper can classify it;
 * deliberate ceilings (abort/budget/wall-clock) propagate as their own error
 * types and are recognized up there.
 */
async function runStep(ctx: RunCtx, step: PlanStep, exploreDigest: string, rules: string | null, resume?: RunState): Promise<void> {
  const { session } = ctx;
  const task = session.task!;
  // B10: bail before doing ANY work if the step was already timed out/aborted.
  if (ctx.stepSignal?.aborted) throw new DOMException("aborted", "AbortError");
  // B11: resume re-enters the SAME attempt that was interrupted — the persisted
  // runState already carries the current attempt number (it was written AFTER
  // the increment). The old `resume.attempts + 1` double-counted the attempt
  // and `task.stepCount++` burned the step budget twice on every crash-resume.
  const attempts = resume ? resume.attempts : step.attempts + 1;
  step.attempts = attempts;
  if (!resume) task.stepCount++;
  const stepStarted = Date.now();
  // Forge conductor: resolve worker from step meta for role-based dispatch
  const workerId = (step as any).meta?.worker_id as string | undefined;
  const worker = workerId ? getWorker(workerId) : undefined;
  const stepRole = worker ? workerToRole(workerId!) as "planner" | "coder" | "reviewer" | "router" : "coder";
  const stepRoleLabel = worker?.role ?? "Coder";
  logger.info("orchestrator", "step start", {
    sessionId: session.id, taskId: task.id, stepId: step.id, title: step.title, attempt: attempts,
    worker_id: workerId ?? "coder", role: stepRole,
  });
  const span = emit(session, "agent.start", `${stepRoleLabel.toLowerCase()} · ${step.id}: ${step.title}`, { agentRole: stepRole, input: { detail: step.detail, attempt: attempts, worker_id: workerId } });

  // Wave 25 (forge-parity fluid chat): the coder's tokens stream live to the
  // wire under this step's span — content deltas as kind:"text", reasoning
  // deltas as kind:"thought" (the web Thinking box). Keyed by the span so the
  // llm.call trace (input.streamed) can seal the accumulator when the call
  // completes. Live-only: never journaled, so no transcript bloat.
  const streamHook: StreamHook = (() => {
    // Live-coding tap: the same content deltas that feed the chat bubble are
    // ALSO fed to the incremental write_file decoder, so the editor can type
    // the file out as the model produces it rather than waiting for the whole
    // tool call to parse. Reasoning deltas are excluded — only real content
    // can carry a tool call. See livecode.ts for why this needs a decoder.
    // Two independent decoders, because a file can arrive down either channel:
    //   textLive — the TOOL_CALL: {...} text protocol (untrained models)
    //   argsLive — native tool_calls[].function.arguments (tool-trained models)
    // The arguments JSON has the same {"path":…,"content":…} shape as the text
    // payload, so the same decoder reads both. Keeping them separate stops one
    // channel's partial JSON from corrupting the other's parse state.
    let rawText = "";
    let rawArgs = "";
    const textLive = newLiveCodeState();
    const argsLive = newLiveCodeState();
    const pushLive = (hit: { path: string; delta: string; done: boolean } | null): void => {
      if (!hit) return;
      wire.emit({
        type: "file_stream", sessionId: session.id, taskId: task.id,
        path: hit.path, delta: hit.delta, done: hit.done,
      });
    };
    const throttle = createDeltaThrottle((d) => {
      const delta = d.text ?? d.reasoning;
      if (!delta) return;
      wire.emit({
        type: "token", sessionId: session.id, taskId: task.id,
        messageId: span, spanId: span, delta,
        kind: d.reasoning ? "thought" : "text",
      });
    });
    return {
      push: (d) => {
        // Live preview is cosmetic: a decode fault must never disturb the real
        // tool call, which is parsed independently from the completed response.
        try {
          if (d.text) {
            rawText += d.text;
            pushLive(liveFeed(rawText, textLive));
          }
          if (d.toolArgs) {
            // Native arguments carry no tool name inside the JSON, so wrap the
            // fragment in the envelope the decoder expects.
            if (rawArgs === "") rawArgs = `{"name":"${d.toolName ?? "write_file"}","args":`;
            rawArgs += d.toolArgs;
            pushLive(liveFeed(rawArgs, argsLive));
          }
        } catch { /* never break the stream for a preview */ }
        throttle.push(d);
      },
      flush: throttle.flush,
    };
  })();

  // Tiered auto-compaction before assembling step context
  try {
    // B29: the Compactor used to be constructed WITHOUT a summarizer, so T2
    // rolling summarization could never actually run (it threw → silent T3
    // floor). Wire a real routed LLM call, and pass task state so a T3
    // emergency rebuild never emits "Goal: (unknown goal)".
    const compactor = new Compactor({ summarizer: makeSummarizer(ctx) });
    const { messages: compacted, report } = await compactor.maybeCompact(session.messages, 200_000, 0, undefined, { goal: task.goal });
    if (report && report.tier !== "none") {
      session.messages = compacted;
      saveSession(session);
      emit(session, "compaction", `compaction ${report.tier}: ${report.tokensBefore} → ${report.tokensAfter} tok`, {
        agentRole: "coder",
        output: report,
      });
    }
  } catch {
    /* compaction failure must not kill the step */
  }

  // Minimal per-step thread (never the whole history — least-context req).
  let msgs: SysMsg[];
  if (resume && resume.partialMessages.length) {
    msgs = [...resume.partialMessages] as SysMsg[];
    if (resume.pendingCall) {
      msgs.push(toolMsg(resume.pendingCall.name, { ok: false, result: "(interrupted before execution — re-issue this exact call if still needed)" }));
    }
  } else {
    msgs = [await buildStepContext(ctx, step, attempts, exploreDigest, rules)];
  }

  // ── FORGE WORKER DISPATCH ──────────────────────────────────────────────
  // adversarial_debugger: structured critic verdict (no tools, JSON response)
  // lead_engineer / synthesizer: full tool-calling coder loop
  // fast_tool_agent: lightweight quick-answer path
  const isCritic = workerId === "adversarial_debugger";
  const isFastScout = workerId === "fast_tool_agent";

  let run: ToolLoopResult;
  if (isCritic) {
    // Forge adversarial critic: structured JSON verdict, no tools
    const criticSys = buildSystemPrompt({ agentsMdRules: rules, rolePrompt: CRITIC_PROMPT });
    const criticMsgs = [
      { role: "system", content: criticSys },
      { role: "user", content: msgs[msgs.length - 1]?.content ?? step.detail },
    ];
    const r = await routedLlm(ctx, "reviewer", criticMsgs, span, 2048, true);
    const verdict = parseCriticVerdict(r.res.text);
    run = {
      finalText: verdict.passed
        ? `Critic verdict: PASS — ${verdict.reason}`
        : `Critic verdict: FAIL — ${verdict.reason} [${verdict.suggestedFixCategory}]`,
      outcomes: [],
    };
    // Record critic output for access-list scoped context
    const taskOutputs = stepOutputs.get(task.id);
    const stepNum = parseInt(step.id.replace(/\D/g, ""), 10) || 0;
    if (taskOutputs) taskOutputs.set(stepNum, { workerId: workerId!, output: run.finalText });
    recordRun(task.id, run.finalText, run.outcomes);
    // Critic steps don't produce code changes — skip review/audit, just set status
    step.status = verdict.passed ? "done" : "failed";
    step.resultSummary = run.finalText;
    if (!verdict.passed) markStepFailed(task, step, clip(run.finalText, 180));
  } else {
    // lead_engineer / synthesizer / fast_tool_agent / default: full tool loop
    const effectiveRole = isFastScout ? "router" : stepRole;
    run = await toolLoop(ctx, effectiveRole as any, msgs, span, isFastScout ? 5 : MAX_TOOL_CALLS, undefined, streamHook);
    recordRun(task.id, run.finalText, run.outcomes);
    // Record step output for access-list isolation
    const taskOutputs = stepOutputs.get(task.id);
    const stepNum = parseInt(step.id.replace(/\D/g, ""), 10) || 0;
    if (taskOutputs) taskOutputs.set(stepNum, { workerId: workerId ?? "lead_engineer", output: run.finalText });
  }
  // Critic steps already set their status above — skip the review/audit/status flow
  if (!isCritic) {
  let bundle = computeDiffs(ctx);
  // NO-OP GUARD: code-touching step with no successful write/edit → retry
  for (let noopNudge = 0; noopNudge < 2 && impliesCodeChange(step) && !madeWriteOrEdit(run.outcomes); noopNudge++) {
    if (run.outcomes.length === 0) {
      emit(session, "error", `step ${step.id}: no tool call from ${stepRoleLabel.toLowerCase()} — nudging (${noopNudge + 1}/2)`, { parentId: span });
      msgs.push(asstMsg(run.finalText || "(no final text)"));
      msgs.push(userMsg(`You replied without using any tool. This step requires actual changes. Use the protocol: one TOOL_CALL line (e.g. TOOL_CALL: {"name":"write_file","args":{"path":"…","content":"…"}}), wait for TOOL_RESULT, then FINAL when verified.`));
    } else {
      emit(session, "error", `step ${step.id}: explored but changed nothing — nudging (${noopNudge + 1}/2)`, { parentId: span });
      msgs.push(asstMsg(run.finalText || "(no final text)"));
      msgs.push(userMsg(`You explored but made NO changes. To finish step "${step.title}" you MUST write code: reply with one TOOL_CALL line using write_file or edit_file with the full file content / exact replacement, wait for TOOL_RESULT, then FINAL.`));
    }
    run = await toolLoop(ctx, stepRole as any, msgs, span, MAX_TOOL_CALLS, undefined, streamHook);
    recordRun(task.id, run.finalText, run.outcomes);
  }
  bundle = computeDiffs(ctx);
  let verdict: Verdict | null = null;
  // ADVERSARIAL REVIEW RUNS ON EVERY CODE CHANGE.
  for (let round = 0; bundle.files.length > 0 && round < 2; round++) {
    recordProposal(ctx, bundle.files, `step ${step.id}${round ? " (retry)" : ""}: ${step.title}`, span);
    verdict = await reviewStep(ctx, step, bundle.patchText, span);
    if (verdict.verdict === "pass" || attempts >= 2) break;
    emit(session, "review", `reviewer failed ${step.id} — feeding issues back`, { parentId: span, agentRole: "reviewer", output: verdict });
    msgs.push(asstMsg(run.finalText || "(no final text)"));
    msgs.push(userMsg(`REVIEW FEEDBACK — your edits were rejected:\n${verdict.issues.map((x, n) => `${n + 1}. ${x}`).join("\n")}\nFix exactly these problems for step "${step.title}". Same protocol.`));
    run = await toolLoop(ctx, stepRole as any, msgs, span, MAX_TOOL_CALLS, undefined, streamHook);
    recordRun(task.id, run.finalText, run.outcomes);
    bundle = computeDiffs(ctx);
  }
  // ── AUDIT ────────────────────────────────────────────────────────────────
  let audit: AuditReport | null = null;
  if (bundle.files.length > 0) {
    const changed = bundle.files.filter((f) => f.status !== "deleted").map((f) => f.path);
    const removed = bundle.files.filter((f) => f.status === "deleted").map((f) => f.path);
    try {
      audit = await auditStep(ctx.root, changed, removed);
      emit(session, "review", auditLabel(audit), {
        parentId: span, agentRole: "reviewer",
        output: { ok: audit.ok, checks: audit.checks, facts: audit.facts },
      });
      if (!audit.ok) {
        logger.warn("orchestrator", "audit failed — overriding reviewer verdict", {
          sessionId: session.id, taskId: task.id, stepId: step.id,
          failures: audit.checks.filter((c) => !c.ok).map((c) => c.detail),
        });
        verdict = {
          verdict: "fail",
          issues: audit.checks.filter((c) => !c.ok).map((c) => c.detail).slice(0, 3),
        };
      }
    } catch (err) {
      logger.warn("orchestrator", "audit could not run", { error: clip(String(err), 160) });
    }
  }

  if (bundle.files.length === 0 && !impliesCodeChange(step)) { step.status = "done"; verdict = null; }
  else if (bundle.files.length === 0) { step.status = "failed"; step.attempts += 1; }
  else if (verdict?.verdict === "pass") step.status = "done";
  else step.status = "failed";
  step.resultSummary = step.status === "failed"
    ? verdict
      ? `reviewer failing: ${verdict.issues.join("; ")}`
      : (clip(run.finalText, 200) || "step failed without review")
    : audit
      ? `${audit.facts[0]}${run.finalText ? ` · ${stepRoleLabel.toLowerCase()} reported: ${clip(run.finalText, 200)}` : ""}`
      : clip(run.finalText, 400);
  if (step.status === "failed") markStepFailed(task, step, clip(step.resultSummary, 180));
  } // end if (!isCritic)

  logger.info("orchestrator", "step end", {
    sessionId: session.id, taskId: task.id, stepId: step.id, status: step.status,
    durationMs: Date.now() - stepStarted,
    summary: clip(step.resultSummary ?? "", 160), worker_id: workerId ?? "coder",
  });
  emit(session, "agent.end", `${stepRoleLabel.toLowerCase()} · ${step.id} → ${step.status}`, {
    spanId: span, agentRole: stepRole,
    output: { status: step.status, summary: step.resultSummary, worker_id: workerId }, durationMs: Date.now() - stepStarted,
  });
  if (!ctx.stepSignal?.aborted) {
    saveSession(session);
    emitTask(session);
    wire.emit({ type: "session", session });
  }
}

function recordRun(taskId: string, finalText: string, outcomes: { key: string; ok: boolean }[]): void {
  if (finalText) textHist.set(taskId, [...(textHist.get(taskId) ?? []), normText(finalText)].slice(-12));
  toolHist.set(taskId, [...(toolHist.get(taskId) ?? []), ...outcomes].slice(-60));
}

/** True if this step's tool outcomes include a SUCCESSFUL write_file/edit_file.
 *  Used by the NO-OP guard: computeDiffs diffs against the task-start snapshot
 *  (not consumed across steps), so on step 2+ the bundle always carries earlier
 *  steps' files and `bundle.files.length===0` can never detect "this step wrote
 *  nothing". Checking the step's own outcomes is accumulation-proof. */
export function madeWriteOrEdit(outcomes: { key: string; ok: boolean }[]): boolean {
  return outcomes.some((o) => o.ok && /^(write_file|edit_file):/.test(o.key));
}

// ── Planning ────────────────────────────────────────────────────────────────
function firstPendingIndex(task: NonNullable<Session["task"]>): number {
  const i = (task.plan ?? []).findIndex((s) => s.status === "pending" || s.status === "failed");
  return i === -1 ? (task.plan?.length ?? 0) : i;
}
export interface PlanShape {
  steps: { id?: string; title: string; detail: string; dependsOn?: string[]; accessList?: string[] }[];
  complexity: "easy" | "medium" | "hard";
}

// ── Sibling-task digest (RC3) ────────────────────────────────────────────────
// The user's tasks in one folder are interconnected — the planner gets a
// COMPACT digest of the most recent sibling tasks in the same project so it
// can build on (or avoid repeating) them. Hard caps keep it ~300 tokens max:
// never a context-window bloat vector.
const SIBLING_MAX_ROWS = 5;
const SIBLING_TOTAL_CAP = 1200;
const SIBLING_TITLE_CLIP = 60;
const SIBLING_SUMMARY_CLIP = 100;

/** Compact one-line-per-task digest of sibling tasks in the same project.
 *  Excludes the session itself and delegated subagent sessions (fan-out
 *  noise, not user work). Pure read of the session store — no LLM calls. */
export function siblingDigest(session: Session): string {
  try {
    const sibs = listSessions(session.projectId)
      .filter((s) => s.id !== session.id)
      .filter((s) => !s.task?.meta?.delegated)
      .filter((s) => s.task) // only sessions that carry a task
      .slice(0, SIBLING_MAX_ROWS);
    const lines: string[] = [];
    let used = 0;
    for (const s of sibs) {
      const t = s.task!;
      // Outcome: persisted resultSummary first, else derive from status.
      const outcome = t.resultSummary?.trim() ||
        (t.status === "failed" ? "failed" : t.status === "stopped" ? "stopped" : "");
      const line = `- [${t.status}] ${clip(t.title || t.goal, SIBLING_TITLE_CLIP)}${outcome ? ` — ${clip(outcome, SIBLING_SUMMARY_CLIP)}` : ""}`;
      if (used + line.length > SIBLING_TOTAL_CAP) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (!lines.length) return "";
    return `RELATED TASKS IN THIS FOLDER (same project, most recent first — they may be interconnected):\n${lines.join("\n")}`;
  } catch {
    return ""; // store unavailable → no digest, planning proceeds
  }
}

async function planTask(ctx: RunCtx, replan: boolean): Promise<void> {
  const { session, root } = ctx;
  const task = session.task!;
  task.status = "planning";
  const span = emit(session, "agent.start", replan ? "conductor · re-plan" : "conductor", { agentRole: "planner" });
  const recent = session.messages.filter((m) => m.role === "user" || (m.role === "assistant" && !m.meta?.bytheway)).slice(-6);
  const pinned = session.contextRefs.filter((r) => r.source === "user");
  const repoMap = await computeRepoMap(root, task.goal, 1500).catch(() => "");
  // RC3: sibling tasks in the same folder, hard-capped (~300 tokens max).
  const siblings = siblingDigest(session);
  const agentsMd = loadProjectRules(root).rules ?? "";

  // Forge Conductor: build user block with pool manifest for DAG decomposition
  const userBlock = [
    `Devise multi-agent execution graph for: ${task.goal}`,
    repoMap ? repoMap : "",
    siblings,
    pinned.length ? `PINNED CONTEXT (must be used):\n${pinned.map((r) => `- ${r.path}${r.startLine ? `:${r.startLine}-${r.endLine ?? ""}` : ""}`).join("\n")}` : "",
    recent.length ? `RECENT CONVERSATION:\n${recent.map((m) => `${m.role}: ${clip(m.content, 400)}`).join("\n")}` : "",
    replan ? failureDigest(session) : "",
  ].filter(Boolean).join("\n\n");

  // Use Forge Conductor prompt with pool manifest instead of generic planner
  const conductorPrompt = `${CONDUCTOR_PROMPT}\n\n${poolManifest()}`;
  const sys = buildSystemPrompt({ agentsMdRules: agentsMd, rolePrompt: conductorPrompt });

  // Also try the standard planner as fallback — some models respond better to it
  let out: PlanShape | null = null;
  let conductorSteps: ConductorWorkflowStep[] | null = null;

  // 3 attempts: try conductor prompt first, fall back to standard planner format
  for (let attempt = 0; attempt < 3 && !out; attempt++) {
    const useStandardPlanner = attempt >= 2; // last attempt uses the original planner prompt
    const effectiveSys = useStandardPlanner
      ? buildSystemPrompt({ agentsMdRules: agentsMd, rolePrompt: PLANNER_PROMPT })
      : sys;
    const msgs = [
      { role: "system", content: effectiveSys },
      { role: "user", content: attempt === 0
        ? userBlock
        : `${userBlock}\n\nYour previous reply was invalid. Output ONLY the JSON ${useStandardPlanner ? "object" : "array"} per the schema — no thinking, no explanation, no markdown, no schema placeholders.` },
    ];
    const r = await routedLlm(ctx, "planner", msgs, span, 4096, true);

    if (!useStandardPlanner) {
      // Try parsing as ConductorWorkflowStep[] (JSON array)
      const parsed = parseConductorPlan(r.res.text, task.goal);
      if (parsed.length > 0) {
        conductorSteps = parsed;
        // Convert ConductorWorkflowStep[] to PlanShape for downstream compatibility
        out = {
          steps: parsed.map((s) => ({
            id: `s${s.step_id}`,
            title: `[${getWorker(s.worker_id).role}] ${clip(s.subtask, 100)}`,
            detail: s.subtask,
            dependsOn: s.access_list.map((id) => `s${id}`),
            accessList: s.access_list.map((id) => `s${id}`),
          })),
          complexity: parsed.length <= 2 ? "easy" : parsed.length <= 4 ? "medium" : "hard",
        };
      }
    } else {
      // Standard planner format fallback
      out = sanitizePlan(parseJsonLoose<PlanShape>(r.res.text));
    }

    if (!out) emit(session, "error", "conductor JSON unparseable — repairing", { parentId: span, agentRole: "planner", input: clip(r.res.text, 400) });
  }
  if (!out) out = { steps: [{ id: "s1", title: "execute goal directly", detail: `Work the goal in one pass: ${task.goal}`, dependsOn: [] }], complexity: "medium" };

  task.meta = {
    ...task.meta,
    complexity: out.complexity,
    conductorMode: !!conductorSteps, // track whether we're using Forge conductor
    planRevision: ((task.meta?.planRevision as number | undefined) ?? 0) + 1,
  };

  // Build PlanStep[] with worker_id stored in meta for dispatch in runStep
  task.plan = out.steps.map((s, n) => {
    const conductorStep = conductorSteps?.[n];
    return {
      id: s.id || `s${n + 1}`,
      title: clip(s.title, 120),
      detail: s.detail,
      status: "pending" as const,
      attempts: 0,
      dependsOn: s.dependsOn ?? [],
      accessList: s.accessList,
      meta: conductorStep ? {
        worker_id: conductorStep.worker_id,
        strategy: conductorStep.strategy,
        access_list_numeric: conductorStep.access_list,
      } : undefined,
    };
  });

  // Initialize step outputs map for this task (Forge access-list isolation)
  stepOutputs.set(task.id, new Map());

  emit(session, "agent.end", `conductor rev${task.meta.planRevision}: ${task.plan.length} step(s) · ${out.complexity}${conductorSteps ? " [forge-conductor]" : ""}`, {
    spanId: span, agentRole: "planner", output: { complexity: out.complexity, conductorMode: !!conductorSteps, steps: task.plan.map((s) => ({ id: s.id, title: s.title, dependsOn: s.dependsOn, worker_id: (s as any).meta?.worker_id })) },
  });
  saveSession(session);
  emitTask(session);
}

export interface TopologicalPlanResult {
  steps: PlanStep[];
  hasCycle: boolean;
}

export function validateAndSortDAG(steps: PlanStep[]): TopologicalPlanResult {
  const stepMap = new Map<string, PlanStep>();
  for (const s of steps) {
    stepMap.set(s.id, s);
  }

  for (const s of steps) {
    if (Array.isArray(s.dependsOn)) {
      s.dependsOn = s.dependsOn.filter((id) => id !== s.id && stepMap.has(id));
    } else {
      s.dependsOn = [];
    }
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const s of steps) {
    inDegree.set(s.id, s.dependsOn!.length);
    if (!adj.has(s.id)) adj.set(s.id, []);
  }

  for (const s of steps) {
    for (const depId of s.dependsOn!) {
      const dependents = adj.get(depId) ?? [];
      dependents.push(s.id);
      adj.set(depId, dependents);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const sorted: PlanStep[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(stepMap.get(id)!);

    for (const dependentId of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(dependentId) ?? 1) - 1;
      inDegree.set(dependentId, newDeg);
      if (newDeg === 0) queue.push(dependentId);
    }
  }

  const hasCycle = sorted.length !== steps.length;
  if (hasCycle) {
    // If a cycle was detected, safely fall back to sequential dependency to prevent deadlocks
    const linear = steps.map((s, idx) => ({
      ...s,
      dependsOn: idx === 0 ? [] : [steps[idx - 1]!.id],
    }));
    return { steps: linear, hasCycle: true };
  }

  return { steps: sorted, hasCycle: false };
}

export function sanitizePlan(raw: PlanShape | null): PlanShape | null {
  if (!raw || !Array.isArray(raw.steps)) return null;
  // BUGFIX: reasoning models echo the schema example from the prompt inside
  // their prose thinking ('{"steps":[{"title":"...","detail":"..."}]}'). That
  // template parses as valid JSON, so reject placeholder steps ("...", <…>,
  // […]) — otherwise the planner "succeeds" with an empty plan and never runs
  // its repair attempt.
  const isPlaceholder = (v: string): boolean => {
    const t = v.trim();
    return t === "" || /^[\u2026.]{2,}$/.test(t) || /^<[^>]*>$/.test(t) || /^\[[^\]]*\]$/.test(t);
  };
  const rawSteps = raw.steps.slice(0, 6)
    .map((s, idx) => ({
      id: typeof s?.id === "string" && s.id.trim() ? s.id.trim() : `s${idx + 1}`,
      title: String(s?.title ?? "step").slice(0, 200),
      detail: String(s?.detail ?? ""),
      dependsOn: Array.isArray(s?.dependsOn) ? s.dependsOn.map(String).map((x) => x.trim()).filter(Boolean) : undefined,
      accessList: Array.isArray(s?.accessList)
        ? s.accessList.map(String).map((x) => x.trim()).filter(Boolean)
        : undefined,
    }))
    .filter((s) => !isPlaceholder(s.title) && !isPlaceholder(s.detail));
  if (!rawSteps.length) return null;

  const planSteps: PlanStep[] = rawSteps.map((s) => ({
    id: s.id,
    title: s.title,
    detail: s.detail,
    status: "pending",
    attempts: 0,
    dependsOn: s.dependsOn,
    accessList: s.accessList,
  }));

  const { steps: sortedSteps } = validateAndSortDAG(planSteps);

  // Validate the access list AFTER the topological sort, because "earlier" is
  // only meaningful in execution order. A planner that invents an id, points a
  // step at itself, or reads a step that has not run yet would otherwise inject
  // an unsatisfiable reference straight into the context builder.
  const orderIndex = new Map(sortedSteps.map((s, i) => [s.id, i]));
  const steps = sortedSteps.map((s, i) => {
    const access = (s.accessList ?? []).filter(
      (ref) => ref !== s.id && orderIndex.has(ref) && orderIndex.get(ref)! < i,
    );
    return {
      id: s.id,
      title: s.title,
      detail: s.detail,
      ...(s.dependsOn && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
      ...(access.length > 0 ? { accessList: access } : {}),
    };
  });

  return { steps, complexity: raw.complexity === "easy" || raw.complexity === "hard" ? raw.complexity : "medium" };
}

function failureDigest(session: Session): string {
  const task = session.task!;
  return [
    "FAILED ATTEMPTS (do NOT repeat these approaches; change strategy):",
    ...task.stuckEvents.slice(-5).map((e) => `- ${e.kind}: ${e.detail}`),
    ...(task.plan ?? []).filter((s) => s.status === "failed")
      .map((s) => `- step ${s.id} "${s.title}" failed after ${s.attempts} attempt(s): ${s.resultSummary ?? "?"}`),
  ].join("\n");
}

// ── Explore phase (read-only locator agent) ─────────────────────────────────
async function explorePhase(ctx: RunCtx): Promise<string> {
  const { session } = ctx;
  const task = session.task!;
  const span = emit(session, "agent.start", "explorer · locate relevant code", { agentRole: "explorer" });
  // Wave 25: the explorer seed used to carry NO retrieval hits, so the explorer
  // had to rediscover code from scratch with whole-file read_file calls. Now it
  // starts from the same retrieval hits the steps get — verify, don't rediscover.
  const hits = await retrieveHits(session, task.goal);
  const hitBlock = hits.length
    ? hits.map((h) => `- ${h.path}:${h.startLine}${h.endLine > h.startLine ? `-${h.endLine}` : ""}${h.symbol ? ` (${h.symbol})` : ""}\n  ${clip(h.preview ?? "", 160)}`).join("\n")
    : "(none — locate the relevant files yourself)";
  const seed: SysMsg = {
    id: uid(), role: "user", at: Date.now(),
    content: `QUERY: ${task.goal}\nPLANNED STEPS:\n${(task.plan ?? []).map((s) => `- ${s.title}: ${clip(s.detail, 160)}`).join("\n")}\nRETRIEVAL HITS (verify these first):\n${hitBlock}`,
    meta: { explore: true },
  };
  seed.__sys = buildSystemPrompt({ agentsMdRules: loadProjectRules(ctx.root).rules, rolePrompt: EXPLORER_PROMPT });
  try {
    // Wave 25: the explorer is a READ-ONLY locator — it used to receive no
    // allowedTools, so despite "Read-only job" in its prompt it could call
    // write_file/run_command. Pin the toolset to read-side tools only.
    const run = await toolLoop(ctx, "explorer", [seed], span, 6, EXPLORER_TOOLS);
    const digest = clip(run.finalText.replace(/^FINAL:\s*/i, ""), 1500);
    emit(session, "agent.end", "explorer done", { spanId: span, agentRole: "explorer", output: digest });
    return digest;
  } catch (err) {
    // Explorer failure is never fatal — steps fall back to raw retrieval hits.
    emit(session, "agent.end", "explorer skipped", { spanId: span, agentRole: "explorer", input: clip(err instanceof Error ? err.message : String(err), 200) });
    return "";
  }
}

// ── Minimal per-step context assembly ───────────────────────────────────────
const STEP_STOPWORDS = new Set(["should", "which", "there", "their", "about", "after", "before", "where", "these", "those", "using", "based", "make", "sure"]);

function keywordsOf(text: string): string {
  const idents = text.match(/[\w./\\-]+\.\w{1,5}|`[^`]+`|[A-Z][A-Za-z0-9_]{2,}|\b[a-z_][a-z0-9_]{4,}\b/g) ?? [];
  const seen = new Set<string>(); const out: string[] = [];
  for (const w of idents) {
    const k = w.replace(/[`\\]/g, "");
    if (!STEP_STOPWORDS.has(k.toLowerCase()) && !seen.has(k) && out.length < 12) { seen.add(k); out.push(k); }
  }
  return out.join(" ") || text.slice(0, 120);
}

async function retrieveHits(session: Session, query: string): Promise<RetrievalHit[]> {
  try {
    const k = (session.task?.meta?.complexity as string) === "easy" ? 2 : RETRIEVAL_HITS;
    await ensureFresh(resolveProjectRoot(session), session.projectId); // cheap drift probe
    return await retrieve({ projectId: session.projectId, query, k, sessionId: session.id });
  } catch {
    return []; // unindexed/unavailable project → coder falls back to grep/list_dir
  }
}

/**
 * Which earlier steps' results this step should be shown.
 *
 * Three sources, strongest first — the whole point is that a step sees what it
 * NEEDS and nothing else:
 *
 *   1. accessList  — the planner said so explicitly. It had the whole goal in
 *                    view when it decided, so this is the best signal there is.
 *   2. dependency closure — no access list, but the step declares prerequisites.
 *                    Transitive, because if s3 needs s2 and s2 needed s1, the
 *                    facts s1 established are still load-bearing for s3.
 *   3. recency     — nothing declared: fall back to the last few completed
 *                    steps, which is all the old code ever did.
 *
 * Why the fallback order matters: recency alone is actively wrong on any plan
 * longer than four steps. A step depending only on s2 was shown s5–s8 and NOT
 * s2 — the one result it needed was the one it was denied, purely because it
 * had scrolled out of a fixed-size window. Sources 1 and 2 are both relevance-
 * based; recency is only the floor.
 */
export function resolveStepContext(plan: PlanStep[], step: PlanStep, recencyN = 4): PlanStep[] {
  const byId = new Map(plan.map((s) => [s.id, s]));
  const usable = (s: PlanStep | undefined): s is PlanStep =>
    !!s && s.status === "done" && !!s.resultSummary;

  // 1. Explicit information topology.
  if (step.accessList?.length) {
    const picked = step.accessList.map((id) => byId.get(id)).filter(usable);
    if (picked.length) return picked;
    // Every referenced step failed or was skipped: fall through rather than
    // hand the coder an empty context it was told to expect.
  }

  // 2. Transitive dependency closure.
  if (step.dependsOn?.length) {
    const seen = new Set<string>();
    const queue = [...step.dependsOn];
    const out: PlanStep[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id) || id === step.id) continue;   // id === step.id guards a self-cycle
      seen.add(id);
      const dep = byId.get(id);
      if (usable(dep)) out.push(dep);
      for (const up of dep?.dependsOn ?? []) if (!seen.has(up)) queue.push(up);
    }
    if (out.length) {
      // Plan order, so the coder reads them in the order they happened.
      const rank = new Map(plan.map((s, i) => [s.id, i]));
      return out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
  }

  // 3. Recency floor.
  return plan.filter(usable).slice(-recencyN);
}

async function buildStepContext(ctx: RunCtx, step: PlanStep, attempts: number, exploreDigest: string, rules: string | null): Promise<SysMsg> {
  const { session, root } = ctx;
  const isEasy = (session.task?.meta?.complexity as string) === "easy";
  const kw = keywordsOf(`${step.title} ${step.detail}`);
  const hits = isEasy ? [] : await retrieveHits(session, kw);
  const hitBlock = hits.length
    ? hits.map((h) => `- ${h.path}:${h.startLine}${h.endLine > h.startLine ? `-${h.endLine}` : ""}${h.symbol ? ` (${h.symbol})` : ""}\n  ${clip(h.preview ?? "", 180)}`).join("\n")
    : "";
  const pinnedRefs = resolvePinnedRefs(ctx.root, session.contextRefs.filter((r) => r.source === "user"));
  // Critique #12: stash this step's context provenance for the trace emitter —
  // retrieval hits as "lines" refs, then whatever the user pinned.
  const stepContextRefs: ContextRef[] = [
    ...hits.map((h) => ({ kind: "lines" as const, path: h.path, startLine: h.startLine, endLine: h.endLine, source: "retrieval" as const })),
    ...pinnedRefs,
  ];
  if (stepContextRefs.length > 0) currentStepRefs.set(session.id, stepContextRefs);
  const prevDone = resolveStepContext(session.task!.plan ?? [], step);
  const relMsgs = pickRelevantMessages(session, kw);

  // Forge conductor: access-list scoped context from prior steps
  const task = session.task!;
  const taskOuts = stepOutputs.get(task.id);
  const accessListNums = ((step as any).meta?.access_list_numeric as number[] | undefined) ?? [];
  let scopedContextBlock = "";
  if (taskOuts && accessListNums.length > 0) {
    const sections: string[] = [];
    for (const priorId of accessListNums) {
      const prior = taskOuts.get(priorId);
      if (prior) {
        sections.push(`=== Output from [${prior.workerId}] (Step s${priorId}) ===\n${prior.output}`);
      }
    }
    if (sections.length > 0) {
      scopedContextBlock = "ACCESSIBLE CONTEXT FROM PRIOR AGENTS (Sakana Fugu isolation):\n" + sections.join("\n\n");
    }
  }

  const body = [
    `ORIGINAL USER REQUEST (verbatim, authoritative):\n${task.goal}`,
    `STEP ${step.id} (attempt ${attempts}): ${step.title}\nDETAIL:\n${step.detail}`,
    `RETRIEVAL HITS (start here):\n${hitBlock}`,
    pinnedRefs.length ? `USER-PINNED CONTEXT:\n${renderContextBlock(pinnedRefs)}` : "",
    exploreDigest ? `EXPLORER FINDINGS:\n${exploreDigest}` : "",
    scopedContextBlock, // Forge access-list scoped context
    prevDone.length ? `COMPLETED SO FAR:\n${prevDone.map((s) => `- ${s.id}: ${s.resultSummary}`).join("\n")}` : "",
    relMsgs.length ? `RELEVANT MESSAGES:\n${relMsgs.map((m) => `${m.role}: ${clip(m.content, 300)}`).join("\n")}` : "",
    attempts > 1 && step.resultSummary ? `PRIOR ATTEMPT FAILED: ${step.resultSummary}` : "",
    (() => {
      const usedTokens = Object.values(task.tokensUsed ?? {}).reduce((n, u) => n + u.inTok + u.outTok, 0);
      return `--- BUDGET & STATE ---\nTask Step: ${task.stepCount}/${MAX_STEPS} | Tokens Used: ${usedTokens}/${task.maxTokensPerTask ?? 400_000} | Cost: $${task.costUsd.toFixed(4)}`;
    })(),
  ].filter(Boolean).join("\n\n");

  // Select role-specific prompt based on worker_id
  const wid = (step as any).meta?.worker_id as string | undefined;
  let rolePrompt = CODER_PROMPT;
  if (wid === "adversarial_debugger") rolePrompt = CRITIC_PROMPT;
  else if (wid === "synthesizer") rolePrompt = SYNTHESIZER_PROMPT;

  const roster = TOOL_SPECS.map((t) => `- ${t.name}: ${t.description}${toolRequiresApproval(t.name) ? " [needs user approval]" : ""}`).join("\n");
  const m: SysMsg = { id: uid(), role: "user", content: body, at: Date.now(), meta: { stepId: step.id } };
  m.__sys = buildSystemPrompt({
    agentsMdRules: rules, rolePrompt,
    extra: `PROJECT ROOT is "${root}" — tool paths are relative to it.\nAVAILABLE TOOLS:\n${roster}`,
  });
  return m;
}

/** ≤3 most keyword-relevant session messages (recency tiebreak). */
function pickRelevantMessages(session: Session, kw: string): ChatMessage[] {
  const terms = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  return session.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.meta?.bytheway && m.content.length > 20)
    .map((m, idx) => ({ m, score: terms.reduce((n, t) => n + (m.content.toLowerCase().includes(t) ? 1 : 0), 0) * 100 + idx }))
    .sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.m);
}

// ── Tool-call loop (strict text protocol for small models) ──────────────────
interface ToolLoopResult { finalText: string; outcomes: { key: string; ok: boolean }[] }

const CODE_VERBS = /\b(create|write|edit|add|fix|update|refactor|remove|delete|implement|change|modify|rename)\b/i;
// "no files to create or modify" / "nothing to edit" — negated verbs must not
// read as code intent (r4-tasks #9: false nudge → failed step → lost answer).
const NEGATED_CODE = /\b(no|not|nothing|never|without|skip|avoid|don'?t|do not)\b[^.\n]{0,40}\b(create|write|edit|add|fix|update|refactor|remove|delete|implement|change|modify|rename|file|files)\b/i;
// A step that LEADS with a verification verb is a verification/analysis step,
// not a code-change step — even when its detail names files ("Verify calc.js
// exists"). The extension fallback below would otherwise mark it a code step,
// and the NO-OP guard would nudge it to "write code"; it correctly never does
// and burns the wall-clock cap (seen live: two 480s verify-step timeouts).
const VERIFY_LEAD = /^\s*(?:verify|validate|ensure|confirm|check|test)\b/i;

export function impliesCodeChange(step: PlanStep): boolean {
  if (VERIFY_LEAD.test(step.title)) return false;
  const text = `${step.title} ${step.detail}`;
  if (NEGATED_CODE.test(text)) return /\.(ts|tsx|js|jsx|py|go|rs|java|md|json|css|html)\b/.test(step.detail);
  return CODE_VERBS.test(text) || /\.(ts|tsx|js|jsx|py|go|rs|java|md|json|css|html)\b/.test(step.detail);
}

/** Extract TOOL_CALL payloads with lenient JSON and XML/AntML parsing */
function extractToolCalls(text: string): { name: string; args: Record<string, unknown> }[] {
  const clean = text
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<thought[\s\S]*?<\/thought>/gi, "");
  const actions = extractAllActions(clean);
  if (actions.length > 0) {
    return actions.map((a) => ({ name: a.name, args: a.args }));
  }

  const calls: { name: string; args: Record<string, unknown> }[] = [];
  // BUGFIX: small models emit "TOOLCALL:" (no underscore) and mixed case. The
  // marker used to require an exact "TOOL_CALL:", so those calls were never
  // extracted and the step silently "finished" without running the tool.
  const marker = /(?:^|\n)[ \t]*(?:\*\*)?TOOL[_ ]?CALL:(?:\*\*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(clean)) !== null) {
    const start = clean.indexOf("{", m.index + m[0].length - 1);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < clean.length; i++) {
      const c = clean[i]!;
      if (esc) { esc = false; continue; }
      if (inStr && c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) {
      marker.lastIndex = m.index + m[0].length;
      continue;
    }
    marker.lastIndex = end + 1;
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1)) as { name?: unknown; args?: unknown };
      if (typeof parsed.name === "string") {
        calls.push({ name: parsed.name, args: (parsed.args && typeof parsed.args === "object" ? parsed.args : {}) as Record<string, unknown> });
      }
    } catch { /* ignore */ }
  }
  return calls;
}

// ── File-level concurrency lock for DAG parallel step execution ─────────────
const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const norm = path.normalize(relPath || "");
  if (!norm || norm === ".") return await fn();
  while (fileLocks.has(norm)) {
    await fileLocks.get(norm);
  }
  let release: () => void;
  const p = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(norm, p);
  try {
    return await fn();
  } finally {
    fileLocks.delete(norm);
    release!();
  }
}

async function toolLoop(ctx: RunCtx, role: Extract<RouterRole, "coder" | "explorer">, seed: SysMsg[], parentSpan: string, maxCalls: number, allowedTools?: Set<string>, stream?: StreamHook): Promise<ToolLoopResult> {
  const { session, controller } = ctx;
  const phase: RunState["phase"] = role === "explorer" ? "explore" : "step";
  const sys = seed[0]?.__sys ?? buildSystemPrompt({ agentsMdRules: loadProjectRules(ctx.root).rules, rolePrompt: role === "explorer" ? EXPLORER_PROMPT : CODER_PROMPT });
  // r7 FIX: the old filter (`!m.__sys || m !== seed[0]`) evaluated FALSE for
  // the step-context seed (it carries __sys AND is seed[0]), silently DROPPING
  // the step's whole prompt — models were answering from the bare system role,
  // which is exactly how a doomed step looked healthy to every observer.
  // Keep every seed's content; only suppress role:"system" duplicates (a
  // resumed runState replays prior turns that already contain one).
  const msgs: { role: string; content: unknown }[] = [
    { role: "system", content: sys },
    ...seed.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
  ];
  const outcomes: { key: string; ok: boolean }[] = [];
  let nudged = false, nudgeCount = 0, finalText = "";
  /** Bounded: a model that keeps overflowing must not loop forever. */
  let truncations = 0;

  for (let turn = 0; turn <= maxCalls; turn++) {
    // B10: honor the per-step abort (timeout) as well as the task controller.
    if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
    if (Date.now() > ctx.deadline) throw new Error("wall-clock cap exceeded mid-step");
    // B44: drain queued nudges (watchdog interventions / user follow-ups sent
    // while the task runs) and inject them as user turns BETWEEN LLM calls so
    // the model can actually react to them mid-flight.
    if (session.task) {
      for (const nudge of drainNudges(session.task.id)) {
        msgs.push({ role: "user", content: `[NUDGE — adjust course if relevant]\n${nudge}` });
      }
    }
    persistRunState(session, phase, msgs as ChatMessage[]);
    const { res } = await routedLlm(ctx, role, msgs, parentSpan, role === "explorer" ? 1500 : 4096, false, stream);
    // B10: the step may have timed out DURING the call — stop before acting on
    // its result (no tool execution, no persistence, no transcript writes).
    if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
    // ── TRUNCATION GATE ──────────────────────────────────────────────────
    // A reply cut off at max_tokens is not an answer, it is half an answer.
    // Acting on it is how a half-written PyTorch script reached disk: the
    // partial text still parses as a write_file call, the file is created, and
    // every downstream check (reviewer reads the diff, auditor sees a file
    // that exists) reports success on a truncated file.
    //
    // Retry with the SAME context instead. The model is not wrong, it ran out
    // of room — so tell it, and ask for the change in smaller pieces rather
    // than one enormous write.
    if (res.truncated) {
      truncations += 1;
      logger.warn("orchestrator", "completion truncated at max_tokens — not executing its tool call", {
        sessionId: session.id, role, turn, truncations, chars: (res.text ?? "").length,
      });
      emit(session, "error", `output truncated at the token limit — retrying in smaller pieces (${truncations}/${MAX_TRUNCATION_RETRIES})`, {
        parentId: parentSpan, agentRole: role,
      });
      if (truncations <= MAX_TRUNCATION_RETRIES) {
        msgs.push({ role: "assistant", content: clip(res.text ?? "", 400) });
        msgs.push({
          role: "user",
          content:
            "Your previous reply was CUT OFF at the token limit, so it was discarded — nothing was written. " +
            "Do NOT try to emit that whole file in one call. Split the work: create or edit ONE file per " +
            "TOOL_CALL, and for a large file write it in sections using edit_file to append each part. " +
            "Start again with the first piece only.",
        });
        continue;
      }
      finalText = "(stopped: output kept exceeding the token limit)";
      break;
    }

    const text = res.text ?? "";
    const finMatch = text.match(/(?:^|\n)[ \t]*(?:\*\*)?FINAL:(?:\*\*)?[ \t]*([\s\S]*)$/);
    // Native tool calls win over the text protocol.
    //
    // Tool-trained models (gpt-oss-20b and most current instruction models)
    // answer with `message.tool_calls` and an EMPTY content field. Scraping
    // `text` for a TOOL_CALL: line finds nothing there, so before this the
    // coder looked like it had replied with prose and the step died after
    // burning its nudges. The text protocol stays as the fallback for models
    // that do not emit native calls — small local models especially.
    const nativeCalls = res.toolCalls ?? [];
    const calls = finMatch
      ? []
      : nativeCalls.length > 0
        ? nativeCalls.map((c) => ({ name: c.name, args: c.args }))
        : extractToolCalls(text);
    // BUGFIX: canonicalize tool names/args (writefile->write_file, listdir->
    // list_dir, target_file->path) BEFORE the mutation/approval gates below, so
    // a mutated alias is still gated and snapshotted like the real tool.
    for (const c of calls) {
      const norm = normalizeTool(c.name, c.args);
      c.name = norm.name;
      c.args = norm.args;
    }

    if (finMatch) { finalText = (finMatch[1] ?? "").trim() || text.trim(); break; }
    if (calls.length === 0) {
      // BUGFIX: if the reply is clearly TRYING to call a tool but the payload is
      // malformed, keep nudging (bounded) instead of accepting the blob as FINAL
      // — that is how steps reported "done" with no file ever written.
      const attemptingToolCall = /TOOL[_ ]?CALL\s*:|"name"\s*:\s*"/i.test(text);
      const nudgesLeft = attemptingToolCall ? nudgeCount < 3 : !nudged;
      if (nudgesLeft && text.trim()) {
        nudged = true; // small models forget the contract — remind them
        nudgeCount++;
        msgs.push({ role: "assistant", content: text });
        msgs.push({ role: "user", content: 'Protocol reminder: reply with exactly one `TOOL_CALL: {"name":"<tool>","args":{…}}` line (valid JSON, real tool name like write_file / edit_file / run_command), or `FINAL: <summary>`.' });
        continue;
      }
      finalText = text.trim() || "(empty reply)";
      break;
    }

    msgs.push({ role: "assistant", content: text });

    // Wave 25 parallel subagents: a turn that is purely multiple `delegate`
    // calls fans them out concurrently (context-isolated + ungated, so safe).
    // Mixed or single-tool turns stay sequential below.
    if (calls.length >= 2 && !allowedTools && calls.every((c) => c.name === "delegate")) {
      const room = maxCalls - outcomes.length;
      const batch = calls.slice(0, room);
      const results = await runDelegateBatch(ctx, batch, parentSpan);
      if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i]!;
        const result = results[i]!;
        outcomes.push({ key: `${call.name}:${argsHash(call.args)}`, ok: result.ok });
        emit(session, "agent.thought", `tool ${call.name} → ${result.ok ? "ok" : "fail"} (parallel)`, {
          parentId: parentSpan, agentRole: role, input: call.args, output: clip(result.result, 300),
        });
        msgs.push(toolMsg(call.name, { ok: result.ok, result: clip(result.result, 8000) }));
      }
      persistRunState(session, phase, msgs as ChatMessage[]);
      if (calls.length > room) msgs.push(toolMsg("delegate", { ok: false, result: `tool-call cap (${maxCalls}) reached — finish with FINAL:` }));
      if (outcomes.length >= maxCalls) { finalText = "(stopped at tool-call cap)"; break; }
      continue;
    }

    for (const call of calls) {
      if (outcomes.length >= maxCalls) {
        msgs.push(toolMsg(call.name, { ok: false, result: `tool-call cap (${maxCalls}) reached — finish with FINAL:` }));
        break;
      }
      if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
      const mutates = call.name === "write_file" || call.name === "edit_file";
      // Lite-path sandbox FIRST: when a tool allowlist is set, out-of-list
      // calls get a readable refusal instead of executing (answerLite is
      // read-only) — must run before any execution/approval machinery.
      if (allowedTools && !allowedTools.has(call.name)) {
        // Low-item fix: the assistant turn was already appended above (before
        // the call loop) — pushing it again here duplicated the message.
        msgs.push(toolMsg(call.name, { ok: false, result: `tool "${call.name}" is not available in this read-only mode. Available: ${[...allowedTools].join(", ")}` }));
        break;
      }
      // Side-effect gate: park status at waiting-approval while executeTool
      // awaits the human decision; persist pendingCall for crash-resume FIRST.
      const gated = toolRequiresApproval(call.name);
      if (gated) session.task!.status = "waiting-approval";
      persistRunState(session, phase, msgs as ChatMessage[], mutates || gated ? { name: call.name, args: call.args } : undefined);
      if (gated) emitTask(session); // critique #7: badge/dock flip live
      const targetPath = String(call.args.path ?? "");
      if (mutates) captureSnapshot(ctx, targetPath);
      const t0 = Date.now();
      const runCall = () => executeTool({
        sessionId: session.id, projectId: session.projectId, projectRoot: ctx.root,
        name: call.name, args: call.args, autoApprove: READONLY_TOOLS.has(call.name),
        signal: effSignal(ctx), // B10: Stop AND step timeout break an in-flight wait
        parentSpan, // r4-tasks #5: tool/approval spans nest under the coder span
      });
      const result = mutates ? await withFileLock(targetPath, runCall) : await runCall();
      // B10: a step that timed out mid-tool must not keep mutating state.
      if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
      // Critique #24: an approval wait burns wall-clock without doing work —
      // refund the human deliberation time to the deadline (only when a gate
      // actually ran). Low-item fix: refund ONLY the measured approval wait,
      // not the whole gated call — the tool's real execution time must still
      // count against the step budget (the old code over-refunded it).
      if (gated && typeof result.approvalId === "string" && typeof result.approvalWaitMs === "number") {
        ctx.deadline += result.approvalWaitMs;
        // The per-step timer needs the same refund, or a slow human approval
        // kills the very step it was approving.
        ctx.extendStepDeadline?.(result.approvalWaitMs);
      }
      outcomes.push({ key: `${call.name}:${argsHash(call.args)}`, ok: result.ok });
      if (gated) session.task!.status = "running";
      emit(session, "agent.thought", `tool ${call.name} → ${result.ok ? "ok" : "fail"}`, {
        parentId: parentSpan, agentRole: role, durationMs: Date.now() - t0,
        input: call.args, output: clip(result.result, 300),
      });
      msgs.push(toolMsg(call.name, { ok: result.ok, result: clip(result.result, 2000) }));
      persistRunState(session, phase, msgs as ChatMessage[]);
      if (gated) emitTask(session);
    }
    if (outcomes.length >= maxCalls) { finalText = "(stopped at tool-call cap)"; break; }
  }
  return { finalText, outcomes };
}

function toolMsg(name: string, payload: unknown): SysMsg {
  return { id: uid(), role: "user", content: `TOOL_RESULT [${name}]: ${JSON.stringify(payload)}`, at: Date.now() };
}
const asstMsg = (content: string): SysMsg => ({ id: uid(), role: "assistant", content, at: Date.now() });
const userMsg = (content: string): SysMsg => ({ id: uid(), role: "user", content, at: Date.now() });

/** Crash anchor: written before every LLM/tool call, refreshed after each. */
function persistRunState(session: Session, phase: RunState["phase"], partial: ChatMessage[], pendingCall?: { name: string; args: Record<string, unknown> }): void {
  const task = session.task!;
  // B11: PIN the system prompt + step-context seed (the first two messages).
  // The old `slice(-24)` dropped them on long tool loops, so a crash-resumed
  // step replayed with NO system prompt and NO step context — the coder woke
  // up amnesiac and the resume was useless.
  const pinned = partial.slice(0, 2);
  const tail = partial.slice(2).slice(-24);
  const rs: RunState = {
    taskId: task.id, projectId: session.projectId, phase,
    stepIndex: task.currentStep ?? 0, attempts: task.plan?.[task.currentStep ?? 0]?.attempts ?? 1,
    partialMessages: [...pinned, ...tail].map((m) => ({ ...m, content: clip(m.content, 12_000) })),
    ...(pendingCall ? { pendingCall } : {}), savedAt: Date.now(),
  };
  runStates.set(session.id, rs);
  task.meta = { ...task.meta, runState: rs };
  saveSession(session);
}

/** Exported for verification harnesses: seeds the pre-task content of one
 *  relative path (the revert base computeDiffs diffs against). */
export function captureSnapshot(ctx: RunCtx, rel: string): void {
  if (!rel) return;
  const task = ctx.session.task;
  if (!task) return;
  const snap = snapshots.get(task.id) ?? new Map<string, string | null>();
  if (!snapshots.has(task.id)) snapshots.set(task.id, snap);
  if (snap.has(rel)) return; // first modification in the task wins
  let pre: string | null;
  try { pre = fs.readFileSync(path.resolve(ctx.root, rel), "utf8"); }
  catch { pre = null; } // file did not exist yet → "added"
  snap.set(rel, pre);
  // Wave 26: durable checkpoint so the task's footprint can be reverted after
  // it finishes (optimistic execution / reject-and-revert). Best-effort — a
  // checkpoint write failure must never block the tool itself.
  const label = task.goal || task.title || ctx.session.title || "Task";
  try {
    recordCheckpointFile({
      projectId: ctx.session.projectId,
      taskId: task.id,
      sessionId: ctx.session.id,
      root: ctx.root,
      label,
      rel,
      preContent: pre,
    });
  } catch { /* best-effort */ }
  // Wave 26 (critique I2): a delegated subtask's writes are ungated too, but
  // revert is keyed to the ROOT task. Mirror every subtask capture onto the root
  // parent task's checkpoint as well, so rejecting the parent also reverts the
  // files its subagents wrote. Depth limit is 1, so the parent is always the root.
  try {
    const parentId = (task.meta as { delegated?: boolean; parentSessionId?: string } | undefined)?.delegated
      ? (task.meta as { parentSessionId?: string }).parentSessionId
      : undefined;
    if (parentId) {
      const parentSession = findSessionAny(parentId);
      const parentTaskId = parentSession?.task?.id;
      if (parentTaskId && parentTaskId !== task.id) {
        recordCheckpointFile({
          projectId: ctx.session.projectId,
          taskId: parentTaskId,
          sessionId: parentId,
          root: ctx.root,
          label: parentSession!.task?.goal || parentSession!.task?.title || label,
          rel,
          preContent: pre,
        });
      }
    }
  } catch { /* best-effort */ }
}

// ── Routing-transparent LLM calls ───────────────────────────────────────────
const MODEL_DEAD = /\b(unavailable|not found|does not exist|no longer|deactivated|deprecated)\b/i;

/** Quota backoff ladder (r6: was 45/90/135s). With parallel racing, a marathon
 *  wait is pointless — the race already tried 3 models, so if EVERY one is
 *  quota-dead a short pause and another race is the right move. The 3-round
 *  structure + wall-clock deadline checks are unchanged. Exported for smoke
 *  verification (asserting the ladder without waiting 3+ minutes). */
export const QUOTA_BACKOFF_MS = [3_000, 8_000, 15_000] as const;
const QUOTA_RE = /FreeUsageLimitError|rate limit/i;
export const isQuotaBackoff = (err: unknown): boolean =>
  err instanceof LlmError && err.status === 429 && QUOTA_RE.test(err.message);

// ── Wave 25 subagents: real delegation ────────────────────────────────────
// `delegate` used to be a stub that echoed its args. Now it spins up a real,
// bounded sub-agent: a child session in the same project runs a coder-style
// tool loop toward the sub-goal, context-isolated from the parent. Blocking —
// the parent's tool call awaits the report. Depth-limited (a subtask cannot
// delegate further) and budget-capped so delegation can't recurse or run away.
const DELEGATE_MAX_CALLS = 12;      // tool budget for one subtask
const DELEGATE_MAX_MS = 240_000;    // 4-min wall clock per subtask
const subtaskSessions = new Set<string>(); // child session ids (depth guard)

/** Run a batch of `delegate` tool calls concurrently (wave 25 parallel subagents).
 *  Each subtask is context-isolated (own session) and ungated (`delegate` has
 *  sideEffect:false → no HITL), so fanning them out is safe and speeds up
 *  multi-part work. Results preserve input order. Exported for tests. */
export async function runDelegateBatch(
  ctx: RunCtx,
  calls: { name: string; args: Record<string, unknown> }[],
  parentSpan: string,
): Promise<ExecuteToolResult[]> {
  return Promise.all(calls.map((call) => executeTool({
    sessionId: ctx.session.id, projectId: ctx.session.projectId, projectRoot: ctx.root,
    name: call.name, args: call.args, autoApprove: false,
    signal: effSignal(ctx), parentSpan,
  })));
}

export async function runDelegateSubtask(input: DelegateInput): Promise<string> {
  const { sessionId, projectId, projectRoot, role, goal, instructions, signal } = input;
  // Depth guard: a delegated subtask must not delegate further (depth limit 1).
  if (subtaskSessions.has(sessionId)) {
    return `[delegate] refused — already inside a delegated subtask (depth limit 1). Goal was: ${clip(goal, 120)}`;
  }

  const child = newSession(projectId, `subagent · ${clip(goal, 40)}`);
  subtaskSessions.add(child.id);
  const startedAt = Date.now();
  const controller = new AbortController();
  // Budget: give the subtask its own caps (budgetOver() needs budgetUsdCap /
  // maxTokensPerTask to trip) so delegation is not an uncapped spend channel.
  const dsettings = loadSettings();
  const childTask: TaskRecord = {
    id: uid(), sessionId: child.id, title: clip(goal, 60), status: "running",
    goal, createdAt: startedAt, updatedAt: startedAt,
    tokensUsed: {}, costUsd: 0, stepCount: 0, stuckEvents: [],
    budgetUsdCap: dsettings.budgetPerTaskUsd, maxTokensPerTask: dsettings.maxTokensPerTask,
    meta: { delegated: true, parentSessionId: sessionId, role },
  };
  child.task = childTask;
  const ctx: RunCtx = { session: child, root: projectRoot, controller, deadline: startedAt + DELEGATE_MAX_MS, startedAt };

  // Wall-clock enforcement: the cooperative deadline (ctx.deadline) is only
  // checked between LLM calls, so a watchdog hard-aborts the child once active
  // work exceeds it. Approval waits are refunded onto ctx.deadline AND park the
  // task at "waiting-approval", so the watchdog skips them — human deliberation
  // is not counted against the subtask's cap (consistent with top-level tasks).
  // Also propagate parent cancellation (Stop) into the child below.
  const killWatchdog = setInterval(() => {
    if (childTask.status === "waiting-approval") return; // human is deciding
    if (Date.now() > ctx.deadline) {
      controller.abort(new DOMException("subtask wall-clock cap reached", "TimeoutError"));
    }
  }, 2_000);
  const onParentAbort = () => controller.abort(signal?.reason ?? new DOMException("parent task stopped", "AbortError"));
  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const useExplorer = role === "explorer";
  const agentRole = useExplorer ? "explorer" : "coder";
  const span = emit(child, "agent.start", `subagent(${role}) · ${clip(goal, 60)}`, {
    agentRole, input: { goal, instructions: clip(instructions, 300), parentSessionId: sessionId },
  });
  const seed: SysMsg = {
    id: uid(), role: "user", at: Date.now(),
    content: [
      `SUBTASK GOAL: ${goal}`,
      instructions ? `INSTRUCTIONS:\n${instructions}` : "",
      "Complete this focused subtask now. Use tools to inspect and modify the project as needed.",
      "When finished, reply with a single line: FINAL: <concise report of what you did and any files changed>.",
    ].filter(Boolean).join("\n\n"),
    meta: { delegate: true },
  };
  seed.__sys = buildSystemPrompt({
    agentsMdRules: loadProjectRules(projectRoot).rules,
    rolePrompt: useExplorer ? EXPLORER_PROMPT : CODER_PROMPT,
  });

  let ok = false;
  try {
    const run = await toolLoop(ctx, useExplorer ? "explorer" : "coder", [seed], span, DELEGATE_MAX_CALLS, useExplorer ? EXPLORER_TOOLS : undefined);
    const report = clip(run.finalText.replace(/^FINAL:\s*/i, "").trim() || "(subtask returned no report)", 2000);
    emit(child, "agent.end", `subagent(${role}) done`, { spanId: span, agentRole, output: report });
    ok = true;
    return `[delegate report from ${role} subagent]\n${report}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(child, "agent.end", `subagent(${role}) failed`, { spanId: span, agentRole, input: clip(msg, 200) });
    return `[delegate] subtask failed: ${clip(msg, 200)}`;
  } finally {
    clearInterval(killWatchdog);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    subtaskSessions.delete(child.id);
    childTask.status = ok ? "done" : "failed";
    childTask.updatedAt = Date.now();
    // runDelegateSubtask bypasses finalize(): drop the in-memory runStates entry
    // and the crash-anchor meta.runState it would otherwise leak per delegation.
    runStates.delete(child.id);
    if (childTask.meta) delete childTask.meta.runState;
    saveSession(child);
  }
}

// Register the delegate runner so the `delegate` tool does real work (wave 25).
setDelegateRunner(runDelegateSubtask);

/** Test hook: expose the subtask depth-guard set (no LLM needed to assert it). */
export const _subtaskSessionsForTest = subtaskSessions;

async function routedLlm(ctx: RunCtx, role: RouterRole, msgs: { role: string; content: unknown }[], parentSpan: string, maxTokens: number, json = false, stream?: StreamHook): Promise<{ res: ChatResult; modelId: string }> {
  const nativeTools = nativeToolsFor(role);
  const effort = reasoningEffortFor(role);
  const { session, controller } = ctx;
  const task = session.task!;
  const contextTokens = msgs.reduce((n, m) => n + estTokens(String(m.content ?? "")) + 8, 0);
  // Free-tier upstreams flap: a chain can exhaust while healthy models exist.
  // Up to 2 route rounds — the second excludes everything we just watched die.
  let lastErr: unknown = new Error("no candidate model available");
  // r7-B: every model the race touched, across both rounds — chatSweep's
  // exclude list so the last-resort sweep only tries NEVER-TRIED models.
  const triedModels = new Set<string>();
  const noteAttempts = (ids: string[]): void => { for (const id of ids) triedModels.add(id); };
  /** Last-dash full-catalog sweep. Runs once the race AND re-route round have
   *  both exhausted (and after the quota ladder) — before any LLM failure is
   *  allowed to become a TASK failure. Returns null when even the sweep is
   *  dry or when aborting/budget/wall-clock says stop. */
  const sweepLastResort = async (): Promise<{ res: ChatResult; modelId: string } | null> => {
    if (effSignal(ctx).aborted || !(lastErr instanceof LlmError)) return null;
    if (budgetOver(task) || Date.now() > ctx.deadline) return null;
    try {
      emit(session, "llm.retry", "race exhausted — sweeping every other enabled model", {
        parentId: parentSpan, agentRole: "router", input: { exclude: [...triedModels], error: clip(lastErr.message, 200) },
      });
      logger.warn("orchestrator", "race exhausted — starting full-registry sweep", {
        sessionId: session.id, taskId: task.id, role, exclude: [...triedModels], error: clip(lastErr.message, 200),
      });
      const swept = await chatSweep({
        modelId: "", // unused by the sweep — it iterates the registry
        messages: msgs,
        maxTokens,
        signal: effSignal(ctx),
        ...(json ? { responseFormat: "json" as const } : {}),
      }, [...triedModels]);
      recordOutcome(swept.modelId, true, swept.latencyMs);
      accumulateUsage(task, swept.modelId, swept);
      emit(session, "llm.call", `${role} ← ${swept.modelId} (registry sweep)`, {
        parentId: parentSpan, agentRole: role, model: swept.modelId,
        tokensIn: swept.tokensIn, tokensOut: swept.tokensOut, costUsd: costOf(swept.modelId, swept),
        durationMs: swept.latencyMs, input: { messages: msgs.length, maxTokens, swept: true }, output: clip(swept.text, 600),
      });
      logger.info("orchestrator", "llm call via registry sweep", {
        role, model: swept.modelId, latencyMs: swept.latencyMs, tokensIn: swept.tokensIn, tokensOut: swept.tokensOut,
      });
      return { res: swept, modelId: swept.modelId };
    } catch (sweepErr) {
      pushError(session.id, `sweep: ${clip(sweepErr instanceof Error ? sweepErr.message : String(sweepErr), 160)}`);
      return null; // original failure stands
    }
  };

  for (let round = 0; round < 2; round++) {
    try {
      return await routedLlmOnce(ctx, role, msgs, parentSpan, maxTokens, json, contextTokens, round > 0 ? String(lastErr) : undefined, false, noteAttempts, stream);
    } catch (err) {
      lastErr = err;
      if (effSignal(ctx).aborted || err instanceof DOMException) throw err;
      // r8 CONTEXT-OVERFLOW JUMP: a "context length exceeded" error is
      // deterministic — walking the normal retry ladder just replays the same
      // oversized window into smaller models. Skip scoring ONCE and race the
      // healthy model with the LARGEST ctxWindow instead. Failure here falls
      // through to the standard machinery (re-route round → sweep).
      if (err instanceof LlmError && err.overflow) {
        const alt = largestCtxHealthyModel([...triedModels]);
        if (alt && !effSignal(ctx).aborted && !budgetOver(task) && Date.now() < ctx.deadline) {
          triedModels.add(alt.id);
          emit(session, "llm.retry", `context overflow — jumping to largest-window model ${alt.id}`, {
            parentId: parentSpan, agentRole: "router",
            input: { error: clip(err.message, 200), target: alt.id, ctxWindow: alt.ctxWindow },
          });
          logger.warn("orchestrator", "context overflow — one-shot reroute to largest-context model", {
            sessionId: session.id, taskId: task.id, role,
            from: (err as RaceError).raceModelId ?? "race", to: alt.id, ctxWindow: alt.ctxWindow,
          });
          try {
            const r = await chat({
              modelId: alt.id, messages: msgs, maxTokens, signal: effSignal(ctx),
              ...(json ? { responseFormat: "json" as const } : {}),
              ...(nativeTools ? { tools: nativeTools } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
            });
            recordOutcome(alt.id, true, r.latencyMs);
            accumulateUsage(task, alt.id, r);
            emit(session, "llm.call", `${role} ← ${alt.id} (overflow reroute)`, {
              parentId: parentSpan, agentRole: role, model: alt.id,
              tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: costOf(alt.id, r),
              durationMs: r.latencyMs,
              input: { messages: msgs.length, maxTokens, overflowReroute: true }, output: clip(r.text, 600),
            });
            return { res: r, modelId: alt.id };
          } catch (overflowErr) {
            lastErr = overflowErr; // largest window didn't save us either
          }
        }
      }
      const retryable = err instanceof LlmError && err.retryable;
      if (!retryable) {
        // Non-retryable (config/unknown-model): still sweep once before giving
        // up — another PROVIDER may be perfectly healthy. Budget/deadline
        // guards inside sweepLastResort keep this bounded.
        const swept = await sweepLastResort();
        if (swept) return swept;
        throw err;
      }
      // Key-level quota exhaustion (FreeUsageLimitError) hits EVERY model on
      // the same key — fallbacks can't dodge it. Bounded backoff instead of
      // instant task failure; wall-clock deadline still caps total waiting.
      // r6: 45/90/135s → 3/8/15s. chatRace fans out over several models per
      // attempt, so if all of them come back quota-dead the outage is key-wide
      // and minutes of waiting just stalls the UI; short waits re-race fast.
      const quota = isQuotaBackoff(err);
      if (quota) {
        for (let waitRound = 0; waitRound < QUOTA_BACKOFF_MS.length; waitRound++) {
          const waitMs = QUOTA_BACKOFF_MS[waitRound];
          if (waitMs === undefined) break;
          if (Date.now() + waitMs > ctx.deadline) break;
          emit(session, "llm.retry", `quota exhausted — racing again in ${waitMs / 1000}s`, {
            parentId: parentSpan, agentRole: "router", input: { error: clip(String(err.message), 200) },
          });
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            controller.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
            // B10: a step timeout must also end the quota wait immediately.
            ctx.stepSignal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
          try {
            return await routedLlmOnce(ctx, role, msgs, parentSpan, maxTokens, json, contextTokens, "quota-wait", false, noteAttempts);
          } catch (err2) {
            lastErr = err2;
            if (!isQuotaBackoff(err2)) break;
          }
        }
        const sweptAfterQuota = await sweepLastResort();
        if (sweptAfterQuota) return sweptAfterQuota;
        throw lastErr;
      }
    }
  }
  const swept = await sweepLastResort();
  if (swept) return swept;
  throw lastErr;
}

// ── PS 11b(iv): per-agent context snapshots ────────────────────────────────
// "Show the exact files or code chunks in each agent's context over their
// lifetime." The dashboard consumer already existed (SpanDetail's Context tab
// normalizes `meta.context_snapshot`), but nothing ever EMITTED the event, so
// the tab read "no inline context snapshot" on every span. This is the
// producer: one snapshot per LLM call, parented to that call's span, so the
// tree shows exactly what each agent saw at each step.

/** File-and-line references as they appear in assembled prompts. */
const CTX_FILE_RE =
  /(?:^|[\s`([])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:-(\d+))?)?/gm;

/** Distinct file/chunk references in one assembled prompt, capped for size. */
function extractContextFiles(msgs: { role: string; content: unknown }[]): Array<{ path: string; lines?: string }> {
  const seen = new Map<string, { path: string; lines?: string }>();
  for (const m of msgs) {
    const text = typeof m.content === "string" ? m.content : "";
    if (!text) continue;
    CTX_FILE_RE.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = CTX_FILE_RE.exec(text)) !== null) {
      const p = hit[1]!;
      // Skip bare version-ish / package-ish tokens with no path separator and
      // no line anchor — they are almost always prose, not context.
      if (!p.includes("/") && !hit[2]) continue;
      const lines = hit[2] ? (hit[3] ? `${hit[2]}-${hit[3]}` : hit[2]) : undefined;
      const key = lines ? `${p}:${lines}` : p;
      if (!seen.has(key)) seen.set(key, { path: p, ...(lines ? { lines } : {}) });
      if (seen.size >= 64) break;
    }
    if (seen.size >= 64) break;
  }
  return [...seen.values()];
}

/**
 * Emit the exact context handed to one agent for one call. Message bodies are
 * clipped hard — this is an observability record, not a second transcript, and
 * the full text is already on the llm.call span.
 */
function emitContextSnapshot(
  session: Session,
  role: RouterRole,
  msgs: { role: string; content: unknown }[],
  parentSpan: string,
  contextTokens: number,
): void {
  const messages = msgs.map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return { role: m.role, tokens: estTokens(text), content: clip(text, 600) };
  });
  const files = extractContextFiles(msgs);
  emit(session, "context.snapshot", `context: ${role} — ${msgs.length} msgs, ${files.length} files, ~${contextTokens} tok`, {
    parentId: parentSpan,
    agentRole: role,
    input: {
      // `context_snapshot` is the key SpanDetail.normMessages() reads.
      context_snapshot: messages,
      files,
      total_tokens: contextTokens,
      message_count: msgs.length,
    },
  });
}

async function routedLlmOnce(
  ctx: RunCtx,
  role: RouterRole,
  msgs: { role: string; content: unknown }[],
  parentSpan: string,
  maxTokens: number,
  json: boolean,
  contextTokens: number,
  excludeError?: string,
  skipManualOverride = false,
  onAttempts?: (ids: string[]) => void,
  stream?: StreamHook,
): Promise<{ res: ChatResult; modelId: string }> {
  const { session, controller } = ctx;
  const task = session.task!;
  const nativeTools = nativeToolsFor(role);
  const effort = reasoningEffortFor(role);
  // ROUTING TRANSPARENCY: the decision is traced BEFORE the call, live.
  // Critique #10: an explicit per-role pick in settings bypasses scoring
  // entirely — but still degrades into the scored auto-route on any error.
  const settings = loadSettings();
  const overrideId = skipManualOverride ? undefined : (settings.selectedModels as Partial<Record<RouterRole, string>>)[role];
  const overrideSpec = overrideId ? registry.get(overrideId) : undefined;
  const disabled = new Set(settings.disabledModels ?? []);
  const manualOverride = !!overrideSpec && overrideSpec.enabled && !disabled.has(overrideSpec.id);

  let decision: RouteDecision;
  let attempts: string[];
  if (overrideSpec && manualOverride) {
    // A role pin says "PREFER this model", not "never recover". The pin used to
    // also empty the fallback list, so a pinned model that stalled or hit a rate
    // limit had nothing to fall through to and simply retried itself — which is
    // precisely the situation fallbacks exist for, and it defeats the recovery
    // requirement exactly for users who took the trouble to configure pins.
    // Observed live: `route decision {primary: engine/small, fallbacks: []}`
    // followed by a 180s stall and a retry against the same stalled model.
    //
    // So: keep the pin as primary and scoring skipped, but ask the router for
    // the candidates it WOULD have chosen, to be used only after the pin fails.
    // Cost is unchanged in the healthy case — a healthy primary is still a
    // single call, and these ids are consulted only on error.
    const scored = await decideRoute({
      sessionId: session.id, role, userPrompt: task.goal,
      contextTokens, tokensUsedSoFar: Object.values(task.tokensUsed).reduce((n, u) => n + u.inTok + u.outTok, 0),
      costUsedSoFarUsd: task.costUsd, budgetCapUsd: task.budgetUsdCap, recentErrors: lastErrors.get(session.id),
    }).catch(() => null);
    const recovery = [...(scored ? [scored.modelId, ...scored.fallbacks] : [])]
      .filter((id) => id && !id.startsWith("(") && id !== overrideSpec.id && !disabled.has(id));

    decision = {
      modelId: overrideSpec.id,
      provider: overrideSpec.provider,
      reason: "manual role override",
      signals: [{ name: "manual-override", value: role, note: `settings.selectedModels.${role} = ${overrideSpec.id} — scoring skipped; ${recovery.length} recovery candidate(s) held in reserve` }],
      complexity: 0,
      fallbacks: recovery.slice(0, 2),
      at: Date.now(),
    };
    attempts = [overrideSpec.id, ...decision.fallbacks];
  } else {
    decision = await decideRoute({
      sessionId: session.id, role, userPrompt: task.goal,
      contextTokens, tokensUsedSoFar: Object.values(task.tokensUsed).reduce((n, u) => n + u.inTok + u.outTok, 0),
      costUsedSoFarUsd: task.costUsd, budgetCapUsd: task.budgetUsdCap, recentErrors: lastErrors.get(session.id),
    });
    attempts = [decision.modelId, ...decision.fallbacks.slice(0, 2)].filter((id) => id && !id.startsWith("("));
  }
  // r7-A: route decisions are info-level (diagnosing "why did it pick THAT
  // model" is the single most common post-mortem question).
  logger.info("orchestrator", "route decision", {
    sessionId: session.id, taskId: task.id, role,
    primary: decision.modelId, fallbacks: decision.fallbacks, reason: decision.reason,
    ...(excludeError ? { excludeError } : {}),
  });
  onAttempts?.(attempts);
  emit(session, "route", `route ${role} → ${decision.modelId}`, { parentId: parentSpan, agentRole: "router", input: decision });
  // PS 11b(iv): record what this agent is about to see, before it sees it.
  emitContextSnapshot(session, role, msgs, parentSpan, contextTokens);
  if (effSignal(ctx).aborted) throw new DOMException("aborted", "AbortError");
  const midOver = budgetOver(task);
  if (midOver) throw new Error(`${midOver} — halting mid-call`);

  // B16 SINGLE-MODEL DEFAULT: the old code raced primary + 2 fallbacks on
  // EVERY call, burning ~3× the tokens for one answer even when the fleet was
  // healthy. Now a healthy primary on the first round gets a single chat();
  // racing is OPT-IN — only when the primary is degraded (breaker open/
  // degraded or a health penalty on file) or when we are already in a
  // retry/re-route round (excludeError set): exactly when fast failover
  // matters more than token cost.
  const primaryId = attempts[0]!;
  const primaryBreaker = effectiveBreakerState(primaryId);
  const primaryPenalty = effectivePenalty(primaryId);
  const primaryDegraded = primaryBreaker === "open" || primaryBreaker === "degraded" || primaryPenalty >= 0.25;

  // RACE ONLY ACROSS INDEPENDENT PROVIDERS.
  //
  // Racing is a failover mechanism, and failover only helps when the candidates
  // can fail INDEPENDENTLY. Models served by the same provider share one rate
  // limit, so they fail together — racing them does not buy a second chance, it
  // just puts 3x the requests into the bucket that is already rejecting you.
  //
  // Measured on a 3-step task with only Groq keyed: 16 successful LLM calls
  // took 11s of model time inside a 174s task, with 97 HTTP 429s in between.
  // The degraded-primary trigger fires precisely BECAUSE of those 429s, so the
  // old condition formed a feedback loop — 429 raises the health penalty, the
  // penalty enables racing, racing triples the load on the same account, and
  // that produces more 429s.
  //
  // Requiring two distinct providers keeps fast failover where it genuinely
  // helps (a dead provider, with a healthy alternative to jump to) and makes
  // same-provider fallbacks sequential, which is what a shared quota wants.
  const providerOf = (id: string): string => registry.get(id)?.provider ?? id;
  const distinctProviders = new Set(attempts.map(providerOf)).size;
  const shouldRace = attempts.length > 1 && distinctProviders > 1 && (primaryDegraded || !!excludeError);
  if (attempts.length > 1 && distinctProviders === 1 && (primaryDegraded || excludeError)) {
    logger.info("orchestrator", "not racing: all candidates share one provider (shared rate limit)", {
      sessionId: session.id, role, provider: providerOf(primaryId), candidates: attempts.length,
    });
  }
  // B16: slow-but-healthy models need room to finish — coder/reviewer slots get
  // 120 s, everyone else 90 s (the old global 45 s killed long completions).
  const maxSlotMs = role === "coder" || role === "reviewer" ? 120_000 : 90_000;

  // r6 PARALLEL RACING (when enabled): primary + fallbacks launch staggered;
  // first non-empty answer wins ("retry should be very fast" — a dead primary
  // no longer burns its full timeout before the next model is even tried).
  // Losers that ERRORED feed health/pushError and get one llm.retry trace
  // each; losers ABORTED because someone else won are ignored — that is the
  // race working; losers returning an EMPTY 200 get a small non-breaker
  // penalty (B16) and their usage is still counted (B15).
  const erroredLosers: { modelId: string; status?: number; msg: string }[] = [];
  let res: ChatResult & { modelId: string };
  try {
    if (shouldRace) {
      res = await chatRace({
        modelId: primaryId,
        candidates: attempts,
        messages: msgs,
        maxTokens,
        signal: effSignal(ctx),
        maxSlotMs,
        ...(json ? { responseFormat: "json" as const } : {}),
        ...(nativeTools ? { tools: nativeTools } : {}),
        // Wave 25: live token deltas for the fluid chat UI (chatRace forwards
        // only the leader's stream — see providers.ts).
        ...(stream ? { onDelta: stream.push } : {}),
        onLoser: ({ modelId, outcome, latencyMs, error, tokensIn, tokensOut }) => {
          if (outcome === "aborted") {
            // B15: a loser that finished 200-OK after the winner still spent
            // its tokens — count them (no health impact: that is the race
            // working as intended). Mid-flight aborts carry no usage.
            if ((tokensIn ?? 0) > 0 || (tokensOut ?? 0) > 0) {
              accumulateUsage(task, modelId, { text: "", tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, latencyMs });
            }
            return;
          }
          if (outcome === "empty") {
            // B16: small, non-breaker penalty — one empty reply must not demote
            // a healthy model for minutes the way the old 5xx-class filing did.
            recordEmptyOutcome(modelId, latencyMs);
            // B15: the empty 200-OK still consumed tokens — count them so the
            // budget ledger reflects reality.
            accumulateUsage(task, modelId, { text: "", tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, latencyMs });
            erroredLosers.push({ modelId, msg: "empty completion" });
            return;
          }
          const msg = error instanceof Error ? error.message : String(error);
          const status = error instanceof LlmError ? error.status : undefined;
          // B26: pass the REAL status through. recordOutcome's 4xx exemption
          // already keeps client-shape errors from poisoning health; the old
          // vague-400→503 remap defeated that exemption and demoted models for
          // request-shape errors they did not cause.
          recordOutcome(modelId, false, latencyMs, status);
          pushError(session.id, `${modelId}: ${msg}`);
          erroredLosers.push({ modelId, status, msg });
        },
      });
    } else {
      // Single-model fast path: healthy primary, first round, no retry context.
      const t0 = Date.now();
      try {
        const single = await chat({
          modelId: primaryId, messages: msgs, maxTokens, signal: effSignal(ctx),
          ...(json ? { responseFormat: "json" as const } : {}),
          ...(stream ? { onDelta: stream.push } : {}),
          ...(nativeTools ? { tools: nativeTools } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
        });
        res = { ...single, modelId: primaryId };
      } catch (singleErr) {
        // Mirror the race's loser bookkeeping so the health ledger sees the
        // failure exactly once, then rethrow into the shared catch below.
        if (!effSignal(ctx).aborted && !(singleErr instanceof DOMException)) {
          recordOutcome(primaryId, false, Date.now() - t0, singleErr instanceof LlmError ? singleErr.status : undefined);
          pushError(session.id, `${primaryId}: ${singleErr instanceof Error ? singleErr.message : String(singleErr)}`);
        }
        if (singleErr instanceof Error) (singleErr as RaceError).raceModelId = primaryId;
        throw singleErr;
      }
    }
  } catch (err) {
    if (effSignal(ctx).aborted || err instanceof DOMException) throw err; // Stop / step timeout unwind untouched
    const msg = err instanceof Error ? err.message : String(err);
    // Critique #10: a hand-pinned model that errors must degrade into the
    // scored auto-route (once — skipManualOverride prevents recursion)
    // instead of killing the task.
    if (manualOverride) {
      emit(session, "llm.retry", `manual override ${primaryId} failed (${(err as LlmError).status ?? "error"}) → falling back to auto-routing`, {
        parentId: parentSpan, agentRole: role, model: primaryId,
        input: { error: clip(msg, 300), override: overrideId },
      });
      return routedLlmOnce(ctx, role, msgs, parentSpan, maxTokens, json, contextTokens, excludeError ?? msg, true);
    }
    // Exhausted call: throw; outer routedLlm re-routes once with fresh health
    // state (dead models now penalized) before giving up. r4-tasks #2: name
    // the model whose failure ended the chain — chatRace marks the most
    // informative loser it rethrew with raceModelId.
    const raceModel = (err as RaceError).raceModelId ?? attempts[attempts.length - 1];
    if (err instanceof LlmError) throw new LlmError(`model ${raceModel}: ${err.message}`, err.status, err.retryable);
    throw err;
  }
  recordOutcome(res.modelId, true, res.latencyMs);
  accumulateUsage(task, res.modelId, res);
  logger.info("orchestrator", "llm call ok", {
    sessionId: session.id, taskId: task.id, role, model: res.modelId,
    latencyMs: res.latencyMs, tokensIn: res.tokensIn, tokensOut: res.tokensOut,
    raced: shouldRace ? attempts : [res.modelId],
    ...(res.estimated ? { tokensEstimated: true } : {}),
  });
  // Wave 25: flush the delta throttle BEFORE the llm.call trace — the web
  // store seals the stream accumulator when that trace arrives, so the last
  // coalesced chunk must already be on the wire.
  stream?.flush();
  // Label the trace with the model that ACTUALLY answered, not the alias we
  // asked for. `engine/small` is a tier request; `openai/gpt-oss-20b@groq` is
  // the fact. The badge in the chat reads this, which is what makes "which
  // model is handling this?" answerable at a glance.
  const upstreamLabel = res.upstream ? `${res.upstream.model}@${res.upstream.provider}` : res.modelId;
  emit(session, "llm.call", `${role} ← ${upstreamLabel}`, {
    parentId: parentSpan, agentRole: role, model: upstreamLabel,
    tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: costOf(res.modelId, res),
    durationMs: res.latencyMs,
    input: {
      messages: msgs.length, maxTokens, raced: shouldRace ? attempts : [res.modelId],
      // Wave 25: when streamed, the web store already rendered this call's
      // text live under the parent span — it seals that accumulator instead of
      // re-rendering a duplicate bubble. reasoning rides for the Thinking box.
      ...(stream ? { streamed: true } : {}),
      ...(res.reasoningContent ? { reasoning: clip(res.reasoningContent, 2000) } : {}),
      // Full routing provenance: alias asked for, model actually used, and the
      // router's own reason string. PS 3b — the decision can never be hidden.
      ...(res.upstream
        ? { upstream: res.upstream, aliasRequested: res.modelId }
        : {}),
    },
    output: clip(res.text, 600),
    ...(res.estimated ? { tokensEstimated: true } : {}),
  });
  for (const l of erroredLosers) {
    emit(session, "llm.retry", `${l.modelId} failed (${l.status ?? "network"}) → lost race to ${res.modelId}`, {
      parentId: parentSpan, agentRole: role, model: l.modelId,
      input: { error: clip(l.msg, 300), winner: res.modelId },
    });
  }
  return { res, modelId: res.modelId };
}

function costOf(modelId: string, r: ChatResult): number {
  const spec = registry.get(modelId);
  return spec ? (r.tokensIn / 1e6) * spec.costInPerM + (r.tokensOut / 1e6) * spec.costOutPerM : 0;
}
function accumulateUsage(task: NonNullable<Session["task"]>, modelId: string, r: ChatResult): void {
  const u = task.tokensUsed[modelId] ?? { inTok: 0, outTok: 0, calls: 0 };
  u.inTok += r.tokensIn; u.outTok += r.tokensOut; u.calls += 1;
  task.tokensUsed[modelId] = u;
  task.costUsd += costOf(modelId, r);
  task.updatedAt = Date.now();
}

// ── Review phase ────────────────────────────────────────────────────────────
interface Verdict { verdict: "pass" | "fail"; issues: string[] }

async function reviewStep(ctx: RunCtx, step: PlanStep, patchText: string, coderSpan: string): Promise<Verdict> {
  const span = emit(ctx.session, "agent.start", `reviewer · ${step.id}`, { parentId: coderSpan, agentRole: "reviewer", input: { goal: step.title } });
  const msgs = [
    { role: "system", content: buildSystemPrompt({ agentsMdRules: loadProjectRules(ctx.root).rules, rolePrompt: REVIEWER_PROMPT }) },
    { role: "user", content: `STEP GOAL: ${step.title}\n${step.detail}\n\nUNIFIED DIFF:\n${truncatePatchForReview(patchText, PATCH_CHAR_CAP) || "(no textual changes captured)"}` },
  ];
  try {
    const { res, modelId } = await routedLlm(ctx, "reviewer", msgs, span, 2048, true);
    let verdict = sanitizeVerdict(parseJsonLoose<Verdict>(res.text));
    // Hallucinated-review guard: a "fail" whose issues reference NONE of the
    // changed paths derails weak coders into editing random files. Require the
    // review to talk about the actual diff (a changed path, or a concrete
    // defect keyword); otherwise treat as pass-with-note.
    if (verdict.verdict === "fail") {
      const changedPaths = extractChangedPaths(patchText);
      const grounded = verdict.issues.some((iss) => {
        const low = iss.toLowerCase();
        const mentionsPath = changedPaths.some((p) => low.includes(p.toLowerCase()) || low.includes(p.toLowerCase().split("/").pop()!));
        const concrete = /\b(diff|hunk|missing|syntax|broken|incorrect|wrong|fails?|error)\b/.test(low);
        return mentionsPath || concrete;
      });
      if (!grounded) {
        emit(ctx.session, "review", "reviewer fail not grounded in diff — treating as pass", {
          parentId: span, agentRole: "reviewer", output: { issues: verdict.issues, changedPaths },
        });
        return { verdict: "pass", issues: [`reviewer fail discarded (not grounded in changed files: ${changedPaths.join(", ") || "none"})`] };
      }
    }
    // Deterministic incomplete-output guard (false-PASS catch): a source file
    // explicitly named in the step goal that is NEITHER in the diff NOR
    // pre-existing (task-start snapshot) was supposed to be created but wasn't.
    // The reviewer LLM can miss this — seen live under concurrent load: the
    // planner fell back to a single step, the coder wrote index.html (which
    // referenced quotes.js) but never created quotes.js, and the reviewer
    // passed. Fail the step so the coder retries and creates the file.
    if (verdict.verdict === "pass") {
      // Multi-step plans check only the step TITLE (a step's detail routinely
      // names files OTHER steps create → false positive; seen live: "Create
      // index.html with stopwatch UI" flagged stopwatch.js which step 2
      // creates). Single-step plans (e.g. the fallback "execute goal directly"
      // when the planner fails) carry the whole goal in the detail, so check
      // title+detail there.
      const isSingleStep = (ctx.session.task!.plan ?? []).length === 1;
      const missing = goalNamedFilesMissing(step, patchText, snapshots.get(ctx.session.task!.id), isSingleStep);
      if (missing.length > 0) {
        verdict = { verdict: "fail", issues: [...missing.map((f) => `The goal names "${f}" but it is missing from the changes and did not exist before — you must create it.`), ...verdict.issues].slice(0, 3) };
        emit(ctx.session, "review", `goal-named file(s) missing from diff — failing: ${missing.join(", ")}`, { parentId: span, agentRole: "reviewer", output: verdict });
      }
    }
    emit(ctx.session, "agent.end", `reviewer · ${step.id} → ${verdict.verdict}`, {
      spanId: span, agentRole: "reviewer", model: modelId,
      tokensIn: res.tokensIn, tokensOut: res.tokensOut, output: verdict,
    });
    return verdict;
  } catch (err) {
    // Reviewer unavailability must not wedge the pipeline: auto-pass w/ note.
    const msg = err instanceof Error ? err.message : String(err);
    emit(ctx.session, "error", "reviewer unavailable — auto-pass", { parentId: span, agentRole: "reviewer", input: clip(msg, 300) });
    return { verdict: "pass", issues: [`reviewer skipped: ${clip(msg, 120)}`] };
  }
}

function sanitizeVerdict(v: Verdict | null): Verdict {
  if (!v || (v.verdict !== "pass" && v.verdict !== "fail")) return { verdict: "pass", issues: ["unparseable verdict — treated as pass"] };
  return { verdict: v.verdict, issues: (Array.isArray(v.issues) ? v.issues : []).slice(0, 3).map((i) => clip(String(i), 300)) };
}

function extractChangedPaths(patchText: string): string[] {
  const out = new Set<string>();
  // git-style headers (run_command git-diff fallback chunks).
  for (const m of patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    const p = m[2];
    if (p) out.add(p);
  }
  // jsdiff createTwoFilesPatch headers (snapshot-derived diffs) emit
  // "Index: <path>" — NOT "diff --git" — so those must be matched too or every
  // write_file/edit_file change (incl. every newly created file) is invisible.
  for (const m of patchText.matchAll(/^Index: ([^\n\r]+)/gm)) {
    const p = m[1]?.trim();
    if (p) out.add(p);
  }
  return [...out];
}

/** Source-file name matcher for goal text. Limited to code/source extensions a
 *  step would CREATE — data extensions (.json/.csv/.txt/.md) are excluded since
 *  those are commonly read as inputs, not produced. */
const GOAL_SRC_FILE_RE = /[\w./-]+\.(?:tsx|ts|jsx|js|mjs|html|htm|css|scss|py|go|rs|java|c|cpp|sh|vue|svelte)\b(?!\.\w)/gi;
// A source file that is the DIRECT OBJECT of a create-verb ("create index.html",
// "make quotes.js"). For multi-step steps the title may also REFERENCE files that
// other steps create ("linking style.css", "loads game.js") — those must NOT be
// flagged as missing from this step, so only create-verb objects are checked.
const CREATE_VERB_FILE_RE = /\b(?:create|creates|creating|created|make|makes|making|made|write|writes|writing|wrote|build|builds|building|built|add|adds|adding|added|implement|implements|implementing|implemented|generate|generates|generating|generated|produce|produces|producing|produced|author|authors|authoring|authored|draft|drafts|drafting|drafted|scaffold|scaffolds|scaffolding|scaffolded|compose|composes|composing|composed|craft|crafts|crafting|crafted|construct|constructs|constructing|constructed|assemble|assembles|assembling|assembled|prepare|prepares|preparing|prepared)\s+(?:the\s+|a\s+|an\s+)?([\w./-]+\.(?:tsx|ts|jsx|js|mjs|html|htm|css|scss|py|go|rs|java|c|cpp|sh|vue|svelte))\b(?!\.\w)/gi;

/** Return source files explicitly named in the step goal/detail that are absent
 *  from BOTH the diff and the pre-task snapshot — i.e. they were meant to be
 *  created by this step but were not. Used by reviewStep as a deterministic
 *  false-pass guard (the reviewer LLM can overlook a missing referenced file).
 *  Matching is by basename so "quotes.js" matches a diff path "app/quotes.js". */
export function goalNamedFilesMissing(step: PlanStep, patchText: string, preExisting: Map<string, string | null> | undefined, includeDetail = true): string[] {
  const named = new Set<string>();
  if (includeDetail) {
    // Single-step plans (e.g. the planner fallback) carry the whole goal in the
    // detail, so every named source file must be created by this one step.
    for (const m of `${step.title} ${step.detail}`.matchAll(GOAL_SRC_FILE_RE)) {
      if (m[0].includes("//")) continue; // a URL (https://cdn.x/widget.js), not a local file
      named.add(m[0]);
    }
  } else {
    // Multi-step: only files that are the DIRECT OBJECT of a create-verb in the
    // title ("Create index.html"). The title may also REFERENCE files other steps
    // create ("linking style.css", "loads game.js") — those must NOT be flagged
    // as missing from THIS step (seen live: memory-game step 1 "Create index.html
    // linking style.css and loads game.js" was wrongly failed).
    for (const m of step.title.matchAll(CREATE_VERB_FILE_RE)) {
      if (m[1] && !m[1].includes("//")) named.add(m[1]); // skip URLs
    }
  }
  if (named.size === 0) return [];
  const changedBases = extractChangedPaths(patchText).map((p) => p.toLowerCase().split("/").pop()!);
  // Only files that genuinely PRE-EXISTED the task (non-null snapshot value). A
  // null value means "did not exist pre-task" (a new file or a FAILED write
  // attempt) and must NOT count as pre-existing, else a failed write_file would
  // register the key and mask a missing file (false negative for the exact
  // failure mode this guard exists to catch).
  const preBases = preExisting
    ? [...preExisting.entries()].filter(([, v]) => v !== null).map(([k]) => k.toLowerCase().split("/").pop()!)
    : [];
  const missing: string[] = [];
  for (const f of named) {
    const base = f.toLowerCase().split("/").pop()!;
    if (changedBases.includes(base)) continue; // created/modified in this diff
    if (preBases.includes(base)) continue; // existed before the task (input/pre-existing)
    missing.push(f);
  }
  return missing;
}

// ── Diffs & change proposals ────────────────────────────────────────────────
/** Snapshot-derived diffs (write/edit tools) + git-tracked leftovers
 *  (run_command effects), deduped by path — the snapshot wins. Git-fallback
 *  chunks byte-identical to the task-start baseline (r2b-review R2B-3) are
 *  EXCLUDED: pre-existing uncommitted changes are not agent work. */
export function computeDiffs(ctx: RunCtx): { files: FileDiff[]; patchText: string } {
  const task = ctx.session.task!;
  const rawPatch = (rel: string, before: string | null, after: string | null): string =>
    createTwoFilesPatch(rel, rel, before ?? "", after ?? "", "before", "after", { context: 3 });
  interface Change { rel: string; before: string | null; after: string | null; viaGit?: string }
  const changes: Change[] = [];
  const snap = snapshots.get(task.id);
  if (snap) {
    for (const [rel, before] of snap) {
      let after: string | null = null;
      try { after = fs.readFileSync(path.resolve(ctx.root, rel), "utf8"); } catch { after = null; }
      if (before !== after) changes.push({ rel, before, after });
    }
    // Critique #21: snapshots are NOT consumed here — a multi-step task keeps
    // its revert base across steps; finalize() deletes them at task end.
  }
  const covered = new Set(changes.map((c) => c.rel));
  const baseline = chunkByPath(ctx.gitBaseline);
  if (fs.existsSync(path.join(ctx.root, ".git"))) {
    try { // catch shell-effect edits the snapshot map cannot see
      const patch = execFileSync("git", ["--no-pager", "diff", "HEAD", "--unified=3"], { cwd: ctx.root, encoding: "utf8", timeout: 2_500 });
      for (const chunk of patch.split(/\n(?=diff --git )/)) {
        const rel = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2];
        if (!rel || covered.has(rel) || !chunk.includes("@@")) continue;
        // Dirty-worktree guard: a chunk identical to the task-start baseline
        // is pre-existing WIP, not something this task produced.
        if (baseline.get(rel) === chunk.trim()) continue;
        changes.push({ rel, before: null, after: null, viaGit: chunk });
      }
    } catch { /* unborn HEAD / not a repo / git missing */ }
  }
  const files = changes.map((c) => {
    const fd = parseUnifiedPatch(c.rel, c.viaGit ?? rawPatch(c.rel, c.before, c.after));
    if (c.before === null && c.after !== null) fd.status = "added";
    else if (c.after === null && c.before !== null) fd.status = "deleted";
    return fd;
  });
  return { files, patchText: changes.map((c) => c.viaGit ?? rawPatch(c.rel, c.before, c.after)).join("\n\n") };
}

/** Unified-diff text → FileDiff hunks: shared parser lives in apply.ts
 *  (buildFileDiff uses the same one, so review and apply agree on hunk shape). */

/** B31: stable content fingerprint of one file diff (path + status + exact
 *  hunk lines). Used to dedupe byte-identical proposals within a task. */
function fileDiffFingerprint(f: FileDiff): string {
  const hunkText = f.hunks
    .map((h) => `${h.header}\n${h.lines.map((l) => `${l.type}:${l.text}`).join("\n")}`)
    .join("\n");
  return crypto.createHash("sha256")
    .update(`${f.path}\u0000${f.status}\u0000${hunkText}`)
    .digest("hex").slice(0, 24);
}

function recordProposal(ctx: RunCtx, files: FileDiff[], rationale: string, parentSpan?: string): ChangeProposal | null {
  // P2 misattribution guard: files already materialized by a HUMAN-approved
  // gated write/edit earlier in THIS step carry their own review card —
  // re-listing them in the batch "step" proposal would present human-approved
  // edits as agent output (and double-count them). Skip those paths here.
  //
  // REMAINING GAP (documented, accepted): the exclusion is per-PATH, not per-
  // hunk. If the coder ALSO hand-edited one of those paths beyond the gated
  // diff within the same step, those extra hunks are hidden from this batch
  // proposal too (they still show in the next step's snapshot diff, and the
  // tool-gated card itself showed the gated part at approval time).
  const covered = gatedAppliedPaths(ctx.session.id);
  // B31: dedupe by taskId + path + content-hash. Retried steps — and the
  // step-diff path, which bypasses gatedAppliedPaths entirely — used to file a
  // second byte-identical proposal for changes already on record, so the
  // review UI showed the same diff twice (and "accept all" applied it twice).
  // Any file whose exact content already sits in a non-rejected proposal of
  // THIS task is skipped.
  const taskId = ctx.session.task!.id;
  const seen = new Set<string>();
  for (const p of listProposals(ctx.session.id)) {
    if (p.taskId !== taskId || p.status === "rejected") continue;
    for (const f of p.files) seen.add(`${f.path}\u0000${fileDiffFingerprint(f)}`);
  }
  const fresh = files.filter((f) => !covered.has(f.path) && !seen.has(`${f.path}\u0000${fileDiffFingerprint(f)}`));
  if (files.length > 0 && fresh.length === 0) {
    emit(ctx.session, "diff.propose", `proposal skipped (all ${files.length} file(s) already covered by approved tool gates or an identical earlier proposal): ${rationale}`, {
      parentId: parentSpan, agentRole: "orchestrator", input: { rationale }, output: files.map((f) => `${f.path} (${f.status})`),
    });
    return null;
  }
  const proposal: ChangeProposal = {
    id: uid(), sessionId: ctx.session.id, taskId: ctx.session.task!.id, files: fresh, rationale,
    createdAt: Date.now(), status: "applied", // writes already landed via gated tools
  };
  putProposal(proposal);
  ctx.session.task!.meta = { ...ctx.session.task!.meta, proposalId: proposal.id };
  emit(ctx.session, "diff.propose", `proposal ${proposal.id.slice(0, 8)}: ${rationale}`, {
    parentId: parentSpan, agentRole: "orchestrator", input: { rationale },
    output: fresh.map((f) => `${f.path} (${f.status}, +${f.additions} −${f.deletions})`),
  });
  wire.emit({ type: "proposal", proposal });
  return proposal;
}

// ── Stuck detection (graded) ────────────────────────────────────────────────
function detectStuck(session: Session, step: PlanStep): StuckEvent | null {
  const base = { at: Date.now(), stepId: step.id };
  if (step.attempts >= STEP_ATTEMPTS_MAX) {
    return { ...base, kind: "step-attempts", detail: `step ${step.id} attempted ${step.attempts}× (cap ${STEP_ATTEMPTS_MAX}); last: ${clip(step.resultSummary ?? "", 160)}` };
  }
  // Same (toolName, argsHash) failing ≥2 times back-to-back.
  const hist = toolHist.get(session.task!.id) ?? [];
  const last = hist[hist.length - 1];
  if (last && !last.ok) {
    let consec = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      const e = hist[i]!;
      if (e.key !== last.key || e.ok) break;
      consec++;
    }
    if (consec >= 2) {
      const [toolName, hash] = last.key.split(":");
      return { ...base, kind: "repeat-fail", detail: `tool ${toolName} (argsHash ${hash}) failed ${consec}× consecutively` };
    }
  }
  // ≥3 byte-identical normalized assistant outputs → the model is looping.
  const texts = textHist.get(session.task!.id) ?? [];
  const last3 = texts.slice(-3);
  if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2] && last3[0]) {
    return { ...base, kind: "repeat-text", detail: `3 identical assistant outputs: "${clip(last3[0], 120)}"` };
  }
  return null;
}

// ── Trivial triage + lite answering (still routed) ──────────────────────────
// B14: CODE_INTENT NARROWED to strong imperative work verbs. Noun-ish words
// ("config", "build", "test"…) used to push pure questions ("what does the
// build do?") into the full planner. Questions are handled by the
// question-branch below, which ignores this list entirely.
// BUGFIX: "make" (and other unambiguous creation verbs) were missing, so
// "make a 3d flappy bird game" triaged as trivial → read-only answerLite →
// no files were ever written. Added make/generate/develop/scaffold.
export const CODE_INTENT = /\b(fix|add|implement|refactor|write|create|make|generate|develop|scaffold|update|delete|remove|migrate|install|debug|build|test|optimi[sz]e|rename|move|port|convert|extend|integrate|patch|revert)\b/i;
export const QUESTIONISH = /^\s*(what|why|who|when|where|which|explain|difference|meaning|define|is|are|can|does|do|should|how|summarize|summarise|describe|list)\b/i;
/** Polite task requests ("can you make a game", "please create a component")
 *  lead with a QUESTIONISH word (can/could/would/please…) but are IMPERATIVES,
 *  not questions. Without this, Branch 1 below would route them to the read-only
 *  lite path even when they carry a strong code-intent verb. */
const POLITE_LEADIN = /^\s*(?:can|could|would|will|please|help\s+me)\b/i;
/** Repo-artifact mentions: @refs, file.ext names, or path-like a/b tokens.
 *  Any of these means the ask is ABOUT the codebase → planner/explore, not lite. */
const FILE_REF = /(@[\w./-]+)|([\w.-]+\.(?:tsx?|jsx?|py|go|rs|java|md|json|css|html|toml|ya?ml|sh|sql|vue|svelte))\b|((?:^|[\s"'`(])[\w.-]+(?:\/[\w.-]+)+)/i;

/** B14: pure question OR tiny ask → single routed answer, planner skipped.
 *  The old version only matched text that looked like a question (interrogative
 *  lead or "?"), so short imperative asks ("thanks", "summarize the last
 *  change") needlessly spun up the planner. Broadened: any ask of ≤12 words
 *  with no code-intent verb and no repo-artifact mention is trivial too. */
export function isTrivial(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).length;
  const hasFileRef = FILE_REF.test(t);
  // Branch 0 — polite task request: "can you make/create X" is an IMPERATIVE,
  // not a question. A polite lead-in carrying a code-intent verb is a real task,
  // so it must reach the planner (Branch 1 would otherwise treat "can …" as a
  // question and route it to the read-only lite path).
  if (POLITE_LEADIN.test(t) && CODE_INTENT.test(t)) return false;
  // Branch 1 — pure question: interrogative lead-in, no repo artifacts.
  if ((QUESTIONISH.test(t) || /\?\s*$/.test(t)) && !hasFileRef && words <= 60) return true;
  // Branch 2 — tiny ask: short, no code intent, no repo artifacts.
  return words <= 12 && !CODE_INTENT.test(t) && !hasFileRef;
}

/**
 * Social/chitchat detector — the cheapest possible path.
 *
 * "Hello" was costing ~2,557 tokens. answerLite spins up a full tool loop with
 * the read-only tool schemas declared, and a tool-trained model handed a tool
 * roster will USE it: the transcript showed the agent running a directory
 * listing in order to answer a greeting.
 *
 * A greeting needs no workspace, no tools, no AGENTS.md, and no environment
 * facts. Matching is deliberately narrow — a short message that is ONLY a
 * social phrase. Anything carrying a question mark, a file reference, or a
 * code verb falls through to the normal lite path, because "hi, can you fix
 * the parser?" is not chitchat.
 */
const CHITCHAT_RE =
  /^\s*(?:hi|hey|hello|yo|sup|howdy|greetings|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|thx|ty|ok|okay|cool|nice|great|awesome|got\s+it|never\s?mind|nvm|bye|goodbye|see\s+ya|cheers|ping)\b[\s!.,]*$/i;

export function isChitchat(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (t.includes("?")) return false;              // a question is not chitchat
  if (FILE_REF.test(t)) return false;             // names a repo artifact
  if (CODE_INTENT.test(t)) return false;          // asks for work — note this
                                                  // deliberately excludes a bare
                                                  // "test", which reads as "run
                                                  // the tests", not a greeting.
  return CHITCHAT_RE.test(t);
}

/**
 * One tiny completion, no tools, no workspace context. ~40 prompt tokens
 * against answerLite's ~2,500.
 */
async function answerChitchat(ctx: RunCtx, userMessage: ChatMessage): Promise<void> {
  const { session } = ctx;
  // Labelled with the role that actually runs it. It used to say "coder",
  // which put the wrong agent — and so the wrong model — in the activity view.
  const span = emit(session, "agent.start", "chat · greeting", { agentRole: "summarizer" });
  let text = "";
  try {
    const { res } = await routedLlm(
      ctx,
      "summarizer", // cheapest role: no tool schemas are declared for it
      [
        { role: "system", content: "You are a coding assistant. Reply to this greeting in ONE short sentence. Do not list files, do not describe the project, do not offer a menu of options." },
        { role: "user", content: userMessage.content },
      ],
      span,
      64,
    );
    text = res.text.trim();
  } catch {
    /* falls through to the canned reply below */
  }
  if (!text) text = "Hey — what would you like to work on?";
  emit(session, "agent.end", "chat · greeting", { spanId: span, agentRole: "coder", output: clip(text, 120) });
  const reply = asstMsg(text);
  session.messages.push(reply);
  wire.emit({ type: "message", sessionId: session.id, message: reply });
}

async function answerLite(ctx: RunCtx, userMessage: ChatMessage): Promise<void> {
  const { session } = ctx;
  const span = emit(session, "agent.start", "direct answer", { agentRole: "explorer" });
  const pinnedRefs = resolvePinnedRefs(ctx.root, session.contextRefs.filter((r) => r.source === "user"));
  // Environment facts: "what's my cwd"-class questions are answerable from
  // these without any tool call — the workspace root IS the user's cwd.
  const envFacts = [
    "ENVIRONMENT FACTS (authoritative — answer from these directly when asked):",
    `- The user's current working directory / project root is: ${ctx.root}`,
    `- Platform: ${process.platform} · Today: ${new Date().toISOString().slice(0, 10)}`,
    "- You HAVE read-only access to this workspace via tools (list_dir, read_file, grep, glob, git_status) — use ONE when the question needs file contents.",
  ].join("\n");
  const sys = buildSystemPrompt({
    agentsMdRules: loadProjectRules(ctx.root).rules,
    rolePrompt: "You are a precise coding assistant with READ-ONLY tools over the user's workspace. Answer the question directly; use a tool call only when the answer needs file contents or a directory listing.",
  });
  const seed: SysMsg[] = [
    { id: uid(), role: "user", content: pinnedRefs.length ? `${renderContextBlock(pinnedRefs)}\n\nQUESTION: ${userMessage.content}` : userMessage.content, at: Date.now(), __sys: `${sys}\n\n${envFacts}` },
  ];
  const readOnly = new Set(["read_file", "read_range", "list_dir", "grep", "glob", "git_status", "web_search"]);
  let finalText = "";
  try {
    const run = await toolLoop(ctx, "explorer", seed, span, 4, readOnly);
    finalText = run.finalText;
  } catch (err) {
    logger.warn("orchestrator", "lite tool-loop failed — direct answer fallback", { error: clip(String(err), 200) });
  }
  if (!finalText) {
    const msgs = [
      { role: "system", content: `${sys}\n\n${envFacts}` },
      { role: "user", content: userMessage.content },
    ];
    const { res } = await routedLlm(ctx, "coder", msgs, span, 1024);
    finalText = res.text;
  }
  emit(session, "agent.end", "coder-lite done", { spanId: span, agentRole: "coder", output: clip(finalText, 300) });
  const reply = asstMsg(finalText);
  session.messages.push(reply);
  // Critique #7: assistant answers must reach the UI live, not on reselect.
  wire.emit({ type: "message", sessionId: session.id, message: reply });
}

// ── Finalization ────────────────────────────────────────────────────────────
/** Authoritative failed-steps snapshot from PLAN STATE (not the incremental
 *  meta list — replans may have revived steps): id, title, one-line reason. */
function buildFailedSteps(task: NonNullable<Session["task"]>): { id: string; title: string; reason: string }[] {
  return (task.plan ?? [])
    .filter((s) => s.status === "failed")
    .map((s) => ({ id: s.id, title: s.title, reason: clip(s.resultSummary ?? "step failed", 200) }));
}

function finalize(session: Session, status: "done" | "failed" | "stopped", reason: string, aborted = false): { done: boolean; aborted?: boolean; reason?: string } {
  const task = session.task;
  if (task) {
    task.status = status;
    task.updatedAt = Date.now();
    // Critique #21: the pre-task snapshot map is the revert base for review —
    // it lives until the task actually ends, not until the first diff read.
    snapshots.delete(task.id);
    // Engine low item: these per-task/per-session maps used to grow without
    // bound — a long-lived process leaked every finished task's text/tool
    // history, error ledger, and nudge queue. Drop them when the task ends.
    textHist.delete(task.id);
    toolHist.delete(task.id);
    pendingNudges.delete(task.id);
    taskSessions.delete(task.id);
    lastErrors.delete(session.id);
    runStates.delete(session.id);
    // Forge conductor: clean up per-task state
    stepOutputs.delete(task.id);
    clearActionHashes(task.id);
    salvageClaims.delete(task.id);
    // Hygiene: the crash anchor has served its purpose once the task is
    // terminal — drop it so the persisted session stops carrying a stale
    // runState (up to ~300 KB of old transcript) and a later boot can't
    // mistake a finished task for an interrupted one.
    if (task.meta?.runState || task.meta?.bootInterrupted) {
      task.meta = { ...task.meta, runState: undefined, bootInterrupted: undefined };
    }
    const done = (task.plan ?? []).filter((s) => s.status === "done").length;
    const failed = (task.plan ?? []).filter((s) => s.status === "failed").length;
    const failedSteps = buildFailedSteps(task);
    const tokens = Object.values(task.tokensUsed).reduce((n, u) => n + u.inTok + u.outTok, 0);
    logger[status === "done" && failedSteps.length === 0 ? "info" : status === "stopped" ? "warn" : "error"]("orchestrator", "task end", {
      sessionId: session.id, taskId: task.id, status, reason,
      stepsDone: done, stepsFailed: failed, costUsd: Number(task.costUsd.toFixed(5)), tokens,
    });
    // r4-ux P1#1: a dead run must be LOUD in the transcript — the top-bar pill
    // alone reads as "nothing happened". Failed/stopped get an explicit error
    // card plus the recovery hint; r7-B/C: a DONE task with failed steps gets
    // one too, listing WHY each step died (honest counts, never a bare lie).
    const bad = status !== "done";
    const partial = !bad && failedSteps.length > 0;
    const head = status === "failed" ? "✗ Task failed" : status === "stopped" ? "■ Task stopped" : partial ? "⚠ Task done — with failed steps" : "Task done";
    const statsLines = [
      task.plan?.length
        ? `Steps: ${done}/${task.plan.length} done${failed > 0 ? ` · ${failed} failed` : ""}.`
        : "",
      ...failedSteps.map((f) => `✗ ${f.id} "${clip(f.title, 60)}" — ${f.reason}`),
      `Cost $${task.costUsd.toFixed(4)} · ~${tokens} tokens.`,
    ].filter(Boolean);
    const summary = bad || partial
      ? [`**${head}**`, `${reason}.`, ...statsLines, "", "Send a new prompt to retry, or use resume."].join("\n")
      : [`**${head}** — ${reason}.`, ...statsLines].join(" ");
    // Wave-2b payload enrichment: task.end output carries the SAME summary
    // string the transcript card shows, so web's task.end renderer
    // (output.summary wins) displays a real conclusion instead of re-deriving
    // one from the counts.
    emit(session, "task.end", `task ${status}: ${reason}`, {
      agentRole: "orchestrator", costUsd: task.costUsd,
      output: { summary, reason, stepsDone: done, stepsFailed: failed, tokens, costUsd: Number(task.costUsd.toFixed(5)) },
    });
    // RC3: persist the outcome on the TaskRecord itself — sibling-task digests
    // and the task list read THIS (not transcript messages), so a finished
    // task's result survives independent of the message log.
    task.resultSummary = clip(summary.replace(/\*\*/g, "").replace(/\n+/g, " "), 200);
    // One-shot answers (a greeting, a direct question) get no completion
    // message. The task machinery still records the outcome on the TaskRecord
    // and in the task.end trace — the dashboard and the top bar read those —
    // but appending "Task done — greeting. Cost $0.0000 · ~149 tokens" under a
    // one-line reply is task ceremony applied to a conversation.
    const oneShot = /^(greeting|answered directly)/i.test(reason);
    const last = session.messages[session.messages.length - 1];
    if (!oneShot && (last?.role !== "assistant" || last.content !== summary)) {
      const m: ChatMessage = {
        id: uid(), role: "assistant", content: summary, at: Date.now(),
        meta: {
          taskFinal: true,
          ...(bad || partial ? { errorCard: true } : {}),
          ...(failedSteps.length ? { failedSteps } : {}),
        },
      };
      session.messages.push(m);
      wire.emit({ type: "message", sessionId: session.id, message: m }); // critique #7
    }
    emitTask(session);
  }
  wire.emit({ type: "status", sessionId: session.id, status, note: reason });
  saveSession(session);
  return aborted ? { done: false, aborted: true, reason } : { done: status === "done", reason };
}

function resolveProjectRoot(session: Session): string {
  return projectRoots().get(session.projectId) ?? process.cwd();
}
function findSessionAny(sessionId: string): Session | undefined {
  for (const pid of projectRoots().keys()) {
    const s = getSession(pid, sessionId);
    if (s) return s;
  }
  return undefined;
}
