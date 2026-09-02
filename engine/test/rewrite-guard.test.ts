// Large-codebase guard: write_file must not be used to make a small edit to a
// big file. Reproducing untouched code from memory is both the most expensive
// and the most destructive thing the agent can do — anything it fails to echo
// back is silently deleted, and a whole-file diff hides that from review.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { retainedLineFraction, rewriteGuardVerdict } from "../src/tools.js";
import { taskBranchName, clampParallelForTest } from "../src/orchestrator.js";

const bigFile = (n: number, marker = "") =>
  Array.from({ length: n }, (_, i) => `line_${i}();${marker}`).join("\n");

describe("retainedLineFraction", () => {
  test("identical content retains everything", () => {
    expect(retainedLineFraction("a\nb\nc", "a\nb\nc")).toBe(1);
  });
  test("disjoint content retains nothing", () => {
    expect(retainedLineFraction("a\nb\nc", "x\ny\nz")).toBe(0);
  });
  test("ignores blank lines and surrounding whitespace", () => {
    expect(retainedLineFraction("a\n\n  b  \n", "  a  \nb")).toBe(1);
  });
  test("a duplicated line only counts as often as it survives", () => {
    // "a" appears twice in before, once in after → 1 of 2 retained.
    expect(retainedLineFraction("a\na", "a")).toBe(0.5);
  });
  test("empty before is not a division by zero", () => {
    expect(retainedLineFraction("", "anything")).toBe(0);
  });
});

describe("rewriteGuardVerdict", () => {
  test("allows creating a new file", () => {
    expect(rewriteGuardVerdict(null, bigFile(500))).toBeNull();
  });

  test("allows a full rewrite of a small file", () => {
    const before = bigFile(20);
    expect(rewriteGuardVerdict(before, before + "\nextra();")).toBeNull();
  });

  test("REFUSES a 3-line change delivered as a whole-file rewrite", () => {
    const before = bigFile(400);
    const after = `${before}\nmultiply();\ndivide();\nmodulo();`;
    const verdict = rewriteGuardVerdict(before, after);
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("edit_file");
    expect(verdict).toContain("100%"); // every original line unchanged
  });

  test("allows a genuine rewrite that shares little with the original", () => {
    expect(rewriteGuardVerdict(bigFile(400, "//old"), bigFile(400, "//new"))).toBeNull();
  });

  test("the refusal tells the model what it costs and what to do instead", () => {
    const before = bigFile(300);
    const verdict = rewriteGuardVerdict(before, `${before}\nnew_thing();`)!;
    expect(verdict.includes("tokens")).toBe(true);
    expect(verdict.includes("oldText/newText")).toBe(true);
  });
});

describe("taskBranchName", () => {
  test("derives a stable branch from the task id, never from model output", () => {
    // Prompt-injection safety: the branch name can only ever contain the id's
    // own characters, so no model output can smuggle git arguments into it.
    const name = taskBranchName("4df4e875-db43-4ccb-b2a7-4cb36c27db06");
    expect(name).toBe("agentzero/task-4df4e875");
    expect(/^agentzero\/task-[0-9a-f-]{1,8}$/.test(name)).toBe(true);
  });
  test("is deterministic for the same task", () => {
    expect(taskBranchName("abc12345-x")).toBe(taskBranchName("abc12345-x"));
  });
});

describe("maxParallelSteps — the setting must actually do something", () => {
  test("clamps into a safe band and defaults sensibly", () => {
    // The UI exposed budgets.max_parallel_subagents and the scheduler ignored
    // it — the control was decorative. These lock the contract.
    expect(clampParallelForTest(3)).toBe(3);
    expect(clampParallelForTest(1)).toBe(1);
    expect(clampParallelForTest(99)).toBe(4);   // conflicting edits cost more than wall clock
    expect(clampParallelForTest(0)).toBe(1);    // never zero: that deadlocks the scheduler
    expect(clampParallelForTest(-5)).toBe(1);
    expect(clampParallelForTest(NaN)).toBe(2);  // non-finite → default
    expect(clampParallelForTest(undefined)).toBe(2);
  });
});
