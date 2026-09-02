/**
 * Native TypeScript RepoMap — compact repository map for planning prompts.
 *
 * Algorithms & Features:
 * 1. Regex definition extraction across JS/TS/Py/Go/Rust/C/C++/Java/Kotlin/C#.
 * 2. Symbol definition -> reference graph builder.
 * 3. Power-iteration PageRank over symbol graph with query keyword teleportation vector.
 * 4. Token-budgeted output rendering (<1800 tokens, 3.5 chars/token ratio).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface SymbolDef {
  name: string;
  path: string;
  kind: string;
  startLine: number;
  /** Exclusive end line, inferred from the next symbol's start. Lets a
   *  reference be attributed to the symbol that CONTAINS it. */
  endLine?: number;
  score?: number;
}

/**
 * Edge kinds, in descending strength of evidence.
 *
 *  import — file A literally imports from file B. A hard, syntactic dependency.
 *  call   — a symbol's body references another symbol by exact name. This is
 *           the closest thing to execution flow available without a full
 *           type-resolved AST.
 *
 * Kept distinct because they mean different things during retrieval: an import
 * says "you cannot understand A without B", a call says "A probably runs B".
 */
export type EdgeKind = "import" | "call";

export const EDGE_WEIGHT: Record<EdgeKind, number> = { import: 3, call: 1 };

export interface SymbolGraph {
  nodes: Map<string, SymbolDef>; // id -> SymbolDef
  edges: Map<string, Map<string, number>>; // fromId -> (toId -> weight)
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
]);

const CODE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  ".java", ".kt", ".kts",
  ".cs",
  ".rb", ".php", ".swift", ".scala",
  ".sh", ".bash", ".zsh",
]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "does", "did", "what", "when", "where",
  "which", "this", "that", "these", "those", "from", "into", "about", "should",
  "could", "would", "can", "you", "your", "our", "are", "was", "were", "has",
  "have", "had", "but", "all", "any", "some", "its", "there", "here", "then",
  "than", "also", "just", "like", "please", "need", "want", "she", "him",
  "his", "her", "not", "who", "why", "will", "may", "might", "must", "shall",
]);

// Multi-language definition regexes
interface DefPattern {
  kind: string;
  regex: RegExp;
  nameGroup: number;
}

