# Agent IDE frontend audit — `web/src` vs engine wire contract

## Why "the chat is not showing live stuff" — root causes first

**1. CRITICAL — Event vocabulary mismatch: nearly everything the engine emits live is silently dropped**
`web/src/stores/chat.ts:190-210` (trace case), `289-291`, `231`
The engine's wire bus emits exactly these types (`engine/src/types.ts:221-230`, `orchestrator.ts:93-107`): `trace`, `route`, `task`, `session`, `message`, `status`, `proposal`, `approval`. Trace kinds are `task.start / task.end / agent.start / agent.end / agent.thought / llm.call / llm.retry / route / review / compaction / diff.propose / error` (`types.ts:51-70`). `deriveTimeline` renders trace kinds `llm.plan/llm.coder/llm.reviewer/tool.call/task.finish/approval.request` — **none of which the engine emits** — and top-level types `routing.selected`, `llm.response`, `tool.requested/approved/rejected/result`, `plan.created`, `task.finish`, `context.compacted`, `bytheway.*`, `subagent.*`, `checkpoint.*` — **none of which exist on this engine**. Net effect: during a running task the only things that render are the user `message`, the goal (`task`), `proposal`/`approval` cards and the final summary `message`. All assistant output (`llm.call`, whose `output: clip(res.text, 600)` is at `orchestrator.ts:1122-1126`), all agent phases, errors, compaction, route decisions arrive and fall into `default: break` (`chat.ts:523-524`). Fix: map the real kinds — `llm.call`→thought, `task.end`→summary, `route`→lastRoute (from `payload.decision`), `error`→notice, `agent.*`→notices.

**2. HIGH — Tool calls never arrive live at all**
`engine/src/tools.ts:1116-1124, 1174-1182`
`tool.call`/`tool.result` are emitted with `trace.emit(...)` directly, which does **not** go through the orchestrator's `emit()` wrapper that mirrors to `wire` (`orchestrator.ts:104`). So SSE never carries tool activity; it only appears after a REST backfill (page load / reconnect heal). The live tool spinner rows in `ChatPane` can never appear during a run. Fix: mirror tool spans onto the wire (engine) or render `agent.thought` tool rows (web).

**3. HIGH — Backfill cannot heal missed wire events; user's first message is always lost**
`web/src/hooks/useTaskStream.ts:26-33,66`; `engine/src/index.ts:468-485`
`heal()` only fetches `GET /api/tasks/:id/events`, which returns **trace events only** (`type: e.kind, payload: e`). Wire events (`message`, `proposal`, `approval`, `task`, `status`) are never persisted, so anything emitted while disconnected — including the user message emitted during `POST /api/tasks` (`index.ts:290`) *before* the EventSource connects — never reaches the pane. The `?since=` param the client sends (`lib/api.ts:88`) is ignored by the handler. Fix: server-side per-session wire-event ring with `since` replay.

**4. HIGH — No taskId filtering: SSE is a global firehose, all sessions mix into one timeline**
`web/src/hooks/useTaskStream.ts:44-54`; `engine/src/index.ts:1164-1193`
`api.sseUrl(taskId)` → `/api/events/:id`, but `sseHandler` ignores `:id` and broadcasts every session's events. `onmessage` appends every frame to `events[taskId]` without checking `ev.taskId`. With ≥2 sessions, both chats contaminate each other. Fix: filter `ev.taskId === taskId || ev.taskId === undefined` client-side (or filter server-side).

**5. HIGH — Two colliding id spaces scramble ordering and arm a silent-drop landmine**
`web/src/stores/chat.ts:83,93`; `engine/src/index.ts:1162,1170`; `engine/src/trace.ts:26-35`
Live SSE ids are `++sseEventSeq` starting at `Date.now()` (≈1.78e12); backfill trace ids are `Date.now() − 1_700_000_000_000` (≈8e10). `backfill` merges and `.sort((a,b)=>a.id-b.id)`, so **all** backfilled trace events sort before **all** live wire events regardless of real time (user bubbles render after tool rows after reload). `append` drops any event with `id <= last.id` — today trace ids happen to be smaller so live events survive, but the monotonic guard assumes one id space; any backfill payload with larger ids (or the `e.id || idx` fallback) silently drops live events as "replayed". Fix: keep separate namespaces or compare per-source.

**6. HIGH — Live status updates never reach the task list (id keyed wrong)**
`web/src/stores/chat.ts:269-273`; `web/src/stores/ui.ts:146-150`; `engine/src/index.ts:1171`
SSE DTO sets `taskId: e.sessionId`, so `status`/`task.finish` handlers call `patchTaskStatus(sessionId, …)`, but `patchTaskStatus` matches `t.id === tid` — and `GET /api/tasks` rows have `id: task.id` (a UUID) with `sessionId` separate. Live done/failed/waiting flips are dropped; the top-bar chip stays "running" until manual ⟳. Fix: match `t.id === tid || t.sessionId === tid`.

