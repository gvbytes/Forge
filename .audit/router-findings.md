# Router audit — findings

Scope: `/workspace/agent/router/src/**`, tests, plus engine-side call paths needed to explain the symptoms. I also compared against `router/dist/router.js` (an older bundle) which exposed several regressions. No files were modified.

## Critical

**1. Watchdog event contract mismatch — the entire watchdog is dead against the real engine.**
`router/src/watchdog/events.ts:270-323` (dispatch) only recognizes types matching `message.part.*`, `session.updated*`, `session.idle*`, `task.` (with trailing dot), `*permission*`, `*.error`, `*tool*`, `*idle*`. The engine's actual SSE vocabulary (`engine/src/types.ts:221-230`, emitted via `wire.emit`) is exactly: `trace, session, message, token, approval, proposal, task, route, status` — wrapped as `{id, taskId, ts, type, payload}` in `engine/src/index.ts:1164-1188`. Nothing matches: `"task"` fails `startsWith("task.")`, tool activity rides inside `type:"trace"` payloads with `event.kind:"tool.call"` (`engine/src/tools.ts:1120`) which dispatch never inspects, and permission gates arrive as `type:"approval"`, not `*permission*`. Result: stuck detection, deny-nudges, `onSessionActivity` attribution, and therefore the budget governor (no task rows → nothing to poll) never fire in production. All watchdog tests pass because they fabricate events (`session.next.tool.success`, `permission.v2.asked`) the real engine never emits.
*Fix:* parse the engine's real envelope (`type` + `payload.event.kind` for tool/trace events, `approval` for permission gates) or define a shared event schema.

**2. Alias-resolution gap → symptom 1 (`engine/small` → 503 `{"error":"no provider configured","attempts":[]}`).**
For aliases, routing must pass `selectProvider`, which filters `p.healthy !== false && (p.consecutive429 ?? 0) < OPEN_CIRCUIT_429` (`policy/select.ts:80-85`, `OPEN_CIRCUIT_429 = 5` at line 52). The moment the only keyed provider (zen) is in a 429 cooldown (`providers.ts:228-233`) or has ≥5 consecutive 429s, `pickRoute` finds no eligible provider for *any* tier → `noRoute(...)` → the `!decision` 503 with empty attempts (`proxy.ts:255-271`). Meanwhile explicit names (`hy3-free`, …) still route because the forced-model branch bypasses health entirely: `const hit = candidates.find((c) => c.model === forceModel); if (!hit) return noRoute(...)` (`router.ts:182-191`) — no health check — and the chain loop's last-resort path (`proxy.ts:337-352`) then fetches anyway. Worse, the alias path can never self-heal: no alias request can reach zen to produce a `markSuccess()` that resets `consecutive_429`, so alias routing stays broken until a forced-model call happens to succeed.
*Fix:* when all providers of the desired tier are ineligible, still attempt the least-bad candidate (or make the forced-model and alias paths share one "last resort" policy).

## High

