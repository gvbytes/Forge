# Agent IDE — Extensive Bug Report

**Date:** 2026-08-26 · **Scope:** full monorepo `/workspace/agent` — `router` (:4098), `engine` (:4100), `web` (:4444), launch scripts, docs
**Method:** static audit of all ~24k LOC **plus live reproduction** against running services (all three services started; a real task executed end-to-end; SSE stream captured; router SQLite telemetry queried; 6 endpoints probed; watchdog status inspected).
**Companion docs:** `FIX-PLAN.md` (phased remediation plan) · per-service detail: `web-findings.md`, `engine-findings.md`, `router-findings.md`.

---

## 0. Executive summary

All three user-reported symptoms reproduce and have concrete, located root causes:

| Symptom | Root cause (short) | Bugs |
|---|---|---|
| **"Chat is not showing live stuff"** | Engine SSE event vocabulary and the web timeline renderer share almost **zero** overlap; tool calls are never bridged to SSE; chat messages are not replayed on reload; two incompatible event-id spaces scramble ordering | B1–B6 |
| **"Agents are not working properly"** | Trivial prompts over-plan (2 min / 7 LLM calls for "Say hello"); every LLM call races 3 models; alias models 503; approval gates disabled by default; watchdog blind; chat mode unreachable | B7–B15 |
| **"Project is very buggy"** | Broken launcher, 6 frontend endpoints 404, task-identity confusion, duplicate proposals, dead code presented as features, unguarded command execution endpoint | B16–B44 |

**Totals: 8 critical · 14 high · 14 medium · 8 low = 44 findings.** Every finding lists file:line evidence; every fix is specified in `FIX-PLAN.md`.

---

## 1. Environment & launch defects (all reproduced)

### E1 — `start.sh` is broken — HIGH
`start.sh:5` execs `$SCRIPT_DIR/agent_ide/scripts/dev.sh`; there is **no `agent_ide/` directory** — the script lives at `scripts/dev.sh`. `./start.sh` dies instantly.
Evidence: `ls: cannot access '/workspace/agent/agent_ide': No such file or directory`.

### E2 — `bun` missing from PATH — HIGH
`scripts/dev.sh` prepends `~/.local/bin` and calls `bun`, but only `bunx` was symlinked there; the binary lives at `~/.bun/bin/bun` (v1.4.0). Result: router+engine fail with `bun: command not found`. (Fixed during this audit by adding the symlink; dev.sh should self-locate bun instead.)

### E3 — `pnpm dev` aborts in non-TTY shells — MEDIUM
pnpm v11 verify-deps tries to purge+reinstall `web/node_modules` and demands interactive confirmation: `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]`. Headless/CI launch of the web tier fails until `CI=true` / `confirmModulesPurge=false`. dev.sh sets neither.

### E4 — Port/doc drift — LOW
`AGENTS.md` says router on **4090**; code default is **4098** (`router/src/index.ts:48`), dev.sh and the engine base URL (`engine/src/config.ts:22`) use 4098. The header comment inside `router/src/index.ts:4,24` also still says 4090. `test_e2e.ts:33` passes `PORT=4100` to the engine, which reads `ENGINE_PORT ?? AGENTZERO_PORT` (`engine/src/index.ts:1241`) — override silently ignored (works only because 4100 is the default too).

### E5 — Router watchdog attach races the engine — MEDIUM
`scripts/dev.sh` starts both services concurrently and passes no `ENGINE_URL`; router logs `engine unreachable at boot — retrying watchdog attach every 30s`. Retry eventually succeeds (verified `attached: true`), but there is a ≥30 s blind window and the topology is implicit.

---

## 2. CRITICAL bugs

