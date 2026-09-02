// Boot-reloaded pending approvals are ZOMBIES for dead tasks (user bug: "asks
// for permission that was pending before, right after running the server").
// The waiting tool call lived in the previous process — after restart nothing
// can satisfy the gate, so every reloaded pending whose session is not live
// must force-deny at boot instead of resurfacing as a prompt. Also: the
// pending list must be project-scopable.
import "./_env.js";
import { describe, expect, test, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { listAllPending, getApproval } from "../src/approvals.js";
import type { ApprovalRequest } from "../src/types.js";
import { registerProject, projectIdFor, newSession, saveSession } from "../src/sessions.js";

const rootA = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "appr-proj-A-"));
const rootB = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "appr-proj-B-"));

function writePendingApproval(projectRoot: string, sessionId: string, id: string, ageMs: number): void {
  const pid = projectIdFor(projectRoot);
  const dir = path.join(DATA_DIR, "projects", pid);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const req: ApprovalRequest = {
    id, sessionId, toolName: "run_command", summary: `approval ${id}`,
    payload: { command: "echo x" }, createdAt: Date.now() - ageMs, status: "pending",
  };
  fs.writeFileSync(path.join(dir, "approvals.json"), JSON.stringify([req]));
  fs.writeFileSync(path.join(dir, "sessions", `${sessionId}.json`), JSON.stringify({
    id: sessionId, projectId: pid, title: "s", messages: [], contextRefs: [], compactions: [],
    createdAt: Date.now() - ageMs - 1000, updatedAt: Date.now() - ageMs,
  }));
}

beforeEach(() => {
  registerProject(rootA);
  registerProject(rootB);
  writePendingApproval(rootA, "sess-live-a", "appr-young", 60_000);     // 1min old
  writePendingApproval(rootA, "sess-dead-a", "appr-mid", 10 * 60_000);   // 10min old (was decidable pre-restart)
  // reload persisted state from disk
  const { reloadApprovalsForBoot } = require("../src/approvals.js");
  reloadApprovalsForBoot();
});

describe("boot zombie approvals (bug: permission prompt right after server start)", () => {
  test("a reloaded pending whose task is not running is force-denied at boot", () => {
    const mid = getApproval("appr-mid");
    expect(mid?.status).toBe("denied");
    expect(mid?.decidedBy).toBe("policy-auto-deny");
  });

  test("no reloaded pending resurfaces as a prompt after boot", () => {
    // With no live tasks, EVERY reloaded pending must be decided — the UI must
    // never show a prompt from the previous process.
    for (const p of listAllPending()) {
      expect(p.status).not.toBe("pending");
    }
  });
});
