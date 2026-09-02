// Atomic saveSession (temp+fsync+rename, no truncated JSON, no temp litter)
// and B11 boot reconciliation (crashed running task → stopped + bootInterrupted
// when a runState anchor exists).
import "./_env.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import {
  getSession,
  newSession,
  projectIdFor,
  reconcileBootSessions,
  registerProject,
  saveSession,
} from "../src/sessions.js";
import type { Session } from "../src/types.js";

describe("atomic saveSession", () => {
  test("persists valid JSON and leaves no temp files behind", () => {
    const s = newSession("proj-atomic", "atomic test");
    const dir = path.join(DATA_DIR, "projects", "proj-atomic", "sessions");
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp")).length).toBe(0);
    expect(files).toContain(`${s.id}.json`);
    // The file must parse and round-trip.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${s.id}.json`), "utf8")) as Session;
    expect(raw.id).toBe(s.id);
    expect(raw.title).toBe("atomic test");
    const loaded = getSession("proj-atomic", s.id);
    expect(loaded?.id).toBe(s.id);
  });

  test("re-saving updates content atomically (no partial writes observable)", () => {
    const s = newSession("proj-atomic2", "v1");
    s.title = "v2 with a much longer title to change the byte size significantly";
    saveSession(s);
    const loaded = getSession("proj-atomic2", s.id);
    expect(loaded?.title).toBe(s.title);
    const dir = path.join(DATA_DIR, "projects", "proj-atomic2", "sessions");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length).toBe(0);
  });
});

describe("B11 reconcileBootSessions", () => {
  function makeRunningSession(projPath: string, withRunState: boolean): Session {
    const info = registerProject(projPath);
    const s = newSession(info.id, "crash test");
    const now = Date.now();
    s.task = {
      id: `task-${Math.random().toString(36).slice(2)}`,
      sessionId: s.id,
      title: "was running",
      status: "running",
      goal: "do the thing",
      createdAt: now,
      updatedAt: now,
      tokensUsed: {},
      costUsd: 0,
      stepCount: 1,
      stuckEvents: [],
      meta: withRunState
        ? {
            runState: {
              taskId: "t", projectId: s.projectId, phase: "step",
              stepIndex: 0, attempts: 1, partialMessages: [], savedAt: now,
            },
          }
        : {},
    };
    return saveSession(s);
  }

  test("crashed running task WITH runState → stopped + bootInterrupted", () => {
    const s = makeRunningSession(`/tmp/engine-test-root-${Date.now()}-a`, true);
    reconcileBootSessions();
    const loaded = getSession(s.projectId, s.id);
    expect(loaded?.task?.status).toBe("stopped");
    expect(loaded?.task?.meta?.bootInterrupted).toBe(true);
    // runState anchor must survive reconciliation so /resume can use it.
    expect(loaded?.task?.meta?.runState).toBeTruthy();
  });

  test("crashed running task WITHOUT runState → stopped, not bootInterrupted", () => {
    const s = makeRunningSession(`/tmp/engine-test-root-${Date.now()}-b`, false);
    reconcileBootSessions();
    const loaded = getSession(s.projectId, s.id);
    expect(loaded?.task?.status).toBe("stopped");
    expect(loaded?.task?.meta?.bootInterrupted).toBeFalsy();
  });

  test("crashed planning task is also reconciled", () => {
    const s = makeRunningSession(`/tmp/engine-test-root-${Date.now()}-c`, true);
    s.task!.status = "planning";
    saveSession(s);
    reconcileBootSessions();
    const loaded = getSession(s.projectId, s.id);
    expect(loaded?.task?.status).toBe("stopped");
    expect(loaded?.task?.meta?.bootInterrupted).toBe(true);
  });

  test("waiting-approval task is reconciled too (its gate's waiter died with the old process)", () => {
    const s = makeRunningSession(`/tmp/engine-test-root-${Date.now()}-c2`, true);
    s.task!.status = "waiting-approval";
    saveSession(s);
    reconcileBootSessions();
    const loaded = getSession(s.projectId, s.id);
    expect(loaded?.task?.status).toBe("stopped");
    expect(loaded?.task?.meta?.bootInterrupted).toBe(true);
  });

  test("done/failed tasks are left alone", () => {
    const s = makeRunningSession(`/tmp/engine-test-root-${Date.now()}-d`, true);
    s.task!.status = "done";
    saveSession(s);
    reconcileBootSessions();
    const loaded = getSession(s.projectId, s.id);
    expect(loaded?.task?.status).toBe("done");
    expect(loaded?.task?.meta?.bootInterrupted).toBeFalsy();
  });

  test("projectIdFor is stable for registerProject roots", () => {
    const p = `/tmp/engine-test-root-${Date.now()}-e`;
    expect(registerProject(p).id).toBe(projectIdFor(p));
  });
});
