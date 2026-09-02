// events.ts — Authoritative Canonical Event Store: the single source of truth
// for session transcripts (ported from the reference implementation).
//
// One append-only log per session. EVERY transcript event — user/assistant
// message, trace span, task state, status, approval, proposal, route decision,
// session snapshot — is appended exactly once via eventStore.append and gets:
//   * `cursor`: a per-session monotonically increasing INTEGER, allocated once
//     before broadcast. It is the ONLY ordering/replay id space the UI sees
//     (SSE `id:` lines, ?after= cursors, REST row ids).
//   * `id`: a stable UUID/semantic id used ONLY for idempotency/dedupe —
//     never for ordering and never as a transport cursor.
//
// REST (GET /api/tasks/:id/events) and SSE (/api/events*) serve rows from THIS
// store exclusively — no more merging of trace ring + wire ring + session
// messages with incompatible id spaces, and no timestamp-derived ids.
//
// Producers that still emit through the legacy buses are bridged here exactly
// once by startEventStore() (idempotent):
//   * trace.emit → one type:"trace" row per span (tool.call/tool.result share
//     their spanId in the payload so the UI can merge the pair), plus a
//     derived type:"route" row for route traces carrying a RouteDecision;
//   * wire.emit  → one row per WireEvent (message/task/status/approval/
//     proposal/session/...). Wire events of type "trace" are skipped because
//     the trace bridge already recorded the underlying span — never expose
//     both a trace and its WireEvent wrapper as two transcript records.
//
// Persistence: in-memory per-session list + append-only JSONL journal under
// DATA_DIR/events/<sessionId>.jsonl (reference design). High-volume,
// re-derivable snapshot rows (`session`, `token`) are live-only: they get a
// cursor and stream over SSE but are not journaled — the same policy the old
// wave-2b journal applied, and the REST endpoints re-serve that data from its
// own stores. The pre-existing persistence for messages (sessions.ts) and
// traces (traces.jsonl) is untouched and backs the legacy backfill below.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ChatMessage, RouteDecision, TaskRecord, TraceEvent, WireEvent } from "./types.js";
import { DATA_DIR, ensureDataDir } from "./config.js";
import { wire, extractEventIds } from "./bus.js";
import { trace } from "./trace.js";

export interface CanonicalEvent {
  cursor: number;
  id: string; // stable UUID / semantic id (dedupe key; NEVER used for ordering)
  sessionId: string;
  taskId?: string;
  projectId?: string;
  type: string;
  payload: Record<string, any>;
  createdAt: number;
}

/** Canonical DTO — the ONE shape shared by REST backfill rows and SSE frames
 *  (both replay and live). `id` === `cursor` so existing clients that key on
 *  numeric `id` keep working; `eventId` carries the stable semantic id. */
export interface EventDto {
  id: number; // = cursor
  cursor: number;
  eventId: string;
  taskId: string;
  sessionId: string;
  projectId?: string;
  ts: number; // = createdAt (compat alias)
  createdAt: number;
  type: string;
  payload: Record<string, any>;
}

export function toEventDto(ev: CanonicalEvent, fallbackTaskId?: string): EventDto {
  return {
    id: ev.cursor,
    cursor: ev.cursor,
    eventId: ev.id,
    taskId: ev.taskId ?? fallbackTaskId ?? ev.sessionId,
    sessionId: ev.sessionId,
    ...(ev.projectId ? { projectId: ev.projectId } : {}),
    ts: ev.createdAt,
    createdAt: ev.createdAt,
    type: ev.type,
    payload: ev.payload,
  };
}

type CanonicalListener = (ev: CanonicalEvent) => void;
const listeners = new Set<CanonicalListener>();

const cursors = new Map<string, number>();
const inMemoryEvents = new Map<string, CanonicalEvent[]>();
const seenEventIds = new Map<string, Set<string>>();

/** High-volume / re-derivable snapshot types are live-only (not journaled). */
const LIVE_ONLY_TYPES = new Set(["session", "token"]);

/** Session ids become file names — same sanitization as trace.ts so a raw id
 *  can never traverse out of DATA_DIR. */
function safeId(sessionId: string): string {
  return sessionId.replace(/[^\w-]/g, "_");
}

