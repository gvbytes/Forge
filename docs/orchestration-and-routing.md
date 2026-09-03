# Orchestration & Routing

How AgentZero turns one prompt into working code using only open-weight models
of **≤80B total parameters** on free-tier APIs.

---

## 1. The constraint that shapes everything

A sub-80B model cannot hold a multi-step coding task in its head. So the
orchestrator never asks it to. Every design decision below follows from that,
and each one was forced by an observed failure — the failures are recorded next
to the fixes, because a design justified only in the abstract is not defensible.

---

## 2. Task lifecycle

```
prompt ─▶ triage ─▶ plan ─▶ explore ─▶ drive ─▶ finalize
            │                            │
            │ chitchat / trivial         │ stuck?
            └────────▶ direct answer     └───────▶ re-plan (≤3)
```

Two paths deliberately skip work rather than do it badly:

- **Chitchat** ("hi", "thanks") → one small completion, **no tools declared**.
  *Why:* "Hello" cost **2,557 tokens** because the lite path declared a
  read-only tool roster, and a tool-trained model handed a roster uses it — it
  ran a directory listing to answer a greeting. Now **149 tokens, one call**.
  **Declaring a capability invites its use.**
- **Explorer** runs only when the plan has >1 step, the workspace is non-empty,
  and the planner did not mark the task `easy`.

---

## 3. Three nested loops

Each ring retries a different unit of work against a different signal, with an
independent cap. This is what stops blind retry.

| Loop | Unit | Retries when | Cap |
|---|---|---|---|
| `toolLoop()` | one LLM turn | malformed tool call | 3 nudges · 20 calls |
| `runStep()` | one plan step | reviewer fails, or nothing written | 2 + 2 · 3 attempts |
| `drive()` | the whole plan | stuck detector fires | 3 re-plans |

A protocol slip is fixed without re-running the step; a bad edit without
re-planning; only a genuinely stuck task pays for a new plan.

**Stuck detection** has three signals, and **none of them retry** — all escalate
to re-plan, a *different mechanism*:

- `step-attempts` — same step tried 3×
- `repeat-fail` — same tool **hashed with its arguments** failing twice
- `repeat-text` — 3 byte-identical normalized outputs

---

## 4. Verification: three layers, only one of them an LLM

1. **No-op guard** — a code step where no write succeeded is not done.
2. **Reviewer** — reads the unified diff, returns a JSON verdict.
3. **Auditor** (`audit.ts`) — **zero tokens, read-only, cannot hallucinate.**

The auditor exists because layers 1–2 are downstream of the coder: the reviewer
reads a diff computed from the coder's *own writes*, so it cannot see a file
that does not parse, is empty, or was never written. The auditor stats the
filesystem and parses the files. It **overrides** the reviewer.

It runs no build and no test suite — those mutate state, and an auditor that
changes what it audits cannot certify it.

`step.resultSummary` — which the re-planner reads — now leads with the verified
observation and labels the claim as a claim:

```
VERIFIED: calc.py present and parsing on disk · coder reported: Added divide(a,b)
```

**Truncation gate.** A reply cut off at `max_tokens` is half an answer, and it
still parses as a valid `write_file`. Nothing read `finish_reason`, so
half-written files reached disk and every downstream check passed on them. The
tool loop now refuses to execute a truncated reply and asks for the work in
smaller pieces.

---

## 5. Routing

### The ≤80B guarantee

Not a filter — a **hardcoded catalog plus a startup invariant**.
`createRouterApp()` throws on any model with non-finite or over-cap `param_b`.
The router cannot route to a model that is not in the table, and refuses to boot
if the table is invalid.

`param_b` is always **TOTAL** parameters. MoE models advertise the *active*
count in their id, and several free models are disqualifying on total alone:

```
nvidia/nemotron-3-super-120b-a12b   12B active / 120B TOTAL   INELIGIBLE
poolside/laguna-s-2.1                8B active / 118B TOTAL   INELIGIBLE
poolside/laguna-xs-2.1               3B active /  33B TOTAL   eligible
```

Those last two differ by one letter.

### The decision

The engine asks for a **tier** (`engine/small|medium|large`); the router decides
which concrete model serves it:

```
classify(body, ctx)      → complexity tier + reasons     (pure, no I/O)
Cascade                  → per-task escalation floor
budgetMode(ledger)       → normal | finalize | halt
selectProvider(tier, …)  → provider by headroom, cost, health
```

`Cascade` escalates a tier on verified failure and **demotes** after two
consecutive successes at the same tier — cheap when things are going well.

### Transparency (the decision can never be hidden)

Every response carries `x-engine-route` with the model, provider, tier, and
every signal that moved the decision:

```
score 0 -> base S; alias engine/small -> S; free-tier lock: priced models
excluded; budget:normal ($0.0000/$0.05, 0s/2400s); provider nvidia-nim chosen:
headroom 0.97, 429x0, rpm 1/30
```

