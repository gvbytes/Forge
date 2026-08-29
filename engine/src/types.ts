// ── Native Agent Engine shared contracts (server + web) ───────────────────
// Single source of truth for wire types.

export type Role = "system" | "user" | "assistant" | "tool";

/** Live circuit-breaker posture for one model (r8). Attached to ModelSpec by
 *  GET /api/models so Settings can show why a model is (not) being picked.
 *  `degraded` = sole enabled model of its provider: failing, logged, but never
 *  fully cooled down because there is nobody else to answer. */
export interface BreakerHealth {
  state: "closed" | "open" | "half-open" | "degraded";
  /** Epoch ms when the current cooldown ends (open/half-open only). */
  cooldownUntil?: number;
  /** Rolling-window failure rate 0..1 (over ≥ minSamplesForRate samples). */
  failRate?: number;
}

export interface ModelSpec {
  id: string; // provider model id, e.g. "laguna-s-2.1-free"
  label: string;
  provider: string; // e.g. "opencode-zen" | custom
  baseUrl: string;
  ctxWindow: number;
  maxOutput: number;
  costInPerM: number;
  costOutPerM: number;
  tags: string[]; // ["free","fast","vision","longctx",...]
  enabled: boolean;
  /** Present on /api/models responses; never persisted, computed live. */
  health?: BreakerHealth;
}

// ── Routing ────────────────────────────────────────────────────────────────
export type RouteSignal = {
  name: string;
  value: number | string;
  note?: string;
};

export interface RouteDecision {
  modelId: string;
  provider: string;
  reason: string; // human-readable why
  signals: RouteSignal[];
  complexity: number; // 0..1 estimated
  fallbacks: string[]; // ordered next choices on failure
  at: number;
}

// ── Trace / observability ─────────────────────────────────────────────────
export type TraceKind =
  | "task.start"
  | "task.end"
  | "plan"
  | "agent.start"
  | "agent.end"
  | "agent.thought"
  | "route"
  | "llm.call"
  | "llm.retry"
  | "tool.call"
  | "tool.result"
  | "approval.request"
  | "approval.decision"
  | "retrieval"
  | "compaction"
  | "review"
  | "diff.propose"
  | "error"
  | "context.snapshot";

export interface TraceEvent {
  id: number;
  sessionId: string;
  taskId?: string;
  parentId?: string; // span parent for hierarchy
  spanId: string;
  kind: TraceKind;
  agentRole?: string; // planner|coder|reviewer|explorer|router...
  label: string;
  input?: unknown;
  output?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  contextRefs?: ContextRef[]; // what context this node saw
  at: number;
}

// ── Manual context control ────────────────────────────────────────────────
export interface ContextRef {
  kind: "file" | "lines" | "snippet";
  path: string;
  startLine?: number;
  endLine?: number;
  content?: string; // for snippets pinned by user
  source: "user" | "agent" | "retrieval"; // who added it
}

// ── Sessions & messages ───────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
  refs?: ContextRef[];
  meta?: Record<string, unknown>;
  at: number;
}

export interface StuckEvent {
  at: number;
  stepId?: string;
  kind: "repeat-fail" | "repeat-text" | "step-attempts"; // why stuck was declared
  detail: string;
}

export interface TaskRecord {
  id: string;
  sessionId: string; // owning session — lets SSE consumers match task events to a session (req 11)
  title: string;
  status: "planning" | "running" | "waiting-approval" | "reviewing" | "done" | "failed" | "stopped";
  goal: string;
  plan?: PlanStep[];
  currentStep?: number;
  createdAt: number;
  updatedAt: number;
  tokensUsed: { [modelId: string]: { inTok: number; outTok: number; calls: number } };
  costUsd: number;
  budgetUsdCap?: number;
  /** Σ(in+out) token ceiling snapshotted at task start — cost caps are
   *  unenforceable on all-free catalogs ($0 forever), so tokens are the real
   *  spend signal there. */
  maxTokensPerTask?: number;
  stepCount: number;
  stuckEvents: StuckEvent[];
  /** One-line final outcome (RC3): persisted by finalize() so sibling-task
   *  digests and task lists can show what a finished task achieved. */
  resultSummary?: string;
  meta?: { [k: string]: unknown }; // orchestrator scratch: runState, proposalId, planRevision
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  resultSummary?: string;
  /** IDs of prerequisite steps that must complete before this step can run. */
  dependsOn?: string[];
  /** Which prior steps' OUTPUTS this step should be shown — declared by planner. */
  accessList?: string[];
  /** Forge conductor metadata: worker_id, strategy, access_list_numeric. */
  meta?: { [k: string]: unknown };
}

