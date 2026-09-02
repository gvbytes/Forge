// NO-OP guard detection regression.
// computeDiffs diffs against the task-start snapshot (not consumed across
// steps), so on step 2+ `bundle.files.length===0` can never detect "this step
// wrote nothing" — the bundle always carries earlier steps' files. That let a
// coder that wrote NOTHING on a code step sail into review, which failed
// "file X missing from the diff" and burned a retry (observed live on
// physics.js / main.js / storage.js). madeWriteOrEdit detects a successful
// write_file/edit_file from the step's OWN outcomes (accumulation-proof).
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { madeWriteOrEdit, impliesCodeChange } from "../src/orchestrator.js";

const o = (name: string, ok = true): { key: string; ok: boolean } => ({ key: `${name}:deadbeef`, ok });

describe("madeWriteOrEdit (NO-OP guard detection)", () => {
  test("empty outcomes → false", () => {
    expect(madeWriteOrEdit([])).toBe(false);
  });
  test("read-only outcomes → false", () => {
    expect(madeWriteOrEdit([o("read_file"), o("list_dir"), o("run_command")])).toBe(false);
  });
  test("successful write_file → true", () => {
    expect(madeWriteOrEdit([o("read_file"), o("write_file")])).toBe(true);
  });
  test("successful edit_file → true", () => {
    expect(madeWriteOrEdit([o("edit_file")])).toBe(true);
  });
  test("REJECTED write_file (ok:false) → false", () => {
    expect(madeWriteOrEdit([o("write_file", false)])).toBe(false);
  });
  test("tool name must match at key start, not substring", () => {
    // a hypothetical tool "xwrite_file" must not count
    expect(madeWriteOrEdit([{ key: "xwrite_file:aa", ok: true }])).toBe(false);
  });
});

// impliesCodeChange must classify verification-led steps as NON-code, so the
// NO-OP guard does not nudge them to "write code" (they correctly never do and
// would burn the wall-clock cap — two live 480s verify-step timeouts).
const step = (title: string, detail = "") => ({ title, detail }) as unknown as Parameters<typeof impliesCodeChange>[0];

describe("impliesCodeChange (verify-led steps are not code steps)", () => {
  test("verify-led step naming files is NOT a code step", () => {
    expect(impliesCodeChange(step("Verify both files exist and syntax is correct", "Check index.html and calc.js are valid"))).toBe(false);
  });
  test("check/validate/ensure/test-led steps are NOT code steps", () => {
    expect(impliesCodeChange(step("Check the build works"))).toBe(false);
    expect(impliesCodeChange(step("Validate app.js loads", "open app.js"))).toBe(false);
    expect(impliesCodeChange(step("Ensure styles.css renders"))).toBe(false);
    expect(impliesCodeChange(step("Test the timer runs", "timer.js"))).toBe(false);
  });
  test("code-led steps remain code steps", () => {
    expect(impliesCodeChange(step("Create index.html with form"))).toBe(true);
    expect(impliesCodeChange(step("Implement physics engine", "physics.js"))).toBe(true);
  });
  test("code step that also verifies (leads with a code verb) stays code", () => {
    expect(impliesCodeChange(step("Wire main game loop and verify", "main.js"))).toBe(true);
  });
  test("negated code intent is not a code step", () => {
    expect(impliesCodeChange(step("Summarize results", "no files to create or modify"))).toBe(false);
  });
});
