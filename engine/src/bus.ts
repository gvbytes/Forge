// Wire event bus: everything producers still emit live (SSE ingestion path).
//
// In the canonical event-store design (events.ts) this bus is NO LONGER the
// transcript source of truth — the event store subscribes here once and
// appends one canonical row per WireEvent. The ring buffer is kept for
// in-process observability (and parity with the reference implementation).
import { WireEvent } from "./types.js";

export interface StoredWireEvent {
  seq: number;
  ts: number;
  event: WireEvent;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
}

type Listener = (e: WireEvent, stored: StoredWireEvent) => void;
const listeners = new Set<{ fn: Listener; filterId?: string }>();

const EVENT_BUFFER_SIZE = 2000;
let eventSeq = Date.now();
const eventRing: StoredWireEvent[] = [];

/** Best-effort identity extraction from every WireEvent variant: surfaces
 *  sessionId/taskId/projectId from wherever each variant carries them. */
export function extractEventIds(e: WireEvent): { taskId?: string; sessionId?: string; projectId?: string } {
  let sessionId = (e as any).sessionId;
  let taskId = (e as any).taskId;
  let projectId = (e as any).projectId;

  if (e.type === "trace") {
    sessionId = sessionId || e.event?.sessionId;
    taskId = taskId || e.event?.taskId;
  } else if (e.type === "session") {
    sessionId = sessionId || e.session?.id;
    projectId = projectId || e.session?.projectId;
    taskId = taskId || e.session?.task?.id;
  } else if (e.type === "task") {
    taskId = taskId || e.task?.id;
    sessionId = sessionId || e.task?.sessionId;
  } else if (e.type === "approval") {
    sessionId = sessionId || e.approval?.sessionId;
  } else if (e.type === "proposal") {
    sessionId = sessionId || e.proposal?.sessionId;
    taskId = taskId || e.proposal?.taskId;
  }

  return { taskId, sessionId, projectId };
}

export function matchesTarget(stored: StoredWireEvent, targetId?: string): boolean {
  if (!targetId || targetId === "all" || targetId === "global") return true;
  return (
    stored.taskId === targetId ||
    stored.sessionId === targetId ||
    stored.projectId === targetId
  );
}

export const wire = {
  emit(e: WireEvent): StoredWireEvent {
    const ids = extractEventIds(e);
    const stored: StoredWireEvent = {
      seq: ++eventSeq,
      ts: Date.now(),
      event: e,
      taskId: ids.taskId,
      sessionId: ids.sessionId,
      projectId: ids.projectId,
    };

    eventRing.push(stored);
    if (eventRing.length > EVENT_BUFFER_SIZE) {
      eventRing.shift();
    }

    for (const sub of listeners) {
      if (!sub.filterId || matchesTarget(stored, sub.filterId)) {
        try {
          sub.fn(e, stored);
        } catch {
          /* ignore */
        }
      }
    }
    return stored;
  },

  getEventsSince(targetId?: string, sinceSeq = 0): StoredWireEvent[] {
    return eventRing.filter((s) => s.seq > sinceSeq && matchesTarget(s, targetId));
  },

  subscribe(fn: Listener, filterId?: string): () => void {
    const item = { fn, filterId };
    listeners.add(item);
    return () => {
      listeners.delete(item);
    };
  },
};

/** Wave 25 (fluid chat): upstream models emit one SSE chunk per 1–3 tokens —
 *  forwarding each as its own wire event would flood the event store with
 *  thousands of rows per response. The throttle coalesces deltas and flushes
 *  at most every `intervalMs` (40 ms ≈ 25 fps — imperceptible for text). */
export function createDeltaThrottle(
  emit: (d: { text?: string; reasoning?: string }) => void,
  intervalMs = 40,
): { push: (d: { text?: string; reasoning?: string }) => void; flush: () => void } {
  let text = "";
  let reasoning = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    timer = null;
    const d: { text?: string; reasoning?: string } = {};
    if (text) { d.text = text; text = ""; }
    if (reasoning) { d.reasoning = reasoning; reasoning = ""; }
    if (d.text !== undefined || d.reasoning !== undefined) {
      try { emit(d); } catch { /* listener errors never break the stream */ }
    }
  };
  return {
    push(d) {
      if (d.text) text += d.text;
      if (d.reasoning) reasoning += d.reasoning;
      if (!timer) {
        timer = setTimeout(fire, intervalMs);
        if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
      }
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
  };
}
