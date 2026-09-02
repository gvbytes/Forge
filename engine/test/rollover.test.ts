// Task-identity resolution across ROLLOVER (RC1): a followup to a terminal task
// archives the old TaskRecord (pastTasks) and mints a new UUID in the SAME
// session. Every identity-addressed route must resolve BOTH the live task id
// AND archived pastTasks ids, and POST /message must report the post-rollover
// taskId so the web can follow the conversation instead of sticking to a dead
// UUID (the refresh-loses-task bug).
import "./_env.js";
import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "../src/index.js";
import { registerProject, projectIdFor } from "../src/sessions.js";
import type { Session, TaskRecord } from "../src/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollover-proj-"));
let sessionId = "";
const OLD_TASK = "roll-old-task";
const NEW_TASK = "roll-new-task";

function writeSession(s: Session): void {
  const dir = path.join(process.env.ENGINE_DATA!, "projects", s.projectId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
}

function mkTask(id: string, title: string, status: TaskRecord["status"]): TaskRecord {
  const now = Date.now();
  return {
    id, sessionId, title, status, goal: title,
    createdAt: now - 6000, updatedAt: now - 1000,
    tokensUsed: {}, costUsd: 0, stepCount: 0, stuckEvents: [], meta: {},
  };
}

beforeAll(() => {
  const pid = projectIdFor(root);
  registerProject(root);
  const now = Date.now();
  const s: Session = {
    id: "roll-session-1", projectId: pid, title: "rollover conv",
    messages: [], contextRefs: [], compactions: [],
    createdAt: now - 7000, updatedAt: now,
    pastTasks: [mkTask(OLD_TASK, "first goal", "done")],
    task: mkTask(NEW_TASK, "second goal", "done"),
  };
  sessionId = s.id;
  writeSession(s);
});

describe("identity resolution incl. archived pastTasks (RC1)", () => {
  test("GET /api/tasks/:id resolves an ARCHIVED pastTasks id", async () => {
    const res = await app.request(`/api/tasks/${OLD_TASK}`);
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.session.id).toBe(sessionId);
  });

  test("GET /api/tasks/:id resolves the CURRENT task id", async () => {
    const res = await app.request(`/api/tasks/${NEW_TASK}`);
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.task.id).toBe(NEW_TASK);
  });

  test("GET /api/tasks/:id of an unknown id → 404 (not silent ok)", async () => {
    const res = await app.request("/api/tasks/definitely-not-a-task");
    expect(res.status).toBe(404);
  });

  test("stop on an ARCHIVED task id → 404, not silent {ok:true}", async () => {
    const res = await app.request(`/api/tasks/${OLD_TASK}/stop`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("spans/proposals resolve an archived id without throwing", async () => {
    const sp = await app.request(`/api/tasks/${OLD_TASK}/spans`);
    expect(sp.status).toBe(200);
    const pr = await app.request(`/api/tasks/${OLD_TASK}/proposals`);
    expect(pr.status).toBe(200);
  });

  test("events for an ARCHIVED task id are attributed to THAT task, not the current one", async () => {
    // The store keys rows by session; the taskId fallback for a pastTasks
    // match must be the requested (archived) id, never session.task.id.
    const res = await app.request(`/api/tasks/${OLD_TASK}/events`);
    expect(res.status).toBe(200);
    const evs = (await res.json()) as any[];
    for (const e of evs) {
      expect(e.taskId).toBe(OLD_TASK);
    }
  });
});

describe("POST /api/tasks/:id/message reports the post-rollover taskId (RC1)", () => {
  test("history-path response carries the effective task id", async () => {
    // The session's current task is terminal → the engine archives it and a
    // followup mints a fresh task; the response MUST tell the web which id is
    // live now so the UI can follow the rollover.
    const res = await app.request(`/api/tasks/${NEW_TASK}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "followup probe" }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(typeof b.taskId).toBe("string");
    expect(b.taskId).not.toBe(NEW_TASK); // rolled over to a fresh task
    expect(typeof b.sessionId).toBe("string");
    expect(b.sessionId).toBe(sessionId);
  });
});
