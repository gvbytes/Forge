#!/usr/bin/env python3
"""SWE-bench suite for the Agent-Zero eval harness — REAL tasks, zero docker.

Sources ``princeton-nlp/SWE-bench_Verified`` instances (downloaded once into
``tasks/*.json`` beside this file, together with the gold patch
``tasks/<instance_id>.gold.patch`` and hidden test patch
``tasks/<instance_id>.tests.patch``) and turns them into runner-compatible
task dicts ``{id, title, instruction, test_cmd, timeout_s}``.

The agent instruction is the REAL upstream issue text (``problem_statement``);
grading runs the real FAIL_TO_PASS tests introduced by the instance's
test_patch.  Environments are plain pip venvs under ``/tmp/swb_envs/<slug>``
(shared across all instances of the same repo) and git checkouts come from
blob-filtered caches under ``/tmp/swb_repos/<slug>`` — no docker anywhere.

Task-dict contract (docs/SPEC.md §12 + eval/runner.py)::

    {"id": "swebench sympy__sympy-21596",      # "<suite> <instance_id>"
     "title": ...,                              # short human title
     "instruction": <problem_statement>,        # shown to the agent verbatim
     "test_cmd": "/tmp/swb_envs/<slug>/bin/python -m pytest -q <touched files>",
     "timeout_s": 900}

Public API (all stdlib-only)::

    register()                    -> suite descriptor consumed by eval/suites
    list_instances(tasks_dir)     -> ["sympy__sympy-21596", ...]
    load_record(instance_id)      -> full JSON record incl. F2P/P2P lists
    load_task(record)             -> canonical runner task dict (5 fields)
    prepare(instance_dir, workroot) -> ctx {record, repo, python, env, workroot}
        clone/fetch base_commit into ``workroot/repo`` (cached worktree off the
        shared blob:none cache) + cached pip env under /tmp/swb_envs/<slug>
        (deps installed once per repo; per-instance editable relink, --no-deps).
    apply_test_patch_at_grade(repo, record) -> (ok, err)
        stage the hidden tests right before grading (agent never sees them).
    gold_patch(instance_id)       -> Path to solution.patch (--baseline-solution)
    validate_instance(instance_id)-> end-to-end proof:
        prepare -> test_patch -> F2P fails -> gold patch -> F2P passes (+timing)

ONE-LINE INTEGRATION (deliberately NOT added here to avoid touching files I
don't own — add exactly this line where suites are wired up, e.g. in
``eval/suites/__init__.py`` or at the top of ``main()`` in eval/runner.py)::

    from eval.suites import swebench_data; SWEBENCH_SUITE = swebench_data.register()

Standalone use::

    .venv/bin/python eval/suites/swebench_data.py list
    .venv/bin/python eval/suites/swebench_data.py validate sympy__sympy-21596
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SUITE_NAME = "swebench_data"
TASKS_DIR = Path(__file__).resolve().parent / SUITE_NAME / "tasks"
CHECKOUT_ROOT = Path(os.environ.get("SWB_CHECKOUT_ROOT", "/tmp/swb_repos"))
ENV_ROOT = Path(os.environ.get("SWB_ENV_ROOT", "/tmp/swb_envs"))
WORKROOT_DEFAULT = Path(os.environ.get("SWB_WORK_ROOT", "/tmp/swb_runs"))
VENV_PYTHON = Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python"
INSTALL_BUDGET_S = 480          # mission bar: pip install must succeed <= 8 min


# ---------------------------------------------------------------------------
# small shell helpers
# ---------------------------------------------------------------------------
class SuiteError(RuntimeError):
    pass


def _sh(cmd: list[str], *, cwd: Path | None = None, timeout: int | None = None,
        check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True,
                          text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise SuiteError(
            f"`{' '.join(cmd)}` failed rc={proc.returncode}: "
            f"{(proc.stderr or proc.stdout).strip()[:400]}")
    return proc


def _git(repo: Path, *args: str, timeout: int | None = None,
         check: bool = True) -> subprocess.CompletedProcess:
    return _sh(["git", "-C", str(repo), *args], timeout=timeout, check=check)


def _slug(repo: str) -> str:
    return repo.split("/")[-1]


# ---------------------------------------------------------------------------
# records & runner-contract mapping
# ---------------------------------------------------------------------------
def list_instances(tasks_dir: Path | str = TASKS_DIR) -> list[str]:
    return sorted(p.stem for p in Path(tasks_dir).glob("*.json"))


def load_record(instance_id: str, tasks_dir: Path | str = TASKS_DIR) -> dict:
    path = Path(tasks_dir) / f"{instance_id}.json"
    if not path.is_file():
        raise SuiteError(f"unknown swebench_data instance {instance_id!r} "
                         f"(have: {', '.join(list_instances(tasks_dir))})")
    return json.loads(path.read_text(encoding="utf-8"))


def load_task(record: dict) -> dict:
    """Project a record onto the canonical five-field runner contract."""
    return {
        "id": record["id"],
        "title": record["title"],
        "instruction": record["instruction"],
        "test_cmd": record["test_cmd"],
        "timeout_s": int(record.get("timeout_s", 900)),
    }


def gold_patch(instance_id: str, tasks_dir: Path | str = TASKS_DIR) -> Path:
    return Path(tasks_dir) / f"{_iid(instance_id)}.gold.patch"


def tests_patch(instance_id: str, tasks_dir: Path | str = TASKS_DIR) -> Path:
    return Path(tasks_dir) / f"{_iid(instance_id)}.tests.patch"


def _iid(value: str | dict) -> str:
    """Accept 'sympy__x', record id 'swebench sympy__x' or 'swebench_data sympy__x'."""
    if isinstance(value, dict):
        value = value["id"]
    return re.sub(rf"^{SUITE_NAME}\s+|^swebench\s+", "", value.strip())


# ---------------------------------------------------------------------------
# git cache: one blob-filtered clone per repo, worktrees per instance
# ---------------------------------------------------------------------------
def ensure_checkout_cache(repo: str) -> Path:
    """Shared shallow-ish cache clone (commits+trees only, blobs on demand)."""
    path = CHECKOUT_ROOT / _slug(repo)
    if (path / ".git").exists() or (path / "HEAD").exists():   # worktree/bare ok
        return path
    CHECKOUT_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".partial-{os.getpid()}")
    _sh(["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout",
         f"https://github.com/{repo}.git", str(tmp)], timeout=1200)
    tmp.rename(path)
    return path


def _ensure_commit(cache: Path, base_commit: str) -> None:
    have = _git(cache, "cat-file", "-e", f"{base_commit}^{{commit}}",
                check=False).returncode == 0
    if not have:
        _git(cache, "fetch", "--quiet", "--filter=blob:none", "origin",
             base_commit, timeout=900)


def materialize_repo(record: dict, dest: Path) -> Path:
    """Detach a cached worktree at the instance's base_commit into *dest*."""
    cache = ensure_checkout_cache(record["repo"])
    _ensure_commit(cache, record["base_commit"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():                       # stale worktree from an earlier attempt
        release_repo(dest)                  # prune + remove (objects stay cached)
        shutil.rmtree(dest, ignore_errors=True)
    _git(cache, "worktree", "prune", timeout=60)
    _git(cache, "worktree", "add", "--quiet", "--detach", str(dest),
         record["base_commit"], timeout=600)
    return dest


def release_repo(repo: Path) -> None:
    """Drop a prepared worktree (objects stay in the shared cache)."""
    try:
        dotgit = repo / ".git"
        if dotgit.is_file():
            cache = Path(dotgit.read_text().split("gitdir:", 1)[1]
                         .strip().split("/worktrees/")[0])
            _git(cache, "worktree", "remove", "--force", str(repo), check=False)
            return
    except Exception:
        pass
    shutil.rmtree(repo, ignore_errors=True)


# ---------------------------------------------------------------------------
# pip env cache: one venv per repo slug, reused by every instance of the repo
# ---------------------------------------------------------------------------
def _uv() -> str:
    uv = shutil.which("uv") or "/usr/local/bin/uv"
    if not Path(uv).exists():
        raise SuiteError("uv not found; needed for fast env creation")
    return uv


def ensure_env(record: dict, repo: Path) -> tuple[Path, float, float]:
    """Return (env_python, first_install_s, total_s).

    Cached per repo slug: dependencies install once; later instances of the
    same repo only relink the editable path (--no-deps, seconds).
    """
    slug = record.get("env_slug") or _slug(record["repo"])
    env_dir = ENV_ROOT / slug
    py = env_dir / "bin" / "python"
    t0 = time.time()
    spent_first = 0.0
    if not py.is_file():
        ENV_ROOT.mkdir(parents=True, exist_ok=True)
        _sh([_uv(), "venv", "--python", str(VENV_PYTHON), str(env_dir)],
            timeout=180)
    ready = env_dir / ".swb_ready"
    stamped_commit = ready.read_text().splitlines()[0].strip() if ready.is_file() else ""
    if not ready.is_file() or stamped_commit != record["base_commit"]:
        # first instance of this repo, or dep closure may have drifted:
        # pull the full dependency closure once
        _sh([_uv(), "pip", "install", "--quiet", "-p", str(py),
             "-e", str(repo)], timeout=INSTALL_BUDGET_S)
        spent_first = time.time() - t0
        ready.write_text(f"{record['base_commit']}\n"
                         f"{record['repo']}\n{datetime.now(timezone.utc).isoformat()}\n")
    else:
        # same commit family as the cached env: relink the editable path cheaply
        _sh([_uv(), "pip", "install", "--quiet", "-p", str(py),
             "--no-deps", "-e", str(repo)], timeout=INSTALL_BUDGET_S)
    # make sure pytest exists (django uses its own runtests.py; harmless there)
    probe = _sh([str(py), "-c", "import pytest"], check=False)
    if probe.returncode != 0:
        _sh([_uv(), "pip", "install", "--quiet", "-p", str(py), "pytest"],
            timeout=300)
    return py, spent_first, time.time() - t0


def prepare(instance_dir: Path | str | dict, workroot: Path | str | None = None) -> dict:
    """Suite entry point: fully materialize one SWE-bench instance.

    ``instance_dir`` may be the instance id, a task-dir containing
    ``<id>.json``, or an already-loaded record dict.  Returns a context dict::

        {"record", "task", "repo", "python", "env", "install_s", "install_first"}
    """
    if isinstance(instance_dir, dict):
        record = instance_dir
    else:
        p = Path(instance_dir)
        iid = p.name if (p / (p.name + ".json")).is_file() else _iid(str(instance_dir))
        record = load_record(iid, p if p.is_dir() else TASKS_DIR)
    task = load_task(record)

    workroot = Path(workroot) if workroot else None
    if workroot is None:
        WORKROOT_DEFAULT.mkdir(parents=True, exist_ok=True)
        workroot = Path(tempfile.mkdtemp(prefix=f"swb-{_iid(record)}-",
                                         dir=str(WORKROOT_DEFAULT)))
    workroot.mkdir(parents=True, exist_ok=True)

    repo = materialize_repo(record, workroot / "repo")
    py, first_s, total_s = ensure_env(record, repo)
    return {
        "record": record,
        "task": task,
        "repo": repo,
        "python": py,
        "env": py.parent.parent,
        "workroot": workroot,
        "install_first_s": round(first_s, 1),
        "install_s": round(total_s, 1),
    }


def apply_test_patch_at_grade(repo: Path, record: dict) -> tuple[bool, str]:
    """Stage hidden tests (test_patch) immediately before grading."""
    proc = subprocess.run(
        ["git", "-C", str(repo), "apply", "--whitespace=nowarn",
         str(tests_patch(_iid(record)))],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return False, f"test patch apply failed: {(proc.stderr or proc.stdout).strip()}"
    return True, ""


def apply_gold_patch(repo: Path, record: dict) -> tuple[bool, str]:
    """Apply the reference solution (--baseline-solution equivalent)."""
    proc = subprocess.run(
        ["git", "-C", str(repo), "apply", "--whitespace=nowarn",
         str(gold_patch(_iid(record)))],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return False, f"gold patch apply failed: {(proc.stderr or proc.stdout).strip()}"
    return True, ""


# ---------------------------------------------------------------------------
# grading helpers
# ---------------------------------------------------------------------------
def run_tests(ctx: dict, timeout: int | None = None) -> dict:
    """Run the record's test_cmd inside the prepared repo (cwd=repo)."""
    cmd = ctx["task"]["test_cmd"]
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(ctx["python"].parent),
                                   env.get("PATH", "")])
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["CI"] = "1"
    t0 = time.time()
    proc = subprocess.run(cmd, shell=True, cwd=str(ctx["repo"]), env=env,
                          capture_output=True, text=True,
                          timeout=timeout or ctx["task"]["timeout_s"])
    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return {"exit_code": proc.returncode, "output": out[-20000:],
            "wall_s": round(time.time() - t0, 1)}


def _touched_test_files(repo: Path, record: dict) -> list[str]:
    """Repo-relative files the instance's test_patch creates/edits."""
    proc = subprocess.run(
        ["git", "apply", "--numstat", str(tests_patch(_iid(record)))],
        cwd=str(repo), capture_output=True, text=True)
    files = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            files.append(parts[2])
    return files


def _def_location(repo: Path, rel_path: str, func: str) -> str | None:
    """Class-qualified dotted path of ``func`` inside a python test file."""
    import ast

    path = repo / rel_path
    if not path.is_file():
        return None
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func:
            qual, cur = [node.name], parents.get(node)
            while isinstance(cur, ast.ClassDef):
                qual.insert(0, cur.name)
                cur = parents.get(cur)
            return ".".join(qual)
    return None


def _added_def_names(record: dict) -> list[str]:
    """Function defs ADDED by the tests.patch (lines '+...def <name>')."""
    patch = tests_patch(_iid(record)).read_text(encoding="utf-8", errors="replace")
    return re.findall(r"^\+\s*(?:async\s+)?def\s+(\w+)", patch, re.M)


def resolve_f2p_targets(repo: Path, record: dict) -> tuple[str, list[str]]:
    """Precise per-test probe targets for FAIL_TO_PASS entries.

    Returns (kind, targets): kind is 'pytest' (file::node ids, shell-quoted)
    or 'django' (dotted labels for tests/runtests.py).
    """
    files = _touched_test_files(repo, record)
    f2p = record["fail_to_pass"]
    if "runtests.py" in record["test_cmd"]:
        labels = []
        added = [n for n in _added_def_names(record) if n.startswith("test_")]
        for name in f2p:
            m = re.match(r".*\(([^)]+)\)$", name)      # desc (module.Class[.meth])
            if m:
                dotted = m.group(1)
                mod, tail = dotted.rsplit(".", 1)
                labels.append(dotted if tail.startswith("test_") else dotted)
            elif added and files:
                # dataset lost the parenthetical: locate each added def via ast
                for d in added:
                    for f in files:
                        q = _def_location(repo, f, d)
                        if q and q.endswith(d):
                            mod = f[:-3].replace("/", ".")
                            if mod.startswith("tests."):
                                mod = mod[len("tests."):]   # runtests.py app-label space
                            labels.append(f"{mod}.{q}")
                            break
        return "django", sorted(set(labels))
    # pytest-style suites
    targets = []
    for name in f2p:
        if "::" in name:
            fname, node = name.split("::", 1)
            targets.append(f"{fname}::{shlex_quote(node)}")
            continue
        placed = False
        for f in files:
            q = _def_location(repo, f, name)
            if q:
                if "." in q:
                    cls, fn = q.rsplit(".", 1)
                    targets.append(f"{f}::{cls}::{fn}")
                else:
                    targets.append(f"{f}::{q}")
                placed = True
                break
        if not placed and files:
            targets.append(files[-1])                  # coarse fallback
    return "pytest", sorted(set(targets))


def shlex_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'" if re.search(r"[^\w./:=+-]", s) else s


def run_targeted(ctx: dict, kind_targets: tuple[str, list[str]],
                 timeout: int | None = None) -> dict:
    """Run ONLY the F2P probe targets (used by validate_instance)."""
    kind, targets = kind_targets
    py = ctx["python"]
    if not targets:
        return {"exit_code": -1, "output": "no targets", "wall_s": 0.0}
    if kind == "django":
        cmd = (f"{py} tests/runtests.py {' '.join(targets)} "
               f"--settings=test_sqlite --parallel=1 -v 1")
    else:
        cmd = f"{py} -m pytest -q --no-header " + " ".join(targets)
    ctx2 = dict(ctx)
    ctx2["task"] = dict(ctx["task"], test_cmd=cmd)
    return run_tests(ctx2, timeout=timeout)


# ---------------------------------------------------------------------------
# end-to-end validation: fail-before -> green-after
# ---------------------------------------------------------------------------
def validate_instance(instance_id: str, workroot: Path | str | None = None,
                      verbose: bool = True) -> dict:
    """clone -> install -> baseline(F2P must FAIL) -> gold patch -> must PASS.

    Evidence is two-layered: the recorded full-suite test_cmd AND a targeted
    F2P-only probe (resolved from tests.patch + ast) must both fail before
    and both pass after applying the gold patch.
    """
    iid = _iid(instance_id)
    rep: dict = {"instance_id": iid, "ok": False}
    ctx = prepare(iid, workroot)
    rep.update(repo=str(ctx["repo"]), install_s=ctx["install_s"],
               install_first_s=ctx["install_first_s"])

    ok, err = apply_test_patch_at_grade(ctx["repo"], ctx["record"])
    if not ok:
        rep["error"] = err
        return rep

    targets = resolve_f2p_targets(ctx["repo"], ctx["record"])
    rep["f2p_probe"] = {"kind": targets[0], "targets": targets[1]}
    base_full = run_tests(ctx)
    base_probe = run_targeted(ctx, targets)
    rep["baseline"] = {"full_exit": base_full["exit_code"],
                       "probe_exit": base_probe["exit_code"],
                       "full_wall_s": base_full["wall_s"],
                       "probe_wall_s": base_probe["wall_s"]}
    if not (base_full["exit_code"] != 0 and base_probe["exit_code"] != 0):
        rep["error"] = ("baseline did not reproduce F2P failures: "
                        f"full_exit={base_full['exit_code']} "
                        f"probe_exit={base_probe['exit_code']}")
        rep["baseline_output_tail"] = (base_probe["output"]
                                       or base_full["output"])[-1500:]
        return rep

    ok, err = apply_gold_patch(ctx["repo"], ctx["record"])
    if not ok:
        rep["error"] = err
        return rep
    fix_full = run_tests(ctx)
    fix_probe = run_targeted(ctx, targets)
    rep["fixed"] = {"full_exit": fix_full["exit_code"],
                    "probe_exit": fix_probe["exit_code"],
                    "full_wall_s": fix_full["wall_s"],
                    "probe_wall_s": fix_probe["wall_s"]}
    rep["fixed_output_tail"] = fix_full["output"][-800:]
    rep["ok"] = fix_full["exit_code"] == 0 and fix_probe["exit_code"] == 0
    if not rep["ok"]:
        rep["error"] = "suite not green after gold patch"
    if verbose:
        tag = "PASS" if rep["ok"] else "FAIL"
        print(f"[{tag}] {iid}: install={ctx['install_s']}s "
              f"(cold first-install={ctx['install_first_s']}s) "
              f"baseline full/probe={base_full['wall_s']}/{base_probe['wall_s']}s "
              f"fixed full/probe={fix_full['wall_s']}/{fix_probe['wall_s']}s",
              flush=True)
    return rep


# ---------------------------------------------------------------------------
# suite descriptor
# ---------------------------------------------------------------------------
def register() -> dict:
    """Descriptor consumed by the suite registry (see docstring integration)."""
    return {
        "name": SUITE_NAME,
        "description": "Real princeton-nlp/SWE-bench_Verified instances, docker-free",
        "tasks_dir": str(TASKS_DIR),
        "list_instances": lambda: list_instances(),
        "load_record": load_record,
        "load_task": load_task,
        "prepare": prepare,
        "apply_test_patch_at_grade": apply_test_patch_at_grade,
        "gold_patch": gold_patch,
        "tests_patch": tests_patch,
        "validate_instance": validate_instance,
    }


# ---------------------------------------------------------------------------
# CLI (standalone dogfood/validation driver)
# ---------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    if argv[:1] in (["list"], []):
        for iid in list_instances():
            rec = load_record(iid)
            print(f"{iid:32s} {rec['repo']:28s} v{rec['version']:6s} "
                  f"f2p={len(rec['fail_to_pass']):3d} p2p={len(rec['pass_to_pass']):3d}")
        return 0
    if argv[:1] == ["show"]:
        print(json.dumps(load_record(_iid(argv[1])), indent=2)[:4000])
        return 0
    if argv[:1] == ["validate"]:
        targets = list_instances() if "--all" in argv else argv[1:]
        results = [validate_instance(t) for t in targets]
        good = sum(r["ok"] for r in results)
        print(f"\nvalidated {good}/{len(results)}")
        print(json.dumps(results, indent=2))
        return 0 if good == len(results) else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))


