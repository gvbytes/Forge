// Wave 2B (B5/B6): file-scoped hunk addressing + per-hunk decision
// persistence, exercised through the real HTTP route via app.request.
// Importing index.ts boots the server on an ephemeral port (see _env.ts).
import "./_env.js";
import { describe, expect, test, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { app } from "../src/index.js";
import { registerProject, newSession } from "../src/sessions.js";
import { putProposal, getProposal } from "../src/proposals.js";
import { buildFileDiff } from "../src/apply.js";
import type { ChangeProposal } from "../src/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunk-route-test-"));
let sessionId = "";
let proposal: ChangeProposal;

async function patch(url: string, body: unknown): Promise<Response> {
  return await app.request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeProposal(files: { rel: string; before: string; after: string }[]): ChangeProposal {
  const fds = files.map((f) => {
    fs.writeFileSync(path.join(root, f.rel), f.before);
    return buildFileDiff(f.rel, f.before, f.after);
  });
  const p: ChangeProposal = {
    id: crypto.randomUUID(), sessionId, files: fds, rationale: "wave2b test",
    createdAt: Date.now(), status: "pending",
  };
  putProposal(p);
  return p;
}

beforeAll(() => {
  const info = registerProject(root);
  sessionId = newSession(info.id).id;
  proposal = makeProposal([
    { rel: "a.txt", before: "line1\nline2\nline3\n", after: "line1\nline2 CHANGED\nline3\n" },
    { rel: "b.txt", before: "alpha\nbeta\ngamma\n", after: "alpha\nBETA\ngamma\n" },
  ]);
});

describe("B6 file-scoped hunk addressing", () => {
  test("hid '${fileIdx}_${hunkIdx}' applies ONLY to that file", async () => {
    // web sends the per-file DTO id as pid and `${fileIdx}_${hunkIdx}` as hid
    const res = await patch(`/api/proposals/${proposal.id}_1/hunks/1_0`, { accept: true });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string; path: string; hunks: { status: string }[] };
    // response is the full ProposalDto matching the request id (replaceProposal)
    expect(dto.id).toBe(`${proposal.id}_1`);
    expect(dto.path).toBe("b.txt");
    expect(dto.hunks[0]!.status).toBe("accepted");
    // ONLY b.txt changed on disk; a.txt untouched
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("line1\nline2\nline3\n");
  });

  test("legacy numeric hid still resolves (first file containing the hunkIndex)", async () => {
    const p2 = makeProposal([
      { rel: "c.txt", before: "one\ntwo\n", after: "one\nTWO\n" },
    ]);
    const res = await patch(`/api/proposals/${p2.id}/hunks/0`, { accepted: true }); // old body key too (B5)
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("one\nTWO\n");
  });

  test("unknown hunk address → 404", async () => {
    const res = await patch(`/api/proposals/${proposal.id}_0/hunks/9_9`, { accept: true });
    expect(res.status).toBe(404);
  });
});

describe("B5 per-hunk decision persistence", () => {
  test("REJECT persists status+reason, emits updated proposal, returns DTO", async () => {
    const res = await patch(`/api/proposals/${proposal.id}_0/hunks/0_0`, { accept: false, reason: "not needed" });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string; hunks: { status: string; reason?: string }[] };
    expect(dto.id).toBe(`${proposal.id}_0`);
    expect(dto.hunks[0]!.status).toBe("rejected");
    expect(dto.hunks[0]!.reason).toBe("not needed");
    // persisted to the proposal store (disk), not just the response
    const stored = getProposal(proposal.id)!;
    expect(stored.files[0]!.hunks[0]!.status).toBe("rejected");
    expect(stored.files[0]!.hunks[0]!.reason).toBe("not needed");
    expect(stored.files[1]!.hunks[0]!.status).toBe("accepted");
    // mixed decisions → partially-applied; rejected file untouched on disk
    expect(stored.status).toBe("partially-applied");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("line1\nline2\nline3\n");
  });

  test("accept body key '{accepted}' also honored", async () => {
    const p3 = makeProposal([
      { rel: "d.txt", before: "x\ny\n", after: "x\nY\n" },
    ]);
    const res = await patch(`/api/proposals/${p3.id}/hunks/0_0`, { accepted: true });
    expect(res.status).toBe(200);
    const stored = getProposal(p3.id)!;
    expect(stored.files[0]!.hunks[0]!.status).toBe("accepted");
    expect(stored.status).toBe("applied");
  });
});
