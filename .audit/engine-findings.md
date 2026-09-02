# Engine Bug Audit — Agent IDE (`/workspace/agent/engine/src`)

Scope: orchestrator.ts, tools.ts, providers.ts, router.ts, context.ts, compaction.ts, sessions.ts, approvals.ts, proposals.ts, apply.ts, actions.ts, chat.ts, terminal.ts, retrieval.ts, types.ts, config.ts (+ index.ts interaction points where orchestrator/tools meet HTTP routes). Read-only; nothing modified.

## Findings

### 1. CRITICAL — Approval gate is dead: no tool ever requires approval
- **Where:** `tools.ts:1057-1066`, `config.ts:60-62`, `types.ts` (AppSettings)
- **What happens:** `write_file`, `edit_file`, `run_command` (arbitrary `bash -c`), `git_commit`, `git_branch` execute with zero human consent, even though TOOL_SPECS and the UI claim "REQUIRES USER APPROVAL". `executeTool` (`tools.ts:1139`) never creates an approval request, never parks at `waiting-approval`; the orchestrator's status flips and deadline refunds (`orchestrator.ts:798-815`) never fire. The entire approvals.ts machinery is unreachable from the tool path.
- **Root cause:**
  ```ts
  const mode = s.approvals?.mode ?? "auto_safe";
  if (mode === "auto_safe") { return false; }
  return (s.requireApprovalFor ?? []).includes(name);
  ```
  `DEFAULT_SETTINGS` ships `approvals: { mode: "auto_safe" }` (config.ts:60-62), and `AppSettings` in types.ts declares no `approvals` field at all — so the mode can never be anything but `"auto_safe"` through the typed settings surface, and `requireApprovalFor: ["write_file","edit_file","run_command","git_commit","git_branch"]` (config.ts:68) is unreachable dead config. The default mode name suggests "auto-approve only safe tools", but the implementation auto-approves everything.
- **Fix:** gate on `sideEffect && requireApprovalFor.includes(name)` by default (or default mode `"strict"`), and add `approvals` to the `AppSettings` type so it can be configured.

### 2. CRITICAL — Second prompt in a session re-executes the OLD plan with the OLD goal
- **Where:** `orchestrator.ts:144-151, 170-176, 183, 302`; exercised by `index.ts:239-311` (POST /api/tasks with existing `sessionId`) and `index.ts:408-434` (watchdog nudge `/api/tasks/:id/message`)
- **What happens:** Send a follow-up prompt to a session whose previous task completed with a plan: the planner is skipped and the entire old plan is re-run step by step against the old `task.goal`; the new user message only leaks in via `pickRelevantMessages`. `task.stepCount` accumulates across prompts, so after enough prompts in one long-lived session every new task fails instantly with "step cap 40 reached".
- **Root cause:** `runTask` creates a task only via `session.task ??= {...}` (no-op when one exists) and plans only `if (!task.plan?.length)`. With an existing plan it falls through to `drive(ctx, Math.max(0, opts?.resumeFromStep ?? 0), …)` → startIdx 0, and `drive`'s loop (`for (let i = startIdx; i < (task.plan?.length ?? 0); i++)`, orchestrator.ts:302) has **no `step.status` check** — already-`done` steps are re-run by `runStep`, which also never checks status.
- **Fix:** on a new user prompt, archive the terminal task and create a fresh one (or at minimum reset `plan`, `stepCount`, `goal`, `tokensUsed`, `costUsd` when the existing task is in a terminal status); alternatively have `drive` skip `done` steps.

