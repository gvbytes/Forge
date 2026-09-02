"""Battle-tested public benchmark suites for the Agent-Zero eval harness.

Suite modules implement a tiny contract consumed by ``eval/runner.py``
when ``--suite <name>`` is passed (default ``legacy`` = the fixture repos
under ``eval/tasks/``):

    discover(selectors) -> list[SuiteTask]   task discovery (selector filter)
    prepare(task, run_root) -> Prep          fresh working repo + git baseline
    stage_grading(prep) -> None              stage hidden/future tests at grade time
    apply_gold(prep) -> (bool, str)          reference solution, like solution.patch

``SuiteTask`` duck-types the fields of ``runner.Task`` that the harness
reads (id/title/instruction/test_cmd/timeout_s/raw/baseline_expectation).
"""
try:                                    # package-style import (repo root on path)
    from eval.suites.base import SuiteTask, Prep
except ImportError:                     # flat import (eval/ itself on path)
    from suites.base import SuiteTask, Prep  # type: ignore no-redef

SUITES = ("bugsinpy", "aider-polyglot")

__all__ = ["SuiteTask", "Prep", "SUITES"]
