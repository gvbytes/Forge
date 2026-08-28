// ── Code retrieval pipeline ────────────────────────────────────────────────
//
// The problem this is built against: dumping whole files does not fit a small
// model's context; keyword matching is too rigid; and general-purpose vector
// embeddings treat source as English prose, so they miss the things that
// actually decide what code an agent needs — dependencies and execution flow.
//
// So the index is structural, and search runs in two rounds that answer two
// different questions:
//
//   LEXICAL  — "what mentions this?"
//     1. query prep: identifier + backtick extraction, symbol-table expansion
//     2. BM25 (MiniSearch) with field boosts (symbols > path > body) and
//        prefix/fuzzy tolerance, over semantically-chunked source
//     3. PageRank over the symbol graph: globally important code ranks higher
//
//   STRUCTURAL — "what does this depend on, and what runs it?"
//     4. one-hop traversal of REAL edges out of the top lexical seeds:
//          import  — file A imports file B (weight 3): a hard dependency
//          call    — a symbol's body references another by exact name
//                    (weight 1): the closest thing to execution flow
//                    available without a type-resolved AST
//        Both directions count: the callers of a function matter as much as
//        its callees when the task is to change it.
//     5. co-occurrence expansion as the weaker fallback (shared vocabulary)
//
// Then packing and trimming, because precision is the point:
//     6. greedy chunk packing for coherent boundaries
//     7. diversity: <=3 chunks per file unless the query names that file
//     8. bounded previews (<=30 lines) — a file is NEVER dumped whole
//
// Why edges beat vocabulary: two files can both say `parse` without either
// depending on the other, while `runCheckoutFlow` and `authorizeTransaction`
// may share no token at all and yet one cannot run without the other. Round 4
// is what reaches the second case, and it is weighted above round 5 for
// exactly that reason.
//
// ISOLATION (PS 5b): every index is keyed by projectId and every symbol graph
// by project root, so retrieval and agent memory cannot cross between the
// folders a user has open. See test/project-isolation.test.ts, which asserts
// this against real indexes over real directories rather than mocks — the
// failure mode being guarded is a shared cache key, and a mock would share
// whatever key the test invented instead of the one the code uses.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import MiniSearch, { type AsPlainObject, type Options } from "minisearch";
import { DATA_DIR, ensureDataDir } from "./config.js";
import { trace } from "./trace.js";
import { getSymbolPageRanks, getStructuralNeighbors } from "./repomap.js";

// ── Public API ─────────────────────────────────────────────────────────────

export interface RetrievalHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  symbol?: string;
  preview: string;
}

export async function buildIndex(
  projectRoot: string,
  projectId: string
): Promise<{ files: number; chunks: number; ms: number }> {
  const t0 = Date.now();
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`retrieval: projectRoot is not a directory: ${root}`);
  }

  const walked = await collectFiles(root);
  const chunks: Chunk[] = [];
  for (const f of walked.files) {
    try {
      const src = await fsp.readFile(f.abs, "utf8");
      if (looksBinary(src)) continue;
      for (const span of chunkSpans(src)) {
        chunks.push(makeChunk(f.rel, src, span, chunks.length));
      }
    } catch {
      /* unreadable file (perms/race) — skip */
    }
  }

  const mini = new MiniSearch<MiniDoc>(miniOptions);
  mini.addAll(chunks.map(toMiniDoc));

  const meta: IndexMeta = {
    projectRoot: root,
    indexedAt: Date.now(),
    fileCount: walked.files.length,
    maxMtime: walked.maxMtime,
    chunkCount: chunks.length,
  };
  rememberIndex(projectId, hydrate(meta, chunks, mini));
  await persistIndex(projectId, { version: INDEX_VERSION, meta, chunks, mini: mini.toJSON() });

  return { files: walked.files.length, chunks: chunks.length, ms: Date.now() - t0 };
}

