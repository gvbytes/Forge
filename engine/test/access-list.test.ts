// Information topology, separate from execution order — the Conductor workflow
// primitive from the Sakana Fugu report ({subtask, worker, access_list}).
//
// dependsOn answers "when may this run?"; accessList answers "what should it
// SEE?". Conflating them meant every step got the last FOUR completed summaries
// BY RECENCY, so a step depending only on s2 was shown s5–s8 and not s2 — the
// one result it needed was the one it was denied.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { resolveStepContext, sanitizePlan } from "../src/orchestrator.js";
import type { PlanStep } from "../src/types.js";

const done = (id: string, summary = `result of ${id}`): PlanStep =>
  ({ id, title: id, detail: "", status: "done", attempts: 1, resultSummary: summary });
const pending = (id: string): PlanStep =>
  ({ id, title: id, detail: "", status: "pending", attempts: 0 });

describe("resolveStepContext — precedence", () => {
  const plan = [done("s1"), done("s2"), done("s3"), done("s4"), done("s5"), done("s6")];

  test("an explicit accessList wins over recency", () => {
    const step: PlanStep = { ...pending("s7"), accessList: ["s1", "s2"] };
    expect(resolveStepContext([...plan, step], step).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  test("THE BUG: without accessList, an old dependency was dropped for recent noise", () => {
    // s7 depends only on s2. Recency would hand it s3–s6 and omit s2 entirely.
    const step: PlanStep = { ...pending("s7"), dependsOn: ["s2"] };
    const got = resolveStepContext([...plan, step], step).map((s) => s.id);
    expect(got).toEqual(["s2"]);
    expect(got).not.toContain("s6");
  });

  test("the dependency closure is transitive", () => {
    // s3 needs s2, s2 needed s1 — s1's facts are still load-bearing for s3.
    const p = [done("s1"), { ...done("s2"), dependsOn: ["s1"] }];
    const step: PlanStep = { ...pending("s3"), dependsOn: ["s2"] };
    expect(resolveStepContext([...p, step], step).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  test("closure results come back in plan order, not discovery order", () => {
    const p = [done("s1"), done("s2"), { ...done("s3"), dependsOn: ["s1", "s2"] }];
    const step: PlanStep = { ...pending("s4"), dependsOn: ["s3"] };
    expect(resolveStepContext([...p, step], step).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  test("falls back to recency when nothing is declared", () => {
    const step = pending("s7");
    expect(resolveStepContext([...plan, step], step).map((s) => s.id)).toEqual(["s3", "s4", "s5", "s6"]);
  });

  test("an accessList naming only FAILED steps falls through, not to empty", () => {
    // Being told to read s1 and getting nothing is worse than the old floor.
    const p = [{ ...pending("s1"), status: "failed" as const }, done("s2"), done("s3")];
    const step: PlanStep = { ...pending("s4"), accessList: ["s1"] };
    expect(resolveStepContext([...p, step], step).map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  test("never includes steps that have not produced a result", () => {
    const p = [done("s1"), pending("s2")];
    const step: PlanStep = { ...pending("s3"), accessList: ["s1", "s2"] };
    expect(resolveStepContext([...p, step], step).map((s) => s.id)).toEqual(["s1"]);
  });

  test("a self-referential dependency cannot loop", () => {
    const step: PlanStep = { ...pending("s1"), dependsOn: ["s1"] };
    expect(() => resolveStepContext([step], step)).not.toThrow();
  });
});

describe("sanitizePlan — accessList validation", () => {
  test("keeps a valid backward reference", () => {
    const out = sanitizePlan({
      steps: [
        { id: "s1", title: "a", detail: "d" },
        { id: "s2", title: "b", detail: "d", dependsOn: ["s1"], accessList: ["s1"] },
      ],
      complexity: "medium",
    })!;
    expect(out.steps[1]!.accessList).toEqual(["s1"]);
  });

  test("drops a hallucinated step id", () => {
    const out = sanitizePlan({
      steps: [{ id: "s1", title: "a", detail: "d", accessList: ["s99"] }],
      complexity: "easy",
    })!;
    expect(out.steps[0]!.accessList).toBeUndefined();
  });

  test("drops a self-reference", () => {
    const out = sanitizePlan({
      steps: [{ id: "s1", title: "a", detail: "d", accessList: ["s1"] }],
      complexity: "easy",
    })!;
    expect(out.steps[0]!.accessList).toBeUndefined();
  });

  test("drops a FORWARD reference — you cannot read output that has not run", () => {
    const out = sanitizePlan({
      steps: [
        { id: "s1", title: "a", detail: "d", accessList: ["s2"] },
        { id: "s2", title: "b", detail: "d", dependsOn: ["s1"] },
      ],
      complexity: "medium",
    })!;
    expect(out.steps.find((s) => s.id === "s1")!.accessList).toBeUndefined();
  });

  test("a plan with no accessList still sanitizes cleanly", () => {
    const out = sanitizePlan({ steps: [{ id: "s1", title: "a", detail: "d" }], complexity: "easy" })!;
    expect(out.steps[0]!.accessList).toBeUndefined();
    expect(out.steps[0]!.id).toBe("s1");
  });
});
