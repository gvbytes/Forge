/**
 * B8 — watchdog ⇄ engine native-envelope contract test.
 *
 * The engine emits the pinned wire envelope on its SSE stream:
 *   { id:number, taskId:string, sessionId:string, ts:number, type:string, payload:object }
 * with type ∈ trace|message|token|task|status|proposal|approval|route, and trace
 * events nested at payload.event ({ kind, label, input, output }). This test feeds
 * those native frames to the watchdog and asserts they drive the stuck/attribution
 * callbacks exactly like the legacy dialect does.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { Hono } from "hono";
import { argsHash } from "../src/watchdog/events";
import { startWatchdog, type WatchdogHandle } from "../src/watchdog";
import type { WatchdogTelemetry } from "../src/watchdog/types";

interface FakeEngine {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  send(obj: unknown): void;
  messages: Array<{ taskId: string; body: unknown }>;
  aborts: string[];
  hits: { globalEvent: number };
}

/** Reconnect-safe fake engine: each SSE connection gets a FRESH stream, and send()
 * pushes to the most recent live controller (guarded against closed controllers). */
function mkEngine(): FakeEngine {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const newStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c: ReadableStreamDefaultController<Uint8Array>): void {
        controller = c;
      },
    });
  const eng: FakeEngine = {
    url: "",
    server: null as unknown as ReturnType<typeof Bun.serve>,
    messages: [],
    aborts: [],
    hits: { globalEvent: 0 },
    send(obj: unknown): void {
      if (!controller) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      } catch {
        /* controller closed (client went away) — ignore in tests */
      }
    },
  };
  const app = new Hono();
  const sse = (): Response => new Response(newStream(), { headers: { "content-type": "text/event-stream" } });
  app.get("/global/event", () => {
    eng.hits.globalEvent++;
    return sse();
  });
  app.get("/event", () => sse());
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

// --- native envelope builders ------------------------------------------------
let idSeq = 0;
let spanSeq = 0;
function frame(taskId: string, sessionId: string, type: string, payload: object, directory?: string): unknown {
  return {
    id: ++idSeq,
    taskId,
    sessionId,
    ts: Date.now(),
    type,
    payload,
    ...(directory ? { directory } : {}),
  };
}
function traceFrame(taskId: string, sessionId: string, event: object, directory?: string): unknown {
  return frame(taskId, sessionId, "trace", { event }, directory);
}
function toolCall(taskId: string, sessionId: string, tool: string, input: unknown, spanId: string, directory?: string): unknown {
  return traceFrame(taskId, sessionId, { kind: "tool.call", label: `tool: ${tool}`, spanId, input }, directory);
}
function toolResult(
  taskId: string,
  sessionId: string,
  tool: string,
  output: { ok: boolean; result?: string; error?: string },
  spanId: string,
  directory?: string,
): unknown {
  return traceFrame(taskId, sessionId, { kind: "tool.result", label: `tool: ${tool}`, spanId, output }, directory);
}
/** Send one full tool invocation = tool.call + matching tool.result (same spanId). */
function sendInvocation(
  eng: FakeEngine,
  taskId: string,
  sessionId: string,
  tool: string,
  input: unknown,
  output: { ok: boolean; result?: string; error?: string },
  directory?: string,
): void {
  const spanId = `span-${++spanSeq}`;
  eng.send(toolCall(taskId, sessionId, tool, input, spanId, directory));
  eng.send(toolResult(taskId, sessionId, tool, output, spanId, directory));
}

// --- telemetry fake ------------------------------------------------------------
const fakeTelemetry: WatchdogTelemetry = {
  addTrace() {
    return 1;
  },
  listActiveTasks() {
    return [];
  },
  listCalls() {
    return [];
  },
  sumCostByTask() {
    return 0;
  },
  lastCallTs() {
    return null;
  },
  setTaskState() {},
};

const engine = mkEngine();
// Started in beforeAll (not at module load) so this watchdog is the ACTIVE one
// when these tests run — other test files also call startWatchdog at module load
// and the shared `active` handle would otherwise be clobbered.
let wd: WatchdogHandle;
beforeAll(async () => {
  wd = startWatchdog({
    engineUrl: engine.url,
    telemetry: fakeTelemetry,
    limits: { nudgeCooldownMs: 250, maxInterventionsPerTask: 3 },
    budgetIntervalMs: 3_600_000,
  });
  // Proven connection signal (mirrors attr.test.ts): attached + the engine's
  // /global/event endpoint actually hit, then a beat for the stream to go live.
  await waitFor(() => wd.status().attached && engine.hits.globalEvent >= 1);
  await sleep(50);
});

afterAll(() => {
  wd.stop();
  engine.server.stop(true);
});

const messagesFor = (id: string): Array<{ taskId: string; body: unknown }> => engine.messages.filter((m) => m.taskId === id);
const nudgeText = (m: { body: unknown }): string => {
  const body = m.body as { message?: string; parts?: Array<{ text: string }> };
  return body.message ?? body.parts?.[0]?.text ?? "";
};

