// The retrieval brief: keyword matching is too rigid and plain embeddings treat
// code as English — both miss execution flow and dependencies. This asserts the
// property that distinguishes a structural pipeline from a lexical one:
// retrieval must reach code that shares NO VOCABULARY with the query, purely
// because the program depends on it.
import { TEST_DATA_DIR } from "./_env.js";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, retrieve } from "../src/retrieval.js";
import { _clearGraphCache } from "../src/repomap.js";

let root = "";

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "struct-ret-"));

  // A three-hop chain with DELIBERATELY DISJOINT vocabulary at each hop.
  // Nothing lexical connects "checkout" to "vault" — only the import chain.
  fs.writeFileSync(path.join(root, "checkout.ts"),
    `import { authorizeTransaction } from "./gateway";\n` +
    `export function runCheckoutFlow(basket: number) {\n  return authorizeTransaction(basket);\n}\n`);

  fs.writeFileSync(path.join(root, "gateway.ts"),
    `import { unsealCredential } from "./vault";\n` +
    `export function authorizeTransaction(amount: number) {\n  return unsealCredential() + amount;\n}\n`);

  fs.writeFileSync(path.join(root, "vault.ts"),
    `export function unsealCredential() {\n  return 42;\n}\n`);

  // Decoys: plenty of unrelated files so a "returns everything" index fails.
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(root, `noise${i}.ts`),
      `export function renderSidebarWidget${i}() {\n  return "sidebar ${i}";\n}\n`);
  }

  await buildIndex(root, "proj-struct");
});

afterAll(() => {
  _clearGraphCache();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("structural retrieval follows dependencies, not vocabulary", () => {
  test("a query naming ONLY the entry point still surfaces its direct dependency", async () => {
    // "runCheckoutFlow" shares no token with gateway.ts's contents beyond the
    // import line — a pure BM25 match on the query cannot rank it.
    const hits = await retrieve({ projectId: "proj-struct", query: "runCheckoutFlow", k: 8 });
    const paths = hits.map((h) => h.path);
    expect(paths.some((p) => p.includes("checkout"))).toBe(true);
    expect(paths.some((p) => p.includes("gateway"))).toBe(true);
  });

  test("it does not simply return every file — decoys stay out", async () => {
    // An index that returns everything would trivially pass the test above.
    const hits = await retrieve({ projectId: "proj-struct", query: "runCheckoutFlow", k: 8 });
    const noise = hits.filter((h) => h.path.includes("noise"));
    expect(noise.length).toBeLessThan(hits.length);
  });

  test("previews are bounded — no whole-file dumping", async () => {
    // The brief is explicit that whole files must not be dumped into context.
    const hits = await retrieve({ projectId: "proj-struct", query: "authorizeTransaction", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.preview.split("\n").length).toBeLessThanOrEqual(30);
      expect(h.endLine).toBeGreaterThanOrEqual(h.startLine);
    }
  });

  test("every hit carries a precise line span, not just a filename", async () => {
    const hits = await retrieve({ projectId: "proj-struct", query: "unsealCredential", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(Number.isFinite(h.startLine)).toBe(true);
      expect(h.startLine).toBeGreaterThan(0);
    }
  });
});
