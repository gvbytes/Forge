// Trace bus: every agent/tool/llm/route event flows through here.
// Persisted per project for post-hoc dashboard; broadcast over SSE live.
import fs from "node:fs";
import path from "node:path";
import { TraceEvent } from "./types.js";
import { DATA_DIR } from "./config.js";

type Listener = (e: TraceEvent) => void;
const listeners = new Set<Listener>();

const RING_CAP = 5000;
const rings = new Map<string, TraceEvent[]>(); // projectId -> events
/**
 * IDs must be unique ACROSS server restarts: traces.jsonl rings from previous
 * runs are re-served to the dashboard next to live events and deduped BY id,
 * so the old `let seq = 1` reset made every post-restart event collide with
 * history — the dashboard kept the OLD event and silently DROPPED the newer
 * run. Scheme: bounded monotonic `Date.now() - TRACE_ID_EPOCH + seq++`.
 *   * within a process: strictly ascending (numeric sort stays stable);
 *   * across restarts: the later process's base is larger than any id an
 *     earlier one emitted, because wall time only moved forward and per-run
 *     counters (≪ restart gaps) can't bridge a millisecond of drift;
 *   * clock skew backwards is guarded anyway: an id is never allowed to be
 *     ≤ its in-process predecessor.
 */
export const TRACE_ID_EPOCH = 1_700_000_000_000; // 2023-11-14T22:13:20Z
let seq = 0;
let lastId = 0;

function nextId(): number {
  let id = Date.now() - TRACE_ID_EPOCH + ++seq;
  if (id <= lastId) id = lastId + 1;
  lastId = id;
  return id;
}

/** B4: the wire-event single id space (events.ts) draws from this SAME counter
 *  so trace events and wire frames can never collide and stay globally
 *  monotonic across both buses. */
export function nextEventId(): number {
  return nextId();
}

/** Advance the floor after loading persisted rows (journal/traces) so fresh
 *  ids stay strictly above anything a previous run emitted — covers clock
 *  skew in addition to the wall-clock restart guarantee above. */
export function floorEventId(floor: number): void {
  if (Number.isFinite(floor) && floor > lastId) lastId = Math.floor(floor);
}

/** Current high-water mark (last emitted id). Synthetic backfill ids must
 *  stay BELOW this so they sort before live events. */
export function currentEventId(): number {
  return lastId;
}

export const trace = {
  emit(e: Omit<TraceEvent, "id" | "at"> & { at?: number }): TraceEvent {
    const full: TraceEvent = { ...e, id: nextId(), at: e.at ?? Date.now() };
    const ring = rings.get(full.sessionId) ?? [];
    ring.push(full);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    rings.set(full.sessionId, ring);
    for (const l of listeners) {
      try {
        l(full);
      } catch {
        /* listener error must not break emitter */
      }
    }
    // fire-and-forget persistence
    persist(full).catch(() => {});
    return full;
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  recent(sessionId: string): TraceEvent[] {
    return rings.get(sessionId) ?? [];
  },
  getEvents(sessionId: string): TraceEvent[] {
    const mem = rings.get(sessionId);
    if (mem && mem.length > 0) return mem;
    return loadTraces(sessionId);
  },
};

/** Session ids become directory names — sanitize path separators so a raw
 *  id can never traverse out of DATA_DIR/projects (HTTP routes validate
 *  `/^[\w-]+$/` too; this covers internal callers). */
function safeId(sessionId: string): string {
  return sessionId.replace(/[^\w-]/g, "_");
}

function fileFor(sessionId: string): string {
  return path.join(DATA_DIR, "projects", safeId(sessionId), `traces.jsonl`);
}

async function persist(e: TraceEvent): Promise<void> {
  const dir = path.dirname(fileFor(e.sessionId));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(fileFor(e.sessionId), JSON.stringify(e) + "\n");
}

export function loadTraces(sessionId: string): TraceEvent[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(fileFor(sessionId));
  } catch {
    return [];
  }
  // Strip a leading UTF-8 BOM (externally touched file) so the first line parses.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  // Torn-tail repair: a crash mid-write leaves a partial last line (no trailing
  // \n). Truncate it (byte-correct) so the next persist() doesn't glue new JSON
  // onto the partial bytes and corrupt the next persisted line.
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
    const lastNl = buf.lastIndexOf(0x0a);
    const good = lastNl === -1 ? 0 : lastNl + 1;
    try {
      fs.truncateSync(fileFor(sessionId), good);
    } catch {
      /* best effort */
    }
    buf = buf.subarray(0, good);
  }
  // Parse line-by-line: a single corrupt/torn line (e.g. crash mid-write) must
  // not discard the whole session's traces (the old single .map(JSON.parse)
  // threw and the outer catch returned []).
  const out: TraceEvent[] = [];
  let maxId = 0;
  for (const line of buf.toString("utf8").split("\n").filter(Boolean).slice(-RING_CAP)) {
    try {
      const t = JSON.parse(line) as TraceEvent;
      out.push(t);
      if (typeof t.id === "number" && t.id > maxId) maxId = t.id;
    } catch {
      /* skip corrupt line */
    }
  }
  // Advance the id floor past any persisted id so post-restart ids — even under
  // a backward clock step — never collide with history (the dashboard dedupes by
  // id and would otherwise keep the OLD row and drop the newer run).
  if (maxId > 0) floorEventId(maxId);
  return out;
}
