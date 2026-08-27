/**
 * B39 regression tests — provider health accounting.
 *
 *  (a) A 2xx response whose body is an error object that looks like a rate limit
 *      must call markRateLimited — the provider's 429 counters and cooldown must
 *      advance exactly like a real 429 status, and chain exhaustion on such
 *      bodies surfaces an honest 429 (engine quota-backoff contract).
 *  (b) Consecutive 5xx responses must accumulate in a streak; once the streak
 *      reaches MAX_CONSECUTIVE_5XX the provider is cooled down (isProviderHealthy
 *      false) instead of being re-selected on every request. Any success resets
 *      the streak.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono, type Context } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterApp, type RouterApp } from "../src/index";
import {
  MAX_CONSECUTIVE_5XX,
  healthSnapshot,
  isProviderHealthy,
  markSuccess,
  resetProviderHealth,
  type Provider,
  type Tier,
} from "../src/providers";

function mkModel(id: string, tier: Tier): Provider["models"][number] {
  return { model_id_per_provider: id, tier, ctx_window: 8192, price_in: 0, price_out: 0, param_b: 7 };
}

interface Fake {
  provider: Provider;
  server: ReturnType<typeof Bun.serve>;
}

function startFake(id: string, handler: (c: Context) => Response): Fake {
  const app = new Hono();
  app.post("/v1/chat/completions", handler);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const provider: Provider = {
    id,
    kind: "openai-compatible",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    envKey: `FAKE_${id.toUpperCase().replace(/-/g, "_")}_KEY`,
    notes: "b39 fake upstream",
    models: [mkModel("b39-model", "M")],
  };
  return { provider, server };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-router-b39-"));

// (a) 200-OK body carrying a rate-limit error object.
const rlBody = startFake("b39-rl-body", (c) =>
  c.json({ error: { code: "rate_limit_exceeded", message: "quota exceeded, slow down" } }, 200),
);
const appRl: RouterApp = createRouterApp({ dbPath: join(tmpRoot, "rl.db"), providers: [rlBody.provider] });
const serverRl = Bun.serve({ port: 0, fetch: appRl.app.fetch });
const baseRl = `http://127.0.0.1:${serverRl.port}`;

// (b) always-500 upstream.
const err5xx = startFake("b39-5xx", (c) => c.json({ error: { message: "internal explosion" } }, 500));
const app5xx: RouterApp = createRouterApp({ dbPath: join(tmpRoot, "fivexx.db"), providers: [err5xx.provider] });
const server5xx = Bun.serve({ port: 0, fetch: app5xx.app.fetch });
const base5xx = `http://127.0.0.1:${server5xx.port}`;

beforeAll(() => {
  resetProviderHealth();
});

afterAll(() => {
  serverRl.stop(true);
  server5xx.stop(true);
  rlBody.server.stop(true);
  err5xx.server.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function postKey(base: string, provider: string, key: string): Promise<void> {
  const res = await fetch(`${base}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) throw new Error(`POST /keys failed: ${res.status}`);
}

async function chat(base: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "b39-model", messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("B39a — 2xx body carrying a rate-limit error", () => {
  test("advances the provider's 429 counters and surfaces an honest 429", async () => {
    await postKey(baseRl, "b39-rl-body", "sk-fake");

    const res = await chat(baseRl);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; attempts?: unknown[] };
    expect(body.error).toBe("all providers rate-limited");
    expect(Array.isArray(body.attempts)).toBe(true);

    const snap = healthSnapshot()["b39-rl-body"];
    if (!snap) throw new Error("expected health snapshot entry for b39-rl-body");
    expect(snap.consecutive_429).toBeGreaterThanOrEqual(1);
    expect(snap.cooldown_until_ts).not.toBeNull();
  });
});

describe("B39b — 5xx streak tracking", () => {
  test("repeated 500s cool the provider down; a success heals it", async () => {
    await postKey(base5xx, "b39-5xx", "sk-fake");

    expect(isProviderHealthy("b39-5xx")).toBe(true);

    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) {
      const res = await chat(base5xx);
      // Chain exhaustion on 5xx is a 503 WITH attempts (not a 429).
      expect(res.status).toBe(503);
      const body = (await res.json()) as { attempts?: Array<{ http?: number | null }> };
      expect(Array.isArray(body.attempts)).toBe(true);
      expect(body.attempts?.[0]?.http).toBe(500);
    }

    const snap = healthSnapshot()["b39-5xx"];
    if (!snap) throw new Error("expected health snapshot entry for b39-5xx");
    expect(snap.consecutive_5xx).toBe(MAX_CONSECUTIVE_5XX);
    expect(snap.cooldown_until_ts).not.toBeNull();
    expect(isProviderHealthy("b39-5xx")).toBe(false);

    // Any success resets the streak and lifts the cooldown.
    markSuccess("b39-5xx");
    const healed = healthSnapshot()["b39-5xx"];
    if (!healed) throw new Error("expected health snapshot entry for b39-5xx after heal");
    expect(healed.consecutive_5xx).toBe(0);
    expect(healed.cooldown_until_ts).toBeNull();
    expect(isProviderHealthy("b39-5xx")).toBe(true);
  });
});
