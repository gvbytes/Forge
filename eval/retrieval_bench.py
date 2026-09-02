#!/usr/bin/env python3
"""Retrieval quality benchmark for Agent-Zero's code-retrieval pipeline.

Ground truth: SWE-bench-Lite instances (real GitHub issues + the patch a real
maintainer wrote). The files touched by the maintainer's ``patch`` are the gold
set; we ask whether the retriever surfaces those FILES from the repo state at
``base_commit`` given only the ``problem_statement``.

Subcommands
-----------
  build-dataset   stream SWE-bench-Lite via the HF datasets-server JSON API,
                  extract {instance_id, repo, base_commit, problem_statement,
                  gold_files[]} and shard into eval/suites/retrieval_ground_truth/
  run             evaluate instances (each in a killable child process, hard
                  120 s per-instance timeout): clone/prefetch repos, build
                  CodeIndex, score Recall@{5,10}/MRR for
                    full        BM25 ∪ vector ∪ graph-expand, RRF, MMR  (default)
                    bm25_only   lexical stage only          (ablation b)
                    vector_only embedding cosine only       (ablation c)
                    grep        ripgrep keyword baseline    (ablation d)
                    repomap     PageRank repo-map rendering (auxiliary signal)
  eval-one        internal: evaluate ONE instance (child-process entry)

Ablations are implemented by SUBCLASSING Retriever (stage toggles) — sources
under backend/agent_zero are never modified. Embeddings default OFF here:
fastembed throughput measured ≈3 chunks/s on this box (256 chunks in 93 s),
which cannot fit a 120 s/instance budget; the pipeline is explicitly designed
to degrade to lexical-only (search.py module docstring). Use --embeddings to
opt in for small subsets.

Usage (project venv):
  .venv/bin/python eval/retrieval_bench.py build-dataset
  .venv/bin/python eval/retrieval_bench.py run --n 24 [--configs full,bm25_only,grep] [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # /workspace/ps_pclub
sys.path.insert(0, str(ROOT / "backend"))             # sys.path bootstrap

DATA_DIR = ROOT / "eval" / "suites" / "retrieval_ground_truth"
BENCH_ROOT = Path("/tmp/retr_bench")
REPOS_DIR = BENCH_ROOT / "repos"

DATASET = "princeton-nlp/SWE-bench_Lite"
ROWS_API = ("https://datasets-server.huggingface.co/rows"
            f"?dataset={DATASET.replace('/', '%2F')}&config=default&split=test"
            "&offset={offset}&length=100")

# Repos kept in the suite: small enough that clone+index fits the timeout.
ALLOWED_REPOS = OrderedDict([
    ("pallets/flask", 3),
    ("mwaskom/seaborn", 4),
    ("psf/requests", 6),
    ("pylint-dev/pylint", 6),
    ("pytest-dev/pytest", 10),
    ("sphinx-doc/sphinx", 8),
])

INSTANCE_TIMEOUT_S = 120
K_VALUES = (5, 10)
RESULT_MARKER = "RESULT_JSON:"

# Indexer only ever sees these extensions (indexer.py CODE_EXTS|TEXT_FALLBACK_EXTS,
# <=200KB) — gold files outside this set would be unwinnable by construction.
INDEXABLE_EXTS = {".py", ".js", ".jsx", ".ts", ".tsx", ".md", ".rst", ".txt",
                  ".toml", ".yaml", ".yml", ".json", ".cfg", ".ini", ".sh",
                  ".css", ".html", ".sql"}

CONFIGS = ["full", "bm25_only", "vector_only", "grep", "repomap"]


# ---------------------------------------------------------------------------
# dataset building
# ---------------------------------------------------------------------------

def _fetch_rows(cache_dir: Path) -> list[dict]:
    """Page SWE-bench-Lite through datasets-server; cache raw pages on disk."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    recs: list[dict] = []
    for offset in (0, 100, 200):
        cf = cache_dir / f"swebench_lite_raw_page_{offset}.json"
        if not cf.exists():
            url = ROWS_API.format(offset=offset)
            req = urllib.request.Request(url, headers={"User-Agent": "retrieval-bench/1"})
            with urllib.request.urlopen(req, timeout=90) as r:
                cf.write_bytes(r.read())
            print(f"  fetched page offset={offset} ({cf.stat().st_size} bytes)")
        page = json.loads(cf.read_text(encoding="utf-8"))
        recs.extend(row["row"] for row in page["rows"])
    return recs


