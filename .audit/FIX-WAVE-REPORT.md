# Task/refresh/folder-scope fix wave — final report

## User-visible fixes (all verified live via Playwright E2E)

### 1. Refresh sticks to the same task (the core bug)
- **Root cause**: a followup to a terminal task ARCHIVES the old TaskRecord server-side and mints a NEW UUID in the same session; the old response never carried the new id → UI stuck on a dead UUID → after refresh "no task selected" with a zombie timeline.
- **Engine**: `POST /api/tasks/:id/message` now calls `ensureTask` synchronously and returns `{taskId, sessionId}` on BOTH paths (nudge + history). All identity routes resolve archived `pastTasks` ids via one shared `findSessionByAnyId` (stop/resume honestly 404 for archived ids; events attributed to the REQUESTED task id).
- **Web**: ChatPane follows the rollover (`selectTask(new)`), migrates optimistic bubbles + event buffers under the new key (order matters: select FIRST, then migrate — `resetTask` wipes the new key), and `refreshTasks` resolves any stale/dead id to the session's CURRENT task before clearing.
- **E2E**: rollover followed ✔, refresh sticky ✔ (same task selected, full conversation 51 items).

### 2. Task list scoped to the folder, "All tasks" grouped by folder
- `GET /api/tasks?projectId=` scopes to one project (unknown pid → `[]`, never all).
- Web default scope = "folder" (persisted `agent-ide.taskScope`); scope chip toggles to "all".
- "All" mode groups by folder via `<optgroup label="📁 folder (n)">`; folder mode stays flat.
- Delegated subagent sessions (meta.delegated) are hidden from the list.
- **E2E**: folder mode = 36 options / 1 project; all mode = 93 options / 45 optgroups ✔.
- **Bonus bug found live**: `Object.entries(<Map>)` returns `[]` → select rendered EMPTY while the store had tasks. Fixed (pairs array) + regression test.

### 3. Agent context about sibling tasks (no window bloat)
- `siblingDigest(session)` in planTask's userBlock: ≤5 most recent sibling tasks in the same project (excludes self + delegated), ≤100-char summaries, 1200-char total cap (~300 tokens — 20-80× headroom vs caps).
- `task.resultSummary` persisted in `finalize()` (new TaskRecord field) so digests carry real outcomes.
- **Live proof**: temporary context.snapshot trace showed "sibling digest attached (659 chars, 5 rows)" in a real task's journal; 7 tasks already have resultSummary.

### 4. Other bugs fixed in this wave
- `runTask` pre-try throws (controller collision) no longer strand a task in "planning" — outer catch marks it failed + emits an error card.
- `contextPins` dead store: pins now persist to the session's `contextRefs` (source:"user") so they actually reach the model; survive restart; project-scoped.
- `POST /api/tasks` with a foreign-project sessionId no longer silently forks an empty session (resolves the owning project first).
- SSE handler uses the shared resolver; archived-id subscriptions attribute frames to the requested id.
- `forThisTask` accepts rolled-over frames during the list-refresh gap (sessionId match).
- `resetTask` no longer leaks optimistic local bubbles across selections.

## Verification
- Engine: 373 bun tests pass (15 new: task-scope ×5, rollover ×7, sibling-digest ×4), `tsc --noEmit` clean.
- Web: 21 bun tests pass (8 task-scope/refresh-stickiness + 2 grouping regression), `tsc --noEmit` clean, `vite build` clean.
- `scripts/verify.sh`: 14/14 passed.
- Playwright E2E (live stack): project open → folder scope → all-folders optgroups → task select → followup rollover → refresh sticky → chat continuity. All green.
- Sibling digest proven live via journal trace (removed after proof).

## Files changed
- engine/src/index.ts, engine/src/orchestrator.ts, engine/src/types.ts
- engine/test/{task-scope,rollover,sibling-digest}.test.ts (new)
- web/src/stores/{ui,chat}.ts, web/src/lib/{api,composer}.ts
- web/src/components/{TopBar,ChatPane}.tsx, web/src/hooks/useTaskStream.ts
- web/test/{task-scope,topbar-grouping}.test.ts (new)

## Dev stack left RUNNING
engine :4100, router :4098, web :4444 (vite dev — GUI at http://localhost:4444).
