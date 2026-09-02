// /api/approvals/pending must be project-scopable: the chat-pane panel polls
// it every 2s and must never prompt for approvals belonging to OTHER folders
// (user bug: fresh server start prompted for permissions "pending before",
// from another project). Engine route test via app.request.
import "./_env.js";
import { describe, expect, test, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { registerProject, projectIdFor } from "../src/sessions.js";
import { createApproval, decideApproval, listAllPending } from "../src/approvals.js";
import { app } from "../src/index.js";

const rootA = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "scop-proj-A-"));
const rootB = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "scop-proj-B-"));

beforeEach(() => {
  registerProject(rootA);
  registerProject(rootB);
});

describe("project-scoped pending approvals endpoint", () => {
  test("?projectId= returns only that project's pendings", async () => {
    const pA = projectIdFor(rootA);
    const pB = projectIdFor(rootB);
    const a1 = createApproval({ sessionId: `sess-a1-${Date.now()}`, toolName: "run_command", summary: "A1", payload: {} });
    // patch sessionIds onto records via the store: approvals carry sessionId
    // from the creating session — emulate by registering sessions first.
    // Simpler: create with explicit sessionIds below.
    void a1;
    const sA = `sess-A-${Math.random()}`;
    const sB = `sess-B-${Math.random()}`;
    // write minimal session files so the session→project resolver can find them
    for (const [pid, sid] of [[pA, sA], [pB, sB]] as [string, string][]) {
      const dir = path.join(DATA_DIR, "projects", pid, "sessions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
        id: sid, projectId: pid, title: "t", messages: [], contextRefs: [], compactions: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      }));
    }
    const apprA = createApproval({ sessionId: sA, toolName: "run_command", summary: "A-pending", payload: {} });
    const apprB = createApproval({ sessionId: sB, toolName: "run_command", summary: "B-pending", payload: {} });
    void apprA; void apprB;

    const rA = await app.request(`/api/approvals/pending?projectId=${pA}`);
    const bodyA = (await rA.json()) as { sessionId: string }[];
    const all0 = listAllPending();
    for (const a of all0) {
      const hit2 = (await import("../src/sessions.js")).listSessions(pA).find((sx: any) => sx.id === a.sessionId);
    }
    expect(bodyA.some((x) => x.sessionId === sA)).toBe(true);
    expect(bodyA.some((x) => x.sessionId === sB)).toBe(false);

    const rB = await app.request(`/api/approvals/pending?projectId=${pB}`);
    const bodyB = (await rB.json()) as { sessionId: string }[];
    expect(bodyB.some((x) => x.sessionId === sB)).toBe(true);
    expect(bodyB.some((x) => x.sessionId === sA)).toBe(false);

    decideApproval(apprA!.id, false);
    decideApproval(apprB!.id, false);
  });

  test("no projectId → global list (back-compat for the settings modal)", async () => {
    const all = listAllPending();
    const r = await app.request("/api/approvals/pending");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(all);
  });
});
