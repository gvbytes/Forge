// Chat state: per-task event buffer (backfill + SSE), connection status,
// local-only items (optimistic user messages, /bytheway bubbles), the last
// routing decision per task, and the derived render timeline.
//
// PINNED WIRE CONTRACT: every SSE frame AND every row of
// GET /api/tasks/:id/events?after=<cursor> shares ONE canonical DTO:
//   { id:<cursor>, cursor, eventId?, taskId, sessionId?, ts, createdAt?, type, payload }
// `id` === `cursor` is the per-session monotonic integer — the ONLY order/
// replay/dedupe key. `eventId` (stable UUID) is a secondary dedupe key when
// provided. `ts`/`createdAt` are the same epoch-ms value; ingestion
// normalizes to `ts`. Top-level types: message | trace | task | status |
// route | approval | proposal. For type==="trace", payload.event.kind carries
// the span vocabulary (task.start, task.end, agent.start, agent.end,
// agent.thought, route, llm.call, llm.retry, tool.call, tool.result,
// approval.request, approval.decision, compaction, review, diff.propose,
// error). Payload shapes are owned by the engine (engine/src/events.ts);
// every accessor below is defensive so a shape change degrades gracefully.
//
// Buffers are kept sorted by cursor; append/backfill are ONE idempotent
// upsert (dedupe by eventId when present, else by cursor). The last canonical
// cursor is tracked in `cursors` SEPARATELY from the rendered events — the
// replay cursor is never derived from the largest rendered id.
//
// deriveTimeline is PURE (B34): no store writes during the render phase.
// Status patching happens in the SSE onmessage handler (useTaskStream).
import { useMemo } from "react";
import { create } from "zustand";
import type { EventDto } from "../lib/types";
import { useUi } from "./ui";

export interface RouteInfo {
  modelKey: string;
  providerId: string;
  tier: string;
  reasons: string[];
}

export interface GoalItem { kind: "goal"; id: string; ts: number; text: string; title?: string }
export interface PlanItem { kind: "plan"; id: string; ts: number; steps: { text: string; done: boolean; dependsOn?: string[] }[] }
export interface ThoughtItem {
  kind: "thought"; id: string; ts: number; text: string; route?: RouteInfo;
  /** Wave 25 (forge parity): reasoning-model chain-of-thought, rendered in a
   *  collapsible "Thinking" box. Live `token` frames with kind:"thought". */
  thinking?: string;
  /** true while the stream is still open — renders a blinking cursor. */
  streaming?: boolean;
}
/** "running" = tool.call without its tool.result yet (spinner);
 *  "result"  = merged row, ok===false renders error styling. */
export type ToolPhase = "running" | "result";
export interface ToolItem {
  kind: "tool"; id: string; ts: number; tool: string; phase: ToolPhase;
  input?: unknown; output?: unknown; ok?: boolean;
}
export interface NoticeItem { kind: "notice"; id: string; ts: number; level: "info" | "warn" | "error"; icon: string; text: string }
export interface HitlItem { kind: "hitl"; id: string; ts: number; proposalId: string; path: string; hunks?: number }
export interface BythewayItem {
  kind: "bytheway"; id: string; ts: number; question: string;
  answer?: string; modelKey?: string; pending: boolean;
}
export interface VisionItem {
  kind: "vision"; id: string; ts: number; prompt: string;
  images: { name: string; dataUrl: string }[];
  answer?: string; modelKey?: string; pending: boolean; error?: string;
}
export interface SummaryItem { kind: "summary"; id: string; ts: number; text: string }
export interface UserItem {
  kind: "user"; id: string; ts: number; text: string; status: "sent" | "failed";
  /** server message id when known — used to suppress the SSE echo (B32). */
  msgId?: string;
}

export type TimelineItem =
  | GoalItem | PlanItem | ThoughtItem | ToolItem | NoticeItem
  | HitlItem | BythewayItem | VisionItem | SummaryItem | UserItem;

export type ConnState = "idle" | "connecting" | "live" | "offline";

interface ChatState {
  events: Record<string, EventDto[]>;
  rev: Record<string, number>;
  conn: Record<string, ConnState>;
  local: Record<string, TimelineItem[]>;
  /** last wire `route` decision per task buffer (RoutingBadge source). */
  routes: Record<string, RouteInfo>;