const PATTERNS: Record<string, DefPattern[]> = {
  ts: [
    { kind: "func", regex: /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { kind: "class", regex: /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { kind: "interface", regex: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { kind: "type", regex: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, nameGroup: 1 },
    { kind: "enum", regex: /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { kind: "const", regex: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, nameGroup: 1 },
  ],
  py: [
    { kind: "def", regex: /(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g, nameGroup: 1 },
    { kind: "class", regex: /class\s+([A-Za-z_][\w]*)(?:\s*\([^)]*\))?\s*:/g, nameGroup: 1 },
  ],
  go: [
    { kind: "func", regex: /func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/g, nameGroup: 1 },
    { kind: "struct", regex: /type\s+([A-Za-z_][\w]*)\s+struct\b/g, nameGroup: 1 },
    { kind: "interface", regex: /type\s+([A-Za-z_][\w]*)\s+interface\b/g, nameGroup: 1 },
  ],
  rs: [
    { kind: "fn", regex: /(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
    { kind: "struct", regex: /(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
    { kind: "enum", regex: /(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
    { kind: "trait", regex: /(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
    { kind: "impl", regex: /impl(?:<[^>]+>)?\s+(?:[A-Za-z_][\w]*\s+for\s+)?([A-Za-z_][\w]*)/g, nameGroup: 1 },
  ],
  c: [
    { kind: "class", regex: /(?:class|struct|enum|union)\s+([A-Za-z_][\w]*)\s*[{;:]/g, nameGroup: 1 },
    { kind: "func", regex: /^\s*(?:[A-Za-z_][\w*&\s<>]+\s+)+([A-Za-z_][\w]*)\s*\([^;{)]*\)\s*(?:const)?\s*\{/gm, nameGroup: 1 },
  ],
  jvm: [
    { kind: "class", regex: /(?:public|private|protected|static|final|abstract|sealed)*\s*(?:class|interface|enum|record|trait)\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
    { kind: "method", regex: /(?:public|private|protected|static|final|abstract|synchronized)\s+(?:<[^>]+>\s+)?[A-Za-z_][\w<>[\],.?\s]*\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/g, nameGroup: 1 },
    { kind: "fun", regex: /(?:fun|val|var)\s+([A-Za-z_][\w]*)/g, nameGroup: 1 },
  ],
};

function getFileLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if ([".py", ".pyi"].includes(ext)) return "py";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rs";
  if ([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"].includes(ext)) return "c";
  if ([".java", ".kt", ".kts", ".scala", ".cs"].includes(ext)) return "jvm";
  return "ts";
}

export function estTokensMap(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}

/** Extract definitions from a source code string */
export function extractFileSymbols(relPath: string, content: string): SymbolDef[] {
  const lang = getFileLanguage(relPath);
  const patterns = PATTERNS[lang] ?? PATTERNS.ts!;
  const lines = content.split(/\r?\n/);
  const defs: SymbolDef[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("//") || line.trim().startsWith("#") || line.trim().startsWith("/*")) {
      continue;
    }
    for (const pat of patterns) {
      pat.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.regex.exec(line)) !== null) {
        const name = m[pat.nameGroup];
        if (name && name.length >= 2 && !STOPWORDS.has(name.toLowerCase()) && !seen.has(name)) {
          seen.add(name);
          defs.push({
            name,
            path: relPath,
            kind: pat.kind,
            startLine: i + 1,
          });
        }
      }
    }
  }
  return defs;
}

export async function walkProjectFiles(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(projectRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
        stack.push(rel);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          out.push(rel);
        }
      }
    }
  }
  return out.sort();
}

/** Extract all symbols across workspace */
export async function extractProjectSymbols(projectRoot: string): Promise<{ symbols: SymbolDef[]; fileContents: Map<string, string> }> {
  const files = await walkProjectFiles(projectRoot);
  const symbols: SymbolDef[] = [];
  const fileContents = new Map<string, string>();

  for (const rel of files) {
    const abs = path.join(projectRoot, rel);
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > 500_000) continue; // Skip huge files
      const content = await fsp.readFile(abs, "utf8");
      fileContents.set(rel, content);
      const defs = extractFileSymbols(rel, content);
      symbols.push(...defs);
    } catch {
      // skip unreadable
    }
  }

  return { symbols, fileContents };
}

/** Build definition -> reference graph */
export function buildSymbolGraph(symbols: SymbolDef[], fileContents: Map<string, string>): SymbolGraph {
  const nodes = new Map<string, SymbolDef>();
  const symbolIndex = new Map<string, string[]>(); // name.toLowerCase() -> [nodeId]

  for (const sym of symbols) {
    const id = `${sym.path}:${sym.name}`;
    nodes.set(id, sym);
    const lower = sym.name.toLowerCase();
    const existing = symbolIndex.get(lower) ?? [];
    existing.push(id);
    symbolIndex.set(lower, existing);
  }

  const edges = new Map<string, Map<string, number>>();
  for (const id of nodes.keys()) {
    edges.set(id, new Map());
  }

  // Tokenize each file and connect referenced symbols
  const identRe = /[A-Za-z_$][\w$]*/g;
  for (const [relPath, content] of fileContents) {
    const fileSymbols = symbols.filter((s) => s.path === relPath);
    if (!fileSymbols.length) continue;

    const matches = content.match(identRe) ?? [];
    const counts = new Map<string, number>();
    for (const m of matches) {
      const low = m.toLowerCase();
      if (symbolIndex.has(low)) {
        counts.set(low, (counts.get(low) ?? 0) + 1);
      }
    }

    for (const [lowName, count] of counts) {
      const targets = symbolIndex.get(lowName) ?? [];
      for (const targetId of targets) {
        const targetSym = nodes.get(targetId);
        if (!targetSym || targetSym.path === relPath) continue; // Avoid self-file loops

        // Connect all source file symbols to target symbol
        for (const srcSym of fileSymbols) {
          const srcId = `${srcSym.path}:${srcSym.name}`;
          const edgeMap = edges.get(srcId);
          if (edgeMap) {
            edgeMap.set(targetId, (edgeMap.get(targetId) ?? 0) + count);
          }
        }
      }
    }
  }

  return { nodes, edges };
}

/** Query keyword personalization weights for PageRank teleportation vector */
export function buildPersonalization(
  nodes: Map<string, SymbolDef>,
  query: string
): Map<string, number> {
  const pers = new Map<string, number>();
  const keywords = (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 3 && !STOPWORDS.has(k));

  if (!keywords.length) {
    const count = nodes.size;
    if (count === 0) return pers;
    const uniform = 1.0 / count;
    for (const id of nodes.keys()) pers.set(id, uniform);
    return pers;
  }

  let total = 0;
  for (const [id, sym] of nodes) {
    const name = sym.name.toLowerCase();
    const p = sym.path.toLowerCase();
    let strength = 0;

    for (const kw of keywords) {
      if (name === kw) {
        strength += 1.0;
      } else if (new RegExp(`(?:^|[^A-Za-z0-9_])${kw}(?:$|[^A-Za-z0-9_])`).test(name)) {
        strength += 0.7;
      } else if (name.includes(kw)) {
        strength += 0.3;
      } else if (p.includes(kw)) {
        strength += 0.15;
      }
    }

    const weight = 1.0 + 10.0 * strength;
    pers.set(id, weight);
    total += weight;
  }

  if (total > 0) {
    for (const [id, weight] of pers) {
      pers.set(id, weight / total);
    }
  }
  return pers;
}

/** Power-iteration PageRank on symbol definition -> reference graph */
export function pagerankPower(
  graph: SymbolGraph,
  personalization?: Map<string, number>,
  alpha = 0.85,
  maxIter = 100,
  tol = 1e-6
): Map<string, number> {
  const nodes = Array.from(graph.nodes.keys());
  const n = nodes.length;
  if (n === 0) return new Map();

  const invN = 1.0 / n;
  let tele: Map<string, number>;
  if (personalization && personalization.size > 0) {
    tele = personalization;
  } else {
    tele = new Map();
    for (const u of nodes) tele.set(u, invN);
  }

  // Precompute outgoing total weights and predecessors
  const outTotal = new Map<string, number>();
  const preds = new Map<string, Array<[string, number]>>();
  const dangling: string[] = [];

  for (const u of nodes) {
    preds.set(u, []);
  }

  for (const u of nodes) {
    const outEdges = graph.edges.get(u) ?? new Map();
    let wSum = 0;
    for (const [v, w] of outEdges) {
      wSum += w;
      preds.get(v)?.push([u, w]);
    }
    if (wSum <= 0) {
      dangling.push(u);
    } else {
      outTotal.set(u, wSum);
    }
  }

  let rank = new Map<string, number>();
  for (const u of nodes) rank.set(u, invN);

  for (let iter = 0; iter < maxIter; iter++) {
    let dmass = 0;
    for (const d of dangling) dmass += rank.get(d) ?? 0;

    const newRank = new Map<string, number>();
    let err = 0;

    for (const u of nodes) {
      let acc = 0;
      const uPreds = preds.get(u) ?? [];
      for (const [p, w] of uPreds) {
        const pOut = outTotal.get(p) ?? 1;
        acc += (rank.get(p) ?? 0) * (w / pOut);
      }
      const teleU = tele.get(u) ?? invN;
      const val = alpha * (acc + dmass * teleU) + (1.0 - alpha) * teleU;
      newRank.set(u, val);
      err += Math.abs(val - (rank.get(u) ?? 0));
    }

    rank = newRank;
    if (err < tol * n) break;
  }

  return rank;
}

/** Rank symbols by PageRank + query personalization */
export function rankSymbols(
  graph: SymbolGraph,
  query = "",
  topN = 80
): SymbolDef[] {
  if (graph.nodes.size === 0) return [];
  const personalization = buildPersonalization(graph.nodes, query);
  const ranks = pagerankPower(graph, personalization);

  const scored: SymbolDef[] = [];
  for (const [id, sym] of graph.nodes) {
    const score = ranks.get(id) ?? 0;
    scored.push({ ...sym, score });
  }

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, topN);
}

/** Token-budgeted output rendering (<1800 tokens) */
export function renderRepoMap(symbols: SymbolDef[], query = "", budgetTokens = 1500): string {
  if (!symbols.length) return "";

  const byPath = new Map<string, SymbolDef[]>();
  for (const s of symbols) {
    const list = byPath.get(s.path) ?? [];
    list.push(s);
    byPath.set(s.path, list);
  }

  const header = "# Repo Map";
  const body: string[] = [];
  let used = estTokensMap(header) + 2;

  // Order paths by strongest symbol score
  const sortedPaths = Array.from(byPath.keys()).sort((a, b) => {
    const maxA = Math.max(...(byPath.get(a)?.map((s) => s.score ?? 0) ?? [0]));
    const maxB = Math.max(...(byPath.get(b)?.map((s) => s.score ?? 0) ?? [0]));
    return maxB - maxA;
  });

  for (const p of sortedPaths) {
    const pathSymbols = (byPath.get(p) ?? []).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const entries = pathSymbols.map((s) => `${p}:${s.startLine}-${s.name} (${s.kind})`);
    const block = entries.join("\n");
    const cost = estTokensMap(block);

    if (used + cost > budgetTokens && body.length > 0) {
      break;
    }
    if (cost > budgetTokens && body.length === 0) {
      // Single oversized group — add lines until budget full
      for (const entry of entries) {
        const c = estTokensMap(entry + "\n");
        if (used + c > budgetTokens) break;
        body.push(entry);
        used += c;
      }
      break;
    }

    body.push(block);
    used += cost + 1;
  }

  if (!body.length) return "";
  return `${header}\n${body.join("\n\n")}\n`;
}

// ── Symbol-graph cache (perf) ───────────────────────────────────────────────
// extractProjectSymbols + buildSymbolGraph walk, read and regex-parse the WHOLE
// repo, yet they are query-independent. getSymbolPageRanks / computeRepoMap used
// to rebuild them on EVERY call — and retrieve() runs on every chat turn and
// task — so each message paid an O(repo) walk+parse+graph-build before even the
// cheap personalization + PageRank. Cache the built graph per project root,
// invalidated by a stat-only file fingerprint (count + maxMtime), so repeat
// queries reuse it. Output is byte-identical; only the recomputation is removed.
interface GraphCacheEntry {
  fingerprint: string;
  graph: SymbolGraph;
  at: number;
}
const graphCache = new Map<string, GraphCacheEntry>();
const graphInflight = new Map<string, Promise<SymbolGraph | undefined>>();
const GRAPH_CACHE_MAX = 8; // bound memory across concurrently opened projects

/** Stat-only fingerprint (no file reads): cheap enough to run per query. */
async function repoFingerprint(root: string): Promise<string> {
  const files = await walkProjectFiles(root);
  const count = files.length;
  let maxMtime = 0;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const mtimes = await Promise.all(
      chunk.map(async (rel) => {
        try {
          const st = await fsp.stat(path.join(root, rel));
          return st.mtimeMs;
        } catch {
          return 0;
        }
      })
    );
    for (const m of mtimes) {
      if (m > maxMtime) maxMtime = m;
    }
  }
  return `${count}:${maxMtime}`;
}

function evictOldestGraph(): void {
  let oldestKey = "";
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [k, v] of graphCache) {
    if (v.at < oldestAt) {
      oldestAt = v.at;
      oldestKey = k;
    }
  }
  if (oldestKey) graphCache.delete(oldestKey);
}

async function symbolGraphFor(root: string): Promise<SymbolGraph | undefined> {
  let fp = "";
  try {
    fp = await repoFingerprint(root);
  } catch {
    fp = "";
  }
  const hit = graphCache.get(root);
  if (hit && fp && hit.fingerprint === fp) return hit.graph;

  const running = graphInflight.get(root);
  if (running) return running;

  const p = (async (): Promise<SymbolGraph | undefined> => {
    const { symbols, fileContents } = await extractProjectSymbols(root);
    if (!symbols.length) return undefined;
    // Structural graph: import edges + enclosing-scope reference edges.
    // buildSymbolGraph (name co-occurrence) is retained below only as the
    // documented predecessor these tests compare against.
    const graph = buildStructuralGraph(symbols, fileContents);
    if (fp) {
      if (graphCache.size >= GRAPH_CACHE_MAX) evictOldestGraph();
      graphCache.set(root, { fingerprint: fp, graph, at: Date.now() });
    }
    return graph;
  })();
  graphInflight.set(root, p);
  try {
    return await p;
  } finally {
    graphInflight.delete(root);
  }
}

/** Test hook: drop cached graphs. */
export function _clearGraphCache(): void {
  graphCache.clear();
  graphInflight.clear();
}

/** Compute and render complete RepoMap for a workspace */
export async function computeRepoMap(
  projectRoot: string,
  query = "",
  budgetTokens = 1500
): Promise<string> {
  try {
    const graph = await symbolGraphFor(projectRoot);
    if (!graph || graph.nodes.size === 0) return "";
    const ranked = rankSymbols(graph, query, 80);
    return renderRepoMap(ranked, query, Math.min(budgetTokens, 1800));
  } catch (err) {
    return "";
  }
}

/** Get PageRank scores map for retrieval boosting */
export async function getSymbolPageRanks(
  projectRoot: string,
  query = ""
): Promise<Map<string, number>> {
  try {
    const graph = await symbolGraphFor(projectRoot);
    if (!graph || graph.nodes.size === 0) return new Map();
    const personalization = buildPersonalization(graph.nodes, query);
    return pagerankPower(graph, personalization);
  } catch {
    return new Map();
  }
}

// ── Dependency extraction ──────────────────────────────────────────────────
//
// Why this exists: the previous graph connected symbols by NAME CO-OCCURRENCE.
// Any identifier that matched any symbol name anywhere produced an edge — from
// every symbol in the source file, case-insensitively. A file with twenty
// functions emitted twenty edges for one mention, and `User` linked to a local
// variable called `user`. That is a bag-of-words model wearing a graph's
// clothes: it captures neither dependencies nor execution flow.
//
// These two functions replace it with structure that actually exists in the
// source: import statements (a hard dependency) and references attributed to
// the enclosing symbol (an approximation of a call edge).

/** Import/require/include forms across the languages in CODE_EXTS. */
const IMPORT_RES: RegExp[] = [
  /(?:^|\n)\s*import\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g,   // ES / TS
  /(?:^|\n)\s*(?:const|let|var)\s+[\w{},\s]+=\s*require\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|\n)\s*from\s+([\w.]+)\s+import\s+/g,                            // Python from-import
  /(?:^|\n)\s*import\s+([\w.]+)/g,                                      // Python / Go / Java
  /(?:^|\n)\s*#include\s*[<"]([^>"]+)[>"]/g,                            // C / C++
  /(?:^|\n)\s*use\s+([\w:]+)/g,                                         // Rust
];

/**
 * Raw import specifiers in a file. Package imports ("react", "os") are kept —
 * resolveImport drops the ones that do not correspond to a file in the repo,
 * which is also how third-party noise is excluded from the graph.
 */
export function extractImports(content: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = (m[1] ?? "").trim();
      if (spec) out.add(spec);
    }
  }
  return [...out];
}

/**
 * Resolve one import specifier to a repo-relative file path, or null when it
 * points outside the codebase (a third-party package, a stdlib module).
 *
 * Deliberately syntactic: no tsconfig paths, no node_modules walk. A resolver
 * that guesses wrong invents edges, and a wrong edge is worse than a missing
 * one — it drags unrelated code into the agent's context.
 */
export function resolveImport(fromPath: string, spec: string, known: Set<string>): string | null {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    // Relative: resolve against the importing file's directory.
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    const parts = norm(`${dir}/${spec}`).split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    candidates.push(stack.join("/"));
  } else {
    // Dotted module path (Python/Java) or a bare specifier that may still name
    // a file inside the repo (e.g. "utils" → utils.py at the root).
    candidates.push(norm(spec.replace(/\./g, "/")), norm(spec));
  }

  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h"];
  for (const base of candidates) {
    if (!base) continue;
    for (const ext of exts) {
      const direct = `${base}${ext}`;
      if (known.has(direct)) return direct;
      // A package directory resolves to its entry file.
      for (const idx of ["/index.ts", "/index.tsx", "/index.js", "/__init__.py", "/mod.rs"]) {
        if (known.has(`${base}${idx}`)) return `${base}${idx}`;
      }
    }
  }
  return null;
}

/** Attach an exclusive endLine to each symbol, inferred from the next symbol
 *  in the same file. Needed to attribute a reference to its enclosing symbol. */
export function withSymbolRanges(symbols: SymbolDef[], lineCounts: Map<string, number>): SymbolDef[] {
  const byFile = new Map<string, SymbolDef[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.path) ?? [];
    arr.push(s);
    byFile.set(s.path, arr);
  }
  const out: SymbolDef[] = [];
  for (const [path, syms] of byFile) {
    syms.sort((a, b) => a.startLine - b.startLine);
    const total = lineCounts.get(path) ?? Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < syms.length; i++) {
      out.push({ ...syms[i]!, endLine: i + 1 < syms.length ? syms[i + 1]!.startLine : total });
    }
  }
  return out;
}