export async function ensureFresh(projectRoot: string, projectId: string): Promise<void> {
  const entry = getLoaded(projectId);
  const fp = await fingerprint(projectRoot);
  const drifted =
    !!entry &&
    !!fp &&
    (fp.count !== entry.meta.fileCount || fp.maxMtime !== entry.meta.maxMtime);
  if (!entry || drifted) {
    // Wave 25: inside a running task's window the agent's OWN writes drift the
    // fingerprint on every step — rebuilding there re-read the whole repo
    // before every step. Suppress drift rebuilds until the window closes; a
    // MISSING index still builds (first build is required for any retrieval).
    if (drifted && taskWindows.has(projectId)) return;
    await guardedBuild(projectRoot, projectId);
    return;
  }
  if (Date.now() - entry.meta.indexedAt >= STALE_MS) entry.meta.indexedAt = Date.now();
}

// ── Wave 25: task-window rebuild suppression ────────────────────────────────
// While a task runs, drift rebuilds are deferred (see ensureFresh). The window
// is opened/closed by the orchestrator around runTask; closing rebuilds ONCE
// if the fingerprint drifted while open.
const taskWindows = new Set<string>();

export function beginTaskWindow(projectId: string): void {
  taskWindows.add(projectId);
}

export async function endTaskWindow(projectId: string): Promise<void> {
  if (!taskWindows.delete(projectId)) return;
  const entry = getLoaded(projectId);
  if (!entry) return;
  const fp = await fingerprint(entry.meta.projectRoot);
  const drifted =
    !!fp && (fp.count !== entry.meta.fileCount || fp.maxMtime !== entry.meta.maxMtime);
  if (drifted) await guardedBuild(entry.meta.projectRoot, projectId);
}

/** Test hook: read the loaded index meta without triggering a disk rehydrate
 *  side effect beyond getLoaded's normal behavior. */
export function _indexMetaForTest(projectId: string): IndexMeta | undefined {
  return getLoaded(projectId)?.meta;
}