**7. HIGH — Per-hunk Accept/Reject in diff review is completely broken (field-name + response-shape mismatch)**
`web/src/lib/api.ts:81` sends `{ accept, reason }`; `engine/src/index.ts:776` reads `const { accepted } = …` → always `undefined` → the accept path never runs (every click lands in the reject no-op branch at `index.ts:798-800`, which persists nothing). Additionally the response is `{ok, result, proposal}`, not a `ProposalDto`, so `DiffReview.replaceProposal` (`diff/DiffReview.tsx:121-124`) matches no `id` and the UI doesn't update either way. Fix: send `{ accepted: accept }` and return/unwrap the updated proposal.

**8. HIGH — Task selection id mismatch hides controls/meter after creating a task**
`web/src/stores/ui.ts:181-184`; `web/src/components/ChatPane.tsx:211`; `TopBar.tsx:26,127-141`
`POST /api/tasks` returns `id: s.task?.id ?? s.id`; at creation the task doesn't exist yet, so `activeTaskId` = sessionId, but the task list later reports `id` = task UUID. `tasks.find(t => t.id === activeTaskId)` (TaskControls, BudgetMeter) returns null → no Pause/Resume/Stop buttons, "no task selected" meter, and the `<select value=…>` shows nothing until the user re-picks. Fix: resolve via `t.id === id || t.sessionId === id` everywhere (as `selectTask` already does).

## Other functional bugs

**9. MEDIUM — `/bytheway` always fails**: `lib/api.ts:55` POSTs `/api/bytheway`; no such route exists in `engine/src/index.ts` → every `/bytheway` bubble ends with `⚠ 404`. Fix: implement engine route (runChat exists unused in `chat.ts`) or remove the command.

**10. MEDIUM — Pause button always 404s**: `lib/composer.ts:22-24` POSTs `/api/tasks/:id/pause`; engine has only stop/resume. Fix: remove button or add route.

**11. MEDIUM — Terminal opens in the wrong directory**: `TerminalPanel.tsx:116-118` + `lib/api.ts:75` → `new WebSocket("/api/term")` with no `?projectId=`; engine upgrade handler falls back to `"default"` → `projectRoots().get("default")` misses (ids are root hashes) → shell starts in engine `process.cwd()` (`index.ts:1254-1261`). Fix: append `?projectId=${projectId}`.

**12. MEDIUM — Follow-up messages render twice**: `ChatPane.tsx:330-340` adds an optimistic local user bubble; the engine then echoes the same user message over SSE (`index.ts:425`) which `deriveTimeline` renders as a second user bubble (`chat.ts:172-173`). No dedupe/removal of the local item. Fix: drop the local item when the server echo lands (match by content/ts).

**13. MEDIUM — Status vocabulary mismatch in TaskControls/TopBar**: `ChatPane.tsx:214` uses `"awaiting_approval"`, engine uses `"waiting-approval"` (`orchestrator.ts:799`); `"queued"/"paused"` don't exist engine-side. Pause/Stop are disabled exactly while the task waits for approval; `TopBar.tsx:14-18` chip colors miss too. Fix: align strings.

**14. MEDIUM — Side effects during render + guaranteed extra re-renders**: `deriveTimeline` (inside `useMemo`, render phase) calls `useUi.getState().patchTaskStatus` (`chat.ts:234,271,481`), and `patchTaskStatus` always returns a new `tasks` array even when nothing matches (`ui.ts:147-149`) → every chat event re-renders TopBar and triggers React's "setState while rendering another component" path; runs twice per event under StrictMode. Fix: move status patching into the event handler (useTaskStream), no-op when unchanged.

**15. MEDIUM — `task.status` handler patches with a timeline-item id**: `chat.ts:481` `patchTaskStatus(id, st)` where `id` is `` `e${ev.id}` `` (line 166), not `ev.taskId`. Dead today (engine emits no `task.status`) but wrong. Fix: use `ev.taskId`.

**16. MEDIUM — Settings: raw API keys round-trip; keys can be clobbered**: engine `GET /api/settings` returns the **raw** key when `api_key` is set (`index.ts:93`), and `SettingsModal.tsx:158-165` binds it straight into the draft and PUTs it back. The `••` mask fallback is safe, but if a provider's id+name+base_url all change (or a new provider is added with empty key), `oldMatch` fails and the engine substitutes `"sk-engine-key"` as the real key (`index.ts:119-123`). Fix: mask server-side, send a sentinel client-side, never default to a fake key.

