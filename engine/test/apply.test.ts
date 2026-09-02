// B12 (accept-all must apply modified files), B27 (symlink escape in apply),
// and the parseUnifiedPatch trailing-empty-context-line fix.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyProposalPartial, buildFileDiff, parseUnifiedPatch } from "../src/apply.js";
import type { ChangeProposal, FileDiff } from "../src/types.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "engine-apply-test-"));
}
function proposal(files: FileDiff[]): ChangeProposal {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    taskId: "t1",
    files,
    rationale: "test proposal",
    createdAt: Date.now(),
    status: "pending",
  };
}
function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("B12 accept-all applies modified files", () => {
  const before = "line1\nline2\nline3\nline4\nline5\n";
  const after = "line1\nlineTWO\nline3\nline4\nline5\n";

  test("accept-all (no selection) splices the modified hunk", () => {
    const root = tmpRoot();
    const rel = "src/hello.ts";
    const abs = write(root, rel, before);
    const fd = buildFileDiff(rel, before, after);
    expect(fd.status).toBe("modified");
    const res = applyProposalPartial(proposal([fd]), root, undefined, false);
    expect(res.appliedCount).toBeGreaterThanOrEqual(1);
    expect(res.appliedFiles).toContain(rel);
    expect(fs.readFileSync(abs, "utf8")).toBe(after);
  });

  test("explicit hunk selection still applies the selected hunk", () => {
    const root = tmpRoot();
    const rel = "src/hello.ts";
    const abs = write(root, rel, before);
    const fd = buildFileDiff(rel, before, after);
    const res = applyProposalPartial(proposal([fd]), root, { [rel]: [0] }, false);
    expect(res.appliedCount).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(abs, "utf8")).toBe(after);
  });

  test("reject-all applies nothing to a modified file", () => {
    const root = tmpRoot();
    const rel = "src/hello.ts";
    const abs = write(root, rel, before);
    const fd = buildFileDiff(rel, before, after);
    const res = applyProposalPartial(proposal([fd]), root, undefined, true);
    expect(res.appliedCount).toBe(0);
    expect(fs.readFileSync(abs, "utf8")).toBe(before);
  });

  test("unrelated selection (no hunks chosen for this file) leaves it untouched", () => {
    const root = tmpRoot();
    const rel = "src/hello.ts";
    const abs = write(root, rel, before);
    const fd = buildFileDiff(rel, before, after);
    const res = applyProposalPartial(proposal([fd]), root, { "other/file.ts": [0] }, false);
    expect(res.appliedCount).toBe(0);
    expect(fs.readFileSync(abs, "utf8")).toBe(before);
  });
});

describe("B27 symlink escape in apply", () => {
  test("a path whose realpath leaves the workspace is skipped, target untouched", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "original\n");
    fs.symlinkSync(victim, path.join(root, "link.txt"));

    const fd = buildFileDiff("link.txt", "original\n", "hacked\n");
    const res = applyProposalPartial(proposal([fd]), root, undefined, false);
    expect(res.appliedCount).toBe(0);
    expect(res.skipped.some((s) => s.reason.includes("symlink"))).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("original\n");
  });

  test("lexical escape (../) is still rejected", () => {
    const root = tmpRoot();
    const fd = buildFileDiff("../escape.txt", "a\n", "b\n");
    const res = applyProposalPartial(proposal([fd]), root, undefined, false);
    expect(res.appliedCount).toBe(0);
    expect(res.skipped.some((s) => s.reason.includes("outside workspace"))).toBe(true);
  });

  test("a normal in-workspace symlink target chain inside root still applies", () => {
    const root = tmpRoot();
    write(root, "real/inner.txt", "alpha\n");
    fs.symlinkSync(path.join(root, "real/inner.txt"), path.join(root, "alias.txt"));
    const fd = buildFileDiff("alias.txt", "alpha\n", "beta\n");
    const res = applyProposalPartial(proposal([fd]), root, undefined, false);
    // realpath(alias.txt) = root/real/inner.txt — still inside root → allowed
    expect(res.skipped.filter((s) => s.reason.includes("symlink")).length).toBe(0);
    expect(fs.readFileSync(path.join(root, "real/inner.txt"), "utf8")).toBe("beta\n");
  });
});

describe("parseUnifiedPatch trailing-line handling", () => {
  test("terminating-newline split artifact is dropped", () => {
    const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    const fd = parseUnifiedPatch("f.txt", patch);
    expect(fd.hunks.length).toBe(1);
    // a, -b, +B, c → 4 lines; the trailing "" from split("\n") is gone
    expect(fd.hunks[0]!.lines.length).toBe(4);
  });

  test("real trailing empty context line survives when patch has no final newline", () => {
    // The last source line is empty: the diff carries it as a bare space (ctx
    // marker + empty text) and the patch text ends WITHOUT a newline.
    const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n ";
    const fd = parseUnifiedPatch("f.txt", patch);
    expect(fd.hunks.length).toBe(1);
    const lines = fd.hunks[0]!.lines;
    expect(lines.length).toBe(4);
    expect(lines[3]!.type).toBe("ctx");
    expect(lines[3]!.text).toBe("");
  });
});
