# Wave 2B — ENGINE event-contract layer (index.ts, bus.ts, trace.ts, events.ts + minimal wiring)

Scope owned: `engine/src/{index,bus,trace,events}.ts` (events.ts NEW) + minimal
wiring in `orchestrator.ts, chat.ts, providers.ts, types.ts` (proposals.ts /
apply.ts ended up needing NO changes). Nothing from wave 1 / wave 2a was undone.

## Verification at completion (from /workspace/agent/engine)
- `bunx tsc --noEmit` → **0 errors**.
- `bun test` → **95 pass / 0 fail across 11 files** (69 pre-existing + 4 from a
  concurrent agent's retrieval.test.ts + 22 new wave-2b tests: events.test.ts
  ×10, hunks-route.test.ts ×5, tasks-route.test.ts ×2, _env.ts port shim).
- `bun build src/index.ts --target=bun --outfile=/tmp/engine-check.js` → OK
  (65 modules, 0.45 MB).
- Boot smoke (port **4101** — a live engine already owns 4100 and the router
  owns 4098; isolated `ENGINE_DATA=/tmp/engine-smoke-data`): health OK →
  POST /api/tasks → real LLM task ran to `done` via the router → events
  endpoint + SSE verified → server killed, rebooted on same data dir →
  journal backfill verified → killed again. No lingering processes.

## Bug id → change map

### B4 — single id space (NEW `events.ts`, trace.ts, index.ts)
- `trace.ts` exports the id source: `nextEventId()` (SAME counter as trace ids
  → frames and trace events can never collide), `floorEventId(floor)` (bump
  after loading persisted rows), `currentEventId()` (watermark), and
  `TRACE_ID_EPOCH`.
- `events.ts`:
  - `startEventStore()` — idempotent; registers the trace→wire bridge +
    wire-bus stamper EXACTLY ONCE (called from index.ts before serve()).
  - Every WireEvent stamped to an `EventFrame`
    `{ id, taskId, sessionId, ts, type, payload }` (payload = the original
    WireEvent; trace frames carry the TraceEvent at `payload.event`).
  - Identity = wave-2a `wireIdentity` semantics moved verbatim (taskId keeps
    the historical sessionId → task.id → raw id order; B20: status/task frames
    always carry both ids — smoke-asserted on all 61 frames).
  - Per-session ring buffer (cap 2000) + append-only JSONL journal
    `DATA_DIR/projects/<sid>/events.jsonl`. `session`/`token` frames are
    live-only (not journaled — large snapshots with no backfill value; web
    ignores them). Journal is append-only/unbounded like traces.jsonl; loads
    read the tail 2000 and dedupe BY id against the live ring; id floor is
    bumped past everything loaded (restart-safe even under clock skew).
  - `eventStore.all(sid)` / `.since(sid, id)` / `.watermark()` / `.subscribe()`.
- `index.ts` sseHandler: `sseEventSeq` GONE — SSE now subscribes to
  `eventStore` frames and writes them verbatim (the pinned DTO). Explicit-DTO
  hygiene from wave 2a preserved (frames are built explicitly in events.ts).
- Restart backfill is REAL (journal), not synthetic replay; verified across a
  reboot (74 frames restored ascending; post-restart ids continued ABOVE the
  restored watermark).

### B3 — GET /api/tasks/:id/events (index.ts + events.ts builders)
- Matches session id OR current task id OR any `pastTasks[].id`; honors
  `?since=<id>` (id > since), ascending sort.
- Rows = ring/journal frames + synthetic frames for history NOT in the ring:
  - `syntheticMessageFrames`: rebuilt from `session.messages`, deduped by
    message id against ring frames; derived id = `message.at - TRACE_ID_EPOCH`
    (same numeric space → naturally BELOW the live watermark and interleaves
    chronologically by `at`); deterministic collision bump keeps dedupe-by-id
    sound.
  - `syntheticTraceFrames`: pre-wave-2b traces from traces.jsonl get their OWN
    trace id as frame id (shared counter → correct chronological slot, no
    collision); deduped by `payload.event.id`.
- Reload with since=0 restores the FULL conversation (web useTaskStream heal).

