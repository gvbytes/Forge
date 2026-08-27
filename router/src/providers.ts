/**
 * Provider registry + in-memory health counters for the router.
 *
 * Design constraint: every seeded model must be OPEN-WEIGHT with <=80B TOTAL parameters.
 * `param_b` is enforced as a data invariant here; the router only ever offers models
 * from this table, so a model not in the table can never be routed to.
 *
 * TOTAL, not active. Mixture-of-experts models routinely advertise their ACTIVE
 * parameter count in the model id (`...-120b-a12b` = 120B total, 12B active), and
 * several otherwise-attractive free models are ineligible on total count alone.
 * `param_b` below is always the TOTAL.
 *
 * Prices are USD per 1M tokens. Every seeded model is 0/0 — the catalog is
 * free-tier only by construction, so the router cannot spend money even with the
 * free-tier lock disabled.
 */

export type Tier = "S" | "M" | "L";

export const TIERS: readonly Tier[] = ["S", "M", "L"];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** Hard design cap on TOTAL parameters (billions). */
export const MAX_PARAM_B = 80;

export interface ModelEntry {
  /** Exact model id sent to the provider's chat endpoint. */
  model_id_per_provider: string;
  /**
   * What kind of input this model consumes.
   *
   * Tier routing exists to pick a TEXT model by task complexity. A vision or
   * speech model has no meaningful place on that ladder — routing a code
   * question to Whisper is not a worse choice, it is a broken one — so
   * non-text models are excluded from tier candidates and are instead looked
   * up explicitly by the capability the caller needs.
   */
  modality?: "text" | "vision" | "transcription";
  tier: Tier;
  ctx_window: number;
  /** USD per 1M input tokens. 0 for free. */
  price_in: number;
  /** USD per 1M output tokens. 0 for free. */
  price_out: number;
  /** TOTAL parameter count in billions — must be <= MAX_PARAM_B. */
  param_b: number;
  /** Which upstream API serves this model. Some models (e.g. muse-spark) are
   *  only reachable via the OpenAI Responses API (`/responses`), not
   *  `/chat/completions`. Default: chat_completions. */
  endpoint?: "chat_completions" | "responses";
}

export interface Provider {
  id: string;
  kind: "openai-compatible";
  baseURL: string;
  /** Env var fallback when the keys table has no row for this provider. */
  envKey: string;
  /** Rate limits / quirks worth knowing at routing time. */
  notes: string;
  models: ModelEntry[];
}

function model(
  id: string,
  tier: Tier,
  ctxWindow: number,
  paramB: number,
  priceIn = 0,
  priceOut = 0,
  endpoint?: "chat_completions" | "responses",
  modality: "text" | "vision" | "transcription" = "text",
): ModelEntry {
  if (paramB > MAX_PARAM_B) {
    throw new Error(`model ${id} has ${paramB}B params > ${MAX_PARAM_B}B design cap`);
  }
  return {
    model_id_per_provider: id,
    modality,
    tier,
    ctx_window: ctxWindow,
    price_in: priceIn,
    price_out: priceOut,
    param_b: paramB,
    ...(endpoint ? { endpoint } : {}),
  };
}

/**
 * Seed registry. Order matters: the policy picks the first healthy
 * candidate in this order within the requested tier.
 */