# ---------------------------------------------------------------------------
# runner.py contract facade (base.py style: discover/prepare/stage_grading/apply_gold)
# Adapts the descriptor API above so --suite swebench behaves like the other suites.
# ---------------------------------------------------------------------------
_descriptor_prepare = prepare   # original instance-materializer (shadowed below)


def discover(selectors=None):  # noqa: ANN201
    """Return SuiteTask list (optionally filtered by instance-id substrings)."""
    import sys as _sys
    from pathlib import Path as _P
    _here = _P(__file__).resolve().parent
    if str(_here) not in _sys.path:
        _sys.path.insert(0, str(_here))
    from suites.base import SuiteTask  # local contract types

    ids = list_instances()
    if selectors:
        ids = [i for i in ids if any(s in i for s in selectors)]
    out = []
    for iid in ids:
        rec = load_record(iid)
        t = load_task(rec)   # dict: id/title/instruction/test_cmd/timeout_s...
        out.append(SuiteTask(
            id=str(t["id"]), title=str(t.get("title", t["id"])),
            instruction=str(t["instruction"]), test_cmd=str(t["test_cmd"]),
            timeout_s=int(t.get("timeout_s", 900)),
            raw={"suite": SUITE_NAME, "record": rec,
                 "baseline_expectation": "fail"}))
    return out


