import "./_env.ts";
import { test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordCheckpointFile,
  getCheckpoint,
  listCheckpoints,
  revertCheckpoint,
} from "../src/checkpoints.js";
import { DATA_DIR } from "../src/config.js";

// Fresh throwaway project root per test (separate from DATA_DIR).
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-proj-"));
  // Reset the checkpoint store between tests (tests reuse taskId/projectId).
  try { fs.rmSync(path.join(DATA_DIR, "projects"), { recursive: true, force: true }); } catch {}
});

const PID = "proj-a";

test("recordCheckpointFile creates a checkpoint and stores pre-state", () => {
  const cp = recordCheckpointFile({
    projectId: PID, taskId: "t1", sessionId: "s1", root, label: "task one",
    rel: "a.txt", preContent: "original",
  });
  expect(cp.taskId).toBe("t1");
  expect(cp.files["a.txt"]).toBe("original");
  const got = getCheckpoint(PID, "t1");
  expect(got?.files["a.txt"]).toBe("original");
  expect(got?.root).toBe(root);
});

test("first-capture-wins: re-recording the same file keeps the original pre-state", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a.txt", preContent: "v1" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a.txt", preContent: "v2" });
  expect(getCheckpoint(PID, "t1")?.files["a.txt"]).toBe("v1");
});

test("null preContent marks the file as created-by-task", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "new.txt", preContent: null });
  const got = getCheckpoint(PID, "t1");
  expect(got?.files["new.txt"]).toBeNull();
  expect("new.txt" in (got?.files ?? {})).toBe(true);
});

test("revertCheckpoint restores modified files and deletes created files", () => {
  // Pre-state: a.txt existed with "original"; created.txt did NOT exist.
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a.txt", preContent: "original" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "created.txt", preContent: null });
  // Simulate the task's changes on disk.
  fs.writeFileSync(path.join(root, "a.txt"), "CHANGED by task");
  fs.writeFileSync(path.join(root, "created.txt"), "new file content");

  const res = revertCheckpoint(PID, "t1");
  expect(res).toBeDefined();
  expect(res!.restored).toContain("a.txt");
  expect(res!.removed).toContain("created.txt");
  expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
  expect(fs.existsSync(path.join(root, "created.txt"))).toBe(false);
  expect(getCheckpoint(PID, "t1")?.reverted).toBe(true);
});

test("revertCheckpoint restores a file the task deleted", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "gone.txt", preContent: "precious" });
  // Task deleted the file (it no longer exists on disk).
  const res = revertCheckpoint(PID, "t1");
  expect(res!.restored).toContain("gone.txt");
  expect(fs.readFileSync(path.join(root, "gone.txt"), "utf8")).toBe("precious");
});

test("revertCheckpoint returns undefined for an unknown checkpoint", () => {
  expect(revertCheckpoint(PID, "nope")).toBeUndefined();
});

test("revertCheckpoint refuses to escape the project root", () => {
  // Escaping rels are rejected at capture time (never stored), so there is
  // nothing to revert — and nothing is ever written outside the root.
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "../../evil.txt", preContent: "bad" });
  const cp = getCheckpoint(PID, "t1");
  expect(Object.keys(cp?.files ?? {})).not.toContain("../../evil.txt");
  const res = revertCheckpoint(PID, "t1");
  expect(res === undefined || !res.restored.includes("../../evil.txt")).toBe(true);
  expect(fs.existsSync(path.resolve(root, "../../evil.txt"))).toBe(false);
});

test("listCheckpoints returns project checkpoints newest-first", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "one", rel: "a.txt", preContent: "x" });
  recordCheckpointFile({ projectId: PID, taskId: "t2", sessionId: "s2", root, label: "two", rel: "b.txt", preContent: "y" });
  const list = listCheckpoints(PID);
  expect(list.length).toBe(2);
  expect(list.map((c) => c.taskId).sort()).toEqual(["t1", "t2"]);
  for (let i = 0; i + 1 < list.length; i++) {
    expect(list[i]!.updatedAt).toBeGreaterThanOrEqual(list[i + 1]!.updatedAt);
  }
});

test("checkpoints are isolated per project", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a.txt", preContent: "x" });
  recordCheckpointFile({ projectId: "proj-b", taskId: "t1", sessionId: "s9", root, label: "y", rel: "b.txt", preContent: "y" });
  expect(listCheckpoints(PID).length).toBe(1);
  expect(listCheckpoints("proj-b").length).toBe(1);
  expect(getCheckpoint(PID, "t1")?.files["a.txt"]).toBe("x");
});

test("recordCheckpointFile normalizes rel so ./a.txt and a.txt share one pre-state", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a.txt", preContent: "v1" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "./a.txt", preContent: "v2" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "sub/../a.txt", preContent: "v3" });
  const cp = getCheckpoint(PID, "t1");
  expect(cp?.files["a.txt"]).toBe("v1"); // first-capture-wins survives normalization
  expect(Object.keys(cp?.files ?? {})).toEqual(["a.txt"]); // no ./a.txt or sub/../a.txt keys
});

test("recordCheckpointFile never stores escaping or absolute rel paths", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "../evil.txt", preContent: "bad" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "/etc/passwd", preContent: "bad" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "a/../../evil.txt", preContent: "bad" });
  const cp = getCheckpoint(PID, "t1");
  const keys = Object.keys(cp?.files ?? {});
  expect(keys.length).toBe(0);
});

test("revert skips a symlink whose target escapes the project root", () => {
  // A real file OUTSIDE root, and a symlink inside root pointing at it. Revert
  // must not follow the symlink and clobber the outside file.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "link.txt", preContent: "attacker" });
  const res = revertCheckpoint(PID, "t1");
  expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");
  expect(res!.restored).not.toContain("link.txt");
  expect(res!.skipped).toContain("link.txt");
});

test("normalizeRel accepts legit dotfile names (only '..' SEGMENTS are escaping)", () => {
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "..hidden.txt", preContent: "a" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: ".env", preContent: "b" });
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "src/..data/cfg", preContent: "c" });
  const cp = getCheckpoint(PID, "t1");
  expect(cp?.files["..hidden.txt"]).toBe("a");
  expect(cp?.files[".env"]).toBe("b");
  expect(cp?.files[path.normalize("src/..data/cfg")]).toBe("c");
});

test("revert skips a path routed through a symlinked ANCESTOR dir escaping root", () => {
  // root/linkdir -> outsideDir (a symlinked DIRECTORY). The captured rel goes
  // through it into a subdir that doesn't exist yet. Revert must not mkdir/write
  // outside the root via the symlinked ancestor.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-outdir-"));
  fs.symlinkSync(outsideDir, path.join(root, "linkdir"));
  recordCheckpointFile({ projectId: PID, taskId: "t1", sessionId: "s1", root, label: "x", rel: "linkdir/sub/file.txt", preContent: "attacker" });
  const res = revertCheckpoint(PID, "t1");
  expect(fs.existsSync(path.join(outsideDir, "sub", "file.txt"))).toBe(false);
  expect(res!.restored).not.toContain("linkdir/sub/file.txt");
  expect(res!.skipped).toContain("linkdir/sub/file.txt");
});
