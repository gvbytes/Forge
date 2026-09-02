#!/usr/bin/env python3
"""Agent-Zero evaluation harness.

from typing import Any
Headless evaluator for fixture repos under ``eval/tasks/``:

    load_task(dir)            -> {id,title,instruction,test_cmd,timeout_s}
    prepare(...)              -> fresh repo copy + git baseline (+hidden tests staged)
    run_agent(repo, goal,...) -> invokes the Agent-Zero headless backend module
    grade(run_dir, cmd, ...)  -> shells out test_cmd, parses A (passed/total)
    score(A, C, T)            -> binding SPEC §12 formula

Modes:
    --dry-run              prepare + baseline test run only (expect FAILures)
    --baseline-solution    apply solution.patch, prove the suite then PASSES
    --live                 full agent run against the Agent-Zero backend
    --suite <name>         task source: "legacy" fixtures (default) or a
                           public-benchmark suite from eval/suites/
                           ("bugsinpy", "aider-polyglot"); same modes apply

Cost/time accounting comes solely from the backend's ``result.json``
(see eval/README.md for the contract).
"""
from __future__ import annotations

import argparse
import json
import time
import os
import re
import shutil
import statistics
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Paths & constants
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]          # repo root (/workspace/ps_pclub)
TASKS_DIR = ROOT / "eval" / "tasks"
RUNS_DIR = ROOT / "eval" / "runs"
VENV_BIN = ROOT / ".venv" / "bin"
VENV_PYTHON = VENV_BIN / "python"

BACKEND_MODULE = "agent_zero.headless"
MAX_COST_USD = 0.5
MAX_WALL_S = 2700

# SPEC §12 scoring constants (binding):
SCORE_COST_NORM = 0.15
SCORE_TIME_NORM = 1320.0
SCORE_COST_WEIGHT = 0.65
SCORE_TIME_WEIGHT = 0.35
SCORE_POWER = 2.5

EXIT_OK = 0
EXIT_SANITY_FAILED = 1
EXIT_USAGE = 2
EXIT_BACKEND_MISSING = 3

COPY_EXCLUDES = ["__pycache__", "*.pyc", ".pytest_cache", ".git", "solution.patch",
                 "tests_hidden", "task.yaml"]


# --------------------------------------------------------------------------
# Task definition
# --------------------------------------------------------------------------
def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _mini_yaml(text: str) -> dict:
    """Fallback parser for the flat ``key: value`` task.yaml files."""
    data: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        data[key.strip()] = _strip_quotes(value)
    return data


def _load_yaml(text: str) -> dict:
    try:
        import yaml  # type: ignore import-not-found

        loaded = yaml.safe_load(text)
        return loaded if isinstance(loaded, dict) else {}
    except ImportError:
        return _mini_yaml(text)


@dataclass
class Task:
    """Fixture metadata; ``raw`` keeps any extra task.yaml keys."""

    dir: Path
    id: str
    title: str
    instruction: str
    test_cmd: str
    timeout_s: int
    raw: dict = field(default_factory=dict)

    @property
    def solution_patch(self) -> Path:
        name = self.raw.get("solution_patch", "solution.patch")
        return self.dir / str(name)

    @property
    def hidden_tests_dir(self) -> Path | None:
        name = self.raw.get("hidden_tests")
        return (self.dir / str(name)) if name else None

    @property
    def baseline_expectation(self) -> str:
        return str(self.raw.get("baseline_expectation", "fail"))


def load_task(task_dir: Path | str) -> dict:
    """Public helper: parse a task.yaml into the five canonical fields."""
    task = _load_task(Path(task_dir))
    return {
        "id": task.id,
        "title": task.title,
        "instruction": task.instruction,
        "test_cmd": task.test_cmd,
        "timeout_s": task.timeout_s,
    }


def _load_task(task_dir: Path) -> Task:
    yaml_path = task_dir / "task.yaml"
    if not yaml_path.is_file():
        raise ValueError(f"{task_dir}: missing task.yaml")
    meta = _load_yaml(yaml_path.read_text(encoding="utf-8"))
    try:
        return Task(
            dir=task_dir,
            id=str(meta["id"]).strip(),
            title=str(meta["title"]).strip(),
            instruction=_strip_quotes(str(meta["instruction"])),
            test_cmd=str(meta["tests"]).strip(),
            timeout_s=int(meta.get("timeout_s", 900)),
            raw=meta,
        )
    except KeyError as exc:
        raise ValueError(f"{yaml_path}: required key {exc} missing") from exc