/**
 * Structural symbol graph: import edges plus enclosing-scope reference edges.
 *
 * Three things this does that the co-occurrence version did not:
 *   1. Import statements produce edges between the symbols of the two files,
 *      weighted higher — a hard dependency is stronger evidence than a mention.
 *   2. A reference is attributed to the symbol whose LINE RANGE contains it,
 *      so one mention makes one edge, not one per symbol in the file.
 *   3. Identifier matching is CASE-SENSITIVE. Code is case-sensitive; matching
 *      `User` to a local `user` was manufacturing edges that do not exist.
 */
export function buildStructuralGraph(
  symbols: SymbolDef[],
  fileContents: Map<string, string>,
): SymbolGraph & { edgeKinds: Map<string, Map<string, EdgeKind>> } {
  const lineCounts = new Map<string, number>();
  for (const [p, c] of fileContents) lineCounts.set(p, c.split(/\r?\n/).length);
  const ranged = withSymbolRanges(symbols, lineCounts);

  const nodes = new Map<string, SymbolDef>();
  const byName = new Map<string, string[]>();        // EXACT name -> node ids
  const byFile = new Map<string, SymbolDef[]>();
  for (const sym of ranged) {
    const id = `${sym.path}:${sym.name}`;
    nodes.set(id, sym);
    (byName.get(sym.name) ?? byName.set(sym.name, []).get(sym.name)!).push(id);
    (byFile.get(sym.path) ?? byFile.set(sym.path, []).get(sym.path)!).push(sym);
  }

  const edges = new Map<string, Map<string, number>>();
  const edgeKinds = new Map<string, Map<string, EdgeKind>>();
  for (const id of nodes.keys()) { edges.set(id, new Map()); edgeKinds.set(id, new Map()); }

  const addEdge = (src: string, dst: string, kind: EdgeKind, n = 1): void => {
    if (src === dst) return;
    const m = edges.get(src);
    if (!m) return;
    m.set(dst, (m.get(dst) ?? 0) + EDGE_WEIGHT[kind] * n);
    // An import edge outranks a call edge between the same pair.
    const k = edgeKinds.get(src)!;
    if (kind === "import" || !k.has(dst)) k.set(dst, kind);
  };

  const knownFiles = new Set(fileContents.keys());
  const identRe = /[A-Za-z_$][\w$]*/g;

  for (const [relPath, content] of fileContents) {
    const localSyms = byFile.get(relPath);
    if (!localSyms?.length) continue;

    // ── 1. Dependency edges from real import statements ────────────────────
    for (const spec of extractImports(content)) {
      const target = resolveImport(relPath, spec, knownFiles);
      if (!target || target === relPath) continue;
      for (const dst of byFile.get(target) ?? []) {
        for (const src of localSyms) {
          addEdge(`${src.path}:${src.name}`, `${dst.path}:${dst.name}`, "import");
        }
      }
    }

    // ── 2. Reference edges attributed to the ENCLOSING symbol ──────────────
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      // Cheap comment skip: a reference inside a comment is documentation,
      // not execution flow.
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
      const owner = localSyms.find((sm) => sm.startLine <= i + 1 && (sm.endLine ?? Infinity) > i + 1);
      if (!owner) continue;                         // top-level code, not in a symbol
      const srcId = `${owner.path}:${owner.name}`;
      identRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = identRe.exec(line)) !== null) {
        const targets = byName.get(m[0]);           // EXACT case
        if (!targets) continue;
        for (const dst of targets) {
          if (nodes.get(dst)?.path === relPath) continue;  // same-file: not a dependency
          addEdge(srcId, dst, "call");
        }
      }
    }
  }

  return { nodes, edges, edgeKinds };
}