export async function retrieve(input: {
  projectId: string;
  query: string;
  k?: number;
  excludePaths?: string[];
  sessionId?: string; // when provided, a "retrieval" trace event is emitted
}): Promise<RetrievalHit[]> {
  const t0 = Date.now();
  const k = Math.max(1, Math.min(50, input.k ?? 8));
  let entry = getLoaded(input.projectId);
  if (!entry) {
    // R4: the post-open build is async (ensureFresh), so a query that lands while a
    // build is in flight used to silently get [] — no code context. Await the
    // in-flight build instead of dropping the retrieval.
    const building = inflight.get(input.projectId);
    if (building) {
      try {
        await building;
      } catch {
        /* build failed → fall through to empty result */
      }
      entry = getLoaded(input.projectId);
    }
  }
  if (!entry || entry.chunks.length === 0) return [];

  // Opportunistic refresh: serve current index, rebuild behind the scenes if stale.
  if (Date.now() - entry.meta.indexedAt >= STALE_MS && fs.existsSync(entry.meta.projectRoot)) {
    void guardedBuild(entry.meta.projectRoot, input.projectId).catch(() => {});
  }

  const { q, terms } = prepareQuery(input.query, entry.symbols);
  if (!terms.length) return [];

  // Oversized pool leaves room for the graph pass + diversity filtering.
  const poolSize = Math.max(k * 3, 24);
  const results = entry.mini.search(q.length ? q : input.query, SEARCH_OPTS);
  if (results.length === 0) return [];

  const excl = (input.excludePaths ?? []).map(normalizeRel).filter(Boolean);

  const pool = results
    .slice(0, poolSize)
    .flatMap((r) => {
      const chunk = entry.byId.get(String(r.id));
      if (!chunk || isExcluded(chunk.path, excl)) return [];
      return [{ r, chunk }];
    });

  // ── PageRank boost from repomap ──────────────────────────────────────────
  let pageRanks = new Map<string, number>();
  try {
    if (fs.existsSync(entry.meta.projectRoot)) {
      pageRanks = await getSymbolPageRanks(entry.meta.projectRoot, input.query);
    }
  } catch {
    // PageRank boost is best-effort
  }

  // ── Structural expansion: walk real import / call edges ──────────────────
  //
  // The co-occurrence round below promotes chunks that share VOCABULARY with
  // the seeds. This round promotes chunks the seeds actually DEPEND ON or are
  // called by — the dependency and execution-flow signal that keyword matching
  // and plain embeddings both miss. A query landing on `buildInvoiceTotals`
  // pulls in `chargeCreditCard` because one calls the other, not because they
  // share tokens.
  let structural = new Map<string, number>();
  try {
    if (fs.existsSync(entry.meta.projectRoot)) {
      const seedSyms = pool.slice(0, SEED_COUNT).flatMap((p2) =>
        p2.chunk.symbols.map((n) => ({ path: p2.chunk.path, name: n })),
      );
      structural = await getStructuralNeighbors(entry.meta.projectRoot, seedSyms);
    }
  } catch {
    // Best-effort: a graph failure must degrade to lexical retrieval, never
    // fail the query — an agent with weaker context still works.
  }
  const structuralMax = structural.size ? Math.max(...structural.values()) : 0;

  // ── Symbol graph boost: co-occurrence expansion round ────────────────────
  const seeds = pool.slice(0, SEED_COUNT);
  const bestSeed = seeds.length ? seeds[0]!.r.score : 0;
  const seen = new Set(pool.map((p) => p.chunk.id));
  const promoted: { r: { id: string; score: number }; chunk: Chunk; score: number }[] = [];
  const mentionCount = new Map<string, number>(); // lowercase symbol -> #seeds mentioning it

  for (const s of seeds) {
    const mentioned = new Set(tokenizeIdents(s.chunk.text).filter((t) => entry.symbols.has(t)));
    for (const t of mentioned) mentionCount.set(t, (mentionCount.get(t) ?? 0) + 1);
  }

  for (const c of entry.chunks) {
    if (promoted.length >= MAX_PROMOTED) break;
    if (!c.symbols.length || seen.has(c.id)) continue;

    // Structural first: a real edge is stronger evidence than shared wording.
    let structuralW = 0;
    for (const symName of c.symbols) {
      const w = structural.get(`${c.path}:${symName}`) ?? 0;
      if (w > structuralW) structuralW = w;
    }
    if (structuralW > 0) {
      const strength = structuralMax > 0 ? structuralW / structuralMax : 0;
      promoted.push({
        r: { id: c.id, score: 0 },
        chunk: c,
        // Weighted above co-occurrence: STRUCTURAL_BOOST > SYMBOL_GRAPH_BOOST.
        score: STRUCTURAL_BOOST * bestSeed * strength,
      });
      seen.add(c.id);
      continue;
    }

    const mentions = mentionCount.get(c.symbols[0]!.toLowerCase()) ?? 0;
    if (mentions > 0) {
      const strength = Math.min(1, mentions / 3);
      promoted.push({
        r: { id: c.id, score: 0 },
        chunk: c,
        score: SYMBOL_GRAPH_BOOST * bestSeed * strength,
      });
    }
  }

  // Combine lexical BM25 score, PageRank boost, and co-occurrence boost
  const ranked = [
    ...pool.map((p) => {
      let prBoost = 0;
      for (const sym of p.chunk.symbols) {
        const pr = pageRanks.get(`${p.chunk.path}:${sym}`) ?? pageRanks.get(sym) ?? 0;
        if (pr > prBoost) prBoost = pr;
      }
      return {
        ...p,
        score: p.r.score * (1.0 + prBoost * 5.0),
      };
    }),
    ...promoted.map((p) => {
      let prBoost = 0;
      for (const sym of p.chunk.symbols) {
        const pr = pageRanks.get(`${p.chunk.path}:${sym}`) ?? pageRanks.get(sym) ?? 0;
        if (pr > prBoost) prBoost = pr;
      }
      return {
        ...p,
        score: p.score * (1.0 + prBoost * 5.0),
      };
    }),
  ].sort((a, b) => b.score - a.score);

  // ── Diversity + projection ────────────────────────────────────────────────
  const ql = input.query.toLowerCase();
  const perFile = new Map<string, number>();
  const hits: RetrievalHit[] = [];

  for (const c of ranked) {
    const p = c.chunk.path;
    const named = ql.includes(p.toLowerCase()) || ql.includes(path.posix.basename(p).toLowerCase());
    const n = perFile.get(p) ?? 0;
    if (!named && n >= PER_FILE_CAP) continue;
    perFile.set(p, n + 1);
    const head = c.chunk.symbols[0];
    hits.push({
      path: p,
      startLine: c.chunk.startLine,
      endLine: c.chunk.endLine,
      score: Math.round(c.score * 10000) / 10000,
      symbol: head || undefined,
      preview: c.chunk.text.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n"),
    });
    if (hits.length === k) break;
  }

  if (input.sessionId) {
    trace.emit({
      sessionId: input.sessionId,
      spanId: `ret-${++traceSeq}`,
      kind: "retrieval",
      agentRole: "explorer",
      label: `${hits.length} hits for "${input.query.slice(0, 80)}"`,
      input: { query: input.query, k, excludePaths: input.excludePaths },
      output: hits.map((h) => ({ path: h.path, startLine: h.startLine, endLine: h.endLine, score: h.score })),
      durationMs: Date.now() - t0,
    });
  }
  return hits;
}

