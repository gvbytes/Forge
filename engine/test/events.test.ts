// Canonical event store contract tests (reference-design port).
// Covers: per-session monotonic integer cursors + canonical DTO shape,
// cursor-based since filtering, trace→store bridge exactly-once with spanId
// correlation (tool.call/tool.result merge key), derived route rows,
// stable-id idempotency (append + wire bridge dedupe), session-scoped
// subscribe, legacy backfill for pre-store sessions, and ensureTask
// archiving (B19 reuse).
import "./_env.js";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { wire } from "../src/bus.js";
import { trace } from "../src/trace.js";
import { eventStore, startEventStore, toEventDto, legacyEvents } from "../src/events.js";
import { ensureTask } from "../src/orchestrator.js";
import type { ChatMessage, RouteDecision, Session, TaskRecord, TraceEvent } from "../src/types.js";

startEventStore(); // idempotent — registers the trace/wire→store bridges once

const sid = `evtest-${crypto.randomUUID().slice(0, 8)}`;

function msg(content: string, at = Date.now()): ChatMessage {
  return { id: crypto.randomUUID(), role: "user", content, at };
}

describe("canonical event store (events.ts)", () => {
  test("wire events become store rows with strictly ascending integer cursors", () => {
    wire.emit({ type: "message", sessionId: sid, message: msg("a") });
    wire.emit({ type: "status", sessionId: sid, status: "running" });
    wire.emit({ type: "message", sessionId: sid, message: msg("b") });
    const rows = eventStore.getEvents(sid);
    expect(rows.length).toBe(3);
    rows.forEach((r, i) => {
      expect(r.cursor).toBe(i + 1); // per-session cursors start at 1
      expect(r.sessionId).toBe(sid);
      expect(typeof r.id).toBe("string"); // stable UUID/semantic id, not a cursor
      expect(typeof r.createdAt).toBe("number");
      expect(typeof r.type).toBe("string");
      expect(typeof r.payload).toBe("object");
    });
    // canonical DTO: ONE shape for REST backfill and SSE frames
    const dto = toEventDto(rows[0]!);
    expect(dto.id).toBe(1); // id === cursor
    expect(dto.id).toBe(dto.cursor);
    expect(dto.eventId).toBe(rows[0]!.id);
    expect(dto.sessionId).toBe(sid);
    expect(dto.taskId).toBe(sid); // falls back to sessionId when no task
    expect(typeof dto.ts).toBe("number");
    expect(dto.ts).toBe(dto.createdAt);
    expect(typeof dto.type).toBe("string");
    expect(typeof dto.payload).toBe("object");
  });

  test("getEvents(afterCursor) returns only rows with cursor > afterCursor, ascending", () => {
    const rows = eventStore.getEvents(sid);
    const pivot = rows[0]!.cursor;
    const tail = eventStore.getEvents(sid, pivot);
    expect(tail.length).toBe(rows.length - 1);
    for (const r of tail) expect(r.cursor).toBeGreaterThan(pivot);
    expect(eventStore.getEvents(sid, rows[rows.length - 1]!.cursor)).toHaveLength(0);
  });

  test("trace spans reach the store exactly once with spanId in the payload", () => {
    const before = eventStore.getEvents(sid).filter((r) => r.type === "trace").length;
    trace.emit({
      sessionId: sid, spanId: "span-1", kind: "tool.call",
      label: "tool: read_file", input: { path: "x.ts" },
    });
    const traces = eventStore.getEvents(sid).filter((r) => r.type === "trace");
    expect(traces.length).toBe(before + 1); // exactly one row, no mirror dup
    const row = traces[traces.length - 1]!;
    expect(row.payload.kind).toBe("tool.call"); // TraceEvent spread at payload root
    expect(row.payload.spanId).toBe("span-1"); // UI merges call/result by spanId
    expect(row.payload.event.spanId).toBe("span-1"); // legacy payload.event path kept
    expect(row.createdAt).toBeGreaterThan(0);
  });

  test("tool.call and tool.result share their spanId and stay ordered", () => {
    const span = `span-${crypto.randomUUID().slice(0, 8)}`;
    trace.emit({ sessionId: sid, spanId: span, kind: "tool.call", label: "tool: list_dir", input: { path: "." } });
    trace.emit({ sessionId: sid, spanId: span, kind: "tool.result", label: "tool: list_dir", output: { files: ["a"] } });
    const pair = eventStore.getEvents(sid).filter((r) => r.type === "trace" && r.payload.spanId === span);
    expect(pair.length).toBe(2);
    expect(pair[0]!.payload.kind).toBe("tool.call");
    expect(pair[1]!.payload.kind).toBe("tool.result");
    expect(pair[0]!.cursor).toBeLessThan(pair[1]!.cursor);
  });

  test("route traces derive a type:'route' row AFTER the trace row", () => {
    const decision: RouteDecision = {
      modelId: "engine/small", provider: "local-proxy", reason: "tiny prompt",
      signals: [{ name: "cx", value: 0.1 }], complexity: 0.1, fallbacks: [], at: Date.now(),
    };
    trace.emit({ sessionId: sid, spanId: "span-r", kind: "route", label: "route", input: decision });
    const rows = eventStore.getEvents(sid);
    const traceRow = rows.filter((r) => r.type === "trace").pop()!;
    const routeRow = rows.filter((r) => r.type === "route").pop()!;
    expect(routeRow.cursor).toBeGreaterThan(traceRow.cursor);
    expect(routeRow.sessionId).toBe(sid);
    expect(routeRow.payload.decision.modelId).toBe("engine/small");
  });

  test("append is idempotent on a repeated stable id", () => {
    const id = crypto.randomUUID();
    const m = msg("dedupe me");
    const first = eventStore.append(sid, "message", { type: "message", sessionId: sid, message: m }, { id });
    const second = eventStore.append(sid, "message", { type: "message", sessionId: sid, message: m }, { id });
    expect(second.cursor).toBe(first.cursor); // same row returned, no dup appended
    expect(eventStore.getEvents(sid).filter((r) => r.id === id)).toHaveLength(1);
  });

  test("message wire events dedupe against an explicit append (same message id)", () => {
    const m = msg("once only");
    eventStore.append(sid, "message", { type: "message", sessionId: sid, message: m }, { id: m.id });
    wire.emit({ type: "message", sessionId: sid, message: m }); // bridge must dedupe
    expect(eventStore.getEvents(sid).filter((r) => r.id === m.id)).toHaveLength(1);
  });

  test("wire events of type 'trace' are skipped (trace bridge owns spans)", () => {
    const before = eventStore.getEvents(sid).length;
    const te = trace.emit({ sessionId: sid, spanId: "span-dup", kind: "llm.call", label: "chat" });
    wire.emit({ type: "trace", event: te }); // must NOT create a second row
    const rows = eventStore.getEvents(sid);
    expect(rows.length).toBe(before + 1); // only the trace bridge row
    expect(rows[rows.length - 1]!.type).toBe("trace");
  });

  test("subscribe can filter by session and stops after unsubscribe", () => {
    const other = `evtest-${crypto.randomUUID().slice(0, 8)}`;
    const seen: number[] = [];
    const unsub = eventStore.subscribe((ev) => seen.push(ev.cursor), sid);
    wire.emit({ type: "status", sessionId: other, status: "running" }); // filtered out
    wire.emit({ type: "status", sessionId: sid, status: "done" });
    unsub();
    wire.emit({ type: "status", sessionId: sid, status: "running" }); // after unsub
    expect(seen).toHaveLength(1);
  });

  test("getLatestCursor tracks the high-water mark", () => {
    const rows = eventStore.getEvents(sid);
    expect(eventStore.getLatestCursor(sid)).toBe(rows[rows.length - 1]!.cursor);
  });
});