function eventLogDir(): string {
  ensureDataDir();
  const dir = path.join(DATA_DIR, "events");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function eventLogPath(sessionId: string): string {
  return path.join(eventLogDir(), `${safeId(sessionId)}.jsonl`);
}

function loadEvents(sessionId: string): CanonicalEvent[] {
  let list = inMemoryEvents.get(sessionId);
  if (list) return list;

  list = [];
  const seen = new Set<string>();
  const fpath = eventLogPath(sessionId);
  if (fs.existsSync(fpath)) {
    try {
      let buf = fs.readFileSync(fpath);
      // Strip a leading UTF-8 BOM (externally touched file) so the first line parses.
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
      // Torn-tail repair: a crash mid-write leaves a partial last line (no
      // trailing \n). Truncate it (byte-correct) so the next appendFileSync
      // doesn't glue new JSON onto the partial bytes and lose the first
      // post-crash event from the journal.
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
        const lastNl = buf.lastIndexOf(0x0a);
        const good = lastNl === -1 ? 0 : lastNl + 1;
        try {
          fs.truncateSync(fpath, good);
        } catch {
          /* best effort */
        }
        buf = buf.subarray(0, good);
      }
      const lines = buf.toString("utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as CanonicalEvent;
          list.push(ev);
          seen.add(ev.id);
          const cur = cursors.get(sessionId) ?? 0;
          if (ev.cursor > cur) cursors.set(sessionId, ev.cursor);
        } catch {
          /* corrupt line — skip */
        }
      }
    } catch {
      /* unreadable journal — start fresh in memory */
    }
  }
  inMemoryEvents.set(sessionId, list);
  seenEventIds.set(sessionId, seen);
  return list;
}