_HUNK_OLD_RE = re.compile(r"^--- (a/(.+)|/dev/null)")
_HUNK_NEW_RE = re.compile(r"^\+\+\+ (b/(.+)|/dev/null)")


def files_touched_by_patch(patch: str) -> tuple[list[str], list[str]]:
    """Split unified-diff headers into (existed_at_base, newly_added).

    existed_at_base: modified/deleted/renamed-away paths — legitimately
    retrievable from the base_commit tree.
    newly_added: created by the patch — NOT present at base_commit, hence
    excluded from the gold set (retrieval cannot find what does not exist).
    """
    existed, added = [], []
    old = new = None
    for line in patch.splitlines():
        mo = _HUNK_OLD_RE.match(line)
        mn = _HUNK_NEW_RE.match(line)
        if mo:
            old = None if mo.group(1) == "/dev/null" else mo.group(2)
        elif mn:
            new = None if mn.group(1) == "/dev/null" else mn.group(2)
            if old is not None:
                existed.append(old)
            if new is not None:
                (added if old is None else existed).append(new)
            old = new = None
    return existed, added


def build_dataset(seed: int = 42) -> None:
    print(f"[build-dataset] streaming {DATASET} …")
    recs = _fetch_rows(DATA_DIR)
    print(f"  {len(recs)} instances streamed")

    per_repo: dict[str, list[dict]] = {}
    skipped = Counter()
    for r in recs:
        repo = r["repo"]
        if repo not in ALLOWED_REPOS:
            continue
        existed, added = files_touched_by_patch(r.get("patch") or "")
        gold = sorted({p for p in existed if Path(p).suffix.lower() in INDEXABLE_EXTS})
        if not gold:
            skipped[f"{repo}:no-indexable-existing-file"] += 1
            continue
        ps = (r.get("problem_statement") or "").strip()
        if len(ps) < 80:
            skipped[f"{repo}:thin-problem-statement"] += 1
            continue
        per_repo.setdefault(repo, []).append({
            "instance_id": r["instance_id"],
            "repo": repo,
            "base_commit": r["base_commit"],
            "problem_statement": ps,
            "changed_files": sorted(set(existed) | set(added)),
            "gold_files": gold,          # retrievable-at-base subset == scoring target
            "version": r.get("version", ""),
        })

    rng = random.Random(seed)
    selected: list[dict] = []
    for repo, cap in ALLOWED_REPOS.items():
        items = per_repo.get(repo, [])
        rng.shuffle(items)
        chosen = items[:cap]
        selected.extend(chosen)
        print(f"  {repo}: {len(items)} eligible → took {len(chosen)} (cap {cap})")
    print(skipped and f"  skipped: {dict(skipped)}" or "  nothing skipped")

    # round-robin interleave so any --n prefix keeps every repo represented
    buckets = {repo: [] for repo in ALLOWED_REPOS}
    for inst in selected:
        buckets[inst["repo"]].append(inst)
    order: list[dict] = []
    i = 0
    while any(buckets.values()):
        for repo in ALLOWED_REPOS:
            if i < len(buckets[repo]):
                order.append(buckets[repo][i])
        i += 1
        if i > 5000:
            break

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for repo in ALLOWED_REPOS:
        shard_items = [x for x in order if x["repo"] == repo]
        if not shard_items:
            continue
        shard = DATA_DIR / f"swe_bench_lite__{repo.replace('/', '__')}.json"
        shard.write_text(json.dumps(
            {"meta": {
                "source": DATASET,
                "source_url": f"https://huggingface.co/datasets/{DATASET}",
                "access": "HF datasets-server /rows JSON API (no auth)",
                "ground_truth_rule": "gold_files = patch-touched files that exist "
                                     "at base_commit and match indexer-supported "
                                     "extensions; files ADDED by the patch excluded",
                "license_note": "SWE-bench is MIT-licensed; instances reference "
                                "public OSS repos under their own licenses",
                "seed": seed,
                "count": len(shard_items),
            }, "instances": shard_items},
            indent=1), encoding="utf-8")
        print(f"  wrote {shard.relative_to(ROOT)} ({len(shard_items)})")
    print(f"[build-dataset] total selected: {len(order)}")


