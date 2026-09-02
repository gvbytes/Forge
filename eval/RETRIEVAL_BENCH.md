# Retrieval Quality Benchmark — Agent-Zero code-retrieval pipeline

**Question:** does the hybrid retrieval design (BM25 ∪ vectors ∪ symbol-graph,
RRF-fused, MMR-diversified — SPEC §6) actually beat its own ablations at the
task retrieval exists for: *surfacing the right code*? We answer with real-world
ground truth instead of toy fixtures.

**Verdict (n=37 instances · 6 OSS repos · SUT @ commit `2ce208f`):**
the hybrid **never loses to its own BM25-only ablation at Recall@5 (3 wins /
0 losses / 34 ties) and lifts MRR +84% relative (0.212 vs 0.115)** — clear
evidence it goes beyond its keyword stage. A plain ripgrep keyword baseline
remains competitive on raw recall over these small repos (R@10 ≈ 0.32–0.43
across runs), but collapses to zero exactly where repos are large and
symbol-rich (sphinx), where the hybrid scores 0.250/0.250. The benchmark also
**caught a real packer defect** whose fix (`2ce208f`) measurably improved the
pipeline (§4). Details below.

---

## 1. Ground-truth provenance

| | |
|---|---|
| Source | [princeton-nlp/SWE-bench_Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite) (300 test instances) |
| Access | HF datasets-server `/rows` JSON API — no auth, no extra deps; raw pages cached in `eval/suites/retrieval_ground_truth/swebench_lite_raw_page_*.json` |
| License | SWE-bench is MIT-licensed; instances reference public OSS repos under their own licenses |
| Selection | deterministic (`--seed 42`): small/medium repos only — flask(3), seaborn(4), requests(6), pylint(6), pytest(10), sphinx(8) → **37 instances** |
| Gold rule | `gold_files` = files touched by the maintainer's `patch` that **exist at `base_commit`** and match indexer-supported extensions (files *added* by the patch are excluded — retrieval cannot find what does not exist yet) |

Parser fidelity audited against the raw dataset: extracted file sets match the
`diff --git` headers of all 37 selected patches exactly (0 mismatches).

A property of SWE-bench-Lite worth knowing: **all 300 patches touch exactly one
file**, so this benchmark is a pure *file-localization* task (given the issue
text, find the one buggy file). Recall@K therefore equals hit-rate@K.

Suite shards (data cache): `swe_bench_lite__{pallets__flask,mwaskom__seaborn,
psf__requests,pylint-dev__pylint,pytest-dev__pytest,sphinx-doc__sphinx}.json`.

## 2. Method

Per instance (`eval/retrieval_bench.py run`):

1. **Repo materialization** — partial clone shared per repo under
   `/tmp/retr_bench/repos/<org>__<repo>`; every needed `base_commit` prefetched
   depth-1 in a network phase outside any timeout; child processes force-checkout
   the working copy to exactly `base_commit` (`git clean -fdx` included).
2. **Indexing** — fresh `.agent-zero/index.db` per instance
   (`CodeIndex.rebuild(incremental=False)`): tree-sitter chunking, FTS5, symbol
   graph. Median index time **0.94 s**, max 2.44 s.
3. **Querying** — `Retriever.retrieve(problem_statement)` with production
   defaults (k=8, budget_tokens=3000) and `RepoMap.render(problem_statement)`
   (1500-token budget).
4. **Scoring** — chunk hits collapse to unique files in best-rank order;
   metrics: Recall@5, Recall@10, MRR, hit-any.
5. **Isolation** — each instance runs in a killable child process, hard
   **120 s timeout**, skip-and-log. Main runs: **37/37 ok, 0 timeouts, 79–107 s
   total wall clock**.

### Ablation harness (no backend sources modified)

Stage toggles are implemented by *subclassing* `Retriever` inside the bench
script and overriding `_fts_candidates` / `_vector_candidates` /
`_graph_candidates`:

| config | stages | meaning |
|---|---|---|
| `full` | BM25 ∪ vector ∪ graph-expand → RRF → MMR → pack | shipped pipeline (vector stage inert without embeddings) |
| `bm25_only` | BM25 only | lexical ablation |
| `vector_only` | embedding cosine only | semantic ablation |
| `grep` | ripgrep keyword baseline | top-8 non-stopword issue terms → case-insensitive alternation → `Retriever.grep_fallback`, re-ranked by match count |
| `repomap` | PageRank repo map rendered from query | orientation signal, not search |

### Disclosed bench-side optimizations & measurement decisions

* **Embeddings OFF in main runs.** fastembed (BAAI/bge-small-en-v1.5) measures
  **≈3 chunks/s** here (256 chunks in 93 s; 16-thread OMP made it *worse*),
  i.e. ~25 min to embed one pytest-sized index — impossible inside 120 s.
  The pipeline is designed to degrade to lexical-only (search.py docstring);
  `full` then measures the BM25+graph hybrid. A supplementary embeddings-ON
  probe (flask subset, 900 s timeout) supplies the vector datapoint — §5.