The engine reads that header back and labels the trace with the model that
**actually answered** — `openai/gpt-oss-20b@nvidia-nim`, not the alias. The chat badge
renders it with the reasons on hover.

### Free-tier lock

Under the scoring formula, differentiating the denominator gives
**one cent of spend ≈ 163 seconds of wall clock**. Cost is weighted ~2× time, so
paying for capability is almost never rational. The router refuses priced models
at every tier and every budget mode. An explicit model pin overrides it — and
says so in the route reason.

### Race only across independent providers

Racing is failover, and failover only helps if candidates fail *independently*.
Models on one provider share a rate limit. Measured on a 3-step task with one
provider keyed: **16 successful calls, 11s of model time, inside a 174s task,
with 97 HTTP 429s**. The degraded-primary trigger fires *because* of those 429s,
so the old condition was a feedback loop:

```
429 → health penalty → race 3× → 3× load on the SAME bucket → more 429s
```

Racing now requires two distinct providers. Same-provider fallbacks go
sequential, which is what a shared quota wants.

---

## 6. Context discipline

Per step, assembled fresh — never the conversation:

- the **verbatim** user goal (the planner compresses; literals must survive)
- step title, detail, attempt number
- **≤6 retrieval hits** as `path:start-end` with bounded previews
- user-pinned context
- results of *specific* prior steps (below)
- ≤3 keyword-relevant messages, live budget footer

### Information flow ≠ execution order

```
dependsOn   → "when may this run?"   (scheduling)
accessList  → "what should it SEE?"  (context)
```

Conflated, a step got the last four summaries **by recency** — so `s9`,
depending only on `s2`, was shown `s5–s8` and *not* `s2`. Resolution order:
explicit `accessList` → **transitive dependency closure** → recency floor.

Our 20B planner ignores the optional `accessList` field entirely, so the
**closure is the load-bearing part**. That is the general rule: *never depend on
a small model producing something optional.*

---

## 7. Tool protocol: both, chosen by evidence

The text protocol (`TOOL_CALL: {…}`) was chosen because small models emit
malformed JSON in a native envelope. That reasoning holds — for models that are
not tool-trained.

`gpt-oss-20b` **is** tool-trained. Handed the text protocol it emitted a native
call anyway; with no `tools` array declared the provider rejected the request
outright (*"Tool choice is none, but model called a tool"*) and returned an
empty `content`. Measured: **65 reasoning deltas, 0 content deltas.**

So tools are declared natively per role, native calls are preferred, and the
text protocol remains the fallback. `normalizeTool()` still repairs the ways
small models mangle names (`writefile`, leaked `<arg_value>` tags) **before**
the approval gate, so a repaired alias is still gated.

---

## 8. Approvals

Default is **`gate`**: every side-effecting tool waits for a human.
`optimistic` (writes apply immediately, checkpointed and revertable) is a
documented opt-in, not the default — the brief requires approval before writes,
and the shipped default must satisfy it without configuration.

A missing or non-boolean decision is a **400**, never a silent deny. Two
endpoints previously disagreed on the body key, so `{approve:true}` to the wrong
one read as `undefined` → false → the write was rejected while the caller
believed it approved.

---

## 9. Parallelism

The planner emits a DAG; the scheduler runs the ready set concurrently up to
`budgets.max_parallel_subagents`. Measured, three independent steps:

```
0.00s start s1 · 0.00s start s2 · 0.00s start s3
28.3s end s1  · 73.2s end s2  · 172.5s end s3
PEAK CONCURRENT: 3    274s of step work in 173s wall
```

Every mutation goes through `withFileLock(path)`; a cycle falls back to a linear
chain rather than deadlocking.

**Subagents** (`delegate`) are context-isolated with their own budget and
watchdog, but the parallel fan-out needs ≥2 delegate calls in one reply and
`gpt-oss-20b` emits one. Step-level parallelism is where concurrency actually
comes from — stated plainly because claiming otherwise would be false.

---

## 10. Every ceiling

| Scope | Limit | Purpose |
|---|---|---|
| Task wall clock | 2,400 s | 300 s under the 2,700 s hard ceiling |
| Per step | 600 s | aborts in flight, not just loses a race |
| Plan steps | 40 | retries included |
| Tool calls / run | 20 | explorer 6 · delegate 12 |
| Re-plans | 3 | then halt rather than loop |
| Truncation retries | 3 | bounded overflow recovery |
| Parallel steps | 1–4 | conflicting edits cost more than wall clock |
| Delegation depth | 1 | a subagent cannot spawn subagents |
| Spend / task | $0.05 | score-optimal, **not** the $0.50 eval ceiling |

Two envelopes, deliberately: a task at $0.35 has already lost even if it
succeeds, so the governor steers by the score-optimal envelope and the hard
ceiling is only a backstop.