export const DEFAULT_PROVIDERS: Provider[] = [
  {
    /**
     * NVIDIA NIM is the ONLY text provider.
     *
     * The catalog was four providers deep; three of them were removed rather
     * than left as dormant fallbacks, because an unused provider is not free —
     * it is a model list that silently rots. NIM retires aggressively (two
     * previously-catalogued ids here returned 410 Gone), and openrouter/zen
     * carried ids nobody had verified in weeks. A fallback you have not
     * exercised is a fallback that fails when you finally need it.
     *
     * Resilience comes instead from THREE NIM keys on three separate accounts.
     * That is a stronger guarantee than it looks: separate accounts mean
     * unambiguously separate rate-limit quotas, whereas multiple keys on one
     * account may share a single 40 RPM budget.
     *
     * The residual risk is stated plainly: this does NOT survive a NIM outage
     * or a model EOL. Both are provider-wide and no number of keys helps.
     */
    id: "nvidia-nim",
    kind: "openai-compatible",
    baseURL: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_NIM_API_KEY",
    notes:
      "Sole text provider. Three keys (three accounts) give independent 40 RPM quotas. " +
      "NIM retires models aggressively — run `bun run preflight` before relying on it.",
    models: [
      // ── S: high-frequency, low-difficulty work ──────────────────────────
      // Explorer, summarizer, triage. MoE with only 3.6B active, ~440ms
      // observed here, and 97% tool-call accuracy in published evals. These
      // roles fire many times per task, so this is where latency compounds —
      // and T is scored directly.
      model("openai/gpt-oss-20b", "S", 128000, 20),

      // ── M: the working tier ─────────────────────────────────────────────
      // CODER. RL-trained specifically on multi-step tool use and structured
      // output, which is literally this role's job. Best SWE-bench Verified of
      // the four (52.8%); PinchBench 85.4 measures real coding-AGENT behaviour
      // rather than one-shot generation, which is what this system does.
      model("nvidia/nemotron-3.5-lightning-30b-a3b", "M", 128000, 30),

      // REVIEWER. Chosen as much for being DIFFERENT as for being good: a
      // model reviewing its own output shares its own blind spots and passes
      // exactly the mistakes it is prone to making. Dense Meta lineage against
      // the coder's NVIDIA MoE. MCP-Atlas 75.5%, and it diagnoses failed tool
      // calls instead of halting on them.
      model("meta/muse-glimmer-30b", "M", 128000, 30),

      // ── L: think hard, rarely ───────────────────────────────────────────
      // PLANNER. Strongest reasoning of the four by a wide margin (AIME 89.2%,
      // LiveCodeBench v6 80.0%, GPQA-D 84.3%). It is also the slowest — 12.4s
      // observed for a trivial reply — so it belongs where a call happens once
      // or twice per task and a bad output poisons everything downstream. It
      // would be the wrong choice anywhere inside a loop.
      model("google/gemma-4-31b-it", "L", 262_144, 31),

      // ── Vision ──────────────────────────────────────────────────────────
      // Kept as a dedicated model despite muse-glimmer being multimodal on
      // paper: asked about an image through NIM, muse-glimmer returned null
      // content with the prompt echoed into reasoning_content, i.e. it did not
      // read the image. This one answered correctly. Measured, not assumed.
      // 11B — its 90B sibling would breach the 80B cap.
      model("meta/llama-3.2-11b-vision-instruct", "M", 128000, 11, 0, 0, undefined, "vision"),
    ],
  },
  {
    /**
     * Groq is retained for ONE capability: speech-to-text.
     *
     * It serves no text tier and cannot be selected for any agent role — it is
     * absent from tier routing entirely. It is here because NVIDIA does not
     * serve ASR on its hosted API at all (whisper is absent from /v1/models,
     * five endpoint shapes 404, and only text-translation Riva models are
     * reachable); NVIDIA ships Whisper as a self-hosted container needing a GPU.
     *
     * So this is not a surviving "fallback provider" — removing it would
     * simply delete voice input.
     */
    id: "groq",
    kind: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    notes: "Transcription only — serves no text tier and cannot be routed to for any agent role.",
    models: [
      model("whisper-large-v3", "S", 0, 2, 0, 0, undefined, "transcription"),
    ],
  },
];

export function findProvider(providers: Provider[], id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

export interface PricedModel extends ModelEntry {
  providerId: string;
}

/** Flat list of every routable (provider, model) pair in registry order. */
export function allModels(providers: Provider[]): PricedModel[] {
  const out: PricedModel[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push({ ...m, providerId: p.id });
    }
  }
  return out;
}

export function priceFor(
  providers: Provider[],
  providerId: string,
  modelId: string,
): { price_in: number; price_out: number } | null {
  const p = findProvider(providers, providerId);
  if (!p) return null;
  const m = p.models.find((x) => x.model_id_per_provider === modelId);
  if (!m) return null;
  return { price_in: m.price_in, price_out: m.price_out };
}

// ---------------------------------------------------------------------------
// In-memory provider health counters (per process, resets on restart).
// ---------------------------------------------------------------------------

export interface ProviderHealthState {
  consecutive_429: number;
  /** B39: streak of consecutive 5xx responses (reset by any success or 429). */
  consecutive_5xx: number;
  last_rate_limit_ts: number | null;
  /** Epoch ms until which the provider is skipped due to rate limiting. */
  cooldown_until_ts: number | null;
  /** Rolling window (epoch ms) of successful forwards, pruned to RPM_WINDOW_MS. */
  rpm_timestamps: number[];
}

