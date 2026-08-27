import { describe, test, expect } from "bun:test";
import { DEFAULT_PROVIDERS, allModels, MAX_PARAM_B, TIERS, type Tier } from "../src/providers";

/**
 * Catalog invariants.
 *
 * The previous version of this file asserted that a handful of hardcoded model
 * id strings were present in the array those same strings were hardcoded into —
 * a circular check that could not fail, and which therefore said nothing about
 * whether the catalog was actually valid or routable. These tests assert the
 * properties the problem statement and the scoring formula actually depend on.
 *
 * Whether the ids RESOLVE upstream is a separate question that a unit test
 * cannot answer; `bun run preflight` sends a real completion to each pair.
 */
describe("model catalog invariants", () => {
  const models = allModels(DEFAULT_PROVIDERS);

  test("every model declares a positive, finite TOTAL parameter count", () => {
    for (const m of models) {
      expect(Number.isFinite(m.param_b)).toBe(true);
      expect(m.param_b).toBeGreaterThan(0);
    }
  });

  test("every model is within the 80B total-parameter cap", () => {
    for (const m of models) {
      expect(m.param_b).toBeLessThanOrEqual(MAX_PARAM_B);
    }
  });

  test("the cap is on TOTAL params, so no MoE model is seeded on its active count", () => {
    // MoE ids advertise ACTIVE params (`-120b-a12b` = 120B total / 12B active).
    // If an id names a size, the seeded param_b must not be the SMALLER of the
    // two numbers — that is the specific mistake that silently breaks the
    // constraint, since 12B looks compliant while the model is 120B.
    // Tolerance exists because vendors round in the NAME: gemma-4-31b-it is
    // 30.7B total. The mistake being caught is an order-of-magnitude one
    // (12 declared against a 120B model), so 10% slack separates the two
    // cases cleanly — 30.7/31 = 0.99 passes, 12/120 = 0.10 fails.
    const NAME_ROUNDING_TOLERANCE = 0.9;
    for (const m of models) {
      const sizes = [...m.model_id_per_provider.matchAll(/(\d+(?:\.\d+)?)b\b/gi)].map((x) => Number(x[1]));
      if (sizes.length === 0) continue;
      const largest = Math.max(...sizes);
      expect(m.param_b).toBeGreaterThanOrEqual(largest * NAME_ROUNDING_TOLERANCE);
      expect(largest).toBeLessThanOrEqual(MAX_PARAM_B);
    }
  });

  test("the catalog is free-tier only — nothing can bill, lock or no lock", () => {
    // The free-tier lock is a routing policy and can be switched off. This
    // asserts the stronger property: the catalog itself contains no priced
    // model, so disabling the lock still cannot spend money.
    for (const m of models) {
      expect(m.price_in).toBe(0);
      expect(m.price_out).toBe(0);
    }
  });

  test("every seeded provider contributes at least one routable model", () => {
    for (const p of DEFAULT_PROVIDERS) {
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.envKey.length).toBeGreaterThan(0);
      expect(p.baseURL.startsWith("https://")).toBe(true);
    }
  });

  test("model ids are unique within a provider", () => {
    for (const p of DEFAULT_PROVIDERS) {
      const ids = p.models.map((m) => m.model_id_per_provider);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // ── Single-provider architecture ──────────────────────────────────────────
  // The catalog was deliberately narrowed to ONE text provider. These replace
  // the old "every tier has two providers" / "four providers seeded" rules,
  // which encoded the previous shape and would now fail by design.

  test("exactly one provider serves text; resilience comes from keys, not providers", () => {
    const textProviders = DEFAULT_PROVIDERS.filter((p) =>
      p.models.some((m) => (m.modality ?? "text") === "text"));
    expect(textProviders.map((p) => p.id)).toEqual(["nvidia-nim"]);
  });

  test("groq is transcription-only and can never be routed to for an agent role", () => {
    const groq = DEFAULT_PROVIDERS.find((p) => p.id === "groq")!;
    // It exists solely because NVIDIA serves no ASR on its hosted API.
    expect(groq.models.every((m) => m.modality === "transcription")).toBe(true);
    expect(groq.models.some((m) => (m.modality ?? "text") === "text")).toBe(false);
  });

  test("the four role models are all present and on the intended tiers", () => {
    const byId = new Map(
      DEFAULT_PROVIDERS.flatMap((p) => p.models.map((m) => [m.model_id_per_provider, m])),
    );
    // S carries the high-frequency roles, L the once-per-task planner, and M
    // holds two DIFFERENT models so the reviewer never shares the coder's
    // blind spots.
    expect(byId.get("openai/gpt-oss-20b")?.tier).toBe("S");
    expect(byId.get("nvidia/nemotron-3.5-lightning-30b-a3b")?.tier).toBe("M");
    expect(byId.get("meta/muse-glimmer-30b")?.tier).toBe("M");
    expect(byId.get("google/gemma-4-31b-it")?.tier).toBe("L");
  });

  test("tier M holds two distinct models so coder and reviewer differ", () => {
    const m = DEFAULT_PROVIDERS.flatMap((p) => p.models)
      .filter((x) => x.tier === "M" && (x.modality ?? "text") === "text");
    expect(new Set(m.map((x) => x.model_id_per_provider)).size).toBeGreaterThanOrEqual(2);
  });

  test("tier coverage is complete", () => {
    const covered = new Set<Tier>(models.map((m) => m.tier));
    for (const tier of TIERS) expect(covered.has(tier)).toBe(true);
  });
});
