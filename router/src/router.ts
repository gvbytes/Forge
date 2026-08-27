/**
 * Router: decides {provider, model, tier, reason} for a chat completion request.
 *
 * It composes policy primitives into one live decision:
 *   classify(body, ctx)            -> complexity tier + transparent reasons
 *   Cascade (per x-engine-task)    -> historyFailures feed ctx; outcomes recorded
 *   budgetMode(telemetry task row) -> normal | finalize | halt governor state
 *   selectProvider(tier, states)   -> concrete provider+model by headroom/cost
 *
 * Tier overrides: `x-router-tier` header or an `engine/small|medium|large`
 * body model alias maps straight to S/M/L. The proxy rewrites aliased bodies to
 * the selected concrete model id before forwarding.
 *
 * Every reason string composes classify reasons + budget mode + provider health
 * note and is returned to callers via x-engine-route.
 */
import { DEFAULT_ROLE_PINS } from "./providers.js";
import { priorityRank } from "./policy/select.js";
import type { Provider, Tier, HealthSnapshotEntry } from "./providers";
import { isTier, healthSnapshot, isProviderHealthy, priceFor, rpmLastMinute, TIERS } from "./providers";
import { classify, contentText } from "./policy/classify";
import { Cascade } from "./policy/cascade";
import { budgetMode, type BudgetMode } from "./policy/budget";
import { headroom, selectProvider, type ProviderState } from "./policy/select";
import type { Telemetry } from "./telemetry";

export interface SessionState {
  session?: string;
  task?: string;
  forceModel?: string;
  forceTier?: Tier;
  /** Agent role; "coder" assumed when omitted (L reserved for planner/diagnostician). */
  role?: string;
  /**
   * Size of the injected context / repo map in tokens (from x-context-tokens).
   * Defaults to 0.
   */
  repoMapTokens?: number;
}

export interface RouteDecision {
  providerId: string;
  model: string;
  tier: Tier;
  reason: string;
}

export interface RouteCandidate {
  providerId: string;
  model: string;
  tier: Tier;
}

/** Receives an explanation when the policy returns no decision (503 path). */
export type NullReasonSink = (reason: string) => void;

/**
 * Policy module contract — kept stable so tests can inject their own policy.
 * Implementations may ignore the optional `nullReason` sink.
 */
export interface RoutePolicy {
  name: string;
  pickRoute(
    reqBody: unknown,
    sessionState: SessionState,
    candidates: readonly RouteCandidate[],
    nullReason?: NullReasonSink,
  ): RouteDecision | null;
}

/**
 * Outcome feedback channel implemented by RouteService and consumed by the
 * proxy: upstream success (2xx with usage) / final fallback failure.
 */
export interface RouteOutcomeSink {
  notifyOutcome(taskId: string | null, outcome: "success" | "failure", tier?: Tier): void;
}

// ---------------------------------------------------------------------------
// engine/* model aliases -> tier override
// ---------------------------------------------------------------------------

const ALIAS_TIERS: Readonly<Record<string, Tier>> = {
  "engine/small": "S",
  "engine/medium": "M",
  "engine/large": "L",
};

/** Map a request body model like "engine/medium" to its tier, else undefined. */
export function aliasTierFor(model: unknown): Tier | undefined {
  if (typeof model !== "string") return undefined;
  const hit = ALIAS_TIERS[model.trim().toLowerCase()];
  return isTier(hit) ? hit : undefined;
}

function normalizeBody(reqBody: unknown): { messages: Array<{ role: string; content: string }>; tools?: unknown[] } {
  const out: { messages: Array<{ role: string; content: string }>; tools?: unknown[] } = { messages: [] };
  if (reqBody === null || typeof reqBody !== "object") return out;
  const rec = reqBody as Record<string, unknown>;
  if (Array.isArray(rec["messages"])) {
    out.messages = rec["messages"]
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
      .map((m) => ({
        role: String(m["role"] ?? ""),
        content: contentText(m["content"]),
      }));
  }
  if (Array.isArray(rec["tools"])) out.tools = rec["tools"];
  return out;
}

interface RouteTaskState {
  cascade: Cascade;
  /** Verification failures observed for this task (feeds classify's escalate). */
  failures: number;
}

// ---------------------------------------------------------------------------
// RouteService — live routing policy
// ---------------------------------------------------------------------------

