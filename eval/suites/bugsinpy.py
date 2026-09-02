"""BugsInPy suite — real bugs from popular Python projects.

Reused upstream work (cited):
  * Bug database, gold patches (``bug_patch.txt``), commit ids and the
    failing-test commands: https://github.com/soarsmu/BugsInPy
    (projects/{tqdm,youtube-dl}/bugs/<n>/{bug.info,bug_patch.txt,run_test.sh}).
    The six gold patches are vendored verbatim under
    ``eval/suites/data/bugsinpy/`` because /tmp research clones are
    ephemeral.
  * Checkout semantics replicated from BugsInPy's own
    ``framework/bin/bugsinpy-checkout``: reset the project to the buggy
    commit, then overlay the fixed-commit versions of every file under
    the bug's test directory (their script copies ``test_file`` entries;
    we additionally carry fix-commit files ADDED under that same test
    root so fixtures like ``tests/test-generate-context/*.json`` are not
    missing at grade time).

Environment policy:
  * One cached venv per project under ``/tmp/bip_envs/<project>/venv``
    (python3.11) carrying only TEST dependencies. The project itself is
    NOT pip-installed: tests import it from the repo working dir, so a
    single venv serves every checkout of that project.
  * Deviation note: BugsInPy's pinned requirements.txt are python3.6-era
    and uninstallable on py3.11 (e.g. pytest==5.4.3, nose); we install
    modern pytest + pynose (a maintained nose fork providing the same
    import path) instead. Projects whose era-source cannot run on
    py3.11 (black→typed_ast, PySnooper/thefuck/httpie→dead stdlib
    imports, tornado pre-6) were probed and excluded for that reason.

Selection: 6 bugs across 2 light, pure-Python projects; each verified
on this box to FAIL at baseline and PASS after applying the gold patch.

Reproducibility note: youtube-dl's maintainers rewrote master history at
some point after BugsInPy was packaged, so some published buggy_commit
ids (e.g. bug 7) no longer exist upstream. Every commit id in the
manifest below was verified present in a fresh clone before selection;
``prepare()`` fails loudly (``reference is not a tree``) if upstream ever
loses another one.
"""
from __future__ import annotations

import shutil
from pathlib import Path

try:
    from eval.suites.base import (BIP_ENV_ROOT, Prep, SuiteTask, ensure_cached_repo,
                                  git, init_baseline_commit, run)
except ImportError:
    from suites.base import (BIP_ENV_ROOT, Prep, SuiteTask, ensure_cached_repo,
                             git, init_baseline_commit, run)  # type: ignore

SUITE = "bugsinpy"
DATA_DIR = Path(__file__).resolve().parent / "data" / "bugsinpy"

TQDM_URL = "https://github.com/tqdm/tqdm"
YTDL_URL = "https://github.com/ytdl-org/youtube-dl"

# Verbatim GitHub issue text used where the upstream fix commit links one.
ISSUE_511 = '''CLI: Cannot escape hyphens in description

$ seq 1000 | tqdm --total 1000 --desc 'test-test' > /dev/null

Error:
Usage:
  tqdm [--help | options]
Traceback ...
  File ".../tqdm/_main.py", line 144, in main
    tqdm_args[o] = cast(v, opt_types[o])
KeyError: 'test'
...
tqdm._tqdm.TqdmKeyError: "'test'"

vs:

$ seq 100 | tqdm --total 100 --desc 'test_test' > /dev/null  # works fine'''