### B1 — Live-chat event vocabulary mismatch (THE "chat not live" bug) — CRITICAL
- Engine wire types (`engine/src/bus.ts` emitters, `engine/src/types.ts:221+`): `session, message, trace, route, task, status, proposal, approval`. Trace kinds actually emitted (measured by grep over orchestrator/chat/tools): `task.start, task.end, agent.start, agent.end, agent.thought, route, llm.call, llm.retry, tool.call, tool.result, approval.request, approval.decision, compaction, review, diff.propose, error`.
- Web `deriveTimeline` (`web/src/stores/chat.ts:190-525`) renders trace kinds `llm.plan / llm.coder / llm.reviewer / tool.call / task.finish / approval.request` and top-level types `plan.created, routing.selected, llm.response, tool.requested/approved/rejected/result, context.compacted, stuck.detected, budget.exceeded, proposal.created/resolved, bytheway.*, subagent.*, checkpoint.*, task.status/done/failed, log` — **nearly none of which the engine ever emits**.
- Consequence (verified against a real SSE capture): during a run, the only live items are the user message, the goal (from wire `task`), proposal/approval cards, and the final boilerplate summary message. All assistant thinking (`llm.call` carries `output: clip(res.text,600)` at `orchestrator.ts:1122`), agent phases, route decisions, retries, errors hit `default: break` (`chat.ts:523`). The pane looks dead for minutes.

### B2 — Tool calls never reach the SSE stream — CRITICAL
`engine/src/tools.ts:1116,1174,1217,1238` emit `tool.call`/`tool.result` via `trace.emit` only. The orchestrator's `emit()` wrapper mirrors to the wire (`orchestrator.ts:104`), but tools.ts bypasses it, and **no trace→wire bridge exists anywhere** (grep `trace.subscribe` = 0 hits). Tool activity appears in the chat only after a page reload/reconnect triggers REST backfill. Live tool spinner rows can never appear.

### B3 — Chat history is lost on reload — CRITICAL
Backfill `GET /api/tasks/:id/events` (`engine/src/index.ts:468-485`) returns **trace events only**. User/assistant messages live only in `session.messages`; the web app never fetches them (grep `web/src` for session-message endpoints = 0). After F5 the entire conversation (prompts + answers) is gone from the chat pane; only trace-derived items return. The user's first message is additionally emitted by `POST /api/tasks` (`index.ts:290`) *before* the EventSource connects, so even a first load can miss it.

### B4 — Two colliding event-id spaces: scrambled order + duplicates + silent-drop landmine — CRITICAL
- Live SSE ids: `++sseEventSeq`, seeded `Date.now()` at boot (`engine/src/index.ts:1162,1170`) ≈ **1.79e12**.
- Backfill ids: trace ids `Date.now() − 1_700_000_000_000 + seq` (`engine/src/trace.ts:26-35`) ≈ **8.8e10**.
- Measured on the completed test task: backfill ids `87763317825..87763422462` vs live ids `1787763232032+`.
- `backfill()` merges then `.sort((a,b)=>a.id-b.id)` (`web/src/stores/chat.ts:83`) → all backfilled events sort **before** all live events regardless of real time. Dedupe is by exact id, so the same underlying event delivered live (SSE seq id, `type:"trace"` wrapper) and via backfill (trace id, `type:kind`) renders **twice**. `append()`'s monotonic guard (`chat.ts:95`) assumes a single id space — any future payload with larger ids silently drops live events.
- `?since=` sent by the client (`web/src/lib/api.ts:88`) is **ignored** server-side, so every heal re-fetches everything, amplifying the above.

### B5 — Per-hunk Accept/Reject in diff review is 100% broken (two independent bugs) — CRITICAL
1. Field mismatch: `web/src/lib/api.ts:81` sends `{ accept, reason }`; engine reads `const { accepted } = …` (`engine/src/index.ts:776`) → always `undefined` → every click lands in the reject branch.
2. The reject branch is a **no-op** (`index.ts:798-800`): returns `{ok:true}` without persisting anything or emitting an event. UI optimistically shows "rejected", reload reverts to pending, the pending-hunk badge never clears.
3. Response shape: success returns `{ok, result, proposal}`, not a `ProposalDto`, so `DiffReview.replaceProposal` (`web/src/components/diff/DiffReview.tsx:121-124`) matches nothing — the UI wouldn't update even if 1–2 were fixed.

