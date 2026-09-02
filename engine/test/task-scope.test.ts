// Folder-scoped task listing (RC2) + delegated-subtask hygiene (RC4) +
// followup-rollover taskId contract (RC1 server side), exercised through the
// real HTTP routes via app.request. Importing index.ts boots on an ephemeral
// port (see _env.ts) and uses a throwaway DATA_DIR.
import "./_env.js";
import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "../src/index.js";
import { registerProject, projectIdFor } from "../src/sessions.js";
import type { Session, TaskRecord } from "../src/types.js";

const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "scope-proj-A-"));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "scope-proj-B-"));

/** Build a session with a task directly on disk (no LLM involved). */
function seedTask(root: string, opts: { id: string; sessionId: string; title: string; status?: TaskRecord["status"]; delegated?: boolean }): void {
  const pid = projectIdFor(root);
  const dir = path.join(process.env.ENGINE_DATA!, "projects", pid, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const s: Session = {
    id: opts.sessionId,
    projectId: pid,
    title: opts.title,
    messages: [],
    contextRefs: [],
    compactions: [],
    createdAt: now - 5000,
    updatedAt: now,
    task: {
      id: opts.id, sessionId: opts.sessionId, title: opts.title,
      status: opts.status ?? "done", goal: opts.title,
      createdAt: now - 5000, updatedAt: now,
      tokensUsed: {}, costUsd: 0, stepCount: 1, stuckEvents: [],
      ...(opts.delegated ? { meta: { delegated: true, parentSessionId: "parent-1", role: "coder" } } : {}),
    },
  };
  fs.writeFileSync(path.join(dir, `${opts.sessionId}.json`), JSON.stringify(s));
}

beforeAll(() => {
  registerProject(rootA);
  registerProject(rootB);
  seedTask(rootA, { id: "task-a1", sessionId: "sess-a1", title: "alpha task" });
  seedTask(rootA, { id: "task-a2", sessionId: "sess-a2", title: "second in A", status: "stopped" });
  seedTask(rootB, { id: "task-b1", sessionId: "sess-b1", title: "bravo task" });
  // delegated subagent session in A — must NOT appear in the task list
  seedTask(rootA, { id: "task-sub", sessionId: "sess-sub", title: "subagent · delegated", delegated: true });
});

describe("folder-scoped GET /api/tasks (RC2)", () => {
  test("unscoped returns tasks across projects (legacy behavior)", async () => {
    const res = await app.request("/api/tasks");
    const rows = (await res.json()) as any[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("task-a1");
    expect(ids).toContain("task-b1");
  });

  test("?projectId= returns ONLY that project's tasks", async () => {
    const pidA = projectIdFor(rootA);
    const res = await app.request(`/api/tasks?projectId=${pidA}`);
    const rows = (await res.json()) as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.projectId).toBe(pidA);
      expect(r.projectRoot).toBe(rootA);
    }
    expect(rows.some((r) => r.id === "task-a1")).toBe(true);
    expect(rows.some((r) => r.id === "task-b1")).toBe(false);
  });

  test("unknown projectId → [] (never falls through to all)", async () => {
    const res = await app.request("/api/tasks?projectId=doesnotexist");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("delegated subtask sessions are hidden from the task list", async () => {
    const res = await app.request("/api/tasks");
    const rows = (await res.json()) as any[];
    expect(rows.some((r) => r.id === "task-sub")).toBe(false);
    expect(rows.some((r) => r.id === "task-a1")).toBe(true);
  });

  test("rows carry grouping fields (projectId, projectRoot, projectName)", async () => {
    const res = await app.request("/api/tasks");
    const rows = (await res.json()) as any[];
    const a1 = rows.find((r) => r.id === "task-a1");
    expect(a1.projectRoot).toBe(rootA);
    expect(typeof a1.projectName).toBe("string");
    expect(a1.projectName.length).toBeGreaterThan(0);
  });
});
