/**
 * Watchdog tests — bun test, no real network.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argsHash } from "../src/watchdog/events";
import { FINALIZE_MESSAGE } from "../src/watchdog/messages";
import { getWatchdog, startWatchdog, type WatchdogHandle } from "../src/watchdog";
import type { WatchdogTelemetry } from "../src/watchdog/types";
import { createRouterApp } from "../src/index";

interface FakeEngine {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  send(obj: unknown): void;
  raw(text: string): void;
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
    raw(text: string): void {
      controller.enqueue(encoder.encode(text));
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

function toolEvent(session: string, tool: string, args: unknown, opts?: { failed?: boolean; output?: string }): unknown {
  return {
    payload: {
      type: `session.next.tool.${opts?.failed ? "failed" : "success"}`,
      properties: {
        sessionID: session,
        tool,
        args,
        ...(opts?.output !== undefined ? { output: opts.output } : {}),
      },
    },
  };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-wd-"));
const engine = mkEngine();

const traces: Array<{ kind: string; task: string | null; label: string | null }> = [];
let activeTaskRows: Array<{
  id: string;
  created_ts: number;
  state: string;
  budget_usd: number;
  wall_deadline_s: number;
  spent_usd: number;
  started_ts: number | null;
}> = [];
const costByTask = new Map<string, number>();
const callsByTask = new Map<string, Array<{ session: string | null; ts: number }>>();

const fakeTelemetry: WatchdogTelemetry = {
  addTrace(t) {
    traces.push({ kind: t.kind, task: t.task, label: t.label });
    return traces.length;
  },
  listActiveTasks() {
    return activeTaskRows;
  },
  listCalls(task) {
    return callsByTask.get(task ?? "") ?? [];
  },
  sumCostByTask(id) {
    return costByTask.get(id) ?? 0;
  },
  lastCallTs(id) {
    const calls = callsByTask.get(id) ?? [];
    if (calls.length === 0) return null;
    return Math.max(...calls.map((c) => c.ts));
  },
  setTaskState(id, state) {
    for (const row of activeTaskRows) {
      if (row.id === id) row.state = state;
    }
  },
};

const wd: WatchdogHandle = startWatchdog({
  engineUrl: engine.url,
  directory: "/proj",
  telemetry: fakeTelemetry,
  limits: { nudgeCooldownMs: 250, maxInterventionsPerTask: 3 },
  budgetIntervalMs: 3_600_000,
});

afterAll(() => {
  wd.stop();
  getWatchdog()?.stop();
  engine.server.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function messagesFor(taskId: string): Array<{ taskId: string; body: unknown }> {
  return engine.messages.filter((m) => m.taskId === taskId);
}

function abortsFor(taskId: string): number {
  return engine.aborts.filter((a) => a === taskId).length;
}

describe("watchdog", () => {
  test("argsHash is stable across argument key order and sensitive to tool name", () => {
    const a = argsHash("bash", { cmd: "ls", flags: ["-l"], nested: { z: 1, y: 2 } });
    const b = argsHash("bash", { nested: { y: 2, z: 1 }, flags: ["-l"], cmd: "ls" });
    expect(a).toBe(b);
    expect(argsHash("grep", { cmd: "ls" })).not.toBe(a);
  });

  test("subscribes /global/event", async () => {
    await waitFor(() => engine.hits.globalEvent >= 1);
    expect(engine.hits.legacyScopedEvent).toBe(0);
  });

  test("loop of identical tool calls -> one nudge; immediate repeats stay in cooldown", async () => {
    const hashArgs = { cmd: "npm test" };
    for (let i = 0; i < 3; i++) engine.send(toolEvent("s1", "bash", hashArgs));
    await waitFor(() => messagesFor("s1").length >= 1);

    expect(messagesFor("s1").length).toBe(1);
    const body = messagesFor("s1")[0]!.body as { message?: string; parts?: Array<{ text: string }> };
    const text = body.message ?? body.parts?.[0]?.text ?? "";
    expect(text).toContain("Watchdog:");
    expect(text).toContain("repeated bash");
    expect(engine.aborts.filter((a) => a === "s1").length).toBe(0);

    for (let i = 0; i < 3; i++) engine.send(toolEvent("s1", "bash", hashArgs));
    await sleep(120);
    expect(messagesFor("s1").length).toBe(1);
  });

  test("alternating A,B,A,B period-2 loop is detected", async () => {
    engine.send(toolEvent("s2", "edit", { file: "a.ts" }));
    engine.send(toolEvent("s2", "edit", { file: "b.ts" }));
    engine.send(toolEvent("s2", "edit", { file: "a.ts" }));
    await sleep(30);
    expect(messagesFor("s2").length).toBe(0);
    engine.send(toolEvent("s2", "edit", { file: "b.ts" }));
    await waitFor(() => messagesFor("s2").length >= 1);
    expect(messagesFor("s2").length).toBe(1);
  });

  test("error spam: 6 consecutive byte-identical failed outputs fire an intervention", async () => {
    for (let i = 0; i < 6; i++) {
      engine.send(toolEvent("s3", "grep", { attempt: i }, { failed: true, output: "boom: permission denied" }));
    }
    await waitFor(() => messagesFor("s3").length >= 1);
    const body = messagesFor("s3")[0]!.body as { message?: string; parts?: Array<{ text: string }> };
    const text = body.message ?? body.parts?.[0]?.text ?? "";
    expect(text).toContain("repeated grep");
  });

  test("B42: 6 byte-identical SUCCESSFUL outputs do NOT fire an error-spam intervention", async () => {
    for (let i = 0; i < 6; i++) {
      engine.send(toolEvent("s42", "grep", { attempt: i }, { failed: false, output: "match: ok" }));
    }
    // Give the watchdog ample time to (incorrectly) fire if B42 regressed.
    await sleep(800);
    expect(messagesFor("s42").length).toBe(0);
  });

  test("action chain escalates nudge->abort and goes abort-only past the intervention cap", async () => {
    const hashArgs = { cmd: "cargo build" };
    const burst = (): void => {
      for (let i = 0; i < 3; i++) engine.send(toolEvent("s4", "bash", hashArgs));
    };

    burst();
    await waitFor(() => messagesFor("s4").length >= 1);

    await sleep(320);
    burst();
    await waitFor(() => abortsFor("s4") >= 1);

    await sleep(320);
    burst();
    await waitFor(() => abortsFor("s4") >= 2);

    await sleep(320);
    burst();
    await waitFor(() => abortsFor("s4") >= 3);

    await sleep(50);
    expect(messagesFor("s4").length).toBe(1);
    expect(abortsFor("s4")).toBe(3);
    const abortTraces = traces.filter((t) => t.kind === "watchdog.abort" && t.label === "s4");
    expect(abortTraces.length).toBe(3);
    const status = wd.status();
    expect(status.attached).toBe(true);
    expect(status.totals.aborts).toBeGreaterThanOrEqual(3);
    expect(status.sessions.some((s) => s.sessionId === "s4")).toBe(true);
  }, 15000);

  test("malformed and unknown frames are ignored without killing the stream", async () => {
    const beforeMsgs = engine.messages.length;
    const beforeAborts = engine.aborts.length;

    engine.raw("data: not-json-at-all\n\n");
    engine.raw(": sse comment frame\n\n");
    engine.raw("data: [DONE]\n\n");
    engine.send({ payload: { type: "unknown.thing", properties: { sessionID: "sx" } } });
    engine.send({ payload: { type: "session.idle", properties: {} } });
    await sleep(80);

    expect(engine.messages.length).toBe(beforeMsgs);
    expect(engine.aborts.length).toBe(beforeAborts);

    for (let i = 0; i < 3; i++) engine.send(toolEvent("s6", "bash", { cmd: "still alive" }));
    await waitFor(() => messagesFor("s6").length >= 1);
  });

  test("client-side directory scoping: mismatched-directory frames drop, matching/workspace-tagged pass", async () => {
    for (let i = 0; i < 3; i++) {
      engine.send({
        payload: {
          type: "session.next.tool.success",
          properties: { sessionID: "s-dir-other", tool: "bash", args: { cmd: "other" }, directory: "/elsewhere" },
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      engine.send({
        payload: {
          type: "session.next.tool.success",
          properties: { sessionID: "s-dir-match", tool: "bash", args: { cmd: "match" }, directory: "/proj" },
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      engine.send({
        payload: {
          type: "session.next.tool.success",
          properties: { sessionID: "s-dir-ws", tool: "bash", args: { cmd: "ws" }, workspace: { directory: "/proj" } },
        },
      });
    }
    await waitFor(() => messagesFor("s-dir-match").length >= 1 && messagesFor("s-dir-ws").length >= 1);
    await sleep(120);
    expect(messagesFor("s-dir-other").length).toBe(0);
    expect(messagesFor("s-dir-match").length).toBe(1);
    expect(messagesFor("s-dir-ws").length).toBe(1);
  }, 8000);

  test("budget governor: finalize transition sends the FINALIZE MODE message once", async () => {
    activeTaskRows = [
      {
        id: "t-fin",
        created_ts: Date.now(),
        state: "active",
        budget_usd: 0.5,
        wall_deadline_s: 2700,
        spent_usd: 0,
        started_ts: Date.now() - 1000,
      },
    ];
    costByTask.set("t-fin", 0.42);
    callsByTask.set("t-fin", [{ session: "s-fin", ts: Date.now() }]);

    const results = await wd.governor.tick();
    expect(results[0]!.task).toBe("t-fin");
    expect(results[0]!.mode).toBe("finalize");
    expect(results[0]!.acted).toBe(true);
    const finMessages = messagesFor("s-fin");
    expect(finMessages.length).toBe(1);
    const body = finMessages[0]!.body as { message?: string; parts?: Array<{ text: string }> };
    const text = body.message ?? body.parts?.[0]?.text ?? "";
    expect(text).toBe(FINALIZE_MESSAGE);

    const again = await wd.governor.tick();
    expect(again[0]!.mode).toBe("finalize");
    expect(again[0]!.acted).toBe(false);
    expect(messagesFor("s-fin").length).toBe(1);
  });

  test("budget governor: halt transition aborts sessions and writes a watchdog.halt trace", async () => {
    costByTask.set("t-fin", 0.6);
    const results = await wd.governor.tick();
    expect(results[0]!.mode).toBe("halt");
    expect(results[0]!.acted).toBe(true);
    expect(engine.aborts.includes("s-fin")).toBe(true);

    expect(traces.some((t) => t.kind === "watchdog.halt" && t.task === "t-fin")).toBe(true);
    const status = wd.status();
    expect(status.budget.some((b) => b.task === "t-fin" && b.mode === "halt")).toBe(true);

    const again = await wd.governor.tick();
    expect(again[0]!.acted).toBe(false);
    expect(engine.aborts.filter((a) => a === "s-fin").length).toBe(1);
  });

  test("B40: an idle task (no recent call) is finalized as 'idle', not wall-clock halted", async () => {
    const old = Date.now() - 45 * 60_000; // 45 min ago — past the wall deadline
    activeTaskRows = [
      {
        id: "t-idle",
        created_ts: old,
        state: "active",
        budget_usd: 0.5,
        wall_deadline_s: 2700,
        spent_usd: 0,
        started_ts: old,
      },
    ];
    costByTask.set("t-idle", 0);
    // Last attributed call was 30 min ago → idle (> IDLE_FINALIZE_MS), $0 spent.
    callsByTask.set("t-idle", [{ session: "s-idle", ts: Date.now() - 30 * 60_000 }]);

    const results = await wd.governor.tick();
    expect(results[0]!.task).toBe("t-idle");
    // Must NOT be halted despite being past the wall-clock deadline.
    expect(results[0]!.mode).toBe("normal");
    expect(results[0]!.acted).toBe(false);
    expect(engine.aborts.includes("s-idle")).toBe(false);
    // The row was moved out of 'active' so the governor stops policing it.
    expect(activeTaskRows[0]!.state).toBe("idle");
  });

  test("GET /watchdog/status + POST /watchdog/attach via router app", async () => {
    getWatchdog()?.stop();
    expect(getWatchdog()).toBeNull();

    const engine2 = mkEngine();
    try {
      const cond = createRouterApp({ dbPath: join(tmpRoot, "wd-endpoint.db") });
      const srv = Bun.serve({ port: 0, fetch: cond.app.fetch });
      const base = `http://127.0.0.1:${srv.port}`;
      try {
        const detached = (await (await fetch(`${base}/watchdog/status`)).json()) as { attached: boolean };
        expect(detached.attached).toBe(false);

        const attachRes = await fetch(`${base}/watchdog/attach`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ engineUrl: engine2.url, directory: "/proj2" }),
        });
        expect(attachRes.status).toBe(200);
        const attached = (await attachRes.json()) as { attached: boolean; directory: string | null };
        expect(attached.attached).toBe(true);
        expect(attached.directory).toBe("/proj2");

        const status = (await (await fetch(`${base}/watchdog/status`)).json()) as { attached: boolean };
        expect(status.attached).toBe(true);
      } finally {
        srv.stop(true);
      }
    } finally {
      engine2.server.stop(true);
      getWatchdog()?.stop();
    }
  });
});
