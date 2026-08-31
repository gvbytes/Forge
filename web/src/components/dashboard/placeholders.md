# Dashboard / DiffReview workstream — notes & placeholders

Owner: observability-dashboard agent. Scope: `src/components/dashboard/**`,
`src/components/diff/**`, `src/dashboard.css`, dev harness files listed below.

## Exports the app shell will import (contract)

```ts
import { DashboardView } from "…/components/dashboard/DashboardView";   // props: { taskId: string; live?: boolean }
import { DiffReview, DiffReviewBadge } from "…/components/diff/DiffReview";
// DiffReviewBadge({ count }) → tiny red pill for the top bar (pending-hunk count)
```
Both also have `export default` aliases. All CSS class names are `az-*` prefixed;
`dashboard.css` defines `--az-*` vars on `:root` (dark theme #0d1117/#161b22/cyan).

## Deviations / coordination notes for the shell agent

1. **`frontend/package.json` was missing** when this workstream started (only
   `src/lib/*.ts` existed). I bootstrapped a minimal one (react 18, vite 5,
   typescript); the shell agent then merged in `@monaco-editor/react` +
   `zustand`. Treat package.json as shared — coordinate further edits.
2. **pnpm ≥11 settings live in `frontend/pnpm-workspace.yaml`**, not
   package.json. It now contains `allowBuilds: esbuild: true` +
   `onlyBuiltDependencies: [esbuild]`; without it installs fail with
   `ERR_PNPM_IGNORED_BUILDS` (pnpm blocks esbuild's postinstall by default).
3. **No extra API calls were needed beyond lib/api.ts.** ~~`api.snapshot(taskId, id)`~~
   The snapshot fetch UI was REMOVED (audit B18: engine will not implement
   `/api/snapshots` for now); the Context tab shows inline `context_snapshot`
   payloads only. If the backend later exposes
   `GET /api/tasks/:id/proposals` deltas or SSE span streams, wire them into
   `DashboardView`'s poll loop (currently `api.spans` every 3s while `live`).
4. **DiffReview state**: resolve responses (`api.resolveHunk/resolveAll` return
   the updated ProposalDto) replace the local copy immediately AND call
   `onResolved(updated)` so the shell/store can persist. No proposal-refetch
   endpoint is used.
5. **Reject-reason prompt**: v1 uses `window.prompt`; **Cancel = reject without
   reason** (reason is optional per spec). Flip this if UX wants Cancel=abort.
6. **Output tab renders markdown source in a styled `<pre>`** ("markdown-pre").
   Rich rendering intentionally deferred — Monaco/markdown-it belongs to the
   shell's editor stack.
7. **Proposal collapse**: statuses `applied`/`discarded` render as a summary
   line incl. feedback note with rejected ranges (uses response
   `rejected_ranges` if present, else derived from rejected hunks). Status
   `resolved` stays expanded with buttons disabled.
8. `SpanDetail` accepts optional `initialTab` (used by tests/deep-links).
9. Live polling pauses when `live=false`; selection/filters survive polls;
   spans whose parent_id is null *or missing* render as roots (data-gap safe);
   cycles are cut defensively.

## Harness (visual QA without the app shell)

- Build: `pnpm --dir frontend exec vite build --config vite.config.dashboard.ts`
  → `dist-dashboard/` (separate outDir; main app build untouched).
- Serve: `pnpm --dir frontend exec vite preview --config vite.config.dashboard.ts`
  → open `/dash-dev.html`. Includes LIVE-polling toggle, mock fetch shim
  (resolve endpoints actually mutate state so accept/reject flows are visible),
  conductor→coder→llm/tool/retrieval/compaction/routing trace incl. an error
  span, a still-running span, and a dangling-parent orphan span.
- Headless sanity render: `node dist-dashboard/assets/ssr-smoke-*.js`
  (47 checks over tree/detail/tabs/timeline/diff markup).