export interface RouteServiceDeps {
  telemetry: Pick<Telemetry, "getTask">;
  providers: Provider[];
  /**
   * Free-tier lock. When true (the DEFAULT — see index.ts) the router will
   * never select a priced model, at any tier or budget mode. See the rationale
   * block on SelectOpts.freeOnly: one cent of spend costs the same score as
   * 163 seconds of wall clock, so paying for capability is almost never
   * rational under the evaluation formula.
   */
  freeOnly?: boolean;
}

export class RouteService implements RoutePolicy, RouteOutcomeSink {
  readonly name = "route-service:classify+cascade+budget+headroom";
  private readonly tasks = new Map<string, RouteTaskState>();
  /** Live-togglable free-tier lock (POST /policy/free-tier). */
  private freeOnly: boolean;
  /**
   * Role -> preferred model id. Capability pinning, borrowed from the Forge
   * prototype, which assigns a specific model to each of its four roles by what
   * that role is good at rather than by size alone.
   *
   * Tier routing answers "how hard is this?"; it cannot answer "which of these
   * equally-sized models is better at reviewing?". Within a tier this router
   * ranks by headroom and cost, so a coder and a reviewer on the same tier get
   * whichever model happens to be least busy — capability never enters into it.
   *
   * A pin is a PREFERENCE, not an override: the model must still be in the
   * catalog (so the <=80B invariant holds), still healthy, and still allowed by
   * the free-tier lock. If any of that fails the normal tier selection runs, so
   * a stale pin degrades instead of breaking routing.
   */
  private rolePins = new Map<string, string>();

  constructor(private readonly deps: RouteServiceDeps) {
    this.freeOnly = deps.freeOnly !== false;
    // Ship the researched assignment as the default rather than leaving every
    // role on generic tier scoring. An operator can still override any pin,
    // and an unusable pin falls through to scoring on its own.
    for (const [role, model] of Object.entries(DEFAULT_ROLE_PINS)) {
      this.rolePins.set(role, model);
    }
  }

  /** Current free-tier lock state (surfaced by GET /routes for the UI). */
  get freeTierOnly(): boolean {
    return this.freeOnly;
  }

  /** Operator toggle — the Settings screen flips this at runtime. */
  setFreeTierOnly(on: boolean): void {
    this.freeOnly = on;
  }

  /** Pin a role to a model, or clear it by passing null. */
  setRolePin(role: string, model: string | null): void {
    if (model) this.rolePins.set(role, model);
    else this.rolePins.delete(role);
  }

  rolePinSnapshot(): Record<string, string> {
    return Object.fromEntries(this.rolePins);
  }

  /**
   * The pinned candidate for this role, if it is currently usable.
   * Returns null when unpinned, absent, unhealthy, or blocked by the lock —
   * every one of which falls through to normal tier selection.
   */
  private pinnedFor(role: string, candidates: readonly RouteCandidate[]): RouteCandidate | null {
    const want = this.rolePins.get(role);
    if (!want) return null;
    const hit = candidates.find((c) => c.model === want);
    if (!hit) return null;
    if (this.freeOnly && !this.isFreeCandidate(hit)) return null;
    if (!isProviderHealthy(hit.providerId)) return null;
    return hit;
  }

  /** True when this (provider, model) pair is billed at $0 by the catalog. */
  private isFreeCandidate(c: RouteCandidate): boolean {
    const price = priceFor(this.deps.providers, c.providerId, c.model);
    return price !== null && price.price_in === 0 && price.price_out === 0;
  }

  /** Test/introspection hook: per-task cascade bookkeeping snapshot. */
  taskSnapshot(): Array<{ taskId: string; failures: number }> {
    return [...this.tasks.entries()].map(([taskId, st]) => ({ taskId, failures: st.failures }));
  }

  private stateFor(taskId: string | null): RouteTaskState {
    const key = taskId ?? "(no-task)";
    let st = this.tasks.get(key);
    if (!st) {
      st = { cascade: new Cascade(key), failures: 0 };
      this.tasks.set(key, st);
    }
    return st;
  }

  /**
   * Proxy feedback: upstream success (2xx carrying usage) clears the failure
   * streak and advances demotion logic; a final fallback failure
   * escalates (next request for this task routes one tier higher).
   */
  notifyOutcome(taskId: string | null, outcome: "success" | "failure", tier?: Tier): void {
    const st = this.stateFor(taskId);
    if (outcome === "failure") {
      st.failures += 1;
      st.cascade.onFailure();
      return;
    }
    if (outcome === "success" && tier) {
      st.failures = 0;
      st.cascade.onSuccess(tier);
    }
  }

