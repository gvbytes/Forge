// Everything that decided whether a step succeeded used to be downstream of the
// coder: the reviewer reads a diff computed from the coder's own writes, and
// resultSummary — what the re-planner reads — is the coder's own account. The
// auditor answers the one question the coder cannot be trusted on: what is
// ACTUALLY on disk now.
import "./_env.js";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditStep, auditLabel } from "../src/audit.js";

let root = "";
const w = (rel: string, body: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  w("good.py", "def add(a, b):\n    return a + b\n");
  w("broken.py", "def add(a, b)\n    return a + b\n");        // missing colon
  w("good.js", "function add(a, b) { return a + b; }\n");
  w("broken.js", "function add(a, b) { return a + b;\n");      // unclosed brace
  w("empty.py", "");
  w("data.json", '{"a": 1}');
  w("bad.json", "{not json}");
  w("notes.md", "# just prose\n");                             // no checker
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("auditStep", () => {
  test("passes a file that exists, has content, and parses", async () => {
    const r = await auditStep(root, ["good.py"]);
    expect(r.ok).toBe(true);
    expect(r.facts[0]).toContain("VERIFIED");
  });

  test("CATCHES A FILE THAT WAS NEVER WRITTEN — the reviewer cannot", async () => {
    // The coder reports creating it; the diff shows it; it is not on disk.
    const r = await auditStep(root, ["quotes.js"]);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "exists")!.ok).toBe(false);
    expect(r.facts[0]).toContain("VERIFIED FAILURE");
    expect(r.facts[0]).toContain("no such file");
  });

  test("catches an empty file — a write that produced no content", async () => {
    const r = await auditStep(root, ["empty.py"]);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.name === "non-empty" && !c.ok)).toBe(true);
  });

  test("catches broken Python syntax that produces a clean-looking diff", async () => {
    const r = await auditStep(root, ["broken.py"]);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.name === "syntax" && !c.ok)).toBe(true);
  });

  test("catches broken JavaScript syntax", async () => {
    const r = await auditStep(root, ["broken.js"]);
    expect(r.ok).toBe(false);
  });

  test("catches malformed JSON", async () => {
    expect((await auditStep(root, ["bad.json"])).ok).toBe(false);
    expect((await auditStep(root, ["data.json"])).ok).toBe(true);
  });

  test("a file with no checker is NOT a failure — unverifiable is not broken", async () => {
    const r = await auditStep(root, ["notes.md"]);
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.name === "syntax")).toBe(false);
  });

  test("a deletion is verified as actually gone", async () => {
    const present = await auditStep(root, [], ["good.py"]);
    expect(present.ok).toBe(false); // still on disk
    const absent = await auditStep(root, [], ["never-existed.py"]);
    expect(absent.ok).toBe(true);
  });

  test("mixed batch fails as a whole and names every real problem", async () => {
    const r = await auditStep(root, ["good.py", "broken.py", "missing.py"]);
    expect(r.ok).toBe(false);
    expect(r.facts.length).toBeGreaterThanOrEqual(2);
    expect(r.facts.every((f) => f.startsWith("VERIFIED FAILURE"))).toBe(true);
  });

  test("facts are observations, never the coder's claims", async () => {
    // The re-planner reads these. They must describe the filesystem.
    const r = await auditStep(root, ["good.py"]);
    expect(r.facts.join(" ")).toContain("on disk");
  });

  test("auditLabel summarises for the trace", async () => {
    expect(auditLabel(await auditStep(root, ["good.py"]))).toContain("audit passed");
    expect(auditLabel(await auditStep(root, ["missing.py"]))).toContain("audit FAILED");
  });
});
