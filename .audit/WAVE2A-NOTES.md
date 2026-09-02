# Wave 2A — Engine contract/hardening fixes (index.ts, chat.ts, terminal.ts, logger.ts)

Scope: ONLY `engine/src/{index,chat,terminal,logger}.ts` were modified. All other
engine files (orchestrator, tools, apply, providers, sessions, actions, fsops,
compaction, context, config, types, proposals, router, prompts, rules,
retrieval, repomap, bus, trace) were READ-ONLY for this wave — another agent
owns them.

## Items

### 1. B24 — DEFAULT_MODELS ReferenceError
- `DEFAULT_MODELS` is exported by **config.ts:24** (verified by grep — NOT
  providers.ts as the prompt guessed). Added it to the existing config import
  (`index.ts:13`). GET/PUT /api/settings can no longer throw ReferenceError
  when settings lack `models`.

### 2. B25 — settings key leak + key clobber
- GET /api/settings (`index.ts` ~150): `api_key`/`apiKey` are now ALWAYS
  `"••••••••"` when a key is set, `""` when absent (previously returned the
  RAW key when `api_key` was set). `has_key` unchanged.
- PUT /api/settings (~175): masked (`••…`) or empty incoming key = "keep
  existing". Old provider matched by id/name (covers renames) with baseUrl as
  tiebreaker, falling back to baseUrl-only match (covers id/name changes).
  No match + no incoming key → `""` — never invents `"sk-engine-key"`.
  Router key-forwarding loop unchanged and still works (keys are real post-merge).

