import { describe, test, expect } from "bun:test";
import { DEFAULT_PROVIDERS, findByModality, allModels } from "../src/providers.js";
import { planRoute } from "../src/router.js";

// Tier routing exists to rank TEXT models by task complexity. A vision or
// speech model on that ladder is not merely a worse pick — a code question
// routed to Whisper cannot produce an answer at all. So non-text models must be
// invisible to tier routing and reachable only by explicit capability lookup.

describe("modality separation", () => {
  test("the catalog carries a vision model and a transcription model", () => {
    expect(findByModality(DEFAULT_PROVIDERS, "vision")?.model.model_id_per_provider)
      .toBe("meta/llama-3.2-11b-vision-instruct");
    expect(findByModality(DEFAULT_PROVIDERS, "transcription")?.model.model_id_per_provider)
      .toBe("whisper-large-v3");
  });

  test("the vision model stays inside the 80B cap", () => {
    const v = findByModality(DEFAULT_PROVIDERS, "vision")!;
    // The 90B sibling exists upstream and would break the PS constraint.
    expect(v.model.param_b).toBeLessThanOrEqual(80);
  });

  test("non-text models never appear as tier-routing candidates", () => {
    const nonText = allModels(DEFAULT_PROVIDERS)
      .filter((m) => (m.modality ?? "text") !== "text")
      .map((m) => m.model_id_per_provider);
    expect(nonText.length).toBeGreaterThan(0);

    for (const tier of ["S", "M", "L"] as const) {
      const r = planRoute({
        providers: DEFAULT_PROVIDERS,
        keyPresent: () => true,
        session: { forceTier: tier } as never,
        body: { messages: [{ role: "user", content: "write a function" }] },
        policy: {
          pickRoute: (_b: unknown, _s: unknown, candidates: { providerId: string; model: string; tier: string }[]) =>
            candidates.length ? { ...candidates[0], reason: "test" } : null,
        } as never,
      } as never);
      for (const c of r.chain) expect(nonText).not.toContain(c.model);
    }
  });

  test("capability lookup returns null rather than a text fallback", () => {
    // A silent fallback would answer confidently about an image it never saw.
    const none = findByModality([], "vision");
    expect(none).toBeNull();
  });
});
