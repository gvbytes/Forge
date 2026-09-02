// ── Native Agent Engine smart router ──────────────────────────────────────
// Deterministic heuristic model selection. Cost discipline: we never spend an
// LLM call deciding which LLM to call.
//
// Pipeline:
//   1. estimate task complexity 0..1 from cheap text signals
//   2. candidate pool = registry.list() filtered to enabled models
//   3. hard gate: ctxWindow >= contextTokens * 1.3 (relaxed only if nobody fits)
//   4. score each model: role/complexity fit + residual rate-limit headroom +
//      cost + speed, multiplied by a live-health gate
//   5. soft gates: reviewer≠coder ("fresh eyes"), preemptive dodge of models
//      that recently 429'd repeatedly, budget-exhausted force-cheap mode
//   6. emit winner + 2 fallbacks + a structured signal trace (auditable)
//
// Health model (`health` / `recordOutcome`): failures add weighted penalty
// mass (429 weighs more than 5xx because it means "alive but saturated");
// mass decays exponentially with a 60 s half-life, so a flapping model earns
// its way back into the pool while a hard-down one sinks — but is still
// reachable when nothing else fits (graceful degradation beats hard failure).

import { registry, chat } from "./providers.js";
import { loadSettings, resolveRoleOverride } from "./config.js";
import { log, logger } from "./logger.js";
import type { ModelSpec, RouteDecision, RouteSignal } from "./types.js";

export type RouterRole =
  | "router"
  | "planner"
  | "coder"
  | "reviewer"
  | "explorer"
  | "summarizer";

export interface DecideRouteInput {
  sessionId: string;
  role: RouterRole;
  /** Latest user text; may be undefined for internal calls. */
  userPrompt?: string;
  /** Estimated tokens the call will carry. */
  contextTokens: number;
  /** Cumulative task tokens. */
  tokensUsedSoFar: number;
  costUsedSoFarUsd: number;
  budgetCapUsd?: number;
  /** Last error strings from this session (rate limits etc.). */
  recentErrors?: string[];
}

// ── Health tracking (fed by providers.ts callers) ──────────────────────────

export interface ModelHealth {
  fail429: number;
  fail5xx: number;
  lastFailAt: number;
  latencyEmaMs: number;
}

/** modelId → live health state. In-memory, process-local by design. */
export const health = new Map<string, ModelHealth>();

const HALF_LIFE_MS = 60_000; // penalty mass halves every 60 s → auto-recovery
const PENALTY_429 = 1.2; // alive-but-saturated: strongest avoidance signal
const PENALTY_5XX = 0.8; // dead/flaky
const UNHEALTHY_PENALTY = 1.0; // ≥ this → score ×0.10 (last resort only)
const DEGRADED_PENALTY = 0.25; // ≥ this → score ×0.55 (deprioritized)
const LATENCY_EMA_ALPHA = 0.3; // EMA smoothing for observed latency

function decaySince(lastFailAt: number, now: number): number {
  if (lastFailAt <= 0) return 1;
  return Math.pow(0.5, Math.max(0, now - lastFailAt) / HALF_LIFE_MS);
}

/** Current decayed failure mass for a model (0 = pristine). */
export function effectivePenalty(modelId: string, now = Date.now()): number {
  const h = health.get(modelId);
  if (!h || (h.fail429 <= 0 && h.fail5xx <= 0)) return 0;
  return (h.fail429 + h.fail5xx) * decaySince(h.lastFailAt, now);
}

/**
 * Feed one call result back into the health ledger.
 * 429 and 5xx (and status-less network errors) hurt; plain 4xx does not —
 * a 401 is a config problem, not the model being unhealthy.
 */
export function recordOutcome(
  modelId: string,
  ok: boolean,
  latencyMs: number,
  status?: number,
): void {
  const now = Date.now();
  let h = health.get(modelId);
  if (!h) {
    h = { fail429: 0, fail5xx: 0, lastFailAt: 0, latencyEmaMs: 0 };
    health.set(modelId, h);
  }
  // Decay existing mass by elapsed time BEFORE accumulating, so repeated
  // failures stack correctly relative to their own timeline.
  if (h.lastFailAt > 0) {
    const f = decaySince(h.lastFailAt, now);
    h.fail429 *= f;
    h.fail5xx *= f;
  }
  if (!ok) {
    if (status === 429) {
      h.fail429 += PENALTY_429;
      h.lastFailAt = now;
    } else if (status === undefined || status >= 500) {
      h.fail5xx += PENALTY_5XX;
      h.lastFailAt = now;
    }
    // other 4xx: request-level error, leave health untouched
    // r7-A: health changes are info — "why did the router stop picking X"
    // is answerable only if the penalty ledger itself is visible.
    logger.info("router", "health penalty", {
      model: modelId, status, fail429: Number(h.fail429.toFixed(2)), fail5xx: Number(h.fail5xx.toFixed(2)),
      penalty: Number(effectivePenalty(modelId, now).toFixed(2)),
    });
  }
  // r8: the breaker rides the same funnel — every caller that records an
  // outcome now also updates trip state (single source of truth).
  recordBreakerOutcome(modelId, ok, status, now);
  if (latencyMs > 0) {
    h.latencyEmaMs =
      h.latencyEmaMs === 0 ? latencyMs : h.latencyEmaMs * (1 - LATENCY_EMA_ALPHA) + latencyMs * LATENCY_EMA_ALPHA;
  }
}