def discover_tasks(selectors: list[str] | None) -> list[Task]:
    tasks = sorted(
        (_load_task(p.parent) for p in TASKS_DIR.glob("*/task.yaml")),
        key=lambda t: t.id,
    )
    if not selectors:
        return tasks
    picked: list[Task] = []
    for sel in selectors:
        sel_l = sel.strip().lower()
        matches = [t for t in tasks if sel_l in (t.id.lower(), t.dir.name.lower())
                   or t.dir.name.lower().startswith(sel_l)]
        if not matches:
            available = ", ".join(t.id for t in tasks)
            raise SystemExit(f"{EXIT_USAGE} unknown task {sel!r}; available: {available}")
        for m in matches:
            if m not in picked:
                picked.append(m)
    return picked


# --------------------------------------------------------------------------
# Benchmark suites (--suite; default "legacy" = fixtures above)
# --------------------------------------------------------------------------
SUITE_CHOICES = ["legacy", "bugsinpy", "aider-polyglot", "swebench"]
_SUITE_MODULES: dict[str, object] = {}


def _load_suite_module(name: str):
    """Load ``eval/suites/<name>.py`` by path (names may contain hyphens)."""
    if name not in _SUITE_MODULES:
        import importlib.util

        eval_dir = Path(__file__).resolve().parent
        if str(eval_dir) not in sys.path:      # suites/* use "from suites.base"
            sys.path.insert(0, str(eval_dir))
        fname = {"swebench": "swebench_data"}.get(name.replace('-', '_'),
                                                  name.replace('-', '_'))
        mod_path = eval_dir / "suites" / f"{fname}.py"
        spec = importlib.util.spec_from_file_location(f"_eval_suite_{name}", mod_path)
        if spec is None or spec.loader is None:
            raise SystemExit(f"2 unknown suite {name!r} ({mod_path} not found)")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        _SUITE_MODULES[name] = mod
    return _SUITE_MODULES[name]


def _suite_of(task: Task):
    """Suite module for this task, or None for legacy fixture tasks."""
    raw = getattr(task, "raw", None) or {}
    name = raw.get("suite")
    return _load_suite_module(name) if name else None


# --------------------------------------------------------------------------
# Scoring (SPEC §12 — binding, do not edit)
# --------------------------------------------------------------------------
def score(a: float, cost_usd: float, wall_s: float) -> tuple[float, list[str]]:
    """Return (score, hard_fail_reasons) using exactly the SPEC §12 formula:

    Score_task = 10*A / (1 + 0.65*(max(C,0)/0.15)**2.5 + 0.35*(max(T,1)/1320)**2.5)
    with a hard-fail (A treated as 0) when C > $0.50 or T > 2700 s.
    """
    reasons: list[str] = []
    a_eff = float(a)
    if cost_usd > MAX_COST_USD:
        reasons.append(f"cost {cost_usd:.2f}$ exceeds hard cap {MAX_COST_USD}$")
        a_eff = 0.0
    if wall_s > MAX_WALL_S:
        reasons.append(f"wall {wall_s:.0f}s exceeds hard cap {MAX_WALL_S}s")
        a_eff = 0.0
    denominator = (
        1.0
        + SCORE_COST_WEIGHT * (max(cost_usd, 0.0) / SCORE_COST_NORM) ** SCORE_POWER
        + SCORE_TIME_WEIGHT * (max(wall_s, 1.0) / SCORE_TIME_NORM) ** SCORE_POWER
    )
    return 10.0 * a_eff / denominator, reasons


# --------------------------------------------------------------------------
# Run preparation
# --------------------------------------------------------------------------
@dataclass
class Prep:
    task: Task
    run_dir: Path
    repo: Path


def _run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc


def make_run_root(tag: str | None = None) -> Path:
    stamp = tag or datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    root = RUNS_DIR / stamp
    suffix = 2
    while root.exists():
        root = RUNS_DIR / f"{stamp}-{suffix}"
        suffix += 1
    root.mkdir(parents=True)
    return root


