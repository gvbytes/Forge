# Agent IDE — Extensive Fix Plan

Companion to `BUG-REPORT.md` (44 findings, B/E-numbered). Ordered into 8 phases by user impact and dependency. Each phase lists: bugs fixed, concrete changes (file-level), and a verification step. Estimated effort assumes one developer familiar with the codebase.

**Guiding principles**
1. Fix the *contract* between engine ↔ web ↔ router first (events, ids, task identity) — most "buggy" symptoms are one broken contract surfacing in many places.
2. Never regress the verified-working list in BUG-REPORT §6 (router tests + engine/router confirmed-working sections are the regression baseline).
3. Every phase ends with a runnable verification; add tests as you go (router already has a `bun test` suite to extend).

---

## Phase 0 — Make it launch (½ day) — fixes E1–E5, B43
| Bug | Fix |
|---|---|
| E1 | `start.sh`: exec `"$SCRIPT_DIR/scripts/dev.sh"` (drop the bogus `agent_ide/` segment). |
| E2 | `scripts/dev.sh`: resolve bun robustly — `BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")`; fail fast with a message if missing. |
| E3 | dev.sh: export `CI=true` (or set `confirmModulesPurge=false` via `.npmrc` in `web/`) before `pnpm dev`. |
| E5 | dev.sh: pass `ENGINE_URL=http://127.0.0.1:4100` to the router; start engine before router. |
| E4/B43 | Fix `AGENTS.md` (4090→4098) and `router/src/index.ts` header comment; `test_e2e.ts` → `ENGINE_PORT`. |
**Verify:** `./start.sh` from a clean non-TTY shell brings up all three services; `curl :4100/api/health`, `:4098/health`, `:4444` all 200; router log shows immediate watchdog attach.

---

## Phase 1 — Make the chat live again (1–2 days) — fixes B1–B6, B19–B20, B32, B34, B35
This is the core UX fix. Strategy: **single event contract, engine is source of truth, web renders the engine's real vocabulary.**

### 1.1 Engine: one id space + persisted wire events (B4, B3)
- In `engine/src/bus.ts` (or a new `events.ts`), assign every wire event a monotonic id from the **trace id scheme** (`Date.now() − EPOCH + seq`, already restart-safe in `trace.ts:26-35`). Keep a per-session ring of the last N wire events (messages/proposals/approvals/status/task) alongside the trace ring.
- `GET /api/tasks/:id/events` (`index.ts:468-485`): merge trace events **and** wire events, sort by id, honor `?since=` (return only `id > since`). Emit user/assistant `message` events from `session.messages` as synthetic wire events so reload restores the full conversation (B3).
- SSE handler (`index.ts:1164-1188`): use the same id source; drop the `...e` spread-after-payload pattern (build the DTO explicitly) to prevent field clobbering.

### 1.2 Engine: bridge tools + normalize kinds (B1, B2)
- Add a trace→wire bridge once at startup (`index.ts`): `trace.subscribe(e => wire.emit({type:"trace", event:e}))`; remove the manual mirror in `orchestrator.ts:104`/`chat.ts:38` to avoid double-emit. This alone makes tool.call/tool.result live (B2).
- Emit the kinds the UI can act on, with stable payloads:
  - `llm.call` already carries `output` (assistant text) — keep.
  - `task.start` input: include `goal` as a **string** field (`input:{goal: text}` already is; also add top-level `label` fallback) so the goal bubble renders live and after reload (B35).
  - `task.end` output: include `summary` text for the summary card.
  - `route` wire events: include `decision` (already) — web maps it (1.3).

