// chat.ts — conversational mode (r6 feedback: "we should be able to chat with
// it — how are we going to plan with the agent … if it is not chatting").
//
// A /chat turn NEVER touches the task machinery: no planner, no tool loop, no
// task record. It is ONE routed+ raced completion over a small context bundle:
// system (AGENTS.md rules + CHAT_PROMPT) + retrieval top-4 + rendered pinned
// refs + last 8 session messages (so follow-ups work). Both sides of the turn
// are appended to the session and pushed over SSE like any other message.
import crypto from "node:crypto";
import { ChatMessage, ContextRef, RouteDecision, Session, TraceKind } from "./types.js";
import { buildSystemPrompt, estTokens, renderContextBlock, resolvePinnedRefs } from "./context.js";
import { loadProjectRules } from "./rules.js";
import { ensureFresh, retrieve } from "./retrieval.js";
import type { RetrievalHit } from "./retrieval.js";
import { chatRace, LlmError } from "./providers.js";
import { recordOutcome, decideRoute } from "./router.js";
import { trace } from "./trace.js";
import { wire, createDeltaThrottle } from "./bus.js";
import { saveSession } from "./sessions.js";
import { CHAT_PROMPT } from "./prompts.js";

/**
 * Test seam for the two calls that would otherwise hit the router/network.
 *
 * Why a seam and not `mock.module`: Bun preloads every test file's module
 * graph before running any test, so `mock.module("../src/providers.js", …)`
 * patches the registry PROCESS-WIDE and cannot be undone once another file has
 * captured the binding. chat.test.ts did exactly that, and its stubbed
 * chatRace leaked into stream.test.ts — which legitimately tests the REAL
 * chatRace and started seeing modelId "engine/small". Injecting the two
 * dependencies keeps chat.test.ts hermetic without touching global state.
 *
 * Production code never sets these; the defaults are the real implementations.
 */
export interface ChatDeps {
  chatRace: typeof chatRace;
  decideRoute: typeof decideRoute;
  recordOutcome: typeof recordOutcome;
}
const REAL_DEPS: ChatDeps = { chatRace, decideRoute, recordOutcome };
let deps: ChatDeps = REAL_DEPS;

/** Test hook: swap the LLM/router dependencies. Call with no argument to reset. */
export function _setChatDeps(next?: Partial<ChatDeps>): void {
  deps = next ? { ...REAL_DEPS, ...next } : REAL_DEPS;
}

const CHAT_RETRIEVAL_HITS = 4;
const CHAT_HISTORY_MESSAGES = 8;   // follow-up window replayed into the prompt
const CHAT_MAX_TOKENS = 1024;
/** Coerce arbitrary input to text. runChat is an exported API and callers may
 *  pass null/undefined/non-strings (the HTTP layer validates one level up, but
 *  the module must not crash or leak "[object Object]" on its own). */
const toText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); } // circular refs → fallback
  }
  return String(v);
};
const clip = (s: unknown, n: number): string => {
  const t = toText(s); // history content comes from persisted sessions → may be non-string
  return t.length <= n ? t : t.slice(0, n) + "…";
};

/** Trace-only emitter (same contract as the orchestrator's emit, minus the
 *  step-context lens chat turns don't have). SSE delivery happens exactly
 *  once via the trace→wire bridge in events.ts (B1/B2) — the manual
 *  wire.emit mirrors (trace + route) that used to live here are GONE; the
 *  type:"route" frame is derived in events.ts from the route trace. */
function emit(session: Session, kind: TraceKind, label: string, o: Partial<{
  parentId?: string; agentRole?: string; input?: unknown; output?: unknown;
  tokensIn?: number; tokensOut?: number; durationMs?: number; model?: string;
}> = {}): void {
  trace.emit({
    sessionId: session.id, taskId: session.task?.id, spanId: crypto.randomUUID().slice(0, 8),
    kind, label, agentRole: o.agentRole, input: o.input, output: o.output,
    tokensIn: o.tokensIn, tokensOut: o.tokensOut, durationMs: o.durationMs, model: o.model,
  });
}

