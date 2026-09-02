"""Shared plumbing for the public-benchmark eval suites.

Reuses upstream benchmark data verbatim wherever possible; this module
only adds the small glue the Agent-Zero harness needs (task records and
a Prep result compatible with ``eval/runner.py``).
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# Heavy per-project environments (venvs, repo caches) live here so they
# are built once and reused across runs.
BIP_ENV_ROOT = Path("/tmp/bip_envs")
POLYGLOT_ENV_ROOT = Path("/tmp/polyglot_envs")


@dataclass
class SuiteTask:
    """Duck-typed stand-in for runner.Task with suite metadata in ``raw``."""

    id: str
    title: str
    instruction: str
    test_cmd: str
    timeout_s: int = 900
    raw: dict = field(default_factory=dict)

    @property
    def baseline_expectation(self) -> str:
        return str(self.raw.get("baseline_expectation", "fail"))

    @property
    def suite(self) -> str:
        return str(self.raw.get("suite"))


@dataclass
class Prep:
    """Mirror of runner.Prep — attributes only; runner never imports us."""

    task: SuiteTask
    run_dir: Path
    repo: Path


def run(cmd: list[str], cwd: Path | None = None, check: bool = True,
        env: dict | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None,
                          capture_output=True, text=True, env=env)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({' '.join(str(c) for c in cmd)}): "
            f"{(proc.stderr or proc.stdout).strip()[:500]}")
    return proc


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return run(["git", "-C", str(repo), *args], check=check)


def init_baseline_commit(repo: Path, tag: str) -> None:
    """Baseline snapshot equivalent to runner.prepare()'s fixture ritual.

    Two cases:
      * suite repos cloned from a real project already carry history
        (HEAD sits on the benchmark baseline) -> only commit when dirty;
      * plain directories copied from upstream problem sets (exercism)
        get their own fresh ``git init`` — never rely on a parent repo.
    """
    if not (repo / ".git").exists():
        git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "eval@agent-zero.local")
    git(repo, "config", "user.name", "Agent-Zero Eval Harness")
    status = git(repo, "status", "--porcelain").stdout.strip()
    if not status:
        return                      # detached at upstream baseline commit
    git(repo, "add", "-A")
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m",
        f"baseline snapshot: {tag}")


def ensure_cached_repo(url: str, cache_dir: Path) -> Path:
    """Clone once into cache_dir; later runs reuse it (git fetch --all)."""
    name = url.rstrip("/").removesuffix(".git").split("/")[-1]
    path = cache_dir / name
    if not (path / ".git").exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = cache_dir / f".{name}.partial"
        shutil.rmtree(tmp, ignore_errors=True)
        run(["git", "clone", "-q", url, tmp])
        tmp.rename(path)
    else:
        git(path, "fetch", "-q", "--all", check=False)
    return path
