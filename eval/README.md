# Agent-Zero Evaluation Harness

Headless evaluator for the Agent-Zero agentic IDE. It ships fixture repos,
runs an agent against them through the Agent-Zero **headless backend**,
grades the resulting workspace by running each task's test command, and
scores the run with the binding formula from `docs/SPEC.md` §12.

This directory is self-contained:

```
eval/
├── runner.py            the harness (stdlib only; shells out to run tests)
├── README.md            this document
├── tasks/               four fixture projects, one task.yaml each
│   ├── T1-bugfix-python/
│   ├── T2-feature-python/
│   ├── T3-refactor-ts/
│   └── T4-cross-file-bug-js/
└── runs/                runtime output (gitignored), one timestamped dir per invocation
```

---

## 1. Running

All commands are issued from the repo root and use the project venv:

```bash
# Sanity gate #1: fresh fixture copies must FAIL their own suites.
# No agent runs; verifies bugs reproduce / features are missing.
/workspace/ps_pclub/.venv/bin/python eval/runner.py --dry-run

# Sanity gate #2: apply each task's solution.patch and require green suites.
# Proves every task is solvable and its reference solution is correct.
/workspace/ps_pclub/.venv/bin/python eval/runner.py --baseline-solution

# Full evaluation: prepare -> headless agent -> grade -> score.
/workspace/ps_pclub/.venv/bin/python eval/runner.py --live

# Subset selection:
/workspace/ps_pclub/.venv/bin/python eval/runner.py --live --tasks T1,T4
```

`--tasks` accepts comma-separated ids or directory names (`T1` matches
`T1-bugfix-python`; matching is case-insensitive prefix based).

### Modes & exit codes

| Mode                 | What happens                                              | Exit codes                                   |
|----------------------|-----------------------------------------------------------|----------------------------------------------|
| `--dry-run`          | copy fixture → git baseline → run tests only              | `0` all baselines failed as expected · `1` otherwise |
| `--baseline-solution`| as above, but applies `solution.patch` first              | `0` all suites fully green · `1` otherwise    |
| `--live`             | prepare → `agent_zero.headless` agent → grade → score     | `0` graded · `3` backend module missing (SKIP)· `1` other failures |

Every invocation writes into `eval/runs/<UTC-timestamp>/`:

```
<TASK_ID>/repo/         the freshly prepared working repo (git baseline commit)
<TASK_ID>/result.json   backend output (live mode only)
<TASK_ID>/agent_*.log   backend stdout/stderr (live mode only)
<TASK_ID>/test.log      captured test output from grading
report.json             machine-readable results incl. scores
report.md               human-readable markdown table + notes
```

---

## 2. Scoring math (SPEC §12 — binding)

For a task with **A** = fraction of passed tests, **C** = cost in USD,
**T** = wall time in seconds:

```
Score_task = 10·A / (1 + 0.65·(max(C,0)/0.15)^2.5 + 0.35·(max(T,1)/1320)^2.5)
```

Derivation / intent:

* The score starts from a perfect `10·A`.
* Two soft penalties divide it down, both raised to power **2.5** so that
  moderate overspending hurts mildly while gross overshoot is crushed:
  * **cost penalty**, weight `0.65`, normalised at **$0.15** — spending
    exactly $0.15 multiplies the score by `1/(1+0.65) ≈ 0.606`;
  * **time penalty**, weight `0.35`, normalised at **1320 s** (= 22 min,
    half of the 45 min wall cap) — taking 22 min multiplies by
    `1/1.35 ≈ 0.741`.
* Penalties combine additively in the denominator, so e.g. A=1 at
  C=$0.15 *and* T=1320 s scores `10/2 = 5.0`.
* **Hard caps** short-circuit the soft math: if `C > $0.50` or
  `T > 2700 s`, A is forced to 0 → score 0, regardless of test results.

Worked examples (A = 1.0 unless noted):

| C ($) | T (s) | Score |
|-------|-------|-------|
| 0.00  | 0     | ≈ 10.00 |
| 0.15  | 0     | 6.06  |
| 0.00  | 1320  | 7.41  |
| 0.15  | 1320  | 5.00  |
| 0.30  | 600   | 2.12  |
| 0.51  | any   | **0** (hard-fail) |

The aggregate result is the unweighted mean of per-task scores over the
graded tasks.

**Accounting contract:** C and T come **solely** from the backend's
`result.json` (§4). The harness never measures cost or wall time itself;
its own subprocess timeout is only a safety net.

---

## 3. Grading (A)

`grade()` copies hidden tests in (T2 only, see §5), runs the task's
`test_cmd` inside the prepared repo with `.venv/bin` prepended to PATH,
captures stdout+stderr into `<run>/test.log`, then parses **A** with
ordered heuristics:

1. **pytest-style summaries**: `\d+ passed`, `\d+ failed`, `\d+ errors`
   (e.g. `4 failed, 4 passed in 0.04s`);
2. **TAP lines**: lines starting with `ok` / `not ok` (used by the TS and
   node assert-based suites);
3. **loose markers**: line-counts of pass-ish (`passed/pass/ok/✓`) vs
   fail-ish (`failed/fail/AssertionError/not ok`) tokens;
4. **fallback**: `A = 1` iff the command exited 0, else `A = 0`.

A non-zero exit is required for dry-run expectations, but outputs that
look like infrastructure errors (exit 127, "command not found", pytest
collection errors) never count as a satisfying baseline failure.