**3. 429 exhaustion surfaced as 503 "no provider configured" → symptom 4.**
When the chain exhausts (e.g. zen returns 429 `FreeUsageLimitError` on every attempt), the router returns `c.json({ error: "no provider configured", attempts }, 503, ...)` (`proxy.ts:521-524`; same misleading text on the no-decision path at `proxy.ts:256`). Two harms: the error text lies (providers *are* configured; they're rate-limited), and the 429→503 mistranslation defeats the engine's quota handling — `isQuotaBackoff` requires `err.status === 429` (`engine/src/orchestrator.ts:869-871`), so the quota backoff ladder never fires and the engine instead treats it as a dead-model 5xx.
*Fix:* if all attempts failed 429, return 429 with the max Retry-After and a "all providers rate-limited" error.

**4. Symptom 2 mechanism — where penalties are recorded, and how a 200 sits next to one.**
Penalties are recorded by `recordOutcome` in `engine/src/router.ts:85-127`: `if (!ok) { ... else if (status === undefined || status >= 500) { h.fail5xx += PENALTY_5XX; ... } }` then logs `"health penalty"` (lines 104-118). It's fed from `engine/src/chat.ts:136` (`recordOutcome(modelId, false, latencyMs, status === 400 ? 503 : status)`), `engine/src/orchestrator.ts:1089`, and `engine/src/providers.ts:452`. A successful 200 is never directly penalized — I verified race-loser aborts are correctly classified (`providers.ts:533-537` checks `slot.ctl.signal.aborted || params.signal?.aborted` → outcome `"aborted"`, and both `onLoser` handlers ignore non-`"error"` outcomes). The observed pairing happens because the health ledger is keyed by model id: while one `engine/large` request wins with 200 (`"chat ok"` logged in `providers.ts:393`), a concurrent/adjacent request for the *same alias* hits the router's 503 from findings 2/3 (zen cooldown window) and records `fail5xx += 0.8` — exactly the logged `{"model":"engine/large","fail5xx":0.8,"penalty":0.8}`. Aggravators: any status-less error (timeout/network) counts as 5xx, and both chat/orchestrator remap some 400s to 503.
*Fix:* fix findings 2/3 (stop emitting 503 for rate-limited/cooldown alias requests); on the engine side, don't let a 503 that carries `attempts[]` with 429s poison model health as a 5xx.

**5. `UPSTREAM_TIMEOUT_MS` cut from 120s to 45s kills long streams mid-flight.**
`proxy.ts:35`: `const UPSTREAM_TIMEOUT_MS = 45_000;` (dist build: `120000`). The signal is `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` on the upstream fetch (`proxy.ts:381`), which applies to the whole request lifecycle **including the response body** — any SSE stream (or non-streaming generation) lasting >45s is aborted by the router itself, landing in the catch at `proxy.ts:605-622` (`": upstream aborted"`, call row recorded as `error`). The engine waits up to 180s (`CHAT_TIMEOUT_MS`), so the router is now the weakest link. This is a regression vs the shipped bundle.
*Fix:* restore 120s+ and/or use an idle-timeout (reset on each chunk) instead of an absolute timeout for streaming.

**6. Body model now forces exact-model routing — unknown models 503 (regression).**
`proxy.ts:199-200`: `const explicitModel = ... !bodyJson["model"].startsWith("engine/") ? bodyJson["model"] : undefined; const forceModel = headerOrUndefined(c, "x-router-model") ?? explicitModel;` — dist only used the header. Now any body model not in the provider registry hits `noRoute("forced:model=... exists nowhere healthy")` (`router.ts:184-186`). This breaks `model:"auto"` (used by `test/smoke.test.ts:460,554,665` and `router/test_proxy.ts:132`, all expecting transparent classification-based routing) and `model:"whatever"` + `x-router-tier` (`smoke.test.ts:479`), because `pickRoute` checks `forceModel` *before* `forceTier`. It also 503s any dynamically-discovered model id the engine might send that the router doesn't seed.
*Fix:* drop `?? explicitModel` (header-only override), or fall through to classification when the explicit model isn't found.

**7. Attribution wired to two different `AttributionService` instances in production.**
`createRouterApp` makes a per-app instance: `const attribution = opts.attribution ?? new AttributionService();` (`index.ts:121`) and the proxy reads it (`proxy.ts:178`). But boot auto-attach calls `startWatchdog({ engineUrl, ..., telemetry })` with no attribution (`index.ts:227`), so the watchdog writer falls back to the process-wide singleton: `opts.attribution ?? getAttribution()` (`watchdog/index.ts:79`, `attr.ts:67-72`). Watchdog writes to instance B, proxy reads instance A → headerless calls are never attributed, no task ledger rows are created, and `/watchdog/status.lastActiveSession` shows a different object than the proxy uses. Manual `POST /watchdog/attach` passes the right instance (`index.ts:134,278`), which is why only the boot path is broken.
*Fix:* pass `attribution` into `tryAutoAttach`/`startWatchdog`, or use `getAttribution()` in `createRouterApp`.

**8. Watchdog SSE client never reconnects; status lies about it.**
`WatchdogClient.loop` (`watchdog/events.ts:210-239`) runs exactly once: on `!res.ok` it tries the fallback URL once and returns; on stream `done` it breaks and returns; on fetch error it warns and returns. No retry loop. `connected` is `this.ac !== null` (line 200-202) which stays true after the loop dies, and `status()` hardcodes `attached: true` (`watchdog/index.ts:206-217`). So an engine restart (or any transient disconnect) permanently silences the watchdog while `/watchdog/status` reports attached — and the auto-attach interval was already cleared, so nothing recovers it.
*Fix:* wrap `loop` in a reconnect-with-backoff while `ac` is live; make `connected` reflect actual stream state.

## Medium

**9. Cooldown last-resort skip is scoped globally, not to the chain.**
`proxy.ts:337-352`: an unhealthy candidate is skipped when `deps.providers.some((p) => p.id !== cand.providerId && deps.resolveKey(p.id) !== null && isProviderHealthy(p.id))` — i.e. *any* other keyed healthy provider, even one that offers no model in the current chain/tier. With zen cooling down and a keyed healthy openrouter that lacks the needed tier, the last-resort attempt is skipped and the request 503s unnecessarily.
*Fix:* check for remaining healthy candidates within `plan.chain` instead of the whole registry.

**10. No outcome feedback on the no-decision 503 path.**
Chain exhaustion calls `deps.outcomes?.notifyOutcome(taskId, "failure")` (`proxy.ts:523`), but the `!decision` early return (`proxy.ts:255-271`) does not — so the cascade never escalates and `historyFailures` never grows for this failure class; the router can't self-correct by trying a higher tier on the next request.
*Fix:* notify failure on that path too.

**11. The attempt chain ignores the policy's selected provider.**
`planRoute` builds `chain = candidates.filter((c) => c.tier === decision.tier)` (`router.ts:376`) in provider-registry order; the proxy walks it from index 0. `selectProvider`'s headroom/cost ranking (`policy/select.ts:70-107`) therefore never influences attempt order — only the tier does. A saturated-but-not-cooled provider first in the registry gets tried first even when the policy "chose" another provider (the reason string and route decision say otherwise). Present in dist too, but it wastes attempts and makes `x-engine-route` reasons inaccurate.
*Fix:* order the chain starting with the decision's provider/model.

**12. Rate-limit/5xx health accounting gaps.**
(a) A 2xx body containing an error object classified by `looksLikeRateLimitError` does `continue` without `markRateLimited` (`proxy.ts:471-491`) — the provider's 429 counters never advance for in-body quota errors. (b) The health model tracks only 429s (`providers.ts:178-233`); a provider returning repeated 500s is never cooled down or marked unhealthy, so it keeps being selected every request.
*Fix:* call `markRateLimited` on the 2xx-error path and add a 5xx streak to the health state.

**13. Task rows never leave `'active'` → wall-clock governor fires on every session.**
Nothing ever updates `tasks.state` (schema `telemetry.ts:33-41`; only `addSpent` touches tasks, lines 276-280; there is no completion endpoint). `BudgetGovernor.tick` (`watchdog/budget.ts:87-144`) computes `elapsedS = now − started_ts` for every active task, so 45 min (2700s default) after a session's first attributed call it transitions finalize→halt and POSTs stop to that session's engine endpoint — even for a long-idle chat session that spent $0. `lastMode`/`windows`/`interventions` maps also grow unbounded.
*Fix:* add a task-complete path (or TTL/prune) and skip wall-clock halt for zero-spend idle tasks.

**14. `/models` and `/v1/models` emit `id: undefined`.**
`index.ts:151-159`: `providers.flatMap((p) => p.models.map((m) => ({ id: m.id, ... })))` — but `ModelEntry` has no `id` field, only `model_id_per_provider` (`providers.ts:22-33`). `JSON.stringify` drops the undefined key, and the engine's discovery filters `typeof m?.id === "string"` (`engine/src/providers.ts:182-183`) → it receives zero models from the router. (Endpoint doesn't exist in dist; new and broken.)
*Fix:* `id: m.model_id_per_provider`.