export function stats(
  projectId: string
): { files: number; chunks: number; indexedAt?: number } | undefined {
  const mem = getLoaded(projectId);
  if (!mem) return undefined;
  return { files: mem.meta.fileCount, chunks: mem.chunks.length, indexedAt: mem.meta.indexedAt };
}

// ── Internal shapes ────────────────────────────────────────────────────────

interface Chunk {
  id: string; // stable within one build, referenced by MiniSearch postings
  path: string; // posix-style, relative to project root
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  text: string;
  symbols: string[]; // def names inside chunk; [0] is the headline symbol
}

interface MiniDoc {
  id: string;
  text: string;
  path: string;
  symbols: string;
}

interface IndexMeta {
  projectRoot: string;
  indexedAt: number;
  fileCount: number;
  maxMtime: number;
  chunkCount: number;
}

interface PersistedIndex {
  version: 1;
  meta: IndexMeta;
  chunks: Chunk[];
  mini: AsPlainObject;
}

interface CacheEntry {
  meta: IndexMeta;
  chunks: Chunk[];
  byId: Map<string, Chunk>;
  symbols: Map<string, number>; // lowercase symbol -> document frequency
  mini: MiniSearch<MiniDoc>;
}

// ── Tunables ───────────────────────────────────────────────────────────────

const INDEX_VERSION = 1;
const STALE_MS = 10 * 60_000;
const MAX_FILE_BYTES = 300 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".next", "__pycache__", ".venv", "target", "vendor"]);
const LOCK_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "cargo.lock", "poetry.lock"]);
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "flac", "ogg", "mp4", "mov", "avi", "webm", "mkv",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "br", "7z", "rar", "tar",
  "jar", "war", "class", "exe", "dll", "so", "dylib", "bin", "dat",
  "obj", "o", "a", "lib", "pdb", "wasm", "pyc", "pyo", "pyd",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "db", "sqlite", "sqlite3", "mdb", "deb", "rpm", "apk", "map", "lockb",
]);

export const CODE_EXTS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  ".rs",
  ".go",
  ".java", ".kt", ".kts",
  ".cs",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".rb", ".php", ".swift", ".scala",
  ".sh", ".bash", ".zsh",
  ".sql", ".html", ".css", ".json", ".yaml", ".yml", ".toml", ".md",
]);

const TARGET_LINES = 40; // chunk sweet spot
const MIN_DEF_SPLIT = 24; // don't cut at a def boundary before this many lines
const HARD_LINES = 80; // force-split ceiling
const PARAGRAPH_TARGET = TARGET_LINES;
const PREVIEW_MAX_LINES = 30;
const PER_FILE_CAP = 3;
const SEED_COUNT = 8;
const SYMBOL_GRAPH_BOOST = 0.35;
/**
 * Structural expansion outranks co-occurrence.
 *
 * A shared identifier is weak evidence — two files can mention `parse` without
 * either depending on the other. An import or call edge is a fact about the
 * program: the seed cannot be understood, or cannot run, without the target.
 * Weighted ~1.7x the lexical round so a genuine dependency displaces a
 * vocabulary coincidence when both compete for the same slot.
 */
const STRUCTURAL_BOOST = 0.6;
const MAX_EXPANSIONS = 8;
const MAX_PROMOTED = 12;

