# Agent IDE — Fix Status Tracker

Companion to BUG-REPORT.md / FIX-PLAN.md. Updated as waves land.

## Wave 0 (me) — Phase 0 launch fixes — ✅ DONE
- E1 start.sh: removed bogus `agent_ide/` path segment → execs scripts/dev.sh
- E2 dev.sh: bun resolved via `command -v bun` → `~/.bun/bin/bun` fallback, fail-fast message
- E3 dev.sh: `export CI=true` (pnpm non-TTY purge confirmation)
- E5 dev.sh: engine starts FIRST, health-wait loop (≤15s), router gets `ENGINE_URL=http://127.0.0.1:4100`
- E4 AGENTS.md: 4090→4098 (2 places); test_e2e.ts: PORT→ENGINE_PORT
- Verified: bash -n clean; router reads ENGINE_URL (router/src/index.ts:219); engine has /api/health (index.ts:84)
- Remaining E4 item: router/src/index.ts header comment 4090→4098 → delegated to router agent

## Wave 1 (parallel subagents) — IN PROGRESS
- Router agent (f7aa6de6): ⚠️ ran out of context PARTIAL — did B41 (/models ids) + B39 (2xx rate-limit detect). B21–B42/E4 finished by me below.
- Web agent (c106f0c3): ✅ DONE (ran out of context after finishing; verified by me)
  - `pnpm build` green (tsc --noEmit + vite build)
  - Verified landed: B1 deriveTimeline rewrite (llm.call/tool.call/tool.result/agent.*/task.start/end/route), B3/B4 backfill+since+single-id dedupe (api.ts:115, chat.ts:93), B19 dual-match lookups (ui.ts/ChatPane/TopBar), B20 frame filter (useTaskStream:53-54), B32 optimistic-text dedupe, B33 engine status vocab (TopBar:17, ChatPane:220), B34 patchTaskStatus moved to SSE handler (useTaskStream:62-65), B35 goal from input.goal object (chat.ts:262-271), B36 termWsUrl?projectId + resize, B37 expected_mtime/409/current_mtime (editor.ts:61-66, api.ts:87), markdown renderer (lib/markdown.tsx), RoutingBadge via route events (chat.ts:101,114,252), approvals mode radio in SettingsModal (:31,73,328-334), Pause button + snapshot fetch UI removed (SpanDetail:257), bytheway/indexStatus/websearch wired (api.ts:44,55,95), resolvedProposals cleared on task switch (ChatPane:112,262), useProposals incremental tail-scan refetch, hardcoded :4100 URLs gone, EditorTabs keydown listener paired
- Engine-runtime agent (d89a620c): ✅ DONE — all 17 items, tsc 0 errors, bun test 69/0. See report: B7 approval gates, B9 re-run archives terminal task, B10 per-step AbortController, B11 crash-resume, B12 accept-all root cause, B13 TOOL_CALL salvage, B14 trivial triage, B15 token/cost estimate, B16 single-chat racing, B27 symlink escape, B29 compactor summarizer, B31 dup proposals, B44 enqueueNudge + low items + atomic saveSession. B26 chat.ts already fixed (verified).

## Wave 1b (me) — Router Phase 4 — ✅ DONE (116/116 bun test)
- B21a proxy UPSTREAM_TIMEOUT_MS 120s · B21b known-model gate (body model only forces route when it is a real catalog id) · B21c rate-limit cooldown constants reconciled w/ OPEN_CIRCUIT_429
- B22 watchdog SSE reconnect (capped exp backoff) + honest `live` status + auto-attach shares the app's AttributionService instance (no split-brain); RouterApp.attribution typed
- B23 alias least-bad last resort (self-heals 429) + chain-exhausted-on-429 → honest 429 "all providers rate-limited" w/ max Retry-After (updated 2 smoke tests to new contract)
- B38 attempt chain starts w/ policy-selected provider; cooldown last-resort scoped to chain; notifyOutcome(failure) on no-decision 503
- B40 idle task finalization (lastCallTs/setTaskState + governor finalizes >10min-idle rows as 'idle', no wall-clock halt on $0 idle sessions) + capped lastMode/windows/interventions/lastSeen maps (pruneStale)
- B42 extractTool sets errorOutput only on genuine failure (status/error/dotted-type) — regression test added
- B8 native-envelope parser (dispatchNative; type∈trace|message|token|task|status|proposal|approval|route; spanId-correlated tool.call→tool.result observed once; attribution by sessionId, interventions by taskId) + test/watchdog-engine-contract.test.ts (9 tests); legacy dialect kept intact
- E4 router/src/index.ts header comments 4090→4098 · /models + /v1/models emit real ids (model_id_per_provider, was undefined m.id)
- Router §5 lows DONE: 17a streaming attempt included in x-engine-route header · 17b client disconnect → status "aborted" (not "error") · 17c client-abort propagated to upstream fetch (AbortSignal.any) + chain stops · 18 attribution staleness window (ATTRIBUTION_STALE_MS, opt-in per instance) · 19 auto-attach re-checks getWatchdog() after reachability probe · 20 ensureColumns fails loud instead of DROP TABLE calls
- ROUTER COMPLETE: 116/116 bun test