export const RPM_WINDOW_MS = 60_000;
// B21c: restored shipped cooldowns. Default 15s (a 429 with no Retry-After still
// means "back off"), max 300s so long Retry-After headers are honored, not truncated.
export const RATE_LIMIT_COOLDOWN_DEFAULT_S = 15;
export const RATE_LIMIT_COOLDOWN_MAX_S = 300;
/** Absolute circuit breaker so a dead provider cannot be hammered forever.
 * Relationship: policy/select.ts OPEN_CIRCUIT_429 (=5) excludes a provider from the
 * eligible pool at ≥5 consecutive 429s; MAX_CONSECUTIVE_429 is the hard ceiling at
 * which markRateLimited refuses to keep counting it as recoverable. 5 < 8 keeps the
 * select-pool trip below the hard breaker. */
export const MAX_CONSECUTIVE_429 = 8;
/** B39: after this many consecutive 5xx responses the provider is cooled down
 * (default cooldown) so a repeatedly-failing upstream stops being selected on
 * every request. The streak resets on any success; each further 5xx at/above
 * the threshold re-arms the cooldown. */
export const MAX_CONSECUTIVE_5XX = 3;

const health = new Map<string, ProviderHealthState>();

function stateFor(providerId: string): ProviderHealthState {
  let s = health.get(providerId);
  if (!s) {
    s = { consecutive_429: 0, consecutive_5xx: 0, last_rate_limit_ts: null, cooldown_until_ts: null, rpm_timestamps: [] };
    health.set(providerId, s);
  }
  return s;
}

function clampCooldown(seconds: number | null): number {
  const s = seconds ?? RATE_LIMIT_COOLDOWN_DEFAULT_S;
  // Non-finite input (NaN) must never leak into cooldown_until_ts: a NaN
  // deadline compares false against every clock, silently disabling cooldown.
  if (!Number.isFinite(s)) return RATE_LIMIT_COOLDOWN_DEFAULT_S;
  return Math.min(Math.max(Math.round(s), 1), RATE_LIMIT_COOLDOWN_MAX_S);
}

/** F7: recovery window after which a served rate-limit streak decays. A provider
 *  that hit the consecutive_429 ceiling used to be locked out forever (the counter
 *  only reset on success, which an excluded provider can never score). Once its
 *  cooldown has been served AND this long has passed since the last 429, we clear
 *  the streak so it gets another chance instead of needing a process restart. */
export const RATE_LIMIT_RECOVERY_WINDOW_MS = RATE_LIMIT_COOLDOWN_MAX_S * 1000;

function decay429IfDue(s: ProviderHealthState, nowMs: number): void {
  if (s.consecutive_429 <= 0 || s.last_rate_limit_ts === null) return;
  const cooldownServed = s.cooldown_until_ts === null || nowMs >= s.cooldown_until_ts;
  if (!cooldownServed) return;
  if (nowMs - s.last_rate_limit_ts >= RATE_LIMIT_RECOVERY_WINDOW_MS) {
    s.consecutive_429 = 0;
    s.consecutive_5xx = 0;
  }
}

export function markRateLimited(providerId: string, retryAfterSeconds?: number | null): void {
  const s = stateFor(providerId);
  s.consecutive_429 += 1;
  // A 429 is a controlled provider response — the server is answering, so any
  // 5xx streak is broken; keeping it would let a stale streak arm a premature
  // cooldown on a recovering provider.
  s.consecutive_5xx = 0;
  s.last_rate_limit_ts = Date.now();
  s.cooldown_until_ts = Date.now() + clampCooldown(retryAfterSeconds ?? null) * 1000;
}

/** B39: count a 5xx response against the provider. Once the streak reaches
 * MAX_CONSECUTIVE_5XX the provider is cooled down so it stops being selected
 * every request; the streak keeps counting so each further 5xx re-arms the
 * cooldown until a success resets it. Honors Retry-After when the failing
 * response carried one (e.g. 503 maintenance), else the default cooldown.
 * Re-arming only ever EXTENDS an armed cooldown — it never shortens one (a
 * recent 429 may have armed a much longer Retry-After). */
export function markServerError(providerId: string, retryAfterSeconds?: number | null): void {
  const s = stateFor(providerId);
  s.consecutive_5xx += 1;
  if (s.consecutive_5xx >= MAX_CONSECUTIVE_5XX) {
    const next = Date.now() + clampCooldown(retryAfterSeconds ?? null) * 1000;
    s.cooldown_until_ts = s.cooldown_until_ts !== null && s.cooldown_until_ts > next ? s.cooldown_until_ts : next;
  }
}