export const eventStore = {
  append(
    sessionId: string,
    type: string,
    payload: Record<string, any>,
    opts?: { id?: string; taskId?: string; projectId?: string; createdAt?: number },
  ): CanonicalEvent {
    const list = loadEvents(sessionId);
    let seen = seenEventIds.get(sessionId);
    if (!seen) {
      seen = new Set();
      seenEventIds.set(sessionId, seen);
    }

    const eventId = opts?.id || crypto.randomUUID();
    // Idempotency: don't double-append identical eventId within a session.
    if (opts?.id && seen.has(opts.id)) {
      const existing = list.find((e) => e.id === opts.id);
      if (existing) return existing;
    }

    const prevCursor = cursors.get(sessionId) ?? (list.length > 0 ? (list[list.length - 1]?.cursor ?? 0) : 0);
    const cursor = prevCursor + 1;
    cursors.set(sessionId, cursor);
    seen.add(eventId);

    const createdAt = opts?.createdAt || Date.now();
    const taskId = opts?.taskId || (payload as any)?.taskId || (payload as any)?.task?.id;
    const projectId = opts?.projectId || (payload as any)?.projectId || (payload as any)?.session?.projectId;

    const ev: CanonicalEvent = {
      cursor,
      id: eventId,
      sessionId,
      taskId,
      projectId,
      type,
      payload,
      createdAt,
    };

    list.push(ev);

    // Persist to the JSONL journal (live-only types skip this).
    if (!LIVE_ONLY_TYPES.has(type)) {
      try {
        fs.appendFileSync(eventLogPath(sessionId), JSON.stringify(ev) + "\n", "utf8");
      } catch (err) {
        console.error("[eventStore] append error:", err);
      }
    }

    // Broadcast the canonical row to SSE listeners.
    for (const l of listeners) {
      try {
        l(ev);
      } catch (err) {
        console.error("[eventStore] listener error:", err);
      }
    }

    return ev;
  },

  getEvents(sessionId: string, afterCursor = 0): CanonicalEvent[] {
    const list = loadEvents(sessionId);
    if (afterCursor <= 0) return [...list];
    return list.filter((e) => e.cursor > afterCursor);
  },

  getLatestCursor(sessionId: string): number {
    const list = loadEvents(sessionId);
    return list.length > 0 ? (list[list.length - 1]?.cursor ?? 0) : (cursors.get(sessionId) ?? 0);
  },

  subscribe(listener: CanonicalListener, filterSessionId?: string): () => void {
    const fn: CanonicalListener = (ev) => {
      if (!filterSessionId || ev.sessionId === filterSessionId) {
        listener(ev);
      }
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// ── Legacy bus → canonical store bridges ────────────────────────────────────

function isRouteDecision(v: unknown): v is RouteDecision {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RouteDecision).modelId === "string" &&
    typeof (v as RouteDecision).reason === "string"
  );
}

/** Stable semantic id for a WireEvent so accidental re-emissions dedupe
 *  instead of duplicating transcript rows. Types without a natural identity
 *  (status/route/token) return undefined → a fresh UUID is allocated and
 *  every emission is recorded. */
function wireEventId(e: WireEvent): string | undefined {
  switch (e.type) {
    case "message":
      return e.message?.id;
    case "task": {
      const t = e.task;
      return t ? `task:${t.id}:${t.status}:${t.updatedAt ?? t.createdAt ?? 0}` : undefined;
    }
    case "approval":
      return e.approval ? `approval:${e.approval.id}:${e.approval.status}` : undefined;
    case "proposal":
      return e.proposal
        ? `proposal:${e.proposal.id}:${e.proposal.status}:${e.proposal.files?.length ?? 0}`
        : undefined;
    case "session":
      return `session:${e.session?.id ?? "?"}:${e.session?.updatedAt ?? 0}`;
    default:
      return undefined;
  }
}

let started = false;
/** Register the trace→store and wire→store bridges EXACTLY ONCE.
 *  Idempotent — safe to call from index.ts startup and from tests. */
export function startEventStore(): void {
  if (started) return;
  started = true;

  // Every trace span (task.start/task.end, plan, agent.start/agent.end/
  // agent.thought, route, llm.call/llm.retry, tool.call/tool.result,
  // approval.request/approval.decision, retrieval, compaction, review,
  // diff.propose, error, context.snapshot) becomes ONE canonical row. The
  // TraceEvent is spread at the payload root AND kept at payload.event so
  // both new (`payload.kind/spanId`) and legacy (`payload.event.kind`)
  // renderers find it.
  trace.subscribe((te) => {
    eventStore.append(
      te.sessionId,
      "trace",
      { ...te, event: te },
      { id: String(te.id), taskId: te.taskId, createdAt: te.at },
    );
    // Derived route row (replaces the old manual chat.ts re-emit): route
    // decisions surface as their own transcript event AFTER the trace row.
    if (te.kind === "route" && isRouteDecision(te.input)) {
      eventStore.append(
        te.sessionId,
        "route",
        { type: "route", sessionId: te.sessionId, taskId: te.taskId, decision: te.input },
        { id: `route-${te.id}`, taskId: te.taskId, createdAt: te.at },
      );
    }
  });

  // Every WireEvent from producers that still emit on the legacy bus
  // (orchestrator, tools, approvals, chat, index.ts routes) becomes one
  // canonical row. Wire events of type "trace" are skipped: the trace bridge
  // above already recorded the underlying span.
  wire.subscribe((e) => {
    if (e.type === "trace") return;
    const ids = extractEventIds(e);
    if (!ids.sessionId) return; // no session scope → not a transcript event
    eventStore.append(
      ids.sessionId,
      e.type,
      e as unknown as Record<string, any>,
      {
        id: wireEventId(e),
        taskId: ids.taskId,
        projectId: ids.projectId,
        createdAt: e.type === "message" ? (e.message.at ?? Date.now()) : Date.now(),
      },
    );
  });
}

// ── Legacy backfill (pre-store sessions) ────────────────────────────────────
// Sessions created BEFORE the canonical store existed have no journal rows.
// For those, GET /api/tasks/:id/events deterministically rebuilds canonical
// DTOs from the durable sources the working copy always persisted (task
// record, session messages, traces.jsonl), assigning synthetic cursors 1..n
// in chronological order. Once a session has real store rows, the endpoints
// serve the store exclusively and this builder is never used for it.

export function legacyEvents(opts: {
  sessionId: string;
  taskId: string;
  task?: TaskRecord;
  messages: ChatMessage[];
  traces?: TraceEvent[];
  projectId?: string;
}): EventDto[] {
  type Item = { ts: number; type: string; payload: Record<string, any>; eventId: string };
  const items: Item[] = [];
  if (opts.task) {
    items.push({
      ts: opts.task.createdAt || opts.task.updatedAt || 0,
      type: "task",
      payload: { type: "task", task: opts.task, sessionId: opts.sessionId },
      eventId: `task:${opts.task.id}:initial`,
    });
  }
  for (const m of opts.messages ?? []) {
    items.push({
      ts: m.at ?? 0,
      type: "message",
      payload: { type: "message", sessionId: opts.sessionId, message: m },
      eventId: m.id,
    });
  }
  for (const te of opts.traces ?? []) {
    items.push({
      ts: te.at ?? 0,
      type: "trace",
      payload: { ...te, event: te },
      eventId: String(te.id),
    });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items.map((it, i) => ({
    id: i + 1,
    cursor: i + 1,
    eventId: it.eventId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ts: it.ts,
    createdAt: it.ts,
    type: it.type,
    payload: it.payload,
  }));
}