/** B16: an empty 200-OK completion means the model answered with nothing.
 *  That deserves a SMALL deprioritization — but it is NOT a 5xx (the model is
 *  alive and answering) and it must NOT trip the circuit breaker (one empty
 *  reply used to demote a healthy model for minutes via fail5xx += 0.8).
 *  This path touches only the decayed penalty ledger, never the breaker. */
const PENALTY_EMPTY = 0.2;
export function recordEmptyOutcome(modelId: string, latencyMs: number): void {
  const now = Date.now();
  let h = health.get(modelId);
  if (!h) {
    h = { fail429: 0, fail5xx: 0, lastFailAt: 0, latencyEmaMs: 0 };
    health.set(modelId, h);
  }
  if (h.lastFailAt > 0) {
    const f = decaySince(h.lastFailAt, now);
    h.fail429 *= f;
    h.fail5xx *= f;
  }
  h.fail5xx += PENALTY_EMPTY; // small mass; decays with the 60 s half-life
  h.lastFailAt = now;
  if (latencyMs > 0) {
    h.latencyEmaMs =
      h.latencyEmaMs === 0 ? latencyMs : h.latencyEmaMs * (1 - LATENCY_EMA_ALPHA) + latencyMs * LATENCY_EMA_ALPHA;
  }
  logger.info("router", "empty completion — small penalty, breaker untouched", {
    model: modelId, penalty: PENALTY_EMPTY,
    total: Number(effectivePenalty(modelId, now).toFixed(2)),
  });
}

// ── Circuit breaker (r8, LiteLLM-style) ────────────────────────────────────
// Sits on top of the decayed-penalty health ledger: penalties make a model
// unattractive; the breaker makes it UNROUTABLE for a bounded cool-down so
// dead upstreams stop eating race slots and latency budgets.
//
// Trip rules (per modelId):
//   • ≥ allowedFails failures inside a rolling windowMs → OPEN
//   • OR failure-rate > failRateThreshold over ≥ minSamples samples → OPEN
//   • cool-down = baseCooldown × 2^(repeatOffense−1), capped at maxCooldown
//   • after cool-down → HALF-OPEN: one trial request; success closes,
//     failure re-opens at double the cooldown
//   • 400/401/403 NEVER trip (auth/request blame is config, not uptime) —
//     logged as "invalid key?" hints instead
//   • sole enabled model of its provider is only ever DEGRADED, never fully
//     opened: cooling down the only answer guarantees task death.

export type BreakerStateName = "closed" | "open" | "half-open" | "degraded";

export interface BreakerEntry {
  state: BreakerStateName;
  /** Failure timestamps inside the rolling trip window. */
  failsTs: number[];
  /** ALL outcome timestamps inside the rolling rate window (success+fail). */
  samplesTs: number[];
  repeatOffenses: number;
  openedAt?: number;
  cooldownUntil?: number;
  cooldownMs?: number;
}

/** modelId → live breaker state. In-memory, process-local like `health`. */
export const breaker = new Map<string, BreakerEntry>();

/** Test/ops knobs — mutable so smokes can prove trip/half-open behavior with
 *  millisecond cooldowns instead of sleeping 30–300 s per case. */
export const breakerKnobs = {
  allowedFails: 3,
  windowMs: 60_000,
  minSamplesForRate: 20,
  failRateThreshold: 0.5,
  baseCooldownMs: 30_000,
  maxCooldownMs: 300_000,
};

function breakerTripWorthy(status: number | undefined): boolean {
  // Timeouts/network deaths arrive status-less — treat like 5xx.
  return status === undefined || status === 429 || status >= 500;
}

function getBreaker(modelId: string): BreakerEntry {
  let b = breaker.get(modelId);
  if (!b) {
    b = { state: "closed", failsTs: [], samplesTs: [], repeatOffenses: 0 };
    breaker.set(modelId, b);
  }
  return b;
}

/** Lazy state transition: an open breaker whose cooldown has elapsed becomes
 *  half-open ON FIRST READ (router scoring, sweep, or API snapshot), which is
 *  what admits exactly one trial request. */
export function effectiveBreakerState(modelId: string, now = Date.now()): BreakerStateName {
  const b = breaker.get(modelId);
  if (!b) return "closed";
  if ((b.state === "open" || b.state === "degraded") && b.cooldownUntil !== undefined && now >= b.cooldownUntil) {
    b.state = "half-open";
    logger.info("router", "breaker half-open — admitting one trial request", {
      model: modelId, cooldownMs: b.cooldownMs, repeatOffense: b.repeatOffenses,
    });
  }
  return b.state;
}

