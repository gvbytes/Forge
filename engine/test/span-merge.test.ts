// The dashboard timeline could not show concurrency: each span was emitted as
// TWO rows (agent.start + agent.end) sharing an id, and the end row set t0 to
// the END timestamp and t1 to end+duration — placing every finished span in the
// future by its own duration. Parallel steps therefore rendered as zero-width
// marks, and overlapping work was invisible.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { mergeSpans } from "../src/index.js";
import type { TraceEvent } from "../src/types.js";

const ev = (o: Partial<TraceEvent> & { spanId: string; kind: string; at: number }): TraceEvent =>
  ({ id: 0, sessionId: "s", label: o.kind, ...o }) as unknown as TraceEvent;

describe("mergeSpans", () => {
  test("folds start+end into ONE row with a real interval", () => {
    const rows = mergeSpans([
      ev({ spanId: "a", kind: "agent.start", at: 1000, label: "coder · s1" }),
      ev({ spanId: "a", kind: "agent.end", at: 4000, durationMs: 3000, label: "coder · s1 → done" }),
    ], "t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.t0).toBe(1000);
    expect(rows[0]!.t1).toBe(4000);
    expect(rows[0]!.status).toBe("done");
    // The end event's label carries the outcome, so it wins.
    expect(rows[0]!.name).toBe("coder · s1 → done");
  });

  test("CONCURRENCY IS VISIBLE: overlapping steps produce overlapping intervals", () => {
    // This is the property the dashboard needs. Three steps started together;
    // their [t0,t1] intervals must genuinely overlap.
    const rows = mergeSpans([
      ev({ spanId: "s1", kind: "agent.start", at: 0 }),
      ev({ spanId: "s2", kind: "agent.start", at: 2 }),
      ev({ spanId: "s3", kind: "agent.start", at: 2 }),
      ev({ spanId: "s1", kind: "agent.end", at: 28_289, durationMs: 28_289 }),
      ev({ spanId: "s2", kind: "agent.end", at: 73_225, durationMs: 73_223 }),
      ev({ spanId: "s3", kind: "agent.end", at: 172_474, durationMs: 172_472 }),
    ], "t1");
    expect(rows).toHaveLength(3);
    let overlaps = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!, b = rows[j]!;
        if (a.t0 < (b.t1 ?? Infinity) && b.t0 < (a.t1 ?? Infinity)) overlaps++;
      }
    }
    expect(overlaps).toBe(3); // all three pairs overlap
  });

  test("an unfinished span stays open so live and finished views match", () => {
    const rows = mergeSpans([ev({ spanId: "a", kind: "agent.start", at: 500 })], "t1");
    expect(rows[0]!.t1).toBeNull();
    expect(rows[0]!.status).toBe("running");
  });

  test("a lone end event still yields a real interval", () => {
    // Its start was lost to a restart; walk back over the duration.
    const rows = mergeSpans([ev({ spanId: "a", kind: "agent.end", at: 9000, durationMs: 4000 })], "t1");
    expect(rows[0]!.t0).toBe(5000);
    expect(rows[0]!.t1).toBe(9000);
  });

  test("never emits two rows for one span id", () => {
    const rows = mergeSpans([
      ev({ spanId: "a", kind: "agent.start", at: 1 }),
      ev({ spanId: "a", kind: "agent.end", at: 2, durationMs: 1 }),
      ev({ spanId: "b", kind: "tool.call", at: 3 }),
    ], "t1");
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("token and cost totals accumulate across a span's events", () => {
    const rows = mergeSpans([
      ev({ spanId: "a", kind: "llm.call", at: 1, tokensIn: 100, tokensOut: 20, costUsd: 0.001 }),
      ev({ spanId: "a", kind: "agent.end", at: 2, tokensIn: 5, tokensOut: 5, costUsd: 0.002 }),
    ], "t1");
    expect(rows[0]!.tokens_in).toBe(105);
    expect(rows[0]!.tokens_out).toBe(25);
    expect(Math.abs(rows[0]!.cost_usd - 0.003) < 1e-9).toBe(true);
  });
});

describe("open spans close when the task ends", () => {
  test("a finished task has no span left RUNNING", () => {
    // task.start and task.end are separate spans, so the opener never received
    // an end event: the root node reported RUNNING on a finished task and the
    // timeline stretched its window to "now" — hours wide, hundreds of lanes,
    // real bars invisible.
    const rows = mergeSpans([
      ev({ spanId: "root", kind: "task.start", at: 1000 }),
      ev({ spanId: "a", kind: "agent.start", at: 1100 }),
      ev({ spanId: "a", kind: "agent.end", at: 4000, durationMs: 2900 }),
      ev({ spanId: "fin", kind: "task.end", at: 5000 }),
    ], "t1");
    expect(rows.every((r) => r.status === "done")).toBe(true);
    expect(rows.every((r) => r.t1 !== null)).toBe(true);
    const root = rows.find((r) => r.kind === "task.start")!;
    expect(root.t1).toBe(5000);
    // Window is the real task duration, not "now minus start".
    const window = Math.max(...rows.map((r) => r.t1!)) - Math.min(...rows.map((r) => r.t0));
    expect(window).toBe(4000);
  });

  test("a LIVE task keeps its open spans open", () => {
    // No task.end yet — the running view must still show work in flight.
    const rows = mergeSpans([
      ev({ spanId: "root", kind: "task.start", at: 1000 }),
      ev({ spanId: "a", kind: "agent.start", at: 1100 }),
    ], "t1");
    expect(rows.every((r) => r.t1 === null)).toBe(true);
    expect(rows.every((r) => r.status === "running")).toBe(true);
  });
});
