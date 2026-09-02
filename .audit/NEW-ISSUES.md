# NEW-ISSUES — found during wave-2b wait (retrieval-pipeline audit)

Scope note: these are NEW findings beyond the original 44 (B1–B44) + E1–E5. They
concern the semantic code-retrieval pipeline (`engine/src/retrieval.ts`,
`repomap.ts`) and project isolation (`sessions.ts`), which the original audit did
not cover. `repomap.ts` / `retrieval.ts` are OUTSIDE wave-2b's file scope, so the
R1 fix below does not conflict with the running engine agent.

## What the pipeline already does (answering "is this implemented?")
YES — substantially. It deliberately avoids the two anti-patterns in the brief:
- NOT "dump whole files": `retrieve()` returns ≤k chunks with previews capped at
  30 lines (`PREVIEW_MAX_LINES`), never full files.
- NOT "standard vector embeddings over code-as-English": it uses
  (1) semantic chunking at def boundaries + greedy packing (`chunkSpans`),
  (2) per-chunk symbol extraction + camelCase splitting,
  (3) BM25 (MiniSearch) with field boosts symbols>path>body + prefix/fuzzy,
  (4) a symbol def→reference graph + query-personalized PageRank (`repomap.ts`)
      that captures dependency/importance structure naive embeddings miss,
  (5) co-occurrence expansion + per-file diversity cap.
- Per-project isolation: `projectId = sha1(abs root).slice(0,12)`; index persisted
  to `DATA_DIR/projects/<pid>/index.json`, sessions to
  `DATA_DIR/projects/<pid>/sessions/`, in-memory cache keyed by pid. `retrieve()`
  only ever reads its own pid's index (verified: unknown pid → []).

## R1 — FIXED: per-query full-repo re-scan for the PageRank boost (perf)
`retrieve()` (runs on EVERY chat turn + task) and `computeRepoMap()` called
`getSymbolPageRanks()`/`extractProjectSymbols()`, which walk + read + regex-parse
the WHOLE repo and rebuild the symbol graph + run up-to-100-iteration PageRank on
EVERY query — zero caching. O(repo) work per message; on large codebases this
makes "highly precise search" slow.
Fix (repomap.ts): query-independent symbol graph now cached per project root,
invalidated by a stat-only fingerprint (file count + maxMtime), memory-bounded to
8 projects, with in-flight dedupe. Output is byte-identical; only recomputation is
removed. Locked by `engine/test/retrieval.test.ts` (7 tests: determinism, cache
invalidation on file-add, chunking bounds, per-project isolation, bounded previews).

## R2 — FIXED (low): unbounded in-memory retrieval index cache
`retrieval.ts` `cache: Map<projectId, CacheEntry>` never evicted; each entry holds
all chunks + the MiniSearch index → memory growth across opened projects.
Fix: `rememberIndex()` enforces an LRU cap of 8 (delete+re-insert marks recency,
evicts least-recently-used). Eviction is safe — `getLoaded()` rehydrates from the
persisted index on demand. Locked by retrieval.test.ts (build 10 → cache ≤ 8 →
evicted project still retrieves via disk rehydration).

## R3 — RECLASSIFIED: not a bug (working as designed) — NO code change
Initial read flagged the `currentProjectRoot` fallback as a "soft isolation leak".
Deeper investigation REVERSES that: the fallback is LOAD-BEARING for the web UI's
single-active-project model. web/src/lib/api.ts does NOT send projectId on most
calls — createTask sends `path`, and fileTree/writeFile/runFile/readFile/pins/etc.
send nothing; they all rely on the engine resolving the currently-open project.
Removing/strictening the fallback would break the entire web frontend.
Crucially, the ACTUAL spec requirement ("separate index per project; code context,
retrieval, and agent memory do not leak between projects") IS satisfied: the index,
sessions, and agent memory are all stored under `DATA_DIR/projects/<projectId>/…`
(pid = sha1 of the root), and `retrieve()` only ever reads its own pid's data
(verified: unknown pid → []). The fallback selects the ACTIVE project; it does not
mix one project's index/memory into another's. No change made. If stricter
multi-project isolation is ever wanted, it is a coordinated web+engine design change
(send projectId on every call), not a one-line fix.

## R4 — FIXED (low): silent empty retrieval on fresh-open race
`retrieve()` returned `[]` if the index wasn't loaded yet; the post-open build is
async (`void ensureFresh(...)`), so a query fired right after opening a project
silently got no code context. Fix: when `getLoaded()` misses, `retrieve()` now
awaits any in-flight build (`inflight.get(projectId)`) and retries, so the first
query after open gets real context. Locked by retrieval.test.ts (gated in-flight
build → retrieve returns hits, not []).
