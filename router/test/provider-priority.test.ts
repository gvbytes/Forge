import { describe, test, expect } from "bun:test";
import { selectProvider, priorityRank, PROVIDER_PRIORITY, OPEN_CIRCUIT_429, type ProviderState } from "../src/policy/select.js";

// Every provider here is free, so the cost tie-break never fires and selection
// used to fall through to ALPHABETICAL id — "groq" beat "nvidia-nim" on nearly
// every tie, purely by naming. Preference is now explicit, but it must never
// become a way to aim traffic at a provider that cannot take it: preferring a
// rate-limited or unhealthy provider would manufacture the very API errors a
// preference is configured to avoid.

const P = (id: string, over: Partial<ProviderState> = {}): ProviderState =>
  ({ id, tiers: ["S", "M", "L"], healthy: true, consecutive429: 0, costPerMTok: 0, rpmWindow: [], ...over });

const pick = (ps: ProviderState[], opts = {}) =>
  selectProvider("M", ps, "normal", { now: () => 1_000_000, freeOnly: true, ...opts })?.id;

describe("provider priority", () => {
  test("nvidia-nim is preferred over the alphabetically-earlier groq", () => {
    expect(pick([P("groq"), P("nvidia-nim")])).toBe("nvidia-nim");
    expect(pick([P("nvidia-nim"), P("groq")])).toBe("nvidia-nim");  // order-independent
  });

  test("the full default order is nvidia-nim > groq > openrouter > zen", () => {
    expect(PROVIDER_PRIORITY[0]).toBe("nvidia-nim");
    const all = [P("zen"), P("openrouter"), P("groq"), P("nvidia-nim")];
    expect(pick(all)).toBe("nvidia-nim");
    expect(pick(all.filter((p) => p.id !== "nvidia-nim"))).toBe("groq");
    expect(pick(all.filter((p) => !["nvidia-nim", "groq"].includes(p.id)))).toBe("openrouter");
  });

  test("a preferred provider with NO headroom loses to one that can take it", () => {
    // rpmWindow full => headroom 0. This is the guard that stops a preference
    // from turning into a 429 generator.
    const saturated = P("nvidia-nim", { rpmWindow: Array.from({ length: 200 }, () => 999_999) });
    expect(pick([saturated, P("groq")], { rpmLimit: 30 })).toBe("groq");
  });

  test("preference never resurrects an unhealthy or circuit-open provider", () => {
    expect(pick([P("nvidia-nim", { healthy: false }), P("groq")])).toBe("groq");
    expect(pick([P("nvidia-nim", { consecutive429: OPEN_CIRCUIT_429 }), P("groq")])).toBe("groq");
  });

  test("unlisted providers rank after every listed one", () => {
    expect(priorityRank("nvidia-nim")).toBeLessThan(priorityRank("groq"));
    expect(priorityRank("some-new-provider")).toBe(PROVIDER_PRIORITY.length);
    expect(pick([P("some-new-provider"), P("zen")])).toBe("zen");
  });

  test("returns null when nothing is eligible rather than forcing the preferred one", () => {
    expect(pick([P("nvidia-nim", { healthy: false })])).toBeUndefined();
  });
});
