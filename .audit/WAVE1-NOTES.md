# Wave 1 — Engine-runtime agent notes (all 17 items DONE, verified)

Verification at completion (from /workspace/agent/engine): `bunx tsc --noEmit` → 0 errors (incl. all pre-existing baseline errors fixed); `bun test` → 69 pass / 0 fail (7 test files); `bun build src/index.ts --target=bun` → clean. No new deps. Wave-2 files (index.ts, bus.ts, chat.ts, trace.ts, terminal.ts, logger.ts) were NOT touched.

## Contracts wave 2 MUST consume (do not re-derive)
- **Nudge hook (B44):** `export function enqueueNudge(taskId: string, text: string): boolean` in `orchestrator.ts` (~line 70). Returns `false` when the task is not live or text is empty; bounded to last 10 nudges (2KB each). The tool loop drains the queue between LLM calls, injecting each nudge as a `[NUDGE — adjust course if relevant]` user turn. **No HTTP route yet — wave 2 wires `POST /api/tasks/:id/message` to this.** Surface `404/409` when it returns false.
- **Live task↔session index:** `taskSessions` Map in orchestrator (`taskSessions.set(task.id, session.id)` in runTask/resume, cleared in finalize). `enqueueNudge` uses it.
- **AppSettings addition (B7):** `approvals?: { mode: "gate" | "auto" }` — absent = gate. `toolRequiresApproval(name)` in tools.ts honors it (auto → never gates).
- **Session.pastTasks (B9):** `Session.pastTasks?: TaskRecord[]` — archived terminal tasks, cap 25. runTask archives a terminal (done/failed/stopped) previous task here and creates a fresh one. **Wave 2's `ensureTask` (B19) must REUSE this archiving logic, not duplicate it.**
- **ExecuteToolResult:** gained optional `approvalWaitMs?: number` (gated-tool deadline refund).
- **chatRace onLoser:** gained optional `tokensIn/tokensOut/estimated` (usage of 200-OK losers) so caps bind.
- **TaskRecord.status vocab:** planning | running | waiting-approval | reviewing | done | failed | stopped.

## Trace → wire facts (for the B1/B2 bridge)
- `trace.emit(...)` in `trace.ts` stamps `{ id, at }` via a restart-safe monotonic scheme: `Date.now() - 1_700_000_000_000 + seq` (guarded strictly ascending). **This is the id source wave 2's single-id-space (events.ts) should reuse/extend.** TraceEvent shape: `{ id, sessionId, taskId?, parentId?, spanId, kind, agentRole?, label, input?, output?, tokensIn?, tokensOut?, costUsd?, durationMs?, model?, contextRefs?, at }`.
- `TraceKind`: task.start, task.end, plan, agent.start, agent.end, agent.thought, route, llm.call, llm.retry, tool.call, tool.result, approval.request, approval.decision, retrieval, compaction, review, diff.propose, error, context.snapshot.
- Tool spans: `tool.call` = `{ kind, label: "tool: <name>", spanId, input: summarizeArgs(...) }`; matching `tool.result` = `{ kind, label, spanId, output: { ok, result | error, ... } }` (SAME spanId as the call). Router watchdog (B8) already correlates by spanId.
- Current manual mirrors to REMOVE when the bridge lands: orchestrator.ts `emit()` wrapper (~line 104 — keep trace.emit, delete the wire.emit mirror) and chat.ts `emit()` (:38-39). A `route` wire re-emit exists in chat.ts — prefer deriving type:"route" in events.ts from a trace kind==="route" carrying a RouteDecision input, then delete the manual one.
- Engine wire emit call-sites already use `{ type, sessionId, taskId?, ... }` (e.g. `wire.emit({ type:"task", task, sessionId })`, `{ type:"message", sessionId, message }`, `{ type:"proposal", proposal }`).

## Already-fixed (do NOT redo)
- **B26** chat.ts real-status remap — verified in place (stop 400→503 handled). Its chatRace call still lacks maxSlotMs/signal — wave 2 may add parity with the task path if cheap.
- **B28** response_format json_object (providers.ts ~L356) — in place.
- **B30** run_command detached + process-group kill (tools.ts L365-409) — in place.
- **B15** usage-missing → chars/3.5 estimate marked `estimated` — in place.

## Scope deviations flagged by the runtime agent
- `test_engine.ts`: 3 pre-existing `unknown`-type errors → `as any` casts (test harness only, not a wave-2 runtime file).
- `test/bun-test.d.ts`: minimal ambient `bun:test` declarations added (bun-types not installed, new deps forbidden).

## Deferred to wave 2 (from the runtime agent)
- HTTP route for nudge (`POST /api/tasks/:id/message` → enqueueNudge).
- Any index.ts/bus.ts/chat.ts follow-ups listed above (B1/B2 bridge, B3/B4 events endpoint, B19 ensureTask, B5/B6 hunks, /models discovery).
