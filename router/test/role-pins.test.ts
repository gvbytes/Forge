// Capability pinning, from the Forge prototype: a specific model per role
// (router→gpt-oss-20b, coder→gemma, critic→muse) rather than routing by size
// alone. Tier routing answers "how hard is this?"; it cannot answer "which of
// these equally-sized models is better at reviewing?" — within a tier this
// router ranks by headroom and cost, so capability never entered into it.
//
// A pin is a PREFERENCE, not an override: the model must still be catalogued
// (so the <=80B invariant holds), healthy, and free-tier-allowed.
import { describe, expect, it, beforeEach } from "bun:test";
import { RouteService } from "../src/router";
import { resetProviderHealth, markRateLimited, type Provider } from "../src/providers";

const tel = { getTask: () => null };

const prov = (): Provider => ({
  id: "p1", kind: "openai-compatible", baseURL: "http://127.0.0.1:9/v1",
  envKey: "K", notes: "fixture",
  models: [
    { model_id_per_provider: "m-s", tier: "S", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 20 },
    { model_id_per_provider: "m-m", tier: "M", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 30 },
    { model_id_per_provider: "m-l", tier: "L", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 70 },
  ],
});
const paidProv = (): Provider => ({
  id: "paid", kind: "openai-compatible", baseURL: "http://127.0.0.1:9/v1",
  envKey: "K2", notes: "priced",
  models: [{ model_id_per_provider: "m-paid", tier: "M", ctx_window: 8192, price_in: 0.5, price_out: 0.9, param_b: 30 }],
});
const cands = [
  { providerId: "p1", model: "m-s", tier: "S" as const },
  { providerId: "p1", model: "m-m", tier: "M" as const },
  { providerId: "p1", model: "m-l", tier: "L" as const },
];
const body = (t: string) => ({ messages: [{ role: "user", content: t }] });

describe("role -> model capability pins", () => {
  beforeEach(() => resetProviderHealth());

  it("routes a pinned role to its model regardless of classified tier", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("reviewer", "m-l");
    const d = rs.pickRoute(body("tiny"), { role: "reviewer", task: "t1" }, cands);
    expect(d!.model).toBe("m-l");
    expect(d!.reason).toContain("role pin");
  });

  it("leaves unpinned roles on normal tier routing", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("reviewer", "m-l");
    const d = rs.pickRoute(body("tiny"), { role: "coder", task: "t2" }, cands);
    expect(d!.model).not.toBe("m-l");
    expect(d!.reason).not.toContain("role pin");
  });

  it("a STALE pin degrades to tier routing instead of failing", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("coder", "model-that-was-retired");
    const d = rs.pickRoute(body("tiny"), { role: "coder", task: "t3" }, cands);
    expect(d).not.toBeNull();
    expect(d!.reason).not.toContain("role pin");
  });

  it("an UNHEALTHY pinned model falls through — availability still wins", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("coder", "m-m");
    for (let i = 0; i < 9; i++) markRateLimited("p1", 300);
    const d = rs.pickRoute(body("tiny"), { role: "coder", task: "t4" }, cands);
    if (d) expect(d.reason).not.toContain("role pin");
  });

  it("the free-tier lock outranks a pin to a priced model", () => {
    // A capability preference must never become a spending decision.
    const rs = new RouteService({ telemetry: tel, providers: [prov(), paidProv()] });
    rs.setRolePin("coder", "m-paid");
    const d = rs.pickRoute(body("tiny"), { role: "coder", task: "t5" },
      [...cands, { providerId: "paid", model: "m-paid", tier: "M" as const }]);
    expect(d!.model).not.toBe("m-paid");
  });

  it("an explicit force beats a pin — stronger operator intent", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("coder", "m-l");
    const d = rs.pickRoute(body("x"), { role: "coder", task: "t6", forceModel: "m-s" }, cands);
    expect(d!.model).toBe("m-s");
  });

  it("pins can be cleared", () => {
    const rs = new RouteService({ telemetry: tel, providers: [prov()] });
    rs.setRolePin("coder", "m-l");
    expect(rs.rolePinSnapshot().coder).toBe("m-l");
    rs.setRolePin("coder", null);
    expect(rs.rolePinSnapshot().coder).toBeUndefined();
  });
});