### B6 — Multi-file proposals patch the WRONG file — CRITICAL
DTO ids are per-file `${p.id}_${fileIdx}` (`engine/src/index.ts:546`). PATCH `/api/proposals/:pid/hunks/:hid` strips the suffix (`index.ts:774`) then applies to the **first file containing that hunkIndex** (`index.ts:784-790`). Hunk indexes restart at 0 per file (`apply.ts:89`), so accepting file #2's hunk 0 silently applies file #1's hunk 0.

### B7 — Approval gates are disabled by default (HITL contract broken) — CRITICAL
`toolRequiresApproval` (`engine/src/tools.ts:1057-1066`): in mode `auto_safe` it **returns false unconditionally**, ignoring `requireApprovalFor: ["write_file","edit_file","run_command","git_commit","git_branch"]` (`engine/src/config.ts:61-68`). `auto_safe` is the default mode. Log proof from the reproduced run: `tool call: write_file {…, gated:false}` and `tool call: run_command {…, gated:false}` — the agent wrote files and executed shell commands with zero human approval while the UI advertises per-tool approval settings. The mode name implies "auto-approve only safe ops"; the implementation approves everything.

### B8 — Router watchdog is completely blind to the engine — CRITICAL
`router/src/watchdog/events.ts:280-323` parses opencode-style frames: types containing `tool`/`permission`/`idle`, `*.error`/`session.error`/`message.error`, `task.*` prefixes, `properties.sessionID`. The engine emits types `trace/route/task/message/session/status/proposal/approval` with `sessionId` (lowercase d) and tool data nested in `payload.event`. **No frame matches any branch** (even liveness: `task` ≠ `task.` prefix). Proof: after a full task execution, `GET /watchdog/status` → `"totals": {"signals": 0, "nudges": 0, "aborts": 0}`. Stuck detection, budget governor, deny-nudge and session attribution are all dead code against this engine.

---

## 3. HIGH-severity bugs

### Agent runtime (engine)

### B9 — Second prompt in a session re-executes the OLD plan with the OLD goal — HIGH
`engine/src/orchestrator.ts:144-151,170-176,302`. `runTask` creates a task only via `session.task ??= {...}` and plans only `if (!task.plan?.length)`. With an existing (finished) plan it falls through to `drive(ctx, 0)` whose loop has **no `step.status` check** — every already-`done` step is re-run against the old goal; the new prompt only leaks in via relevance picking. `task.stepCount` accumulates across prompts, so long-lived sessions eventually fail instantly with "step cap 40 reached". Budget/usage also persist across prompts (silent "budget cap exceeded" returns, `orchestrator.ts:156-157`).

### B10 — Step timeout leaks `runStep`: zombie steps keep calling LLMs, writing files, re-emitting the task — HIGH (prime suspect for "stuck running")
`engine/src/orchestrator.ts:322-361,513-515,836-847`. The 480 s per-step guard uses `Promise.race`; the losing `runStep` promise is never cancelled. It keeps spending tokens, executing tools (**real file writes land after the step was declared failed**), re-populates `runStates` after `finally` deleted it, and finally calls `saveSession` + `emitTask` — re-broadcasting a finalized task with a stale status minutes later. With gating enabled, a leaked `executeTool` would also apply an approval decided after the step died (30-min approval timeout > 8-min step timeout guarantees the race).