async function chatRetrieval(session: Session, root: string, query: string): Promise<RetrievalHit[]> {
  try {
    await ensureFresh(root, session.projectId);
    return await retrieve({ projectId: session.projectId, query, k: CHAT_RETRIEVAL_HITS, sessionId: session.id });
  } catch {
    return []; // unindexed project → answer from pinned refs/history alone
  }
}

/**
 * One conversational turn. Appends the user message FIRST (so an LLM failure
 * still leaves the transcript truthful), then answers via decideRoute("router")
 * + chatRace over primary + 2 fallbacks. Throws on total model failure — the
 * endpoint maps that to a 502 the composer shows inline.
 */
export async function runChat(
  session: Session,
  root: string,
  text: string,
  refs?: ContextRef[],
): Promise<{ reply: ChatMessage; modelId: string }> {
  text = toText(text); // normalize once: every use below is now string-safe
  // ── 1. User side of the turn ──────────────────────────────────────────────
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(), role: "user", content: text, refs: refs ?? [],
    meta: { chat: true }, at: Date.now(),
  };
  session.messages.push(userMsg);
  if (refs?.length) {
    for (const r of refs) {
      if (!session.contextRefs.find((x) => x.path === r.path && x.startLine === r.startLine)) {
        session.contextRefs.push({ ...r, source: "user" });
      }
    }
  }
  if (session.title === "New session" && text.trim()) session.title = text.slice(0, 60);
  saveSession(session);
  wire.emit({ type: "message", sessionId: session.id, message: userMsg });

  // ── 2. Context bundle ─────────────────────────────────────────────────────
  const rules = loadProjectRules(root).rules;
  const envFacts = [
    "ENVIRONMENT FACTS (authoritative):",
    `- The user's current working directory / project root is: ${root}`,
    `- Platform: ${process.platform} · Today: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
  const sys = buildSystemPrompt({ agentsMdRules: rules, rolePrompt: `${CHAT_PROMPT}\n\n${envFacts}` });
  const hits = await chatRetrieval(session, root, text);
  const hitBlock = hits.length
    ? hits.map((h) => `- ${h.path}:${h.startLine}${h.endLine > h.startLine ? `-${h.endLine}` : ""}${h.symbol ? ` (${h.symbol})` : ""}\n  ${clip(h.preview ?? "", 180)}`).join("\n")
    : "(no index hits — rely on pinned context and the conversation)";
  const pinnedRefs = resolvePinnedRefs(root, session.contextRefs.filter((r) => r.source === "user"));
  // Follow-up memory: last 8 messages BEFORE this turn's question.
  const history = session.messages.slice(0, -1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-CHAT_HISTORY_MESSAGES);
  const body = [
    `PROJECT CONTEXT (retrieval hits):\n${hitBlock}`,
    pinnedRefs.length ? `PINNED CONTEXT:\n${renderContextBlock(pinnedRefs)}` : "",
    history.length ? `RECENT CONVERSATION:\n${history.map((m) => `${m.role}: ${clip(m.content, 400)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: body ? `${body}\n\nMESSAGE:\n${text}` : text },
  ];

  // ── 3. Routing transparency (same as task calls) ─────────────────────────
  const contextTokens = estTokens(sys) + estTokens(body) + estTokens(text) + 64;
  let decision: RouteDecision;
  try {
    decision = await deps.decideRoute({
      sessionId: session.id, role: "router", userPrompt: text,
      contextTokens, tokensUsedSoFar: 0, costUsedSoFarUsd: session.task?.costUsd ?? 0,
      budgetCapUsd: session.task?.budgetUsdCap,
    });
  } catch {
    decision = { modelId: "(no-model)", provider: "(none)", reason: "router failed", signals: [], complexity: 0, fallbacks: [], at: Date.now() };
  }
  emit(session, "route", `route chat → ${decision.modelId}`, { agentRole: "router", input: decision });

  // ── 4. Race primary + 2 fallbacks ─────────────────────────────────────────
  const candidates = [decision.modelId, ...decision.fallbacks.slice(0, 2)].filter((id) => id && !id.startsWith("("));
  const erroredLosers: { modelId: string; status?: number; msg: string }[] = [];
  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof chatRace>>;
  // Wave 25 (forge-parity fluid chat): the reply id is minted BEFORE the race
  // so token deltas can stream under it live; the final `message` frame reuses
  // the same id, which tells the web store to retire its stream accumulator.
  const replyId = crypto.randomUUID();
  // Wave 25: coalesce per-token deltas into ≤25 fps wire frames (see bus.ts).
  const deltaThrottle = createDeltaThrottle((d) => {
    const delta = d.text ?? d.reasoning;
    if (!delta) return;
    wire.emit({
      type: "token", sessionId: session.id, messageId: replyId, delta,
      kind: d.reasoning ? "thought" : "text",
    });
  });
  try {
    res = await deps.chatRace({
      modelId: candidates[0] ?? "",
      candidates,
      messages,
      maxTokens: CHAT_MAX_TOKENS,
      // B26 parity with the task path (orchestrator passes role-specific
      // caps): chat turns get the same 90 s per-slot ceiling instead of
      // relying on chatRace's default. No signal parity: a /chat turn has no
      // abort controller of its own (the HTTP layer does not propagate one).
      maxSlotMs: 90_000,
      // A /chat turn has no tool loop, so an answer that lives entirely in the
      // model's reasoning field is still a usable answer here — unlike in the
      // orchestrator, where it would masquerade as a missing tool call.
      allowReasoningAsText: true,
      onDelta: deltaThrottle.push,
      onLoser: ({ modelId, outcome, latencyMs, error }) => {
        if (outcome !== "error") return;
        const msg = error instanceof Error ? error.message : String(error);
        const status = error instanceof LlmError ? error.status : undefined;
        // B26: record the REAL status — recordOutcome's 4xx exemption keeps
        // client errors (400/401/403) from poisoning 5xx health/tripping the
        // breaker. Remapping 400→503 here used to bypass that protection.
        deps.recordOutcome(modelId, false, latencyMs, status);
        erroredLosers.push({ modelId, status, msg });
      },
    });
  } catch (err) {
    for (const l of erroredLosers) {
      emit(session, "llm.retry", `${l.modelId} failed (${l.status ?? "network"}) → chat race lost`, {
        agentRole: "chat", model: l.modelId, input: { error: clip(l.msg, 300) },
      });
    }
    throw err;
  }
  // Wave 25: flush the last coalesced chunk BEFORE the llm.call trace (which
  // carries input.streamed and tells the web store to seal the accumulator).
  deltaThrottle.flush();
  deps.recordOutcome(res.modelId, true, res.latencyMs);
  emit(session, "llm.call", `chat ← ${res.modelId}`, {
    agentRole: "chat", model: res.modelId,
    tokensIn: res.tokensIn, tokensOut: res.tokensOut, durationMs: Date.now() - t0,
    input: {
      messages: messages.length, maxTokens: CHAT_MAX_TOKENS, raced: candidates,
      // Wave 25: the web store skips re-rendering this call's text as a fresh
      // bubble when it already streamed live under replyId.
      streamed: replyId,
      ...(res.reasoningContent ? { reasoning: clip(res.reasoningContent, 2000) } : {}),
    },
    output: clip(res.text, 600),
  });
  for (const l of erroredLosers) {
    emit(session, "llm.retry", `${l.modelId} failed (${l.status ?? "network"}) → lost chat race to ${res.modelId}`, {
      agentRole: "chat", model: l.modelId, input: { error: clip(l.msg, 300), winner: res.modelId },
    });
  }

  // ── 5. Assistant side of the turn ─────────────────────────────────────────
  // Wave 25: reuse replyId (the stream key) so the web store retires its live
  // accumulator when this message lands. reasoningContent rides in meta so the
  // Thinking box stays populated after reload (live-only deltas don't persist).
  const reply: ChatMessage = {
    id: replyId, role: "assistant", content: res.text.trim() || "(empty reply)",
    meta: {
      chat: true, model: res.modelId,
      ...(res.reasoningContent ? { reasoning: clip(res.reasoningContent, 4000) } : {}),
    },
    at: Date.now(),
  };
  session.messages.push(reply);
  saveSession(session);
  wire.emit({ type: "message", sessionId: session.id, message: reply });
  return { reply, modelId: res.modelId };
}