export interface Session {
  id: string;
  projectId: string; // resolved root dir key
  title: string;
  messages: ChatMessage[];
  contextRefs: ContextRef[]; // manual + auto context
  task?: TaskRecord;
  /** Finished/aborted tasks archived when a new prompt starts (B9): keeps the
   *  ledger honest without losing the old record to in-place reuse. */
  pastTasks?: TaskRecord[];
  compactions: { at: number; beforeTokens: number; summaryMessageId: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInfo {
  id: string; // short hash of abs path
  path: string;
  name: string;
  indexedAt?: number;
  fileCount?: number;
}

// ── Approvals ─────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  summary: string;
  payload: Record<string, unknown>; // e.g. command, path, diff preview
  createdAt: number;
  status: "pending" | "approved" | "denied";
  decidedBy?: "user" | "policy-auto-deny" | "policy-auto-approve" | "aborted";
}

/** decidedBy:"aborted" is synthetic: awaitDecision resolves with it when the
 *  caller's AbortSignal fires mid-wait so tools unwind with "aborted" instead
 *  of parking until the timeout. */

// ── Diff review ───────────────────────────────────────────────────────────
export interface DiffHunk {
  hunkIndex: number;
  header: string;
  lines: { type: "add" | "del" | "ctx"; text: string; oldLn?: number; newLn?: number }[];
  /** B5: per-hunk HITL decision, persisted with the proposal. Absent = not
   *  decided yet (rendered as "pending" by the DTO layer). */
  status?: "pending" | "accepted" | "rejected";
  /** Optional human reason recorded with a rejection (B5). */
  reason?: string;
}

export interface FileDiff {
  path: string;
  oldPath?: string; // for renames
  status: "added" | "modified" | "deleted";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Server-side apply hint (set by buildFileDiff/parseUnifiedPatch): the new
   * image has NO trailing newline. Unified diffs only encode this via
   * "\ No newline at end of file" markers, which line-array hunks lose. */
  noTrailingNewline?: boolean;
  /** Compact digest for dashboards/UI (path stats + hunk headers). */
  summary?: string;
}

export interface ChangeProposal {
  id: string;
  sessionId: string;
  taskId?: string;
  files: FileDiff[];
  rationale: string;
  createdAt: number;
  status: "pending" | "partially-applied" | "applied" | "rejected";
}

// ── SSE envelope ──────────────────────────────────────────────────────────
export type WireEvent =
  | { type: "trace"; event: TraceEvent }
  | { type: "session"; session: Session }
  | { type: "message"; sessionId: string; message: ChatMessage }
  | { type: "token"; sessionId: string; messageId: string; delta: string; taskId?: string; spanId?: string; kind?: "text" | "thought" }
  | { type: "approval"; approval: ApprovalRequest }
  | { type: "proposal"; proposal: ChangeProposal }
  | { type: "task"; task: TaskRecord; sessionId?: string } // sessionId mirrors task.sessionId for cheap SSE matching
  | { type: "route"; sessionId: string; decision: RouteDecision }
  /** Live code streaming: decoded write_file/edit_file content, arriving as the
   *  model produces it so the editor can type it out (Cursor/Antigravity feel)
   *  instead of waiting for the completed tool call. See livecode.ts. */
  | { type: "file_stream"; sessionId: string; taskId?: string; path: string; delta: string; done: boolean }
  | { type: "status"; sessionId: string; status: string; note?: string };

// ── Settings ──────────────────────────────────────────────────────────────
export interface ProviderSettings {
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: "openai-compatible";
}

export interface AppSettings {
  providers: ProviderSettings[];
  selectedModels: { router?: string; planner?: string; coder?: string; reviewer?: string; explorer?: string; summarizer?: string };
  budgetPerTaskUsd?: number;
  /** Secondary hard ceiling per task in total tokens (in+out). Trips the same
   *  abort path as budgetPerTaskUsd; default 400_000 (see config.ts). */
  maxTokensPerTask?: number;
  autoCompact: boolean;
  compactThreshold: number; // fraction of ctx window, e.g. 0.7
  /** Approval posture (B7): "gate" (DEFAULT — PS 8b) = every side-effecting
   *  tool waits for a human. "optimistic" (opt-in) = file mutations
   *  (write_file/edit_file) apply immediately and are checkpointed for revert,
   *  while shell/git tools still gate; "gate" = side-effect tools AND
   *  requireApprovalFor names park on the human gate; "auto" = nothing gates.
   *  Absent/empty field is treated as "gate" (the merged default). */
  approvals?: { mode: "gate" | "auto" | "optimistic" };
  requireApprovalFor: string[]; // extra tool names to gate (ignored for write/edit in optimistic)
  /** Model ids switched OFF in Settings (critique #10): excluded from routing
   *  even when the registry reports them enabled. Absent = none disabled. */
  disabledModels?: string[];
  /** ≤80B gate for custom providers (critique #11): when set and non-empty,
   *  ONLY these ids are admitted from custom endpoints; unset/empty admits
   *  everything tagged ["custom","unverified"] with a console.warn. */
  customModelAllowlist?: string[];
}