**15. `extractTool` treats any tool output as an error output.**
`watchdog/events.ts:146-159` (direct branch): `errorOutput: str(ev["output"]) ?? str(props?.["output"]) ?? ...` with no success/failed check — unlike the part-based branch which requires `status === "error" || "failed"` (lines 160-177). Successful calls with output feed `SessionWindow.recordError` (`watchdog/index.ts:159-168`, `stuck.ts:69-88`), so six consecutive identical *successful* outputs can fire a bogus error-spam intervention. (Currently masked by finding 1 — no real events arrive — but wrong on its own contract.)
*Fix:* only set `errorOutput` when the frame marks the call failed.

## Low

**16. Provider-health constants regressed vs dist.**
`providers.ts:183-186`: `RATE_LIMIT_COOLDOWN_DEFAULT_S = 3` (dist: 15), `RATE_LIMIT_COOLDOWN_MAX_S = 60` (dist: 300) — upstream `Retry-After` headers >60s get truncated (`clampCooldown`, lines 199-202), so the router retries sooner than the upstream allows; `MAX_CONSECUTIVE_429 = 15` (dist: 8) widens the dead zone where `isProviderHealthy` says healthy but `selectProvider` (circuit at 5) refuses — the exact window behind finding 2.
*Fix:* restore 15s/300s/8, or align `OPEN_CIRCUIT_429` with `MAX_CONSECUTIVE_429`.