_BUGS = [
    dict(project="tqdm", bug=2, url=TQDM_URL,
         buggy="bef86db56654d271838b145ad77f7040a73a7b4d",
         fixed="127af5caf19e7d29c346f5ca8a9c7ef3004b664b",
         test_root="tqdm/tests/",
         node="tqdm/tests/tests_tqdm.py::test_format_meter",
         title="format_meter: TypeError with unit_scale and unknown total",
         instruction=(
             "Real regression from the tqdm project (BugsInPy tqdm/bug-2).\n"
             "Upstream fix commit: \"fix `TypeError` when `unit_scale` and unknown "
             "`total`\". format_meter() mis-trims its output when ncols is falsy and "
             "mis-handles ANSI-reset detection for custom bar_format strings.\n"
             "Fix tqdm/tqdm/_tqdm.py so the pinned test passes:\n"
             "  python -m pytest tqdm/tests/tests_tqdm.py::test_format_meter"),
         source="BugsInPy bug_patch.txt + run_test.sh (commit message)"),
    dict(project="tqdm", bug=4, url=TQDM_URL,
         buggy="03b347646492131d889871939b40457d29147216",
         fixed="964dee631d0ed30e2f799b42fc58ba5e73795a08",
         test_root="tqdm/tests/",
         node="tqdm/tests/tests_tqdm.py::test_nototal",
         title="TypeError: unsupported operand *= NoneType when total is unknown",
         instruction=(
             "Real regression from the tqdm project (BugsInPy tqdm/bug-4).\n"
             "With no explicit total, constructing a progress bar raises\n"
             "  TypeError: unsupported operand type(s) for *=: 'NoneType' and 'int'\n"
             "because unit scaling multiplies an unknown (None) total.\n"
             "Fix tqdm/tqdm/_tqdm.py so the pinned test passes:\n"
             "  python -m pytest tqdm/tests/tests_tqdm.py::test_nototal"),
         source="BugsInPy bug_patch.txt + run_test.sh (commit message)"),
    dict(project="tqdm", bug=7, url=TQDM_URL,
         buggy="caefe02fd6f3165e5634460ab20caf4c60400120",
         fixed="4efd35246c924236f34d8130b1055a3c3ba78605",
         test_root="tqdm/tests/",
         node="tqdm/tests/tests_main.py::test_main",
         title="CLI: Cannot escape hyphens in description",
         instruction=(
             "Real user-reported issue from the tqdm project (tqdm issue #511,\n"
             "fixed by BugsInPy tqdm/bug-7). Issue text verbatim:\n\n" + ISSUE_511 +
             "\n\nFix the CLI argument parser in tqdm/tqdm/_main.py so hyphens inside\n"
             "quoted option values are not treated as options, then verify:\n"
             "  python -m pytest tqdm/tests/tests_main.py::test_main"),
         source="github.com/tqdm/tqdm/issues/511 (verbatim) via BugsInPy bug 7"),
    dict(project="youtube-dl", bug=1, url=YTDL_URL,
         buggy="99036a1298089068dcf80c0985bfcc3f8c24f281",
         fixed="1cc47c667419e0eadc0a6989256ab7b276852adf",
         test_root="test/",
         node="test.test_utils.TestUtil.test_match_str",
         title="match_str mishandles boolean meta fields",
         instruction=(
             "Real bug from youtube-dl (BugsInPy youtube-dl/bug-1), upstream fix\n"
             "commit: \"[utils] Fix match_str for boolean meta fields\".\n"
             "In youtube_dl/utils.py the field filter used by match_str treats any\n"
             "present value as a match ('') and any absent value as non-match ('!'),\n"
             "even when the value is a bool — so 'view_count:True'-style filters\n"
             "cannot distinguish True from False.\n"
             "Fix youtube_dl/utils.py so the pinned unittest passes:\n"
             "  python -m unittest -q test.test_utils.TestUtil.test_match_str"),
         source="BugsInPy bug_patch.txt + run_test.sh (commit message)"),
    dict(project="youtube-dl", bug=3, url=YTDL_URL,
         buggy="f5469da9e6e259c1690c7ef54f1da1c19f65036f",
         fixed="95f3f7c20a05e7ac490e768b8470b20538ef8581",
         test_root="test/",
         node="test.test_utils.TestUtil.test_unescape_html",
         title="unescapeHTML crashes on malformed entities like &amp&quot;",
         instruction=(
             "Real bug from youtube-dl (BugsInPy youtube-dl/bug-3), upstream fix\n"
             "commit: \"[utils] Fix unescapeHTML for misformed string like "
             "'&a&quot;' (#13935)\".\n"
             "unescapeHTML() in youtube_dl/utils.py consumes too much input per\n"
             "entity candidate and raises on malformed ampersand sequences instead\n"
             "of leaving them untouched.\n"
             "Fix youtube_dl/utils.py so the pinned unittest passes:\n"
             "  python -m unittest -q test.test_utils.TestUtil.test_unescape_html"),
         source="BugsInPy bug_patch.txt + run_test.sh (commit message)"),
    dict(project="youtube-dl", bug=6, url=YTDL_URL,
         buggy="4f29fa99069760dc47ef9ca5dbf607a567d2982f",
         fixed="d631d5f9f27f93767226192e4288990413fa9dbd",
         test_root="test/",
         node="test.test_utils.TestUtil.test_parse_dfxp_time_expr",
         title="dfxp2srt crashes on TTML paragraphs missing begin/dur",
         instruction=(
             "Real bug from youtube-dl (BugsInPy youtube-dl/bug-6), upstream fix\n"
             "commit: \"[utils] Fix TTML conversion\".\n"
             "parse_dfxp_time_expr() returns 0.0 for an empty expression, and\n"
             "dfxp2srt() indexes para.attrib['begin']/['dur'] directly, so TTML\n"
             "subtitle files whose <p> elements omit begin or dur crash with a\n"
             "KeyError instead of skipping the paragraph.\n"
             "Fix youtube_dl/utils.py so the pinned unittest passes:\n"
             "  python -m unittest -q test.test_utils.TestUtil.test_parse_dfxp_time_expr"),
         source="BugsInPy bug_patch.txt + run_test.sh (commit message)"),
]