**17. MEDIUM — GOAL bubble never renders after reload**: live, the goal comes from wire `task` events (`chat.ts:180-188` via `payload.task.goal`); after reload only the backfilled `task.start` trace exists, whose `input` is the object `{goal, resumeFromStep}` — `asStr(p.input)` fails → no goal. Fix: read `p.input?.goal` / `p.label`.

**18. LOW — RoutingBadge is dead**: engine emits wire type `route` with `payload.decision` shaped `{modelId, provider, reason, signals}` (`types.ts:40-48`); frontend waits for `routing.selected` and `normalizeRoute` reads `model_key/provider_id/tier/reasons[]` (`chat.ts:138-148,289-291`). No badge ever shows. Fix: handle `route`, map `decision.modelId/reason`.

**19. LOW — No markdown rendering in chat**: bubbles render via `ClickableText` (plain text + file links); the engine's final summary is markdown (`**Task done**`, bullets — `orchestrator.ts:1396-1406`) and shows raw asterisks, newlines collapsed in `<p>`. Fix: render markdown.

**20. LOW — Multi-file proposal hunk ids collide**: DTO hunk id is the per-file `hunkIndex` (`index.ts:534`, `apply.ts:89` restarts per file); engine PATCH matches the **first** file containing that index (`index.ts:784-790`) → accepting file #2's hunk 0 applies file #1's hunk 0. Fix: prefix hunk ids with the file index (the `${id}_${fileIdx}` split at `index.ts:774` also breaks if base ids ever contain `_`).

**21. LOW — useProposals refetch race**: `useProposals.ts:28-38` only refetches when the *last* buffered event starts with `"proposal"`; a follow-up event committed in the same batch hides it. Fix: scan the new tail or key on a proposal rev.

**22. LOW — Editor save-conflict contract is imaginary**: `stores/editor.ts:48-83` relies on `expected_mtime`/409/`current_mtime` from `/api/files/write`, but the engine handler ignores `expected_mtime`, never returns 409 or `mtime` (`index.ts:925-935`) → concurrent-write detection is dead code and `mtimes` reset to 0.

**23. LOW — Dead endpoints in api.ts**: `indexStatus`/`reindex` (`api.ts:44-45`), `searchWeb` (77), `snapshotMeta`/`snapshot` (89-90) have no engine routes → guaranteed 404s where used (dashboard snapshots).

**24. LOW — ApprovalsPanel**: `decide()` never checks `r.ok` and removes the row optimistically even on failure (`ApprovalsPanel.tsx:25-30`); also polls every 2s despite live `approval` SSE events existing.

**25. LOW — TerminalPanel Agent replay is backfill-only**: filters `tool === "bash"` rows (`TerminalPanel.tsx:208-214`) which, per finding 2, only exist after backfill — the tab stays empty during live runs.

**26. LOW — Misc React/hygiene**: `EditorTabs.tsx:169-179` keydown effect has no deps array (re-attaches every render); `EditorTabs.tsx:164` hardcodes `http://127.0.0.1:4100` for previews; `ProjectPickerModal.tsx:111-119` hardcodes dev quick-jump paths (`/home/k/...`); `ChatPane.tsx:110` module-level `resolvedProposals` map never clears across tasks; `useTaskStream.ts:48` `Number(ev.id) || Date.now()` fallback can break monotonicity; engine chip (`ChatPane.tsx:257,311`) sends `engine` which the backend ignores (cosmetic deception).

## Confirmed working

- SSE transport itself: EventSource via Vite proxy (`ws`+http proxy OK), reconnect with capped exponential backoff, `heal()` on every reconnect, ping keepalives from engine.
- `message` event rendering (user + assistant), `proposal` HITL cards, `approval` notices, goal bubble on live `task` events.
- `append()` dedupe of true duplicates and `backfill()` id-set merge; `useTimeline` memo deps (`evs`/`local` identity) are correct — no infinite re-render from zustand selectors.
- Approve/Deny in `ApprovalsPanel`: `PATCH /api/approvals/:id` with `{approve}` matches the engine handler exactly.
- HitlCard Accept-All/Reject-All: `resolve_all` with `{accept}` matches the engine.
- Terminal WS protocol (`{input}`/`{resize}` frames vs `{type:"replay"|"output",data}`) matches `terminal.ts:132-177`; replay-on-connect works; Vite `ws: true` proxies the upgrade.
- `sendFollowup` → `POST /api/tasks/:id/message` body `{content}` matches; `createTask` body accepted; task stop/resume endpoints exist and resolve both id schemes.
- FileTree/EditorTabs REST shapes (`/api/files/tree|content|create|delete|rename`, `/api/run`) match engine handlers; `useStickBottom` auto-scroll logic is sound.
