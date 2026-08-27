/**
 * Provider selection — pure/deterministic given an injected clock.
 *
 * selectProvider(tier, providers, budgetMode, opts) picks the highest-headroom
 * healthy provider offering `tier`.
 *
 * Eligibility: offers the tier · healthy !== false · consecutive429 < 5
 * (5 straight 429s => circuit considered open).
 *
 * Free providers (price_in + price_out === 0 => costPerMTok === 0) stay eligible
 * under finalize/halt so the agent can always emit a wrap-up message at $0;
 * only PAID models are excluded at halt. Unknown cost (costPerMTok undefined)
 * counts as paid.
 *
 * headroom(p) = free-rpm-fraction / (1 + consecutive429), where the free
 * fraction is (rpmLimit - requests in the last windowMs)/rpmLimit computed
 * from p.rpmWindow timestamps against the injected clock.
 *
 * Ranking:
 *   normal   -> headroom desc, then costPerMTok asc, then id asc (tie-break)
 *   finalize -> costPerMTok asc first (squeeze remaining budget), then headroom
 *   halt     -> free-only pool, then ranked like finalize (all costs are 0,
 *              so headroom decides); null when no free provider remains
 */
import type { Tier } from "./types";
import type { BudgetMode } from "./budget";

export interface ProviderState {
  id: string;
  /** Tiers this provider can serve. */
  tiers: Tier[];
  healthy?: boolean;
  /** Consecutive 429 responses seen (rate-limit pressure). */
  consecutive429?: number;
  /** Request timestamps (epoch ms) in the current rolling RPM window. */
  rpmWindow?: number[];
  /** Blended $ per million tokens — deterministic cost tie-break. */
  costPerMTok?: number;
}

export interface SelectOpts {
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** Requests per rolling window allowed before headroom hits 0. Default 30. */
  rpmLimit?: number;
  /** Sliding window width in ms. Default 60_000. */
  windowMs?: number;
  /**
   * Free-tier lock (scoring). When true the eligible pool is restricted to
   * costPerMTok === 0 at EVERY budget mode, not just "halt".
   *
   * Why this exists: the evaluation score is
   *   S = 10A / (1 + 0.65(C/0.15) + 0.35(T/1320))^2.5
   * Differentiating the denominator gives dD/dC = 4.333 per dollar against
   * dD/dT = 0.000265 per second, so ONE CENT of spend does the same damage as
   * 163 SECONDS of wall clock. At realistic token volumes the cost term
   * dominates the time term outright, and a single fallback to a priced 70B
   * model (~$0.26 on a long task) costs ~81% of the achievable score.
   *
   * Waiting is therefore almost always correct: a 15 s rate-limit backoff is
   * worth ~$0.0009, so ~10 consecutive backoffs still beat one $0.01 call.
   * Unknown cost (costPerMTok undefined) counts as paid and is excluded.
   */
  freeOnly?: boolean;
}

const DEFAULT_RPM_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;
export const OPEN_CIRCUIT_429 = 5;
const UNKNOWN_COST = Number.POSITIVE_INFINITY;

export function headroom(
  p: ProviderState,
  nowMs: number,
  rpmLimit = DEFAULT_RPM_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
): number {
  const used = (p.rpmWindow ?? []).filter((t) => nowMs - t < windowMs).length;
  const freeFraction = Math.max(0, rpmLimit - used) / rpmLimit;
  return freeFraction / (1 + (p.consecutive429 ?? 0));
}

export function isFreeProvider(p: ProviderState): boolean {
  return p.costPerMTok !== undefined && p.costPerMTok === 0;
}

/**
 * Preferred provider order, strongest first.
 *
 * Every provider here is free, so costPerMTok is 0 across the board and the
 * cost tie-break never fires. That left ALPHABETICAL id as the effective
 * decider — "groq" sorts before "nvidia-nim", so groq won essentially every
 * tie regardless of which provider the operator had actually provisioned for
 * the job. That is an accident of naming, not a routing decision.
 *
 * This makes the preference explicit and configurable. It ranks only among
 * providers that are ALREADY eligible (healthy, circuit closed) and that still
 * have request headroom, so a preference can never force traffic at a provider
 * that is rate-limited or down — preferring a dead provider would manufacture
 * exactly the API errors a preference is set to avoid.
 *
 * Override with PROVIDER_PRIORITY as a comma-separated id list. Unlisted
 * providers keep their relative order after the listed ones.
 */
export const PROVIDER_PRIORITY: string[] = (process.env.PROVIDER_PRIORITY ?? "nvidia-nim,groq,openrouter,zen")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Rank of a provider in PROVIDER_PRIORITY; unlisted sort last. */
export function priorityRank(id: string): number {
  const i = PROVIDER_PRIORITY.indexOf(id);
  return i === -1 ? PROVIDER_PRIORITY.length : i;
}

export function selectProvider(
  tier: Tier,
  providers: ProviderState[],
  budgetMode: BudgetMode,
  opts: SelectOpts = {},
): ProviderState | null {
  const nowMs = (opts.now ?? Date.now)();
  const rpmLimit = opts.rpmLimit ?? DEFAULT_RPM_LIMIT;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const eligible = providers.filter(
    (p) =>
      p.tiers.includes(tier) &&
      p.healthy !== false &&
      (p.consecutive429 ?? 0) < OPEN_CIRCUIT_429,
  );
  // Free-tier lock applies at EVERY mode; halt additionally forces it. Both
  // collapse to the same filter, so ordering here is irrelevant.
  const pool =
    opts.freeOnly || budgetMode === "halt" ? eligible.filter(isFreeProvider) : eligible;
  if (pool.length === 0) return null;

  const costOf = (p: ProviderState): number => p.costPerMTok ?? UNKNOWN_COST;
  const costFirst = budgetMode !== "normal";

  return pool.sort((a, b) => {
    if (costFirst) {
      const byCost = costOf(a) - costOf(b);
      if (byCost !== 0) return byCost;
    }
    const ha = headroom(a, nowMs, rpmLimit, windowMs);
    const hb = headroom(b, nowMs, rpmLimit, windowMs);
    // A provider with NO headroom left always loses, whatever its preference —
    // this is what keeps a preference from becoming a way to generate 429s.
    if ((ha > 0) !== (hb > 0)) return hb > 0 ? 1 : -1;
    // Among providers that can actually take the request, operator preference
    // decides. Previously this fell straight through to headroom and then to
    // alphabetical id.
    const byPriority = priorityRank(a.id) - priorityRank(b.id);
    if (byPriority !== 0) return byPriority;
    if (hb !== ha) return hb - ha;
    if (!costFirst) {
      const byCost = costOf(a) - costOf(b);
      if (byCost !== 0) return byCost;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}
