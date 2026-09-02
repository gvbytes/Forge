// B7: approval gates. Default mode is "gate" (absent OR empty approvals field
// too), because PS 8b requires human approval before EVERY side-effecting tool
// call — writing/deleting a file included. "optimistic" is an opt-in that lets
// checkpointed file mutations through while still gating shell/git; "auto"
// never gates. Settings-driven, so we flip the persisted settings per case.
import "./_env.js";
import { describe, expect, test, afterAll } from "bun:test";
import { loadSettings, saveSettings } from "../src/config.js";
import { toolRequiresApproval } from "../src/tools.js";
import { readApprovalDecision } from "../src/index.js";

const original = loadSettings();
afterAll(() => {
  saveSettings(original);
});

describe("B7 approval gate modes", () => {
  test("default settings: gate mode is the default (PS 8b)", () => {
    const s = loadSettings();
    expect(s.approvals?.mode ?? "gate").toBe("gate");
  });

  test("PS 8b: out of the box, every side-effecting tool requires approval", () => {
    // The shipped default must satisfy the requirement with no configuration:
    // "Any command with a side effect … must always require human approval
    // before it runs." This is the regression guard for that promise.
    saveSettings(original);
    for (const tool of ["write_file", "edit_file", "run_command", "git_commit", "git_branch", "git_merge"]) {
      expect(toolRequiresApproval(tool)).toBe(true);
    }
  });

  test("gate mode: listed + side-effect tools require approval", () => {
    saveSettings({ ...original, approvals: { mode: "gate" } });
    // explicit requireApprovalFor entries
    expect(toolRequiresApproval("write_file")).toBe(true);
    expect(toolRequiresApproval("edit_file")).toBe(true);
    expect(toolRequiresApproval("run_command")).toBe(true);
    expect(toolRequiresApproval("git_commit")).toBe(true);
    // read-only tools never gate
    expect(toolRequiresApproval("read_file")).toBe(false);
    expect(toolRequiresApproval("list_dir")).toBe(false);
    expect(toolRequiresApproval("grep")).toBe(false);
  });

  test("gate mode: side-effect tool NOT in requireApprovalFor still gates", () => {
    saveSettings({ ...original, approvals: { mode: "gate" }, requireApprovalFor: ["write_file"] });
    // git_branch has sideEffect:true but is not in the (shrunk) list → still gates via spec
    expect(toolRequiresApproval("git_branch")).toBe(true);
    expect(toolRequiresApproval("write_file")).toBe(true);
    expect(toolRequiresApproval("read_file")).toBe(false);
  });

  test("auto mode: nothing gates, even side-effect tools", () => {
    saveSettings({ ...original, approvals: { mode: "auto" } });
    expect(toolRequiresApproval("write_file")).toBe(false);
    expect(toolRequiresApproval("edit_file")).toBe(false);
    expect(toolRequiresApproval("run_command")).toBe(false);
    expect(toolRequiresApproval("git_commit")).toBe(false);
    expect(toolRequiresApproval("read_file")).toBe(false);
  });

  test("absent approvals field falls back to the gate default (never fully-ungated)", () => {
    const { approvals: _dropped, ...rest } = original;
    saveSettings(rest as typeof original);
    // A missing field must land on the SAFE posture, never a permissive one.
    expect(toolRequiresApproval("write_file")).toBe(true);
    expect(toolRequiresApproval("run_command")).toBe(true);
  });

  test("empty approvals object {} also resolves to gate (consistent with absent)", () => {
    saveSettings({ ...original, approvals: {} as typeof original.approvals });
    expect(toolRequiresApproval("write_file")).toBe(true);
    expect(toolRequiresApproval("edit_file")).toBe(true);
    expect(toolRequiresApproval("run_command")).toBe(true);
  });
});

describe("optimistic approval mode (wave 26)", () => {
  test("optimistic: file mutations apply ungated (checkpointed, revertable)", () => {
    saveSettings({ ...original, approvals: { mode: "optimistic" } });
    expect(toolRequiresApproval("write_file")).toBe(false);
    expect(toolRequiresApproval("edit_file")).toBe(false);
  });

  test("optimistic: arbitrary-shell + git tools still gate", () => {
    saveSettings({ ...original, approvals: { mode: "optimistic" } });
    expect(toolRequiresApproval("run_command")).toBe(true);
    expect(toolRequiresApproval("git_commit")).toBe(true);
    expect(toolRequiresApproval("git_branch")).toBe(true);
  });

  test("optimistic: read-only tools never gate", () => {
    saveSettings({ ...original, approvals: { mode: "optimistic" } });
    expect(toolRequiresApproval("read_file")).toBe(false);
    expect(toolRequiresApproval("list_dir")).toBe(false);
    expect(toolRequiresApproval("grep")).toBe(false);
    expect(toolRequiresApproval("glob")).toBe(false);
  });

  test("optimistic: requireApprovalFor cannot re-gate file mutations", () => {
    saveSettings({ ...original, approvals: { mode: "optimistic" }, requireApprovalFor: ["write_file", "edit_file", "run_command"] });
    expect(toolRequiresApproval("write_file")).toBe(false);
    expect(toolRequiresApproval("edit_file")).toBe(false);
    expect(toolRequiresApproval("run_command")).toBe(true);
  });
});

// Endpoint contract: a silent deny on a malformed body is the worst failure a
// gate can have — the human approves, the agent is told no, and the step fails
// with nothing reporting why. This happened for real: PATCH accepted either
// key while POST /decision accepted only `approved`, so `{approve:true}` on
// the POST route was read as undefined → false → denied.
describe("approval decision body contract", () => {
  test("readApprovalDecision accepts both key spellings", () => {
    expect(readApprovalDecision({ approve: true })).toBe(true);
    expect(readApprovalDecision({ approved: true })).toBe(true);
    expect(readApprovalDecision({ approve: false })).toBe(false);
    expect(readApprovalDecision({ approved: false })).toBe(false);
  });

  test("a missing or non-boolean decision is rejected, never treated as deny", () => {
    expect(readApprovalDecision({})).toBeNull();
    expect(readApprovalDecision(undefined)).toBeNull();
    expect(readApprovalDecision({ approve: "yes" })).toBeNull();
    expect(readApprovalDecision({ approved: 1 })).toBeNull();
    expect(readApprovalDecision({ reason: "looks fine" })).toBeNull();
  });

  test("an explicit approve is never downgraded by an unrelated field", () => {
    expect(readApprovalDecision({ approve: true, reason: "ok" })).toBe(true);
  });
});