### 3. B18 — missing endpoints wired (all were 404)
- `POST /api/bytheway` (after POST /api/tasks, ~380): resolves/creates the
  session exactly like POST /api/tasks (projectId → registered root; else
  path/currentProjectRoot; defensive cross-project sessionId lookup), runs
  `runChat(session, root, text, refs)`, returns
  `{ ok:true, answer, messageId, model, modelId, model_key, sessionId }`
  (aliases for web's defensive reader). Thrown LLM failure → `502 { error }`.
- `GET /api/index/status` (~290): per-project `{ root, files, chunks, indexedAt }`
  map over all registered projects + `currentProjectRoot`/`currentProjectId`.
- `POST /api/index/rebuild` (~305): **uses `buildIndex(root, pid)`** — the real
  signature of `ensureFresh(root, pid)` has NO `{force}` option; `buildIndex`
  IS the unconditional rebuild (re-walk/re-chunk/re-persist). Returns
  `{ ok, projectId, root, files, chunks, ms }`.
- `GET /api/websearch?query=…` (~1330): **mirrored approach** — the tools.ts
  `web_search` handler is module-private (reachable only via `executeTool`,
  which would drag in session/trace/approval machinery), so the DDG HTML
  fetch+parse logic (same UA, regexes, `uddg` unwrap, entity decode, 6-result
  cap) is replicated locally. Returns a JSON **array** of
  `{ title, url, snippet }` (web's `searchWeb` expects an array).
- NOT implemented (deliberate ponytail decision, web UI removed):
  `/api/tasks/:id/pause`, snapshot endpoints.

### 4. B26 — chat.ts breaker bypass
- `chat.ts:136` area: `recordOutcome(modelId, false, latencyMs, status)` —
  passes the REAL status; the breaker's 4xx exemption now works for chat-race
  losers. (The other two B26 sites — orchestrator.ts:1088, providers.ts:452 —
  are in the other agent's files; skipped per scope.)

### 5. B36/B37 — terminal + editor save-conflict
- `POST /api/term`: accepts `projectId` from **query string OR body**
  (fallback `"default"`); root fallback chain now includes
  `currentProjectRoot` (same fix applied to the WS upgrade handler).
- `terminal.ts resize()`: no longer a no-op. We hold pipes into
  `script -qfc` (it owns the pty master — no fd to ioctl), so resize writes
  `stty cols C rows R\n` into the shell's real pty: stty applies TIOCSWINSZ
  and the kernel dispatches SIGWINCH to the foreground pgrp; SIGWINCH to
  `script` is belt-and-braces. Cols/rows clamped to sane ranges. Documented
  edge case: a foreground fullscreen app receives the stty line as input
  (accepted until node-pty).
- Terminal SSE (`GET /api/term/:projectId/stream`): **single subscribe** —
  `term.subscribe` registers the listener and captures the ring in one
  synchronous step; the replay frame is enqueued FIRST through a
  per-connection promise chain, so nothing emitted before/after connect is
  dropped and frames never interleave. Race-free 404 via new `term.exists()`
  probe (replaces the old subscribe→unsubscribe→resubscribe pattern).
- `handleFileWrite` (POST/PUT /api/files/write): honors `expected_mtime` —
  stat first; on mismatch → `409 { error:"mtime mismatch", current_mtime,
  current }` (current = on-disk content ≤4000 chars, matches web's
  editor-store contract). Success → `{ ok:true, bytes, mtime: newMtimeMs }`.
  mtimeMs round-trips exactly through JSON, strict equality is sound.

### 6. B17 — /api/run hardening
- **(a) raw caller-supplied `cmd` support REMOVED** → 400 with explanation.
  Decision: the approval machinery is NOT trivially available from index.ts —
  the full gate (preflight, proposal lifecycle, awaitDecision) lives in
  tools.ts (read-only this wave), and routing through `executeTool` would
  need a fabricated sessionId and could park an HTTP request for up to the
  30-min approval timeout. Full approval gating of custom commands is
  **deferred to the contract wave** (belongs on the run_command tool gate).
  Documented in the endpoint's block comment.
- **(b) scrubbed env**: local `scrubRunEnv()` — whitelist
  PATH/HOME/SHELL/USER/LANG/LC_ALL/TERM/TMPDIR, minus any name matching
  KEY/TOKEN/SECRET (mirrors tools.ts scrubEnv; no longer `env: process.env`).
- **(c) buffer caps**: stdout and stderr each capped at 1 MB
  (`RUN_STREAM_CAP`); response text still clipped to 20 KB as before.
- Interpreter-by-extension table, preview path, timeout clamp unchanged.

### 7. Phase 6 hardening
- Single `app.use("/api/*", …)` middleware registered **before all routes**:
  - Origin guard first: POST/PUT/PATCH/DELETE /api/* with an Origin/Referer
    header must be http(s)://127.0.0.1|localhost with port 4444/5173/4100/4098,
    or the same host as the request → else `403 { error:"origin not allowed" }`.
    No Origin/Referer (curl, router, watchdog) → allowed.
  - Then bearer auth: when `ENGINE_API_TOKEN` is set (non-empty), all mutating
    /api routes require `Authorization: Bearer <token>` (timing-safe compare)
    → else `401 { error:"unauthorized" }`. `/api/health` exempt. Env unset =
    auth fully off (default).
- `GET /api/fs/list`: default path is now `currentProjectRoot` (not
  process.cwd()/home); the `home` field is gone from the response; unused
  `node:os` import removed.

### 8. SSE DTO hygiene (BUG-REPORT §5)
- `sseHandler` builds the DTO EXPLICITLY:
  `{ id, taskId, sessionId, ts, type, payload }` — the `...e` spread after
  computed fields is GONE, so growing wire shapes can't clobber id/type.
- `wireIdentity()` extracts sessionId from every WireEvent variant
  (sessionId / session.id / event.sessionId / approval.sessionId /
  proposal.sessionId / task.sessionId); taskId keeps the historical
  resolution order (sessionId → task.id → raw id).
- Writes are sequential per connection: a per-connection promise chain
  (`enqueue`) serializes event frames AND pings — no interleaving under
  backpressure. Same pattern applied to the terminal SSE stream.
- `sseEventSeq` id source intentionally kept (contract wave replaces it).
- Verified compatibility: wave-1 web (`useTaskStream.ts`, `stores/chat.ts`)
  reads `ev.payload.*` + top-level `id/type/taskId/sessionId` only — the new
  envelope matches exactly.

### Extra: pre-existing strictness errors fixed in index.ts
tsc (noUncheckedIndexedAccess) flagged latent issues inside index.ts that had
to be fixed to reach zero errors in this wave's files: regex-group indexing
in `toProposalDtos` (`match[1]!/match[3]!`), `split("_")[0] ?? ""` in the
three proposal routes, and `new Promise<Response>(…)` typing for /api/run.
No behavior change.

## Verification
- `bunx tsc --noEmit` (engine): **0 errors in index.ts / chat.ts /
  terminal.ts / logger.ts**. 33 errors remain, ALL in the other agent's
  in-flight files: apply.ts(4), context.ts(6), orchestrator.ts(17),
  retrieval.ts(1), tools.ts(2), test_engine.ts(3).
- `bun build src/index.ts --target=bun --outfile=/tmp/engine-2a-check.js`:
  **OK** (64 modules bundled, 0.43 MB, exit 0).
- Server NOT started and `bun test` NOT run, per wave instructions.

## Skipped / deferred
- `/api/tasks/:id/pause` + snapshot endpoints — deliberate ponytail decision
  (web UI removed), per instructions.
- Full approval gating for /api/run custom commands — deferred to the
  contract wave; raw cmd dropped in the meantime (see item 6).
- B26 remap sites in orchestrator.ts:1088-1089 and providers.ts:452 — other
  agent's files.
- No new npm dependencies added.