def load_instances(repos: list[str] | None, n: int | None, seed: int) -> list[dict]:
    """Load suite shards, optionally filtered/sampled (deterministic)."""
    insts: list[dict] = []
    for shard in sorted(DATA_DIR.glob("swe_bench_lite__*.json")):
        d = json.loads(shard.read_text(encoding="utf-8"))
        insts.extend(d["instances"])
    if repos:
        insts = [x for x in insts if x["repo"] in repos]
    if n is not None and n < len(insts):
        rng = random.Random(seed)
        keep: list[dict] = []
        buckets: dict[str, list[dict]] = {}
        for x in insts:
            buckets.setdefault(x["repo"], []).append(x)
        for b in buckets.values():
            rng.shuffle(b)
        i = 0
        while len(keep) < n and any(buckets.values()):
            for b in buckets.values():
                if i < len(b) and len(keep) < n:
                    keep.append(b[i])
            i += 1
        insts = keep
    return insts


# ---------------------------------------------------------------------------
# repo working copies (shared per repo under /tmp/retr_bench/repos)
# ---------------------------------------------------------------------------

def _git(args: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True,
                          check=check, timeout=600)


def ensure_repo_clone(repo: str) -> Path:
    """Partial clone (--filter=blob:none, no checkout): cheap commit graph;
    individual base_commits are then fetched depth-1 on demand."""
    dest = REPOS_DIR / repo.replace("/", "__")
    if dest.exists():
        return dest
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"
    print(f"  [clone] {repo} → {dest}")
    t0 = time.time()
    _git(["clone", "--filter=blob:none", "--no-checkout", url, str(dest)])
    print(f"  [clone] done in {time.time() - t0:.1f}s")
    return dest


def prepare_commit(repo_dir: Path, sha: str) -> None:
    """Fetch (depth 1) + force-checkout the working copy to exactly *sha*."""
    have = subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"],
                          cwd=repo_dir, capture_output=True).returncode == 0
    if not have:
        t0 = time.time()
        _git(["fetch", "--depth", "1", "origin", sha], cwd=repo_dir)
        print(f"    fetched {sha[:10]} in {time.time() - t0:.1f}s")
    _git(["checkout", "--force", "--detach", sha], cwd=repo_dir)
    _git(["clean", "-fdxq"], cwd=repo_dir)


# ---------------------------------------------------------------------------
# ablation harness (subclassing only — no edits to backend sources)
# ---------------------------------------------------------------------------

_FAST_GRAPH_INSTALLED = False