### B1/B2 — trace→wire bridge (events.ts, orchestrator.ts, chat.ts)
- Bridge `trace.subscribe(e => wire.emit({type:"trace", event:e}))` registered
  once in `startEventStore()`.
- REMOVED manual mirrors: orchestrator.ts `emit()` no longer does
  `wire.emit({type:"trace"})` nor the route re-emit; chat.ts `emit()` likewise
  (both keep `trace.emit`). RouteDecision import kept (still used by routing).
- type:"route" frames are DERIVED in events.ts when a trace kind==="route"
  arrives whose `input` is a RouteDecision (modelId+reason validated); the
  derived frame gets the next id so order stays trace→route. Smoke run showed
  1:1 trace:route pairing.
- Result: tool.call/tool.result/llm.call/agent phases reach SSE exactly once
  (bridge is the sole source; approvals/context/retrieval/tools trace.emit
  sites now also reach SSE, which they never did before).

### Payload enrichment (orchestrator.ts)
- `task.start` input already carried `{ goal }` (verified, unchanged).
- `task.end` output now includes `{ summary }` — the SAME string the
  transcript card shows (finalize() reordering computes summary before the
  emit). web's `summarizeTaskEnd` prefers `output.summary`. Smoke-verified.

### B19 — POST /api/tasks synchronous TaskRecord (index.ts, orchestrator.ts)
- New `export function ensureTask(session, prompt): TaskRecord` in
  orchestrator: REUSES the wave-1 B9 archiving rule (hoisted to module-level
  `isTerminalTask`; runTask's inline copy replaced by it — ONE rule). Archives
  a TERMINAL previous task to `pastTasks` (cap 25), creates/returns the fresh
  record; runTask's `session.task ??=` then no-ops.
- POST /api/tasks calls `ensureTask` BEFORE saveSession/respond; response now
  carries the real task UUID: `{ ok, id, taskId, sessionId, ... }` with
  `id === taskId !== sessionId` (smoke + tasks-route.test.ts). 409 double-run
  guard kept. Live archiving verified in smoke (second prompt archived task #1
  into pastTasks and ran task #2).

### B5 — PATCH /api/proposals/:pid/hunks/:hid persistence (index.ts, types.ts)
- Accepts BOTH `{ accept }` and `{ accepted }` (+ optional `reason`, capped
  500 chars).
- `DiffHunk` gained optional `status?: "pending"|"accepted"|"rejected"` +
  `reason?: string` (types.ts); decisions persist IMMUTABLY through
  `updateProposal` (getProposal returns fresh disk parses — mutating the local
  copy would be lost; the route builds a new files array instead).
- REJECT is no longer a no-op: persists status+reason, recomputes proposal
  status from the per-hunk ledger (all accepted → applied; all decided & none
  accepted → rejected; some accepted → partially-applied; else pending),
  emits the updated proposal on the wire.
- Response = the full ProposalDto via `toProposalDtos`, matched to the request
  pid (`dtos.find(d => d.id === rawPid) ?? dtos[fileIdx] ?? dtos[0]`) so web's
  `replaceProposal` matches by id. `toProposalDtos` now renders per-hunk
  `status`/`reason` (per-hunk wins; legacy derivation otherwise).
- Accept path 409s with the skip reason when applyProposalPartial could not
  apply the hunk (drift/escapee) instead of silently marking it accepted.

### B6 — file-scoped hunk addressing (index.ts)
- hid `${fileIdx}_${hunkIdx}` (e.g. "2_0") → applies ONLY to
  `p.files[fileIdx]` (jailed single-file proposal copy into
  `applyProposalPartial`, acceptedHunks `{ [file.path]: [hunkIdx] }`).
- Legacy numeric hid fallback kept (first file containing that hunkIndex).
- pid may be bare proposal id or per-file DTO id `${p.id}_${fileIdx}`
  (proposal ids are underscore-free UUIDs → `split("_")[0]` safe).
- Hunk DTO id stays the BARE hunkIndex — web prefixes fileIdx itself
  (DiffReview B6); do NOT "fix" the DTO id to include fileIdx or web would
  double-prefix.

### B44 — POST /api/tasks/:id/message nudge (index.ts)
- RUNNING task (isRunning = controllers.has) → `enqueueNudge(taskId, text)`
  (wave-1 signature verified: `(taskId: string, text: string) => boolean`):
  true → `{ ok:true, delivered:"loop" }`; false → honest 409.
- Non-running → unchanged append-to-history + fresh runTask kick, now
  returning `{ ok:true, delivered:"history" }`. Unknown id → 404.
- Smoke-verified `delivered:"loop"` on a task parked at the approval gate.

### B20 — frames carry taskId+sessionId
- Verified: wireIdentity surfaces both on every variant; smoke asserted
  61/61 frames carry both. No code change needed.

### /models discovery (providers.ts — FIX-PLAN Phase 6)
- `registry.refresh` now runs the previously-dead pipeline: per-provider
  `fetchProviderModels` (TTL-cached) → models.dev enrichment
  (`matchModelsDevProvider` + `specFromEndpointAndCatalog`) → merge with the
  NATIVE_MODELS seed. Discovered specs win on id clash; the engine/* tier
  aliases are ALWAYS kept (router-proxy routing vocabulary). Custom
  (non-local-router) endpoints honor `customModelAllowlist` (critique #11):
  allowlist set → only listed ids admitted; unset → everything admitted tagged
  "unverified" + one-time console.warn. Any failure → graceful fallback to the
  seed; refresh never throws.
- Startup refresh (startRegistryAutoRefresh) + on-settings-save refresh
  (PUT /api/settings already called registry.refresh) now both do REAL
  discovery. Smoke: engine /api/models = 7 seeds + 10 real router ids.

### B26 parity (chat.ts — wave-1 deferred follow-up)
- chatRace call now passes `maxSlotMs: 90_000` (task-path parity). Signal
  parity N/A: a /chat turn has no abort controller of its own. The other two
  B26 sites (orchestrator.ts:~1319, providers.ts chatSweep) were already fixed
  in wave 1 — verified in place.

## Tests added
- `test/events.test.ts` (10): id monotonicity + since(); bridge exactly-once;
  derived route frame ordering; watermark; synthetic message replay ordering +
  dedupe-by-id soundness; synthetic trace dedupe; ensureTask archiving ×3.
- `test/hunks-route.test.ts` (5): file-scoped accept touches ONLY the target
  file; legacy numeric hid; unknown hunk 404; reject persists status+reason +
  proposal ledger; `{accepted}` body key.
- `test/tasks-route.test.ts` (2): B19 synchronous real-UUID response; empty
  prompt 400. (Runs via `app.request`; importing index.ts boots the server on
  an ephemeral port — `test/_env.ts` now sets `ENGINE_PORT ??= "0"`.)

## Skipped / deferred (with reasons)
- `/api/proposals/:id/apply` + `resolve_all` do NOT set per-hunk status (B5
  scope is the hunks PATCH route); their DTO hunk statuses still derive from
  proposal status exactly as before — no regression.
- Journal truncation/rotation: append-only by design (same policy as
  traces.jsonl); loads read only the tail 2000.
- Persisting message-emit ids instead of derived synthetic ids: chose derived
  `at - epoch` ids (simpler, restart-proof, no extra storage); documented in
  events.ts.
- Smoke ran on port 4101: a live engine instance already owns 4100 (and the
  router 4098); did not disturb either.

## Integration notes for the next wave
- SSE + events endpoint share ONE id space — any NEW wire.emit anywhere in the
  engine is automatically stamped/journaled/bridged; do NOT add manual
  trace→wire mirrors anywhere (the bridge in events.ts is the single source).
- New WireEvent variants: add sessionId extraction to `wireIdentity` in
  events.ts if the variant hides it in a new sub-object.
- The events endpoint's synthetic builders need `session.messages` /
  `trace.getEvents`; if a future store keeps messages elsewhere, feed the
  builders from there.
- `enqueueNudge(taskId, text)` remains the ONLY live-injection path; the
  message route returns `delivered:"loop"|"history"` (web composer may surface
  it; currently ignored client-side by design).
- Registry cache is process-global; `registry.refresh({force:true})` bypasses
  the per-provider /models TTL (10 min).