### 3. HIGH — Step timeout leaks `runStep`: timed-out steps keep calling LLMs, writing files, and mutating task state
- **Where:** `orchestrator.ts:322-361` (drive), `orchestrator.ts:513-515` (runStep tail), `orchestrator.ts:836-847` (persistRunState)
- **What happens:** When the 480s per-step timeout wins the race, the step is marked failed and the loop continues to the next step — but the losing `runStep` promise is never cancelled. The leaked step keeps running concurrently with its successor on the same session/task object: it spends tokens via `routedLlm`, executes tools (**real file writes land after the step was declared failed**), re-populates `runStates` via `persistRunState` after `runTask`'s `finally` deleted it, and finally calls `saveSession` + `emitTask` (lines 513-515), re-emitting the task with a stale/overwritten status minutes after `finalize` ran. This is the prime suspect for tasks that appear stuck "running": a finalized task gets re-broadcast as running/waiting-approval by the zombie step. If gating were enabled, a leaked `executeTool` would apply an approval decided after the step died (approval timeout 30 min > step timeout 8 min guarantees this race).
- **Root cause:**
  ```ts
  const stepTimeoutPromise = new Promise<never>((_, reject) => { stepTimer = setTimeout(() => reject(new Error(...)), PER_STEP_TIMEOUT_MS); });
  await Promise.race([runStep(...), stepTimeoutPromise]);
  ```
  `Promise.race` cannot cancel the loser; nothing aborts the work behind `runStep`.
- **Fix:** give each step a child `AbortController` chained to `ctx.controller` and abort it when the timeout wins; have `executeTool`/`routedLlm` honor it.

### 4. HIGH — Parallel racing burns up to 3× tokens per call, drops 200-OK losers uncounted, and penalizes healthy models with fail5xx
- **Where:** `orchestrator.ts:1052, 1075-1092, 1116`; `providers.ts:483-486, 524-527, 533-541`; `router.ts:104-111`
- **What happens (three related defects, matching the live symptom "route decision … raced all three … fail5xx penalty right after a 200 OK"):**
  1. `attempts = [decision.modelId, ...decision.fallbacks.slice(0, 2)]` → `chatRace` launches up to **3 staggered full completions for every single LLM invocation** (planner/coder/reviewer/explorer). A 21-turn tool loop can fire ~63 upstream calls for one step. On free-tier keys this burns the shared quota ~3× faster — accelerating the very 429/quota failures the race exists to dodge.
  2. A loser that completes **200 OK** after a winner exists hits `if (winner) return;` (providers.ts:526) and is silently dropped. Its tokens were really consumed upstream, but `accumulateUsage` (orchestrator.ts:1132) only counts the winner — so `task.tokensUsed`/`costUsd` under-count real spend and the `maxTokensPerTask` ceiling is computed on fiction.
  3. The fail5xx-on-200-OK path: an empty/whitespace 200-OK completion throws `new LlmError(\`${slot.modelId}: empty completion\`, undefined, true)` (providers.ts:524). In `onLoser` that is outcome `"error"` with `status === undefined`, and `recordOutcome` treats undefined as 5xx: `else if (status === undefined || status >= 500) h.fail5xx += PENALTY_5XX` (router.ts:108) — plus it is breaker-trippable (`breakerTripWorthy(undefined) === true`). One empty reply from a healthy model demotes it router-wide for ~minutes.