def install_fast_graph_builder(verify_against_original: bool = False) -> str | None:
    """Monkeypatch CodeIndex._build_graph with a verified-equivalent fast version.

    Why: the original loops every vocabulary regex over every chunk
    (O(chunks × symbols)); profiled at 12.5M re.findall calls / 104 s on pytest.
    The replacement tokenizes each chunk once and intersects with the symbol
    vocabulary — the same word-boundary occurrence semantics (identifiers are
    exactly [A-Za-z_][A-Za-z0-9_]* maximal runs, which is what the original's
    lookaround patterns match), same min(count,3) weights, same node ids.
    Known divergence, measured negligible: identifiers directly adjacent to '$'
    or non-ASCII letters (the original refuses '$'-adjacent matches).

    Returns None normally; returns an equivalence report dict when
    *verify_against_original* (compares full edge multisets on this repo).
    """
    global _FAST_GRAPH_INSTALLED
    from collections import Counter as _Counter
    from agent_zero.retrieval import indexer as ix

    # unicode-aware: mirrors the ORIGINAL's semantics exactly — its patterns
    # use python-re \w (unicode) with explicit $ exclusions. Repos like pylint
    # ship test fixtures with non-ASCII identifiers ('úóíéá', 'НoldIt').
    ident_re = re.compile(r"[^\W\d]\w*")
    name_ok_re = re.compile(r"[^\W\d]\w*\Z")

    def _verified_token_counts(content: str) -> Counter:
        """Occurrences identical to the original's per-name lookaround patterns:
        a maximal unicode-identifier run counts toward *run* only when the
        surrounding chars are not [\\w$] (the original refuses $-adjacent
        matches; runs following word chars like the 'f' in '%.2f' are never
        standalone)."""
        counts: Counter = _Counter()
        n = len(content)
        wch = re.compile(r"[\w$]")
        for m in ident_re.finditer(content):
            s, e = m.start(), m.end()
            if (s == 0 or not wch.match(content[s - 1])) and \
               (e >= n or not wch.match(content[e])):
                counts[m.group()] += 1
        return counts

    def _fast_build_graph(self, chunks):
        import networkx as nx
        g = nx.DiGraph()
        by_name: dict[str, list[str]] = {}
        for ch in chunks:
            if ch.kind in ("block", "file"):
                continue
            nid = f"{ch.path}::{ch.name}"
            g.add_node(nid, name=ch.name, path=ch.path, kind=ch.kind)
            by_name.setdefault(ch.name, []).append(nid)
        # fidelity guard: exotic (non-ASCII-word) names fall back to the
        # original per-name regex scan — rare, so cost stays negligible
        exotic = [nm for nm in by_name if not name_ok_re.match(nm)]
        if exotic:
            return _orig_build_graph(self, chunks)
        for ch in chunks:
            if ch.kind in ("block", "file") or not ch.content:
                continue
            counts = _verified_token_counts(ch.content)
            src = f"{ch.path}::{ch.name}"
            for name, c in counts.items():
                if name == ch.name:
                    continue
                dsts = by_name.get(name)
                if not dsts:
                    continue
                w = float(min(c, 3))
                for dst in dsts:
                    g.add_edge(src, dst, weight=w, src_path=ch.path)
        return g

    _orig_build_graph = ix.CodeIndex._build_graph

    report = None
    orig = ix.CodeIndex._build_graph
    if verify_against_original:
        report = {"match": True, "checked": 0}
        # compare on-the-fly below by running both builders over the same chunks
        def _verify_build(self, chunks):
            g_fast = _fast_build_graph(self, chunks)
            g_orig = orig(self, chunks)
            fast_edges = sorted((u, v, d.get("weight", 1.0)) for u, v, d in g_fast.edges(data=True))
            orig_edges = sorted((u, v, d.get("weight", 1.0)) for u, v, d in g_orig.edges(data=True))
            report["checked"] += 1
            if fast_edges != orig_edges or set(g_fast.nodes) != set(g_orig.nodes):
                report["match"] = False
                report.setdefault("first_diff", {})
                report["first_diff"].setdefault("nodes_missing_in_fast",
                    sorted(set(g_orig.nodes) - set(g_fast.nodes))[:5])
                report["first_diff"].setdefault("nodes_extra_in_fast",
                    sorted(set(g_fast.nodes) - set(g_orig.nodes))[:5])
                de = [(a, b) for (a, b) in zip(orig_edges, fast_edges) if a != b]
                report["first_diff"]["edges"] = de[:5]
                report["n_edges_orig"], report["n_edges_fast"] = len(orig_edges), len(fast_edges)
            return g_fast                     # proceed with the fast graph either way
        ix.CodeIndex._build_graph = _verify_build
    else:
        ix.CodeIndex._build_graph = _fast_build_graph
    _FAST_GRAPH_INSTALLED = True
    return report

def build_retriever(code_index, stages: frozenset):
    """Retriever with stage toggles: {'fts','vector','graph'} ⊆ stages run."""
    from agent_zero.retrieval.search import Retriever

    class StageRetriever(Retriever):
        def __init__(self, code_index, stages=frozenset()):
            super().__init__(code_index)
            self._stages = frozenset(stages)

        def _fts_candidates(self, fts_expr):
            return super()._fts_candidates(fts_expr) if "fts" in self._stages else []

        def _vector_candidates(self, query):
            return super()._vector_candidates(query) if "vector" in self._stages else []

        def _graph_candidates(self, *lists):
            return super()._graph_candidates(*lists) if "graph" in self._stages else []

    return StageRetriever(code_index, stages)