# Test-only deps installed once into /tmp/bip_envs/<project>/venv.
_DEPS = {"tqdm": ["wheel", "pytest", "pynose"], "youtube-dl": ["wheel", "pytest"]}


def _task(meta: dict) -> SuiteTask:
    project = meta["project"]
    vpython = BIP_ENV_ROOT / project / "venv" / "bin" / "python"
    if meta["project"] == "youtube-dl":
        cmd = f"{vpython} -m unittest -q {meta['node']}"
    else:
        cmd = f"{vpython} -m pytest {meta['node']} -p no:cacheprovider -q"
    return SuiteTask(
        id=f"BIP-{project}-{meta['bug']}",
        title=f"{meta['title']} [{project}]",
        instruction=meta["instruction"],
        test_cmd=cmd,
        timeout_s=900,
        raw={"suite": SUITE, "baseline_expectation": "fail", **meta},
    )


def discover(selectors: list[str] | None) -> list[SuiteTask]:
    tasks = [_task(m) for m in _BUGS]
    if not selectors:
        return tasks
    picked: list[SuiteTask] = []
    for sel in selectors:
        s = sel.strip().lower()
        matches = [t for t in tasks if s in t.id.lower()
                   or t.raw["project"].lower().startswith(s)]
        if not matches:
            avail = ", ".join(t.id for t in tasks)
            raise SystemExit(f"2 unknown suite task {sel!r}; available: {avail}")
        picked.extend(m for m in matches if m not in picked)
    return picked


def ensure_venv(project: str) -> Path:
    """Create/reuse the cached per-project venv (idempotent)."""
    import sys

    venv_dir = BIP_ENV_ROOT / project / "venv"
    marker = BIP_ENV_ROOT / project / ".venv-ok"
    vpython = venv_dir / "bin" / "python"
    if marker.exists() and vpython.exists():
        return vpython
    try:
        BIP_ENV_ROOT.mkdir(parents=True, exist_ok=True)
        run([sys.executable, "-m", "venv", str(venv_dir)])
        run([str(venv_dir / "bin" / "pip"), "install", "-q", "--no-input",
             *_DEPS[project]])
    except Exception as exc:  # pragma: no cover - network/pip failures
        raise RuntimeError(f"failed to build BugsInPy venv for {project}: {exc}")
    marker.write_text("ok\n")
    return vpython


def prepare(task: SuiteTask, run_root: Path) -> Prep:
    meta = task.raw
    cache = ensure_cached_repo(meta["url"], BIP_ENV_ROOT / "_repos")
    run_dir = run_root / task.id
    repo = run_dir / "repo"
    if repo.exists():
        shutil.rmtree(repo)
    repo.parent.mkdir(parents=True, exist_ok=True)
    git(cache, "worktree", "prune", check=False)
    # local clone from the persistent cache: fast, offline, full history
    shutil.copytree(str(cache), str(repo))
    git(repo, "remote", "remove", "origin", check=False)
    git(repo, "checkout", "-q", "-f", meta["buggy"])
    git(repo, "clean", "-qfd")
    ensure_venv(meta["project"])
    init_baseline_commit(repo, task.id)
    return Prep(task=task, run_dir=run_dir, repo=repo)


def stage_grading(prep: Prep) -> None:
    """Overlay the fixed-commit test tree (BugsInPy's test-patch step).

    Copies the fixed version of every changed path under the bug's test
    root — exactly what bugsinpy-checkout does with ``test_file``, plus
    fixtures added by the fix commit so the suite can actually run.
    Runs at grade time only: the agent never sees the future tests.
    """
    meta = prep.task.raw
    diff = git(prep.repo, "diff", "--name-only", meta["buggy"], meta["fixed"])
    for line in diff.stdout.splitlines():
        path = line.strip()
        if path.startswith(meta["test_root"]):
            git(prep.repo, "checkout", "-q", meta["fixed"], "--", path)


def apply_gold(prep: Prep) -> tuple[bool, str]:
    """Apply the vendored BugsInPy gold patch (verbatim bug_patch.txt)."""
    meta = prep.task.raw
    patch = DATA_DIR / f"{meta['project']}_{meta['bug']}.patch"
    if not patch.is_file():
        return False, f"vendored gold patch missing: {patch}"
    proc = git(prep.repo, "apply", "--whitespace=nowarn", str(patch), check=False)
    if proc.returncode != 0:
        return False, f"gold patch apply failed: {(proc.stderr or proc.stdout).strip()}"
    return True, ""
