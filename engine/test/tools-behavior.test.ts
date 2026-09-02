// Behavior regression tests for the three critical side-effect tools:
// write_file, edit_file, run_command. These lock the edge-case guarantees the
// engine relies on (nested-dir creation, workspace containment, safe edit
// failures, command timeout + bounded output). They call executeTool directly
// with autoApprove:true so the raw handler runs (no approval parking).
import "./_env.js";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { executeTool } from "../src/tools.js";

// ── temp workspace under the engine dir (inside the repo workspace) ──────
// test/ lives one level below the engine root; temp dirs stay in-workspace.
const ENGINE_ROOT = path.dirname(new URL(".", import.meta.url).pathname);
let base = "";
let rootDir = ""; // project root the tools are jailed to
let outsideDir = ""; // sibling dir that is OUTSIDE rootDir (escape target)

beforeAll(() => {
  base = fs.mkdtempSync(path.join(ENGINE_ROOT, "tmp-audit-"));
  rootDir = path.join(base, "root");
  outsideDir = path.join(base, "outside");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>) {
  return executeTool({
    sessionId: "audit-session",
    projectId: "audit-project",
    projectRoot: rootDir,
    name,
    args,
    autoApprove: true,
  });
}

const read = (p: string): string => fs.readFileSync(p, "utf8");
const exists = (p: string): boolean => fs.existsSync(p);

// ── 1. write_file creates missing parent dirs ────────────────────────────
describe("write_file — nested paths", () => {
  test("creates missing parent directories", async () => {
    const r = await call("write_file", { path: "a/b/c/file.txt", content: "hello" });
    expect(r.ok).toBe(true);
    const abs = path.join(rootDir, "a/b/c/file.txt");
    expect(exists(abs)).toBe(true);
    expect(read(abs)).toBe("hello");
  });

  test("deeply nested (6 levels) also works", async () => {
    const r = await call("write_file", { path: "x1/x2/x3/x4/x5/x6/deep.txt", content: "deep" });
    expect(r.ok).toBe(true);
    expect(read(path.join(rootDir, "x1/x2/x3/x4/x5/x6/deep.txt"))).toBe("deep");
  });
});

// ── 2. write_file / edit_file workspace containment ──────────────────────
describe("path containment — no escape past project root", () => {
  test("write_file rejects relative traversal ../../", async () => {
    const escaped = path.resolve(rootDir, "../../evil-rel.txt");
    const r = await call("write_file", { path: "../../evil-rel.txt", content: "x" });
    expect(r.ok).toBe(false);
    expect(r.result.toLowerCase()).toContain("outside workspace");
    expect(exists(escaped)).toBe(false);
  });

  test("write_file does not write an absolute path outside the root", async () => {
    const probe = "/tmp/audit-escape-probe-abs";
    const r = await call("write_file", { path: probe, content: "x" });
    // Whether rejected or re-rooted, NOTHING may land at the real absolute path.
    expect(exists(probe)).toBe(false);
    if (r.ok) {
      // re-rooted variant: file must live inside rootDir
      const rerooted = path.join(rootDir, "tmp/audit-escape-probe-abs");
      expect(exists(rerooted)).toBe(true);
    }
  });

  test("write_file rejects a symlink that points outside the root", async () => {
    fs.symlinkSync(outsideDir, path.join(rootDir, "link-out"));
    const r = await call("write_file", { path: "link-out/evil.txt", content: "x" });
    expect(r.ok).toBe(false);
    expect(exists(path.join(outsideDir, "evil.txt"))).toBe(false);
  });

  test("edit_file rejects relative traversal", async () => {
    fs.writeFileSync(path.join(outsideDir, "target.txt"), "orig");
    const r = await call("edit_file", {
      path: "../outside/target.txt",
      oldText: "orig",
      newText: "HACKED",
    });
    expect(r.ok).toBe(false);
    expect(read(path.join(outsideDir, "target.txt"))).toBe("orig");
  });
});

// ── 3. edit_file match-count safety ──────────────────────────────────────
describe("edit_file — match-count handling (no partial write)", () => {
  test("0 matches → clear error, file untouched", async () => {
    const f = path.join(rootDir, "zero.txt");
    fs.writeFileSync(f, "alpha beta");
    const r = await call("edit_file", { path: "zero.txt", oldText: "gamma", newText: "X" });
    expect(r.ok).toBe(false);
    expect(r.result.toLowerCase()).toContain("not found");
    expect(read(f)).toBe("alpha beta");
  });

  test(">1 match without replaceAll → clear error, NO partial write", async () => {
    const f = path.join(rootDir, "multi.txt");
    fs.writeFileSync(f, "foo bar foo");
    const r = await call("edit_file", { path: "multi.txt", oldText: "foo", newText: "X" });
    expect(r.ok).toBe(false);
    expect(/2 times|replaceAll/.test(r.result)).toBe(true);
    // The file must be byte-identical — proves nothing was partially written.
    expect(read(f)).toBe("foo bar foo");
  });

  test(">1 match WITH replaceAll → replaces all", async () => {
    const f = path.join(rootDir, "multi2.txt");
    fs.writeFileSync(f, "foo bar foo");
    const r = await call("edit_file", {
      path: "multi2.txt",
      oldText: "foo",
      newText: "X",
      replaceAll: true,
    });
    expect(r.ok).toBe(true);
    expect(read(f)).toBe("X bar X");
  });

  test("exactly 1 match → edits normally", async () => {
    const f = path.join(rootDir, "one.txt");
    fs.writeFileSync(f, "one two");
    const r = await call("edit_file", { path: "one.txt", oldText: "one", newText: "1" });
    expect(r.ok).toBe(true);
    expect(read(f)).toBe("1 two");
  });
});

// ── 4. run_command timeout kills a hung command ──────────────────────────
describe("run_command — timeout", () => {
  test("a hung command is killed, not run forever", async () => {
    const t0 = Date.now();
    const r = await call("run_command", { command: "sleep 30", timeoutMs: 1000 });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true); // returns a result describing the kill
    expect(r.result.toLowerCase()).toContain("timeout");
    // Must return shortly after the 1s timeout, not after 30s.
    expect(elapsed).toBeLessThan(8000);
  });

  test("timeoutMs:0 cannot disable the timeout (clamped to 1s floor)", async () => {
    const t0 = Date.now();
    const r = await call("run_command", { command: "sleep 30", timeoutMs: 0 });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(r.result.toLowerCase()).toContain("timeout");
    expect(elapsed).toBeLessThan(8000);
  });
});

// ── 5. run_command output is bounded ─────────────────────────────────────
describe("run_command — bounded output", () => {
  test("huge stdout is truncated, not unbounded", async () => {
    const r = await call("run_command", {
      command: "head -c 600000 /dev/zero | tr '\\0' 'A'",
      timeoutMs: 15000,
    });
    expect(r.ok).toBe(true);
    // OUT_CAP is 20_000; allow headroom for the framing/truncation suffix.
    expect(r.result.length).toBeLessThan(21000);
    expect(r.result.toLowerCase()).toContain("truncated");
  });
});