_GREP_STOP = set("""the a an and or of to in for on with is are be do does did how what
where when why which who we i it its this that these those my our us you your can should
would there here get has have was were not no yes but from into out up down over under
again then once about against between through during before after above below only own
same so than too very will just don now issue bug error fix fixed fails fail wrong
incorrect unexpected behavior behaviour expected correct result results value values
case cases test tests testing function method class return returns returned should
must may might also however therefore thus when while if else elif try except raise
line lines file files code make made makes new old add adds added remove removes set
sets get gets put call calls called use uses used using work works working""".split())


def grep_baseline_pattern(problem_statement: str, top: int = 8) -> str:
    """Naive keyword baseline: most frequent non-stopword identifiers/words."""
    words = re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", problem_statement)
    freq = Counter(w for w in words if w.lower() not in _GREP_STOP)
    kws = [w for w, _ in freq.most_common(top)]
    if not kws:
        kws = [w for w, _ in Counter(words).most_common(3)] or ["nonexistenttoken"]
    return "(?i)(" + "|".join(re.escape(k) for k in kws) + ")"


def unique_file_ranking(paths_in_order: list[str]) -> list[str]:
    seen, out = set(), []
    for p in paths_in_order:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------

def metrics(ranked_files: list[str], gold: set[str]) -> dict:
    gold = set(gold)
    top = ranked_files
    m = {"recall@5": 0.0, "recall@10": 0.0, "mrr": 0.0, "hit": 0.0}
    if not gold:
        return m
    for k in K_VALUES:
        m[f"recall@{k}"] = len(set(top[:k]) & gold) / len(gold)
    for i, f in enumerate(top, 1):
        if f in gold:
            m["mrr"] = 1.0 / i
            break
    m["hit"] = 1.0 if set(top) & gold else 0.0
    return m


# ---------------------------------------------------------------------------
# per-instance evaluation (runs as a child process; parent enforces timeout)
# ---------------------------------------------------------------------------

def eval_one(instance: dict, use_embeddings: bool, configs: list[str],
             grep_top: int, fast_graph: bool = True) -> dict:
    if fast_graph:
        install_fast_graph_builder()
    repo_dir = ensure_repo_clone(instance["repo"])
    t_checkout = time.time()
    prepare_commit(repo_dir, instance["base_commit"])
    t_checkout = time.time() - t_checkout

    idx_dir = repo_dir / ".agent-zero"
    if idx_dir.exists():                       # never mix trees across commits
        shutil.rmtree(idx_dir)

    from agent_zero.retrieval.indexer import CodeIndex
    from agent_zero.retrieval.repomap import RepoMap

    t_index = time.time()
    idx = CodeIndex(repo_dir, enable_embeddings=use_embeddings)
    stats = idx.rebuild(incremental=False, embed=use_embeddings)
    t_index = time.time() - t_index

    query = instance["problem_statement"]
    gold = set(instance["gold_files"])
    timings: dict[str, float] = {}
    rankings: dict[str, list[str]] = {}

    stage_map = {
        "full": frozenset({"fts", "vector", "graph"}),
        "bm25_only": frozenset({"fts"}),
        "vector_only": frozenset({"vector"}),
    }
    for cfg in configs:
        t0 = time.time()
        if cfg in stage_map:
            ret = build_retriever(idx, stage_map[cfg]).retrieve(
                query, k=8, budget_tokens=3000)
            rankings[cfg] = unique_file_ranking([c.path for c in ret.chunks])
        elif cfg == "grep":
            from agent_zero.retrieval.search import Retriever
            pat = grep_baseline_pattern(query, top=grep_top)
            hits = Retriever(idx).grep_fallback(pat, limit=60)
            rx = re.compile(pat, re.I)

            def key(h, _rx=rx):
                return -len(_rx.findall(h.content or ""))
            hits = sorted(hits, key=key)
            # rg searches "." so paths arrive as "./src/x.py"; indexer paths
            # are "./"-free — normalize or gold matching would never fire.
            rankings[cfg] = unique_file_ranking(
                [h.path.removeprefix("./") for h in hits])
        elif cfg == "repomap":
            rendered = RepoMap(idx).render(query, budget_tokens=1500)
            paths = re.findall(r"^([\w./\\+-]+):\d+", rendered or "", re.M)
            rankings[cfg] = unique_file_ranking(paths)
        else:
            raise ValueError(f"unknown config {cfg}")
        timings[cfg] = time.time() - t0

    idx.close()

    out = {
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "n_gold": len(gold),
        "gold_files": sorted(gold),
        "index_stats": {k: stats.get(k) for k in
                        ("files", "chunks", "symbols", "edges")},
        "t_checkout_s": round(t_checkout, 2),
        "t_index_s": round(t_index, 2),
        "t_query_s": {c: round(timings.get(c, 0.0), 3) for c in configs},
        "ranked_files": rankings,
        "metrics": {c: metrics(rankings.get(c, []), gold) for c in configs},
    }
    return out


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------

