// Sibling-task context (RC3): the planner sees a COMPACT digest of other tasks
// in the SAME project folder (the user says they're interconnected), with hard
// caps so it can never bloat the context window. Also covers task.resultSummary
// persistence in finalize — the digest's outcome source.
import "./_env.js";
import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProject, projectIdFor } from "../src/sessions.js";
import { siblingDigest } from "../src/orchestrator.js";
import type { Session, TaskRecord } from "../src/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-proj-"));
let pid = "";

function writeSession(s: Session): void {
  const dir = path.join(process.env.ENGINE_DATA!, "projects", s.projectId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
}

function mkTask(id: string, title: string, opts: { status?: TaskRecord["status"]; summary?: string; goal?: string } = {}): TaskRecord {
  const now = Date.now();
  return {
    id, sessionId: "", title, status: opts.status ?? "done",
    goal: opts.goal ?? title,
    createdAt: now - 10_000, updatedAt: now,
    tokensUsed: {}, costUsd: 0, stepCount: 1, stuckEvents: [],
    ...(opts.summary ? { resultSummary: opts.summary } : {}),
  };
}

beforeAll(() => {
  pid = projectIdFor(root);
  registerProject(root);
  const now = Date.now();
  const self: Session = {
    id: "self-session", projectId: pid, title: "self", messages: [], contextRefs: [],
    compactions: [], createdAt: now, updatedAt: now,
    task: mkTask("self-task", "current task", { status: "running" }),
  };
  self.task!.sessionId = self.id;
  writeSession(self);

  const s1: Session = {
    id: "sib-1", projectId: pid, title: "sibling one", messages: [], contextRefs: [],
    compactions: [], createdAt: now - 9000, updatedAt: now - 1000,
    task: mkTask("sib-1-task", "add login handler", { summary: "Created auth/login.ts with session validation" }),
  };
  s1.task!.sessionId = s1.id;
  writeSession(s1);

  const s2: Session = {
    id: "sib-2", projectId: pid, title: "sibling two", messages: [], contextRefs: [],
    compactions: [], createdAt: now - 8000, updatedAt: now - 500,
    task: mkTask("sib-2-task", "fix login handler", { status: "failed", summary: "Edit failed — token mismatch in auth.ts" }),
  };
  s2.task!.sessionId = s2.id;
  writeSession(s2);

  // delegated subtask — must NOT appear in the digest
  const sub: Session = {
    id: "sub-1", projectId: pid, title: "subagent · delegated", messages: [], contextRefs: [],
    compactions: [], createdAt: now - 7000, updatedAt: now - 100,
    task: mkTask("sub-task", "subagent fanout noise", { status: "done" }),
  };
  sub.task!.sessionId = sub.id;
  sub.task!.meta = { delegated: true, parentSessionId: "self-session", role: "coder" };
  writeSession(sub);
});

describe("siblingDigest (RC3)", () => {
  test("lists sibling tasks in the same project, excluding self and delegated", () => {
    const self = { id: "self-session", projectId: pid } as Session;
    const d = siblingDigest(self);
    expect(d).toContain("add login handler");
    expect(d).toContain("fix login handler");
    expect(d).not.toContain("self-task");
    expect(d).not.toContain("current task");
    expect(d).not.toContain("subagent fanout noise");
  });

  test("carries each sibling's status and outcome summary", () => {
    const self = { id: "self-session", projectId: pid } as Session;
    const d = siblingDigest(self);
    expect(d).toContain("session validation");
    expect(d).toContain("token mismatch");
    expect(d.toLowerCase()).toContain("done");
    expect(d.toLowerCase()).toContain("failed");
  });

  test("hard caps: ≤5 rows, ≤1200 total chars", () => {
    // Seed 7 more sibling sessions to blow past the caps.
    for (let i = 0; i < 7; i++) {
      const s: Session = {
        id: `sib-extra-${i}`, projectId: pid, title: `extra ${i}`, messages: [], contextRefs: [],
        compactions: [], createdAt: Date.now() - 6000 + i, updatedAt: Date.now() - 50 + i,
        task: mkTask(`sib-extra-task-${i}`, `extra task ${i} with a very long title ${"x".repeat(200)}`, {
          summary: "y".repeat(500),
        }),
      };
      s.task!.sessionId = s.id;
      writeSession(s);
    }
    const self = { id: "self-session", projectId: pid } as Session;
    const d = siblingDigest(self);
    expect(d.length).toBeLessThanOrEqual(1200);
    // count digest rows (lines starting with "- [")
    const rows = d.split("\n").filter((l) => l.trim().startsWith("- ["));
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  test("empty project (no siblings) → empty string", () => {
    const lone = { id: "lone-session", projectId: "no-such-project" } as Session;
    expect(siblingDigest(lone)).toBe("");
  });
});
