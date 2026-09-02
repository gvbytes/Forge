// Regression suite for parseJsonLoose — the planner/reviewer JSON salvage.
// Free models ignore response_format and emit near-miss JSON. Two real-world
// corruptions captured from the flappy-bird task:
//   engine/large        -> '{"}steps":[…]}'  (stray brace corrupts opening key)
//   nemotron-3-ultra    -> '{"{"steps":[…]}' (false-start prefix before object)
// The parser must recover the plan object from both, plus fences/prose, and
// must never let a nested fragment shadow the outer object.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { parseJsonLoose, matchJsonObjectEnd, sanitizePlan, type PlanShape } from "../src/orchestrator.js";

const PLAN = { steps: [{ id: "s1", title: "T", detail: "D" }], complexity: "medium" };
const PLAN_JSON = JSON.stringify(PLAN);

describe("parseJsonLoose", () => {
  test("valid JSON parses directly", () => {
    expect(parseJsonLoose(PLAN_JSON)).toEqual(PLAN);
  });

  test("strips ```json fences", () => {
    expect(parseJsonLoose("```json\n" + PLAN_JSON + "\n```")).toEqual(PLAN);
  });

  test("extracts object surrounded by prose", () => {
    expect(parseJsonLoose("Here is the plan:\n" + PLAN_JSON + "\nLet me know.")).toEqual(PLAN);
  });

  test("recovers from stray-brace opening corruption ('{\"}steps\")", () => {
    const corrupt = '{"}steps":[{"id":"s1","title":"T","detail":"D"}],"complexity":"medium"}';
    expect(parseJsonLoose(corrupt)).toEqual(PLAN);
  });

  test("recovers from false-start prefix ('{\"{\"steps\")", () => {
    const corrupt = '{"{' + '"steps":[{"id":"s1","title":"T","detail":"D"}],"complexity":"medium"}';
    expect(parseJsonLoose(corrupt)).toEqual(PLAN);
  });

  test("outer object wins over a nested fragment", () => {
    const text = 'noise {"a":1,"inner":{"b":2}} tail';
    expect(parseJsonLoose(text)).toEqual({ a: 1, inner: { b: 2 } });
  });

  test("handles braces inside string values", () => {
    const text = '{"detail":"use { and } chars","ok":true}';
    expect(parseJsonLoose(text)).toEqual({ detail: "use { and } chars", ok: true });
  });

  test("returns null for pure prose with no object", () => {
    expect(parseJsonLoose("I will now produce a JSON object with steps.")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseJsonLoose("")).toBeNull();
  });
});

describe("matchJsonObjectEnd", () => {
  test("finds the closing brace of a simple object", () => {
    expect(matchJsonObjectEnd('{"a":1}', 0)).toBe(6);
  });
  test("ignores braces inside strings", () => {
    expect(matchJsonObjectEnd('{"a":"}{"}', 0)).toBe(9);
  });
  test("returns -1 when unbalanced", () => {
    expect(matchJsonObjectEnd('{"a":1', 0)).toBe(-1);
  });
});

describe("sanitizePlan — placeholder rejection", () => {
  test("rejects the schema example echoed from prompt (title/detail '...')", () => {
    const template = JSON.parse('{"steps":[{"id":"s1","title":"...","detail":"..."}],"complexity":"easy|medium|hard"}');
    expect(sanitizePlan(template)).toBeNull();
  });
  test("rejects angle-bracket / square-bracket placeholders", () => {
    expect(sanitizePlan({ steps: [{ title: "<title>", detail: "[detail]" }], complexity: "medium" })).toBeNull();
  });
  test("keeps real steps, drops placeholder ones", () => {
    const raw: PlanShape = {
      steps: [
        { title: "...", detail: "..." },
        { title: "Create index.html", detail: "Write the HTML entry point with a canvas." },
      ],
      complexity: "medium",
    };
    const out = sanitizePlan(raw);
    expect(out?.steps).toHaveLength(1);
    expect(out?.steps[0]?.title).toBe("Create index.html");
  });
  test("accepts a normal multi-step plan", () => {
    const raw: PlanShape = {
      steps: [
        { title: "Create index.html", detail: "HTML entry with canvas + three.js CDN." },
        { title: "Write game.js", detail: "Game loop, physics, collision, scoring." },
      ],
      complexity: "medium",
    };
    const out = sanitizePlan(raw);
    expect(out?.steps).toHaveLength(2);
    expect(out?.complexity).toBe("medium");
  });
});
