/**
 * Attribution tests — bun test, no real network.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttributionService } from "../src/attr";
import { createRouterApp } from "../src/index";
import { getWatchdog, startWatchdog, type WatchdogHandle } from "../src/watchdog";
import type { Provider } from "../src/providers";

interface FakeEngine {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  send(obj: unknown): void;
  messages: Array<{ taskId: string; body: unknown }>;
  aborts: string[];
  hits: { globalEvent: number; legacyScopedEvent: number };
}

function mkEngine(): FakeEngine {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c: ReadableStreamDefaultController<Uint8Array>): void {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const legacyScopedResponse = (): Response => {
    const s = new ReadableStream<Uint8Array>({
      start(c: ReadableStreamDefaultController<Uint8Array>): void {
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`));
        c.enqueue(encoder.encode(": heartbeat\n\n"));
      },
    });
    return new Response(s, { headers: { "content-type": "text/event-stream" } });
  };
  const eng: FakeEngine = {
    url: "",
    server: null as unknown as ReturnType<typeof Bun.serve>,
    messages: [],
    aborts: [],
    hits: { globalEvent: 0, legacyScopedEvent: 0 },
    send(obj: unknown): void {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    },
  };
  const app = new Hono();
  app.get("/global/event", () => {
    eng.hits.globalEvent++;
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  app.get("/event", () => {
    eng.hits.legacyScopedEvent++;
    return legacyScopedResponse();
  });
  app.post("/api/tasks/:id/message", async (c) => {
    eng.messages.push({ taskId: c.req.param("id"), body: await c.req.json() });
    return c.json({ ok: true });
  });
  app.post("/api/tasks/:id/stop", (c) => {
    eng.aborts.push(c.req.param("id"));
    return c.json({ ok: true });
  });
  eng.server = Bun.serve({ port: 0, fetch: app.fetch });
  eng.url = `http://127.0.0.1:${eng.server.port}`;
  return eng;
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-attr-"));
const engine = mkEngine();
const attribution = new AttributionService();

const upstreamApp = new Hono();
upstreamApp.post("/v1/chat/completions", () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-attr",
      object: "chat.completion",
      created: 1700000000,
      model: "attr-small",
      choices: [{ index: 0, message: { role: "assistant", content: "ATTR_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
);
const upstreamServer = Bun.serve({ port: 0, fetch: upstreamApp.fetch });

const provider: Provider = {
  id: "fake-attr",
  kind: "openai-compatible",
  baseURL: `http://127.0.0.1:${upstreamServer.port}/v1`,
  envKey: "FAKE_ATTR_KEY",
  notes: "attribution-test upstream",
  models: [
    { model_id_per_provider: "attr-small", tier: "S", ctx_window: 8192, price_in: 0, price_out: 0, param_b: 7 },
  ],
};

const cond = createRouterApp({
  dbPath: join(tmpRoot, "attr.db"),
  providers: [provider],
  attribution,
});
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: cond.app.fetch });
const base = `http://127.0.0.1:${server.port}`;
const chatUrl = `${base}/v1/chat/completions`;

let wd: WatchdogHandle;

afterAll(() => {
  wd?.stop();
  getWatchdog()?.stop();
  server.stop(true);
  upstreamServer.stop(true);
  engine.server.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("AttributionService", () => {
  test("tracks recency across directories and returns null before any event", () => {
    const a = new AttributionService();
    expect(a.mostRecent()).toBeNull();

    a.observe("s-old", { directory: "/a", now: 1000 });
    expect(a.mostRecent()?.sessionID).toBe("s-old");

    a.observe("s-b", { directory: "/b", now: 2000 });
    expect(a.mostRecent()?.sessionID).toBe("s-b");
    expect(a.mostRecent()?.directory).toBe("/b");

    a.observe("s-a2", { directory: "/a", now: 3000 });
    expect(a.mostRecent()?.sessionID).toBe("s-a2");
    expect(a.snapshot()?.ts).toBe(3000);
  });

  test("empty sessionIDs are ignored", () => {
    const a = new AttributionService();
    a.observe("", { now: 100 });
    expect(a.mostRecent()).toBeNull();
  });
});

describe("watchdog-driven attribution", () => {
  test("message.part.updated events attribute unheadered chats to the live session", async () => {
    getWatchdog()?.stop();
    wd = startWatchdog({
      engineUrl: engine.url,
      directory: "/proj-attr",
      telemetry: cond.telemetry,
      limits: { nudgeCooldownMs: 60_000 },
      budgetIntervalMs: 3_600_000,
      attribution,
    });
    await waitFor(() => wd.status().attached);

    await waitFor(() => engine.hits.globalEvent >= 1);
    expect(engine.hits.legacyScopedEvent).toBe(0);

    const kp = await fetch(`${base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "fake-attr", key: "sk-attr-000000000000" }),
    });
    expect(kp.status).toBe(200);

    engine.send({
      payload: { type: "message.part.updated", properties: { sessionID: "sess-live-1", part: { sessionID: "sess-live-1" } } },
    });
    await sleep(50);
    engine.send({
      payload: { type: "session.idle", properties: { sessionID: "sess-live-2" } },
    });
    await sleep(50);

    const status = wd.status();
    expect(status.lastActiveSession?.sessionID).toBe("sess-live-2");
    expect(status.lastActiveSession?.directory).toBeNull();

    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "engine/small",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);

    const callsJson = (await (
      await fetch(`${base}/telemetry/calls?limit=10`)
    ).json()) as { calls: Array<{ provider: string; session: string | null; task: string | null }> };
    const row = callsJson.calls.find((r) => r.provider === "fake-attr");
    expect(row).toBeDefined();
    expect(row!.session).toBe("sess-live-2");

    const taskRes = await fetch(`${base}/telemetry/task/sess-live-2`);
    expect(taskRes.status).toBe(200);
    const taskJson = (await taskRes.json()) as { task: { state: string; started_ts: number | null } };
    expect(taskJson.task.state).toBe("active");
    expect(taskJson.task.started_ts).not.toBeNull();
    expect(row!.task).toBe("sess-live-2");

    engine.send({
      payload: { type: "message.part.updated", properties: { sessionID: "sess-live-3" } },
    });
    await sleep(50);
    const res2 = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "engine/small", messages: [{ role: "user", content: "hi again" }] }),
    });
    expect(res2.status).toBe(200);
    const calls2 = (await (
      await fetch(`${base}/telemetry/calls?limit=10`)
    ).json()) as { calls: Array<{ provider: string; session: string | null }> };
    const newest = calls2.calls.filter((r) => r.provider === "fake-attr")[0];
    expect(newest!.session).toBe("sess-live-3");
  });

  test("explicit x-session-id header takes precedence over attribution", async () => {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess-explicit" },
      body: JSON.stringify({ model: "engine/small", messages: [{ role: "user", content: "mine" }] }),
    });
    expect(res.status).toBe(200);
    const callsJson = (await (
      await fetch(`${base}/telemetry/calls?limit=10`)
    ).json()) as { calls: Array<{ provider: string; session: string | null; task: string | null }> };
    const row = callsJson.calls.filter((r) => r.provider === "fake-attr")[0];
    expect(row!.session).toBe("sess-explicit");
    expect(row!.task).toBeNull();
  });

  test("watchdog nudge traces keep parent_id=null but carry task/session in detail_json", async () => {
    for (let i = 0; i < 3; i++) {
      engine.send({
        payload: {
          type: "session.next.tool.success",
          properties: { sessionID: "sess-loop", tool: "bash", args: { cmd: "attr-doom" } },
        },
      });
    }
    await waitFor(() => engine.messages.some((m) => m.taskId === "sess-loop"));

    const traces = cond.telemetry.listTraces(100);
    const nudge = traces.find((t) => t.kind === "watchdog.nudge" && t.label === "sess-loop");
    expect(nudge).toBeDefined();
    expect(nudge!.parent_id).toBeNull();
    const detail = JSON.parse(nudge!.detail_json ?? "{}") as { task?: string; text?: string };
    expect(detail.task).toBe("sess-loop");
  });
});