const SEARCH_OPTS = {
  prefix: true,
  fuzzy: 0.2,
  combineWith: "OR" as const,
  boost: { symbols: 2.2, path: 1.6 },
  weights: { fuzzy: 0.45, prefix: 0.65 },
  boostTerm: (term: string): number => (term.length <= 2 ? 0.15 : 1),
};

const miniOptions: Options<MiniDoc> = {
  fields: ["text", "path", "symbols"],
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ files: number; chunks: number; ms: number }>>();
let traceSeq = 0;

// R2: bound the in-memory index cache. Each entry holds every chunk + the
// MiniSearch index, so an unbounded Map grows with every project ever opened.
// Eviction is safe: getLoaded() rehydrates from the persisted index on demand.
const INDEX_CACHE_MAX = 8;
function rememberIndex(projectId: string, entry: CacheEntry): CacheEntry {
  cache.delete(projectId); // re-insert below → marks most-recently-used
  cache.set(projectId, entry);
  while (cache.size > INDEX_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

/** Test hook: number of indexes resident in the in-memory cache (R2). */
export function _cacheSize(): number {
  return cache.size;
}
/** Test hook: register an in-flight build promise to exercise the R4 await path
 * deterministically. Auto-removes itself from `inflight` when it settles. */
export function _setInflightForTest(
  projectId: string,
  p: Promise<{ files: number; chunks: number; ms: number }>,
): void {
  const wrapped = p.finally(() => {
    if (inflight.get(projectId) === wrapped) inflight.delete(projectId);
  });
  inflight.set(projectId, wrapped);
}

// ── Module state helpers ───────────────────────────────────────────────────

function guardedBuild(
  root: string,
  projectId: string
): Promise<{ files: number; chunks: number; ms: number }> {
  const running = inflight.get(projectId);
  if (running) return running;
  const p = buildIndex(root, projectId).finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
  return p;
}

function hydrate(meta: IndexMeta, chunks: Chunk[], mini: MiniSearch<MiniDoc>): CacheEntry {
  const byId = new Map<string, Chunk>();
  const symbols = new Map<string, number>();
  for (const c of chunks) {
    byId.set(c.id, c);
    for (const s of new Set(c.symbols.map((x) => x.toLowerCase()))) {
      symbols.set(s, (symbols.get(s) ?? 0) + 1);
    }
  }
  return { meta, chunks, byId, symbols, mini };
}

function getLoaded(projectId: string): CacheEntry | undefined {
  const mem = cache.get(projectId);
  if (mem) return rememberIndex(projectId, mem);
  const persisted = readIndexFromDisk(projectId);
  if (!persisted) return undefined;
  const mini = MiniSearch.loadJSON<MiniDoc>(JSON.stringify(persisted.mini), miniOptions);
  return rememberIndex(projectId, hydrate(persisted.meta, persisted.chunks, mini));
}

function indexPath(projectId: string): string {
  return path.join(DATA_DIR, "projects", projectId, "index.json");
}

async function persistIndex(projectId: string, data: PersistedIndex): Promise<void> {
  ensureDataDir();
  const file = indexPath(projectId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data));
}

function readIndexFromDisk(projectId: string): PersistedIndex | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(projectId), "utf8")) as PersistedIndex;
    if (
      parsed &&
      parsed.version === INDEX_VERSION &&
      Array.isArray(parsed.chunks) &&
      parsed.meta &&
      parsed.mini
    ) {
      return parsed;
    }
  } catch {
    /* missing/corrupt index */
  }
  return undefined;
}

// ── Walking & filtering ────────────────────────────────────────────────────

interface Fingerprint {
  count: number;
  maxMtime: number;
}