def run_bench(n: int | None, repos: list[str] | None, configs: list[str],
              seed: int, timeout: int, embeddings: bool, grep_top: int) -> dict:
    insts = load_instances(repos, n, seed)
    if not insts:
        print("no instances selected — did you run build-dataset?", file=sys.stderr)
        return {}
    print(f"[run] {len(insts)} instances · configs={configs} · "
          f"embeddings={'on' if embeddings else 'OFF (lexical-only pipeline)'} · "
          f"timeout={timeout}s/instance\n")

    # prefetch phase (network): clones AND every needed base_commit, so the
    # per-instance 120 s budget only ever covers local checkout+index+query
    for repo in dict.fromkeys(x["repo"] for x in insts):
        repo_dir = ensure_repo_clone(repo)
        missing: list[str] = []
        for sha in dict.fromkeys(x["base_commit"] for x in insts
                                 if x["repo"] == repo):
            have = subprocess.run(
                ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
                cwd=repo_dir, capture_output=True).returncode == 0
            if not have:
                missing.append(sha)
        if missing:
            t0 = time.time()
            print(f"  [prefetch] {repo}: {len(missing)} commit(s) …", flush=True)
            _git(["fetch", "--depth", "1", "origin", *missing], cwd=repo_dir)
            print(f"  [prefetch] {repo} done in {time.time() - t0:.1f}s")

    results: list[dict] = []
    t_start = time.time()
    for i, inst in enumerate(insts, 1):
        tag = f"[{i:>2}/{len(insts)}] {inst['instance_id']}"
        t0 = time.time()
        payload = json.dumps({"instance": inst, "embeddings": embeddings,
                              "configs": configs, "grep_top": grep_top})
        tmp = BENCH_ROOT / "child_payload.json"
        BENCH_ROOT.mkdir(parents=True, exist_ok=True)
        tmp.write_text(payload, encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, __file__, "eval-one", "--payload", str(tmp)],
                capture_output=True, text=True, timeout=timeout)
            line = next((ln for ln in proc.stdout.splitlines()
                         if ln.startswith(RESULT_MARKER)), None)
            if line is None:
                raise RuntimeError(
                    f"child produced no result (rc={proc.returncode}): "
                    f"{proc.stderr.strip().splitlines()[-1:] or ''}")
            res = json.loads(line[len(RESULT_MARKER):])
            res["status"] = "ok"
            results.append(res)
            m = res["metrics"]["full"]
            print(f"{tag} ok {time.time()-t0:5.1f}s  "
                  f"full R@5={m['recall@5']:.2f} R@10={m['recall@10']:.2f} "
                  f"MRR={m['mrr']:.2f}")
        except subprocess.TimeoutExpired:
            results.append({"instance_id": inst["instance_id"], "repo": inst["repo"],
                            "status": "timeout", "elapsed_s": round(time.time()-t0, 1)})
            print(f"{tag} TIMEOUT after {time.time()-t0:.0f}s — skipped")
        except Exception as e:                                  # noqa: BLE001
            results.append({"instance_id": inst["instance_id"], "repo": inst["repo"],
                            "status": "error", "error": str(e)[:400]})
            print(f"{tag} ERROR: {str(e)[:160]}")

    ok = [r for r in results if r.get("status") == "ok"]
    agg = aggregate(ok)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    outfile = DATA_DIR / f"results_{stamp}.json"
    doc = {
        "meta": {
            "dataset": DATASET,
            "n_selected": len(insts), "n_ok": len(ok),
            "n_timeout": sum(1 for r in results if r.get("status") == "timeout"),
            "n_error": sum(1 for r in results if r.get("status") == "error"),
            "configs": configs, "embeddings": embeddings,
            "instance_timeout_s": timeout, "seed": seed,
            "wall_clock_s": round(time.time() - t_start, 1),
            "python": sys.version.split()[0],
        },
        "aggregate": agg,
        "instances": results,
    }
    outfile.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    print(f"\n[run] results → {outfile.relative_to(ROOT)}")
    print(format_tables(doc))
    return doc