/**
 * One-hop structural neighbours of a set of seed symbols.
 *
 * This is what turns the graph from a RANKING signal into a RETRIEVAL one.
 * PageRank already nudged globally-important symbols up the list, but it says
 * nothing about *this* query: a query that lands on `buildInvoiceTotals` should
 * pull in `chargeCreditCard` because the first one calls the second, not
 * because charging is popular repo-wide.
 *
 * Walking outward from the seeds along import and call edges is how the
 * pipeline answers "what else does the agent need in order to understand this
 * code" — dependencies and execution flow, rather than more text that happens
 * to share vocabulary.
 *
 * Returns `path:name -> weight`, where weight is the summed edge strength
 * (imports count 3, calls 1) so a hard dependency outranks a passing mention.
 * Outbound and inbound edges both count: callers of a matched function are as
 * relevant as its callees when the task is to change it.
 */
export async function getStructuralNeighbors(
  projectRoot: string,
  seedSymbols: { path: string; name: string }[],
  limit = 40,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (seedSymbols.length === 0) return out;
  const graph = await symbolGraphFor(projectRoot).catch(() => undefined);
  if (!graph) return out;

  const seedIds = new Set(seedSymbols.map((s) => `${s.path}:${s.name}`));

  for (const seedId of seedIds) {
    // Outbound: what this symbol depends on / calls.
    for (const [dst, w] of graph.edges.get(seedId) ?? []) {
      if (seedIds.has(dst)) continue;
      out.set(dst, (out.get(dst) ?? 0) + w);
    }
  }
  // Inbound: who depends on / calls this symbol. Scanning every adjacency list
  // is O(edges); the graph is cached per root and repo-sized, not web-sized.
  for (const [src, adj] of graph.edges) {
    if (seedIds.has(src)) continue;
    for (const seedId of seedIds) {
      const w = adj.get(seedId);
      if (w) out.set(src, (out.get(src) ?? 0) + w);
    }
  }

  if (out.size <= limit) return out;
  return new Map([...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
}
