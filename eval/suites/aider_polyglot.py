"""Aider polyglot suite — Exercism exercises, exactly as aider benchmarks them.

Reused upstream work (cited):
  * Problem files verbatim from github.com/exercism/{python,javascript,cpp}
    (``exercises/practice/<slug>/``): stub file, public test file and the
    reference solution in ``.meta/``. Aider's own benchmark fetches these
    same repos via ``benchmark/clone-exercism.sh``
    (https://github.com/Aider-AI/aider).
  * JavaScript grading mirrors aider's ``benchmark/npm-test.sh``: jest
    against the exercise's ``*.spec.js``. We do NOT need their
    ``sed xtest→test`` trick because current specs import ``xtest`` from
    ``@jest/globals`` directly; we do need babel with exercism's preset
    (specs are ESM), installed once into /tmp/polyglot_envs/js.
  * C++ grading follows each exercise's CMakeLists.txt target but compiles
    directly with g++ because cmake is not installed on this box:
        g++ -std=c++14 -I. -Itest <slug>_test.cpp test/tests-main.cpp <slug>.cpp
    (Catch2 single-header is vendored per exercise upstream).

Selection: 8 exercises — 4 python, 2 javascript, 2 cpp (rust/go/java were
rejected: no toolchain on this box). Baseline = upstream stub → tests fail
(python/javascript) or fail to compile (cpp); gold = upstream .meta
reference solution copied over the stub.

Hygiene note (consistent with legacy fixtures T1/T3/T4): these exercises'
tests are PUBLIC by design and stay in the repo; nothing is staged at
grade time. Grader helper scripts written into the run repo contain no
solution material.
"""
from __future__ import annotations

import shutil
from pathlib import Path

try:
    from eval.suites.base import (POLYGLOT_ENV_ROOT, Prep, SuiteTask,
                                  ensure_cached_repo, git, init_baseline_commit)
except ImportError:
    from suites.base import (POLYGLOT_ENV_ROOT, Prep, SuiteTask,      # type: ignore
                             ensure_cached_repo, git, init_baseline_commit)

SUITE = "aider-polyglot"
EXERCISM_URLS = {
    "python": "https://github.com/exercism/python",
    "javascript": "https://github.com/exercism/javascript",
    "cpp": "https://github.com/exercism/cpp",
}
PY_VENV_BIN = Path("/workspace/ps_pclub/.venv/bin")
JEST_ENV = POLYGLOT_ENV_ROOT / "js" / "node_modules"

_EXERCISES = [
    # --- python (pytest) ---
    dict(lang="python", slug="two-fer",
         title="Two fer — one for you or a name"),
    dict(lang="python", slug="bob",
         title="Bob — teenage conversationalist response classifier"),
    dict(lang="python", slug="rna-transcription",
         title="RNA transcription — DNA to RNA with invalid-input rules"),
    dict(lang="python", slug="darts",
         title="Darts — score a dart hit on a circular dartboard"),
    # --- javascript (jest) ---
    dict(lang="javascript", slug="two-fer",
         title="Two fer — one for you or a name (JS)"),
    dict(lang="javascript", slug="bob",
         title="Bob — teenage conversationalist response classifier (JS)"),
    # --- cpp (Catch2, g++ direct) ---
    dict(lang="cpp", slug="raindrops",
         title="Raindrops — factor-to- sounds conversion (C++)"),
    dict(lang="cpp", slug="darts",
         title="Darts — score a dart hit on a circular dartboard (C++)"),
]


def _exercise_dir(task: SuiteTask) -> str:
    return f"{task.raw['lang']}/{task.raw['slug']}"


def _task(meta: dict) -> SuiteTask:
    lang, slug = meta["lang"], meta["slug"]
    if lang == "python":
        mod = slug.replace("-", "_")
        cmd = (f"python -m pytest {mod}_test.py -p no:cacheprovider -q")
    elif lang == "javascript":
        cmd = "bash _grade_jest.sh"
    else:
        cmd = "bash _grade_cpp.sh"
    return SuiteTask(
        id=f"POLYGLOT-{lang}-{slug}",
        title=f"{meta['title']} [aider-polyglot]",
        instruction=(
            f"Exercism practice exercise \"{slug}\" ({lang}), the exact task used\n"
            "by aider's polyglot benchmark. Implement the solution in the stub\n"
            f"file so the exercise's public test-suite passes.\n"
            + _LANG_HINT[lang]),
        test_cmd=cmd,
        timeout_s=600,
        raw={"suite": SUITE, "baseline_expectation": "fail", **meta},
    )