- **Fix:** race only the primary, falling back on observed error (or keep racing but count completed losers' usage into the task budget); never map empty/aborted/client-error outcomes onto the 5xx health bucket.

### 5. HIGH — Crash-resume is unreachable: boot reconcile and the resume predicate disagree; `bootInterrupted` is never written
- **Where:** `sessions.ts:57-67`; `orchestrator.ts:221-227`; boot call at `index.ts:1244`
- **What happens:** A process crash mid-step leaves `task.status === "running"` on disk. At boot, `reconcileBootSessions()` flips it to `"stopped"`. But `resumeAfterApproval`'s resumable predicate is:
  ```ts
  const resumable = t.status === "waiting-approval"
    || ((t.status === "planning" || t.status === "running" || t.status === "reviewing") && !!rs)
    || (t.status === "failed" && bootInterrupted && !!diskRs);
  ```
  `"stopped"` is not resumable, and `bootInterrupted` is only ever **read** (orchestrator.ts:221) — nothing in the repo ever writes it. So after any crash, `POST /api/tasks/:id/resume` silently no-ops and the persisted `runState` crash-anchor machinery (persistRunState → `task.meta.runState`) is dead for its main use case.
- **Fix:** in `reconcileBootSessions`, set `task.meta.bootInterrupted = true` and mark status `failed` (or add `"stopped" && diskRs` to the resumable predicate).

### 6. HIGH — `saveSession` is non-atomic; a crash mid-write corrupts the session out of existence
- **Where:** `sessions.ts:95-102` (saveSession), `sessions.ts:46-53` (listSessions swallow), `proposals.ts:26`, `approvals.ts:60`
- **What happens:** `saveSession` does a direct overwrite: `fs.writeFileSync(path.join(dir, \`${session.id}.json\`), JSON.stringify(session, null, 2))` — no tmp-file + rename. It is called on every LLM call and tool result via `persistRunState` (orchestrator.ts:836-847), which embeds up to 24 × 12 KB `partialMessages` in `task.meta.runState`, so large high-frequency writes are routine. A kill/crash mid-write leaves truncated JSON; `getSession`/`listSessions` swallow the parse error (`catch { return null }`) — the session simply vanishes from the UI and from `findSessionAny`. Same non-atomic pattern corrupts `proposals.json` and `approvals.json`; a corrupt `proposals.json` additionally falls back to the (empty after restart) in-memory map, silently losing persisted proposals.
- **Fix:** write to `<file>.tmp` then `fs.renameSync` (atomic on POSIX); on read, keep the last-good copy instead of returning null.

### 7. HIGH — "Accept all" applies NOTHING to modified files
- **Where:** `apply.ts:133-138` vs `apply.ts:195`; callers `index.ts:757` and `index.ts:816`
- **What happens:** `POST /api/proposals/:pid/resolve_all` calls `applyProposalPartial(p, root, undefined, false)` (index.ts:816) and `POST /api/proposals/:id/apply` passes `body.acceptedHunks ?? {}` (index.ts:757). With no explicit selection, `allAccepted = !rejectAll && wanted.size === 0` is true. The `added`/`deleted` branch honors it (`const accepted = allAccepted || wanted.has(h.hunkIndex)`, apply.ts:149), but the `modified` branch checks only `const accepted = wanted.has(h.hunkIndex);` (apply.ts:195). So for modified files every hunk is skipped, `appliedCount === 0`, and the proposal is labeled `partially-applied` while nothing landed. Added/deleted files work, so the bug is file-type dependent and easy to miss in testing.
- **Fix:** use `allAccepted || wanted.has(h.hunkIndex)` in the modified branch too.

### 8. HIGH — TOOL_CALL text protocol: quoted JSON in prose becomes an executable tool call
- **Where:** `actions.ts:319-446` (extractAllActions), `orchestrator.ts:705-709, 766` (extractToolCalls/toolLoop)
- **What happens:** `extractAllActions` has a last-resort branch (actions.ts:430-446) that scans the whole text for *any* balanced JSON object containing a `name`/`tool`/`action` key and treats it as a tool call. A model reply that merely *quotes* such JSON — e.g. explaining the tool-call format, showing a config example `{"name":"write_file","args":{...}}`, or echoing a prior TOOL_RESULT — gets executed. Because `toolLoop` only skips extraction when a `FINAL:` marker is present (`const calls = finMatch ? [] : extractToolCalls(text)`, orchestrator.ts:766), any reply without `FINAL:` that contains such JSON triggers real tool execution. Combined with finding #1 (dead approval gate), quoted JSON can drive `write_file`/`run_command` with no human in the loop. Secondary fragility: sections 2 and 3 (XML/DSML salvage) run even when section 1 already matched, and there is no early return until line 428, so mixed-format output can yield duplicate actions.
- **Fix:** only honor the raw-JSON fallback when the text actually begins with/intends a call (e.g. anchored at a TOOL_CALL marker or start-of-message), and return immediately after the first successful section.

### 9. MEDIUM — `isTrivial` is too strict: imperative micro-tasks never qualify (symptom 1)
- **Where:** `orchestrator.ts:1311-1317`
- **What happens:** "Say hello and nothing else" is not a question, so `QUESTIONISH` (anchored to what/why/how/…) fails and there is no `?`; `isTrivial` returns false and the request goes to the planner, which invents a plan step like "Create hello output script", whose coder then burns retries on 503-ing models. Triviality is defined purely as "interrogative", so short imperative asks ("reply OK", "say hi", "print hello") always take the full PLAN→EXPLORE→EXECUTE pipeline. Conversely `CODE_INTENT` is over-broad (`add|build|test|move|port|convert|extend|patch|config|…` as bare words), so genuine questions like "how do I add a header?" or "what does the build output mean?" are *also* denied the trivial path.
- **Root cause:**
  ```ts
  return !CODE_INTENT.test(text) && (QUESTIONISH.test(text.trim()) || /\?/.test(text)) && text.trim().split(/\s+/).length <= 60;
  ```
- **Fix:** also treat very short imperative requests (e.g. ≤ ~8 words, no file/path/URL token, no CODE_INTENT verb acting on a repo noun) as trivial; tighten CODE_INTENT to verbs with code-ish objects.

### 10. MEDIUM — Resume off-by-one: an interrupted attempt is double-counted; `stepCount` double-incremented
- **Where:** `orchestrator.ts:413-415` (runStep), `orchestrator.ts:836-847` (persistRunState)
- **What happens:** `runStep` computes `const attempts = resume ? resume.attempts + 1 : step.attempts + 1;` then immediately writes back `step.attempts = attempts` and `task.stepCount++`. `persistRunState` stores `attempts: task.plan?.[task.currentStep]?.attempts ?? 1` — the **already-incremented** value. After a crash/approval resume, `resume.attempts + 1` increments it **again**, so one interrupted attempt counts as two. Two crashes during one step hit `STEP_ATTEMPTS_MAX = 3` and force a replan for work that actually had one real attempt. `task.stepCount++` on every entry (including resume) similarly double-counts against `MAX_STEPS = 40`.
- **Fix:** persist the attempt count *before* incrementing, or on resume reuse `resume.attempts` (the interrupted attempt is retried, not added).

### 11. MEDIUM — 400→503 remapping bypasses the breaker's "client errors never trip" protection
- **Where:** `orchestrator.ts:1088-1089` (onLoser `blameModel`), `chat.ts:136`, `providers.ts:452` (chatSweep)
- **What happens:** The router's health model explicitly says plain 4xx should not hurt a model ("a 401 is a config problem, not the model being unhealthy", router.ts:82-84) and `breakerTripWorthy` excludes 400/401/403. But three callers remap vague 400s to 503 before recording: `recordOutcome(modelId, false, latencyMs, blameModel ? 503 : status)` where `blameModel = status === 400 && !/client-blame regex/` (orchestrator.ts:1088-1089), `status === 400 ? 503 : status` (chat.ts:136, providers.ts:452). A request-level 400 the engine itself constructed (bad payload, oversized context) therefore poisons the model's 5xx health and can trip the breaker that was designed to ignore it.
- **Fix:** record the true status and express "model-side blame" through a separate signal instead of forging 503.

### 12. MEDIUM — Per-file `hunkIndex` vs global `hid`: accepting a hunk can apply the wrong file's hunk
- **Where:** `apply.ts:89` (parseUnifiedPatch numbers hunks per file from 0), `index.ts:772-801` (PATCH /api/proposals/:pid/hunks/:hid)
- **What happens:** The granular accept route treats `hid` as globally unique and finds the first file whose hunks contain `hunkIndex === hid`, then `break`s. But `hunkIndex` restarts at 0 for every file, so in any multi-file proposal "accept hunk 0 of file 2" actually applies hunk 0 of file 1.
- **Fix:** key hunks by `path + hunkIndex` (or assign globally unique ids when building the proposal).

### 13. MEDIUM — Path containment is lexical-only: symlink escape from the project root
- **Where:** `tools.ts:202-219` (resolveInRoot), `tools.ts:447-457` (readTextFile), `tools.ts:737-748` (write_file), `tools.ts:633-650` (edit_file)
- **What happens:** `../` traversal is correctly blocked (`path.resolve` normalizes it, then the `rootAbs + path.sep` prefix check rejects escapees), and absolute paths are re-rooted or rejected. But there is **no `realpath` resolution**: a symlink inside the project pointing outside (e.g. `link -> /etc`, created earlier by an approved `run_command` or pre-existing) passes the prefix check as `<root>/link/passwd`, and `readFile`/`writeFile` then follow the symlink — reading or writing outside the jail. `collectFiles`/`list_dir` skip symlinks during *walks*, so discovery won't enumerate through them, but direct `read_file`/`write_file`/`edit_file` on a symlinked path escapes. Same gap in `apply.ts:39-42` and `fsops.ts:13-16` (both lexical-only).
- **Fix:** after resolving, `fs.realpathSync` the target (and each existing parent) and re-check containment before I/O.

### 14. MEDIUM — `responseFormat: "json"` is accepted but never sent to the API
- **Where:** `providers.ts:251` (ChatParams), `providers.ts:334-341` (request body), callers `orchestrator.ts:903, 948, 1081`
- **What happens:** Planner and reviewer calls pass `responseFormat: "json"`, but the `chat()` request body only serializes `model`, `messages`, `temperature`, `max_tokens` — `response_format` is never included. JSON mode is silently dropped; correctness rides entirely on the prompt plus `parseJsonLoose` salvage. Not a crash, but the feature is dead and the planner's JSON failures (seen in the "planner JSON unparseable — repairing" traces) are more frequent than they need to be.
- **Fix:** add `response_format: { type: "json_object" }` to the body when `params.responseFormat === "json"` (guard for providers that reject it).

### 15. MEDIUM — Token usage is read only from the response `usage` field; missing usage → 0 → budget caps never trip
- **Where:** `providers.ts:397-405` (chat), `providers.ts:627` (chatStream), `orchestrator.ts:67-76` (budgetOver), `orchestrator.ts:1132-1156` (accumulateUsage)
- **What happens:** The live symptom `tokensIn:0 tokensOut:0` on a successful 200 call comes from `tokensIn = json.usage?.prompt_tokens ?? 0` / `tokensOut = json.usage?.completion_tokens ?? 0`. When the upstream (the :4098 router proxy or a free endpoint) omits `usage` — common on streamed or proxied free-tier responses — the engine records zero. `accumulateUsage` then adds nothing to `task.tokensUsed`, so `budgetOver`'s token ceiling (`maxTokensPerTask`, default 400k) is computed on fiction and never trips; cost stays $0. There is no fallback to the `estTokens` heuristic the codebase already has.
- **Fix:** when `usage` is absent/zero, estimate from `estTokens(prompt)` / `estTokens(text)` and mark it estimated.

### 16. MEDIUM — Compactor is constructed without a summarizer: T2 is dead, long sessions fall through to a destructive T3 that loses the goal
- **Where:** `orchestrator.ts:424-425` (`new Compactor()` — no `summarizerFn`), `compaction.ts:646-660` (T2 degrade), `compaction.ts:679-687` (T3), `compaction.ts:538-540` (T3 goal)
- **What happens:** The only production call site builds `new Compactor()` with no summarizer, so the LLM-summary tier (T2) degrades to T1.5 amortized forgetting. If T1.5 can't drop enough (turns ≤ `forgetTriggerTurns`), `maybeCompact` escalates to the T3 emergency rebuild, which rebuilds context from system + keystone + last turn with an **empty** `taskState` — emitting "Goal: (unknown goal)" and discarding the real task goal and history. So a long session that crosses the trigger can have its transcript gutted and its goal replaced with "(unknown goal)". Separately, the entire `maybeCompact` in `context.ts:486-617` (a different, LLM-based implementation) is imported by the orchestrator but never called — dead code.
- **Fix:** wire a real summarizer into the Compactor (or pass task state into T3), and delete or wire the unused `context.ts` maybeCompact.

### 17. MEDIUM — `run_command` timeout kills only the direct child; grandchildren survive
- **Where:** `tools.ts:332-375` (runProcess)
- **What happens:** Commands run via `bash -c`. On timeout the code does `child.kill("SIGKILL")` on the shell process only — no process group (`detached: true` + `process.kill(-pid)`), so anything the shell spawned (`sleep 1000 &`, a build, a fork) keeps running after the tool reports a timeout. Repeated timeouts can accumulate orphan processes.
- **Fix:** spawn with `detached: true` and kill the whole process group (`process.kill(-child.pid, "SIGKILL")`).

### 18. MEDIUM — Every race slot is capped at 45s; a slow-but-healthy model can never win
- **Where:** `providers.ts:486` (`maxSlotMs ?? 45_000`), `providers.ts:505-509` (slot timer)
- **What happens:** `chatRace` aborts each slot after 45s regardless of role. A coder call with `maxTokens=2200` on a slow free model that legitimately needs 60s gets all three slots aborted → race fails → re-route round → sweep → the step fails even though a capable model would have answered given time. The per-call `CHAT_TIMEOUT_MS=180s` is fused but the 45s slot always wins.
- **Fix:** make `maxSlotMs` role-aware (larger for coder/reviewer) or escalate the slot cap on the second routing round.

### 19. MEDIUM — Last-resort sweep ignores operator-disabled models
- **Where:** `providers.ts:421-422` (chatSweep pool filter)
- **What happens:** Normal routing honors `settings.disabledModels`, but `chatSweep` builds its pool from `registry.list()` filtered only by `enabled` — it can call a model the operator explicitly switched off in Settings. It also doesn't consult the breaker's open state (only `effectivePenalty >= 2.0`).
- **Fix:** apply the same `disabledModels` exclusion (and breaker state) in the sweep.

### 20. MEDIUM — Advertised chat/side-question features are unwired dead code
- **Where:** `chat.ts:57-170` (runChat), `index.ts:23-26` (imports only), `prompts.ts:94` (BYTHEWAY_PROMPT), `providers.ts:570-636` (chatStream)
- **What happens:** `runChat` (the composer Chat mode) is imported but never bound to any route; `BYTHEWAY_PROMPT` is imported but unused; `chatStream` is never called. The orchestrator filters history on `m.meta?.bytheway` (orchestrator.ts:535, 685) but nothing ever sets that flag. So the "/bytheway side-question path" and Chat mode simply don't exist at the engine API layer. Bonus latent bug in the dead `chatStream`: on `data: [DONE]` it `return`s without calling `onMeta`, so usage metadata is lost on the normal completion path.
- **Fix:** wire `runChat`/bytheway to routes (or remove), and call `onMeta` before returning on `[DONE]`.

### 21. MEDIUM — Crash-resume loses the step context; explore-phase state can resume as coder context
- **Where:** `orchestrator.ts:836-847` (persistRunState `partial.slice(-24)`), `orchestrator.ts:238` (resumeAfterApproval drive), `orchestrator.ts:744` (explore persist)
- **What happens:** `persistRunState` keeps only the last 24 messages, each clipped to 12k chars. The system prompt and the step-context user message (carrying `__sys` and the STEP/CONTEXT/RULES block) are the *first* messages, so a long tool loop pushes them out of the window; a crash-resume then rebuilds `msgs` without the step instructions or role prompt (`sys = seed[0]?.__sys ?? generic`). Also, `RunState.phase` ("explore" vs "step") is persisted but `resumeAfterApproval` ignores it and just drives from `stepIndex` — a crash during the explore phase persists `stepIndex 0`, so resume replays explore's seed messages as step 0's coder context.
- **Fix:** always pin the system + step-context messages in the persisted window (not just `slice(-24)`), and honor `RunState.phase` on resume.

### Low-severity findings

**22. LOW — Duplicate assistant message in toolLoop on disallowed-tool rejection.** `orchestrator.ts:780` pushes `{role:"assistant", content:text}` once before the call loop, then `orchestrator.ts:792-793` pushes the same text again for each call rejected by `allowedTools`. Duplicate assistant turns confuse the text protocol on subsequent turns. Fix: push the rejection note only, not the whole text again.

**23. LOW — Gated-tool deadline refund over-refunds.** `orchestrator.ts:813`: `ctx.deadline += Date.now() - t0` refunds the *entire* gated tool duration (including post-approval execution), not just the approval wait. Latent while the gate is dead (finding 1). Fix: record the wait interval only.

**24. LOW — `grep` tool has no ReDoS guard.** `tools.ts:549-575`: a model-supplied regex (≤500 chars) is compiled and run with `re.test(line)` over file lines with no timeout — `(a+)+$`-style patterns can hang the event loop. Fix: run in a worker with a time budget (as the standalone regex tool does).

**25. LOW — Terminal `resize()` is a no-op.** `terminal.ts:97-104` stores `cols`/`rows` but never signals the PTY (no SIGWINCH/ioctl), so the shell never actually resizes.

**26. LOW — Registry "dynamic discovery" is dead.** `providers.ts:230-234`: `refresh()` only re-seeds `NATIVE_MODELS` × configured providers; `fetchProviderModels`, `loadModelsDevCatalog`, `specFromEndpointAndCatalog` and models.dev enrichment are never called despite the module header advertising them. `/models` endpoint discovery never happens.

**27. LOW — Unbounded/stale per-task and per-session maps.** `orchestrator.ts:55-59`: `textHist`, `toolHist` (keyed by task id) and `lastErrors`, `currentStepRefs` (keyed by session id) are never cleaned up in `finalize` — slow memory leak across tasks, and `lastErrors` feeds the router's 429-dodge with errors from long-past tasks.

**28. LOW — T2 compaction ordering + toothless integrity probe.** `compaction.ts:503`: the summary message is appended *after* the kept recent turns (chronology inverted); `integrityProbe` (compaction.ts:505-518) checks protected lines against `kept + summary`, but `kept` already contains the system/keystone messages by construction, so the probe passes regardless of the summarizer's output.

**29. LOW — Sweep success double-recorded in health.** `providers.ts:442` records success inside `chatSweep`, and `orchestrator.ts:905` (`sweepLastResort`) records it again — two samples for one call skew the breaker's failure-rate window and latency EMA.

**30. LOW — `parseUnifiedPatch` can drop a real trailing empty context line.** `apply.ts:103` (`rows.pop()` when the last row is `""`) assumes the final element is the split artifact; but git-derived chunks pass through `chunkByPath`'s `chunk.trim()` (`orchestrator.ts:1230-1247`), which strips the trailing newline — if the last hunk line is an empty context line, it is popped instead, shifting review display/apply by one line.

**31. LOW — `run_command` preflight/handler key mismatch.** `tools.ts:460` preflight requires `str(args, "command")`, but the handler also accepts a `cmd` key (`tools.ts:1173` area, `optStr(args,"command","") || optStr(args,"cmd","")`). With the approval gate enabled, a `cmd`-keyed call would fail preflight with "missing required argument". Latent while the gate is dead.

**32. LOW — Whitespace-trimmed fuzzy line equality can mis-anchor hunks.** `apply.ts:253-255` (`fuzzyLineEq` trims) lets drift search match lines that differ only in indentation — in indentation-sensitive code (Python) this can splice at the wrong line. Documented tradeoff, but worth a stricter mode when the strict walk already matches.

**33. LOW — Startup probe penalizes unknown-status failures as 503.** `router.ts:814`: `err?.status || (err?.name === "AbortError" ? 504 : 503)` — an `LlmError` with `status === undefined` (e.g. empty completion during probe) is recorded as 503, consistent with finding 4's health-poisoning pattern.

**34. LOW — `runTask` budget-exceeded early return is silent.** `orchestrator.ts:156-157`: if the *previous* task exhausted the budget, a new prompt returns `{done:false, reason:"budget cap exceeded"}` before creating a controller or emitting anything — the HTTP route still answers `ok:true` and the UI shows nothing. (Interacts with finding 2: budget/usage persist across prompts because the task is reused.)

**35. LOW — Watchdog nudge never reaches a running task.** `index.ts:408-434`: `POST /api/tasks/:id/message` appends the message to `session.messages`, but if the task *is* running nothing injects it into the active tool loop — the nudge only lands in history for the next run (which, per finding 2, re-runs the old plan). The AGENTS.md nudge contract is only half-met.

## Confirmed working

- **`../` and absolute-path traversal are blocked** in `resolveInRoot` (tools.ts:202-219): `path.resolve` normalizes traversal, and the `rootAbs + path.sep` prefix check is sibling-safe (`/workspace/agent-evil` does not pass for root `/workspace/agent`); absolute paths outside the root are re-rooted or rejected. Same sibling-safe `inRoot` in apply.ts:39-42 and fsops.ts:13-16.
- **Concurrent double-run per session is prevented**: `runTask` throws when `controllers.has(sessionId)` (orchestrator.ts:141), the route 409s on `isRunning` (index.ts:270), `resumeAfterApproval` no-ops (orchestrator.ts:211); there is no `await` between check and `controllers.set` in either entry path, so two quick prompts cannot both start.
- **Approval decide/wait machinery is race-safe** (approvals.ts): `decideApproval` is idempotent (`if (req.status === "pending")` guard), `awaitDecision` has a settle-once `finish`, caller abort resolves as `decidedBy:"aborted"` instead of parking, the 30-min timer auto-denies, and boot reload auto-denies stale persisted pendings.
- **Budget guards are checked at task start, per step, and mid-call** (orchestrator.ts:156, 314-318, 1064-1065); when every fallback 503s, `routedLlm` throws after 2 rounds + sweep, `drive` marks the step failed and continues, and an all-failed plan finalizes as `"failed"` — it does not loop forever or fake `"done"` (the task-level outcome is correct even though it takes a long time, findings 4/18).
- **Stuck detection is graded and bounded**: repeat-fail/repeat-text/step-attempts triggers replans capped at `MAX_REPLANS = 3`, steps at `MAX_STEPS = 40`, attempts at `STEP_ATTEMPTS_MAX = 3`.
- **Caller abort propagates cleanly**: `stopTask` aborts the controller; `chatRace` maps caller-abort to a DOMException (not a health penalty — aborted race losers are classified `"aborted"` and ignored by `onLoser`), `toolLoop` checks the signal at loop top and before each tool, and `handleError` finalizes as `"stopped"`.
- **`edit_file` ambiguity guard**: `oldText` absent → error; `count > 1 && !replaceAll` → error (tools.ts:643-648); empty `oldText` rejected.
- **Circuit breaker core is sound**: 400/401/403 never trip it (`breakerTripWorthy`), a sole enabled model degrades instead of opening, half-open probes restore, cooldown doubling is capped.
- **Trace ids are unique across restarts** (trace.ts:26-35, monotonic epoch-based), and **deleted sessions don't resurrect** via the tombstone set (sessions.ts:85-96).
- **`buildFileDiff`/apply hardening**: ground-truth `noTrailingNewline`, synthetic whole-content hunk for degenerate diffs, idempotent re-apply detection (apply.ts:219), and drift correction that re-derives both offset and splice anchor.
- **Planner JSON salvage**: `parseJsonLoose` + one repair attempt + a single-step fallback plan (orchestrator.ts:548-557) means a malformed planner reply degrades instead of killing the task.
- **Quota backoff is deadline-aware** (orchestrator.ts:960-1002: refuses waits that would cross the task deadline, re-checks abort after waiting), and context-overflow errors jump straight to the largest-context model.
- **run_command defense-in-depth** (given the gate is the real control): env scrubbing to a whitelist, catastrophic-command blocklist, `rm` root-target detection, git branch name validation; `collectFiles`/`list_dir` skip symlinks during walks; read/grep size caps.
