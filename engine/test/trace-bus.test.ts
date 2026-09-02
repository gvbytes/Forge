// Fresh-eyes edge-case audit locks for src/bus.ts and src/trace.ts.
// Covers: (1) bus unsubscribe actually stops delivery / no leak / no
// double-delivery; (2) bus emit with zero subscribers and with a throwing
// listener; (3) trace span double-end / end-without-start; (4) trace emit
// with missing parentId / undefined optional metadata.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { trace } from "../src/trace.js";
import { wire } from "../src/bus.js";
import type { TraceEvent, WireEvent } from "../src/types.js";

const status = (sessionId: string): WireEvent => ({ type: "status", sessionId, status: "ok" });

function base(sessionId: string, over: Partial<Omit<TraceEvent, "id" | "at">> = {}): Omit<TraceEvent, "id" | "at"> {
  return { sessionId, spanId: "span-1", kind: "agent.thought", label: "x", ...over };
}

// ── bus.ts ─────────────────────────────────────────────────────────────────

describe("bus: subscribe/unsubscribe (edge case 1)", () => {
  test("unsubscribe stops delivery", () => {
    let n = 0;
    const off = wire.subscribe(() => n++);
    wire.emit(status("b1"));
    off();
    wire.emit(status("b1"));
    expect(n).toBe(1);
  });

  test("double unsubscribe is a safe no-op (no throw, no re-arm)", () => {
    let n = 0;
    const off = wire.subscribe(() => n++);
    off();
    expect(() => off()).not.toThrow();
    wire.emit(status("b1"));
    expect(n).toBe(0);
  });

  test("same fn subscribed twice = two independent subscriptions, no cross-talk", () => {
    let n = 0;
    const fn = () => n++;
    const off1 = wire.subscribe(fn);
    const off2 = wire.subscribe(fn);
    wire.emit(status("b1"));
    expect(n).toBe(2); // two live subscriptions → two deliveries
    off1();
    wire.emit(status("b1"));
    expect(n).toBe(3); // off2 must still deliver
    off2();
    wire.emit(status("b1"));
    expect(n).toBe(3); // nothing live anymore
  });

  test("self-unsubscribing listener runs exactly once", () => {
    let n = 0;
    let off: () => void = () => {};
    off = wire.subscribe(() => {
      n++;
      off();
    });
    wire.emit(status("b1"));
    wire.emit(status("b1"));
    expect(n).toBe(1);
  });
});

describe("bus: emit robustness (edge case 2)", () => {
  test("emit with zero subscribers does not throw, still stores", () => {
    const stored = wire.emit(status("nobody"));
    expect(stored.seq).toBeGreaterThan(0);
    expect(stored.ts).toBeGreaterThan(0);
    expect(stored.sessionId).toBe("nobody");
    expect(stored.event.type).toBe("status");
  });

  test("a throwing listener does not break delivery to later listeners", () => {
    const seen: string[] = [];
    const offBad = wire.subscribe(() => {
      throw new Error("boom");
    });
    const offGood = wire.subscribe((_e, s) => seen.push(s.sessionId ?? ""));
    expect(() => wire.emit(status("b2"))).not.toThrow();
    offBad();
    offGood();
    expect(seen).toEqual(["b2"]);
  });

  test("filterId subscriber only receives matching events", () => {
    const seen: string[] = [];
    const off = wire.subscribe((_e, s) => seen.push(s.sessionId ?? ""), "task-A");
    wire.emit(status("task-A"));
    wire.emit(status("task-B"));
    off();
    expect(seen).toEqual(["task-A"]);
  });

  test("getEventsSince returns ring entries after seq, filtered by target", () => {
    const s1 = wire.emit(status("ring-s"));
    wire.emit(status("other-s"));
    const got = wire.getEventsSince("ring-s", s1.seq - 1);
    expect(got.length).toBe(1);
    expect(got[0]!.seq).toBe(s1.seq);
  });
});

// ── trace.ts ───────────────────────────────────────────────────────────────

describe("trace: span end edge cases (edge case 3)", () => {
  test("double-end of same span records both events in order, no corruption/dedup", () => {
    const sid = "tb-double-end";
    const e1 = trace.emit(base(sid, { kind: "agent.end", label: "end#1" }));
    const e2 = trace.emit(base(sid, { kind: "agent.end", label: "end#2" }));
    const ring = trace.recent(sid);
    expect(ring.length).toBe(2);
    expect(ring[0]!.id).toBeLessThan(ring[1]!.id);
    expect(e1.label).toBe("end#1");
    expect(e2.label).toBe("end#2");
  });

  test("end without start (unknown spanId, no parent) is recorded, does not crash", () => {
    const sid = "tb-orphan-end";
    const e = trace.emit(base(sid, { kind: "agent.end", spanId: "never-started" }));
    expect(trace.recent(sid).length).toBe(1);
    expect(e.spanId).toBe("never-started");
  });
});

describe("trace: missing/undefined parent & metadata (edge case 4)", () => {
  test("emit without parentId or optional metadata yields a well-formed event", () => {
    const sid = "tb-noparent";
    const e = trace.emit({ sessionId: sid, spanId: "s", kind: "plan", label: "no parent" });
    expect(e.id).toBeGreaterThan(0);
    expect(e.at).toBeGreaterThan(0);
    expect(e.sessionId).toBe(sid);
    expect(e.parentId).toBeUndefined();
    // survives the JSON round-trip used by persistence and SSE without
    // emitting malformed output
    const round = JSON.parse(JSON.stringify(e));
    expect(round.sessionId).toBe(sid);
    expect(round.id).toBe(e.id);
    expect("parentId" in round).toBe(false);
  });

  test("undefined input/output do not crash emit or listeners", () => {
    const sid = "tb-undef-meta";
    let seen = 0;
    const off = trace.subscribe(() => seen++);
    const e = trace.emit(base(sid, { input: undefined, output: undefined }));
    off();
    expect(seen).toBe(1);
    expect(JSON.parse(JSON.stringify(e)).id).toBe(e.id);
  });
});

describe("trace: delivery robustness", () => {
  test("ids are strictly monotonic across consecutive emits", () => {
    const sid = "tb-mono";
    const a = trace.emit(base(sid));
    const b = trace.emit(base(sid));
    const c = trace.emit(base(sid));
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
  });

  test("a throwing trace listener does not break other listeners or emit", () => {
    const sid = "tb-throw";
    const seen: number[] = [];
    const offBad = trace.subscribe(() => {
      throw new Error("boom");
    });
    const offGood = trace.subscribe((e) => seen.push(e.id));
    const e = trace.emit(base(sid));
    offBad();
    offGood();
    expect(seen).toEqual([e.id]);
  });

  test("trace unsubscribe stops delivery", () => {
    const sid = "tb-unsub";
    let n = 0;
    const off = trace.subscribe(() => n++);
    trace.emit(base(sid));
    off();
    trace.emit(base(sid));
    expect(n).toBe(1);
  });
});
