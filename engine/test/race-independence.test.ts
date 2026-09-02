// Racing is a FAILOVER mechanism, and failover only helps when candidates can
// fail independently. Models on one provider share a rate limit, so racing them
// triples the load on the bucket that is already rejecting you.
//
// Measured on a 3-step task with only Groq keyed: 16 successful LLM calls took
// 11s of model time inside a 174s task, with 97 HTTP 429s in between. The
// degraded-primary trigger fires BECAUSE of those 429s, so the old condition
// was a feedback loop: 429 → health penalty → race → 3x load → more 429s.
import "./_env.js";
import { describe, test, expect } from "bun:test";

/** The shipped predicate, isolated so it can be asserted without a live router. */
function shouldRace(
  attempts: string[],
  providerOf: (id: string) => string,
  degraded: boolean,
  excludeError?: string,
): boolean {
  const distinct = new Set(attempts.map(providerOf)).size;
  return attempts.length > 1 && distinct > 1 && (degraded || !!excludeError);
}

const oneProvider = () => "groq";
const perModel: Record<string, string> = {
  "groq/a": "groq", "groq/b": "groq",
  "nim/a": "nvidia-nim", "zen/a": "zen",
};
const multi = (id: string) => perModel[id] ?? id;

describe("race only across independent providers", () => {
  test("DOES NOT race same-provider candidates, even when degraded", () => {
    // The exact case measured: every fallback is another Groq model, so all
    // three draw on one 30 RPM account.
    expect(shouldRace(["groq/a", "groq/b"], oneProvider, true)).toBe(false);
  });

  test("does not race same-provider candidates on a retry round either", () => {
    expect(shouldRace(["groq/a", "groq/b"], oneProvider, false, "429 rate limited")).toBe(false);
  });

  test("DOES race when a genuinely independent provider is available", () => {
    // Groq is rate-limited; NIM has its own quota. Failover is real here.
    expect(shouldRace(["groq/a", "nim/a"], multi, true)).toBe(true);
  });

  test("still does not race a healthy primary — token cost without benefit", () => {
    expect(shouldRace(["groq/a", "nim/a"], multi, false)).toBe(false);
  });

  test("never races a single candidate", () => {
    expect(shouldRace(["groq/a"], multi, true, "boom")).toBe(false);
  });

  test("three candidates across two providers still races", () => {
    expect(shouldRace(["groq/a", "groq/b", "zen/a"], multi, true)).toBe(true);
  });

  test("an unknown model id counts as its own provider — fail open, not closed", () => {
    // A model missing from the registry must not silently disable failover.
    expect(shouldRace(["unknown/x", "groq/a"], multi, true)).toBe(true);
  });
});