describe("B8: watchdog parses the engine native envelope", () => {
  test("watchdog is attached and streaming from the engine SSE endpoint", () => {
    expect(wd.status().attached).toBe(true);
    expect(engine.hits.globalEvent).toBeGreaterThanOrEqual(1);
  });

  test("native repeated tool invocations drive a nudge keyed by taskId (task-scoped endpoint)", async () => {
    const args = { cmd: "npm test" };
    for (let i = 0; i < 3; i++) sendInvocation(engine, "task-n1", "sess-n1", "bash", args, { ok: true, result: "ok" });
    await waitFor(() => messagesFor("task-n1").length >= 1);

    // Intervention POSTed to the TASK id, not the session id.
    expect(messagesFor("task-n1").length).toBe(1);
    expect(messagesFor("sess-n1").length).toBe(0);
    expect(nudgeText(messagesFor("task-n1")[0]!)).toContain("repeated bash");
  });

  test("native identical failed results ×6 fire error-spam", async () => {
    for (let i = 0; i < 6; i++) {
      // Distinct args so repeat-hash does not fire first; identical error output.
      sendInvocation(engine, "task-n2", "sess-n2", "grep", { attempt: i }, { ok: false, error: "boom: permission denied" });
    }
    await waitFor(() => messagesFor("task-n2").length >= 1);
    expect(nudgeText(messagesFor("task-n2")[0]!)).toContain("repeated grep");
  });

  test("B42 parity: identical SUCCESSFUL results ×6 do NOT fire an intervention", async () => {
    for (let i = 0; i < 6; i++) {
      sendInvocation(engine, "task-n3", "sess-n3", "grep", { attempt: i }, { ok: true, result: "match: ok" });
    }
    await sleep(700);
    expect(messagesFor("task-n3").length).toBe(0);
    expect(engine.aborts.includes("task-n3")).toBe(false);
  });

  test("native trace kind:error feeds the error monitor", async () => {
    for (let i = 0; i < 6; i++) {
      engine.send(traceFrame("task-n4", "sess-n4", { kind: "error", label: "llm failed", output: { message: "upstream 500" } }));
    }
    await waitFor(() => messagesFor("task-n4").length >= 1 || engine.aborts.includes("task-n4"));
    expect(messagesFor("task-n4").length >= 1 || engine.aborts.includes("task-n4")).toBe(true);
  });

  test("native approval.decision rejected fires a deny nudge", async () => {
    engine.send(traceFrame("task-n5", "sess-n5", { kind: "approval.request", label: "approval", input: { toolName: "bash" } }));
    engine.send(traceFrame("task-n5", "sess-n5", { kind: "approval.decision", label: "approval", output: { status: "rejected" } }));
    await waitFor(() => messagesFor("task-n5").length >= 1);
    expect(messagesFor("task-n5").length).toBeGreaterThanOrEqual(1);
  });

  test("malformed native frames are ignored without killing the stream", async () => {
    const before = engine.messages.length;
    engine.send({ id: "not-a-number", type: "trace" }); // missing sessionId/payload
    engine.send(frame("task-x", "sess-x", "trace", { event: { kind: "unknown.kind" } }));
    await sleep(80);
    expect(engine.messages.length).toBe(before);
    // Stream still alive: a subsequent valid repeated loop still fires.
    for (let i = 0; i < 3; i++) sendInvocation(engine, "task-n6", "sess-n6", "bash", { cmd: "alive" }, { ok: true, result: "ok" });
    await waitFor(() => messagesFor("task-n6").length >= 1);
  });

  test("argsHash is stable across key order for native inputs", () => {
    expect(argsHash("bash", { a: 1, b: 2 })).toBe(argsHash("bash", { b: 2, a: 1 }));
    expect(argsHash("bash", { a: 1 })).not.toBe(argsHash("bash", { a: 2 }));
  });

  // LAST: creating a second watchdog stops the shared `active` handle (the main wd),
  // so nothing after this may rely on the main watchdog.
  test("directory scoping applies to native frames (filtered watchdog drops foreign dir)", async () => {
    const eng2 = mkEngine();
    const wd2 = startWatchdog({
      engineUrl: eng2.url,
      directory: "/proj",
      telemetry: fakeTelemetry,
      limits: { nudgeCooldownMs: 250, maxInterventionsPerTask: 3 },
      budgetIntervalMs: 3_600_000,
    });
    try {
      await waitFor(() => wd2.status().attached && eng2.hits.globalEvent >= 1);
      await sleep(50);
      for (let i = 0; i < 3; i++) sendInvocation(eng2, "task-other", "sess-other", "bash", { cmd: "x" }, { ok: true, result: "ok" }, "/elsewhere");
      await sleep(250);
      expect(eng2.messages.length).toBe(0);
      for (let i = 0; i < 3; i++) sendInvocation(eng2, "task-match", "sess-match", "bash", { cmd: "x" }, { ok: true, result: "ok" }, "/proj");
      await waitFor(() => eng2.messages.filter((m) => m.taskId === "task-match").length >= 1);
    } finally {
      wd2.stop();
      eng2.server.stop(true);
    }
  });
});