def prepare(task: Task, run_root: Path) -> Prep:
    """Fresh copy of the fixture into the run dir + committed git baseline.

    Hidden tests are NOT copied here (the agent must never see them);
    grade() stages them right before running the test command.
    Suite tasks delegate repo preparation to their suite module.
    """
    mod = _suite_of(task)
    if mod is not None:
        return mod.prepare(task, run_root)
    run_dir = run_root / task.id
    repo = run_dir / "repo"
    shutil.copytree(task.dir, repo, ignore=shutil.ignore_patterns(*COPY_EXCLUDES))
    _run_git(repo, "init", "-q", "-b", "main")
    _run_git(repo, "config", "user.email", "eval@agent-zero.local")
    _run_git(repo, "config", "user.name", "Agent-Zero Eval Harness")
    _run_git(repo, "add", "-A")
    _run_git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m",
             f"baseline snapshot: {task.id}")
    return Prep(task=task, run_dir=run_dir, repo=repo)


def apply_solution_patch(prep: Prep) -> tuple[bool, str]:
    mod = _suite_of(prep.task)
    if mod is not None:
        return mod.apply_gold(prep)          # suite gold = upstream reference
    patch = prep.task.solution_patch
    if not patch.is_file():
        return False, f"solution patch missing: {patch}"
    proc = subprocess.run(
        ["git", "-C", str(prep.repo), "apply", "--whitespace=nowarn", str(patch)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False, f"patch apply failed: {(proc.stderr or proc.stdout).strip()}"
    return True, ""


# --------------------------------------------------------------------------
# Agent bridge (Agent-Zero headless backend)
# --------------------------------------------------------------------------
def run_agent_pi(prep: "Prep", max_cost: float, max_wall: float,
                 model: str = "deepseek-v4-flash", provider: str = "opencode-go") -> dict:
    """Run the battle-tested pi coding agent (badlogic/pi-mono) headless.

    pi --mode json emits a full event stream (toolcalls, usage, compaction) —
    we parse it into the same result.json contract the grader consumes.
    """
    result_path = prep.run_dir / "result.json"
    env = dict(os.environ)
    backend_root = str(Path(__file__).resolve().parents[1] / "backend")
    env["PYTHONPATH"] = backend_root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    dotenv = Path(__file__).resolve().parents[1] / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                env.setdefault(k.strip(), v.strip())
    env.setdefault("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1")
    cmd = [
        str(Path.home() / ".npm-global" / "bin" / "pi"),
        "-e", str(Path(__file__).resolve().parents[1] / "pi-bridge" / "opencode-provider.ts"),
        "--provider", provider, "--model", model,
        "--thinking", "low", "-p", "--no-session", "--mode", "json",
        "--", prep.task.instruction,
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, cwd=str(prep.repo), capture_output=True, text=True,
                              timeout=max_wall + 120, env=env)
    except subprocess.TimeoutExpired:
        return {"status": "agent_error", "note": "pi exceeded harness timeout"}
    (prep.run_dir / "pi_stdout.jsonl").write_text(proc.stdout or "")
    (prep.run_dir / "pi_stderr.log").write_text(proc.stderr or "")

    usage: dict[str, dict] = {}
    tool_calls = 0
    final_text = ""
    saw_agent_end = False
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get("type", "")
        if t == "tool_execution_start":
            tool_calls += 1
        if t == "agent_end":
            saw_agent_end = True
        if t == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            u = msg.get("usage") or {}
            name = msg.get("model") or "unknown"
            d = usage.setdefault(name, {"calls": 0, "input": 0, "output": 0, "cost": 0.0})
            d["calls"] += 1
            d["input"] += u.get("input", 0) or 0
            d["output"] += u.get("output", 0) or 0
            d["cost"] += (u.get("cost") or {}).get("total", 0.0)
            for block in msg.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip():
                    final_text = block["text"].strip()
    cost = sum(d["cost"] for d in usage.values())
    out = {"success": saw_agent_end and proc.returncode == 0,
           "summary": final_text[:4000], "cost_usd": round(cost, 6),
           "wall_s": round(time.time() - t0, 1), "steps": tool_calls,
           "model_usage": usage}
    result_path.write_text(json.dumps(out, indent=2))
    return {"status": "ran", "result_path": result_path}


MODELS_PI: list = []  # pi reports per-message cost itself


def run_agent(prep: Prep, max_cost: float = MAX_COST_USD,
              max_wall: float = MAX_WALL_S) -> dict:
    """Invoke the Agent-Zero headless CLI for this prepared repo.

    Contract: the backend is another engineer's module
    (``agent_zero.headless``) invoked with the argv documented in
    eval/README.md; it writes ``<run_dir>/result.json``. If the module is
    absent we degrade gracefully: a SKIP note is printed and the caller
    exits with code 3 once all tasks are processed.
    """
    result_path = prep.run_dir / "result.json"
    cmd = [
        str(VENV_PYTHON), "-m", BACKEND_MODULE,
        "--project", str(prep.repo),
        "--goal", prep.task.instruction,
        "--max-cost", f"{max_cost:g}",
        "--max-wall", f"{max_wall:g}",
        "--json-out", str(result_path),
    ]
    suite_task = getattr(prep, "task", None)
    if getattr(suite_task, "raw", None) and suite_task.raw.get("suite"):
        task_cmd = getattr(suite_task, "test_cmd", "")
        if task_cmd and len(task_cmd) < 500:
            cmd += ["--test-cmd", task_cmd]
    try:
        env = dict(os.environ)
        backend_root = str(Path(__file__).resolve().parents[1] / "backend")
        env["PYTHONPATH"] = backend_root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        proc = subprocess.run(cmd, cwd=str(prep.repo), capture_output=True,
                              text=True, timeout=max_wall + 120, env=env)
        (prep.run_dir / "agent_stdout.log").write_text(proc.stdout or "")
        (prep.run_dir / "agent_stderr.log").write_text(proc.stderr or "")
        combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if result_path.is_file():
            return {"status": "ran", "result_path": result_path}
        if "No module named" in combined or "ModuleNotFoundError" in combined:
            return {"status": "backend_missing",
                    "note": f"{BACKEND_MODULE} not installed; skipping agent run"}
        return {"status": "agent_error",
                "note": f"backend exited {proc.returncode} without result.json"}
    except subprocess.TimeoutExpired:
        return {"status": "agent_error", "note": "agent run exceeded harness timeout"}


def parse_result_json(result_path: Path) -> dict:
    """Parse the backend contract fields (documented in eval/README.md)."""
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    return {
        "success": bool(payload.get("success", False)),
        "cost_usd": float(payload.get("cost_usd", 0.0)),
        "wall_s": float(payload.get("wall_s", 0.0)),
        "steps": int(payload.get("steps", 0)),
        "model_usage": list(payload.get("model_usage") or []),
    }


# --------------------------------------------------------------------------
# Grading
# --------------------------------------------------------------------------
_INFRA_MARKERS = (
    "command not found",
    "no such file or directory",
    "errors during collection",
    "error during collection",
)


def parse_test_output(output: str, exit_code: int) -> tuple[int, int]:
    """Heuristically extract (passed, total) from captured test output.

    Strategy order:
      1. pytest-style summary counts ("5 passed", "2 failed", "3 errors")
      2. TAP lines ("ok 3 - name" / "not ok 4 - name")
      3. loose pass/fail markers, one count per matching line
      4. fallback: exit_code == 0 means everything passed
    """
    n_pass = sum(int(m) for m in re.findall(r"\b(\d+)\s+passed\b", output))
    n_fail = sum(int(m) for m in re.findall(r"\b(\d+)\s+failed\b", output))
    if n_pass or n_fail:
        n_fail += sum(int(m) for m in re.findall(r"\b(\d+)\s+errors?\b", output))
        if n_pass + n_fail:
            return n_pass, n_pass + n_fail

    tap_ok = len(re.findall(r"(?m)^\s*ok\b", output))
    tap_not_ok = len(re.findall(r"(?m)^\s*not\s+ok\b", output))
    if tap_ok or tap_not_ok:
        return tap_ok, tap_ok + tap_not_ok

    loose_pass = len(re.findall(r"(?im)^\s*(?:\[\s*x?\s*\]\s*)?(?:passed|pass|ok|✓|✔)\b", output))
    loose_fail = len(re.findall(r"(?im)(?:\bfailed\b|\bfail\b|AssertionError|\bnot\s+ok\b)", output))
    if loose_pass or loose_fail:
        return loose_pass, loose_pass + loose_fail

    return (1, 1) if exit_code == 0 else (0, 1)


def grade(prep: Prep, timeout_s: int | None = None) -> dict:
    """Copy hidden tests in (if any), run test_cmd, capture log, parse A."""
    task = prep.task
    mod = _suite_of(task)
    if mod is not None:
        mod.stage_grading(prep)   # suite test-patch step (no-op for polyglot)
    else:
        hidden = task.hidden_tests_dir
        if hidden is not None and hidden.is_dir():
            shutil.copytree(hidden, prep.repo / hidden.name, dirs_exist_ok=True)

    env = os.environ.copy()
    env["PATH"] = os.pathsep.join([str(VENV_BIN), env.get("PATH", "")])
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    env["CI"] = "1"

    timeout = timeout_s or task.timeout_s
    timed_out = False
    try:
        proc = subprocess.run(
            task.test_cmd, shell=True, cwd=str(prep.repo), env=env,
            capture_output=True, text=True, timeout=timeout,
        )
        out, err, rc = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        out = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        err = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        rc = 124

    output = f"{out}\n{err}"
    log_path = prep.run_dir / "test.log"
    log_path.write_text(output)

    passed, total = parse_test_output(output, rc)
    a_frac = (passed / total) if total else 0.0
    infra_error = rc == 127 or any(marker in output.lower() for marker in _INFRA_MARKERS)
    return {
        "exit_code": rc,
        "timed_out": timed_out,
        "passed": passed,
        "total": total,
        "a": a_frac,
        "infra_error": infra_error,
        "log": str(log_path),
    }


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
@dataclass
class Row:
    task: Task
    status: str                      # OK | MISMATCH | PASS | FAIL | SKIPPED | AGENT_ERROR
    note: str = ""
    exit_code: int | None = None
    passed: int | None = None
    total: int | None = None
    a: float | None = None
    cost_usd: float | None = None
    wall_s: float | None = None
    steps: int | None = None
    score_val: float | None = None
    hard_fail: list[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

    def cells(self) -> list[str]:
        def num(v, fmt="{:.2f}", dash="-"):
            return dash if v is None else fmt.format(v)

        return [
            self.task.id,
            self.status,
            "-" if self.passed is None else f"{self.passed}/{self.total}",
            num(self.a, "{:.3f}"),
            num(self.cost_usd, "{:.2f}"),
            num(self.wall_s, "{:.0f}"),
            num(self.steps, "{:d}") if isinstance(self.steps, int) else "-",
            num(self.score_val),
            self.note,
        ]


HEADER = ["Task", "Status", "Passed", "A", "Cost$", "Wall_s", "Steps", "Score", "Note"]
WIDTHS = [18, 12, 9, 8, 8, 8, 6, 8]


def print_table(rows: list[Row]) -> None:
    all_widths = WIDTHS + [0]  # last column (Note) is unpadded

    def line(cells: list[str]) -> str:
        padded = [str(c).ljust(w) if w else str(c) for c, w in zip(cells, all_widths)]
        return "  ".join(padded).rstrip()

    print(line(HEADER))
    print("-" * 110)
    for row in rows:
        print(line(row.cells()))
    print()


def render_markdown_report(mode: str, run_root: Path, rows: list[Row],
                           notes: list[str]) -> str:
    scores = [r.score_val for r in rows if r.score_val is not None]
    mean_score = statistics.fmean(scores) if scores else None
    lines = [
        "# Agent-Zero eval report",
        "",
        f"* Mode: `{mode}`",
        f"* Run dir: `{run_root}`",
        f"* Timestamp (UTC): {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"* Aggregate mean score: {mean_score:.3f}" if mean_score is not None
        else "* Aggregate mean score: n/a",
        "",
        "| Task | Status | Passed | A | Cost$ | Wall_s | Steps | Score | Note |",
        "|------|--------|--------|---|-------|--------|-------|-------|------|",
    ]
    for r in rows:
        c = r.cells()
        lines.append("| " + " | ".join(c) + " |")
    lines += ["", "## Notes", ""]
    lines += [f"- {n}" for n in notes] or ["- (none)"]
    lines += [
        "",
        "## Scoring",
        "",
        "`Score = 10·A / (1 + 0.65·(max(C,0)/0.15)^2.5 + 0.35·(max(T,1)/1320)^2.5)`",
        "",
        "Hard-fail (score 0) when C > $0.50 or T > 2700 s. Cost/time come solely from",
        "the backend `result.json`.",
        "",
    ]
    return "\n".join(lines)


def write_reports(mode: str, run_root: Path, rows: list[Row], notes: list[str],
                  extra: dict | None = None) -> None:
    payload = {
        "mode": mode,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "run_dir": str(run_root),
        "mean_score": (
            statistics.fmean([r.score_val for r in rows if r.score_val is not None])
            if any(r.score_val is not None for r in rows) else None
        ),
        "tasks": [
            {
                "id": r.task.id,
                "title": r.task.title,
                "status": r.status,
                "note": r.note,
                "exit_code": r.exit_code,
                "passed": r.passed,
                "total": r.total,
                "a": r.a,
                "cost_usd": r.cost_usd,
                "wall_s": r.wall_s,
                "steps": r.steps,
                "score": r.score_val,
                "hard_fail": r.hard_fail,
                "instruction": r.task.instruction,
                "test_cmd": r.task.test_cmd,
                "timeout_s": r.task.timeout_s,
                **r.extra,
            }
            for r in rows
        ],
        "notes": notes,
        **(extra or {}),
    }
    (run_root / "report.json").write_text(json.dumps(payload, indent=2))
    (run_root / "report.md").write_text(render_markdown_report(mode, run_root, rows, notes))


def summarize_notes(mode: str, rows: list[Row]) -> list[str]:
    notes = [f"mode={mode}"]
    for r in rows:
        bits = []
        if r.hard_fail:
            bits.append("HARD-FAIL: " + "; ".join(r.hard_fail))
        if r.note:
            bits.append(r.note)
        if bits:
            notes.append(f"{r.task.id}: " + " | ".join(bits))
    return notes


# --------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------
def mode_dry_run(tasks: list[Task], run_root: Path) -> int:
    """Prepare + baseline tests only. Expectation from task.yaml: fail."""
    rows: list[Row] = []
    for task in tasks:
        prep = prepare(task, run_root)
        g = grade(prep)
        expect_fail = task.baseline_expectation == "fail"
        satisfied = (g["exit_code"] != 0) if expect_fail else (g["exit_code"] == 0)
        if g["infra_error"]:
            satisfied = False
        info_score = score(g["a"], 0.0, 0.0)[0]
        rows.append(Row(
            task=task,
            status="OK" if satisfied else "MISMATCH",
            note=("expected fail, got fail" if satisfied and expect_fail else
                  "expected pass, got pass" if satisfied else
                  "INFRA ERROR — see test.log" if g["infra_error"] else
                  "expected fail, tests PASSED (bug not reproduced!)" if expect_fail else
                  "expected pass, tests FAILED"),
            exit_code=g["exit_code"], passed=g["passed"], total=g["total"],
            a=g["a"], score_val=info_score,
            extra={"timed_out": g["timed_out"], "infra_error": g["infra_error"],
                   "log": g["log"]},
        ))
    print_table(rows)
    notes = summarize_notes("dry-run", rows)
    write_reports("dry-run", run_root, rows, notes)
    ok = all(r.status == "OK" for r in rows)
    print(f"dry-run: {'all baseline expectations met' if ok else 'EXPECTATION MISMATCH'}")
    print(f"reports: {run_root}/report.md, report.json")
    return EXIT_OK if ok else EXIT_SANITY_FAILED


def info_score(a: float) -> float:
    """Informational score for modes where no agent ran (C=T=0)."""
    return score(a, 0.0, 0.0)[0]


def mode_baseline_solution(tasks: list[Task], run_root: Path) -> int:
    """Apply each solution.patch and verify the suite turns green."""
    rows: list[Row] = []
    for task in tasks:
        prep = prepare(task, run_root)
        applied, err = apply_solution_patch(prep)
        if not applied:
            rows.append(Row(task=task, status="FAIL", note=err, score_val=0.0))
            continue
        g = grade(prep)
        all_pass = g["exit_code"] == 0 and g["total"] > 0 and g["passed"] == g["total"]
        rows.append(Row(
            task=task,
            status="PASS" if all_pass else "FAIL",
            note="" if all_pass else "post-fix suite not green — see test.log",
            exit_code=g["exit_code"], passed=g["passed"], total=g["total"],
            a=g["a"], score_val=info_score(g["a"]),
            extra={"log": g["log"], "timed_out": g["timed_out"]},
        ))
    print_table(rows)
    notes = summarize_notes("baseline-solution", rows)
    write_reports("baseline-solution", run_root, rows, notes)
    ok = all(r.status == "PASS" for r in rows)
    print(f"baseline-solution: {'reference solutions verified' if ok else 'VERIFICATION FAILED'}")
    print(f"reports: {run_root}/report.md, report.json")
    return EXIT_OK if ok else EXIT_SANITY_FAILED


def mode_live(tasks: list[Task], run_root: Path, args: Any = None) -> int:
    """Full pipeline: prepare → headless agent → grade → score."""
    rows: list[Row] = []
    backend_missing = False
    for task in tasks:
        prep = prepare(task, run_root)
        use_pi = args is not None and getattr(args, "backend", "agentzero") == "pi"
        if use_pi:
            outcome = run_agent_pi(prep, args.pi_max_cost, args.pi_max_wall,
                                   args.pi_model, args.pi_provider)
        else:
            outcome = run_agent(prep, args.pi_max_cost, args.pi_max_wall)
        if outcome["status"] != "ran":
            backend_missing = backend_missing or outcome["status"] == "backend_missing"
            rows.append(Row(
                task=task,
                status="SKIPPED" if outcome["status"] == "backend_missing" else "AGENT_ERROR",
                note=outcome.get("note", ""),
            ))
            continue

        result = parse_result_json(outcome["result_path"])
        cost, wall, steps = result["cost_usd"], result["wall_s"], result["steps"]
        g = grade(prep)
        s_val, hard_fails = score(g["a"], cost, wall)
        note_parts = []
        if hard_fails:
            note_parts.append("; ".join(hard_fails))
        if not result["success"]:
            note_parts.append("backend reported success=false")
        rows.append(Row(
            task=task,
            status="GRADED",
            note=" | ".join(note_parts),
            exit_code=g["exit_code"], passed=g["passed"], total=g["total"], a=g["a"],
            cost_usd=cost, wall_s=wall, steps=steps, score_val=s_val,
            hard_fail=hard_fails,
            extra={"model_usage": result["model_usage"], "backend_success": result["success"],
                   "log": g["log"]},
        ))
    print_table(rows)
    notes = summarize_notes("live", rows)
    write_reports("live", run_root, rows, notes)
    scores = [r.score_val for r in rows if r.score_val is not None]
    if scores:
        print(f"aggregate mean score: {statistics.fmean(scores):.3f}")
    graded = [r for r in rows if r.status == "GRADED"]
    if graded and len(graded) == len(rows):
        print(f"reports: {run_root}/report.md, report.json")
        return EXIT_OK
    print(f"reports: {run_root}/report.md, report.json")
    return EXIT_BACKEND_MISSING if backend_missing else EXIT_SANITY_FAILED


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="runner.py",
        description="Agent-Zero evaluation harness (see eval/README.md)",
    )
    parser.add_argument("--tasks", default=None,
                        help="comma-separated task ids/dir names (default: all)")
    parser.add_argument("--backend", default="agentzero", choices=["agentzero", "pi"],
                        help="agent engine: our orchestrator, or the pi coding agent (battle-tested)")
    parser.add_argument("--pi-model", default="deepseek-v4-flash")
    parser.add_argument("--pi-provider", default="opencode-go")
    parser.add_argument("--pi-max-cost", type=float, default=0.5)
    parser.add_argument("--pi-max-wall", type=float, default=900)
    parser.add_argument("--suite", default="legacy", choices=SUITE_CHOICES,
                        help="task source: legacy fixtures (default), or a "
                             "public benchmark suite under eval/suites/")
    parser.add_argument("--tag", default=None, help="override the run-dir timestamp tag")
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument("--dry-run", action="store_true",
                            help="prepare + baseline tests only; baselines must FAIL")
    mode_group.add_argument("--live", action="store_true",
                            help="full headless agent run + grading + scoring")
    mode_group.add_argument("--baseline-solution", action="store_true",
                            help="apply solution.patch and require green suites")
    args = parser.parse_args(argv)

    if not VENV_PYTHON.exists():
        print(f"venv python missing: {VENV_PYTHON}", file=sys.stderr)
        return EXIT_USAGE

    selectors = args.tasks.split(",") if args.tasks else None
    if args.suite == "legacy":
        tasks = discover_tasks(selectors)
    else:
        tasks = _load_suite_module(args.suite).discover(selectors)
    run_root = make_run_root(args.tag)
    print(f"eval run: {run_root}  ({len(tasks)} task(s), suite={args.suite})\n")

    if args.live:
        return mode_live(tasks, run_root, args)
    if args.baseline_solution:
        return mode_baseline_solution(tasks, run_root)
    return mode_dry_run(tasks, run_root)


if __name__ == "__main__":
    sys.exit(main())
