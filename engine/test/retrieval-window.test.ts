// Wave 25 retrieval efficiency: task-window rebuild suppression.
//
// Root cause (audit): ensureFresh() runs before EVERY step (orchestrator
// retrieveHits). The agent's own write_file/edit_file between steps change
// mtimes → the fingerprint drifts → a FULL repo re-read + re-chunk +
// MiniSearch rebuild ran before every subsequent step of a multi-step task.
//
// Fix: beginTaskWindow(pid) suppresses drift rebuilds while the task runs
// (the index is a hint layer — the coder reads real files via tools);
// endTaskWindow(pid) rebuilds ONCE if the fingerprint drifted during the
// window. A missing index still builds even inside the window.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIndex,
  ensureFresh,
  beginTaskWindow,
  endTaskWindow,
  _indexMetaForTest,
} from "../src/retrieval.js";

function mkProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-window-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const pid = (root: string) => `win-${path.basename(root)}`;

describe("task-window rebuild suppression (wave 25)", () => {
  test("drift inside a task window does NOT rebuild", async () => {
    const root = mkProject({ "a.ts": "export function a() { return 1; }" });
    const id = pid(root);
    await buildIndex(root, id);
    const before = _indexMetaForTest(id)!;
    expect(before.fileCount).toBe(1);

    beginTaskWindow(id);
    // The agent's own write — drifts the fingerprint (count + mtime).
    fs.writeFileSync(path.join(root, "b.ts"), "export function b() { return 2; }");
    await ensureFresh(root, id);

    const during = _indexMetaForTest(id)!;
    expect(during.fileCount).toBe(1); // NOT rebuilt — still 1 file
    await endTaskWindow(id);
  });

  test("endTaskWindow rebuilds once when the window drifted", async () => {
    const root = mkProject({ "a.ts": "export function a() { return 1; }" });
    const id = pid(root);
    await buildIndex(root, id);

    beginTaskWindow(id);
    fs.writeFileSync(path.join(root, "b.ts"), "export function b() { return 2; }");
    await ensureFresh(root, id);
    expect(_indexMetaForTest(id)!.fileCount).toBe(1); // suppressed

    await endTaskWindow(id);
    expect(_indexMetaForTest(id)!.fileCount).toBe(2); // rebuilt once at window end
  });

  test("endTaskWindow is a no-op when nothing drifted", async () => {
    const root = mkProject({ "a.ts": "export function a() { return 1; }" });
    const id = pid(root);
    await buildIndex(root, id);
    const before = _indexMetaForTest(id)!.indexedAt;

    beginTaskWindow(id);
    await endTaskWindow(id);
    expect(_indexMetaForTest(id)!.indexedAt).toBe(before); // untouched
  });

  test("a MISSING index still builds inside a window (first build needed)", async () => {
    const root = mkProject({ "a.ts": "export function a() { return 1; }" });
    const id = pid(root);
    beginTaskWindow(id);
    await ensureFresh(root, id); // no index yet → must build anyway
    expect(_indexMetaForTest(id)?.fileCount).toBe(1);
    await endTaskWindow(id);
  });

  test("outside a window, drift rebuilds immediately (pre-existing behavior)", async () => {
    const root = mkProject({ "a.ts": "export function a() { return 1; }" });
    const id = pid(root);
    await buildIndex(root, id);
    fs.writeFileSync(path.join(root, "b.ts"), "export function b() { return 2; }");
    await ensureFresh(root, id);
    expect(_indexMetaForTest(id)!.fileCount).toBe(2);
  });
});