function openBreaker(modelId: string, now: number): void {
  const b = getBreaker(modelId);
  b.repeatOffenses += 1;
  b.openedAt = now;
  const cd = Math.min(
    Math.round(breakerKnobs.baseCooldownMs * Math.pow(2, b.repeatOffenses - 1)),
    breakerKnobs.maxCooldownMs,
  );
  b.cooldownMs = cd;
  b.cooldownUntil = now + cd;
  // Single-enabled-model guard: cooling down the provider's ONLY model turns
  // one flaky endpoint into a guaranteed task failure. Degrade instead — it
  // stays routable as a last resort while the penalty ledger pushes it back.
  const spec = registry.get(modelId);
  const solo =
    !!spec && registry.list().filter((m) => m.enabled && m.provider === spec.provider).length <= 1;
  if (solo) {
    b.state = "degraded";
    logger.warn("router", "breaker would open but model is the provider's only enabled model — degraded", {
      model: modelId, provider: spec?.provider, failsInWindow: b.failsTs.length, cooldownMs: cd,
    });
  } else {
    b.state = "open";
    logger.warn("router", "breaker OPEN — model cooled down", {
      model: modelId,
      failsInWindow: b.failsTs.length,
      windowMs: breakerKnobs.windowMs,
      cooldownMs: cd,
      repeatOffense: b.repeatOffenses,
      until: new Date(b.cooldownUntil).toISOString(),
    });
  }
}

/** Feed one outcome into the breaker. Called from recordOutcome so EVERY
 *  caller (orchestrator races, chat fallback chains, sweeps, bytheway)
 *  funnels through here exactly once. */
function recordBreakerOutcome(modelId: string, ok: boolean, status: number | undefined, now: number): void {
  const b = getBreaker(modelId);
  // Prune both rolling windows first so rates/counters reflect recent reality.
  b.samplesTs = b.samplesTs.filter((t) => now - t <= breakerKnobs.windowMs);
  b.failsTs = b.failsTs.filter((t) => now - t <= breakerKnobs.windowMs);
  b.samplesTs.push(now);

  if (ok) {
    if (b.state === "half-open") {
      logger.info("router", "breaker closed — trial request succeeded", { model: modelId });
      breaker.delete(modelId); // full reset: clean slate, offense count included
      return;
    }
    if (b.state === "degraded") {
      // Solo model recovered: give it a clean slate too (fresh 3-strike budget).
      logger.info("router", "breaker degraded→closed on success", { model: modelId });
      breaker.delete(modelId);
      return;
    }
    return;
  }

  // Auth/request-class errors are OUR bug or a bad key, never model uptime:
  // tripping here would cool down perfectly healthy models over config slips.
  if (status === 400 || status === 401 || status === 403) {
    logger.warn("router", `auth/request error ${status} — not cooling down (invalid key?)`, { model: modelId });
    return;
  }
  if (!breakerTripWorthy(status)) return; // other 4xx: request-level, not health

  b.failsTs.push(now);
  const state = effectiveBreakerState(modelId, now);
  if (state === "open" || state === "degraded") return; // already cooling
  if (state === "half-open") {
    // Trial failed → straight back to open at DOUBLE the previous cooldown.
    openBreaker(modelId, now);
    return;
  }
  const failRate = b.samplesTs.length >= breakerKnobs.minSamplesForRate ? b.failsTs.length / b.samplesTs.length : 0;
  if (b.failsTs.length >= breakerKnobs.allowedFails || failRate > breakerKnobs.failRateThreshold) {
    openBreaker(modelId, now);
  } else if (b.failsTs.length >= 2) {
    logger.debug("router", "breaker accumulating failures", {
      model: modelId, failsInWindow: b.failsTs.length, allowed: breakerKnobs.allowedFails,
    });
  }
}

export interface BreakerSnapshotEntry {
  state: BreakerStateName;
  cooldownUntil?: number;
  cooldownRemainingMs?: number;
  failRate?: number;
  repeatOffenses: number;
}

/** Wire-shape snapshot of ALL known models' breaker states (GET /api/models
 *  `health`). Models with no breaker entry report a pristine "closed" so the
 *  Settings table can render a full column instead of blanks. */
export function breakerSnapshot(now = Date.now()): Record<string, BreakerSnapshotEntry> {
  const out: Record<string, BreakerSnapshotEntry> = {};
  const ids = new Set<string>([...registry.list().map((m) => m.id), ...breaker.keys()]);
  for (const modelId of ids) {
    if (!breaker.has(modelId)) {
      out[modelId] = { state: "closed", repeatOffenses: 0 };
      continue;
    }
    const state = effectiveBreakerState(modelId, now);
    const b = breaker.get(modelId)!;
    const fails = b.failsTs.filter((t) => now - t <= breakerKnobs.windowMs).length;
    const samples = b.samplesTs.filter((t) => now - t <= breakerKnobs.windowMs).length;
    out[modelId] = {
      state,
      ...(b.cooldownUntil !== undefined && state !== "closed"
        ? { cooldownUntil: b.cooldownUntil, cooldownRemainingMs: Math.max(0, b.cooldownUntil - now) }
        : {}),
      ...(samples >= breakerKnobs.minSamplesForRate ? { failRate: Math.round((fails / samples) * 100) / 100 } : {}),
      repeatOffenses: b.repeatOffenses,
    };
  }
  return out;
}