export function markSuccess(providerId: string): void {
  const s = stateFor(providerId);
  s.consecutive_429 = 0;
  s.consecutive_5xx = 0;
  s.cooldown_until_ts = null;
  s.rpm_timestamps.push(Date.now());
}

export function pruneRpm(providerId: string, nowMs = Date.now()): void {
  const s = stateFor(providerId);
  s.rpm_timestamps = s.rpm_timestamps.filter((t) => nowMs - t < RPM_WINDOW_MS);
}

export function rpmLastMinute(providerId: string, nowMs = Date.now()): number {
  pruneRpm(providerId, nowMs);
  return stateFor(providerId).rpm_timestamps.length;
}

export function isProviderHealthy(providerId: string, nowMs = Date.now()): boolean {
  const s = health.get(providerId);
  if (!s) return true;
  decay429IfDue(s, nowMs);
  if (s.cooldown_until_ts !== null && nowMs < s.cooldown_until_ts) return false;
  return s.consecutive_429 < MAX_CONSECUTIVE_429;
}

export interface HealthSnapshotEntry {
  consecutive_429: number;
  /** B39: streak of consecutive 5xx responses. */
  consecutive_5xx: number;
  last_rate_limit_ts: number | null;
  cooldown_until_ts: number | null;
  rpm_last_minute: number;
}

export function healthSnapshot(nowMs = Date.now()): Record<string, HealthSnapshotEntry> {
  const out: Record<string, HealthSnapshotEntry> = {};
  for (const [id] of health) {
    pruneRpm(id, nowMs);
    const s = stateFor(id);
    decay429IfDue(s, nowMs);
    out[id] = {
      consecutive_429: s.consecutive_429,
      consecutive_5xx: s.consecutive_5xx,
      last_rate_limit_ts: s.last_rate_limit_ts,
      cooldown_until_ts: s.cooldown_until_ts,
      rpm_last_minute: s.rpm_timestamps.length,
    };
  }
  return out;
}

/** Test hook: clear all counters. */
export function resetProviderHealth(): void {
  health.clear();
}


/**
 * First (provider, model) pair serving a given capability.
 *
 * Deliberately not part of tier routing: there is exactly one sensible vision
 * model and one sensible speech model in this catalog, so "which one" is a
 * lookup rather than a scored decision. Returns null when nothing serves the
 * capability, which the caller must surface — silently falling back to a text
 * model would produce a confident answer about an image it never saw.
 */
export function findByModality(
  providers: Provider[],
  modality: "vision" | "transcription",
): { providerId: string; model: ModelEntry } | null {
  for (const p of providers) {
    for (const m of p.models) {
      if (m.modality === modality) return { providerId: p.id, model: m };
    }
  }
  return null;
}


/**
 * Default role -> model assignment.
 *
 * Derived from published evals rather than guesswork, and from one principle
 * that outranks any benchmark: THE REVIEWER MUST NOT BE THE CODER. A model
 * grading its own output shares its own blind spots and will pass exactly the
 * mistakes it is prone to making, so coder and reviewer are deliberately
 * different lineages (NVIDIA MoE vs dense Meta) even though both sit on tier M.
 *
 *   planner     gemma-4-31b      strongest reasoning (AIME 89.2, LCB-v6 80.0);
 *                                also the slowest at ~12s, which is affordable
 *                                only because planning happens once per task
 *                                and a bad plan poisons every step after it.
 *   coder       nemotron-3.5     RL-trained on multi-step tool use + structured
 *                                output — this role's literal job. Best
 *                                SWE-bench Verified here (52.8%).
 *   reviewer    muse-glimmer     different lineage from the coder; MCP-Atlas
 *                                75.5%; recovers from failed tool calls rather
 *                                than halting.
 *   explorer/   gpt-oss-20b      ~440ms, 3.6B active, 97% tool-call accuracy.
 *   summarizer                   These fire many times per task, so this is
 *                                where latency actually compounds.
 *
 * Pins are DEFAULTS, not constraints: an unusable pin (rate-limited, unhealthy,
 * EOL'd) falls through to normal tier scoring rather than failing the call.
 */
export const DEFAULT_ROLE_PINS: Record<string, string> = {
  planner: "google/gemma-4-31b-it",
  coder: "nvidia/nemotron-3.5-lightning-30b-a3b",
  reviewer: "meta/muse-glimmer-30b",
  critic: "meta/muse-glimmer-30b",
  explorer: "openai/gpt-oss-20b",
  summarizer: "openai/gpt-oss-20b",
  triage: "openai/gpt-oss-20b",
};