### 1.3 Web: render the engine's real vocabulary (B1, B33, B34)
Rewrite `deriveTimeline`'s switch (`web/src/stores/chat.ts:170-525`) around the actual contract:
- `trace` kinds: `llm.call`→thought bubble (text from `p.output`, route from last `route` decision); `tool.call`/`tool.result`→tool rows (merge by `spanId`); `agent.start/end`→phase notices; `llm.retry`→notice; `task.start`→goal; `task.end`→summary card; `error`→error notice; `compaction`→notice; `review`/`diff.propose`→notices.
- Wire `route`→store `lastRoute` (model from `decision.modelId`, provider, reasons from `decision.reason`/`signals`) → RoutingBadge on thoughts (revives dead RoutingBadge, web #18).
- Wire `status`→`patchTaskStatus` keyed by **both** `ev.taskId` and session lookup; move the patch out of the render-phase `useMemo` into the SSE `onmessage` handler (B34).
- Delete handlers for types the engine will never emit (`bytheway.*`, `subagent.*`, `checkpoint.*`, `routing.selected`, `llm.response`, …) or keep them only if Phase 5 implements them.

### 1.4 Web: stream hygiene (B20, B32)
- `useTaskStream.onmessage`: drop frames where `ev.taskId && ev.taskId !== taskId && ev.taskId !== sessionIdOf(taskId)` (B20).
- Follow-ups: mark the optimistic local bubble `sent` and suppress the server echo with the same message id, or stop emitting the echo for messages the client already rendered (B32).

### 1.5 Task identity (B19)
- Engine `POST /api/tasks` (`index.ts:239-311`): create the `TaskRecord` **synchronously before responding** (move task creation out of async `runTask` into the route), return the real task UUID as `id`/`taskId` plus `sessionId`.
- Web: `ui.newTask` keeps `t.taskId`; all lookups (`TaskControls`, `BudgetMeter`, select) match `t.id === id || t.sessionId === id`; `patchTaskStatus` matches both too.
**Verify:** start a task in the UI; watch goal → thoughts with routing badge → tool rows → summary appear live with zero reloads; reload mid-task → full timeline + conversation restored, correct order, no duplicates; run two tasks concurrently → timelines stay separate; status chip tracks planning→running→done live.

---

## Phase 2 — Restore human-in-the-loop (1 day) — fixes B5, B6, B7, B12, B25
| Bug | Fix |
|---|---|
| B7 | `tools.ts:1057-1066`: default semantics = gate when `spec.sideEffect && requireApprovalFor.includes(name)`. Replace the mode enum with explicit `approvals: {mode: "gate" \| "auto"}` defaulting to `"gate"`; add `approvals` to the `AppSettings` type (engine #1). Settings UI already lists the tools — wire it to this setting. |
| B5 | Engine PATCH hunks handler (`index.ts:772-801`): read `{ accept }` (accept the web contract) **and** `{ accepted }` for compat; persist per-hunk decisions on the `FileDiff.hunks` (add `status`/`reason` fields); reject branch updates state + emits `proposal`; respond with the full `ProposalDto` (via `toProposalDtos`) so the UI can replace it. |
| B6 | Encode file identity in the hunk route: parse `${pid}_${fileIdx}` and apply only to that file (`p.files[fileIdx]`); keep hunkIndex addressing within the file. |
| B12 | `apply.ts:195`: honor `allAccepted` in the modified branch (`if (allAccepted || wanted.has(...))`). Add a unit test: modified-file proposal + accept-all writes the file. |
| B25 | `GET /api/settings`: mask `api_key`/`apiKey` always (`"••••••••"` when set); PUT: treat masked value as "keep existing" (copy from current settings by provider id). |
**Verify:** with default settings, `write_file`/`run_command` park in the approval dock; approve → applied via reviewed diff; diff overlay per-hunk accept applies exactly that hunk of exactly that file (multi-file proposal test); reject persists across reload; badge counts clear; settings round-trip never clobbers keys.

---

## Phase 3 — Make agents behave (1–2 days) — fixes B9, B10, B11, B14, B15, B16, B26, B28, B30, B31, B44
| Bug | Fix |
|---|---|
| B9 | `runTask`: when `session.task` exists in a **terminal** status (done/failed/stopped), archive it (`session.pastTasks.push(task)` or fresh `session.task = null`) and create a new task for the new prompt; reset plan/stepCount/goal/tokensUsed/costUsd. Belt & braces: `drive()` skips steps with `status === "done"`. |
| B10 | Give each step its own `AbortController` chained off the task controller; the 480 s guard aborts it instead of just racing; `runStep` checks `stepCtl.signal` before every LLM/tool call and before `saveSession`/`emitTask` in its tail; `executeTool` already accepts a signal — pass the step's. |
| B11 | Boot reconcile (`sessions.ts:57-67`): mark crashed tasks `stopped` **and** set `task.meta.bootInterrupted = true` when a runState exists; extend the resume predicate to accept `stopped + bootInterrupted + runState`. Pin system+step-context messages in `persistRunState` (never slice them out) and honor `RunState.phase` on resume (engine #21). Fix attempt double-count (`orchestrator.ts:413-415`): `resume ? resume.attempts : step.attempts + 1`. |
| B14 | Broaden `isTrivial`: also accept short imperatives — `words ≤ 12 && !CODE_INTENT && !mentionsFiles` (no `@refs`, no paths), plus keep the question path; narrow `CODE_INTENT` (require the verb to govern an object-ish token, or drop the most generic words like "add"/"update" when `words ≤ 8`). Ship with evals: the 10 canonical trivial prompts answer in one call; the 10 canonical code asks still plan. |
| B15 | `providers.ts`: when `usage` is missing, fall back to `estTokens(prompt)` / `estTokens(text)` and mark the estimate; count race-loser tokens too (they were spent). Now cost/token caps actually bind. |
| B16 | Make racing opt-in/adaptive: default to single-model calls; race only (a) when the primary's health is degraded, or (b) as the existing second-round/sweep escalation. Keep `chatRace` for those paths. Classify empty-200 as its own outcome (`empty`) with a small penalty that is **not** breaker-trippable and not logged as 5xx. Raise `maxSlotMs` for coder/reviewer roles (90–120 s). Apply `disabledModels` + breaker state in `chatSweep`. |
| B26 | Stop remapping 400→503; pass real statuses and let `recordOutcome`'s existing 4xx exemption work. |
| B28 | After `resolveInRoot`, `fs.realpath` the target (and each existing ancestor) and re-check containment before read/write/apply; refuse escapes. Same in `apply.ts`/`fsops.ts`. |
| B30 | `runProcess`: spawn with `detached:true`, kill the process group (`process.kill(-pid, "SIGKILL")`) on timeout. |
| B31 | Dedup proposals: key by `taskId + path + content-hash`; skip `recordProposal` when an identical applied/pending proposal exists for the step. |
| B44 | Nudge delivery: `POST /api/tasks/:id/message` on a running task should push into a per-task `pendingNudges` queue that `toolLoop` injects as a user turn between calls (also fixes "followups ignored while running"). |
**Verify:** "Say hello" answers in one routed call (<10 s, <2k tokens); second prompt in a session plans fresh; kill -9 the engine mid-step → boot → resume continues the right step with context; force a model to 503 → no healthy-model poisoning; budget cap trips on estimated tokens; timed-out `sleep 1000 &` leaves no orphans.

---

## Phase 4 — Router: availability & honesty (1 day) — fixes B21, B22, B23, B38–B42
| Bug | Fix |
|---|---|
| B23 | Alias last-resort: when no tier provider is eligible, route the least-bad candidate anyway (mirror the forced-model branch's behavior) so alias traffic can self-heal `consecutive_429`. Distinguish errors: chain exhausted on 429s → return **429** with max Retry-After + `all providers rate-limited`; no config → 503 `no provider configured`. Engine `isQuotaBackoff` then works unchanged. |
| B21 | Restore `UPSTREAM_TIMEOUT_MS = 120_000` (or per-phase: connect 10 s / body 120 s); revert forced-body-model to header-only (`x-router-model`) unless the model is a known catalog id (fixes `model:"auto"` 503s and the 4 failing smoke tests); restore cooldown constants (default 15 s, max 300 s, `MAX_CONSECUTIVE_429` 8) or reconcile them with `OPEN_CIRCUIT_429` deliberately. |
| B22 | `WatchdogClient.loop`: reconnect with backoff on stream end/error while `attached`; re-probe engine health on a timer. Auto-attach: share ONE `AttributionService` instance between proxy and watchdog (pass the app's instance into `startWatchdog`). |
| B38 | Build the attempt chain starting with the policy-selected provider; scope the cooldown last-resort skip to the chain; call `notifyOutcome(taskId,"failure")` on the no-decision path. |
| B39 | In the 2xx-with-error branch: run `looksLikeRateLimitError` → `markRateLimited`; add a 5xx streak counter to provider health with cooldown. |
| B40 | Finalize task rows on idle (no call for X min) and on engine `task.end`/`status` wire events (once B8's parser is fixed); cap the governor maps. |
| B41 | `/models`: emit `id: model_id_per_provider[provider]` rows so engine discovery works (then wire `registry.refresh` to actually call it — see Phase 6). |
| B42 | `extractTool`: only set `errorOutput` when the frame marks failure (mirror the `message.part` branch's status check). |
**Verify:** extend `router/test/*` — new tests: alias-routes-during-cooldown, 429-aggregation-returns-429, auto-model-200, watchdog-reconnect; run full `bun test` in `router/`.

---

## Phase 5 — Watchdog integration & missing endpoints (1 day) — fixes B8, B18, B33(pause)
1. **Event contract (B8):** pick one direction and make it explicit in a shared doc:
   - Engine adapter (recommended, smaller blast radius): in the engine SSE, additionally emit watchdog-shaped frames the parser already understands — `tool` activity as `{type:"tool.call", properties:{sessionID, tool, args, state:{status:"completed"|"failed"}}}`, approvals as `{type:"permission.asked", properties:{sessionID, action}}` / `permission.replied`, task lifecycle as `task.started`/`task.finished` (dot suffix), errors as `session.error`.
   - Or rewrite `watchdog/events.ts` dispatch to parse the engine envelope (`type` + `payload.event.kind`).
   Either way: add a contract test that feeds **real recorded engine frames** (from this audit's SSE capture) through `WatchdogClient` and asserts signals increment.
2. **Missing endpoints (B18):**
   - `POST /api/bytheway` → wire the existing `runChat` (engine/src/chat.ts) — it already appends both sides, emits SSE, races models. Frontend works unchanged.
   - `GET /api/index/status` + `POST /api/index/rebuild` → expose `retrieval.stats()` / `ensureFresh(root, pid, {force:true})`.
   - `GET /api/websearch` → reuse the tools.ts `web_search` handler.
   - Snapshots: either implement `GET /api/tasks/:id/snapshots` from the existing in-task snapshot map + trace `context.snapshot` events, or delete the dashboard's snapshot UI (ponytail choice: delete until needed).
   - Pause: implement `POST /api/tasks/:id/pause` as abort-with-resume-state (controller abort + status `paused` + runState persist), or remove the Pause button. Recommend: remove button now, implement later.
**Verify:** run a task that repeats one tool call 6× → watchdog `signals>0` and a nudge fires; `/bytheway what port does the engine use?` answers live; index status shows real chunk counts.

---

## Phase 6 — Security hardening (½–1 day) — fixes B17, B25(done in P2), B27, plus engine hardening
| Item | Fix |
|---|---|
| B17 `/api/run` | Require the same approval gate as `run_command` when `cmd` is caller-supplied (or restrict to the interpreter-by-extension path and drop `cmd`); spawn with `scrubEnv()`; cap output buffers. |
| Auth | Add a shared-secret option: `ENGINE_API_TOKEN` / router `ROUTER_API_TOKEN`; all mutating routes require `Authorization: Bearer …` when set; Vite proxy injects it. Off by default for dev ergonomics, documented. |
| CORS/origin | Engine: reject state-changing requests whose `Origin`/`Referer` isn't in the trusted list (mirror the router's existing guard). |
| `/api/fs/list` | Keep browsing (project picker needs it) but gate it behind the same origin guard; stop returning `home`. |
| Misc | `grep` tool in a worker with time budget (ReDoS); `chatStream` onMeta-on-[DONE] if kept; delete or wire dead code (`chatStream`, models.dev discovery, `context.ts maybeCompact`) — decision: wire `/models` discovery (router B41) into `registry.refresh` since the code already exists, delete `chatStream`. |
**Verify:** malicious-origin fetch to `/api/run` blocked; `cmd:"curl …"` without approval rejected; symlink-escape test (ln -s /etc/passwd inside project → read_file refuses).

---

## Phase 7 — Frontend polish & correctness sweep (½–1 day) — fixes B36, B37, web lows
- TerminalPanel: `api.termWsUrl(projectId)` → `/api/term?projectId=…`; engine applies real resize (`script -qfc` + `stty cols/rows` or node-pty later); fix SSE subscribe race (single subscribe, replay from it).
- Editor: implement `expected_mtime` check + 409 + `current_mtime` in `handleFileWrite` (or drop the conflict UI).
- Chat: render markdown in bubbles (tiny dependency-free renderer or `marked`); dedupe followups (done in P1); clear module-level caches on task switch.
- TopBar: poll tasks every 10 s as a safety net under SSE; fix status vocabulary to engine's (done in P1).
- Delete/replace dead UI paths found in web #22/23/26 (hardcoded preview URL → relative via proxy; dev quick-jump paths → recent projects).
**Verify:** terminal opens in project root and resizes; editor save-conflict path exercised by two-tab test.

---

## Phase 8 — Tests & regression net (ongoing, starts with Phase 1)
1. **Event contract golden test:** record engine SSE for a canned task; assert the web `deriveTimeline` renders goal/thoughts/tools/summary (jsdom or plain unit test on the store).
2. **Engine:** unit tests for `isTrivial` matrix, `runTask` second-prompt fresh-plan, step-abort propagation, resume-after-crash, apply `allAccepted`, proposal dedup, approval gating default.
3. **Router:** the four new tests from Phase 4 + watchdog contract test with real frames.
4. **E2E:** fix `test_e2e.ts` (ENGINE_PORT), extend it: create task → poll until done → assert events endpoint returns messages+traces with one id space → assert proposals applied once.
5. Add `pnpm typecheck` (web `build` already runs tsc) + `bun test` for all workspaces to `scripts/build.sh` so CI catches regressions.

---

## Suggested sequencing & effort

| Phase | Effort | Unblocks |
|---|---|---|
| 0 Launch | ½ d | everything else (app starts) |
| 1 Live chat | 1–2 d | the #1 user complaint |
| 2 HITL | 1 d | safety; trust in the agent |
| 3 Agent behavior | 1–2 d | the #2 complaint (speed/correctness) |
| 4 Router | 1 d | availability under free-tier rate limits |
| 5 Watchdog+endpoints | 1 d | stuck-task safety net; /bytheway etc. |
| 6 Security | ½–1 d | hardening before any wider use |
| 7 Web polish | ½–1 d | fit & finish |
| 8 Tests | continuous | keeps it fixed |

**Total: ~7–10 focused dev-days to a substantially solid product.** Phases 0–2 alone (~3 days) fix every symptom the user reported.