async function collectFiles(
  root: string
): Promise<{ files: { rel: string; abs: string; mtime: number }[]; maxMtime: number }> {
  const allRel = await walkProject(root);
  const candidates = allRel.filter((rel) => !isSkippablePath(rel));
  const files: { rel: string; abs: string; mtime: number }[] = [];
  let maxMtime = 0;
  const CHUNK_SIZE = 50;

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(async (rel) => {
        const abs = path.join(root, rel);
        try {
          const st = await fsp.stat(abs);
          if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
          return { rel, abs, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) {
        if (r.mtime > maxMtime) maxMtime = r.mtime;
        files.push(r);
      }
    }
  }
  return { files, maxMtime };
}

async function fingerprint(root: string): Promise<Fingerprint | undefined> {
  try {
    const { files, maxMtime } = await collectFiles(root);
    return { count: files.length, maxMtime };
  } catch {
    return undefined;
  }
}

async function walkProject(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true });
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
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function isSkippablePath(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return true;
  if (base.endsWith(".lock") || LOCK_NAMES.has(base)) return true;
  if (/\.min\.[jt]sx?$/.test(base) || base.endsWith(".min.css")) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = base.slice(dot).toLowerCase();
  if (BINARY_EXTS.has(ext.slice(1))) return true;
  return false;
}

function looksBinary(src: string): boolean {
  if (src.includes("\u0000")) return true;
  const replacements = src.split("\uFFFD").length - 1;
  if (replacements > 0 && replacements * 1000 > src.length) return true;
  for (const line of src.split("\n")) {
    if (line.length > 2000) return true;
  }
  return false;
}

// ── Semantic chunking with greedy chunk packing ─────────────────────────────

const DEF_LINE_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:function|class|def|fn|func|impl|struct|interface|enum|trait|record)\b/;
const JAVA_MEMBER_RE =
  /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|synchronized|native)\s+)+[\w<>[\],.?]\s*[\w<>[\],.?\s]*\s+\w+\s*\(/;
const C_MEMBER_RE =
  /^\s*(?:(?:virtual|static|inline|explicit|friend|const)\s+)*[\w:*&<>]+\s+\w+\s*\([^;{)]*\)\s*(?:const)?\s*\{/;
const DEF_NAME_RES = [
  /\b(?:function|class|struct|interface|enum|trait|record|impl)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:def|fn|func)\s+([A-Za-z_][\w]*)/,
];

interface Span {
  start: number; // 0-based inclusive
  end: number; // 0-based exclusive
}

/** Greedy chunk packing: pack raw source into balanced, coherent ~TARGET_LINES spans */
export function chunkSpans(src: string): Span[] {
  const lines = src.split(/\r?\n/);
  const defLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (DEF_LINE_RE.test(lines[i]!) || JAVA_MEMBER_RE.test(lines[i]!) || C_MEMBER_RE.test(lines[i]!)) {
      defLines.add(i);
    }
  }

  const spans: Span[] = [];
  if (defLines.size === 0) return packParagraphs(lines);

  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    const len = i - start;
    if (defLines.has(i) && len >= MIN_DEF_SPLIT) {
      const cut = liftDecorators(lines, i, start);
      spans.push({ start, end: cut });
      start = cut;
    } else if (len >= HARD_LINES) {
      const cut = backToBlank(lines, start, i);
      spans.push({ start, end: cut });
      start = cut;
    }
  }
  if (start < lines.length) spans.push({ start, end: lines.length });

  // Greedy merge: merge adjacent small spans that fit under TARGET_LINES
  return greedyPackSpans(spans.filter((s) => s.end > s.start));
}

function greedyPackSpans(rawSpans: Span[]): Span[] {
  if (rawSpans.length <= 1) return rawSpans;
  const packed: Span[] = [];
  let cur = rawSpans[0]!;

  for (let i = 1; i < rawSpans.length; i++) {
    const next = rawSpans[i]!;
    const combinedLen = next.end - cur.start;
    if (combinedLen <= TARGET_LINES) {
      cur = { start: cur.start, end: next.end };
    } else {
      packed.push(cur);
      cur = next;
    }
  }
  packed.push(cur);
  return packed;
}

function liftDecorators(lines: string[], at: number, floor: number): number {
  let cut = at;
  while (cut - 1 > floor && /^\s*@/.test(lines[cut - 1]!)) cut--;
  return cut;
}

function backToBlank(lines: string[], start: number, at: number): number {
  const lo = Math.max(start + TARGET_LINES, 1);
  for (let j = at; j >= lo; j--) {
    if (lines[j]!.trim() === "") return j + 1;
  }
  return at;
}