_LANG_HINT = {
    "python": ("The module name is the snake_case exercise slug; read\n"
               ".docs/instructions.md and <slug>_test.py for the required behaviour."),
    "javascript": ("Export the required functions from <slug>.js (ESM is fine; jest\n"
                   "with babel transforms it). See .docs/instructions.md and\n"
                   "<slug>.spec.js for the contract."),
    "cpp": ("Implement <slug>.h / <slug>.cpp under namespace <slug>;\n"
            "see .docs/instructions.md. The Catch2 test binary is compiled from\n"
            "<slug>_test.cpp."),
}

discover_cache: list[SuiteTask] | None = None


def discover(selectors: list[str] | None) -> list[SuiteTask]:
    global discover_cache
    tasks = discover_cache
    if tasks is None:
        tasks = [_task(m) for m in _EXERCISES]
        discover_cache = tasks
    if not selectors:
        return list(tasks)
    alias = {"js": "javascript", "py": "python", "cpp": "cpp", "c++": "cpp"}
    picked: list[SuiteTask] = []
    for sel in selectors:
        s = sel.strip().lower()
        s = alias.get(s, s)
        for pre, full in (("c++-", "cpp-"), ("js-", "javascript-"), ("py-", "python-")):
            if s.startswith(pre):
                s = full + s[len(pre):]
                break
        matches = [t for t in tasks
                   if s in t.id.lower()
                   or f"{t.raw['lang']}-{t.raw['slug']}".startswith(s)
                   or t.raw["slug"].replace("-", "").startswith(s.replace("-", ""))]
        if not matches:
            avail = ", ".join(t.id for t in tasks)
            raise SystemExit(f"2 unknown suite task {sel!r}; available: {avail}")
        picked.extend(m for m in matches if m not in picked)
    return picked


# --------------------------------------------------------------------------
# Grader helper scripts (no solution material; agent-visible like any repo file)
# --------------------------------------------------------------------------
JEST_SCRIPT = """#!/bin/bash
# Mirrors aider benchmark/npm-test.sh: jest over the exercise's spec files.
export NODE_PATH={jest_env}
exec node {jest_env}/.bin/jest --ci \\
  --config '{{"testEnvironment":"node","testMatch":["**/*.spec.js"],"rootDir":"."}}'
"""

CPP_SCRIPT = """#!/bin/bash
# Equivalent of the exercise's CMakeLists.txt target, built with g++ directly
# (cmake unavailable on the eval host). Same sources, same defines.
set -e
g++ -std=c++14 -DEXERCISM_RUN_ALL_TESTS -I. -Itest \\
   {slug}_test.cpp test/tests-main.cpp {slug}.cpp -o _polyglot_tests
./_polyglot_tests
"""


def prepare(task: SuiteTask, run_root: Path) -> Prep:
    meta = task.raw
    lang, slug = meta["lang"], meta["slug"]
    cache_repo = ensure_cached_repo(EXERCISM_URLS[lang], POLYGLOT_ENV_ROOT / "exercism")
    src = cache_repo / "exercises" / "practice" / slug
    if not src.is_dir():
        raise RuntimeError(f"exercism exercise missing upstream: {src}")

    run_dir = run_root / task.id
    repo = run_dir / "repo"
    if repo.exists():
        shutil.rmtree(repo)
    repo.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, repo)

    if lang == "javascript":
        (repo / "_grade_jest.sh").write_text(
            JEST_SCRIPT.format(jest_env=JEST_ENV))
        # give the agent a working in-repo env so it never wanders to /tmp clones
        try:
            (repo / "node_modules").symlink_to(JEST_ENV, target_is_directory=True)
        except OSError:
            pass
    elif lang == "cpp":
        (repo / "_grade_cpp.sh").write_text(CPP_SCRIPT.format(slug=slug))

    init_baseline_commit(repo, task.id)
    return Prep(task=task, run_dir=run_dir, repo=repo)


def stage_grading(prep: Prep) -> None:
    """No-op: exercism tests are public and already committed in the repo."""


def apply_gold(prep: Prep) -> tuple[bool, str]:
    """Copy the upstream .meta reference solution over the stub file(s)."""
    meta = prep.task.raw
    lang, slug = meta["lang"], meta["slug"]
    mod = slug.replace("-", "_")
    copies = {
        "python": [(f".meta/example.py", f"{mod}.py")],
        "javascript": [(f".meta/proof.ci.js", f"{slug}.js")],
        "cpp": [(f".meta/example.h", f"{slug}.h"), (f".meta/example.cpp", f"{slug}.cpp")],
    }[lang]
    try:
        for src_name, dst_name in copies:
            shutil.copyfile(prep.repo / src_name, prep.repo / dst_name)
    except OSError as exc:
        return False, f"upstream reference solution missing/copy failed: {exc}"
    return True, ""