### B11 — Crash-resume is unreachable — HIGH
`engine/src/sessions.ts:57-67`, `orchestrator.ts:221-227`. Boot reconcile flips crashed `running` tasks to `stopped`, but the resume predicate accepts `waiting-approval | (planning/running/reviewing + runState) | (failed + bootInterrupted + diskRs)` — `stopped` is not resumable and **nothing ever writes `bootInterrupted`**. After any crash, `POST /api/tasks/:id/resume` silently no-ops; the whole persisted runState machinery is dead for its main use case. Related: resume loses step context (`persistRunState` keeps only the last 24 messages, so the system/step-instruction messages fall out; explore-phase state can resume as coder context — `orchestrator.ts:836-847,238,744`) and attempt/stepCount double-count on resume (`orchestrator.ts:413-415`).

### B12 — "Accept all" applies NOTHING to modified files — HIGH
`engine/src/apply.ts:133-138 vs 195`; callers `index.ts:757,816`. With no explicit selection, `allAccepted` is honored by the added/deleted branches but the **modified** branch checks only `wanted.has(h.hunkIndex)` → every hunk skipped, `appliedCount === 0`, proposal labeled `partially-applied` while nothing landed. File-type-dependent, easy to miss.

### B13 — TOOL_CALL protocol: quoted JSON in prose becomes an executable tool call — HIGH
`engine/src/actions.ts:430-446`, `orchestrator.ts:705-709,766`. Last-resort extraction treats *any* balanced JSON with a `name`/`tool`/`action` key anywhere in the reply as a tool call — explaining the format or echoing an example executes it. With the approval gate dead (B7), quoted JSON can drive `write_file`/`run_command` with no human in the loop. Mixed-format replies can also yield duplicate actions (no early return between salvage sections).

### B14 — Trivial-triage only matches questions → massive over-planning — HIGH
`engine/src/orchestrator.ts:1311-1317`. Reproduced: "Say hello and nothing else" → planner → 2-step plan → 7 LLM calls, ~13.9k tokens, ~2 min, created `scripts/hello.ts`. Imperative micro-asks never qualify (no `?`, not QUESTIONISH); conversely the over-broad `CODE_INTENT` word list denies the trivial path to genuine questions ("how do I add a header?").

### B15 — Token/cost accounting fiction → budget caps never trip — HIGH
`engine/src/providers.ts:397-405`, `orchestrator.ts:67-76,1132-1156`. Usage is read only from `json.usage`; free/proxied upstreams routinely omit it (measured `tokensIn:0 tokensOut:0` on successful calls) → `task.costUsd` stays $0 and `tokensUsed` stays 0 → neither cost nor token ceilings can fire. Race losers that complete 200-OK are dropped uncounted (`providers.ts:526`) so even real spend is under-counted. No fallback to the existing `estTokens` heuristic.

### B16 — Model racing burns ~3× tokens per call and poisons healthy models — HIGH
`engine/src/orchestrator.ts:1052,1075-1092,1116`, `providers.ts:483-541`, `router.ts:104-111`. Every LLM invocation races primary + 2 fallbacks (a 21-turn tool loop ≈ 63 upstream calls) — burning the shared free quota ~3× faster and accelerating the very 429s it dodges. Empty 200-OK completions throw `LlmError(status:undefined)` → `recordOutcome` files undefined status as **fail5xx += 0.8** and it is breaker-trippable; one empty reply demotes a healthy model for minutes. Observed live: `chat ok status:200 tokensIn:0` immediately followed by `health penalty fail5xx:0.8`. Also: 45 s per-slot cap kills slow-but-healthy models (`providers.ts:486`), last-resort sweep ignores operator `disabledModels` (`providers.ts:421-422`), and sweep success is double-recorded in health (`providers.ts:442` + `orchestrator.ts:905`).

### B17 — Unguarded execution endpoint: `/api/run` — HIGH (security)
`engine/src/index.ts:963-1029`. Caller-supplied `cmd` is split into argv and spawned directly — **any binary on PATH**, no approval gate (unlike the `run_command` tool), with `env: process.env` leaking the full environment (tools.ts uses a scrubbed whitelist). Unbounded stdout buffering. The engine has no auth or origin check on any route, so any local process (or malicious web page via localhost) can invoke it.

