/**
 * Policy module tests — bun test, table-driven, no network.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { classify } from "../src/policy/classify";
import { Cascade, startTier } from "../src/policy/cascade";
import {
  budgetMode,
  tokenBudgetRemaining,
  DEFAULT_BUDGET_USD,
  DEFAULT_WALL_S,
  HARD_CEILING_USD,
  HARD_CEILING_WALL_S,
  type BudgetMode,
} from "../src/policy/budget";
import {
  selectProvider,
  headroom,
  type ProviderState,
} from "../src/policy/select";
import { RouteService } from "../src/router";
import { resetProviderHealth, priceFor, type Provider, type Tier } from "../src/providers";

const msg = (role: string, content: unknown) => ({ role, content });
const body = (
  content: unknown,
  tools?: unknown[],
) => ({ messages: [msg("user", content)], ...(tools ? { tools } : {}) });
const ctx = (over: Record<string, unknown> = {}) => ({
  role: "coder",
  ...over,
});

describe("classify — signal thresholds", () => {
  const cases: Array<{
    name: string;
    content: unknown;
    messages?: Array<{ role: string; content: unknown }>;
    tools?: unknown[];
    ctx?: Record<string, unknown>;
    score: number;
    tier: "S" | "M" | "L";
    escalate?: boolean;
  }> = [
    {
      name: "trivial prompt -> S, score 0",
      content: "fix the typo in README",
      score: 0,
      tier: "S",
    },
    {
      name: "2100-char user prompt is BELOW the new 4000 bar -> 0",
      content: "x".repeat(2100),
      score: 0,
      tier: "S",
    },
    {
      name: "long user prompt (>4000 chars) -> +1 only, still S",
      content: "x".repeat(4100),
      score: 1,
      tier: "S",
    },
    {
      name: "huge SYSTEM scaffolding does not count — user chars decide",
      content: "fix typo",
      messages: [
        msg("system", "rules ".repeat(3000)),
        msg("assistant", "ok"),
        msg("user", "fix typo"),
      ],
      score: 0,
      tier: "S",
    },
    {
      name: "array-content parts are flattened ({type:text,text}) for char counting",
      content: [{ type: "text", text: "x".repeat(4100) }],
      score: 1,
      tier: "S",
    },
    {
      name: "3 file mentions (>2) -> +1 only",
      content: "update @src/a.ts and lib/b.py plus docs/c.md",
      score: 1,
      tier: "S",
    },
    {
      name: "hard keyword 'refactor' -> +2 -> M",
      content: "please refactor this module",
      score: 2,
      tier: "M",
    },
    {
      name: "'optimise' (british spelling) fires the hard-keyword class",
      content: "optimise this loop",
      score: 2,
      tier: "M",
    },
    {
      name: "'trace' does NOT trigger the 'race' keyword",
      content: "add a trace log line",
      score: 0,
      tier: "S",
    },
    {
      name: "4 tools is BELOW the new >8 bar -> 0",
      content: "run the suite",
      tools: [{}, {}, {}, {}],
      score: 0,
      tier: "S",
    },
    {
      name: "9 tools (>8) -> +1 only",
      content: "run the suite",
      tools: Array.from({ length: 9 }, () => ({})),
      score: 1,
      tier: "S",
    },
    {
      name: "repoMapTokens > 40000 -> +1 only",
      content: "summarize the repo",
      ctx: { repoMapTokens: 40001 },
      score: 1,
      tier: "S",
    },
    {
      name: "score >=4 -> L for planner",
      content: "refactor".padEnd(4100, "."),
      tools: Array.from({ length: 9 }, () => ({})),
      ctx: { role: "planner" },
      score: 4,
      tier: "L",
    },
    {
      name: "substantial creation task (make + game) -> +2 -> M",
      content: "make a 3d flappy bird game",
      score: 2,
      tier: "M",
    },
    {
      name: "creation task build + dashboard -> M",
      content: "build me an analytics dashboard",
      score: 2,
      tier: "M",
    },
    {
      name: "creation task create + website -> M",
      content: "create a portfolio website",
      score: 2,
      tier: "M",
    },
    {
      name: "creation verb without artifact noun stays S (make it faster)",
      content: "make it faster",
      score: 0,
      tier: "S",
    },
    {
      name: "artifact noun without creation verb stays S (the game is broken)",
      content: "the game is broken",
      score: 0,
      tier: "S",
    },
    {
      name: "same >=4 body with coder role capped to M (classification path)",
      content: "refactor".padEnd(4100, "."),
      tools: Array.from({ length: 9 }, () => ({})),
      ctx: { role: "coder" },
      score: 4,
      tier: "M",
    },
    {
      name: "historyFailures >=1 escalates S->M for coder",
      content: "fix typo",
      ctx: { historyFailures: 1 },
      score: 0,
      tier: "M",
      escalate: true,
    },
    {
      name: "classify-side escalation still cannot give coder L",
      content: "please refactor this module",
      ctx: { historyFailures: 2 },
      score: 2,
      tier: "M",
      escalate: true,
    },
    {
      name: "planner with failures reaches/stays L via escalation",
      content: "plan the refactor of the auth flow",
      ctx: { role: "planner", historyFailures: 1 },
      score: 2,
      tier: "L",
      escalate: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const b = c.messages
        ? { messages: c.messages, ...(c.tools ? { tools: c.tools } : {}) }
        : body(c.content, c.tools);
      const out = classify(b, ctx(c.ctx));
      expect(out.score).toBe(c.score);
      expect(out.tier).toBe(c.tier);
      expect(out.escalate).toBe(c.escalate ?? false);
      expect(out.reasons.length).toBeGreaterThan(0);
    });
  }
});

describe("cascade — outcome state machine", () => {
  it("startTier: coder starts S, planner/diagnostician start L", () => {
    expect(startTier("coder")).toBe("S");
    expect(startTier("reviewer")).toBe("S");
    expect(startTier("planner")).toBe("L");
    expect(startTier("diagnostician")).toBe("L");
  });

  it("failure escalates one tier per failure up to L", () => {
    const c = new Cascade("task-1");
    expect(c.currentFor("coder")).toBe("S");
    c.onFailure();
    expect(c.currentFor("coder")).toBe("M");
    c.onFailure();
    expect(c.currentFor("coder")).toBe("L");
    const p = new Cascade("task-2");
    expect(p.currentFor("planner")).toBe("L");
    p.onFailure();
    expect(p.currentFor("planner")).toBe("L");
  });

  it("two consecutive same-tier successes demote one tier for next subtask", () => {
    const c = new Cascade("task-3");
    c.onFailure();
    expect(c.currentFor("coder")).toBe("M");
    c.onSuccess("M");
    expect(c.currentFor("coder")).toBe("M");
    expect(c.demoted).toBe(false);
    c.onSuccess("M");
    expect(c.currentFor("coder")).toBe("S");
    expect(c.demoted).toBe(true);
  });

  it("mixed-tier or interrupted streaks do not demote; failure clears progress", () => {
    const a = new Cascade("task-4");
    a.onFailure();
    a.onSuccess("M");
    a.onSuccess("S");
    expect(a.currentFor("coder")).toBe("M");
    expect(a.demoted).toBe(false);

    const b = new Cascade("task-5");
    b.onFailure();
    b.onSuccess("M");
    b.onFailure();
    b.onSuccess("M");
    expect(b.currentFor("coder")).toBe("L");

    const d = new Cascade("task-6");
    d.onSuccess("S");
    d.onSuccess("S");
    expect(d.currentFor("coder")).toBe("S");
    expect(d.demoted).toBe(false);
    d.onFailure();
    expect(d.currentFor("coder")).toBe("M");
  });
});

describe("RouteService — cascade floor participates in tier choice", () => {
  beforeEach(() => {
    resetProviderHealth();
  });

  const registryProvider = (): Provider => ({
    id: "p1",
    kind: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    envKey: "TEST_KEY",
    notes: "policy-test fixture",
    models: [
      { model_id_per_provider: "m-s", tier: "S", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 7 },
      { model_id_per_provider: "m-m", tier: "M", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 24 },
      { model_id_per_provider: "m-l", tier: "L", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 32 },
    ],
  });
  const candidates: Array<{ providerId: string; model: string; tier: "S" | "M" | "L" }> = [
    { providerId: "p1", model: "m-s", tier: "S" },
    { providerId: "p1", model: "m-m", tier: "M" },
    { providerId: "p1", model: "m-l", tier: "L" },
  ];
  const fakeTel = { getTask: () => null };

  it("demote-after-2-successes OVERRIDES classify: hard prompt routes S to save cost", () => {
    const rs = new RouteService({ telemetry: fakeTel, providers: [registryProvider()] });
    const t = "t-demote";
    rs.notifyOutcome(t, "failure");
    rs.notifyOutcome(t, "success", "M");
    rs.notifyOutcome(t, "success", "M");

    const d = rs.pickRoute(
      body(`please refactor this module ${"x".repeat(4200)}`),
      { role: "coder", task: t },
      candidates,
    );
    expect(d).not.toBeNull();
    expect(d!.tier).toBe("S");
    expect(d!.model).toBe("m-s");
    expect(d!.reason).toContain("cascade demoted");
  });

  it("failure escalation raises the FLOOR above classify and may carry a coder to L", () => {
    const rs = new RouteService({ telemetry: fakeTel, providers: [registryProvider()] });
    const t = "t-escalate";
    rs.notifyOutcome(t, "failure");
    rs.notifyOutcome(t, "failure");

    const d = rs.pickRoute(body("tiny task"), { role: "coder", task: t }, candidates);
    expect(d).not.toBeNull();
    expect(d!.tier).toBe("L");
    expect(d!.reason).toContain("cascade floor L");
  });

  it("without cascade pressure the same hard prompt still classifies to M", () => {
    const rs = new RouteService({ telemetry: fakeTel, providers: [registryProvider()] });
    const d = rs.pickRoute(
      body(`please refactor this module ${"x".repeat(4200)}`),
      { role: "coder", task: "t-fresh" },
      candidates,
    );
    expect(d!.tier).toBe("M");
  });
});

describe("budget governor — finalize/halt boundaries", () => {
  const cases: Array<{
    name: string;
    spentUsd: number;
    elapsedS: number;
    over?: Record<string, number>;
    want: BudgetMode;
  }> = [
    // Envelope is the SCORE-OPTIMAL one ($0.05 / 2400 s), not the eval hard
    // ceiling ($0.50 / 2700 s) — see the header block on policy/budget.ts.
    { name: "fresh task", spentUsd: 0, elapsedS: 0, want: "normal" },
    { name: "just under finalize spend ($0.039)", spentUsd: 0.039, elapsedS: 0, want: "normal" },
    { name: "finalize spend boundary ($0.04)", spentUsd: 0.04, elapsedS: 0, want: "finalize" },
    { name: "just under finalize time (1899s)", spentUsd: 0, elapsedS: 1899, want: "normal" },
    { name: "finalize time boundary (1900s)", spentUsd: 0, elapsedS: 1900, want: "finalize" },
    { name: "between finalize and halt", spentUsd: 0.045, elapsedS: 2000, want: "finalize" },
    { name: "halt spend cap ($0.05)", spentUsd: 0.05, elapsedS: 100, want: "halt" },
    { name: "halt wall cap (2400s)", spentUsd: 0.01, elapsedS: 2400, want: "halt" },
    { name: "custom budget scales proportionally", spentUsd: 0.85, elapsedS: 0, over: { budgetUsd: 1.0 }, want: "finalize" },
    { name: "custom budget halts at its own cap", spentUsd: 1.0, elapsedS: 0, over: { budgetUsd: 1.0 }, want: "halt" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(budgetMode({ spentUsd: c.spentUsd, elapsedS: c.elapsedS, ...c.over })).toBe(c.want);
    });
  }

  it("halts strictly inside the evaluation hard ceilings", () => {
    // Regression guard for the original mistake: sizing the governor AT the
    // disqualification line. Both envelopes must stay strictly below it, or a
    // halted task has already scored ~0.5·A by the time the governor fires.
    expect(DEFAULT_BUDGET_USD).toBeLessThan(HARD_CEILING_USD);
    expect(DEFAULT_WALL_S).toBeLessThan(HARD_CEILING_WALL_S);
    // A task at the halt cap must still score respectably. Scoring formula:
    //   S = 10A / (1 + 0.65(C/0.15) + 0.35(T/1320))^2.5
    const denom = 1 + 0.65 * (DEFAULT_BUDGET_USD / 0.15) + 0.35 * (DEFAULT_WALL_S / 1320);
    const scoreAtHalt = 10 / Math.pow(denom, 2.5);
    expect(scoreAtHalt).toBeGreaterThan(2.0); // old $0.50/2700 envelope gave ~0.45
  });

  it("tokenBudgetRemaining converts remaining USD at the reference rate", () => {
    // $0.05 default budget at $50/Mtok reference: $0.01 left -> 200 tokens.
    expect(tokenBudgetRemaining({ spentUsd: 0.04, elapsedS: 0 })).toBe(200);
    expect(tokenBudgetRemaining({ spentUsd: 0, elapsedS: 0 }, 100)).toBe(500);
    expect(tokenBudgetRemaining({ spentUsd: 0.9, elapsedS: 0 })).toBe(0);
  });
});

describe("free-tier lock (scoring: $0.01 ≡ 163s of wall clock)", () => {
  const NOW = 1_700_000_000_000;
  const freeP = { id: "free", tiers: ["S", "M", "L"] as Tier[], costPerMTok: 0 };
  const paidP = { id: "paid", tiers: ["S", "M", "L"] as Tier[], costPerMTok: 0.69 };

  it("excludes priced providers at every budget mode, not only halt", () => {
    for (const mode of ["normal", "finalize", "halt"] as BudgetMode[]) {
      const sel = selectProvider("L", [paidP, freeP], mode, { now: () => NOW, freeOnly: true });
      expect(sel?.id).toBe("free");
    }
  });

  it("returns null rather than falling back to a priced provider", () => {
    // A 503 costs $0; a paid fallback costs ~81% of the achievable score.
    const sel = selectProvider("L", [paidP], "normal", { now: () => NOW, freeOnly: true });
    expect(sel).toBeNull();
  });

  it("unlocked routing still reaches the priced provider", () => {
    const sel = selectProvider("L", [paidP], "normal", { now: () => NOW });
    expect(sel?.id).toBe("paid");
  });

  // Mirrors the real catalog's shape: free S/M, and the ONE priced model
  // sitting in tier L — exactly where hard tasks are routed.
  const mixedProvider = (): Provider => ({
    id: "mix",
    kind: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    envKey: "TEST_KEY",
    notes: "free S/M + priced L, like the shipped registry",
    models: [
      { model_id_per_provider: "free-s", tier: "S", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 20 },
      { model_id_per_provider: "free-m", tier: "M", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 32 },
      { model_id_per_provider: "paid-l", tier: "L", ctx_window: 131072, price_in: 0.59, price_out: 0.79, param_b: 70 },
    ],
  });
  const mixedCandidates = [
    { providerId: "mix", model: "free-s", tier: "S" as Tier },
    { providerId: "mix", model: "free-m", tier: "M" as Tier },
    { providerId: "mix", model: "paid-l", tier: "L" as Tier },
  ];
  const tel = { getTask: () => null };

  it("RouteService never routes to the priced L model while locked", () => {
    const rs = new RouteService({ telemetry: tel, providers: [mixedProvider()] });
    // Planner role + hard prompt: this classifies to L, where the only priced
    // model lives. The lock must degrade it to a free tier instead.
    const d = rs.pickRoute(
      body(`refactor the architecture and migrate concurrency ${"x".repeat(4200)}`),
      { role: "planner", task: "t-free-lock" },
      mixedCandidates,
    );
    expect(d).not.toBeNull();
    expect(d!.model).not.toBe("paid-l");
    const price = priceFor([mixedProvider()], d!.providerId, d!.model);
    expect(price!.price_in + price!.price_out).toBe(0);
    expect(d!.reason).toContain("free-tier lock");
  });

  it("unlocked, the same prompt DOES reach the priced L model", () => {
    const rs = new RouteService({ telemetry: tel, providers: [mixedProvider()], freeOnly: false });
    const d = rs.pickRoute(
      body(`refactor the architecture and migrate concurrency ${"x".repeat(4200)}`),
      { role: "planner", task: "t-unlocked" },
      mixedCandidates,
    );
    expect(d!.model).toBe("paid-l");
  });

  it("an explicit model pin overrides the lock but says so in the route reason", () => {
    const rs = new RouteService({ telemetry: tel, providers: [mixedProvider()] });
    const d = rs.pickRoute(body("hi"), { forceModel: "paid-l", task: "t-pin" }, mixedCandidates);
    expect(d?.model).toBe("paid-l");
    expect(d?.reason).toContain("free-tier lock overridden");
  });

  it("setFreeTierOnly(false) re-enables priced routing at runtime", () => {
    const rs = new RouteService({ telemetry: tel, providers: [mixedProvider()] });
    expect(rs.freeTierOnly).toBe(true); // locked by default
    rs.setFreeTierOnly(false);
    expect(rs.freeTierOnly).toBe(false);
    const d = rs.pickRoute(body("hi"), { forceTier: "L", task: "t-toggle" }, mixedCandidates);
    expect(d!.model).toBe("paid-l");
  });
});

describe("selectProvider — headroom ranking", () => {
  const NOW = 1_700_000_000_000;
  const clock = () => NOW;
  const mk = (over: Partial<ProviderState> & { id: string }): ProviderState => ({
    tiers: ["S", "M"],
    healthy: true,
    rpmWindow: [],
    costPerMTok: 100,
    ...over,
  });

  it("picks the provider with the freest RPM window", () => {
    const busy = mk({ id: "busy", rpmWindow: [NOW - 1000, NOW - 2000] });
    const idle = mk({ id: "idle", rpmWindow: [NOW - 1000] });
    expect(selectProvider("M", [busy, idle], "normal", { now: clock })?.id).toBe("idle");
  });

  it("consecutive 429s penalize even an otherwise idle provider", () => {
    const flaky = mk({ id: "flaky", consecutive429: 3 });
    const steady = mk({ id: "steady", rpmWindow: [NOW - 1000] });
    expect(selectProvider("M", [flaky, steady], "normal", { now: clock })?.id).toBe("steady");
    expect(headroom(flaky, NOW)).toBeLessThan(headroom(steady, NOW));
  });

  it("skips providers not offering the tier / unhealthy / circuit-open -> null", () => {
    const sOnly = mk({ id: "s-only", tiers: ["S"] });
    const dead = mk({ id: "dead", healthy: false });
    const open = mk({ id: "open", consecutive429: 5 });
    expect(selectProvider("M", [sOnly, dead, open], "normal", { now: clock })).toBeNull();
    expect(selectProvider("S", [dead, open], "normal", { now: clock })).toBeNull();
  });

  it("ties break by cost asc, then by id asc — deterministically", () => {
    const a = mk({ id: "beta", costPerMTok: 90 });
    const b = mk({ id: "alpha", costPerMTok: 90 });
    const cheap = mk({ id: "zeta", costPerMTok: 10 });
    const picked = selectProvider("M", [a, b, cheap], "normal", { now: clock });
    expect(picked?.id).toBe("zeta");
    expect(selectProvider("M", [a, b], "normal", { now: clock })?.id).toBe("alpha");
    expect(selectProvider("M", [b, a], "normal", { now: clock })?.id).toBe("alpha");
  });

  it("finalize mode prefers the cheapest eligible provider", () => {
    const priceyIdle = mk({ id: "pricey-idle", costPerMTok: 500, rpmWindow: [] });
    const cheapBusy = mk({ id: "cheap-busy", costPerMTok: 5, rpmWindow: [NOW - 1000, NOW - 1500] });
    expect(
      selectProvider("M", [priceyIdle, cheapBusy], "finalize", { now: clock })?.id,
    ).toBe("cheap-busy");
    expect(
      selectProvider("M", [priceyIdle, cheapBusy], "normal", { now: clock })?.id,
    ).toBe("pricey-idle");
  });

  it("halt mode keeps only FREE providers", () => {
    const paid = mk({ id: "paid", costPerMTok: 20 });
    const free = mk({ id: "free", costPerMTok: 0 });
    expect(selectProvider("M", [paid], "halt", { now: clock })).toBeNull();
    expect(selectProvider("M", [mk({ id: "mystery", costPerMTok: undefined })], "halt", { now: clock })).toBeNull();
    expect(selectProvider("M", [paid, free], "halt", { now: clock })?.id).toBe("free");
    expect(selectProvider("M", [paid, free], "finalize", { now: clock })?.id).toBe("free");
  });
});