---

## 4. Contract with the Agent-Zero headless backend

The backend is owned by another engineer. The harness invokes exactly:

```bash
<venv>/bin/python -m agent_zero.headless \
    --project <abs path to prepared repo> \
    --goal   <task instruction text> \
    --max-cost 0.5 \
    --max-wall 2700 \
    --json-out <run dir>/result.json
```

On completion the backend must write `result.json`:

| field         | type    | meaning                                            |
|---------------|---------|----------------------------------------------------|
| `success`     | bool    | whether the agent believes it finished the goal    |
| `cost_usd`    | float   | accumulated LLM spend → feeds **C** in the score   |
| `wall_s`      | float   | elapsed seconds → feeds **T** in the score         |
| `steps`       | int     | number of agent steps taken (reported only)        |
| `model_usage` | list    | per-model usage breakdown (reported only)          |

Graceful degradation: if the `agent_zero.headless` module is absent (or
any run ends without a `result.json` because the module could not be
imported), the harness prints a `SKIPPED` row with a note, keeps going,
and exits **3** after processing all tasks — so the harness itself stays
testable before the backend lands.

Hidden-test hygiene: `prepare()` commits the git baseline **before**
anything else; hidden tests are copied into the repo only when grading
starts, i.e. after the agent process has finished.

---

## 5. Fixtures

Each fixture is a tiny realistic repo (~6–10 files) plus harness metadata:

* `task.yaml` — `{id, title, instruction, tests, timeout_s}` (+ optional
  `solution_patch`, `hidden_tests`, `baseline_expectation`);
* `solution.patch` — unified diff from baseline to a verified-correct
  solution (used by `--baseline-solution`; excluded from agent-visible copies);
* `README.md` — in-repo documentation for the agent, like any real repo.

### T1-bugfix-python — "Fix disappearing todos"

Flask-*like* todo webapp on the standard library (`app.py` route table +
JSON API, `models.py` domain layer, `storage.py` JSON persistence).
Real bug: `TodoStorage.save()` tries to be smart and flush only the
not-yet-written tail (`items[self._flushed:]`) but reopens the file in
truncate mode, so the second save within a session silently drops
earlier todos — exactly the reported symptom. Tests: `pytest -q`
(8 checks: 4 pass pre-fix, 4 pin the regression). Baseline FAIL ✓,
reference solution PASS ✓.

### T2-feature-python — "Add full-text search"

Markdown-notes CLI (`notes.py` argparse front end, `noteslib.py`
storage: one `.md` file per note + `meta.json` index). Feature work:
implement `notes search TEXT` printing `RELATIVE_PATH:LINE_NO: TEXT`,
case-insensitive, ordered by path then line, quiet on zero hits.
Public tests cover existing commands only (they stay green throughout);
the acceptance tests live in `tests_hidden/test_search.py`, which the
runner copies into the repo **at grade time only** so the agent cannot
see them. Baseline (with hidden tests): FAIL ✓; reference solution: 11/11 ✓.

### T3-refactor-ts — "Extract a shared pagination helper"

Express-ish TypeScript catalog service with pure handler functions
(`src/routes.ts` duplicates the pagination block across three handlers,
`src/server.ts` entry point, seed data in `src/data.ts`). Task: create
`src/paginate.ts` exporting `paginate<T>(items, page?, size?)` and use it
from all three handlers with byte-identical behaviour. Tests
(`npx -y tsx test/api.test.ts`): six golden response checks pin current
behaviour (green before and after); three refactor-enforcement checks
require the helper module, its windowing semantics, and ≥3 call sites in
`routes.ts`. Baseline 6/9 FAIL ✓; solution 9/9 ✓.

### T4-cross-file-bug-js — "Fix the calendar month display bug"

Vanilla JS month-calendar widget: `js/util/date.js` shared date helpers,
`js/calendar.js` grid builder, `js/app.js` DOM wiring, `index.html`.
Cross-file bug: `daysInMonth()` computes `new Date(year, month, 0)` —
day 0 of *the same* month instead of the next — so every month reports
its predecessor's length (February 2024 renders 31 cells). Tests:
`node test/node-test.js` (8 plain-assert checks, TAP-style output).
Baseline 3/8 FAIL ✓; solution 8/8 ✓.

---

## 6. Adding a fixture

1. `mkdir eval/tasks/T<N>-slug` and build a small realistic repo.
2. Add `task.yaml` (five canonical keys; set `baseline_expectation: fail`
   for bugfix/feature tasks).
3. Write tests whose pre-state fails for the *intended* reason; keep some
   always-green checks for partial credit.
4. Produce `solution.patch`:
   copy the fixture to a scratch dir, `git init && git add -A && git
   commit`, implement the fix, `git add -A && git diff --cached >
   <fixture>/solution.patch`.
5. Verify: `runner.py --dry-run --tasks <N>` then
   `runner.py --baseline-solution --tasks <N>`.

## 7. Troubleshooting

* `pytest: command not found` — the harness prepends `.venv/bin` to PATH
  automatically; run tests manually via `PATH=$PWD/.venv/bin:$PATH pytest -q`.
* Python fixtures include a root `conftest.py` that puts the repo root on
  `sys.path` — bare `pytest` does not add the working directory itself.
* T3 uses `npx -y tsx`; the sandbox resolves it from the local npm cache,
  no network needed after first fetch.
* Never edit anything under `eval/runs/` — it is regenerated output.