  pickRoute(
    reqBody: unknown,
    sessionState: SessionState,
    candidates: readonly RouteCandidate[],
    nullReason?: NullReasonSink,
  ): RouteDecision | null {
    const noRoute = (reason: string): null => {
      nullReason?.(reason);
      return null;
    };
    if (candidates.length === 0) return noRoute("no keyed healthy candidates");

    const body = normalizeBody(reqBody);
    const role = sessionState.role ?? "coder";
    const st = this.stateFor(sessionState.task ?? null);

    // --- overrides ---------------------------------------------------------
    const forceModel = sessionState.forceModel;
    if (forceModel) {
      const hit = candidates.find((c) => c.model === forceModel);
      if (!hit) return noRoute(`forced:model=${forceModel} exists nowhere healthy`);
      // A pinned model is explicit operator intent and overrides the lock, but
      // the route reason says so out loud — routing decisions can never be
      // hidden (PS 3b), and "this specific call costs money" is exactly the
      // kind of decision the user must be able to see.
      const paidOverride = this.freeOnly && !this.isFreeCandidate(hit);
      return {
        providerId: hit.providerId,
        model: hit.model,
        tier: hit.tier,
        reason:
          `forced:model=${forceModel}; budget:${this.budgetModeFor(sessionState)}; ` +
          `provider ${hit.providerId} chosen (forced exact model)` +
          (paidOverride ? "; ⚠ PAID model — free-tier lock overridden by explicit pin" : ""),
      };
    }
    // Role pin: capability preference, consulted before tier classification but
    // AFTER an explicit force, which is stronger operator intent.
    const pinned = this.pinnedFor(role, candidates);
    if (pinned && !sessionState.forceTier && !aliasTierFor(this.rawModel(reqBody))) {
      return {
        providerId: pinned.providerId,
        model: pinned.model,
        tier: pinned.tier,
        reason:
          `role pin: ${role} -> ${pinned.model}; budget:${this.budgetModeFor(sessionState)}; ` +
          `provider ${pinned.providerId} chosen (capability pin, healthy${this.freeOnly ? ", free-tier" : ""})`,
      };
    }

    const alias = aliasTierFor(this.rawModel(reqBody));
    const forceTier = sessionState.forceTier ?? alias;

    // --- complexity classification + cascade floor -------------------------
    const cplx = classify(body, {
      role,
      historyFailures: st.failures,
      repoMapTokens: sessionState.repoMapTokens ?? 0,
    });
    const cascadeFloor = st.cascade.currentFor(role);
    let tier: Tier;
    if (st.cascade.demoted) {
      tier = cascadeFloor;
    } else {
      tier = TIERS.indexOf(cascadeFloor) > TIERS.indexOf(cplx.tier) ? cascadeFloor : cplx.tier;
    }

    // --- budget governor state from telemetry task row ---------------------
    const budget = this.budgetFor(sessionState);

    // --- desired tier + availability fallback order ------------------------
    const desired: Tier = forceTier ?? tier;
    const roleAllowsL = role === "planner" || role === "diagnostician";
    const order: Tier[] = [desired];
    for (const t of TIERS) {
      if (t === desired) continue;
      if (t === "L" && !roleAllowsL && desired !== "L") continue; // never drift a coder up into L
      order.push(t);
    }

    // --- provider states (healthy only) ------------------------------------
    const now = Date.now();
    // Wave 25 P6: ONE health snapshot per request (used to be taken twice —
    // here and again inside providerStates).
    const snapshot = healthSnapshot(now);
    const states = this.providerStates(candidates, now, snapshot);

    const parts: string[] = [...cplx.reasons];
    if (forceTier) parts.push(`forced:tier=${forceTier}`);
    if (alias) parts.push(`alias ${this.rawModel(reqBody) ?? "?"} -> ${alias}`);
    if (st.cascade.demoted && !forceTier) {
      parts.push(`cascade demoted -> floor ${cascadeFloor} (cost-saving overrides classify)`);
    } else if (!forceTier && cascadeFloor !== "S") {
      parts.push(`cascade floor ${cascadeFloor}${tier !== cplx.tier && tier === cascadeFloor ? " (escalated)" : ""}`);
    }

    if (this.freeOnly) parts.push("free-tier lock: priced models excluded");

    for (const tier of order) {
      const pool = states.filter((p) => p.tiers.includes(tier));
      const sel = selectProvider(tier, pool, budget.mode, { now: () => now, freeOnly: this.freeOnly });
      if (!sel) continue;

      let best: RouteCandidate | null = null;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        if (c.providerId !== sel.id || c.tier !== tier) continue;
        // A provider can be free at one model and priced at another; the pool
        // filter only proved the provider has SOME free model, so re-check the
        // concrete pair here or the lock leaks at the model level.
        if (this.freeOnly && !this.isFreeCandidate(c)) continue;
        const price = priceFor(this.deps.providers, c.providerId, c.model);
        const blend = price ? (price.price_in + price.price_out) / 2 : Number.POSITIVE_INFINITY;
        if (blend < bestCost) {
          best = c;
          bestCost = blend;
        }
      }
      if (!best) continue;

      if (tier !== desired) parts.push(`degrade ${desired}->${tier}: no eligible ${desired} provider`);
      parts.push(`budget:${budget.mode}${budget.note}`);
      parts.push(this.healthNote(sel, snapshot[sel.id], now));
      return { providerId: best.providerId, model: best.model, tier, reason: parts.join("; ") };
    }