def prepare(task, run_root):  # noqa: ANN001, ANN201
    """Materialize repo+env under run_root; return duck-typed Prep."""
    from pathlib import Path as _P
    rec = task.raw.get("record") or load_record(_iid(task.id))
    ctx = _descriptor_prepare(rec, _P(run_root))
    repo = _P(ctx["repo"])

    class _Prep:                              # mirrors suites.base.Prep attrs
        pass
    p = _Prep()
    p.task, p.repo = task, repo
    p.run_dir = repo.parent
    p.ctx = ctx
    return p


def stage_grading(prep) -> None:
    """Apply the upstream tests.patch right before grading (idempotent).

    Agents sometimes touch the same test files; fall back to a 3-way merge
    (objects exist in the shared cache) and finally to --reject so grading can
    proceed on the official tests even after agent edits (standard SWE-bench
    harness behavior)."""
    rec = prep.task.raw.get("record")
    tp = tests_patch(_iid(rec))
    if not Path(tp).is_file():
        return
    repo = Path(prep.repo)
    r = _git(repo, "apply", "--whitespace=nowarn", str(tp), check=False)
    if r.returncode != 0:
        r3 = _git(repo, "apply", "--3way", "--whitespace=nowarn", str(tp), check=False)
        if r3.returncode != 0:
            _git(repo, "apply", "--reject", "--whitespace=nowarn", str(tp), check=False)


def apply_gold(prep):
    rec = prep.task.raw.get("record")
    return apply_gold_patch(Path(prep.repo), rec)