### Live-chat & frontend (web)

### B18 — Six frontend endpoints are 404 — HIGH
Verified against the live engine: `POST /api/bytheway`, `POST /api/tasks/:id/pause`, `GET /api/index/status`, `POST /api/index/rebuild`, `GET /api/websearch`, `GET /api/tasks/:id/snapshots`, `GET /api/snapshots/:id` — all 404. Dead features: `/bytheway` command (always ends `⚠ 404`), Pause button, index status/rebuild UI, web-search UI, dashboard snapshots. Meanwhile the engine already has the implementation sitting unwired: `runChat` + `BYTHEWAY_PROMPT` (`engine/src/chat.ts`, imported at `index.ts:23-24`, never routed).

### B19 — Task-identity confusion (sessionId vs task UUID) — HIGH
`engine/src/index.ts:304` returns `id: s.task?.id ?? s.id` — at creation the task doesn't exist yet, so `activeTaskId` = sessionId, while `GET /api/tasks` rows carry `id: task.id` (UUID). Consequences: TaskControls/BudgetMeter `tasks.find(t => t.id === activeTaskId)` → null → **no Pause/Stop/Resume buttons, "no task selected" meter** (`web/src/components/ChatPane.tsx:211`, `TopBar.tsx:26`); the task `<select>` shows nothing until re-picked; live `status` events call `patchTaskStatus(sessionId)` which matches `t.id` → **status chips never update live** (`web/src/stores/ui.ts:146-150`, `chat.ts:269-273`).

