# Fix plan: refresh-stickiness, folder-scoped tasks, sibling context, + confirmed bugs

## Root causes confirmed (live reproduction)

**RC1 — Task-rollover strands the selection (the "refresh is buggy" bug).**
A followup sent to a TERMINAL task makes the engine archive the old TaskRecord and
mint a new UUID (same session). `POST /api/tasks/:id/message` responds
`{ok:true, delivered:"history"}` WITHOUT the new task id, so the web keeps
`activeTaskId` = dead UUID. The select then shows a stale row/status, TaskControls
and BudgetMeter vanish, and after a page refresh the dead UUID isn't in
`GET /api/tasks` → "— no task selected —" while the chat shows a zombie timeline.

**RC2 — Task list is unscoped.** `GET /api/tasks` returns every session across all
46 registered projects (89+ rows mixed); no `?projectId=` support; the TopBar
select has no grouping (no optgroups). User wants: current folder by default,
"All tasks" grouped by folder.

**RC3 — Agent has zero sibling-task context.** planTask's userBlock carries goal +
repoMap + pins + recent messages of THIS session only. Sibling tasks in the same
project (which the user says are interconnected) are invisible to the planner.

## Fixes (TDD: failing test first for each)

### Engine (engine/src)

1. **`GET /api/tasks?projectId=`** — filter the roots map to one project; unknown
   pid → `[]` (never fall through to all). (~6 lines in index.ts:577)
2. **`POST /api/tasks/:id/message`** — return `taskId` (the post-rollover task
   UUID) in the response so the web can follow the rollover.
3. **pastTasks identity** — shared `findSessionByAnyId(id)` (session id, task id,
   pastTasks ids) used by `GET /api/tasks/:id`, stop, resume, spans, proposals,
   events, SSE; 404 when nothing matches instead of silent `{ok:true}`.
   Fix taskId misattribution for archived tasks (events/SSE fallback = matched
   past-task id, not current task id).
4. **Task list hygiene** — exclude `meta.delegated` subtask sessions from
   `GET /api/tasks` rows.
5. **Sibling digest (RC3)** — `siblingDigest(session)`: ≤5 most-recent sibling
   sessions (updatedAt DESC via listSessions), skip self + delegated, each row
   `- [status] title (≤60ch): summary (≤100ch)`, total block capped at 1200 chars,
   injected in planTask's userBlock. Persist `task.resultSummary` in finalize()
   (fallback: last meta.taskFinal message) so future runs see real outcomes.
6. **runTask pre-try throw** — controllers-map throw + loadSettings inside try /
   failTask in callers' catch: mark task failed instead of stranding "planning".
7. **Pins dead store** — `/api/context/pins` now registers refs on the ACTIVE
   session's contextRefs (project-scoped, persisted) so @file pins actually reach
   the model; keeps array response shape for the ContextPanel.

### Web (web/src)

8. **Follow rollover** — `sendFollowup` reads `taskId` from the response;
   `selectTask(newId)` when it differs from active (keeps chat continuity).
9. **Folder scoping (RC2)** — ui store: `taskScope: "folder" | "all"` (persisted,
   default "folder"); `refreshTasks` passes `?projectId=` when scope=folder and
   projectId known; TopBar select renders `<optgroup label=folder>` per project;
   a scope toggle chip ("This folder" / "All folders"). Selecting a task from
   another folder in All-mode still opens that project (existing behavior).
10. **Refresh stickiness hardening** — `refreshTasks`: if persisted active id no
    longer resolves in tasks (dead/rolled-over), resolve via the session that
    holds it as pastTask → select that session's CURRENT task id (stick to the
    conversation, not the dead UUID); only clear when the session is truly gone.
11. **`forThisTask` fallback** — when the active id isn't in ui.tasks, don't let
    tid degrade to the stale id only: also match sessionId (sid) so frames with
    ev.taskId=new UUID pass.
12. **resetTask local[] leak** — also clear `local[taskId]` (dup-bubble guard).

## Verification

- `bun test` engine + web suites (new tests for each fix, red→green)
- Playwright E2E: followup-rollover → refresh → same conversation, folder-scoped
  select with optgroups, mid-run refresh live continuation
- `bash scripts/verify.sh` end-to-end