    if (budget.mode === "halt") {
      return noRoute(`budget:halt — governor stopped spending${budget.note}`);
    }

    // B23: alias last-resort — when no tier provider is eligible, route the
    // least-bad candidate anyway (mirrors the forced-model branch). This lets
    // alias traffic produce the markSuccess() that self-heals consecutive_429
    // instead of 503-ing forever while an explicit model name would route.
    const leastBad = this.leastBadCandidate(candidates, snapshot, desired);
    if (leastBad) {
      parts.push(
        `last-resort: no eligible provider for ${order.join("/")}, routing least-bad ${leastBad.providerId} to self-heal 429s`,
      );
      parts.push(`budget:${budget.mode}${budget.note}`);
      return { providerId: leastBad.providerId, model: leastBad.model, tier: leastBad.tier, reason: parts.join("; ") };
    }

    return noRoute(`no eligible provider for tier(s) ${order.join("/")} under budget:${budget.mode}`);
  }

  private rawModel(reqBody: unknown): string | undefined {
    if (reqBody === null || typeof reqBody !== "object") return undefined;
    const v = (reqBody as Record<string, unknown>)["model"];
    return typeof v === "string" ? v : undefined;
  }

  private budgetFor(sessionState: SessionState): { mode: BudgetMode; note: string } {
    const task = sessionState.task ? this.deps.telemetry.getTask(sessionState.task) : null;
    if (!task) return { mode: "normal", note: " (no task ledger)" };
    const ledger = {
      spentUsd: task.spent_usd,
      elapsedS: task.started_ts ? Math.max(0, (Date.now() - task.started_ts) / 1000) : 0,
      budgetUsd: task.budget_usd,
      wallS: task.wall_deadline_s,
    };
    return {
      mode: budgetMode(ledger),
      note: ` ($${task.spent_usd.toFixed(4)}/$${task.budget_usd}, ${Math.round(ledger.elapsedS)}s/${task.wall_deadline_s}s)`,
    };
  }

  private budgetModeFor(sessionState: SessionState): BudgetMode {
    return this.budgetFor(sessionState).mode;
  }

  /** Collapse candidate pairs into one ProviderState per healthy provider.
   *  Wave 25 P6: the health snapshot is passed in by the caller so a single
   *  request takes exactly one snapshot instead of one per helper. */
  private providerStates(
    candidates: readonly RouteCandidate[],
    now: number,
    snapshot: Record<string, HealthSnapshotEntry>,
  ): ProviderState[] {
    interface Acc {
      tiers: Set<Tier>;
      costMin?: number;
    }
    const acc = new Map<string, Acc>();
    for (const c of candidates) {
      let a = acc.get(c.providerId);
      if (!a) {
        a = { tiers: new Set() };
        acc.set(c.providerId, a);
      }
      a.tiers.add(c.tier);
      const price = priceFor(this.deps.providers, c.providerId, c.model);
      if (price) {
        const blend = (price.price_in + price.price_out) / 2;
        a.costMin = a.costMin === undefined ? blend : Math.min(a.costMin, blend);
      }
    }

    const states: ProviderState[] = [];
    const allStates: ProviderState[] = [];
    for (const [id, a] of acc) {
      const rpmUsed = rpmLastMinute(id, now);
      const isHealthy = isProviderHealthy(id, now);
      const entry: ProviderState = {
        id,
        tiers: [...a.tiers],
        healthy: isHealthy,
        consecutive429: snapshot[id]?.consecutive_429 ?? 0,
        rpmWindow: Array.from({ length: rpmUsed }, () => now - 1000),
        costPerMTok: a.costMin,
      };
      allStates.push(entry);
      if (isHealthy) states.push(entry);
    }
    return states.length > 0 ? states : allStates;
  }

  private healthNote(sel: ProviderState, snap: { cooldown_until_ts: number | null } | undefined, now: number): string {
    const cooling = snap?.cooldown_until_ts && snap.cooldown_until_ts > now ? ", recently rate-limited" : "";
    return (
      `provider ${sel.id} chosen: headroom ${headroom(sel, now).toFixed(2)}, ` +
      `429x${sel.consecutive429 ?? 0}, rpm ${sel.rpmWindow?.length ?? 0}/30${cooling}`
    );
  }

  /** B23: pick the "least-bad" candidate when no provider is eligible — prefer the
   * desired tier, then the fewest consecutive 429s. Lets alias traffic keep flowing
   * (and self-heal via markSuccess) instead of 503-ing while explicit models route. */
  private leastBadCandidate(
    candidates: readonly RouteCandidate[],
    snapshot: Record<string, HealthSnapshotEntry>,
    desired: Tier,
  ): RouteCandidate | null {
    if (candidates.length === 0) return null;
    // The free-tier lock outranks self-healing: this last-resort path exists to
    // keep alias traffic flowing, never to authorize spending. If nothing free
    // remains we return null and the caller 503s, which is the correct outcome
    // — a 503 costs $0, and the engine's fallback chain handles it.
    const pool = this.freeOnly ? candidates.filter((c) => this.isFreeCandidate(c)) : candidates;
    if (pool.length === 0) return null;
    let best: RouteCandidate | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of pool) {
      const c429 = snapshot[c.providerId]?.consecutive_429 ?? 0;
      const score = (c.tier === desired ? 0 : 1) * 1000 + c429;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }
}

