/**
 * Deny-nudge watchdog tests — bun test, no real network.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { startWatchdog, type WatchdogHandle } from "../src/watchdog";
import { DEFAULT_DENY_NUDGE_LIMITS } from "../src/watchdog/types";
import { denyNudgeMessage } from "../src/watchdog/messages";
import type { WatchdogTelemetry } from "../src/watchdog/types";

interface FakeEngine {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  send(obj: unknown): void;
  messages: Array<{ taskId: string; body: unknown }>;
}

function mkEngine(): FakeEngine {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c: ReadableStreamDefaultController<Uint8Array>): void {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const eng: FakeEngine = {
    url: "",
    server: null as unknown as ReturnType<typeof Bun.serve>,
    messages: [],
    send(obj: unknown): void {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    },
  };
  const app = new Hono();
  app.get("/global/event", () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  app.get("/event", () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  app.post("/api/tasks/:id/message", async (c) => {
    eng.messages.push({ taskId: c.req.param("id"), body: await c.req.json() });
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

function v2Asked(session: string, action: string): unknown {
  return { id: "evt_a", type: "permission.v2.asked", properties: { sessionID: session, requestID: "p1", action } };
}
function v2Replied(session: string, reply: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: "evt_r",
    type: "permission.v2.replied",
    properties: { sessionID: session, requestID: "p1", reply, ...extra },
  };
}
function legacyReplied(session: string, reply: string): unknown {
  return { payload: { type: "permission.replied", properties: { sessionID: session, requestID: "p1", reply } } };
}

const engine = mkEngine();
const traces: Array<{ kind: string; label: string | null }> = [];
const fakeTelemetry: WatchdogTelemetry = {
  addTrace(t) {
    traces.push({ kind: t.kind, label: t.label });
    return traces.length;
  },
  listActiveTasks: () => [],
  listCalls: () => [],
  sumCostByTask: () => 0,
  lastCallTs: () => null,
  setTaskState: () => {},
};

const wd: WatchdogHandle = startWatchdog({
  engineUrl: engine.url,
  telemetry: fakeTelemetry,
  denyNudgeLimits: { cooldownMs: 120, maxPerSession: 3 },
  budgetIntervalMs: 3_600_000,
});

afterAll(() => {
  wd.stop();
  engine.server.stop(true);
});

function messagesFor(taskId: string): Array<{ taskId: string; body: unknown }> {
  return engine.messages.filter((m) => m.taskId === taskId);
}

function nudgeTexts(taskId: string): string[] {
  return messagesFor(taskId).map((m) => {
    const b = m.body as { message?: string; parts?: Array<{ text: string }> };
    return b.message ?? b.parts?.[0]?.text ?? "";
  });
}

describe("watchdog deny nudge", () => {
  test("shipped defaults are 2 min cooldown, max 5 per session", () => {
    expect(DEFAULT_DENY_NUDGE_LIMITS).toEqual({ cooldownMs: 120_000, maxPerSession: 5 });
  });

  test("reject after an ask sends exactly one guidance message naming the tool", async () => {
    engine.send(v2Asked("d1", "edit"));
    await sleep(40);
    engine.send(v2Replied("d1", "reject"));
    await waitFor(() => messagesFor("d1").length >= 1);

    const texts = nudgeTexts("d1");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("Your last edit action was denied by the user");
    expect(texts[0]).toContain("do not retry the identical action");
    expect(traces.some((t) => t.kind === "watchdog.deny-nudge" && t.label === "d1")).toBe(true);
  });

  test("immediate second reject stays in cooldown; later one fires again", async () => {
    engine.send(v2Asked("d2", "bash"));
    await sleep(30);
    engine.send(v2Replied("d2", "reject"));
    await waitFor(() => messagesFor("d2").length >= 1);

    engine.send(v2Replied("d2", "reject"));
    await sleep(60);
    expect(messagesFor("d2").length).toBe(1);

    await sleep(140);
    engine.send(v2Replied("d2", "reject"));
    await waitFor(() => messagesFor("d2").length >= 2);
    expect(messagesFor("d2").length).toBe(2);
  });

  test("per-session cap stops nudges after the limit", async () => {
    for (let i = 0; i < 5; i++) {
      engine.send(v2Replied("cap", "reject"));
      await waitFor(() => messagesFor("cap").length >= Math.min(i + 1, 3));
      await sleep(140);
    }
    expect(messagesFor("cap").length).toBe(3);
  });

  test("once/always replies never nudge", async () => {
    engine.send(v2Asked("ok1", "bash"));
    await sleep(30);
    engine.send(v2Replied("ok1", "once"));
    engine.send(v2Replied("ok1", "always"));
    await sleep(100);
    expect(messagesFor("ok1").length).toBe(0);
  });

  test("legacy permission.replied frames fire too; ask-remembered action is reused", async () => {
    engine.send(v2Asked("leg", "bash"));
    await sleep(30);
    engine.send(legacyReplied("leg", "reject"));
    await waitFor(() => messagesFor("leg").length >= 1);
    expect(nudgeTexts("leg")[0]).toContain("Your last bash action was denied");
  });

  test("unknown tool degrades to generic wording", async () => {
    engine.send(v2Replied("gen", "reject"));
    await waitFor(() => messagesFor("gen").length >= 1);
    expect(nudgeTexts("gen")[0]).toBe(denyNudgeMessage());
    expect(nudgeTexts("gen")[0]).toContain("Your last action was denied by the user");
  });

  test("replied frame carrying its own action wins over the remembered ask", async () => {
    engine.send(v2Asked("own", "edit"));
    await sleep(30);
    engine.send(v2Replied("own", "reject", { action: "webfetch" }));
    await waitFor(() => messagesFor("own").length >= 1);
    expect(nudgeTexts("own")[0]).toContain("Your last webfetch action was denied");
  });

  test("malformed reply frames are ignored", async () => {
    const before = engine.messages.length;
    engine.send({ id: "x", type: "permission.v2.replied", properties: { requestID: "p9" } });
    engine.send({ id: "y", type: "permission.v2.replied", properties: { sessionID: "", reply: "reject" } });
    await sleep(80);
    expect(engine.messages.length).toBe(before);
  });
});