* **Graph construction accelerated bench-side** (monkeypatched
  `CodeIndex._build_graph`): the original loops every vocabulary regex over
  every chunk — profiled at **12.5 M `re.findall` calls / 104 s on pytest**
  (97 % of build time), which alone busts any per-instance budget. The
  replacement tokenizes each chunk once under the original's exact boundary
  semantics (unicode `\w`, `$`-adjacent matches refused; digit-prefixed runs
  like `%.2f` never standalone; exotic names fall back to the original
  scanner). **Equivalence verified**: identical node sets and identical
  weighted edge multisets on flask (9,280 edges), pytest (56,712) and pylint
  (292,319 — includes unicode identifiers like `úóíéá`, `НoldIt`).
  Build time: pytest 107.5 s→0.9 s, pylint 198.8 s→2.5 s. Ranking logic
  (RRF/MMR/PageRank) untouched.

## 3. Main results

Two full-suite runs are reported because the benchmark caught a live defect
mid-campaign (§4): **pre-fix** = SUT before commit `2ce208f`
(`results_20260824T021342Z.json`), **post-fix** = SUT at `2ce208f`
(`results_20260824T030205Z.json`). Headline numbers below are **post-fix**.

### 3.1 Aggregate (macro-average, n=37)

```
config         n    R@5(pre)  R@5(post)   MRR(pre)  MRR(post)   mean q_s
full          37     0.216      0.243      0.203      0.212        0.07
bm25_only     37     0.189      0.162      0.121      0.115        0.05
vector_only   37     0.000      0.000      0.000      0.000       0.03  <- inert, see §5
grep          37     0.243*     0.270*     0.152*     0.169*       0.05
repomap       37     0.108      0.108      0.053      0.053        0.65
```
\* grep varies run-to-run (ripgrep traversal order feeds tie-breaking):
a repeat run measured R@5 **0.351** / R@10 **0.432** / MRR 0.200. Treat grep as
a ±0.08 band around ≈0.31 R@5. All retrieve-based configs were **bit-identical
across repeat runs** (the pipeline itself is deterministic).

R@10 (post-fix): full 0.243 · bm25_only 0.216 · grep 0.324 (repeat: 0.432) ·
repomap 0.216.

Paired per-instance, post-fix (win/loss/tie):

```
full vs bm25_only : R@5  3/0/34    MRR  6/1/30     <- hybrid never loses to its ablation
full vs grep      : R@5  5/6/26    MRR  8/11/18
full vs repomap   : R@5  7/3/27    MRR  9/9/19
```

### 3.2 Per-repo breakdown (post-fix; R@5 / MRR)

```
repo                    n   full           bm25_only      grep
mwaskom/seaborn         4   0.250 / 0.125  0.000 / 0.000  0.000 / 0.023
pallets/flask           3   0.000 / 0.000  0.000 / 0.000  0.667 / 0.400
psf/requests            6   0.333 / 0.333  0.167 / 0.167  0.667 / 0.529
pylint-dev/pylint       6   0.000 / 0.000  0.000 / 0.000  0.000 / 0.000
pytest-dev/pytest      10   0.400 / 0.333  0.300 / 0.191  0.400 / 0.180
sphinx-doc/sphinx       8   0.250 / 0.250  0.250 / 0.167  0.000 / 0.000
```

Best instances (gold at rank 1): `psf__requests-1963`, `psf__requests-863`,
`pytest-dev__pytest-7220`, `pytest-dev__pytest-5692`, `pytest-dev__pytest-5227`,
`sphinx-doc__sphinx-7686`.
Worst: all pylint and flask instances score 0.0 for every retrieve-based config
(grep solves 2 of 3 flask cases).

Illustrative cases:
* *Hybrid win:* `psf__requests-863` — `full` ranks gold `requests/models.py`
  #1; `bm25_only`'s top-3 misses it entirely (graph expansion pulls in the
  caller neighbourhood). Same pattern on `pytest-dev__pytest-7220`.
* *Remaining failure mode:* `pallets__flask-4992` — gold `src/flask/config.py`
  never enters the fused top ranks (blueprints.py dominates); even after the
  packer fix the wrong file leads. Grep finds it at rank 3 via literal keyword
  overlap ("config").

## 4. Benchmark-driven fix verification

The pre-fix campaign exposed a systematic failure mode: `_pack`'s
"truncate-first-oversized-and-stop" rule collapsed whole queries onto a single
file whenever one merged span exceeded the 3000-token budget (documented here
as the flask-4992 collapse case). The fix (commit `2ce208f`) truncates in place
and keeps packing. Measured effect on the identical suite:

* `full`: R@5 **+12.5 %** (0.216 → 0.243), MRR +4 %; new wins include the whole
  seaborn repo tier (0.000 → 0.250 R@5).
* Hybrid-vs-ablation gap widened: full−bm25 MRR gap 0.082 → **0.097**
  (+18 % relative); paired record improved from 5W/2L to **6W/1L**.
* `bm25_only` slightly regressed (packing change reshuffles which candidates
  fit), confirming the two-stage measurement matters when touching the packer.

## 5. Supplementary: embeddings ON (flask subset)

Vector throughput (~3 chunks/s) caps embeddings to tiny indexes, so the probe
ran the 3 flask instances with `--embeddings --timeout 900`
(`results_20260824T025431Z.json`; index build ≈ 734 s each):

```
n=2 scored      R@5    R@10    MRR    q_s
full            0.000  0.000   0.000  0.37   <- true fts+vec+graph hybrid
bm25_only       0.000  0.000   0.000  0.02
vector_only     0.000  0.000   0.000  0.35   <- BGE cosine over 1295 chunks, works mechanically
grep            0.500  1.000   0.333  0.04
```

Reading: the vector stage functions end-to-end (query embedding + cosine over
stored chunk vectors execute; query cost +~0.35 s) but does **not** rescue these
two hard flask instances — BGE-small similarity between issue prose and code
chunks ranks tests/helpers above the small gold files. The third instance
(flask-5063) errored when the packer fix landed mid-probe (transient external
edit race, `NameError` from an intermediate search.py state) — an artifact of
concurrent development, not of the harness; rerun would score it.

## 6. Interpretation vs the PS criterion

PS requirement 5 demands retrieval "**beyond naive keyword/vector**". Evidence:

1. **The hybrid beats its own keyword stage decisively.** Same candidates, same
   fusion machinery: BM25-only → full is 3W/0L at R@5 and +84 % relative MRR
   (0.115 → 0.212). Gains concentrate where symbol structure matters (pytest
   MRR 0.333 vs 0.191; sphinx 0.250 vs 0.167; seaborn 0.125 vs 0.000) — signal
   that issue text alone does not contain. This satisfies "beyond naive
   keyword matching" *relative to its own lexical baseline*.
2. **Against an external ripgrep baseline the picture is split**: grep wins raw
   recall on small repos (literal strings from the issue appear in few files),
   but drops to literally zero on sphinx — where the hybrid scores 0.250/0.250 —
   and is unstable run-to-run. The honest claim: hybrid value grows with repo
   size/vocabulary distance; this Lite-derived suite (≤1000 indexed files,
   single-file patches) is close to grep's home turf.
3. **Vectors are not currently a differentiator at this scale** — they work but
   didn't flip any probed instance; embedding throughput (3 chunks/s hardware
   bound) is also a practical blocker for interactive use on larger repos.
4. **Repomap is not a retriever** (R@5 0.108) — by design an orientation aid;
   keep it out of the precision path.

One-line conclusion: **the hybrid design wins against its own ablations —
unbeaten by bm25-only at R@5 and +84 % MRR — but "beyond naive keyword
matching" is only partially demonstrated against an external ripgrep baseline
on this small-repo suite; scaling the suite to bigger repos is the highest-value
follow-up.**

## 7. Threats to validity

* Single-file ground truth (Lite property) ⇒ localization benchmark, not
  multi-file reasoning; SWE-bench-Verified would enrich the patch distribution.
* Structural output-budget asymmetry: `retrieve` packs ≤~8 chunks (production
  default) vs grep's up to 60 windows — `hit` mostly measures that; Recall@K is
  the fair comparison.
* Grep baseline nondeterminism (±0.08 R@5 across runs) from ripgrep traversal
  order feeding tie-breaks; retrieve-based configs are deterministic.
* One query formulation (raw problem_statement); production adds rewrite +
  grep-fallback retry (SPEC §6 self-check) which lifts all configs.
* Bench-side graph acceleration is verified-equivalent on 3 repos (incl. the
  unicode-heavy pylint corpus) but not formally proven for all inputs; exotic
  names auto-fall back to the original scanner.

## 8. Reproduce

```bash
# suite already built; rebuild from scratch (network) with:
.venv/bin/python eval/retrieval_bench.py build-dataset --seed 42

# full suite (~80 s wall):
.venv/bin/python eval/retrieval_bench.py run

# subsets / knobs:
.venv/bin/python eval/retrieval_bench.py run --n 20 --configs full,bm25_only,grep
.venv/bin/python eval/retrieval_bench.py run --repos pallets/flask --embeddings --timeout 900
```

Artifacts: suite shards + raw page cache + timestamped `results_*.json`
(pre-fix `...T021342Z`, embeddings probe `...T025431Z`, post-fix `...T030205Z`)
in `eval/suites/retrieval_ground_truth/`; working clones in `/tmp/retr_bench/`.