## Wave 2a (parallel hardening agent ec77af97) — ✅ DONE (verified via WAVE2A-NOTES.md + grep audit)
- B24 DEFAULT_MODELS imported (config.ts:24 export) · B25 keys always masked + keep-existing on PUT
- B18 wired: POST /api/bytheway→runChat, GET /api/index/status, POST /api/index/rebuild (buildIndex), GET /api/websearch (DDG mirror, returns array)
- B26 chat.ts site fixed (real status) · B36 term projectId query/body + real stty resize + single-subscribe SSE · B37 expected_mtime→409+current_mtime
- B17: raw cmd DROPPED (FIX-PLAN's sanctioned ponytail option), scrubbed env, 1MB buffer caps
- Phase 6: origin guard + ENGINE_API_TOKEN bearer middleware (off by default), fs/list defaults to project root, no home field
- SSE DTO explicit {id,taskId,sessionId,ts,type,payload}, no ...e spread, per-connection serialized writes
- tsc: 0 errors in its files at completion; bun build OK

## Wave 2b (engine-contract agent dd84e97b) — RUNNING
- Single id space (events.ts + replace sseEventSeq), events endpoint merge+synthetic messages+since (B3/B4), trace→wire bridge + remove manual mirrors (B1/B2), B19 ensureTask (sync TaskRecord), B5/B6 hunk review contract, B44 enqueueNudge HTTP wiring, task.start/end payload enrichment, /models discovery wiring. Prompt: WAVE2-PROMPT.md; depends on WAVE1-NOTES.md (created) + WAVE2A-NOTES.md.

## Wave 3 — integration verification (me) — PENDING wave 2b
- scripts/verify.sh ready (fixed /models OpenAI-style parse). Boots 3 services, checks health, B18 endpoints, B25 masking, task lifecycle + event contract (single id space, since), watchdog signals>0 (B8), /models ids (B41).

## Wave 4 — Phase 8 regression net + final checkoff
- Phase 8 item 2 (engine unit tests): DONE (wave-1 added triage/actions/apply/sessions/approvals/fsops/nudge; wave-2b adds events/hunk/ensureTask).
- Phase 8 item 3 (router tests): DONE (116 tests incl. watchdog-engine-contract.test.ts).
- Phase 8 item 4 (E2E): DONE — test_e2e.ts extended (B19 identity, B3/B4 event shape + since, tolerant completion report); bun build clean.
- Phase 8 item 5 (build.sh typecheck+tests all workspaces): DONE.
- Phase 8 item 1 (web deriveTimeline golden test): SKIPPED deliberately — web has no test framework; adding bun:test to web/src would break the tsc build gate (no @types/bun). deriveTimeline is pure + defensive, covered by web tsc + verify.sh event-contract integration.

## Finding coverage (all 44 B + 5 E assigned)
- Web (c106f0c3 ✅): B1,B3,B4,B19w,B20w,B32,B33,B34,B35,B36w,B37w
- Hardening 2a (ec77af97 ✅): B17,B18,B24,B25,B26-chat,B36e,B37e,Phase6
- Engine wave-1 (d89a620c ✅): B7,B9,B10,B11,B12,B13,B14,B15,B16,B26v,B27,B28,B29,B30,B31,B44-hook,+lows
- Router wave-1b (me ✅): B8,B21,B22,B23,B38,B39,B40,B41,B42,E4,§5-lows (116/116)
- Engine wave-2b (dd84e97b ⏳): B1,B2,B3,B4,B5,B6,B19e,B20e,B44-wire
- Wave-0 (me ✅): E1,E2,E3,E4,E5 (=B43)

## New-issue audit (wave-2b wait) — see NEW-ISSUES.md
- Semantic code-retrieval pipeline CONFIRMED implemented (per-project isolated, symbol-graph+PageRank, bounded previews — not naive vector embeddings).
- R1 FIXED: per-query full-repo PageRank re-scan → cached symbol graph (repomap.ts), 7 new tests green.
- R2/R3/R4 OPEN (low): unbounded index cache; currentProjectRoot fallback isolation; fresh-open empty-retrieval race.

## Wave 2b — engine contract layer — ✅ DONE (verified)
- bunx tsc --noEmit → 0 errors; bun test → 95 pass / 0 fail (11 files, +22 wave-2b tests); bun build clean.
- Boot smoke on :4101 (isolated ENGINE_DATA): REAL LLM task ran to done; rebooted on same data dir → journal backfill re-verified (74 frames ascending, new ids above restored watermark). This satisfies the "live e2e with a real task" gate.
- B4 single id space (events.ts, journal+ring), B3 events endpoint (+synthetic message/trace frames, since=), B1/B2 trace→wire bridge (manual mirrors removed), B19 ensureTask sync UUID, B5/B6 hunk persist + file-scoped hid, B44 nudge loop/history, B20 verified, /models discovery wired, B26 chat parity. See WAVE2B-NOTES.md.

## New-issue retrieval fixes (this session) — see NEW-ISSUES.md
- R1 FIXED per-query full-repo PageRank re-scan → cached symbol graph (repomap.ts).
- R2 FIXED unbounded index cache → LRU cap 8 + disk rehydration (retrieval.ts).
- R4 FIXED fresh-open empty-retrieval race → retrieve awaits in-flight build (retrieval.ts).
- R3 RECLASSIFIED not-a-bug: currentProjectRoot fallback is load-bearing for web's single-active-project model (web sends no projectId on most calls); per-project isolation already enforced via projectId-keyed storage. No change.
- engine/test/retrieval.test.ts: 9 tests green; engine suite 95/0 with these included.

## Wave 3 — live integration (in progress)
- DISCOVERY: stock services on 4098/4100/4444 are STALE (live engine bytheway returns "question required" — a string NOT in current code) and run in an unkillable PID namespace (no lsof/fuser; /proc shows listener inodes but no visible PIDs). scripts/port-kill.py depends on lsof (absent here) → cannot clear them in THIS env.
- Therefore wave 3 boots CURRENT code fresh on alternate ports (router :4099 / engine :4102, isolated data) via /tmp/wave3-integration.sh and verifies B8 watchdog, B19 identity, B3/B4 event contract + since, B41 /models, B18 endpoints, B25 masking (no LLM key needed for these; LLM-to-done already proven by wave 2b).
- WAVE 3 RESULT: 12/12 GREEN (/tmp/wave3-integration.sh, fresh boot router :4099 / engine :4102, isolated data):
  engine+router healthy · B19 real task UUID ≠ sessionId · B8 watchdog attached+live and parsed live engine frames (lastActiveSession == task sessionId; totals.signals counts stuck-detection only, so 0 on a healthy pre-LLM task is correct) · B3/B4 pinned envelope + ascending ids + trace kinds + ?since= honored · B41 /models 14 real ids · B18 bytheway/index-status/websearch present · B25 no raw key leak.
  Also corrected verify.sh §6 B8 assertion (lastActiveSession OR signals>0), since signals>0 alone is not reliably produced by a healthy task.

## Fresh-eyes new-issue audits (parallel subagents) — DONE
### Web audit (3ff005e6) — 4 FIXED, 2 reported-only; tsc 0 + pnpm build + dashboard harness green
- FIXED markdown.tsx:16 infinite-loop module-level g-flag regex in renderInline (bold/italic hung pane).
- FIXED DashboardView.tsx:39 effect-dep (spans.length) clobbered live span selection each poll.
- FIXED TopBar.tsx:60 BudgetMeter read task.budget?.max_cost_usd but wire carries flat budgetUsdCap.
- FIXED EditorTabs.tsx:52,120 pin-decoration async-mount race (decorations never rendered on first open/tab switch).
- REPORTED-ONLY: ApprovalsPanel.tsx hardcoded /api/approvals/pending (ignores VITE_API_BASE) + silent-fail decide(); useTaskStream.ts:120 fallback-id collision edge under pinned contract.
### Router audit (4b630b84) — 3 FIXED, 7 reported-only; bun test 116/0
- FIXED proxy.ts:404 AbortSignal.timeout stayed armed for whole fetch → truncated every SSE stream >120s. Now manual AbortController cleared at headers (connect+headers only); clientSignal abort still propagates (coexists with §5-17c).
- FIXED proxy.ts:240 cascade/budget feedback used raw task header but notifyOutcome used effective taskId → attributed (headerless) traffic never escalated/demoted. Now passes taskId.
- FIXED watchdog/events.ts:265 reconnect pinned to fallback URL forever; now resets useFallback after backoff so primary is retried.
- REPORTED-ONLY (7): no stream_options include_usage for streaming; per-chunk \r\n SSE normalization (TCP-split risk); cascade multi-role escalation collapse; RouteService.tasks unbounded map; non-429/5xx no notifyOutcome/larger-tier; budget halt with empty sessions; respondStreaming unbounded collected buffer.

## FINAL GATE — scripts/build.sh exit 0 (all workspaces)
[1/5] web tsc --noEmit ✓ · [2/5] engine tsc --noEmit ✓ · [3/5] router bun test 116/0 ✓ · [4/5] engine bun test 95/0 ✓ · [5/5] bundles ✓ (web vite 83 modules, router 150.87KB, engine 0.45MB). "Build Complete: typechecks + tests green."

## VERDICT — ALL 44 FINDINGS (B1–B44) + E1–E5 FIXED & VERIFIED
- Builds: build.sh green across web/engine/router.
- Tests: router 116/0, engine 95/0, web tsc+build green.
- Live e2e: wave-2b real-LLM task to done + reboot backfill; wave-3 fresh-boot integration 12/12 (B8/B19/B3/B4/B41/B18/B25).
- Bonus new-issue audits: retrieval R1/R2/R4 fixed (R3 reclassified not-a-bug); web 4 fixed; router 3 fixed; 9 more documented reported-only in NEW-ISSUES.md + this file.

## Dynamic ports (user request: "make 4098/4100/4444 dynamic in case busy")
Root cause: stale/orphaned services hold 4098/4100/4444 in an unkillable PID namespace
(no lsof/fuser; port-kill.py can't clear them). Launch tooling now falls back to free ports.
- NEW scripts/free-port.py: connect-based free-port finder (keeps preferred port if free, else OS-assigned).
- scripts/dev.sh: picks ENGINE/ROUTER/WEB ports dynamically, writes /tmp/agent-ide-ports.json,
  wires router->engine (ENGINE_URL) + engine->router (ENGINE_ROUTER_BASE), and kill_tree() cleanup
  kills the whole process tree (pnpm->vite grandchildren no longer leak).
- scripts/verify.sh: discovers chosen ports from the ports file; all checks use them. 14/14 green on dynamic ports (task reached done).
- web/vite.config.ts: server.port + /api proxy target read WEB_PORT/ENGINE_PORT env (defaults 4444/4100).
- engine/src/index.ts: browserOriginAllowed trusts the dynamic WEB_PORT (else web UI mutating requests 403). Verified: dynamic origin accepted, evil origin still 403.
- test_e2e.ts: freePort() helper; router+engine on dynamic ports. Passes (task done).
- Verified live: free-port detects busy 4098/4100/4444 -> falls back; dev.sh boots all 3 healthy + proxy wired; clean shutdown leaves no orphans.

## Flappy-bird triage bug (user: "make a 3d flappy bird game" created no files)
ROOT CAUSE: isTrivial() misclassified the ask as trivial → answerLite() which only has
READ-ONLY tools (read_file/list_dir/grep…) → the model could never write files; it flailed
("listdir" malformed tool calls) and bailed "answered directly (trivial ask)".
"make" was absent from CODE_INTENT, and Branch-2 (≤12 words, no code-intent verb) fired.
FIXES:
- engine/src/orchestrator.ts: CODE_INTENT += make|generate|develop|scaffold; new POLITE_LEADIN
  branch so "can/could/would/please + code-verb" is a TASK not a question (Branch 0 in isTrivial).
- engine/src/router.ts: HIGH_VERBS += make|create|generate|develop|scaffold (complexity 0.30→0.48
  for creation asks, lifts coder tier). Planner still wants tier-3 but registry has no
  reasoning/longctx-tagged model → model-availability limitation, not a code bug.
- router/src/policy/classify.ts: creation verb+artifact signal (+2 → M) for external requests.
TESTS: engine/test/triage.test.ts +9 cases; router/test/policy.test.ts +5 cases.
VERIFIED: engine 104/0, router 121/0, tsc clean. Live task now routes to planner→coder→HITL
approval gate (previously finalized instantly as "answered directly"). Files are written once the
user approves gated write_file/run_command actions in the UI.

## Planner JSON fragility (user retry: "planner JSON unparseable — repairing")
After the triage fix, the task reached the planner but free models emit near-miss JSON:
 (a) false-start prefixes  '{"{"steps":[…]} ' / stray brace '{"}steps":[…]}'
 (b) plain-prose "thinking" that ECHOES the schema example '{"steps":[{"title":"…"}]}'
     which parsed as valid JSON with a garbage key, so the planner "succeeded" with an
     empty template plan and never ran its repair attempt.
FIXES (engine/src/orchestrator.ts + engine/src/router.ts):
- parseJsonLoose: rewritten — stray-brace repair BEFORE parsing ('{"}steps"' is valid JSON
  with key "}steps"), then scans EVERY balanced '{…}' span and returns the LARGEST that
  parses (skips false-start prefixes; a nested fragment never shadows the plan). Exported.
- matchJsonObjectEnd: new helper (balanced-brace scan respecting strings/escapes). Exported.
- sanitizePlan: rejects placeholder steps ("...", <…>, […], empty) so an echoed schema
  template is treated as invalid and the repair attempt actually runs. Exported.
- planTask: planner maxTokens 1200→2000; repair prompt strengthened ("no thinking, no
  schema placeholders").
- capabilityFit + speed-prior (router.ts): made the fast-model bonus/prior ROLE-AWARE.
  Previously a tiny "fast" model out-scored reasoning models for the planner (fast bonus
  +0.22 and 0.85 speed-prior outweighed the tier penalty), so the planner narrated prose.
  Now only explorer/summarizer/router get the big fast bonus/prior; planner/coder/reviewer
  prefer reasoning/balanced models.
- PlanShape exported for tests.
TESTS: engine/test/parse-json.test.ts (new, 16 cases: both real corruptions, fences, prose,
  false-starts, nested-shadowing, placeholder rejection). Engine 120/0, tsc clean.
VERIFIED LIVE: planner now routes to reasoning models (engine/medium, nemotron-3-ultra),
  produces a real 6-step plan, coder executes step 1 and writes files (game/__init__.py
  created on disk after write_file approval). Remaining quality limit: free coder models are
  quota-limited and may pick a suboptimal stack — model-availability, not a code bug.

## "Still can't see the file" — malformed tool calls silently dropped
User retry showed the coder emitting 'TOOLCALL: {"name":"writefile",...}' (no underscores)
and the step reporting "✔ done" with NO file written. Three stacked defects:
 (a) extractToolCalls/extractAllActions marker required an exact "TOOL_CALL:" — "TOOLCALL:"
     (and mixed case) never matched, so the call was never extracted.
 (b) normalizeTool had no alias for separator-less names (writefile/listdir/runcommand),
     so even if extracted it resolved to "unknown tool".
 (c) When extraction returned 0 calls the loop nudged ONCE then accepted the blob as FINAL,
     so the step marked done without ever running the tool.
FIXES:
- orchestrator.ts extractToolCalls + actions.ts extractAllActions: marker now
  /TOOL[_ ]?CALL:/i (tolerates missing underscore + case).
- tools.ts normalizeTool: exported; added separator-stripped fallback matching against
  TOOL_SPECS (writefile->write_file, listdir->list_dir, runcommand->run_command, ...).
- orchestrator.ts toolLoop: canonicalize each call via normalizeTool BEFORE the
  mutation/approval gates (so an aliased write is still gated+snapshotted); nudge up to 3x
  when the reply is clearly a tool-call attempt instead of accepting it as FINAL.
TESTS: engine/test/tool-normalize.test.ts (new, 12 cases). Engine 132/0, tsc clean.
VERIFIED LIVE: "make a 3d flappy bird game" now plans (6 steps) and WRITES FILES — built a
  Vite+Three.js project in /workspace/agent/tasty (index.html, package.json, src/{main,scene,
  bird,pipes,game}.js, 383 lines) before the user stopped the run. write_file executes and is
  approval-gated correctly.

## Wave 5 — Port from reference agent_ide (user: "take inspiration from agent_ide, test until perfect, 3-4 subagents, 6hr self-improving loop")
Reference = /workspace/agent/agent_ide (another LLM's fork; user says it works better).
Recon findings:
- Prior waves claimed ALL 44 findings + E1-E5 + retrieval R1-R4 fixed, BUT live use still
  exposed the file-write/tool-call bugs (fixed Wave 4) => prior fixes diverged from ref & were partly inferior.
- Reference IMPLEMENTED the canonical event store (engine/src/events.ts: per-session monotonic
  cursor, eventStore.append, SSE id:cursor) — the fix for "chat not live / final msg vanishes / dupes".
  MY events.ts (298L) diverges (uses .all().filter(), no clean cursor store). THIS is the biggest gap.
- MY launch scripts (dev.sh dynamic ports, bun resolve, engine-first, kill_tree) are AHEAD of ref. No port needed.
- Ref docs: fix/BUG-REPORT.md (44 findings), fix/FIX-PLAN.md (8 phases), fix.md + newFix.md (event-pipeline spec).
Wave-5 agents dispatched (parallel, disjoint file ownership):
- 8cf20776 engine event pipeline (events.ts, bus.ts, trace.ts, index.ts SSE/events) -> port ref cursor store.
- c70841b4 router/src (watchdog parse/reconnect B8/B22, B21 timeouts, B23 alias heal, B39/40/41/42).
- 156980b3 web/src (deriveTimeline real vocab B1, cursor-safe Map B4, tool merge by spanId, clientMessageId B32, status B33, task identity B19).
NEXT (after they settle): integrate -> scripts/build.sh -> scripts/verify.sh live e2e -> dispatch wave 6 on remaining gaps.
Ground truth = live tests, not blind copy. Engine-runtime port (orchestrator/tools/providers) held to avoid same-service edit race.
- +cebc9778 engine runtime Phase 2/3 (orchestrator/tools/actions/providers/apply/sessions): diff-and-port
  B7,B10,B11,B12,B13,B16,B26,B28,B30,B31 vs ref, preserving Wave-4 fixes, avoiding events-agent's 4 files.
- eval/ is byte-identical to ref -> nothing to port there.
- 4 agents now parallel. Integration (build.sh + verify.sh) runs AFTER they settle.

## Round 2 — baseline + wave-6 pre-analysis
- Pre-wave baseline GREEN: engine tsc clean + 132/0, router 121/0. (Compare after agents land.)
- Phase5/6 gap check: MINE LEADS ref on index/status, index/rebuild, websearch, ENGINE_API_TOKEN auth,
  expected_mtime editor-conflict. Only /pause missing (low priority; FIX-PLAN suggested removing pause anyway).
  => Confirms selective porting: ref's real edge = event pipeline (agent A) + some runtime semantics (agent 4).
- 4 agents still running (analyze phase). Wave 6 will target integration fallout + any remaining runtime gaps.

## Round 3 — web agent ran out of room; replaced
- 156980b3 (web) died mid-port (only edited web/src/lib/types.ts, which is GOOD: full canonical EventDto
  {id/cursor/eventId/sessionId/createdAt} + approvals {mode:"gate"|"auto"} — better than ref's minimal DTO).
  web tsc still CLEAN (nothing broken).
- Dispatched 48bfc203 to FINISH web: chat.ts (deriveTimeline real vocab + cursor-safe Map + tool merge by
  spanId) + useTaskStream.ts (Last-Event-ID, no parallel heal), using INCREMENTAL edits (prior died doing one
  giant write of the 480-line chat.ts).
- Running now: 8cf20776(engine events) c70841b4(router) cebc9778(engine runtime) 48bfc203(web chat.ts).

## Round 8 — ENGINE COMPLETE (both engine agents settled)
- 8cf20776 (engine events) DONE: canonical cursor event store ported (events.ts rewrite: append-only per-session
  log, monotonic cursor, JSONL journal, trace->store + wire->store bridges, toEventDto/legacyEvents); bus.ts ported;
  index.ts GET /events (store-only, ?after/?since) + SSE (subscribe->replay->drain->live, id:<cursor>, Last-Event-ID,
  serialized writes, close-on-fail). Kept payload.event compat so current web still renders. Fixed ref bug: after>beyond
  high-water returns [] not resynthesized legacy. 136/0 + e2e smoke (replay/Last-Event-ID/byte-equal REST<->SSE/gap-free).
- cebc9778 (engine runtime) DONE: ALL 10 Phase2/3 candidates (B7,B10,B11,B12,B13,B16,B26,B28,B30,B31) ALREADY PRESENT;
  B7/B11/B13 STRICTLY BETTER than ref (porting would regress). Added 6 provider regression tests only. No src changed.
- ENGINE independently verified: tsc clean, 142/0 (132 base +4 events +6 providers).
- WEB: both chat.ts agents ran out of room (context-heavy file). But agent A kept payload.event compat + chat.ts
  already has cases for all trace kinds => web likely renders live already. PLAN: verify live after router settles;
  minimal surgical fix only if broken (e.g. tool-row spanId merge). Do NOT full-rewrite chat.ts.
- Router agent c70841b4 still running (index.ts). NEXT: router settles -> build.sh -> restart stack -> verify.sh -> live web test.

## MILESTONE — full pipeline verified end-to-end (Round 8)
- build.sh EXIT 0: web tsc+vite build (83 modules), engine tsc+142/0, router 123/0, all bundles.
- verify.sh 14/0: health, B18 endpoints, B25 masking, task->done, event contract (single cursor id space,
  messages+traces replayed, ?since honored), B8 watchdog sees engine frames, B41 /models 14 ids.
- LIVE file-writing e2e: "single-file HTML snake game" -> 2-step plan -> wrote test5/snake.html (3.4KB, REAL game:
  canvas/keydown/score/rAF) -> done. 67 events, ids ascending+numeric, 8 types, 13 trace kinds incl 6 tool.call/result.
- WEB compatible with new pipeline: chat.ts reads rec(p.event ?? p) [agent A kept payload.event], handles all trace
  kinds, MERGES tool.call+tool.result by spanId (openTools map) -> no duplicate rows. No web change needed.
- VERDICT: Agent IDE now reliably plans+writes complete working projects e2e; matches/exceeds reference
  (engine runtime B7/B11/B13 > ref; router > ref; event pipeline now == ref).

## Wave 6 — hardening (keep loop going per user: 6hr self-improve)
Plan: fresh-eyes edge-case audits on the NEW event pipeline + router (disjoint, conservative), + more live e2e
task types (edit-file, multi-file). Only high-confidence fixes + regression tests; no refactoring working code.

## Wave 6 results (so far)
- 0013b0ed (router hardening) DONE: 4 REAL bugs fixed — (1) markRateLimited resets consecutive_5xx (stale streak
  premature cooldown); (2) markServerError honors Retry-After + re-arm takes max() never shortens; (3) error:null 200-body
  restored to success path + string rate-limit bodies detected; (4) clampCooldown(NaN) guard (NaN deadline silently
  disabled cooldown). 3 already-correct (breaker recovery, /models+/routes defaults, SSE parse). +12 tests.
  ROUTER 135/0 (was 123), tsc clean. Independently verified.
- 28651c5e (web SSE) DONE: useTaskStream ALREADY CORRECT — reconnect heal(?since=lastId), idempotent dedupe by id
  (append drops id<=last.id), taskId filter, no heal/SSE double-merge. No changes. tsc 0.
- LIVE EDIT e2e: "add pause/spacebar+PAUSED overlay to snake.html" -> 5-step plan, 4 code steps done, file correctly
  modified (3463->3963B, pause logic present). Task then "stopped by user" (clean stop, Steps 4/5, cost/tokens reported)
  => user is watching live UI; STOP functionality works. create/edit/stop all verified live.
- dad7a892 (engine event-pipeline hardening) STILL RUNNING. NEXT: it settles -> build.sh -> verify.sh -> wave 7.

## FINAL GREEN STATE (Round 8, post wave-6)
- build.sh EXIT 0: engine 142/0, router 135/0 (hardened +4 real bugs), web tsc+vite clean, all bundles.
- verify.sh 14/0 on hardened code (fresh stack): health, B18, B25, task->done, event contract (single cursor space,
  messages+traces, ?since), B8 watchdog frames, B41 /models.
- LIVE e2e matrix ALL PASS: create (snake.html real game), edit (pause feature added to snake.html), multi-file
  (test6 todo app: index.html+styles.css+app.js, reviewer verified, 193 events ascending), stop (clean user stop 4/5).
- Event pipeline verified: single ascending numeric cursor id space across every task; replay + ?since + Last-Event-ID.
- Web verified correct: chat.ts reads rec(p.event ?? p), handles all trace kinds, merges tool rows by spanId;
  useTaskStream reconnect heal(?since=lastId) + idempotent dedupe + taskId filter + no heal/SSE race.
- dad7a892 (event-pipeline edge-case hardening) ran out of room during analysis, edited NOTHING (engine unchanged 142/0).
- OBJECTIVE MET: Agent IDE reliably plans+writes complete working projects e2e; matches/exceeds reference.
- REMAINING (optional hardening): event-pipeline edge cases (reconnect gap, cursor-restart monotonicity, journal
  recovery) — will review events.ts directly (agents keep exhausting context on it).

## SSE drain ordering fix (direct review, agents kept exhausting context)
- Reviewed events.ts (374L) directly: cursor-restart monotonicity CORRECT (loadEvents restores cursor to journal max,
  append continues prevCursor+1; torn-tail lines skipped = crash tolerant); eventId dedupe CORRECT.
- Found + FIXED narrow SSE ordering race in index.ts sseHandler drain loop: it `await`ed writeCanonical per queued row,
  so a live row from a still-running task could chain in BEFORE a later queued row -> out-of-cursor-order frames ->
  client `id<=last.id` guard would DROP it. Fix: enqueue whole drain into the serialized write chain synchronously
  (`void writeCanonical`, no per-row await). Chain still serializes order+backpressure. engine 142/0 + tsc clean.
- verify.sh 14/0 after fix (no regression).
- Restarted persistent stack to apply all fixes (engine not hot-reloaded). NEW URL http://localhost:55583
  (engine :51357 router :60713 web :55583).

## STATE SUMMARY
Engine 142/0 · Router 135/0 · web tsc clean · build.sh exit 0 · verify.sh 14/0 (x3).
Live e2e: create(snake game) / edit(pause) / multi-file(todo app, 193 ev) / stop — ALL PASS.
Event pipeline: canonical cursor store, replay+?since+Last-Event-ID, drain ordering fixed. Matches/exceeds reference.
CORE OBJECTIVE MET. Remaining rounds: hardening (error-recovery e2e, run_command tasks, edge cases).

## Wave 7 — run_command e2e PASS
- "create fib.py + run with python3 + verify" -> 2-step plan, write_file fib.py, run_command python3 fib.py,
  coder self-verified output. fib.py correct; output "0 1 1 2 3 5 8 13 21 34 55 89 144 233 377". Task done.
- run_command tool path confirmed live: process spawn + stdout capture + self-verification.

## LIVE E2E VERIFICATION MATRIX (all PASS)
| task type        | result                                                            |
| create (1 file)  | snake.html real game (canvas/keydown/score/rAF)                   |
| edit (modify)    | pause/spacebar/PAUSED overlay added to snake.html                 |
| multi-file       | test6 todo app: index.html+styles.css+app.js, reviewer verified   |
| run_command      | test7 fib.py created + python3 executed + output verified          |
| stop             | clean user stop, Steps 4/5, cost/tokens reported                  |
Event contract: single ascending numeric cursor space on every task (16/67/193 events).

## CONVERGENCE
Objective met: reference improvements ported (event pipeline == ref), engine runtime > ref (B7/B11/B13),
router > ref (+B39 +4 hardening bugs), event pipeline hardened (drain ordering). All task types work live.
Engine 142/0 · Router 135/0 · web clean · build.sh 0 · verify.sh 14/0 (x3). Stack live: http://localhost:55583.
Remaining hardening candidates: error-recovery scenarios, planner avoiding unverifiable "open in browser" steps,
larger interdependent multi-file projects.

## CAPSTONE — "make a 3d flappy bird game" (original scenario) PASS with review-retry recovery
- 6-step plan. Steps 1-3 done. Step 4 (Pipe) initial attempt FAILED by reviewer ("reviewer failed s5 — feeding issues
  back") -> orchestrator routed issues back to coder -> coder reworked as src/Game.js (Pipe class + Game class w/
  collision+scoring). Task reached DONE, 6 files/464 lines, functionally COMPLETE (Pipe+Game+Bird+scene+keydown+rAF loop,
  three ^0.160 + vite). Review-feedback-retry loop WORKS.
- MINOR QUIRK FOUND: reworked steps stay marked [failed] in the plan even after the rework delivers their functionality
  (steps 4-5 [failed] but Game.js implements them; task still [done]). Cosmetic bookkeeping — step status not updated
  after successful rework. Candidate for orchestrator step-status fix (investigate risk vs benefit).

## Step-status quirk — ROOT-CAUSED, design decision (not fixing)
orchestrator.ts:664-682: review loop gives <=2 rounds; line 671 `if (pass || attempts>=2) break` caps review to avoid
infinite loops. On a failed rework the step stays status="failed" (line 682) + markStepFailed (692), even though the
rework file (Game.js) is functional. finalize (542-547) marks task "done" unless ALL steps failed. So step status =
review verdict; task status = overall goal. Flappy: reviewer failed the Game.js rework (possibly over-strict) but the
file is functionally complete -> task done, steps 4-5 show failed. FIXING would need step<->rework coverage tracking
(complex) or loosening the reviewer (risky). End result works -> NOTE ONLY, no change. Candidate if pursuing polish:
investigate reviewer false-negatives on functional code.

## Round 9 — REVIEW-DIFF TRUNCATION BUG found + FIXED (real multi-file reliability issue)
ROOT CAUSE of flappy steps-4/5 "failed": reviewStep did naive clip(patchText, 6000) -> large multi-file diffs sliced at
the char cap, dropping later files -> reviewer failed "src/Game.js is missing from the diff" though Game.js was written.
(The hallucination-guard didn't catch it because Game.js IS a real changed path.)
FIX: orchestrator.ts truncatePatchForReview() — keeps EVERY changed path visible: manifest lists all files, full hunks
while budget lasts, elided files marked "FILE IS PRESENT, do not report missing". Raised PATCH_CHAR_CAP 6000->12000.
Wired into reviewStep. +4 regression tests (review-truncate.test.ts). ENGINE 146/0, tsc clean, build.sh exit 0.
LIVE VERIFY (test9, 5-file markdown note app): task DONE all 6 steps, 5 files. 1 review fail = LEGITIMATE (coder forgot
storage.js attempt 1 on a small non-truncated diff; reviewer caught it; retry produced it) -> fix preserves real catches,
kills truncation false-fails. Stack restarted: http://localhost:44121 (engine :58795 router :57597 web :44121).

## Round 9 (cont.) — NO-OP GUARD accumulation bug found + FIXED; under-tested-file audits
LIVE platformer e2e (test10, 7 files): DONE all 6 steps. 2 review fails ("physics.js/main.js missing from diff") were
LEGITIMATE — timeline shows review ran BEFORE the file was written (coder attempt-1 wrote nothing). Total diff 6461B
(<12KB) so NO truncation; truncatePatchForReview not the cause.
ROOT CAUSE of coder-not-writing-not-caught: NO-OP guard tested `bundle.files.length===0`, but computeDiffs diffs vs the
task-start snapshot (not consumed across steps), so step 2+ bundle ALWAYS carries earlier steps' files -> never empty ->
guard never fired -> coder that wrote nothing sailed into review -> "file missing" fail -> wasted retry.
FIX: orchestrator.ts madeWriteOrEdit(outcomes) = successful write_file/edit_file in the step's OWN outcomes
(accumulation-proof). NO-OP guard now: no-tool-call branch OR !madeWriteOrEdit branch -> nudge before review.
+6 tests (noop-guard.test.ts).
AUDITS (disjoint under-tested files): chat.ts 9bcd862b DONE (3 real bugs: null/empty content crash, non-string content
leaks [object Object] into prompt, clip crash; +toText; 11 tests). context.ts ba860441 DONE "all green" (~21 tests).
compaction.ts 39c3d8db STILL RUNNING (its tests red mid-TDD). Engine excl. compaction 184/0.

## Round 9 FINAL — all fixes integrated + live-verified
compaction.ts 39c3d8db settled (ran out of room at the very end, but final edits landed): compaction.test.ts 18/0.
FULL ENGINE 202/0 (146 start -> +11 chat +21 context +6 noop-guard +18 compaction), tsc clean. build.sh exit 0
(router 135/0, engine 202/0, web built). Stack restarted: http://localhost:38075 (engine :39721 router :51645 web :38075).
LIVE pomodoro e2e (test11, 3 files): DONE all 4 steps, 0 review-fails (vs 2 pre-fix platformer), NO-OP guard fired
correctly once ("step s4: no tool call from coder — nudging") -> coder nudged to act, completed cleanly. Fix confirmed:
guard now detects no-write per-step (accumulation-proof) instead of letting it sail into a "file missing" review-fail.

## ROUND 9 TALLY
Fixed: (1) review-diff truncation dropping files [truncatePatchForReview +4 tests]; (2) NO-OP guard accumulation-blind
[madeWriteOrEdit +6 tests]; (3) chat.ts null/non-string content crashes [agent, +11 tests]; (4) context.ts bugs [agent,
+21 tests]; (5) compaction.ts bugs [agent, +18 tests]. Engine 146->202. Live e2e: platformer(7-file) + pomodoro(3-file)
both DONE. Objective remains met + now more robust.

## Round 10 — concurrent execution tested; verify-step regression found + FIXED
CONCURRENT e2e: 2 tasks at once (test12a tip-calc + test12b md-converter; then test13a unit-conv + test13b color-picker).
No cross-contamination (each dir got only its own files). Engine handles parallel tasks cleanly.
tools.ts audit 09ecd88d (ran out of room at end, work landed): tools-behavior.test.ts +13 tests, tools.ts UNCHANGED ->
write_file/edit_file/run_command already correct+secure (nested-dir create, path-traversal + symlink-escape rejection,
edit 0/multi-match errors, run_command timeout + bounded output all verified). Engine 215/0.
REGRESSION FOUND (from my round-9 NO-OP guard): test12a/test12b verify steps hit 480s wall-clock timeout. Timeline showed
guard fired "explored but changed nothing — nudging" on a VERIFY step -> coder correctly never writes -> burned the cap.
ROOT CAUSE: impliesCodeChange returned true for verify steps because their detail names files (calc.js/index.html) matching
the extension fallback. FIX: VERIFY_LEAD regex — a step whose TITLE leads with verify/validate/ensure/confirm/check/test is
a verification step -> impliesCodeChange false -> NO-OP guard skips it + isEasy auto-passes review. Exported impliesCodeChange,
+5 tests (noop-guard.test.ts now 11). Engine 220/0, tsc clean, build.sh exit 0.
RESTART http://localhost:60699 (engine :57841 web :60699). Re-ran concurrent test13: both done, all steps done, no timeouts.

## Round 11 — interdependent-module e2e + trace/bus audit + loadTraces resilience
INTERDEPENDENT e2e (test14 snake game, 6 ES modules): DONE all 6 steps. Cross-file import/export FULLY CORRECT —
main.js→game.js→{snake.js,food.js}; startGame/Snake/Food exported+imported correctly; ALL relative imports use .js
extension (browser-ESM requirement); all 4 modules pass `node --check`. Hardest multi-file test yet — passed.
trace.ts+bus.ts audit 30d4cd76: no real bugs; +15 locking tests (trace-bus.test.ts). Engine 235/0.
FIXED loadTraces corrupt-line resilience (audit out-of-scope finding): old single .map(JSON.parse) threw on ONE corrupt
line -> outer catch returned [] for the WHOLE session. Now per-line try/catch skips corrupt lines (mirrors
eventStore.loadEvents). +3 tests (trace-corrupt.test.ts). Engine 238/0, tsc clean, build.sh exit 0.
RESTART http://localhost:57071 (engine :42381 web :57071). Smoke test (dice.html) done + correct.

## Round 12 — web<->engine SSE integration verified live (last untested dimension)
WEB SSE integration VERIFIED (code review + live frame inspection):
- Route: web api.sseUrl -> /api/events/:taskId matches engine app.get("/api/events/:id", sseHandler).
- Frame: engine writes `id: <cursor>\ndata: <dto>\n\n`; live curl of a done task delivered 60 frames, monotonic cursor,
  dto keys {id(numeric),cursor,eventId,taskId,sessionId,projectId,ts,createdAt,type,payload}; trace frames carry
  payload.event (chat.ts reads rec(p.event ?? p)). Types seen: session/message/trace/route.
- Web onmessage: parses m.data, extracts numeric ev.id, forThisTask filter, maxSeenId monotonic guard, append to store;
  onerror -> exponential backoff reconnect + heal(?since) backfill. All correct.
WEB SERVING: dev.sh runs Vite dev; root 200 (title/root/main.tsx), /src/{main.tsx,useTaskStream.ts,chat.ts,api.ts} all 200;
useTaskStream served with EventSource. UI renders in dev mode.
No new bugs this round — web integration solid. All 3 services now comprehensively verified:
engine (all task types + concurrent + interdependent modules, 238/0), router (135/0), web (serving + SSE live).

## Round 13 — final reference comparison + definitive verify.sh 14/0
REFERENCE final check: file structure IDENTICAL to /workspace/agent/agent_ide (no only-in-reference files in
engine/router/web src). Confirmed captured all valuable reference fixes (event pipeline ported round 8; my copy ahead on
engine runtime + router). Reference findings docs (BUG-REPORT/FIX-PLAN/{engine,router,web}-findings) all addressed.
VERIFY.SH (definitive automated e2e) run ISOLATED (ENGINE_DATA=/tmp/verify-data PORTS_FILE=/tmp/verify-ports.json so it
doesn't clobber the live stack): **14 passed, 0 failed, exit 0**. Checks: health x3, previously-404 endpoints (B18),
settings masking (B25), task lifecycle -> done + event contract (single id space, messages+traces replayed, ?since
honored) (B1/B3/B4/B19), watchdog attached + sees engine frames (B8), router /models real ids (B41).
Live stack confirmed unaffected (ports file intact, engine/web 200, engine 238/0).
COMPREHENSIVE CLEAN BILL OF HEALTH: engine 238/0, router 135/0, web tsc clean, build.sh exit 0, verify.sh 14/0.

## Round 14 — error-recovery e2e + reviewer false-pass bug found + FIXED
ERROR-RECOVERY e2e (test16): seeded broken.js (ReferenceError typo). Coder ran it (saw crash) -> read to diagnose ->
fixed rezult->result -> re-ran clean (fib(12)=144). All 4 steps done. Error recovery verified live.
3-TASK concurrency (test17a/b/c): all done, no cross-contamination. BUT test17c exposed a REAL BUG: index.html references
quotes.js but quotes.js was NEVER created; reviewer PASSED it -> broken output marked done. Timeline: planner failed 2x
under load ("planner JSON unparseable — repairing") -> fallback single-step "execute goal directly" -> coder wrote only
index.html -> reviewer false-pass.
FIX (goal-named-file false-pass guard): reviewStep now deterministically fails a PASS when a source file named in the step
is absent from the diff AND not pre-existing (task-start snapshot). goalNamedFilesMissing(step,patch,preExisting,
includeDetail). SCOPING (found via a false positive on stopwatch test18/19): multi-step plans check only the step TITLE
(a step's detail names other steps' files -> false positive); single-step plans check title+detail. Coder retry then
creates the file. +9 tests (review-missing-file.test.ts). Engine 247/0, tsc clean, build.sh exit 0.
RESTART http://localhost:34841. Fresh multi-file todo e2e (test20): all 3 steps done, both files, 0 guard false-positives,
verify step no timeout. Guard confirmed working live.

## Round 15 — verify.sh re-confirm 14/0 + planner resilience bump
RE-RAN verify.sh (isolated) after round-14 changes: **14 passed, 0 failed** — no regression. Live stack healthy.
PLANNER RELIABILITY (root cause of round-14 test17c fallback): inspected planTask — 2 attempts (initial+repair) then
single-step fallback. parseJsonLoose already very robust (fences/stray-brace/longest-object salvage); failures were the
LLM returning garbage under load, not a parse bug. Bumped planner attempts 2->3 (each retry re-queries router, may land a
healthier model; only costs an extra call on failure). Engine 247/0, tsc clean, build.sh exit 0.
RESTART http://localhost:58775. Smoke test (age.html): file created CORRECTLY (task done); its verify step hit the 480s
wall-clock cap from 3 slow run_commands under current LLM slowness — NOT the NO-OP guard (no nudge), NOT a regression;
deliverable unaffected (best-effort verify step). Known minor: slow verification run_commands can exceed the per-step cap.

## Round 16 — verify-step timeout headroom
Addressed round-15's minor issue (verify step hit 480s cap from slow run_command round-trips under LLM slowness — NOT the
NO-OP guard, deliverable unaffected). Bumped PER_STEP_TIMEOUT_MS 480_000 -> 600_000 (8 -> 10 min): gives slow verify
steps room to finish; still bounded by the 2400s task cap. Updated the stale "480 s step guard" comment. Engine 247/0,
tsc clean, build.sh exit 0.
RESTART http://localhost:42035. Smoke test (tip calculator, test22): both steps done, tip.html correct (parseFloat tip/total
logic). Stack healthy post-change.

## Round 17 — FOUND+FIXED false-positive in round-14/15 goal-named-file guard
BUG (found via 3-file memory-game e2e test23): step "Create index.html linking style.css and loads game.js" was FAILED even
though index.html was created correctly — the title-only check flagged style.css/game.js (created in steps 2/3) as missing.
A step TITLE can REFERENCE other steps' files (linking/loading), so title-only was insufficient.
FIX (create-verb heuristic): for multi-step plans, goalNamedFilesMissing now only checks files that are the DIRECT OBJECT of
a create-verb in the title (new CREATE_VERB_FILE_RE: create|make|write|build|add|implement|generate|produce|author|draft +
optional the/a/an + file). Referenced files (linking style.css, loads game.js) are NOT flagged. Single-step still checks all
of title+detail. +2 tests. Engine 249/0, tsc clean, build.sh exit 0.
RESTART http://localhost:52857. Re-test (test24): step1 now DONE, guard fired 0x — false positive ELIMINATED. Task later hit
heavy LLM 503s (backend instability) -> stuck -> watchdog "stopped by user"; index.html+style.css created, game.js not. NOT a
regression from my changes (create-verb guard + step-timeout bump don't cause task-level abort).

## Round 18 — verify.sh re-confirm 14/0 + broaden create-verb list
RE-RAN verify.sh (isolated) after round-17 create-verb fix: **14 passed, 0 failed** — no regression.
BROADENED CREATE_VERB_FILE_RE: added scaffold|compose|craft|construct|assemble|prepare to the create-verb list, reducing
false negatives (steps that create a file with a less-common verb were previously unchecked). Low risk: the regex only
matches when the verb is directly followed by a source-file name. Engine 249/0, tsc clean, build.sh exit 0.
RESTART http://localhost:57689. Smoke test (unit converter, test25): done, convert.html correct (km<->mile 1.609/0.621 logic).

## Round 19 — parallel fresh-eyes audit wave: 9 real bugs found + FIXED
Dispatched 4 read-only audit subagents (2 delivered, 2 hit context limit). Engine 249->260/0 (+11 tests).
GUARD-REGEX audit (5 FIXED): (1) CRITICAL — extractChangedPaths only matched "diff --git" but computeDiffs emits jsdiff
"Index:" headers, so changedBases was always empty (guard leaned on snapshot); now matches both. (2) preBases counted ALL
snapshot keys incl. null (new/FAILED write) -> a failed write masked a missing file; now only non-null (truly pre-existing).
(3) CREATE_VERB_FILE_RE missed gerund/past ("Creating x.js"); added full conjugation. (5) GOAL_SRC_FILE_RE matched "app.js"
inside "app.js.map"; added (?!\.\w). (6) URLs matched as files; filtered "//". +8 tests (diff helper now uses REALISTIC
Index: format; old synthetic diff --git could not catch #1).
EVENT-STORE/TRACE audit (3 FIXED): floorEventId() was exported but NEVER called -> now called in loadTraces (clock-skew id
guard); torn-tail (crash, no trailing \n) now byte-truncated in BOTH loadEvents + loadTraces so next append doesn't glue onto
partial bytes; leading UTF-8 BOM stripped in both. +3 tests. Deferred (complex/minor): cursor high-water persistence, out-of-
order fire-and-forget persist, coordinated multi-object capture, quoted git paths.
NO-OP SINGLE-NUDGE gap (found via live color-picker test26): coder returned EMPTY replies (LLM 503 flakiness), single nudge
also empty -> step failed -> task "done" with index.html MISSING. Fixed: NO-OP guard now a bounded loop (up to 2 nudges; each
re-queries router, may land a healthier model). RESTART http://localhost:34309. Re-test (test27): both steps done, BOTH files
created. Deliverable complete.

## Round 20 — OpenCode zen free models via UI path + 3 real bugs fixed
USER REQUEST: add the OpenCode (opencode.ai/zen/v1) free models + API key THROUGH THE UI (not config files),
only small/param-free models, run critique agents, keep hunting bugs.
DISCOVERY: router already had a "zen" provider + a working key (sk-AF23…6fPg) in router.db. Live zen /models
serves 8 free models: big-pickle, deepseek-v4-flash-free, muse-spark-1.2-contributor-free, mimo-v2.5-free,
hy3-free, nemotron-3-ultra-free, nemotron-3.5-lightning-free, laguna-s-2.1-free. Verified key works via curl
(hy3-free SUCCESS). NOTE: muse-spark is /responses-API only (router+engine only do /chat/completions) — gap flagged.
ACTION: added "OpenCode Zen" provider via PUT /api/settings (the exact endpoint the SettingsModal calls) —
engine discovered all 8 zen models. E2E PROOF: set selectedModels planner/coder/reviewer=hy3-free, ran a trivial
task -> route events "route coder -> hy3-free", llm.call span model=hy3-free, hello.txt created correctly.
BUG #1 (CRITICAL, exposed by adding a 2nd provider) seedFromSettings seeded NATIVE_MODELS once PER provider;
refresh() byId merge keeps LAST dup -> engine/small|medium|large got re-tagged to the newest provider
("OpenCode Zen") and became unroutable. FIXED: seed once against the router (hostOf match), baseUrl always
DEFAULT_ROUTER_BASE. +3 tests (test/providers.test.ts).
BUG #2 loadSettings never reconciled the persisted engine-router baseUrl; after a router restart on a new dynamic
port the saved baseUrl went stale -> the router's 14 models stopped being discovered (21 -> 11). FIXED: reconcile
any loopback baseUrl to DEFAULT_ROUTER_BASE (remote providers untouched) + isLoopbackBase helper. +3 tests
(test/config.test.ts).
BUG #3 PUT /api/settings forwarded provider keys to HARDCODED http://127.0.0.1:4098/keys; on any other router
port the forward silently failed (.catch(()=>{})) so UI-added keys never reached the router. FIXED: derive
routerKeysUrl from DEFAULT_ROUTER_BASE (strip /v1). Import added.
Engine 260 -> 266/0 (+6 tests), tsc clean, build.sh exit 0. Restart http://localhost:59237 (engine :47015,
router :53985). 21 models discovered (13 Local Router + 8 OpenCode Zen); engine/* aliases correctly on Local Router.
Dispatched 4 parallel read-only critique/audit agents (my-fixes critique, settings/provider flow, router, web UI).

## Round 21 — 4 critique/audit agents (~44 findings) + critical/security fixes + muse-spark /responses E2E
Dispatched 4 parallel read-only agents (my-fixes critique, settings/provider flow, router, web UI). They returned
~44 findings (4 critical, many important). Fixed the critical + high-impact ones with TDD, then verified live.

CRITICAL FIXED:
- C1 tier-alias hijack: refresh()'s byId merge let ANY discovered model overwrite a seeded engine/* alias (a custom
  provider returning {"id":"engine/small"} re-pointed the alias at its own baseUrl + key). FIXED: extracted
  mergeDiscovered() and skip discovered ids in the reserved engine/* namespace. +3 tests.
- C2 stored-key exfiltration: masked-key preservation + unvalidated base_url let an attacker re-point a provider at
  file:// / 169.254.169.254 / attacker.example and have the engine send the preserved key there as Bearer. FIXED in
  PUT /api/settings: exact-id match only (was loose 4-way id/name OR = I1 key cross-wiring), discard preserved key
  when base_url changes, isSafeProviderBaseUrl (http/https only, deny link-local/metadata/file), strip control chars
  from keys, 400 on unsafe. LIVE-VERIFIED: file:// + metadata PUTs -> 400, nothing persisted.
- I6 SSRF: POST /api/settings/test/:id had a `|| body?.provider` fallback = one-shot SSRF w/ attacker URL+Bearer.
  FIXED: resolve only from saved settings, validate base_url, only 2xx=ok (was ok:true on 401), redactSecrets on
  error echo (Bun invalid-header error echoes the Authorization value -> I8 leak into /api/logs). LIVE-VERIFIED 404.
- Web F1: SettingsModal seeded draft with literal fake key "sk-engine-key" and Save was enabled before GET resolved ->
  clicking Save early PUT the fake key over the real router key + wiped providers. FIXED: removed fake key, added
  `loaded` gate (Save disabled until GET succeeds; on failure draft is NOT re-seeded), empty-array fallback only when
  field absent (F2), crypto.randomUUID provider ids (F4), provider id/base_url validation (F6), clear masked key when
  base_url changes.
- Critique of MY round-20 loadSettings fix: it rewrote ANY loopback baseUrl -> clobbered Ollama/LM Studio (F1, with
  GET->UI->PUT persisted data loss) and ran even when ENGINE_ROUTER_BASE was unset (F3 dead :4098). FIXED: only
  reconcile the canonical router provider (id engine-router / name Local Router), only when ROUTER_BASE_EXPLICIT,
  structuredClone fallback (F5), [::1] bracket handling (F4). Rewrote config.test.ts (22 tests incl. Ollama case).

IMPORTANT FIXED: I3 disabled providers now skipped in refresh; M1/M2 atomic saveSettings + chmod 0600;
router F3 strip control chars in POST /keys; F4 envKeyFor trim; F5 maskKey full-mask <16 chars.

MUSE-SPARK / RESPONSES API (router F1/F2): muse-spark-1.2-contributor-free is only served via the OpenAI Responses
API (/responses), not /chat/completions, so it was unroutable (and unknown body models silently substituted = F2).
FIXED both layers: (a) router — ModelEntry.endpoint discriminator, seeded big-pickle/mimo-v2.5-free/deepseek-v4-flash
-free/muse-spark, proxy translates messages->input and responses->chat/completions (usage incl.), SSE wrap for stream
clients; (b) engine — isResponsesOnlyModel + normalizeResponsesToChat + chat() branch (engine calls a model's baseUrl
directly, so it needs its own translation). +3 engine tests.
E2E VERIFIED: router curl muse-spark -> HTTP 200 chat.completion content "OK" usage ok; ENGINE task with
selectedModels=muse-spark -> route events "planner/coder -> muse-spark (manual role override)", note.txt created
"muse spark works". Then reset selectedModels to auto.

Counts: engine 266 -> 279/0 (+13), router 135/0, web tsc clean, build.sh exit 0. Restart http://localhost:57025
(engine :59023, router :60603). 21 models discovered after force-refresh (boot-time cache race self-heals; = I4/I5).
REMAINING (deferred): I7 response-size cap, I9 unverified-tag routing enforcement, I4/I5 refresh single-flight +
cache keying, M3 fail-closed no-key, M4 NaN pricing guard, M6 models.dev empty-path, M7 zen forward id literals;
router F6 param_b runtime check, F7 429 decay, F11 in-body RL on 4xx/stream, F12 include_usage; web F7 discovered
models invisible in UI, F8 selectedModels surface, F5 stale-overwrite concurrency.

## Round 21b — remaining important findings batch (M4, I7, F6, F7, M7)
- M4 NaN pricing guard: specFromEndpointAndCatalog used Number() on endpoint pricing/context — a non-numeric
  ({"input":{}}) yielded NaN, and NaN cost accumulation silently defeats `>= budgetCapUsd`. FIXED via finiteNum()
  (Number.isFinite, 0/fallback) for ctxWindow/maxOutput/costIn/costOut.
- I7 /models DoS cap: fetchProviderModels did unbounded res.json() + unbounded data[]. FIXED: read text with a
  ~2MB cap (reject larger), JSON.parse guarded, cap data.length at 1000 (MAX_PROVIDER_MODELS_BYTES/COUNT).
- Router F6 param_b runtime enforcement: createRouterApp accepted arbitrary opts.providers with zero validation and
  param_b was never checked at routing time (NaN slipped past `> MAX_PARAM_B`). FIXED: validate every model entry
  (Number.isFinite(param_b) && <= MAX_PARAM_B) at startup, fail fast. Imported MAX_PARAM_B.
- Web F7 discovered models invisible: GET /api/models was never called anywhere in web/src, so the just-added
  OpenCode Zen models were invisible in the Settings UI. FIXED: api.models()/refreshModels() + DiscoveredModel type,
  and a read-only "Discovered models (N)" table in the Models tab with a refresh button. Also added
  selectedModels/disabledModels to SettingsDto (F8 ground-work) and F10 encodeURIComponent on the test route.
- M7 zen key-forward id literals: PUT forwarded to router provider "zen" only for ids zen|opencode|opencode-zen; a
  renamed provider skipped. FIXED: also match on base_url host endswith opencode.ai. LIVE-VERIFIED: router /keys has
  engine-router+opencode-zen+zen before and after re-save.
Counts unchanged: engine 279/0, router 135/0, web tsc clean, build.sh exit 0. Restart http://localhost:37295
(engine :58123, router :32877). 21 models discovered.
STILL REMAINING: I9 unverified-tag routing enforcement (policy nuance — zen models are "unverified" but legitimate;
needs allowlist or a verified-provider notion, deferred to avoid breaking the working zen setup), I4/I5 refresh
single-flight + cache keying (boot-time race self-heals on force-refresh/next interval), M3 fail-closed no-key,
M6 models.dev empty-path match, router F7 429-decay, F11 in-body-RL on 4xx/stream, F12 include_usage for streamed
cost, web F8 selectedModels edit surface, F5 stale-overwrite concurrency, F3 masked-key rotation UX.

## Round 22 — agent web_search audit + ad-filter fix (user: "can the agent search?")
VERDICT: YES — the agent can search. Verified end-to-end.
- web_search tool exists (tools.ts), is in TOOL_SPECS roster shown to the agent LLM, is in
  READONLY_TOOLS (auto-approved, no human click), and handler is registered. /api/websearch
  endpoint mirrors it for the web UI.
- E2E PROOF: ran a real task "use web_search ... write top result title to result.txt" -> the
  agent planned it, called web_search, and wrote "Bun — A fast all-in-one JavaScript runtime".
- BUG FOUND + FIXED: DuckDuckGo serves sponsored results with the same result__a class; the old
  parser returned ads (duckduckgo.com/y.js tracking redirects) as TOP results, misleading the
  agent. First fix (skip ad titles) desynced the snippet pairing (ad snippet bled into result #1).
  FINAL FIX: per-block parse in BOTH tools.ts web_search and index.ts /api/websearch — pair each
  title with the snippet that follows it in the markup and drop sponsored results as a unit
  (title + snippet) via isDdgAd()/wsIsDdgAd() (/\/y\.js\?|ad_provider=|ad_type=/).
- Added engine/test/websearch.test.ts (3 tests for isDdgAd). Engine 279 -> 282/0.
- LIVE-VERIFIED after restart: /api/websearch returns 6 organic results, 0 ads, aligned snippets.
- CAVEAT: DDG HTML scraping is rate-limited/flaky (hit one HTTP 202 challenge page during testing);
  search works but can be intermittently throttled. Restart http://localhost:42295 (engine :42607).

## Round 23 — multi-provider fallback, transparency, per-role control, search reliability
(user: "add multiple free fallback engine... instead of blackbox provide info... give control over
which agent is used for which work... make the api part very reliable... add all famous provider,
free provider, tokenrouter opencode openrouter orcarouter... research every provider from docs")
- DECLINED (told user): impersonating the OpenCode client / faking request identity to evade free
  limits = ToS abuse. Delivering free+reliable the legitimate way (real free providers + fallback).
- RESEARCH (4 subagents, live-verified from official docs, Aug-2026 data): OpenRouter (:free, 20RPM/
  50RPD<$10), OrcaRouter (-free forever), TokenRouter = ambiguous name -> tokenrouter.me is the
  agent gateway (13 models, free trial 50 req, /chat/completions + /responses). Free-provider
  roundup: Groq/Google/Mistral/SambaNova/OpenRouter/Cloudflare truly $0; Cerebras=$5 trial;
  Together=NOT free (no trial); GitHub Models=RETIRED 2026-07-30; Cohere compat=api.cohere.ai.
- PER-ROLE CONTROL: decideRoute honors settings.selectedModels[role] (all 6 roles) -> manual pin
  bypasses scoring; disabled/unknown pin degrades to auto-route. Extracted the decision into pure
  resolveRoleOverride() in config.ts because chat.test.ts mock.module("../src/router.js") is
  process-global and masked logic embedded in decideRoute in the full suite (test-pollution fix).
  LIVE-VERIFIED: PUT selectedModels.router=hy3-free -> /api/bytheway routed to hy3-free, answered OK.
- TRANSPARENCY (de-blackbox): GET /api/router/status (engine proxies router /routes) -> policy,
  tiers S/M/L, per-provider healthy/key_configured/models/429s/5xx/rpm. New Routing tab in Settings:
  per-role model select, model availability toggles, "what is the Local Router" explainer + live
  provider health table. 17 provider presets (gateways+free+paid+local) with corrected notes.
- RELIABILITY F7 FIXED (router): consecutive_429 only reset on success, so a provider at the ceiling
  was locked out FOREVER (couldn't score a success while excluded). Added decay429IfDue(): once the
  cooldown is served AND RATE_LIMIT_RECOVERY_WINDOW_MS (300s) passes since the last 429, the streak
  clears so the provider re-enters the pool. Wired into isProviderHealthy + healthSnapshot (select
  pool sees it). router/test/decay-429.test.ts (4 tests). Router 135 -> 139/0.
- SEARCH RELIABILITY: DDG hard-blocked mid-session (HTTP 000/202). Extracted shared engine/src/
  websearch.ts with searchWeb() = DuckDuckGo -> Bing fallback (first backend with >=1 organic result).
  Added parseBing + unwrapBingHref (decodes /ck/a base64url click-tracking to real URLs). Both
  tools.ts web_search and index.ts /api/websearch now share it (removed ~120 lines of duplication).
  websearch.test.ts expanded to 9 tests (ad-filter, DDG pairing, Bing parse/unwrap, fallback via
  patched fetch). LIVE-VERIFIED: DDG blocked -> Bing returned 6 clean organic results.
Counts: engine 282 -> 293/0, router 135 -> 139/0, web tsc clean, build.sh exit 0.
Restart http://localhost:52285 (engine :60699). 21 models discovered.
STILL REMAINING: F11 in-body rate-limit detection on 4xx/streaming, F12 stream_options.include_usage
for streamed cost, I4/I5 refresh single-flight, M3 fail-closed no-key, M6 models.dev prefix match,
web F5 stale-overwrite (ETag), F3 masked-key rotation UX. OrcaRouter/TokenRouter not seeded into the
router's DEFAULT_PROVIDERS (need <=80B param confirmation + user keys); reachable via engine presets.

## Round 24 — terminal garbage, Ctrl+Shift+C, model/provider blackbox, no-API section
(user: "fix this buggy mess in the terminal {resize json}... ctrl shift c interacts with browser...
why nvidia nim showing in model but not provider... no blackbox qwen/qwen3-30b-a3b:free@Local Router...
if a model is free + no api key, make a 'no api' section configured by default")
- TERMINAL JSON LEAK (root cause): web sends resize as OBJECT {"resize":{cols,rows}} but engine only
  matched ARRAY {"resize":[c,r]} (terminal.ts), so every resize frame fell through to writeInput() and
  the raw JSON was typed into the shell. FIX: exported pure parseResizeFrame() accepting BOTH shapes
  (+ numeric-string coercion, malformed rejection); WS handler uses it. test/terminal.test.ts (6 tests).
- TERMINAL STTY ECHO: resize() typed `stty cols C rows R\n` into the shell (echoed a line every resize).
  FIX: echo-free TIOCSWINSZ — a tiny persistent python3 helper holds the shell's real PTY slave open
  (found by walking /proc/<script>/task/<pid>/children -> readlink fd/0 -> /dev/pts/N) and ioctls the
  size (kernel dispatches SIGWINCH); falls back to stty only if python3/PTY unavailable. Added no-op
  guard (skip identical dims). Resizer killed on exit/kill/idle-reap. LIVE-VERIFIED via WS client:
  RESIZE_JSON_LEAKED=false, MARKER_EXECUTED=true, STTY_ECHO_PRESENT=false.
- CTRL+SHIFT+C/V: xterm attachCustomKeyEventHandler — Ctrl+Shift+C / Ctrl+Insert copies the xterm
  selection to clipboard; Ctrl+Shift+V / Shift+Insert reads clipboard and feeds it to the PTY. No longer
  falls through to the browser (DevTools). web/TerminalPanel.tsx.
- MODEL/PROVIDER BLACKBOX (root cause): engine discovered models from the Local Router's /models, which
  flattens all router-internal providers (openrouter/groq/nvidia-nim/cerebras) under provider
  "Local Router" — so nvidia-nim models appeared with no nvidia-nim provider, and keyless (non-working)
  models were shown as available. FIX (engine/providers.ts): the router's /models carries owned_by (real
  upstream); discovery now sets provider=owned_by (SAFE: router ignores the incoming Bearer and resolves
  its own upstream keys — verified router has no incoming-auth middleware). New classifyRouterModel()
  + fetchRouterKeys() (router /routes key_configured) disable + tag "needs-key" on models whose upstream
  has no key; unknown key status degrades to enabled (never lock out on a probe failure). +5 tests.
- WEB "NO API" SECTION: Models tab now groups discovered models into "✓ Free · no API key needed
  (enabled by default)" / "Ready" / "🔑 Need an API key" (isFreeModel/isKeyGated + DiscoveredTable);
  key-gated models are excluded from the pinnable modelOptions. Real upstream shown, not "Local Router".
- LIVE-VERIFIED after restart http://localhost:35091 (engine :47229): qwen/qwen3-30b-a3b:free now
  @openrouter NEEDS-KEY (disabled); nvidia-nim models @nvidia-nim NEEDS-KEY; zen models @OpenCode Zen
  enabled+free -> "Free" section; per-role override (bytheway -> hy3-free) still works.
Counts: engine 293 -> 304/0, router 139/0, web tsc clean, build.sh exit 0.
STILL REMAINING: F11 in-body rate-limit detect on 4xx/stream, F12 include_usage streamed cost, I4/I5
refresh single-flight, M3 fail-closed no-key, M6 models.dev prefix match, web F5 stale-overwrite (ETag),
F3 masked-key rotation UX. laguna-s-2.1-free/deepseek-v4-flash-free show enabled=False via the direct
OpenCode Zen provider (pre-existing models.dev deprecation/disabled state, not a round-24 regression).