describe("legacy backfill (pre-store sessions)", () => {
  test("rebuilds task+messages+traces as cursor-ordered canonical DTOs", () => {
    const now = Date.now();
    const taskId = crypto.randomUUID();
    const task: TaskRecord = {
      id: taskId, sessionId: "legacy-s", title: "t", status: "done", goal: "g",
      createdAt: now - 10000, updatedAt: now, tokensUsed: {}, costUsd: 0, stepCount: 0, stuckEvents: [],
    };
    const m1 = msg("first", now - 5000);
    const te: TraceEvent = {
      id: 123, sessionId: "legacy-s", spanId: "s", kind: "tool.call", label: "tool: x", at: now - 4000,
    };
    const dtos = legacyEvents({ sessionId: "legacy-s", taskId, task, messages: [m1], traces: [te] });
    expect(dtos).toHaveLength(3);
    dtos.forEach((d, i) => {
      expect(d.cursor).toBe(i + 1); // synthetic cursors 1..n, chronological
      expect(d.id).toBe(d.cursor);
      expect(d.taskId).toBe(taskId);
    });
    expect(dtos.map((d) => d.type)).toEqual(["task", "message", "trace"]);
    expect(dtos[1]!.payload.message.content).toBe("first");
    expect(dtos[2]!.payload.event.kind).toBe("tool.call");
  });
});

describe("B19 ensureTask archiving (reuses wave-1 B9 rule)", () => {
  function sessionWith(task: TaskRecord | undefined): Session {
    return {
      id: `s-${crypto.randomUUID().slice(0, 8)}`, projectId: "p1", title: "t",
      messages: [], contextRefs: [], task, compactions: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  }
  function task(status: TaskRecord["status"]): TaskRecord {
    const now = Date.now();
    return {
      id: crypto.randomUUID(), sessionId: "x", title: "old", status, goal: "old goal",
      createdAt: now, updatedAt: now, tokensUsed: {}, costUsd: 0, stepCount: 0, stuckEvents: [],
    };
  }

  test("archives a TERMINAL previous task and creates a fresh one", () => {
    const s = sessionWith(task("done"));
    const oldId = s.task!.id;
    const t = ensureTask(s, "new prompt");
    expect(t.id === oldId).toBe(false);
    expect(t.status).toBe("planning");
    expect(t.goal).toBe("new prompt");
    expect(t.sessionId).toBe(s.id);
    expect((s.pastTasks ?? []).length).toBe(1);
    expect(s.pastTasks![0]!.id).toBe(oldId);
  });

  test("is idempotent on the fresh task (runTask's ??= no-ops)", () => {
    const s = sessionWith(task("failed"));
    const t1 = ensureTask(s, "p1");
    const t2 = ensureTask(s, "p2");
    expect(t2.id).toBe(t1.id); // not re-created, not re-archived
    expect((s.pastTasks ?? []).length).toBe(1);
  });

  test("leaves a non-terminal task in place", () => {
    const s = sessionWith(task("running"));
    const oldId = s.task!.id;
    const t = ensureTask(s, "another prompt");
    expect(t.id).toBe(oldId);
    expect((s.pastTasks ?? []).length).toBe(0);
  });
});
