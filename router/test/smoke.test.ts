/**
 * Agent Router smoke test.
 *
 * Everything is local: fake upstreams via Bun.serve on dynamic ports.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { DEFAULT_BUDGET_USD, DEFAULT_WALL_S, HARD_CEILING_USD, HARD_CEILING_WALL_S } from "../src/policy/budget";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterApp, type RouterApp } from "../src/index";
import type { Provider, Tier } from "../src/providers";
import type { TraceTreeNode } from "../src/telemetry";

const SSE_BODY = [
  'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"fake-m","choices":[{"index":0,"delta":{"content":"HE"}}]}',
  "",
  'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"fake-m","choices":[{"index":0,"delta":{"content":"LLO"}}]}',
  "",
  'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"fake-m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

interface FakeUpstream {
  provider: Provider;
  server: ReturnType<typeof Bun.serve>;
}

function startFakeProvider(opts: { id: string; mode: "ok" | "rate-limited"; models: Provider["models"] }): FakeUpstream {
  const app = new Hono();
  if (opts.mode === "rate-limited") {
    app.post("/v1/chat/completions", (c) =>
      c.json(
        { error: { code: "rate_limit_exceeded", message: "Too many requests, please retry later" } },
        429,
        { "retry-after": "1" },
      ),
    );
  } else {
    app.post("/v1/chat/completions", async (c) => {
      let stream = false;
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        stream = body["stream"] === true;
      } catch {
        stream = false;
      }
      if (!stream) {
        return c.json({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 1700000000,
          model: "fake-m",
          choices: [
            { index: 0, message: { role: "assistant", content: "FAKE_OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        });
      }
      return new Response(SSE_BODY, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    });
  }
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const provider: Provider = {
    id: opts.id,
    kind: "openai-compatible",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    envKey: `FAKE_${opts.id.toUpperCase().replace(/-/g, "_")}_KEY`,
    notes: "smoke-test fake upstream",
    models: opts.models,
  };
  return { provider, server };
}

function mkModel(id: string, tier: Tier): Provider["models"][number] {
  return { model_id_per_provider: id, tier, ctx_window: 8192, price_in: 0, price_out: 0, param_b: 7 };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-router-smoke-"));

const rlA = startFakeProvider({
  id: "fake-a-rl",
  mode: "rate-limited",
  models: [mkModel("fake-m", "M")],
});
const okA = startFakeProvider({
  id: "fake-b-ok",
  mode: "ok",
  models: [mkModel("fake-m", "M"), mkModel("fake-planner", "L")],
});

const condA: RouterApp = createRouterApp({
  dbPath: join(tmpRoot, "a.db"),
  providers: [rlA.provider, okA.provider],
});
const serverA = Bun.serve({ port: 0, fetch: condA.app.fetch });
const baseA = `http://127.0.0.1:${serverA.port}`;

afterAll(() => {
  serverA.stop(true);
  rlA.server.stop(true);
  okA.server.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function chatUrl(base: string): string {
  return `${base}/v1/chat/completions`;
}

async function postKey(base: string, provider: string, key: string): Promise<Response> {
  return fetch(`${base}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, key }),
  });
}

interface RouteHeader {
  provider: string | null;
  model: string | null;
  tier: string | null;
  reason: string | null;
  attempts: Array<{ provider: string; model: string; status: string; http: number | null; error: string | null }>;
}

describe("router smoke", () => {
  test("health + /routes surface + keys API masks values", async () => {
    const health = await fetch(`${baseA}/health`);
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as Record<string, unknown>;
    expect(healthJson["ok"]).toBe(true);
    expect(healthJson["service"]).toBe("agent-router");

    const routes = await fetch(`${baseA}/routes`);
    expect(routes.status).toBe(200);
    const routesJson = (await routes.json()) as {
      policy: string;
      tiers: Record<string, Array<{ provider: string; tier?: string }>>;
      providers: Array<{ id: string; healthy: boolean }>;
    };
    expect(routesJson.policy).toContain("route-service");
    expect((routesJson.tiers["M"] ?? []).length).toBeGreaterThanOrEqual(2);
    expect(routesJson.providers.find((p) => p.id === "fake-b-ok")).toBeDefined();

    const postRes = await postKey(baseA, "fake-b-ok", "sk-live-abcdef123456");
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as { key: string };
    expect(postJson.key).not.toContain("sk-live-abcdef123456");

    await postKey(baseA, "fake-a-rl", "sk-rl-key-9876543210");

    const keysJson = (await (await fetch(`${baseA}/keys`)).json()) as {
      keys: Array<{ provider: string; key: string }>;
      providers: Record<string, { set: boolean; last4: string }>;
    };
    const stored = keysJson.keys.find((k) => k.provider === "fake-b-ok");
    expect(stored).toBeDefined();
    expect(JSON.stringify(keysJson)).not.toContain("sk-live-abcdef123456");
    expect(JSON.stringify(keysJson)).not.toContain("sk-rl-key-9876543210");
    expect(keysJson.providers["fake-b-ok"]).toEqual({ set: true, last4: "3456" });
  });

  test("non-streaming chat: 429 on provider #1 falls back to provider #2; telemetry rows + task ledger written", async () => {
    const res = await fetch(chatUrl(baseA), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-smoke-1",
        "x-engine-task": "task-smoke-1",
      },
      body: JSON.stringify({
        model: "fake-m",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0]!.message.content).toBe("FAKE_OK");
    expect(body.usage.prompt_tokens).toBe(11);
    expect(body.usage.completion_tokens).toBe(7);

    const routeHdr = res.headers.get("x-engine-route");
    expect(routeHdr).not.toBeNull();
    const route: RouteHeader = JSON.parse(routeHdr!) as RouteHeader;
    expect(route.provider).toBe("fake-b-ok");
    expect(route.tier).toBe("M");
    expect(route.reason).toBeTruthy();
    expect(route.attempts.length).toBe(2);
    expect(route.attempts[0]!.provider).toBe("fake-a-rl");
    expect(route.attempts[0]!.status).toBe("fail");
    expect(route.attempts[0]!.http).toBe(429);
    expect(route.attempts[1]!.provider).toBe("fake-b-ok");
    expect(route.attempts[1]!.status).toBe("ok");

    const callsJson = (await (
      await fetch(`${baseA}/telemetry/calls?task=task-smoke-1&limit=50`)
    ).json()) as {
      calls: Array<{
        provider: string;
        status: string;
        http: number | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        cost_usd: number | null;
        latency_ms: number | null;
        session: string | null;
      }>;
    };
    const failRow = callsJson.calls.find((r) => r.provider === "fake-a-rl");
    expect(failRow).toBeDefined();
    expect(failRow!.status).toBe("error");
    expect(failRow!.http).toBe(429);
    const okRow = callsJson.calls.find((r) => r.status === "success");
    expect(okRow).toBeDefined();
    expect(okRow!.provider).toBe("fake-b-ok");
    expect(okRow!.prompt_tokens).toBe(11);
    expect(okRow!.completion_tokens).toBe(7);
    expect(okRow!.cost_usd).toBe(0);
    expect(okRow!.session).toBe("sess-smoke-1");

    const taskRes = await fetch(`${baseA}/telemetry/task/task-smoke-1`);
    expect(taskRes.status).toBe(200);
    const taskJson = (await taskRes.json()) as {
      task: { budget_usd: number; wall_deadline_s: number; state: string };
      summary: { calls: number; errors: number };
    };
    // Assert against the policy constants, not literals: the ledger row must
    // carry the SCORE-OPTIMAL envelope, not the column's hard-ceiling default.
    // Pinning 0.5/2700 here is what let the tightened envelope pass CI while
    // being inert in production.
    expect(taskJson.task.budget_usd).toBe(DEFAULT_BUDGET_USD);
    expect(taskJson.task.wall_deadline_s).toBe(DEFAULT_WALL_S);
    expect(taskJson.task.budget_usd).toBeLessThan(HARD_CEILING_USD);
    expect(taskJson.task.wall_deadline_s).toBeLessThan(HARD_CEILING_WALL_S);
    expect(taskJson.task.state).toBe("active");
    expect(taskJson.summary.calls).toBeGreaterThanOrEqual(2);
    expect(taskJson.summary.errors).toBeGreaterThanOrEqual(1);

    const traces = condA.telemetry.listTraces(10);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((t) => t.kind === "route")).toBe(true);
  });

  test("streaming chat: SSE bytes pass through untouched + trailing route comment appended", async () => {
    const res = await fetch(chatUrl(baseA), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fake-m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain('{"id":"chatcmpl-fake"');
    expect(text).toContain('"delta":{"content":"HE"}}');
    expect(text).toContain('"delta":{"content":"LLO"}}');
    expect(text).toContain("data: [DONE]");
    const idxDone = text.indexOf("data: [DONE]");
    const idxComment = text.indexOf(": x-engine-route ");
    expect(idxDone).toBeGreaterThanOrEqual(0);
    expect(idxComment).toBeGreaterThan(idxDone);
    expect(text.endsWith("\n\n")).toBe(true);

    const match = /: x-engine-route (\{.*\})\n\n$/.exec(text);
    expect(match).not.toBeNull();
    const route = JSON.parse(match![1]!) as RouteHeader;
    expect(route.provider).toBe("fake-b-ok");

    const hdrRoute: RouteHeader = JSON.parse(res.headers.get("x-engine-route")!) as RouteHeader;
    expect(hdrRoute.provider).toBe(route.provider);

    const callsJson = (await (await fetch(`${baseA}/telemetry/calls?limit=100`)).json()) as {
      calls: Array<{ provider: string; status: string }>;
    };
    const streamOkRows = callsJson.calls.filter((r) => r.provider === "fake-b-ok" && r.status === "success");
    expect(streamOkRows.length).toBeGreaterThanOrEqual(2);
    expect(callsJson.calls.some((r) => r.status === "streaming")).toBe(false);
  });

  test("trace tree: /telemetry/tree nests attempt traces under the route root with calls attached", async () => {
    const res = await fetch(`${baseA}/telemetry/tree?task=task-smoke-1`);
    expect(res.status).toBe(200);
    const { tree } = (await res.json()) as { task: string; tree: TraceTreeNode };
    expect(tree.kind).toBe("task");

    const routeNodes = tree.children.filter((n) => n.kind === "route");
    expect(routeNodes.length).toBeGreaterThanOrEqual(1);
    const routeNode = routeNodes.find((n) => (n.children ?? []).some((c) => c.kind === "attempt"));
    expect(routeNode).toBeDefined();
    expect(routeNode!.label ?? "").toContain("@");

    const attemptNodes = routeNode!.children.filter((n) => n.kind === "attempt");
    expect(attemptNodes.length).toBeGreaterThanOrEqual(2);
    for (const a of attemptNodes) {
      expect(a.label ?? "").toContain("@");
    }

    const allCalls = [...attemptNodes.flatMap((a) => a.calls), ...routeNode!.calls];
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    const okCall = allCalls.find((call) => call.status === "success");
    const failCall = allCalls.find((call) => call.status === "error" && call.http === 429);
    expect(okCall).toBeDefined();
    expect(okCall!.provider).toBe("fake-b-ok");
    expect(failCall).toBeDefined();
    expect(failCall!.provider).toBe("fake-a-rl");

    expect((await fetch(`${baseA}/telemetry/tree`)).status).toBe(400);
  });

  test("cross-provider fallback rewrites body model to each candidate's concrete id", async () => {
    const seenModels: Array<{ provider: string; model: string }> = [];
    const mkCapture = (id: string, modelName: string, mode: "rate-limited" | "ok"): FakeUpstream => {
      const app = new Hono();
      app.post("/v1/chat/completions", async (c) => {
        const b = (await c.req.json()) as { model?: string };
        seenModels.push({ provider: id, model: b.model ?? "(none)" });
        if (mode === "rate-limited") {
          return c.json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, {
            "retry-after": "5",
          });
        }
        return c.json({
          id: "chatcmpl-f1",
          object: "chat.completion",
          created: 1700000000,
          model: b.model,
          choices: [{ index: 0, message: { role: "assistant", content: `SERVED:${b.model}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
      });
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      return {
        provider: {
          id,
          kind: "openai-compatible",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          envKey: `FAKE_${id.toUpperCase().replace(/-/g, "_")}_KEY`,
          notes: "rewrite fixture",
          models: [mkModel(modelName, "M")],
        },
        server,
      };
    };

    const provRl = mkCapture("aa-f1-rl", "aa-only-model", "rate-limited");
    const provOk = mkCapture("bb-f1-ok", "bb-only-model", "ok");
    const cond = createRouterApp({
      dbPath: join(tmpRoot, "f1.db"),
      providers: [provRl.provider, provOk.provider],
    });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      await postKey(base, "aa-f1-rl", "sk-f1-aa-000000000");
      await postKey(base, "bb-f1-ok", "sk-f1-bb-000000000");

      const res = await fetch(chatUrl(base), {
        method: "POST",
        headers: { "content-type": "application/json", "x-router-tier": "M" },
        body: JSON.stringify({
          model: "aa-only-model",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const respBody = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(respBody.choices[0]!.message.content).toBe("SERVED:bb-only-model");

      const byProv = Object.fromEntries(seenModels.map((s) => [s.provider, s.model]));
      expect(byProv["aa-f1-rl"]).toBe("aa-only-model");
      expect(byProv["bb-f1-ok"]).toBe("bb-only-model");

      const route: RouteHeader = JSON.parse(res.headers.get("x-engine-route")!) as RouteHeader;
      expect(route.attempts[0]!.model).toBe("aa-only-model");
      expect(route.attempts[0]!.http).toBe(429);
      expect(route.attempts[1]!.provider).toBe("bb-f1-ok");
      expect(route.attempts[1]!.status).toBe("ok");
      expect(route.model).toBe("bb-only-model");
    } finally {
      srv.stop(true);
      provRl.server.stop(true);
      provOk.server.stop(true);
    }
  });

  test("abort hygiene: upstream dying mid-stream cancels it and appends ': upstream aborted' comment", async () => {
    const encoder = new TextEncoder();
    const app = new Hono();
    app.post("/v1/chat/completions", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"PART"}}]}\n\n',
            ),
          );
          setTimeout(() => controller.error(new Error("upstream socket reset")), 5);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const prov: Provider = {
      id: "fake-dies-midstream",
      kind: "openai-compatible",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      envKey: "FAKE_DIES_KEY",
      notes: "errors mid-stream",
      models: [mkModel("dying-m", "M")],
    };
    const cond = createRouterApp({ dbPath: join(tmpRoot, "f12.db"), providers: [prov] });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    try {
      await postKey(`http://127.0.0.1:${srv.port}`, "fake-dies-midstream", "sk-f12-00000000000");
      const res = await fetch(chatUrl(`http://127.0.0.1:${srv.port}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "dying-m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"content":"PART"');
      expect(text).toContain(": upstream aborted\n");
      const idxAborted = text.indexOf(": upstream aborted");
      const idxPart = text.indexOf('"content":"PART"');
      expect(idxAborted).toBeGreaterThan(idxPart);

      const abortCalls = (await (
        await fetch(`http://127.0.0.1:${srv.port}/telemetry/calls?limit=10`)
      ).json()) as { calls: Array<{ provider: string; status: string; error: string | null }> };
      const abortedRow = abortCalls.calls.find((r) => r.provider === "fake-dies-midstream");
      expect(abortedRow).toBeDefined();
      expect(abortedRow!.status).toBe("error");
      expect(abortedRow!.error ?? "").toContain("aborted");
    } finally {
      srv.stop(true);
      server.stop(true);
    }
  });

  test("context tokens signal is wired via x-context-tokens header", async () => {
    const res = await fetch(chatUrl(baseA), {
      method: "POST",
      headers: { "content-type": "application/json", "x-context-tokens": "45000" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const route: RouteHeader = JSON.parse(res.headers.get("x-engine-route")!) as RouteHeader;
    expect(route.reason).toContain("repoMap 45000tok > 40000 (+1)");

    const plain = await fetch(chatUrl(baseA), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    const plainRoute: RouteHeader = JSON.parse(plain.headers.get("x-engine-route")!) as RouteHeader;
    expect(plainRoute.reason).not.toContain("repoMap");
  });

  test("x-router-tier routes to that tier's candidate", async () => {
    const res = await fetch(chatUrl(baseA), {
      method: "POST",
      headers: { "content-type": "application/json", "x-router-tier": "L" },
      body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content: "plan" }] }),
    });
    expect(res.status).toBe(200);
    const route: RouteHeader = JSON.parse(res.headers.get("x-engine-route")!) as RouteHeader;
    expect(route.tier).toBe("L");
    expect(route.model).toBe("fake-planner");
    expect(route.reason).toContain("forced");
    expect(route.attempts.length).toBe(1);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("FAKE_OK");
  });

  test("503 no provider configured when no keys exist anywhere", async () => {
    const none = startFakeProvider({
      id: "fake-none-1",
      mode: "rate-limited",
      models: [mkModel("fake-m", "M")],
    });
    const cond = createRouterApp({ dbPath: join(tmpRoot, "none.db"), providers: [none.provider] });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    try {
      const res = await fetch(chatUrl(`http://127.0.0.1:${srv.port}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fake-m", messages: [{ role: "user", content: "x" }] }),
      });
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: string; attempts: unknown[] };
      expect(json.error).toBe("no provider configured");
      expect(json.attempts.length).toBe(0);
    } finally {
      srv.stop(true);
      none.server.stop(true);
    }
  });

  test("B23: 429 when the whole chain is exhausted by rate limits (engine quota-backoff)", async () => {
    const rl = startFakeProvider({
      id: "fake-rl-solo",
      mode: "rate-limited",
      models: [mkModel("fake-m", "M")],
    });
    const cond = createRouterApp({ dbPath: join(tmpRoot, "solo.db"), providers: [rl.provider] });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const kp = await postKey(base, "fake-rl-solo", "sk-solo-0000000000");
      expect(kp.status).toBe(200);

      const res = await fetch(chatUrl(base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fake-m", messages: [{ role: "user", content: "x" }] }),
      });
      expect(res.status).toBe(429);
      const json = (await res.json()) as { error: string; attempts: RouteHeader["attempts"] };
      expect(json.error).toBe("all providers rate-limited");
      expect(json.attempts.length).toBe(1);
      expect(json.attempts[0]!.provider).toBe("fake-rl-solo");
      expect(json.attempts[0]!.http).toBe(429);

      const callsJson = (await (
        await fetch(`${base}/telemetry/calls?limit=10`)
      ).json()) as { calls: Array<{ provider: string; status: string; http: number | null }> };
      expect(callsJson.calls.some((r) => r.provider === "fake-rl-solo" && r.http === 429)).toBe(true);
    } finally {
      srv.stop(true);
      rl.server.stop(true);
    }
  });

  test("route service: long hard prompt routes higher than a short trivial one, reasons explain why", async () => {
    const sProv = startFakeProvider({
      id: "fake-len-s",
      mode: "ok",
      models: [mkModel("len-small", "S")],
    });
    const mProv = startFakeProvider({
      id: "fake-len-m",
      mode: "ok",
      models: [mkModel("len-med", "M")],
    });
    const cond = createRouterApp({ dbPath: join(tmpRoot, "len.db"), providers: [sProv.provider, mProv.provider] });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      await postKey(base, "fake-len-s", "sk-len-s-0000000000");
      await postKey(base, "fake-len-m", "sk-len-m-0000000000");

      const chat = (task: string, content: string): RequestInit => ({
        method: "POST",
        headers: { "content-type": "application/json", "x-engine-task": task },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] }),
      });

      const short = await fetch(chatUrl(base), chat("task-len-short", "hi"));
      expect(short.status).toBe(200);
      const shortRoute: RouteHeader = JSON.parse(short.headers.get("x-engine-route")!) as RouteHeader;
      expect(shortRoute.tier).toBe("S");
      expect(shortRoute.model).toBe("len-small");
      expect((shortRoute.reason ?? "").length).toBeGreaterThan(0);

      const longContent = `please refactor this module ${"x".repeat(2100)}`;
      const long = await fetch(chatUrl(base), chat("task-len-long", longContent));
      expect(long.status).toBe(200);
      const longRoute: RouteHeader = JSON.parse(long.headers.get("x-engine-route")!) as RouteHeader;
      expect(longRoute.tier).toBe("M");
      expect(longRoute.model).toBe("len-med");

      expect(longRoute.reason).not.toBe(shortRoute.reason);
      expect(longRoute.reason).toContain("hard keyword");
      expect(longRoute.reason).toContain("budget:");
      expect(longRoute.reason).toContain("provider fake-len-m chosen");
    } finally {
      srv.stop(true);
      sProv.server.stop(true);
      mProv.server.stop(true);
    }
  });

  test("engine/* model aliases override the tier and rewrite the forwarded model id", async () => {
    const seenModels: string[] = [];
    const capApp = new Hono();
    capApp.post("/v1/chat/completions", async (c) => {
      const b = (await c.req.json()) as { model?: string };
      seenModels.push(b.model ?? "(none)");
      return c.json({
        id: "chatcmpl-cap",
        object: "chat.completion",
        created: 1700000000,
        model: b.model,
        choices: [
          { index: 0, message: { role: "assistant", content: `USED:${b.model}` }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    });
    const capServer = Bun.serve({ port: 0, fetch: capApp.fetch });
    const capProvider: Provider = {
      id: "fake-cap",
      kind: "openai-compatible",
      baseURL: `http://127.0.0.1:${capServer.port}/v1`,
      envKey: "FAKE_CAP_KEY",
      notes: "captures which model id it was asked for",
      models: [mkModel("cap-small", "S"), mkModel("cap-large", "L")],
    };
    const cond = createRouterApp({ dbPath: join(tmpRoot, "alias.db"), providers: [capProvider] });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      await postKey(base, "fake-cap", "sk-cap-000000000000");

      const smallRes = await fetch(chatUrl(base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "engine/small", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(smallRes.status).toBe(200);
      const smallBody = (await smallRes.json()) as { choices: Array<{ message: { content: string } }> };
      expect(smallBody.choices[0]!.message.content).toBe("USED:cap-small");
      const smallRoute: RouteHeader = JSON.parse(smallRes.headers.get("x-engine-route")!) as RouteHeader;
      expect(smallRoute.tier).toBe("S");
      expect(smallRoute.model).toBe("cap-small");
      expect(smallRoute.reason).toContain("engine/small");

      const largeRes = await fetch(chatUrl(base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "engine/large", messages: [{ role: "user", content: "plan deeply" }] }),
      });
      expect(largeRes.status).toBe(200);
      const largeBody = (await largeRes.json()) as { choices: Array<{ message: { content: string } }> };
      expect(largeBody.choices[0]!.message.content).toBe("USED:cap-large");
      const largeRoute: RouteHeader = JSON.parse(largeRes.headers.get("x-engine-route")!) as RouteHeader;
      expect(largeRoute.tier).toBe("L");
      expect(seenModels[seenModels.length - 1]).toBe("cap-large");
    } finally {
      srv.stop(true);
      capServer.stop(true);
    }
  });

  test("cascade: a final fallback failure escalates the next request for the same task", async () => {
    const rlS = startFakeProvider({
      id: "fake-casc-s",
      mode: "rate-limited",
      models: [mkModel("casc-s", "S")],
    });
    const okM = startFakeProvider({
      id: "fake-casc-m",
      mode: "ok",
      models: [mkModel("casc-m", "M")],
    });
    const cond = createRouterApp({
      dbPath: join(tmpRoot, "cascade.db"),
      providers: [rlS.provider, okM.provider],
    });
    const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
    const base = `http://127.0.0.1:${srv.port}`;
    const chat = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", "x-engine-task": "task-casc" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "do a tiny thing" }] }),
    });
    try {
      await postKey(base, "fake-casc-s", "sk-casc-s-00000000");
      await postKey(base, "fake-casc-m", "sk-casc-m-00000000");

      const r1 = await fetch(chatUrl(base), chat());
      // B23: chain exhausted by a 429 now answers an honest 429 (was 503). The
      // cascade still records the failure so r2 escalates to tier M below.
      expect(r1.status).toBe(429);
      const route1: RouteHeader = JSON.parse(r1.headers.get("x-engine-route")!) as RouteHeader;
      expect(route1.tier).toBe("S");
      expect(route1.attempts[0]!.model).toBe("casc-s");

      const r2 = await fetch(chatUrl(base), chat());
      expect(r2.status).toBe(200);
      const route2: RouteHeader = JSON.parse(r2.headers.get("x-engine-route")!) as RouteHeader;
      expect(route2.tier).toBe("M");
      expect(route2.model).toBe("casc-m");
      expect(route2.reason).toContain("escalate");
      const body2 = (await r2.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body2.choices[0]!.message.content).toBe("FAKE_OK");
    } finally {
      srv.stop(true);
      rlS.server.stop(true);
      okM.server.stop(true);
    }
  });

  test("CORS: OPTIONS preflight answers 2xx with Access-Control-Allow-Origin", async () => {
    const preflight = await condA.app.request("/keys", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:4444",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBeGreaterThanOrEqual(200);
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

    const plain = await condA.app.request("/health", { headers: { origin: "http://localhost:4444" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("GET /telemetry/tasks lists task ledger rows for the dashboard selector", async () => {
    const res = await fetch(`${baseA}/telemetry/tasks`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      tasks: Array<{ id: string; started_ts: number | null; spent_usd: number; state: string }>;
    };
    expect(Array.isArray(json.tasks)).toBe(true);
    const row = json.tasks.find((t) => t.id === "task-smoke-1");
    expect(row).toBeDefined();
    expect(row!.state).toBe("active");
    expect(row!.started_ts).not.toBeNull();
    expect(row!.spent_usd).toBeGreaterThanOrEqual(0);
  });
});