  backfill(taskId: string, evs: EventDto[]): void;
  append(taskId: string, ev: EventDto): void;
  setConn(taskId: string, s: ConnState): void;
  addLocal(key: string, item: TimelineItem): void;
  patchLocal(key: string, id: string, fn: (item: TimelineItem) => TimelineItem): void;
  /** RC1: move optimistic items under a rollover'd task id. */
  migrateLocal(fromKey: string, toKey: string): void;
  /** RC1: move the event buffer + route under a rollover'd task id. */
  migrateEvents(fromKey: string, toKey: string): void;
  /** Folder isolation: drop every task buffer (project switch). */
  resetAll(): void;
  resetTask(taskId: string): void;
}

// key for local items when no task exists yet
export const LOCAL_NO_TASK = "__no_task";

/** Memoized timeline selector shared by ChatPane / TerminalPanel. */
export function useTimeline(taskId: string | null): TimelineItem[] {
  const evs = useChat((s) => (taskId ? s.events[taskId] : undefined));
  const local = useChat((s) => s.local[taskId ?? LOCAL_NO_TASK]);
  const route = useChat((s) => (taskId ? s.routes[taskId] : undefined));
  const rev = useChat((s) => (taskId ? s.rev[taskId] ?? 0 : 0));
  // rev is a cheap dep that changes on every append/backfill; eslint isn't
  // watching here — array identity alone also works because backfill replaces.
  void rev;
  return useMemo(() => deriveTimeline(evs ?? [], local ?? [], route), [evs, local, route]);
}

export const useChat = create<ChatState>()((set) => ({
  events: {},
  rev: {},
  conn: {},
  local: {},
  routes: {},

  // B3/B4: single monotonic id space → dedupe by id + plain ascending sort is
  // the true chronological order for the merged live+backfill buffer.
  backfill: (taskId, evs) =>
    set((s) => {
      const have = new Set((s.events[taskId] ?? []).map((e) => e.id));
      const merged = [...(s.events[taskId] ?? []), ...evs.filter((e) => !have.has(e.id))].sort((a, b) => a.id - b.id);
      let routes = s.routes;
      for (const e of evs) {
        if (e.type === "route") routes = { ...routes, [taskId]: normalizeRoute(rec(e.payload)) };
      }
      return {
        events: { ...s.events, [taskId]: merged },
        rev: { ...s.rev, [taskId]: (s.rev[taskId] ?? 0) + 1 },
        routes,
      };
    }),

  append: (taskId, ev) =>
    set((s) => {
      const arr = s.events[taskId] ?? [];
      if (arr.length > 0 && arr[arr.length - 1].id >= ev.id) return s; // replayed/duplicate
      const routes = ev.type === "route"
        ? { ...s.routes, [taskId]: normalizeRoute(rec(ev.payload)) }
        : s.routes;
      return {
        events: { ...s.events, [taskId]: [...arr, ev] },
        rev: { ...s.rev, [taskId]: (s.rev[taskId] ?? 0) + 1 },
        routes,
      };
    }),

  setConn: (taskId, st) => set((s) => ({ conn: { ...s.conn, [taskId]: st } })),

  addLocal: (key, item) => set((s) => ({ local: { ...s.local, [key]: [...(s.local[key] ?? []), item] } })),

  patchLocal: (key, id, fn) =>
    set((s) => ({
      local: { ...s.local, [key]: (s.local[key] ?? []).map((it) => (it.id === id ? fn(it) : it)) },
    })),

  // clears the event buffer AND the per-task route cache (task switch)
  resetTask: (taskId) =>
    set((s) => {
      const events = { ...s.events };
      delete events[taskId];
      const routes = { ...s.routes };
      delete routes[taskId];
      // RC1: local optimistic items too — a task switch that keeps the old
      // key used to leak stale bubbles into the NEXT selection of that task.
      const local = { ...s.local };
      delete local[taskId];
      return { events, routes, local, rev: { ...s.rev, [taskId]: 0 } };
    }),

  /** RC1 — rollover migration: rename a task's chat buffers from a dead id
   *  to the live one (the same conversation got a fresh task UUID). Moves
   *  optimistic local items AND the journalled event buffer + route so the
   *  timeline survives the id switch without a refetch. */
  migrateLocal: (fromKey, toKey) =>
    set((s) => {
      if (fromKey === toKey) return s;
      const local = { ...s.local };
      const from = local[fromKey] ?? [];
      if (from.length) {
        local[toKey] = [...(local[toKey] ?? []), ...from];
        delete local[fromKey];
      }
      return { local };
    }),

  migrateEvents: (fromKey, toKey) =>
    set((s) => {
      if (fromKey === toKey) return s;
      const events = { ...s.events };
      const routes = { ...s.routes };
      const rev = { ...s.rev };
      if (events[fromKey] && !events[toKey]) {
        events[toKey] = events[fromKey];
        delete events[fromKey];
        rev[toKey] = rev[fromKey] ?? 0;
        delete rev[fromKey];
      }
      if (routes[fromKey] && !routes[toKey]) {
        routes[toKey] = routes[fromKey];
        delete routes[fromKey];
      }
      return { events, routes, rev };
    }),

  /** Folder isolation: drop EVERY task buffer (events, routes, conn, local
   *  items) — called when the user opens a different project so the old
   *  folder's chat can never bleed into the new one. */
  resetAll: () =>
    set({
      events: {}, rev: {}, conn: {}, local: {}, routes: {},
    }),
}));

