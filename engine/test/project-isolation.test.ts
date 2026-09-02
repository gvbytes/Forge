// PS 5b: "Each codebase gets its own separate index. Retrieval and agent memory
// from one project must never leak into another project."
//
// This is asserted against REAL indexes over REAL temp directories rather than
// mocks, because the failure being guarded against is a shared cache key — and
// a mock would share whatever key the test invents rather than the one the
// implementation actually uses.
import { TEST_DATA_DIR } from "./_env.js";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, retrieve, stats } from "../src/retrieval.js";
import { computeRepoMap, _clearGraphCache } from "../src/repomap.js";

let alphaRoot = "";
let betaRoot = "";

beforeAll(async () => {
  alphaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iso-alpha-"));
  betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iso-beta-"));

  // Deliberately disjoint vocabularies so a leak is unambiguous: no token in
  // one project appears in the other.
  fs.writeFileSync(path.join(alphaRoot, "payments.ts"),
    `export function chargeCreditCard(amountCents: number) {\n  return settleMerchantLedger(amountCents);\n}\n` +
    `export function settleMerchantLedger(n: number) { return n; }\n`);
  fs.writeFileSync(path.join(alphaRoot, "invoice.ts"),
    `import { chargeCreditCard } from "./payments";\nexport function buildInvoiceTotals() { return chargeCreditCard(100); }\n`);

  fs.writeFileSync(path.join(betaRoot, "telemetry.py"),
    `def sample_gyroscope_axis(axis):\n    return calibrate_magnetometer(axis)\n\ndef calibrate_magnetometer(axis):\n    return axis\n`);
  fs.writeFileSync(path.join(betaRoot, "flight.py"),
    `from telemetry import sample_gyroscope_axis\n\ndef compute_altitude_drift():\n    return sample_gyroscope_axis(1)\n`);

  await buildIndex(alphaRoot, "proj-alpha");
  await buildIndex(betaRoot, "proj-beta");
});

afterAll(() => {
  _clearGraphCache();
  for (const d of [alphaRoot, betaRoot]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("per-project index isolation (PS 5b)", () => {
  test("each project gets its own index with its own contents", () => {
    const a = stats("proj-alpha");
    const b = stats("proj-beta");
    expect(a?.files).toBeGreaterThan(0);
    expect(b?.files).toBeGreaterThan(0);
  });

  test("querying project A NEVER returns project B's files", async () => {
    // Ask alpha for something only beta contains.
    const leaked = await retrieve({ projectId: "proj-alpha", query: "calibrate_magnetometer gyroscope", k: 10 });
    for (const hit of leaked) {
      expect(hit.path.includes("telemetry")).toBe(false);
      expect(hit.path.includes("flight")).toBe(false);
    }
  });

  test("querying project B NEVER returns project A's files", async () => {
    const leaked = await retrieve({ projectId: "proj-beta", query: "chargeCreditCard merchant ledger invoice", k: 10 });
    for (const hit of leaked) {
      expect(hit.path.includes("payments")).toBe(false);
      expect(hit.path.includes("invoice")).toBe(false);
    }
  });

  test("each project still finds its OWN code — isolation is not just emptiness", async () => {
    // A test that only asserts absence would pass on a broken index that
    // returns nothing at all.
    const a = await retrieve({ projectId: "proj-alpha", query: "chargeCreditCard", k: 5 });
    expect(a.some((h) => h.path.includes("payments"))).toBe(true);

    const b = await retrieve({ projectId: "proj-beta", query: "calibrate_magnetometer", k: 5 });
    expect(b.some((h) => h.path.includes("telemetry"))).toBe(true);
  });

  test("an unknown project id yields nothing rather than another project's index", async () => {
    const hits = await retrieve({ projectId: "proj-does-not-exist", query: "chargeCreditCard", k: 5 });
    expect(hits).toHaveLength(0);
  });

  test("the repo map is per-root: one project's symbols never appear in another's", async () => {
    const alphaMap = await computeRepoMap(alphaRoot, "charge", 1500);
    const betaMap = await computeRepoMap(betaRoot, "calibrate", 1500);
    expect(alphaMap.includes("chargeCreditCard")).toBe(true);
    expect(alphaMap.includes("calibrate_magnetometer")).toBe(false);
    expect(betaMap.includes("calibrate_magnetometer")).toBe(true);
    expect(betaMap.includes("chargeCreditCard")).toBe(false);
  });
});