def aggregate(ok_results: list[dict]) -> dict:
    agg: dict[str, dict] = {}
    configs = list({c for r in ok_results for c in r.get("metrics", {})})
    for cfg in configs:
        ms = [r["metrics"][cfg] for r in ok_results if cfg in r.get("metrics", {})]
        if not ms:
            continue
        agg[cfg] = {
            "n": len(ms),
            **{k: round(sum(m[k] for m in ms) / len(ms), 4)
               for k in ("recall@5", "recall@10", "mrr", "hit")},
            "mean_query_s": round(sum(r["t_query_s"].get(cfg, 0) for r in ok_results
                                      if cfg in r.get("t_query_s", {})) / len(ms), 3),
        }
    return agg


def format_tables(doc: dict) -> str:
    agg = doc.get("aggregate", {})
    lines = ["", "=== AGGREGATE (macro-average over scored instances) ==="]
    hdr = f"{'config':<12}{'n':>4}{'R@5':>8}{'R@10':>8}{'MRR':>8}{'hit':>8}{'q_s':>8}"
    lines.append(hdr)
    for cfg in CONFIGS:
        if cfg in agg:
            a = agg[cfg]
            lines.append(f"{cfg:<12}{a['n']:>4}{a['recall@5']:>8.3f}{a['recall@10']:>8.3f}"
                         f"{a['mrr']:>8.3f}{a['hit']:>8.3f}{a['mean_query_s']:>8.2f}")
    lines.append("\n=== PER-INSTANCE ===")
    lines.append(f"{'instance':<34}{'R@5':>14}{'R@10':>14}{'MRR':>16}")
    for r in doc.get("instances", []):
        if r.get("status") != "ok":
            lines.append(f"{r['instance_id']:<34}  [{r.get('status')}]")
            continue
        cells = []
        for k in ("recall@5", "recall@10", "mrr"):
            cells.append("/".join(f"{r['metrics'][c][k]:.2f}" for c in CONFIGS
                                  if c in r["metrics"]))
        lines.append(f"{r['instance_id']:<34}{' '.join(cells)}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build-dataset", help="stream SWE-bench-Lite → suite shards")
    b.add_argument("--seed", type=int, default=42)

    r = sub.add_parser("run", help="evaluate the suite")
    r.add_argument("--n", type=int, default=None, help="instances to evaluate")
    r.add_argument("--configs", type=str,
                   default="full,bm25_only,vector_only,grep,repomap")
    r.add_argument("--repos", type=str, default=None,
                   help="comma-separated repo filters")
    r.add_argument("--seed", type=int, default=42)
    r.add_argument("--timeout", type=int, default=INSTANCE_TIMEOUT_S)
    r.add_argument("--embeddings", action="store_true",
                   help="enable fastembed vectors (slow: ~3 chunks/s on this box)")
    r.add_argument("--grep-top", type=int, default=8)

    e = sub.add_parser("eval-one", help="internal: evaluate a single instance")
    e.add_argument("--payload", type=str, required=True)
    e.add_argument("--no-fast-graph", action="store_true")

    a = ap.parse_args(argv)
    if a.cmd == "build-dataset":
        build_dataset(seed=a.seed)
    elif a.cmd == "eval-one":
        p = json.loads(Path(a.payload).read_text(encoding="utf-8"))
        res = eval_one(p["instance"], p["embeddings"], p["configs"],
                       p["grep_top"], fast_graph=not a.no_fast_graph)
        print(RESULT_MARKER + json.dumps(res))
    elif a.cmd == "run":
        configs = [c.strip() for c in a.configs.split(",") if c.strip()]
        repos = [x.strip() for x in a.repos.split(",")] if a.repos else None
        run_bench(a.n, repos, configs, a.seed, a.timeout, a.embeddings, a.grep_top)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
