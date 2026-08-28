// Retrieval pipeline regression suite (new-issue R1 + semantic index contract).
//
// Locks in:
//  - symbol extraction + PageRank correctness & determinism
//  - the symbol-graph cache: repeat queries reuse it, fingerprint invalidation
//  - semantic chunking at def boundaries with bounded spans
//  - end-to-end retrieve(): per-project index, bounded previews, no whole files
import "./_env.js";
import { describe, expect, test, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSymbolPageRanks,
  computeRepoMap,
  extractFileSymbols,
  _clearGraphCache,
} from "../src/repomap.js";
import { chunkSpans, buildIndex, retrieve, _cacheSize, _setInflightForTest } from "../src/retrieval.js";

function mkProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const BASE_FILES = {
  "src/alpha.ts": [
    "export function alphaOne() { return betaHelper() + 1; }",
    "export function alphaTwo() { return 2; }",
    "function betaHelper() { return 40; }",
  ].join("\n"),
  "src/beta.ts": [
    "import { alphaOne } from \"./alpha\";",
    "export class BetaService {",
    "  run() { return alphaOne(); }",
    "}",
  ].join("\n"),
};

beforeEach(() => _clearGraphCache());

describe("repomap symbol extraction + PageRank", () => {
  test("extracts function/class/interface defs", () => {
    const defs = extractFileSymbols("src/alpha.ts", BASE_FILES["src/alpha.ts"]!);
    const names = defs.map((d) => d.name);
    expect(names).toContain("alphaOne");
    expect(names).toContain("alphaTwo");
    expect(names).toContain("betaHelper");
  });

  test("PageRank ranks cross-referenced symbols and is deterministic", async () => {
    const root = mkProject(BASE_FILES);
    const r1 = await getSymbolPageRanks(root, "alphaOne");
    const r2 = await getSymbolPageRanks(root, "alphaOne");
    expect(r1.size).toBeGreaterThan(0);
    // determinism: identical input → identical ranks
    for (const [k, v] of r1) expect(r2.get(k)).toBe(v);
    // alphaOne is named by the query + referenced by beta.ts → should rank highly
    const alphaKey = [...r1.keys()].find((k) => k.endsWith(":alphaOne"));
    expect(alphaKey).toBeDefined();
  });

  test("graph cache invalidates when a file is added (fingerprint changes)", async () => {
    const root = mkProject(BASE_FILES);
    const before = await getSymbolPageRanks(root, "gamma");
    expect([...before.keys()].some((k) => k.includes("gammaThing"))).toBe(false);
    // add a brand-new file → count fingerprint changes → cache must rebuild
    fs.writeFileSync(path.join(root, "src/gamma.ts"), "export function gammaThing() { return 7; }\n", "utf8");
    const after = await getSymbolPageRanks(root, "gamma");
    expect([...after.keys()].some((k) => k.includes("gammaThing"))).toBe(true);
  });

  test("computeRepoMap renders a token-budgeted map naming the symbols", async () => {
    const root = mkProject(BASE_FILES);
    const map = await computeRepoMap(root, "alphaOne", 1500);
    expect(map).toContain("# Repo Map");
    expect(map).toContain("alphaOne");
  });
});

describe("semantic chunking", () => {
  test("splits at def boundaries and bounds span length", () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(`export function fn${i}() {`);
      for (let j = 0; j < 6; j++) lines.push(`  const v${j} = ${j};`);
      lines.push("  return 1;");
      lines.push("}");
    }
    const spans = chunkSpans(lines.join("\n"));
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end - s.start).toBeLessThanOrEqual(80); // HARD_LINES ceiling
    }
    // spans tile the file without gaps/overlaps
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    expect(sorted[0]!.start).toBe(0);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBe(sorted[i - 1]!.end);
    expect(sorted[sorted.length - 1]!.end).toBe(lines.length);
  });
});

describe("retrieve() end-to-end (per-project isolation + bounded previews)", () => {
  test("returns bounded, project-scoped hits for a query", async () => {
    const root = mkProject(BASE_FILES);
    const pid = "proj-alpha";
    await buildIndex(root, pid);
    const hits = await retrieve({ projectId: pid, query: "alphaOne betaHelper", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.path).toBeTruthy();
      expect(h.startLine).toBeGreaterThanOrEqual(1);
      expect(h.endLine).toBeGreaterThanOrEqual(h.startLine);
      // bounded preview — never a whole file dump
      expect(h.preview.split("\n").length).toBeLessThanOrEqual(30);
    }
    // top hit should be from alpha.ts where alphaOne/betaHelper live
    expect(hits[0]!.path).toContain("alpha.ts");
  });

  test("unknown project returns empty (no cross-project leakage)", async () => {
    const root = mkProject(BASE_FILES);
    await buildIndex(root, "proj-alpha");
    const hits = await retrieve({ projectId: "proj-OTHER", query: "alphaOne", k: 5 });
    expect(hits).toEqual([]);
  });
});

describe("R2: bounded in-memory index cache", () => {
  test("cache stays ≤ cap and evicted projects rehydrate from disk", async () => {
    const pids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const root = mkProject({ "src/x.ts": `export function sym${i}() { return ${i}; }` });
      const pid = `proj-cache-${i}`;
      pids.push(pid);
      await buildIndex(root, pid);
    }
    expect(_cacheSize()).toBeLessThanOrEqual(8);
    // proj-cache-0 was evicted from memory but persisted → must rehydrate, not fail
    const hits = await retrieve({ projectId: pids[0]!, query: "sym0", k: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("R4: retrieve awaits an in-flight build", () => {
  test("returns hits (not []) when the index build is still running", async () => {
    const root = mkProject(BASE_FILES);
    const pid = "proj-inflight";
    // Gate the build so retrieve deterministically hits the in-flight branch.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    _setInflightForTest(pid, gate.then(() => buildIndex(root, pid)));
    const pending = retrieve({ projectId: pid, query: "alphaOne", k: 5 });
    await new Promise((r) => setTimeout(r, 20)); // let retrieve reach the await
    release!();
    const hits = await pending;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toContain("alpha.ts");
  });
});
