/**
 * B39 edge-case hardening — regression tests.
 *
 *  1. A 429 (controlled provider response) must break the consecutive_5xx streak
 *     so a stale streak cannot prematurely cool down a recovering provider.
 *  2. markServerError cooldown arming: honor Retry-After when present, else the
 *     default; re-arming may extend but must NEVER shorten an armed cooldown.
 *  3. 2xx-with-error-body detection: no false positives on normal 200s (content
 *     merely mentioning "rate limit", or an explicit `error: null`), but string
 *     rate-limit error bodies must cool the provider down like object ones.
 *  4. Cooldown arithmetic: NaN/0/huge Retry-After must never produce a NaN or
 *     non-positive cooldown.
 *  5. Breaker recovery: cooldown expiry alone re-admits the provider (no manual
 *     reset required).
 *  6. /models + /routes outputs carry no undefined consumer fields.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Hono, type Context } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterApp, type RouterApp } from "../src/index";
import {
  MAX_CONSECUTIVE_5XX,
  RATE_LIMIT_COOLDOWN_DEFAULT_S,
  healthSnapshot,
  isProviderHealthy,
  markRateLimited,
  markServerError,
  resetProviderHealth,
  type Provider,
  type Tier,
} from "../src/providers";

// ---------------------------------------------------------------------------
// Unit-level: providers.ts health accounting
// ---------------------------------------------------------------------------

describe("edge 1 — 429 breaks the 5xx streak", () => {
  beforeEach(() => resetProviderHealth());

  test("a rate limit between 5xx responses resets consecutive_5xx", () => {
    markServerError("edge1"); // 5xx #1
    markServerError("edge1"); // 5xx #2
    markRateLimited("edge1", null); // 429: provider is answering in a controlled way
    markServerError("edge1"); // 5xx #1 again — streak must have restarted

    const snap = healthSnapshot()["edge1"];
    if (!snap) throw new Error("expected snapshot for edge1");
    expect(snap.consecutive_5xx).toBe(1);
  });
});

describe("edge 2 — markServerError cooldown arming", () => {
  beforeEach(() => resetProviderHealth());

  test("honors Retry-After when present", () => {
    const before = Date.now();
    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) markServerError("edge2a", 60);
    const snap = healthSnapshot()["edge2a"];
    if (!snap || snap.cooldown_until_ts === null) throw new Error("expected armed cooldown");
    expect(snap.cooldown_until_ts).toBeGreaterThanOrEqual(before + 55_000);
    expect(snap.cooldown_until_ts).toBeLessThanOrEqual(before + 70_000);
  });

  test("falls back to the default cooldown without Retry-After (lock)", () => {
    const before = Date.now();
    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) markServerError("edge2b");
    const snap = healthSnapshot()["edge2b"];
    if (!snap || snap.cooldown_until_ts === null) throw new Error("expected armed cooldown");
    expect(snap.cooldown_until_ts).toBeGreaterThanOrEqual(before + (RATE_LIMIT_COOLDOWN_DEFAULT_S - 2) * 1000);
    expect(snap.cooldown_until_ts).toBeLessThanOrEqual(before + (RATE_LIMIT_COOLDOWN_DEFAULT_S + 5) * 1000);
  });

  test("re-arming never shortens an existing longer cooldown", () => {
    markRateLimited("edge2c", 300); // 429 with a long Retry-After
    const armed = healthSnapshot()["edge2c"]?.cooldown_until_ts;
    if (armed === null || armed === undefined) throw new Error("expected armed cooldown");
    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) markServerError("edge2c");
    const after = healthSnapshot()["edge2c"]?.cooldown_until_ts;
    if (after === null || after === undefined) throw new Error("expected cooldown to stay armed");
    expect(after).toBeGreaterThanOrEqual(armed);
  });
});

describe("edge 4 — cooldown arithmetic", () => {
  beforeEach(() => resetProviderHealth());

  test("NaN retry-after falls back to the default (never a NaN cooldown)", () => {
    markRateLimited("edge4a", Number.NaN);
    const snap = healthSnapshot()["edge4a"];
    if (!snap || snap.cooldown_until_ts === null) throw new Error("expected armed cooldown");
    expect(Number.isFinite(snap.cooldown_until_ts)).toBe(true);
    expect(isProviderHealthy("edge4a")).toBe(false);
  });

  test("retry-after 0 clamps to >=1s; huge values clamp to the max (lock)", () => {
    const before = Date.now();
    markRateLimited("edge4b", 0);
    const zero = healthSnapshot()["edge4b"]?.cooldown_until_ts;
    if (zero === null || zero === undefined) throw new Error("expected armed cooldown");
    expect(zero).toBeGreaterThanOrEqual(before + 1000);

    markRateLimited("edge4c", 1e9);
    const huge = healthSnapshot()["edge4c"]?.cooldown_until_ts;
    if (huge === null || huge === undefined) throw new Error("expected armed cooldown");
    expect(huge).toBeLessThanOrEqual(before + 305_000);
    expect(huge).toBeGreaterThanOrEqual(before + 295_000);
  });
});

describe("edge 5 — breaker recovery without manual reset (lock)", () => {
  beforeEach(() => resetProviderHealth());

  test("cooldown expiry alone re-admits the provider", () => {
    markRateLimited("edge5a", 1);
    expect(isProviderHealthy("edge5a")).toBe(false);
    expect(isProviderHealthy("edge5a", Date.now() + 5_000)).toBe(true);

    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) markServerError("edge5b");
    expect(isProviderHealthy("edge5b")).toBe(false);
    expect(isProviderHealthy("edge5b", Date.now() + 60_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level: proxy outcome-recording paths
// ---------------------------------------------------------------------------

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
    notes: "edge-case fake upstream",
    models: [mkModel("edge-model", "M")],
  };
  return { provider, server };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-router-edge-"));

function mkApp(name: string, provider: Provider): { app: RouterApp; server: ReturnType<typeof Bun.serve>; base: string } {
  const app = createRouterApp({ dbPath: join(tmpRoot, `${name}.db`), providers: [provider] });
  const server = Bun.serve({ port: 0, fetch: app.app.fetch });
  return { app, server, base: `http://127.0.0.1:${server.port}` };
}

// edge 3 fakes
const okNullErr = startFake("edge-ok-null-err", (c) =>
  c.json(
    {
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      error: null,
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    },
    200,
  ),
);
const rlString = startFake("edge-rl-string", (c) => c.json({ error: "too many requests, slow down" }, 200));
const okMention = startFake("edge-ok-mention", (c) =>
  c.json(
    {
      id: "chatcmpl-2",
      choices: [
        { index: 0, message: { role: "assistant", content: "About rate limits and quota: the limit is 30 rpm." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 9 },
    },
    200,
  ),
);
// edge 2 fake: 5xx carrying Retry-After
const err5xxRa = startFake("edge-5xx-ra", (c) => c.json({ error: { message: "maintenance" } }, 503, { "retry-after": "60" }));

const appOkNullErr = mkApp("ok-null-err", okNullErr.provider);
const appRlString = mkApp("rl-string", rlString.provider);
const appOkMention = mkApp("ok-mention", okMention.provider);
const app5xxRa = mkApp("5xx-ra", err5xxRa.provider);

const servers = [
  appOkNullErr.server,
  appRlString.server,
  appOkMention.server,
  app5xxRa.server,
  okNullErr.server,
  rlString.server,
  okMention.server,
  err5xxRa.server,
];

afterAll(() => {
  for (const s of servers) s.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function postKey(base: string, provider: string): Promise<void> {
  const res = await fetch(`${base}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, key: "sk-fake" }),
  });
  if (!res.ok) throw new Error(`POST /keys failed: ${res.status}`);
}

async function chat(base: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "edge-model", messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("edge 3 — 2xx-with-error-body detection over HTTP", () => {
  test("200 with error:null is accounted as a success", async () => {
    await postKey(appOkNullErr.base, "edge-ok-null-err");
    const res = await chat(appOkNullErr.base);
    expect(res.status).toBe(200);
    const snap = healthSnapshot()["edge-ok-null-err"];
    if (!snap) throw new Error("expected snapshot for edge-ok-null-err");
    expect(snap.rpm_last_minute).toBeGreaterThanOrEqual(1); // markSuccess fired
    expect(snap.cooldown_until_ts).toBeNull();
    expect(snap.consecutive_429).toBe(0);
  });

  test("200 body with a STRING rate-limit error cools the provider down", async () => {
    await postKey(appRlString.base, "edge-rl-string");
    const res = await chat(appRlString.base);
    // Single-candidate chain exhausted on rate limits -> honest 429.
    expect(res.status).toBe(429);
    const snap = healthSnapshot()["edge-rl-string"];
    if (!snap) throw new Error("expected snapshot for edge-rl-string");
    expect(snap.consecutive_429).toBeGreaterThanOrEqual(1);
    expect(snap.cooldown_until_ts).not.toBeNull();
  });

  test("normal 200 whose content merely mentions 'rate limit' stays a success (lock)", async () => {
    await postKey(appOkMention.base, "edge-ok-mention");
    const res = await chat(appOkMention.base);
    expect(res.status).toBe(200);
    const snap = healthSnapshot()["edge-ok-mention"];
    if (!snap) throw new Error("expected snapshot for edge-ok-mention");
    expect(snap.consecutive_429).toBe(0);
    expect(snap.cooldown_until_ts).toBeNull();
    expect(snap.rpm_last_minute).toBeGreaterThanOrEqual(1);
  });
});

describe("edge 2 — 5xx Retry-After honored over HTTP", () => {
  test("5xx with Retry-After arms a cooldown honoring the header", async () => {
    await postKey(app5xxRa.base, "edge-5xx-ra");
    for (let i = 0; i < MAX_CONSECUTIVE_5XX; i++) {
      const res = await chat(app5xxRa.base);
      expect(res.status).toBe(503); // chain exhausted on 5xx
    }
    const snap = healthSnapshot()["edge-5xx-ra"];
    if (!snap || snap.cooldown_until_ts === null) throw new Error("expected armed cooldown");
    expect(snap.consecutive_5xx).toBe(MAX_CONSECUTIVE_5XX);
    expect(snap.cooldown_until_ts).toBeGreaterThanOrEqual(Date.now() + 50_000);
  });
});

describe("edge 6 — /models and /routes output shape (lock)", () => {
  test("no undefined consumer fields", async () => {
    const modelsRes = await fetch(`${appOkMention.base}/v1/models`);
    const models = (await modelsRes.json()) as { object?: string; data?: Array<Record<string, unknown>> };
    expect(models.object).toBe("list");
    expect(Array.isArray(models.data)).toBe(true);
    expect((models.data ?? []).length).toBeGreaterThanOrEqual(1);
    for (const m of models.data ?? []) {
      for (const k of ["id", "object", "created", "owned_by"]) expect(m[k]).toBeDefined();
    }

    const routesRes = await fetch(`${appOkMention.base}/routes`);
    const routes = (await routesRes.json()) as {
      policy?: string;
      tiers?: Record<string, unknown>;
      providers?: Array<Record<string, unknown>>;
    };
    expect(typeof routes.policy).toBe("string");
    for (const t of ["S", "M", "L"]) expect(Array.isArray(routes.tiers?.[t])).toBe(true);
    expect(Array.isArray(routes.providers)).toBe(true);
    for (const p of routes.providers ?? []) {
      expect(typeof p["id"]).toBe("string");
      expect(typeof p["kind"]).toBe("string");
      expect(typeof p["baseURL"]).toBe("string");
      expect(typeof p["models_seeded"]).toBe("number");
      expect(typeof p["key_configured"]).toBe("boolean");
      expect(typeof p["healthy"]).toBe("boolean");
      expect(typeof p["consecutive_429"]).toBe("number");
      expect(typeof p["consecutive_5xx"]).toBe("number");
      expect(typeof p["rpm_last_minute"]).toBe("number");
      expect(p["last_rate_limit_ts"] === null || typeof p["last_rate_limit_ts"] === "number").toBe(true);
    }
  });
});