### B20 — SSE is an unfiltered global firehose — HIGH
`engine/src/index.ts:1164-1193` (`/api/events/:id` ignores `:id`), `web/src/hooks/useTaskStream.ts:44-54` (appends every frame to the active task's buffer without checking `ev.taskId`). With ≥2 concurrent sessions the chats contaminate each other.

### B21 — Router regressions vs the shipped bundle — HIGH
`router/src/proxy.ts:35,199-200`, `router/src/providers.ts:183-186`. (a) `UPSTREAM_TIMEOUT_MS` cut 120 s→45 s and applied to the whole request lifecycle including the response body — any generation/stream >45 s is killed by the router itself (engine waits up to 180 s). (b) Body `model` now forces exact-model routing (`forceModel = header ?? explicitModel`); unknown models like `model:"auto"` 503 — breaking 4 smoke tests + `test_proxy.ts` and any dynamically-discovered id. (c) Cooldown constants regressed (default 15 s→3 s, max 300 s→60 s, `MAX_CONSECUTIVE_429` 8→15) — Retry-After headers >60 s get truncated and a dead zone opens between "healthy" (15) and selectProvider's circuit (5).

### B22 — Watchdog never reconnects; status lies; attribution split-brain — HIGH
`router/src/watchdog/events.ts:210-239`, `watchdog/index.ts:206-217`, `router/src/index.ts:121,227`. `WatchdogClient.loop` runs exactly once — any engine restart or transient disconnect permanently silences the watchdog while `/watchdog/status` still reports `attached: true` (and the auto-attach interval was already cleared). Separately, boot auto-attach wires the watchdog to the `getAttribution()` singleton while the proxy reads a per-app `AttributionService` instance → headerless calls are never attributed and no task-ledger rows are created.

### B23 — Alias models can't self-heal; 429 exhaustion mislabeled — HIGH
`router/src/router.ts:182-191`, `policy/select.ts:52,80-85`, `proxy.ts:255-271,521-524`. Aliases (`engine/small|medium|large`) must pass `selectProvider`'s health filter; when the only keyed provider is in 429 cooldown or ≥5 consecutive 429s, aliases 503 with `attempts:[]` — while explicit model names bypass health entirely via the forced-model branch, so alias traffic can never produce the `markSuccess()` that would reset the counter. Chain exhaustion is reported as 503 `"no provider configured"` (text also used for genuine no-config), which defeats the engine's quota backoff (`isQuotaBackoff` requires status 429, `orchestrator.ts:869-871`) and makes the engine poison alias models with fail5xx penalties.

---

## 4. MEDIUM-severity bugs

| # | Area | Finding | Evidence |
|---|---|---|---|
| B24 | engine | `DEFAULT_MODELS` referenced but **never imported** in `index.ts` → latent `ReferenceError` on GET/PUT `/api/settings` whenever settings lack `models` | `engine/src/index.ts:100,140` vs import at :13 |
| B25 | engine/security | `GET /api/settings` returns **raw api_key** (masking inverted: raw returned when `api_key` set); no auth on any engine route; settings PUT can clobber keys to `"sk-engine-key"` when provider identity changes | `engine/src/index.ts:93-94,119-123`; `web/src/components/SettingsModal.tsx:158-165` |
| B26 | engine | 400→503 remapping at three call sites bypasses the breaker's "client errors never trip" protection; request-level 400s poison model 5xx health | `orchestrator.ts:1088-1089`, `chat.ts:136`, `providers.ts:452` |
| B27 | engine/security | Path containment is lexical-only — a symlink inside the project pointing outside escapes `read_file`/`write_file`/`edit_file` (no `realpath` re-check) | `tools.ts:202-219,447-457,737-748`; `apply.ts:39-42`; `fsops.ts:13-16` |
| B28 | engine | `responseFormat:"json"` accepted but never serialized into the request body → JSON mode dead; planner JSON failures more frequent than needed | `providers.ts:251,334-341`; callers `orchestrator.ts:903,948,1081` |
| B29 | engine | Compactor constructed **without a summarizer** → T2 degrades to T1.5; long sessions can escalate to T3 which rebuilds context with an empty task state ("Goal: (unknown goal)"), gutting the transcript. The other LLM-based `maybeCompact` in `context.ts:486-617` is imported but never called | `orchestrator.ts:424-425`; `compaction.ts:646-687,538-540` |
| B30 | engine | `run_command` timeout SIGKILLs only the direct shell child — grandchildren survive (no process group) | `tools.ts:332-375` |
| B31 | engine | Duplicate proposals observed for one change (two identical `applied` proposals for `scripts/hello.ts` from a single task) — proposal dedup (`gatedAppliedPaths`) doesn't cover the step-diff path | live evidence: `GET /api/tasks/:id/proposals` |
| B32 | web | Follow-up messages render twice: optimistic local bubble + server echo over SSE, no dedupe | `ChatPane.tsx:330-340`; `engine/src/index.ts:425`; `chat.ts:172-173` |
| B33 | web | Status vocabulary mismatch: UI uses `awaiting_approval`/`queued`/`paused`; engine uses `waiting-approval` and has no queued/paused → Pause/Stop disabled exactly while waiting for approval; TopBar chips always dim | `ChatPane.tsx:214`; `orchestrator.ts:799`; `TopBar.tsx:14-18` |
| B34 | web | Side effects during render: `deriveTimeline` (inside `useMemo`) calls `patchTaskStatus`, which always returns a new array even on no-match → extra re-renders + setState-while-rendering; `task.status` handler patches with a timeline-item id instead of `ev.taskId` | `chat.ts:234,271,481`; `ui.ts:147-149` |
| B35 | web | GOAL bubble lost after reload: backfilled `task.start` carries `input:{goal,…}` (object) and `asStr(p.input)` fails | `chat.ts:180-188` vs `engine/src/index.ts:473-479` |
| B36 | web | Terminal opens in the wrong directory: WS URL has no `?projectId=` → engine falls back to `"default"` → shell starts in engine `process.cwd()`; `resize()` is a no-op (never signals the PTY); terminal SSE subscribe→unsubscribe→resubscribe race drops chunks | `TerminalPanel.tsx:116-118`; `api.ts:75`; `engine/src/index.ts:1254-1261`; `terminal.ts:97-104`; `index.ts:1205-1211` |
| B37 | web | Editor save-conflict contract is imaginary: store relies on `expected_mtime`/409/`current_mtime`; engine ignores the field and never returns 409/mtime | `stores/editor.ts:48-83`; `engine/src/index.ts:925-935` |
| B38 | router | Chain order ignores the policy-selected provider (registry order instead of `selectProvider` ranking); cooldown last-resort skip is global not chain-scoped; no `notifyOutcome` on the no-decision 503 path (cascade can't escalate) | `router.ts:376`; `proxy.ts:337-352,255-271` |
| B39 | router | Health accounting gaps: 2xx-with-error-body rate limits never `markRateLimited`; no 5xx streak tracking at all (a provider returning repeated 500s is never cooled down) | `proxy.ts:471-491`; `providers.ts:178-233` |
| B40 | router | Task rows never leave `'active'` → 45 min after a session's first attributed call the BudgetGovernor wall-clock halt POSTs stop even for idle $0 sessions; `lastMode`/`windows`/`interventions` maps grow unbounded | `telemetry.ts:33-41,276-280`; `watchdog/budget.ts:87-144` |
| B41 | router | `/models` emits `id: undefined` (`ModelEntry` has `model_id_per_provider`) → engine discovery filters it all out → zero models discovered | `router/src/index.ts:151-159`; `engine/src/providers.ts:182-183` |
| B42 | router | `extractTool` treats any tool output as `errorOutput` (no success/failed check on the direct branch) → six identical *successful* outputs would fire a bogus error-spam intervention (masked today by B8) | `watchdog/events.ts:146-159` vs :160-177 |
| B43 | launch | `pnpm dev` aborts without TTY (E3) and dev.sh gives the router no `ENGINE_URL` (E5) — both documented in §1 | `scripts/dev.sh` |
| B44 | engine | Watchdog nudge never reaches a *running* task: `POST /api/tasks/:id/message` only appends to history; nothing injects it into the active tool loop (AGENTS.md nudge contract half-met) | `engine/src/index.ts:408-434` |

---

## 5. LOW-severity bugs (condensed)

**Engine** (`engine-findings.md` #22–#35): duplicate assistant message on disallowed-tool rejection (`orchestrator.ts:780,792-793`) · gated-tool deadline over-refund (`orchestrator.ts:813`) · `grep` tool has no ReDoS guard (`tools.ts:549-575`) · registry "dynamic discovery" dead — `refresh()` only re-seeds NATIVE_MODELS; `fetchProviderModels`/models.dev code never called (`providers.ts:230-234`) · unbounded `textHist`/`toolHist`/`lastErrors` maps never cleaned in `finalize` (`orchestrator.ts:55-59`) · T2 compaction appends summary after kept turns (chronology inverted) + toothless integrity probe (`compaction.ts:503-518`) · `parseUnifiedPatch` can pop a real trailing empty context line (`apply.ts:103`) · `run_command` preflight requires `command` key but handler also accepts `cmd` (`tools.ts:460`) · whitespace-trimmed `fuzzyLineEq` can mis-anchor hunks in indentation-sensitive code (`apply.ts:253-255`) · startup probe records status-less errors as 503 (`router.ts:814`) · budget-exceeded early return is silent (route still answers ok:true) (`orchestrator.ts:156-157`) · dead `chatStream` loses usage on `[DONE]` (`providers.ts:624`).

**Web** (`web-findings.md` #18–#26): RoutingBadge dead (engine emits `route` w/ `decision`, UI waits for `routing.selected`) · no markdown rendering in chat bubbles (raw `**Task done**` asterisks) · `useProposals` refetch only when the *last* event is a proposal · TerminalPanel Agent tab is backfill-only (filters `tool==="bash"` rows that never arrive live) · `EditorTabs` keydown effect has no deps array; hardcoded `http://127.0.0.1:4100` preview URL; `ProjectPickerModal` hardcodes dev quick-jump paths; module-level `resolvedProposals` map never clears across tasks; `Number(ev.id) || Date.now()` fallback can break monotonicity; composer "engine" chip is cosmetic (backend ignores it).

**Router** (`router-findings.md` #16–#21): streaming `x-engine-route` header omits its own attempt; client aborts recorded as provider errors; no downstream→upstream abort propagation (abandoned race-loser requests still billed) · attribution has no staleness window (headerless calls days later attributed to dead sessions) · auto-attach can clobber a concurrent manual attach · `ensureColumns` DROPs the `calls` table on migration failure · AGENTS.md port drift (4090 vs 4098) · engine never sends `x-agent-role`, so router role-based tier gating is dead code.

**Misc**: SSE DTO `...e` spread after computed fields could overwrite `id/type` if wire shapes grow (`engine/src/index.ts:1169-1176`) · concurrent fire-and-forget `stream.write` in the SSE handler can interleave under backpressure (`index.ts:1177`) · `test_e2e.ts:33` passes `PORT` but engine reads `ENGINE_PORT` · trace/approval files written under `projects/<sessionId>/` pollute the project-id namespace (`trace.ts:76-78`, `approvals.ts:48-50`).

---

## 6. What actually works (verified, so fixes don't regress it)

- SSE transport: EventSource via Vite proxy, reconnect with capped backoff, `heal()` on reconnect, 15 s ping keepalives.
- `message`/`proposal`/`approval` rendering, goal bubble on live `task` events, ApprovalsPanel approve/deny (`PATCH /api/approvals/:id` contract matches), HitlCard accept-all/reject-all (`resolve_all` contract matches).
- Terminal WS protocol (`{input}`/`{resize}` vs `{type:"replay"|"output"}`) matches; replay-on-connect works; Vite `ws:true` proxies the upgrade.
- Engine: `../`+absolute traversal blocked (sibling-safe `inRoot`); concurrent double-run per session prevented; approval decide/wait machinery race-safe and persisted across restarts; budget guards checked at task start/step/mid-call; all-failed plans finalize `failed` (no infinite loops); caller abort propagates cleanly (race-loser aborts correctly NOT penalized); `edit_file` ambiguity guard; breaker core sound (400/401/403 never trip); trace ids unique across restarts; deleted-session tombstones; `buildFileDiff`/apply hardening (idempotent re-apply, drift correction); planner JSON salvage; quota backoff deadline-aware; run_command env scrub + catastrophic-command blocklist.
- Router: fs jail (lexical+physical, symlink-safe), SSE byte passthrough + trailing route comment, 429 fallback chain + trace-tree nesting, policy primitives (classify/cascade/budget/select) match their tests, key masking, origin allowlist, stuck-monitor & budget-governor semantics vs their own contract, auto-attach retry mechanics.

---

## 7. Evidence appendix

- Reproduced task: session `09a81a9b-cb49-4575-a1ba-cf1a3fcf3e31`, prompt "Say hello and nothing else" → 2-step plan, 7 LLM calls, 13 871 tokens, ~2 min, wrote `scripts/hello.ts`, produced 2 duplicate proposals.
- SSE capture: live ids `1787763232032+` vs backfill ids `87763317825..87763422462` (two id spaces, §B4).
- Router DB (`router/data/router.db`): NO-ROUTE traces `no eligible provider for tier(s) S/M` with `force_tier: S`; call rows `error http=200` (2xx-with-error bodies); 954 calls / 1847 traces.
- Watchdog: `GET /watchdog/status` → `attached:true, totals:{signals:0,nudges:0,aborts:0}` after a full task run (§B8).
- Endpoint probes: six 404s (§B18), engine http log confirms.
- Gating: `tool call: write_file {gated:false}`, `tool call: run_command {gated:false}` in engine log (§B7).