/**
 * r8 context-overflow escape hatch: the healthy ENABLED model with the
 * LARGEST ctxWindow not in `exclude` (breaker-open models skipped unless they
 * alone remain — overflow means we NEED window, so size beats politeness).
 */
export function largestCtxHealthyModel(exclude: Iterable<string>): ModelSpec | undefined {
  const ex = new Set(exclude);
  const pool = registry.list().filter(
    (m) => m.enabled && !ex.has(m.id) && effectiveBreakerState(m.id) !== "open",
  );
  return pool.sort((a, b) => b.ctxWindow - a.ctxWindow || a.id.localeCompare(b.id))[0];
}

// ── Complexity estimation ───────────────────────────────────────────────────

const HIGH_VERBS = [
  "refactor", "debug", "architect", "design", "migrate", "optimize",
  "integrate", "implement", "diagnose", "rewrite", "investigate", "build",
  // BUGFIX: from-scratch creation verbs were missing, so "make a 3d flappy bird
  // game" scored the 0.30 base and the coder landed on tier-1 (tiny) models.
  "make", "create", "generate", "develop", "scaffold",
];
const LOW_VERBS = ["rename", "typo", "reformat", "lint", "spellcheck", "capitalize"];
const QUESTION_WORDS =
  /^(how|what|why|where|when|which|who|can|could|should|is|are|does|do|explain|compare)\b/i;
const KNOWN_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|swift|kt|scala|sql|sh|bash|md|json|ya?ml|toml|ini|env|html|css|scss|vue|svelte)\b/i;

