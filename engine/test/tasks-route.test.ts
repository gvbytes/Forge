// Wave 2B (B19): POST /api/tasks creates the TaskRecord SYNCHRONOUSLY and the
// response carries the real task UUID + sessionId. The response is returned
// BEFORE runTask resolves (runTask is fire-and-forget), so these assertions
// exercise the synchronous creation contract and do not depend on any LLM.
import "./_env.js";
import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "../src/index.js";
import { registerProject } from "../src/sessions.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-route-test-"));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(() => {
  registerProject(root);
});

async function postTask(body: unknown): Promise<Response> {
  return await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("B19 synchronous task creation", () => {
  test("response carries a real task UUID distinct from sessionId", async () => {
    const res = await postTask({ prompt: "wave2b synchronous creation probe", path: root });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; id: string; taskId: string; sessionId: string };
    expect(b.ok).toBe(true);
    expect(UUID_RE.test(b.taskId)).toBe(true);
    expect(UUID_RE.test(b.sessionId)).toBe(true);
    expect(b.id).toBe(b.taskId);
    // the whole point of B19: taskId is the TaskRecord UUID, NOT the session id
    expect(b.taskId === b.sessionId).toBe(false);
  });

  test("empty prompt → 400, no task created", async () => {
    const res = await postTask({ prompt: "   ", path: root });
    expect(res.status).toBe(400);
  });
});
