// The old graph connected symbols by NAME CO-OCCURRENCE: any identifier that
// matched any symbol name anywhere produced an edge, from every symbol in the
// source file, case-insensitively. That is a bag of words wearing a graph's
// clothes — it captures neither dependencies nor execution flow, which is
// exactly what the retrieval brief calls out.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import {
  extractImports,
  resolveImport,
  withSymbolRanges,
  buildStructuralGraph,
  EDGE_WEIGHT,
  type SymbolDef,
} from "../src/repomap.js";

const sym = (path: string, name: string, startLine: number, kind = "func"): SymbolDef =>
  ({ path, name, kind, startLine });

describe("extractImports", () => {
  test("finds the import forms used across the supported languages", () => {
    expect(extractImports(`import { a } from "./util";`)).toContain("./util");
    expect(extractImports(`const x = require("./helper")`)).toContain("./helper");
    expect(extractImports(`from app.core import thing`)).toContain("app.core");
    expect(extractImports(`import os`)).toContain("os");
    expect(extractImports(`#include "engine.h"`)).toContain("engine.h");
    expect(extractImports(`use crate::parser;`)).toContain("crate::parser");
  });

  test("deduplicates repeated specifiers", () => {
    const out = extractImports(`import a from "./x";\nimport b from "./x";`);
    expect(out.filter((s) => s === "./x")).toHaveLength(1);
  });
});

describe("resolveImport", () => {
  const known = new Set(["src/util.ts", "src/nested/index.ts", "app/core.py", "src/a/b.ts"]);

  test("resolves a relative import to a real repo file", () => {
    expect(resolveImport("src/main.ts", "./util", known)).toBe("src/util.ts");
  });

  test("walks .. correctly", () => {
    expect(resolveImport("src/a/b.ts", "../util", known)).toBe("src/util.ts");
  });

  test("resolves a directory to its entry file", () => {
    expect(resolveImport("src/main.ts", "./nested", known)).toBe("src/nested/index.ts");
  });

  test("resolves a dotted python module", () => {
    expect(resolveImport("main.py", "app.core", known)).toBe("app/core.py");
  });

  test("returns null for third-party packages — a wrong edge is worse than none", () => {
    // Inventing an edge drags unrelated code into the agent's context.
    expect(resolveImport("src/main.ts", "react", known)).toBeNull();
    expect(resolveImport("main.py", "os", known)).toBeNull();
  });
});

describe("withSymbolRanges", () => {
  test("infers an end line from the next symbol, and the file end for the last", () => {
    const ranged = withSymbolRanges(
      [sym("a.ts", "one", 1), sym("a.ts", "two", 10), sym("a.ts", "three", 20)],
      new Map([["a.ts", 30]]),
    );
    expect(ranged.find((s) => s.name === "one")!.endLine).toBe(10);
    expect(ranged.find((s) => s.name === "two")!.endLine).toBe(20);
    expect(ranged.find((s) => s.name === "three")!.endLine).toBe(30);
  });
});

describe("buildStructuralGraph", () => {
  test("an import produces a dependency edge weighted above a call", () => {
    const files = new Map([
      ["src/main.ts", `import { helper } from "./util";\nexport function main() {\n  return 1;\n}`],
      ["src/util.ts", `export function helper() {\n  return 2;\n}`],
    ]);
    const g = buildStructuralGraph([sym("src/main.ts", "main", 2), sym("src/util.ts", "helper", 1)], files);
    const w = g.edges.get("src/main.ts:main")!.get("src/util.ts:helper");
    expect(w).toBeGreaterThanOrEqual(EDGE_WEIGHT.import);
    expect(g.edgeKinds.get("src/main.ts:main")!.get("src/util.ts:helper")).toBe("import");
  });

  test("ONE mention makes ONE edge — not one per symbol in the file", () => {
    // The old builder connected every symbol in the source file to the target,
    // so a 20-function file emitted 20 edges for a single reference.
    const files = new Map([
      ["a.ts", `function alpha() {\n  return 1;\n}\nfunction beta() {\n  return target();\n}\nfunction gamma() {\n  return 3;\n}`],
      ["b.ts", `export function target() { return 0; }`],
    ]);
    const g = buildStructuralGraph(
      [sym("a.ts", "alpha", 1), sym("a.ts", "beta", 4), sym("a.ts", "gamma", 7), sym("b.ts", "target", 1)],
      files,
    );
    // Only beta contains the call.
    expect(g.edges.get("a.ts:beta")!.has("b.ts:target")).toBe(true);
    expect(g.edges.get("a.ts:alpha")!.has("b.ts:target")).toBe(false);
    expect(g.edges.get("a.ts:gamma")!.has("b.ts:target")).toBe(false);
  });

  test("identifier matching is CASE-SENSITIVE — code is", () => {
    // `User` must not link to a local variable named `user`.
    const files = new Map([
      ["a.ts", `function run() {\n  const user = 1;\n  return user;\n}`],
      ["b.ts", `export class User {}`],
    ]);
    const g = buildStructuralGraph([sym("a.ts", "run", 1), sym("b.ts", "User", 1, "class")], files);
    expect(g.edges.get("a.ts:run")!.has("b.ts:User")).toBe(false);
  });

  test("references inside comments are not execution flow", () => {
    const files = new Map([
      ["a.ts", `function run() {\n  // calls target() eventually\n  return 1;\n}`],
      ["b.ts", `export function target() { return 0; }`],
    ]);
    const g = buildStructuralGraph([sym("a.ts", "run", 1), sym("b.ts", "target", 1)], files);
    expect(g.edges.get("a.ts:run")!.has("b.ts:target")).toBe(false);
  });

  test("no self-edges, and same-file references are not dependencies", () => {
    const files = new Map([["a.ts", `function one() {\n  return two();\n}\nfunction two() {\n  return 1;\n}`]]);
    const g = buildStructuralGraph([sym("a.ts", "one", 1), sym("a.ts", "two", 4)], files);
    expect(g.edges.get("a.ts:one")!.has("a.ts:one")).toBe(false);
    expect(g.edges.get("a.ts:one")!.has("a.ts:two")).toBe(false);
  });

  test("execution flow survives across a two-hop chain", () => {
    // main -> service -> repo. Retrieval expansion walks these hops, so both
    // must exist as real edges.
    const files = new Map([
      ["main.ts", `import { serve } from "./service";\nfunction main() {\n  return serve();\n}`],
      ["service.ts", `import { fetchRow } from "./repo";\nexport function serve() {\n  return fetchRow();\n}`],
      ["repo.ts", `export function fetchRow() { return null; }`],
    ]);
    const g = buildStructuralGraph(
      [sym("main.ts", "main", 2), sym("service.ts", "serve", 2), sym("repo.ts", "fetchRow", 1)],
      files,
    );
    expect(g.edges.get("main.ts:main")!.has("service.ts:serve")).toBe(true);
    expect(g.edges.get("service.ts:serve")!.has("repo.ts:fetchRow")).toBe(true);
  });
});
