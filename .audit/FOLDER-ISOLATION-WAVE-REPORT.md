# Fix Wave: Folder Isolation + Zombie Approvals (RC3)

User bugs: "old chat and old codes in new folder", "asks permission pending before, right after
server start". Budget: 2 loops / 1hr. Critique agents: 4 parallel (folder-isolation plan,
engine boot/approvals, web state-leak sweep, UX of switching) + 2 diff critics (loop 2).

## Root causes found (all reproduced before fixing)

1. **openProject() never cleared per-folder state** (web/src/stores/ui.ts) — activeTaskId /
   activeSessionId survived a folder switch; refreshTasks' dead-id resolver then RE-SELECTED the
   old folder's task (it exists globally) → old chat rendered in the new folder. The prior wave's
   stickiness fix amplified this.
2. **TopBar typed-path bypass**: the path input mutates `projectRoot` on every keystroke, so a
   root-string `switched` compare said "same project" on the primary open flow. Fixed by deriving
   `switched` from `res.project_id !== prevProjectId`.
3. **Editor/ContextPanel state never reset** — old folder's tabs/buffers/content-cache rendered in
   the new folder (content cache reused old content for same-named relative paths).
4. **Zombie approvals at boot**: `loadPersisted()` re-armed persisted pendings < 30min old; their
   awaiting tool call lived in the DEAD process → the UI prompted for undecidable permissions right
   after server start.
5. **/api/approvals/pending was global** — any folder's pending prompted in the chat pane.
6. **reconcileBootSessions skipped waiting-approval** — a gated task restarted into a live-looking
   "waiting-approval" status whose approval had just been auto-denied (half-zombie).
7. **newTask used the input text as project root** — a typed-but-unopened path could hijack task
   creation into an unregistered folder.
8. **refreshTasks race**: an in-flight fetch scoped to the OLD project resolved after a switch and
   flashed the old folder's tasks into the new folder's select.

## Fixes (TDD — every one red→green)

| # | File | Fix |
|---|------|-----|
| 1 | web ui.ts openProject | On `switched`: clear selection+persist, chat.resetAll(), editor.resetProject(), tasks:[] — unless the selection belongs to the incoming folder (cross-folder task pick, boot follow) |
| 2 | web ui.ts | `switched` from projectId, not root strings |
| 3 | web editor.ts / ContextPanel.tsx | resetProject() action; content cache cleared on projectId change |
| 4 | engine approvals.ts + index.ts | reloadApprovalsForBoot() force-denies reloaded pendings at boot ("zombie across restart"); resume re-executes and mints FRESH approvals (verified live) |
| 5 | engine index.ts + web ApprovalsPanel | ?projectId= scoping (via findSessionByAnyId().pid); panel polls scoped, no-param stays global |
| 6 | engine sessions.ts | reconcileBootSessions covers waiting-approval → stopped + bootInterrupted |
| 7 | web ui.ts + api.ts | newTask passes projectId (opened identity), never input text |
| 8 | web ui.ts | refreshTasks drops payloads whose scope changed mid-flight |
| 9 | web chat.ts | resetAll() folder-pure chat buffers |
| 10 | web ui.ts | dead-id rollover follow only within the current project (taskInProject guard) |

Plus UX/a11y: folder-named empty state ("test — no task selected…"), switch toast names the
consequence, scope chip aria-pressed + aria-hidden emoji, visible .btn:focus-visible outline,
plain "no task selected" option label.

## Critique-agent findings folded in (evidence in session)
- selectTask cross-folder pick wiped by its own openProject (UX critic, reproduced live) →
  selectionBelongsToIncoming guard.
- boot restore wiped (web-sweep critic) → same guard (prevProjectId===null branch).
- typed-path bypass (web-sweep critic, confirmed primary flow) → projectId-derived switch.
- taskInProject projectRoot-vs-projectId compare nit; ContextPanel cache; conn[oldTaskId] (left:
  memory-only); unsaved-buffer confirm + per-folder last-task restore (deferred as refinements).

## Verification (fresh, this wave)
- Engine: `bun test` 378 pass / 0 fail; `tsc --noEmit` clean.
- Web: `bun test` 30 pass / 0 fail; `tsc --noEmit` clean.
- `scripts/verify.sh` 14/14 (own stack, dynamic ports).
- Live E2E (Playwright, dev stack 4444/4100/4098):
  - folder A → typed-path switch → B: no task selected, chat empty, editor "no file open", no
    approval prompt; empty hint names folder B.
  - switch back to A: honest empty selection, no zombie controls.
  - reload: projectRoot persists, no old-chat resurrection.
  - Real gated task (`sleep 1`): pending created → engine restart → boot force-deny
    (policy-auto-deny), global pendings 0, task stopped+bootInterrupted, POST /resume re-runs
    (fresh approval minted, approved → task done).
  - projectId-only task creation lands in the right folder.
- Red-green proven for: boot-approvals, waiting-approval reconcile, refreshTasks race guard.

## Loop-2 diff-critic findings (fixed + verified)
- web ui.ts: duplicated switch blocks merged (single if(switched) with belongs-guard).
- web ui.ts refreshTasks: re-read persisted key before adopting (stale-adopt race closed; red-green pinned).
- web ui.ts newTask: set selection BEFORE refreshTasks (honest-clear could null the fresh key on reload).
- web ApprovalsPanel: setPending([]) on projectId change (no 1-round-trip stale approvals).
- test folder-switch: flash-clear test rewritten with a slow /api/tasks stub (mid-flight assert; was false-green, now red-green proven).
- Engine critic items self-verified: no old-approval-id resolution path (tools.ts awaits only ids minted in-process); forceDeny callers all status-guarded (no double-deny); orphans covered by boot sweep; boot order correct; scoped endpoint 1.2ms with 159 projects (no memo needed).

## Deferred (refinements, not bugs)
- Per-folder persisted last-task (restore on return) — UX critic's preferred refinement.
- Unsaved-buffer confirm on folder switch.
- "All folders" live-task filter + task-search combobox.
- Settings-modal cross-folder pending-approvals queue (global endpoint remains available).