export interface PlanOptions {
  policy: RoutePolicy;
  providers: Provider[];
  /** Whether a usable API key can be resolved for the provider right now. */
  keyPresent: (providerId: string) => boolean;
  body: unknown;
  session: SessionState;
}

export interface PlanResult {
  decision: RouteDecision | null;
  chain: RouteCandidate[];
  nullReason: string | null;
}

export function planRoute(opts: PlanOptions): PlanResult {
  // Tier routing ranks models by task COMPLEXITY, and a vision or speech model
  // on that ladder is not a worse pick but a broken one — a code question
  // routed to Whisper cannot produce an answer at all. So non-text models are
  // kept out of the candidate pool...
  //
  // ...with one exception: a model named explicitly via forceModel. That is a
  // caller stating exactly what it needs, which is how the vision path asks for
  // the vision model. Admitting it here rather than short-circuiting keeps the
  // whole downstream path intact — the policy still applies the free-tier lock
  // and writes a real route reason, and the attempt chain still spans every
  // provider serving that id, so a 429 on the first still falls through.
  const forced = opts.session.forceModel;
  const candidates: RouteCandidate[] = [];
  for (const p of opts.providers) {
    for (const m of p.models) {
      if (!opts.keyPresent(p.id)) continue;
      if (!isProviderUsable(opts, p.id)) continue;
      const isText = (m.modality ?? "text") === "text";
      if (!isText && m.model_id_per_provider !== forced) continue;
      candidates.push({ providerId: p.id, model: m.model_id_per_provider, tier: m.tier });
    }
  }

  let nullReason: string | null = null;
  const decision = opts.policy.pickRoute(opts.body, opts.session, candidates, (r) => {
    nullReason = r;
  });
  if (!decision) return { decision: null, chain: [], nullReason };

  let chain: RouteCandidate[];
  if (opts.session.forceModel && !opts.session.forceTier) {
    chain = candidates.filter((c) => c.model === opts.session.forceModel);
  } else {
    const tierChain = candidates.filter((c) => c.tier === decision.tier);
    // B38: start the attempt chain with the policy-selected provider, then the
    // remaining same-tier candidates — ordered by operator preference rather
    // than registry position, so a fallback after an error lands on the next
    // PREFERRED provider instead of whichever happened to be declared first in
    // the catalog (zen, as it happened, purely by declaration order).
    chain = [
      ...tierChain.filter((c) => c.providerId === decision.providerId),
      ...tierChain
        .filter((c) => c.providerId !== decision.providerId)
        .sort((a, b) => priorityRank(a.providerId) - priorityRank(b.providerId)),
    ];
  }
  return { decision, chain, nullReason };
}

function isProviderUsable(_opts: PlanOptions, _providerId: string): boolean {
  return true;
}