let localSeq = 0;
export function nextLocalId(): string {
  return `local-${++localSeq}`;
}

// ---------- defensive payload helpers ----------
function rec(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** "1532" → "1.5k", keeps small counts plain (usage suffix in thought bubbles). */
function fmtTokUsage(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** Map the engine's RouteDecision (payload.decision) into badge data. */
function normalizeRoute(p: Record<string, any>): RouteInfo {
  const d = rec(p.decision ?? p);
  const complexity = num(d.complexity);
  const tier = complexity === undefined ? "?" : complexity < 0.34 ? "S" : complexity < 0.67 ? "M" : "L";
  const reasons: string[] = [];
  const why = asStr(d.reason);
  if (why) reasons.push(why);
  if (Array.isArray(d.signals)) {
    for (const s of d.signals) {
      const r = rec(s);
      const name = asStr(r.name);
      if (!name) continue;
      const note = asStr(r.note);
      reasons.push(`${name}=${String(r.value)}${note ? ` (${note})` : ""}`);
    }
  }
  return {
    modelKey: asStr(d.modelId) ?? asStr(d.model) ?? "?",
    providerId: asStr(d.provider) ?? asStr(d.provider_id) ?? "?",
    tier,
    reasons,
  };
}

/** task.end trace → summary card text (output.summary wins when present). */
function summarizeTaskEnd(label: string, o: Record<string, any>): string {
  const bits: string[] = [];
  if (typeof o.stepsDone === "number") {
    bits.push(`${o.stepsDone} step(s) done${typeof o.stepsFailed === "number" && o.stepsFailed > 0 ? `, ${o.stepsFailed} failed` : ""}`);
  }
  if (typeof o.tokens === "number") bits.push(`~${fmtTokUsage(o.tokens)} tok`);
  if (typeof o.costUsd === "number") bits.push(`$${o.costUsd.toFixed(4)}`);
  const reason = asStr(o.reason);
  return [label || "Task finished", reason ? `— ${reason}` : "", bits.length ? `(${bits.join(" · ")})` : ""]
    .filter(Boolean)
    .join(" ");
}

/** `tool: write_file` → `write_file`. */
/**
 * Collapse an item that repeats the one before it.
 *
 * The engine deliberately reports a result through more than one channel: an
 * `llm.call` trace carries the model's text, the final `message` frame carries
 * the same text again (so it survives a reload), and `finalize` emits the task
 * summary BOTH as a `task.end` trace and as an assistant message. Each of those
 * is correct on its own; together they rendered the same sentence two or three
 * times in a row, which is most of what makes the transcript feel cluttered.
 *
 * Rather than removing a channel — every one of them is load-bearing for some
 * other consumer — the timeline drops an entry whose visible text matches the
 * previous entry's. Comparison is on normalized text: the `FINAL:` protocol
 * prefix and the trailing token-count line are presentation, not content, so
 * "FINAL: Done." and "Done." are the same message.
 */
function normalizeForDedupe(text: string): string {
  return text
    .replace(/^\s*(?:\*\*)?FINAL:(?:\*\*)?\s*/i, "")
    .replace(/\n+—\s[\d.]+[kKmM]?\s*tok\s*$/i, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractThinkingAndAnswer(rawText: string): { text: string; thinking?: string } {
  if (!rawText) return { text: "" };
  let text = rawText;
  const thoughts: string[] = [];

  // 1. Closed tags
  const tagRe = /<(?:think|thought|thinking)>([\s\S]*?)<\/(?:think|thought|thinking)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[1] && m[1].trim()) thoughts.push(m[1].trim());
  }
  text = text.replace(tagRe, "").trim();

  // 2. Unclosed tags at start of text
  const unclosedMatch = text.match(/^<(?:think|thought|thinking)>([\s\S]*)$/i);
  if (unclosedMatch) {
    const unclosedContent = unclosedMatch[1]!.trim();
    const finalSplit = unclosedContent.split(/(?=(?:FINAL:|Response:|Answer:))/i);
    if (finalSplit.length > 1) {
      thoughts.push(finalSplit[0]!.trim());
      text = finalSplit.slice(1).join("").trim();
    } else {
      thoughts.push(unclosedContent);
      text = "";
    }
  }

  // 3. Chain of thought preamble before FINAL: or Response:
  if (!thoughts.length && /^(?:The user (?:wants|says|asked)|Protocol reminder|Let's check|I need to|Wait, looking)/i.test(text)) {
    const marker = text.search(/(?:FINAL:|Response:|Answer:)/i);
    if (marker > 0) {
      thoughts.push(text.slice(0, marker).trim());
      text = text.slice(marker).trim();
    }
  }

  return {
    text,
    thinking: thoughts.length > 0 ? thoughts.join("\n\n---\n\n") : undefined,
  };
}

/**
 * Kinds that carry the ASSISTANT'S ANSWER. Only these participate in dedupe.
 *
 * Structural entries (notices, tool rows, plans) are skipped over rather than
 * compared: an "✔ chat · greeting" marker sat between the two copies of
 * "Hi there!" and, because it carries text of its own, reset the comparison
 * and let the duplicate through. Answers must be compared to the previous
 * ANSWER, not to whatever happened to render in between.
 */
const DEDUPE_KINDS = new Set(["thought", "summary", "goal", "bytheway", "user"]);

function dedupeAdjacent(items: TimelineItem[]): TimelineItem[] {
  const kept: TimelineItem[] = [];
  let lastText = "";
  for (const it of items) {
    if (!DEDUPE_KINDS.has(it.kind)) { kept.push(it); continue; }
    const raw = (it as { text?: unknown }).text;
    const text = typeof raw === "string" ? normalizeForDedupe(raw) : "";
    // ADJACENCY is the signal, not length: two consecutive answers carrying the
    // same sentence are one answer arriving down two channels, even when it is
    // as short as "Hi there!".
    if (text && text === lastText) continue;
    if (text) lastText = text;
    kept.push(it);
  }
  return kept;
}

function toolNameOf(label: string | undefined, fallback?: string): string {
  if (label && label.startsWith("tool: ")) return label.slice(6);
  return label || fallback || "tool";
}

/**
 * Fold the raw event log (+ local-only items) into renderable timeline items.
 * Pure function — no store side effects (B34).
 *
 * Merges tool.call → tool.result rows by spanId (spinner while unmatched,
 * error styling when the result carries an error), attaches the most recent
 * `route` decision to llm.call thought bubbles, and suppresses server echoes
 * of optimistic local user messages (B32).
 */
export function deriveTimeline(events: EventDto[], local: TimelineItem[], fallbackRoute?: RouteInfo): TimelineItem[] {
  const out: TimelineItem[] = [];
  let lastRoute: RouteInfo | undefined = fallbackRoute;
  const openTools = new Map<string, number>(); // spanId → index into out

  // Wave 25 (fluid chat + reasoning): live `token` frames accumulate here,
  // keyed by stream id (chat: replyId === messageId; task: step spanId).
  // A stream is "sealed" — rendered as a full thought bubble — by whichever
  // lands first: the llm.call trace carrying input.streamed (task + chat), or
  // the final `message` frame reusing the stream id as its message id (chat).
  // Token frames are LIVE_ONLY server-side, so after a reload nothing replays
  // and llm.call degrades to its clipped output — graceful by design.
  interface StreamAcc { text: string; thought: string; ts: number; lastTs: number }
  const streams = new Map<string, StreamAcc>();
  const streamFor = (key: string, ts: number): StreamAcc => {
    let acc = streams.get(key);
    if (!acc) { acc = { text: "", thought: "", ts, lastTs: ts }; streams.set(key, acc); }
    return acc;
  };
  // Terminal frames (task/agent end, error) mark the point after which any
  // still-open stream is a dead (failed) call, not a live one — the flush loop
  // compares each stream's last token against this to stop the blinking cursor.
  let lastTerminalTs = 0;
  const markTerminal = (ts: number) => { if (ts > lastTerminalTs) lastTerminalTs = ts; };

  // B32: multiset of optimistic local user texts (+ ids when known) — server
  // echoes of messages the client already rendered are suppressed.
  const localUserTexts = new Map<string, number>();
  const localUserIds = new Set<string>();
  for (const it of local) {
    if (it.kind === "user") {
      localUserTexts.set(it.text, (localUserTexts.get(it.text) ?? 0) + 1);
      if (it.msgId) localUserIds.add(it.msgId);
    }
  }

  for (const ev of events) {
    const p = rec(ev.payload);
    const id = `e${ev.id}`;
    switch (ev.type) {
      case "message": {
        const msg = rec(p.message ?? p);
        const role = asStr(msg.role);
        const content = asStr(msg.content) ?? "";
        const msgId = asStr(msg.id);
        if (role === "user") {
          if (msgId && localUserIds.has(msgId)) break; // echo suppressed by id
          const n = localUserTexts.get(content) ?? 0;
          if (n > 0) { localUserTexts.set(content, n - 1); break; } // echo suppressed by text
          out.push({ kind: "user", id, ts: ev.ts, text: content, status: "sent", msgId });
        } else if (role === "system") {
          if (content) out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "·", text: content });
        } else if (content) {
          // Wave 25: the final assistant message seals its live stream
          if (msgId) streams.delete(msgId);
          const extracted = extractThinkingAndAnswer(content);
          const thinking = asStr(rec(msg.meta).reasoning) || extracted.thinking;
          const cleanText = extracted.text || (thinking ? "" : content);
          if (cleanText || thinking) {
            out.push({
              kind: "thought", id, ts: ev.ts, text: cleanText, route: lastRoute,
              ...(thinking ? { thinking } : {}),
            });
          }
        }
        break;
      }

      case "trace": {
        const tr = rec(p.event ?? p);
        const tkind = asStr(tr.kind) ?? "";
        const label = asStr(tr.label) ?? "";
        switch (tkind) {
          case "task.start": {
            // B35: backfilled input is the object {goal, resumeFromStep}
            const input = tr.input;
            const goal = input && typeof input === "object" ? asStr(rec(input).goal) : undefined;
            const text = goal ?? asStr(input) ?? label;
            if (text && !out.some((it) => it.kind === "goal")) {
              out.push({ kind: "goal", id, ts: ev.ts, text });
            }
            break;
          }

          case "task.end": {
            markTerminal(ev.ts);
            const o = rec(tr.output);
            const text = asStr(o.summary) ?? (typeof tr.output === "string" ? tr.output : undefined) ?? summarizeTaskEnd(label, o);
            // One-shot answers get no completion card. A greeting or a direct
            // question was answered in a single call — reporting "Task done —
            // greeting. Cost $0.0000 · ~149 tokens" underneath "Hi there!" is
            // the ceremony a 40-step task deserves, applied to a one-liner.
            // The cost/steps are still on the top bar and in the dashboard.
            const reason = asStr(o.reason) ?? "";
            const oneShot = /^(greeting|answered directly)/i.test(reason);
            if (!oneShot) out.push({ kind: "summary", id, ts: ev.ts, text });
            break;
          }

          case "plan": {
            const o = rec(tr.output);
            const i = rec(tr.input);
            const rawSteps: unknown[] = Array.isArray(o.steps) ? o.steps
              : Array.isArray(i.steps) ? i.steps
              : Array.isArray(tr.output) ? (tr.output as unknown[])
              : [];
            const steps = rawSteps.map((s, idx) => {
              if (typeof s === "string") return { text: s, done: false };
              const r = rec(s);
              const deps = Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).map(String).filter(Boolean) : undefined;
              return {
                text: asStr(r.title) ?? asStr(r.text) ?? asStr(r.id) ?? `step ${idx + 1}`,
                done: r.status === "done" || r.done === true,
                ...(deps && deps.length > 0 ? { dependsOn: deps } : {}),
              };
            });
            if (steps.length > 0) out.push({ kind: "plan", id, ts: ev.ts, steps });
            else if (label) out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "🗒", text: label });
            break;
          }

          case "agent.start":
            // The opener said nothing the following bubble does not: every
            // agent.start was immediately followed by that agent's route badge
            // and its output, so "▶ chat · greeting" was pure scaffolding.
            // agent.end is kept — a completion marker separates one step's work
            // from the next, which is the boundary a reader actually looks for.
            break;

          case "agent.end":
            markTerminal(ev.ts);
            out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "✔", text: label || "agent finished" });
            break;

          case "agent.thought":
            if (label) out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "💭", text: label });
            break;

          case "route":
            lastRoute = normalizeRoute({ decision: tr.input ?? tr.output });
            break;

          case "llm.call": {
            // Wave 25: a streamed call (input.streamed) seals its accumulator —
            // render the FULL live text (+ reasoning) instead of the 600-char
            // clipped trace output. Task mode keys the stream by the parent
            // span (streamed === true); chat mode by replyId (streamed === id).
            const inp = rec(tr.input);
            const streamedFlag: unknown = inp.streamed;
            let streamKey: string | undefined;
            if (streamedFlag === true) streamKey = asStr(tr.parentId);
            else if (typeof streamedFlag === "string" && streamedFlag) streamKey = streamedFlag;
            const acc = streamKey ? streams.get(streamKey) : undefined;
            if (streamKey) streams.delete(streamKey);
            else {
              // Non-streamed call under a span (engine retry paths drop the
              // stream hook/flag): seal-and-discard any stale accumulator so a
              // failed attempt's partial text can't be glued onto the next
              // streamed call on this span.
              const spanKey = asStr(tr.parentId);
              if (spanKey) streams.delete(spanKey);
            }

            // Chat mode: the final `message` frame (id = replyId) is the
            // canonical, reload-persistent render — suppress the llm.call
            // bubble to avoid a duplicate. The stream was already sealed above.
            if (typeof streamedFlag === "string") break;

            let rawText = acc && acc.text.trim() ? acc.text : (asStr(tr.output) ?? "");
            let rawThinking = acc?.thought.trim() ? acc.thought : asStr(inp.reasoning);
            const extracted = extractThinkingAndAnswer(rawText);
            let text = extracted.text;
            const thinking = rawThinking || extracted.thinking;
            if (!text.trim() && !thinking) break; // never render an empty thought bubble
            // Token counts are deliberately NOT appended to the message.
            // Per-call usage belongs in the dashboard (PS 11b(v) — tokens and
            // time per agent), where it can be read against the span tree.
            // Stamped under every reply it is just noise in a conversation.
            // Prefer the router's ACTUAL upstream decision over the alias. The
            // engine asks for "engine/small"; the router resolves that to a
            // concrete model on a concrete provider, and that is what the user
            // needs to see. Falling back to lastRoute (the engine-side decision)
            // only when the upstream is unknown — e.g. a direct provider call
            // with no local router in front of it.
            const up = rec(inp.upstream);
            const route = up.model
              ? {
                  modelKey: String(up.model),
                  providerId: String(up.provider ?? "?"),
                  tier: up.tier ? String(up.tier) : "?",
                  reasons: [
                    ...(up.reason ? String(up.reason).split("; ").filter(Boolean) : []),
                    ...(inp.aliasRequested ? [`requested alias: ${String(inp.aliasRequested)}`] : []),
                  ],
                }
              : lastRoute ?? (asStr(tr.model)
                ? { modelKey: tr.model as string, providerId: "?", tier: "?", reasons: [] }
                : undefined);
            out.push({
              kind: "thought", id, ts: ev.ts, text, route,
              ...(thinking ? { thinking } : {}),
            });
            break;
          }

          case "llm.retry": {
            // A retry abandons the in-flight attempt's partial deltas — drop the
            // span's accumulator so the failed text isn't glued onto the retry's
            // output (task-mode llm.retry carries parentId).
            const retrySpan = asStr(tr.parentId);
            if (retrySpan) streams.delete(retrySpan);
            out.push({ kind: "notice", id, ts: ev.ts, level: "warn", icon: "↻", text: label || "LLM retry" });
            break;
          }

          case "tool.call": {
            const tool = toolNameOf(label, asStr(tr.agentRole));
            out.push({ kind: "tool", id, ts: ev.ts, tool, phase: "running", input: tr.input });
            const sp = asStr(tr.spanId);
            if (sp) openTools.set(sp, out.length - 1);
            break;
          }

          case "tool.result": {
            const sp = asStr(tr.spanId);
            let idx = sp !== undefined ? openTools.get(sp) : undefined;
            if (idx === undefined) {
              // fallback: newest still-running row of the same tool name
              const name = toolNameOf(label);
              for (let i = out.length - 1; i >= 0; i--) {
                const it = out[i];
                if (it.kind === "tool" && it.phase === "running" && it.tool === name) { idx = i; break; }
              }
            }
            const o = rec(tr.output);
            const ok = tr.error !== undefined ? false : typeof o.ok === "boolean" ? o.ok : true;
            const output = o.result ?? o.error ?? tr.error ?? (typeof tr.output === "string" ? tr.output : tr.output);
            if (idx !== undefined) {
              const prev = out[idx];
              if (prev.kind === "tool") {
                prev.phase = "result";
                prev.ok = ok;
                prev.output = output;
                if (sp) openTools.delete(sp);
                break;
              }
            }
            // orphan result (backfill started mid-chain)
            out.push({ kind: "tool", id, ts: ev.ts, tool: toolNameOf(label), phase: "result", output, ok });
            break;
          }

          case "approval.request":
            out.push({ kind: "notice", id, ts: ev.ts, level: "warn", icon: "⏸", text: label || "Approval requested" });
            break;

          case "approval.decision": {
            const approved = /approv/i.test(label);
            out.push({ kind: "notice", id, ts: ev.ts, level: approved ? "info" : "warn", icon: approved ? "✓" : "✗", text: label || "Approval decision" });
            break;
          }

          case "compaction":
            out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "🗜", text: label || "Context compacted" });
            break;

          case "review":
            out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "🔍", text: label || "Review" });
            break;

          case "diff.propose":
            out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "⇄", text: label || "Diff proposed" });
            break;

          case "context.snapshot":
            // Dashboard telemetry, not conversation. Every LLM call emits one,
            // so rendering them here put a "context: coder — 6 msgs, 0 files,
            // ~298 tok" line between every message. The Dashboard's Context tab
            // is where this belongs (PS 11b(iv)); the chat is for the answer.
            break;

          case "retrieval":
            out.push({ kind: "notice", id, ts: ev.ts, level: "info", icon: "◇", text: label || "Retrieval" });
            break;

          case "error": {
            const text = asStr(tr.error) ?? (typeof tr.output === "string" ? tr.output : undefined) ?? label;
            if (text) out.push({ kind: "notice", id, ts: ev.ts, level: "error", icon: "⛔", text });
            break;
          }

          default:
            break; // unknown trace kinds are intentionally not rendered
        }
        break;
      }

      case "route":
        lastRoute = normalizeRoute(p);
        break;

      case "task": {
        const t = rec(p.task ?? p);
        const goal = asStr(t.goal) ?? asStr(t.title) ?? "";
        if (goal && !out.some((it) => it.kind === "goal")) {
          const title = asStr(t.title);
          out.push({ kind: "goal", id, ts: ev.ts, text: goal, title: title && title !== goal ? title : undefined });
        }
        break;
      }

      case "proposal": {
        const prop = rec(p.proposal ?? p);
        const pid = asStr(prop.id) ?? "?";
        const files: any[] = Array.isArray(prop.files) ? prop.files : [];
        const fileNames = files.map((f) => asStr(rec(f).path) ?? String(f)).join(", ");
        const hunks = files.reduce((n, f) => n + (Array.isArray(rec(f).hunks) ? rec(f).hunks.length : 0), 0)
          || files.length || 1;
        const existing = out.find((it): it is HitlItem => it.kind === "hitl" && it.proposalId === pid);
        if (existing) {
          if (fileNames) existing.path = fileNames;
          existing.hunks = hunks;
        } else {
          out.push({
            kind: "hitl", id, ts: ev.ts,
            proposalId: pid,
            path: fileNames || asStr(prop.rationale) || "files",
            hunks,
          });
        }
        break;
      }

      case "approval": {
        const app = rec(p.approval ?? p);
        const status = asStr(app.status) ?? "requested";
        out.push({
          kind: "notice", id, ts: ev.ts,
          level: status === "approved" ? "info" : "warn",
          icon: status === "approved" ? "✓" : "⏸",
          text: `Approval ${status}: ${asStr(app.summary) ?? asStr(app.toolName) ?? ""}`,
        });
        break;
      }

      case "status":
        // live status patching happens in the SSE handler (B34) — never here.
        break;

      case "token": {
        // Wave 25: live streaming deltas. kind:"thought" → reasoning box;
        // anything else → visible text. Keyed by messageId (chat: replyId,
        // task: step span).
        const key = asStr(p.messageId) ?? asStr(p.spanId);
        const delta = asStr(p.delta);
        if (key && delta) {
          const acc = streamFor(key, ev.ts);
          acc.lastTs = ev.ts;
          if (p.kind === "thought") acc.thought += delta;
          else acc.text += delta;
        }
        break;
      }

      case "session":
        break; // session snapshots are not timeline items

      case "error": {
        // defensive: not part of the pinned wire contract, but cheap to render
        markTerminal(ev.ts);
        const text = asStr(p.message) ?? asStr(p.error) ?? asStr(p.text) ?? "";
        if (text) out.push({ kind: "notice", id, ts: ev.ts, level: "error", icon: "⛔", text });
        break;
      }

      default:
        break; // unknown event types are intentionally not rendered
    }
  }

  // Wave 25: streams still open at the tail of the buffer are either LIVE right
  // now (render with a blinking cursor) or dead calls that never sealed because a
  // terminal frame (task/agent end, error) landed after their last token (render
  // static — show what was generated, but stop the cursor). Sealed streams were
  // already consumed by their llm.call / message frame above.
  for (const [key, acc] of streams) {
    if (!acc.text.trim() && !acc.thought.trim()) continue;
    const live = lastTerminalTs === 0 || acc.lastTs > lastTerminalTs;
    out.push({
      kind: "thought", id: `stream-${key}`, ts: acc.ts,
      text: acc.text, route: lastRoute,
      ...(acc.thought.trim() ? { thinking: acc.thought } : {}),
      ...(live ? { streaming: true } : {}),
    });
  }

  // Merge optimistic local items by TIMESTAMP, not by appending.
  //
  // They used to be concatenated at the end, so a prompt sent while a task was
  // running rendered BELOW everything already on screen — the user's own
  // message appearing under the assistant's thinking and tool output from the
  // previous turn. A conversation has to read in the order it happened.
  //
  // Sort is stable and ties break toward the SERVER item, so an optimistic
  // bubble and its confirmed counterpart keep their existing relative order and
  // the dedupe pass below still sees them adjacent.
  const merged = [
    ...dedupeAdjacent(out).map((it, i) => ({ it, ts: it.ts, seq: i, local: 0 })),
    ...local.map((it, i) => ({ it, ts: it.ts, seq: i, local: 1 })),
  ].sort((a, b) => a.ts - b.ts || a.local - b.local || a.seq - b.seq);
  return merged.map((m) => m.it);
}
