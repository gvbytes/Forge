/**
 * F7 — rate-limit decay regression tests.
 *
 * consecutive_429 used to reset ONLY on success. A provider that hit the hard
 * ceiling (MAX_CONSECUTIVE_429) was excluded from the pool, so it could never
 * score a success, so the counter never reset → permanent lockout until process
 * restart. The fix decays the streak once the cooldown has been served AND a
 * full recovery window has passed since the last 429, giving the provider
 * another chance instead of locking it out forever.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  markRateLimited,
  isProviderHealthy,
  healthSnapshot,
  resetProviderHealth,
  MAX_CONSECUTIVE_429,
  RATE_LIMIT_COOLDOWN_MAX_S,
} from "../src/providers";

const RECOVERY_MS = RATE_LIMIT_COOLDOWN_MAX_S * 1000;

describe("F7: rate-limited providers decay back into the pool", () => {
  beforeEach(() => resetProviderHealth());

  test("a provider at the 429 ceiling is locked out in the moment", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) markRateLimited("p");
    expect(isProviderHealthy("p")).toBe(false);
  });

  test("recovers once the cooldown is served AND a recovery window has passed", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) markRateLimited("p");
    const later = Date.now() + RECOVERY_MS + 100_000;
    expect(isProviderHealthy("p", later)).toBe(true);
  });

  test("stays locked out while the recovery window has not yet elapsed", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) markRateLimited("p");
    // 20s later: the default 15s cooldown is served, but < recovery window.
    const soon = Date.now() + 20_000;
    expect(isProviderHealthy("p", soon)).toBe(false);
  });

  test("healthSnapshot reflects the decayed streak (select pool sees it too)", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_429; i++) markRateLimited("p");
    const later = Date.now() + RECOVERY_MS + 100_000;
    const snap = healthSnapshot(later);
    expect(snap["p"]?.consecutive_429 ?? 0).toBe(0);
  });
});