function packParagraphs(lines: string[]): Span[] {
  const blocks: Span[] = [];
  let bs = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "") {
      if (i > bs) blocks.push({ start: bs, end: i });
      bs = i + 1;
    }
  }
  if (bs < lines.length) blocks.push({ start: bs, end: lines.length });

  const spans: Span[] = [];
  let cs = -1;
  let ce = -1;
  for (const b of blocks) {
    const blen = b.end - b.start;
    if (cs < 0) {
      cs = b.start;
      ce = b.end;
    } else if (ce - cs + blen <= PARAGRAPH_TARGET) {
      ce = b.end;
    } else {
      spans.push({ start: cs, end: ce });
      cs = b.start;
      ce = b.end;
    }
    while (ce - cs >= HARD_LINES) {
      spans.push({ start: cs, end: cs + HARD_LINES });
      cs += HARD_LINES;
    }
  }
  if (cs >= 0) spans.push({ start: cs, end: ce });
  return greedyPackSpans(spans);
}

function makeChunk(relPath: string, src: string, span: Span, seq: number): Chunk {
  const lines = src.split(/\r?\n/);
  const text = lines.slice(span.start, span.end).join("\n");
  const symbols: string[] = [];
  for (let i = span.start; i < span.end; i++) {
    for (const re of DEF_NAME_RES) {
      const m = re.exec(lines[i]!);
      if (m && m[1] && !symbols.includes(m[1])) {
        symbols.push(m[1]);
        break;
      }
    }
  }
  return {
    id: `c${seq}`,
    path: relPath,
    startLine: span.start + 1,
    endLine: span.end,
    text,
    symbols,
  };
}

function toMiniDoc(c: Chunk): MiniDoc {
  const expanded = c.symbols.flatMap((s) => [s, ...camelParts(s)]);
  return {
    id: c.id,
    text: c.text,
    path: c.path,
    symbols: [...new Set(expanded)].join(" "),
  };
}

// ── Query preparation (identifiers + symbol-table expansion) ───────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "does", "did", "what", "when", "where",
  "which", "this", "that", "these", "those", "from", "into", "about", "should",
  "could", "would", "can", "you", "your", "our", "are", "was", "were", "has",
  "have", "had", "but", "all", "any", "some", "its", "there", "here", "then",
  "than", "also", "just", "like", "please", "need", "want", "she", "him",
  "his", "her", "not", "who", "why", "will", "may", "might", "must", "shall",
]);

function prepareQuery(
  raw: string,
  symbolTable: Map<string, number>
): { q: string; terms: string[] } {
  const terms: string[] = [];
  const push = (t: string) => {
    const low = t.toLowerCase();
    if (low.length >= 2 && !STOPWORDS.has(low) && !terms.some((x) => x.toLowerCase() === low)) {
      terms.push(t);
    }
  };

  for (const m of raw.matchAll(/`([^`]+)`/g)) {
    const g = m[1];
    if (g) push(g);
  }
  for (const m of raw.matchAll(/[A-Za-z_$][\w$]*|[\w-]+\.[\w.-]+/g)) push(m[0]);

  const base = terms.map((t) => t.toLowerCase());
  let added = 0;
  outer: for (const t of base) {
    if (t.length < 3) continue;
    for (const sym of symbolTable.keys()) {
      if (sym === t || added >= MAX_EXPANSIONS) continue;
      const related =
        (sym.startsWith(t) && sym.length > t.length) ||
        (t.startsWith(sym) && sym.length >= 4 && sym.length < t.length);
      if (related && !base.includes(sym)) {
        push(sym);
        added++;
        if (added >= MAX_EXPANSIONS) break outer;
      }
    }
  }

  return { q: terms.join(" "), terms };
}

function camelParts(w: string): string[] {
  return w
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length >= 3)
    .map((p) => p.toLowerCase())
    .filter((p) => p !== w.toLowerCase());
}

function tokenizeIdents(text: string): string[] {
  return (text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).map((t) => t.toLowerCase());
}

// ── Exclusion filters ──────────────────────────────────────────────────────

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function isExcluded(candidate: string, patterns: string[]): boolean {
  return patterns.some((e) => {
    if (e.startsWith("*")) return candidate.endsWith(e.slice(1));
    if (e.endsWith("/*")) return candidate.startsWith(e.slice(0, -1));
    return candidate === e || candidate.startsWith(`${e}/`);
  });
}