const ROLE_DEFAULT_COMPLEXITY: Record<RouterRole, number> = {
  router: 0.15,
  explorer: 0.2,
  summarizer: 0.25,
  coder: 0.55,
  reviewer: 0.5,
  planner: 0.85,
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface ComplexityResult {
  score: number;
  parts: RouteSignal[];
}

function estimateComplexity(prompt: string | undefined, role: RouterRole): ComplexityResult {
  // Internal calls carry no user text: fall back to a per-role prior so the
  // router still tiers sensibly instead of guessing mid for everything.
  if (!prompt) {
    return {
      score: ROLE_DEFAULT_COMPLEXITY[role],
      parts: [
        {
          name: "prompt",
          value: "(none)",
          note: `internal call — role-default complexity ${ROLE_DEFAULT_COMPLEXITY[role]}`,
        },
      ],
    };
  }

  let score = 0.3; // base: assume a normal actionable request
  const parts: RouteSignal[] = [];

  // Imperative verbs — strong intent signal.
  const lower = prompt.toLowerCase();
  const highVerb = HIGH_VERBS.find((v) => lower.includes(v));
  const lowVerb = LOW_VERBS.find((v) => lower.includes(v));
  if (highVerb) {
    score += 0.18;
    parts.push({ name: "imperative-verbs", value: highVerb, note: "+0.18 heavy verb" });
  } else if (lowVerb) {
    score -= 0.12;
    parts.push({ name: "imperative-verbs", value: lowVerb, note: "−0.12 trivial verb" });
  } else {
    parts.push({ name: "imperative-verbs", value: "(none)", note: "±0" });
  }

  // Question vs command — questions want explanations, usually lighter than builds.
  const isQuestion = QUESTION_WORDS.test(prompt.trim()) || /\?/.test(prompt);
  if (isQuestion && !highVerb) {
    score += 0.04;
    parts.push({ name: "question-vs-command", value: "question", note: "+0.04 explanatory" });
  } else {
    parts.push({ name: "question-vs-command", value: isQuestion ? "question" : "command", note: "±0" });
  }

  // Prompt length — long asks correlate with multi-part work.
  const lenBoost = Math.min(prompt.length / 4000, 1) * 0.22;
  score += lenBoost;
  parts.push({ name: "prompt-len", value: prompt.length, note: `+${r2(lenBoost)} (len/4000 capped)` });

  // Code fences — paired ``` occurrences; code in play means harder verification.
  const fenceMarks = (prompt.match(/```/g) ?? []).length;
  const fenceBlocks = Math.floor(fenceMarks / 2);
  const fenceBoost = Math.min(fenceBlocks, 2) * 0.08;
  score += fenceBoost;
  parts.push({ name: "code-fences", value: fenceBlocks, note: `+${r2(fenceBoost)} (max 2 blocks counted)` });

  // Files mentioned — slashed paths + known source extensions, deduped.
  const fileTokens = new Set<string>();
  for (const m of prompt.matchAll(/\b[\w-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,5}\b/g)) fileTokens.add(m[0]);
  for (const m of prompt.matchAll(new RegExp(`\\b[\\w-]+${KNOWN_EXT.source}`, "gi"))) fileTokens.add(m[0]);
  const fileCount = fileTokens.size;
  const fileBoost = Math.min(fileCount, 4) * 0.04;
  score += fileBoost;
  parts.push({ name: "files-mentioned", value: fileCount, note: `+${r2(fileBoost)} (0.04/file, max 4)` });

  // A visible plan makes execution mechanical — complexity drops.
  const planDetected = /^\s*\d+[.)]\s/m.test(prompt) || /\bstep\s*\d+/i.test(prompt);
  if (planDetected) {
    score -= 0.1;
    parts.push({ name: "plan-detected", value: "yes", note: "−0.10 execution already structured" });
  } else {
    parts.push({ name: "plan-detected", value: "no", note: "±0" });
  }

  // Multi-clause requests ("then …, also …") hint at hidden scope.
  const multiClause = /(;\s|\sthen\s|\bafter that\b|\balso\b|\band also\b)/i.test(prompt);
  if (multiClause) {
    score += 0.05;
    parts.push({ name: "multi-clause", value: "yes", note: "+0.05 compound request" });
  }

  return { score: r2(clamp01(score)), parts };
}

// ── Scoring ────────────────────────────────────────────────────────────────

type Tier = 1 | 2 | 3; // 1 light/fast · 2 balanced · 3 heavy/reasoning

function tierOf(m: ModelSpec): Tier {
  if (m.tags.includes("reasoning") || m.tags.includes("longctx")) return 3;
  if (m.tags.includes("fast")) return 1;
  return 2;
}

function desiredTier(role: RouterRole, cx: number): Tier {
  switch (role) {
    case "explorer":
    case "summarizer":
    case "router":
      return 1;
    case "planner":
      return 3;
    case "reviewer":
      return 2;
    case "coder":
      return cx < 0.35 ? 1 : cx < 0.7 ? 2 : 3;
  }
}

function capabilityFit(m: ModelSpec, role: RouterRole, cx: number, contextTokens: number): number {
  let s = 0.4;
  if (m.tags.includes("fast")) {
    // BUGFIX: the big fast-model bonus is only for speed-hungry roles (explorer/
    // summarizer/router). For planner/coder/reviewer it let a tiny model out-score
    // a capable one, so the planner narrated prose instead of emitting its JSON.
    const speedRole = role === "explorer" || role === "summarizer" || role === "router";
    s += speedRole ? (cx <= 0.5 ? 0.22 : 0.05) : (cx <= 0.5 ? 0.04 : 0.02);
  }
  if (m.tags.includes("reasoning")) {
    s += cx >= 0.5 ? 0.26 : 0.06;
    if (role === "planner") s += 0.12; // planner explicitly wants the strongest reasoner
  }
  if (m.tags.includes("longctx")) {
    s += contextTokens > 60_000 ? 0.18 : cx > 0.75 ? 0.08 : 0.02;
  }
  s -= Math.abs(tierOf(m) - desiredTier(role, cx)) * 0.09; // don't send renames to Ultra
  return clamp01(s);
}

function healthMultiplier(eff: number): number {
  if (eff >= UNHEALTHY_PENALTY) return 0.1; // avoid unless nothing else fits
  if (eff >= DEGRADED_PENALTY) return 0.55; // deprioritize while cooling down
  return 1;
}

function recent429Count(modelId: string, recentErrors: string[] | undefined): number {
  if (!recentErrors?.length) return 0;
  const idLower = modelId.toLowerCase();
  return recentErrors.filter((e) => e.includes("429") && e.toLowerCase().includes(idLower)).length;
}

function fmtEma(ms: number): string {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : "n/a";
}

interface ScoredModel {
  spec: ModelSpec;
  fit: number;
  rb: number; // residual rate-limit headroom 0..1
  cs: number; // cost score 0..1
  ss: number; // speed score 0..1
  eff: number; // decayed health penalty
  recent429: number;
  bState: BreakerStateName;
  total: number;
}

/** Per-session memory of the last coder pick — powers reviewer "fresh eyes". */
const lastCoderBySession = new Map<string, string>();

// ── Main entry point ───────────────────────────────────────────────────────

export async function decideRoute(input: DecideRouteInput): Promise<RouteDecision> {
  const now = Date.now();
  const prompt = input.userPrompt && input.userPrompt.trim() ? input.userPrompt : undefined;
  const cxResult = estimateComplexity(prompt, input.role);
  const cx = cxResult.score;
  const signals: RouteSignal[] = [...cxResult.parts];

  // Settings loaded up front: the operator-disabled list (critique #10) and
  // the budget cap both shape the pool before any scoring happens.
  const settings = loadSettings();
  const disabled = new Set(settings.disabledModels ?? []);
  const enabledList = registry.list().filter((m) => m.enabled);
  const operatorFiltered = enabledList.filter((m) => disabled.has(m.id)).length;
  const pool = enabledList.filter((m) => !disabled.has(m.id));
  if (operatorFiltered > 0) {
    signals.push({
      name: "operator-disabled",
      value: operatorFiltered,
      note: `${operatorFiltered} model(s) switched off in Settings — excluded from the pool`,
    });
  }

  // Empty registry: never throw — callers (agent loops) need a shape to log.
  if (pool.length === 0) {
    signals.push({ name: "pool", value: 0, note: "registry empty — placeholder decision" });
    return {
      modelId: "(no-model)",
      provider: "(none)",
      reason: `complexity=${cx.toFixed(2)} + role=${input.role} + registry-empty → no enabled models available`,
      signals,
      complexity: cx,
      fallbacks: [],
      at: now,
    };
  }

  // PER-ROLE CONTROL: an explicit Settings pin (selectedModels[role]) bypasses
  // scoring entirely — mirroring the orchestrator's task-agent override so the
  // router/bytheway path is not a black box that ignores the user's choice. A
  // disabled or unknown pin degrades gracefully to the scored auto-route below.
  const overrideId = resolveRoleOverride(
    settings.selectedModels as Record<string, string> | undefined,
    input.role,
    (id) => {
      const spec = registry.get(id);
      return !!spec && spec.enabled && !disabled.has(spec.id);
    },
  );
  const overrideSpec = overrideId ? registry.get(overrideId) : undefined;
  if (overrideSpec) {
    signals.push({
      name: "manual-override",
      value: input.role,
      note: `settings.selectedModels.${input.role} = ${overrideSpec.id} — scoring skipped`,
    });
    return {
      modelId: overrideSpec.id,
      provider: overrideSpec.provider,
      reason: "manual role override",
      signals,
      complexity: cx,
      fallbacks: [],
      at: now,
    };
  }

  // Budget posture: caps come from the caller, else global settings.
  const cap = input.budgetCapUsd ?? settings.budgetPerTaskUsd;
  const remainingUsd = typeof cap === "number" ? cap - input.costUsedSoFarUsd : undefined;
  const budgetTight =
    remainingUsd !== undefined && cap !== undefined && remainingUsd > 0 && remainingUsd < cap * 0.25;
  const budgetGone = remainingUsd !== undefined && remainingUsd <= 0;
  if (budgetTight) {
    signals.push({
      name: "budget-pressure",
      value: r3(remainingUsd!),
      note: `<25% of $${cap} cap left — cost weight tripled`,
    });
  }
  if (budgetGone) {
    signals.push({
      name: "budget-exhausted",
      value: r3(remainingUsd!),
      note: `over $${cap} cap — forcing cheapest healthy model`,
    });
  }

  // Hard gate: headroom for the reply too (ctx >= tokens*1.3). Relax only if
  // nobody fits — truncating upstream is the caller's compaction job.
  const needTokens = Math.ceil(input.contextTokens * 1.3);
  let candidates = pool.filter((m) => m.ctxWindow >= needTokens);
  let ctxRelaxed = false;
  if (candidates.length === 0) {
    candidates = [...pool];
    ctxRelaxed = true;
    signals.push({
      name: "ctx-relaxed",
      value: needTokens,
      note: `no model fits ${needTokens} tok — ignoring ctx gate, overflow risk accepted`,
    });
  }

  // r8 breaker gating: OPEN models are unroutable while cooling down; if EVERY
  // candidate is open we route anyway (graceful degradation beats hard fail).
  // HALF-OPEN and DEGRADED stay in the pool and take a score penalty below.
  const isOpen = (m: ModelSpec): boolean => effectiveBreakerState(m.id, now) === "open";
  const openSkipped = candidates.filter(isOpen).length;
  if (openSkipped > 0 && openSkipped < candidates.length) {
    signals.push({
      name: "breaker-open",
      value: openSkipped,
      note: `${openSkipped} model(s) skipped — circuit breaker open`,
    });
    candidates = candidates.filter((m) => !isOpen(m));
  } else if (openSkipped > 0 && openSkipped === candidates.length) {
    signals.push({
      name: "breaker-bypass",
      value: openSkipped,
      note: "every candidate's breaker is open — routing anyway as last resort",
    });
  }

  // Dynamic weights: when the budget runs dry, cost stops being a tiebreaker
  // and becomes the objective.
  const wFit = budgetGone ? 0.0 : budgetTight ? 0.4 : 0.55;
  const wRb = budgetGone ? 0.0 : 0.15;
  const wCost = budgetGone ? 0.7 : budgetTight ? 0.3 : 0.1;
  const wSpeed = budgetGone ? 0.3 : 0.2;

  const lastCoder = input.role === "reviewer" ? lastCoderBySession.get(input.sessionId) : undefined;
  const canDiversify = lastCoder !== undefined && candidates.some((m) => m.id !== lastCoder);

  const scored: ScoredModel[] = candidates.map((m) => {
    const h = health.get(m.id);
    const ema = h?.latencyEmaMs ?? 0;
    const eff = effectivePenalty(m.id, now);
    const recent429 = recent429Count(m.id, input.recentErrors);
    // r8: breaker posture on top of the penalty ledger.
    const bState = effectiveBreakerState(m.id, now);

    const fit = capabilityFit(m, input.role, cx, input.contextTokens);
    // Residual limit headroom: decayed in-flight 429 mass + explicit session errors.
    const rb = clamp01(1 - Math.min((h?.fail429 ?? 0) * decaySince(h?.lastFailAt ?? 0, now) + recent429 * PENALTY_429, 3) / 3);
    const blendedCostPerM = (m.costInPerM + m.costOutPerM) / 2;
    const cs = clamp01(1 - blendedCostPerM / 20); // $20/M blended ⇒ 0; free ⇒ 1
    // Speed: measured EMA wins; without data, lean on the "fast" tag prior.
    // BUGFIX: the strong 0.85 fast prior (no EMA yet) let tiny models out-score
    // capable ones for capability-focused roles. Only speed-hungry roles get it.
    const speedRole = input.role === "explorer" || input.role === "summarizer" || input.role === "router";
    const ss = ema > 0 ? clamp01((10_000 - ema) / 9500) : m.tags.includes("fast") ? (speedRole ? 0.85 : 0.5) : 0.4;

    let total = wFit * fit + wRb * rb + wCost * cs + wSpeed * ss;
    total *= healthMultiplier(eff);
    // Dynamic load distribution: small random jitter (+-0.02) among close candidates distributes traffic
    const jitter = (Math.random() - 0.5) * 0.04;
    total += jitter;
    // Breaker penalties (NOT bans): a half-open model may still win the trial
    // when it's the best option; a degraded solo model is tried only last.
    if (bState === "half-open") total *= 0.5;
    if (canDiversify && m.id === lastCoder) total *= 0.5; // reviewer fresh-eyes demotion
    // Free queued models (e.g. OpenRouter ':free' slugs) suffer from severe multi-minute queue latency.
    // Demote them so dedicated keyed providers (Groq, NVIDIA NIM, Cerebras) are chosen first.
    if (m.id.endsWith(":free")) total *= 0.3;
    if (ctxRelaxed) total *= 1; // relaxation is uniform; order preserved, noted in signals

    return { spec: m, fit: r3(fit), rb: r3(rb), cs: r3(cs), ss: r3(ss), eff: r3(eff), recent429, total: r3(total), bState };
  });

  scored.sort((a, b) => b.total - a.total || a.spec.id.localeCompare(b.spec.id)); // score with load-balancing jitter

  // Capability-only order (fit/cost/speed, NO health or rate state) answers:
  // "which model would we want if everything were healthy?"
  const capKey = (s: ScoredModel): number => r3(wFit * s.fit + wCost * s.cs + wSpeed * s.ss);
  // scored is provably non-empty here (pool passed the empty check above and
  // the breaker filter never removes the last candidate).
  const wanted = [...scored].sort((a, b) => capKey(b) - capKey(a) || a.spec.id.localeCompare(b.spec.id))[0]!;

  // Hard 429 veto (spec: repeated 429 for the chosen model → preemptively
  // pick its fallback). Soft rb scoring deprioritizes saturated models, but
  // the veto guarantees the dodge even when the saturated model's capability
  // fit dominates — fresh session errors outrank stale statistics.
  const saturated = wanted.recent429 >= 2;
  const primary = scored.find((s) => s.recent429 < 2) ?? scored[0]!; // all saturated ⇒ best of the bad
  const preempted = saturated && primary.spec.id !== wanted.spec.id;
  if (preempted) {
    signals.push({
      name: "preempt-429",
      value: wanted.spec.id,
      note: `${wanted.recent429}× 429 in session errors — capability-best dodged to ${primary.spec.id}`,
    });
  }

  const chosen = primary;
  const chosenHealth = health.get(chosen.spec.id);
  const effChosen = chosen.eff;
  const healthWord = effChosen >= UNHEALTHY_PENALTY ? "unhealthy" : effChosen >= DEGRADED_PENALTY ? "degraded" : "healthy";

  if (input.role === "reviewer" && lastCoder) {
    signals.push({
      name: "fresh-eyes",
      value: lastCoder,
      note: canDiversify
        ? chosen.spec.id !== lastCoder
          ? `reviewer ${chosen.spec.id} ≠ coder ${lastCoder}`
          : `only ${lastCoder} fits — diversity impossible`
        : `diversity skipped (${lastCoder} is the only candidate)`,
    });
  }

  const ctxHeadroom = chosen.spec.ctxWindow / Math.max(1, needTokens);
  signals.push(
    { name: "complexity", value: cx, note: "final clamped estimate" },
    {
      name: "role-fit",
      value: chosen.fit,
      note: `${input.role} wants tier=${desiredTier(input.role, cx)}, model tier=${tierOf(chosen.spec)} (tags: ${chosen.spec.tags.join(",") || "none"})`,
    },
    {
      name: "health",
      value: healthWord,
      note: `fail429=${r2(chosenHealth?.fail429 ?? 0)} fail5xx=${r2(chosenHealth?.fail5xx ?? 0)} penalty=${effChosen} ema=${fmtEma(chosenHealth?.latencyEmaMs ?? 0)} breaker=${chosen.bState}`,
    },
    { name: "rate-budget", value: chosen.rb, note: `${chosen.recent429}× 429 seen in session errors` },
    {
      name: "ctx-headroom",
      value: r2(ctxHeadroom),
      note: `need≈${needTokens} tok (×1.3 safety) vs ctxWindow ${chosen.spec.ctxWindow}`,
    },
    {
      name: "cost",
      value: chosen.cs,
      note: `$${r2((chosen.spec.costInPerM + chosen.spec.costOutPerM) / 2)}/M blended${chosen.spec.costInPerM === 0 && chosen.spec.costOutPerM === 0 ? " (free)" : ""}`,
    },
    {
      name: "speed",
      value: chosen.ss,
      note:
        (chosenHealth?.latencyEmaMs ?? 0) > 0
          ? `measured ema ${fmtEma(chosenHealth!.latencyEmaMs)}`
          : chosen.spec.tags.includes("fast")
            ? "no measurements yet — 'fast' tag prior"
            : "no measurements yet — neutral prior",
    },
  );

  // Fallbacks: the next two distinct ids in final ranked order.
  const fallbacks: string[] = [];
  for (const s of scored) {
    if (s.spec.id === chosen.spec.id) continue;
    if (fallbacks.includes(s.spec.id)) continue;
    fallbacks.push(s.spec.id);
    if (fallbacks.length === 2) break;
  }

  const extras: string[] = [];
  if (preempted) extras.push("preempt-429");
  if (budgetTight) extras.push("budget-tight");
  if (budgetGone) extras.push("budget-forced-cheap");
  if (ctxRelaxed) extras.push("ctx-relaxed");
  const extraStr = extras.length ? extras.map((e) => ` + ${e}`).join("") : "";

  const reason = `complexity=${cx.toFixed(2)} + role=${input.role} + ${healthWord}(ema=${fmtEma(chosenHealth?.latencyEmaMs ?? 0)})${extraStr} → ${chosen.spec.id}`;

  // Remember the coder pick so a later reviewer call can avoid it.
  if (input.role === "coder") lastCoderBySession.set(input.sessionId, chosen.spec.id);

  // r7-A: the decision itself is debug (high-frequency); the orchestrator
  // mirrors it at info level where it has task context.
  log("debug", "router", "decision", {
    sessionId: input.sessionId, role: input.role, model: chosen.spec.id,
    complexity: cx, total: chosen.total, fallbacks,
    reason,
  });

  return {
    modelId: chosen.spec.id,
    provider: chosen.spec.provider,
    reason,
    signals,
    complexity: cx,
    fallbacks,
    at: now,
  };
}

/**
 * Probes all enabled models in parallel with a 1-token prompt at startup.
 * Automatically discovers responsive models and penalizes 503s/dead models upfront.
 *
 * Only probes real tier-S models (one per provider) — the fastest models we
 * actually route to. Skips virtual engine/* aliases (they loop back into the
 * router and have no upstream). Staggered 500ms apart to avoid burst.
 */
export async function probeAllModels(): Promise<void> {
  const all = registry.list().filter((m) => m.enabled);
  if (!all.length) return;

  // Skip virtual engine/* aliases — they re-enter the router, not upstream.
  // Pick the single best tier-S candidate per provider (prefer tag "tier-s").
  // If a provider has no tier-s model, fall back to whichever model it has first.
  const byProvider = new Map<string, (typeof all)[0]>();
  for (const m of all) {
    if (m.id.startsWith("engine/")) continue; // virtual — skip
    const isTierS = m.tags?.includes("tier-s") ?? false;
    const existing = byProvider.get(m.provider);
    if (!existing || (isTierS && !existing.tags?.includes("tier-s"))) {
      byProvider.set(m.provider, m);
    }
  }

  const probeList = [...byProvider.values()];
  if (!probeList.length) return;
  logger.info("router", `startup probe: ${probeList.length} models (one tier-S per provider) — skipping ${all.length - probeList.length} others`);

  for (const m of probeList) {
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await chat({
        modelId: m.id,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1,
        temperature: 0,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latency = Date.now() - t0;
      recordOutcome(m.id, true, latency, 200);
      logger.info("router", `probe ${m.id} ok (${latency}ms)`);
    } catch (err: any) {
      const latency = Date.now() - t0;
      // Low-item fix: a status-less failure (network down, DNS, refused
      // connect) used to be filed as a literal 503. Pass the real status when
      // there is one and undefined otherwise — recordOutcome already treats
      // status-less outcomes as network failures without fabricating a code.
      const status = err?.name === "AbortError" ? 504 : typeof err?.status === "number" ? err.status : undefined;
      recordOutcome(m.id, false, latency, status);
      logger.info("router", `probe ${m.id} failed (${status ?? "no-status"}, ${Date.now() - t0}ms)`);
    }
    // 500ms between probes — gentler than 150ms, still completes quickly
    await new Promise((r) => setTimeout(r, 500));
  }
  logger.info("router", "startup probe complete");
}