**17. Streaming/abort telemetry distortions.**
(a) `routeHeaderValue` is computed before the streaming attempt is pushed into `attempts` (`proxy.ts:441-452` vs `557-564`), so the `x-engine-route` header and trailing SSE comment omit their own attempt (non-streaming includes it). (b) A downstream client abort during streaming makes `writer.write` throw and the call row is finalized as `status:"error", "stream aborted before completion"` (`proxy.ts:605-622`) — client-side disconnects inflate provider/task error stats. (c) Non-streaming requests have no downstream→upstream abort propagation (signal is timeout-only, `proxy.ts:381`): an engine race-loser abort still lets the router complete and record the upstream call (success + cost) that nobody consumes.
*Fix:* distinguish client-abort from upstream failure, wire `c.req.raw.signal` into the upstream fetch, and add the streaming attempt before building the header.

**18. Attribution has no staleness window.** `AttributionService.mostRecent` (`attr.ts:44-50`) returns the last sample ever recorded; a headerless request days later is attributed (and billed) to a long-dead session. *Fix:* expire samples after an idle threshold.

**19. Auto-attach can clobber a concurrent manual attach.** `tryAutoAttach` checks `getWatchdog()` then awaits `engineReachable` (up to 2.5s) before `startWatchdog` (`index.ts:217-230`); a `POST /watchdog/attach` landing in that window gets replaced by the default-URL watchdog (`startWatchdog` stops the previous, `watchdog/index.ts:73-74`). *Fix:* re-check `getWatchdog()` after the reachability probe.

**20. Destructive migration fallback.** `ensureColumns` does `DROP TABLE calls` if `ALTER TABLE` fails (`telemetry.ts:69-78`) — call history is silently lost on a migration hiccup. *Fix:* fail loud instead of dropping.

**21. Doc/contract drift.** `index.ts:48` defaults to port 4098 while AGENTS.md says 4090 (dev.sh and the engine both use 4098, so the doc is stale). Separately, the engine never sends `x-agent-role` on chat calls (no `agentRole` in `ChatParams` usage), so the router's planner/diagnostician L-tier gating and `startTier(role)` are dead code in production.

## Confirmed working (checked and fine)

- **fs jail** (`fs.ts`): lexical+physical containment (`resolveJailed` walks to the deepest existing ancestor and realpaths it), `../` traversal, symlink escapes (file and dir), NUL rejection, root-not-deletable guards on delete/rename, errno→status mapping — all sound and matching `test/fs.test.ts`.
- **SSE passthrough**: upstream bytes piped untouched, trailing `: x-engine-route` comment, usage extraction from stream, `completeStreamedCall` finalizes rows (no stuck `streaming` rows).
- **429 fallback chain**: per-attempt trace+call rows nested under the route trace, body model rewrite to the concrete provider model, `x-engine-route` attached on success.
- **Policy primitives**: classify thresholds/role-cap, cascade escalate/demote, budget finalize/halt boundaries, selectProvider ranking incl. halt free-only — all consistent with `test/policy.test.ts`.
- **Key masking** on `/keys` and POST responses; origin allowlist + CORS `exposeHeaders: x-engine-route`.
- **Stuck-monitor mechanics** (window, repeat-hash ≥3, period-2, error-spam, nudge cooldown, intervention cap, action chain) and **budget-governor transition semantics** — correct versus their own event contract.
- **Symptom 3 direct answer**: the auto-attach retry loop itself is correct — it retries every 30s, stops on success (`clearInterval`), guards re-entrancy, doesn't double-attach, and defaults to the right engine URL (`http://127.0.0.1:4100`), so it does attach once the engine comes up. The real problems are findings 7 (attached watchdog writes to the wrong attribution instance) and 8 (no SSE reconnect if the engine later restarts).
