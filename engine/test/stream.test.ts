// Streaming support (wave 25 — forge-parity "fluid chat"):
//   chat() with onDelta sends stream:true, parses upstream SSE, forwards
//   content/reasoning deltas, and returns the SAME aggregated ChatResult.
//   chatRace() elects the first slot that emits a real delta as leader,
//   forwards only the leader's deltas, and aborts the other slots early
//   (token-level race = less wasted spend than completion-level race).
// All fetch is stubbed — no network touched.
import "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";
import { chat, chatRace, parseChatSse } from "../src/providers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Build a Response whose body is an SSE stream from a list of raw lines.
 *  Each non-empty line becomes one `data:` event; events are separated by a
 *  blank line per the SSE spec. */
function sseResponse(lines: string[], status = 200): Response {
  const body = lines
    .map((l) => (l === "" ? "" : `data: ${l}\n\n`))
    .join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const chunk = (content?: string, reasoning?: string, usage?: unknown): string =>
  JSON.stringify({
    choices: [{ delta: { ...(content !== undefined ? { content } : {}), ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) } }],
    ...(usage ? { usage } : {}),
  });

describe("parseChatSse (pure SSE line parser)", () => {
  test("splits data lines, ignores comments and [DONE]", () => {
    const events: unknown[] = [];
    const rest = parseChatSse(': keepalive\ndata: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2', (j) => events.push(j));
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b":2'); // incomplete tail is carried over
  });

  test("handles CRLF and multi-line network chunks", () => {
    const events: unknown[] = [];
    let rest = parseChatSse('data: {"a":1}\r\n\r\ndata: {"b"', (j) => events.push(j));
    expect(events).toEqual([{ a: 1 }]);
    rest = parseChatSse(rest + ':2}\r\n\r\n', (j) => events.push(j));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe("");
  });
});

describe("chat() streaming via onDelta", () => {
  test("sends stream:true, forwards content deltas, aggregates text + usage", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return sseResponse([
        chunk("Hel"),
        chunk("lo "),
        chunk("world", undefined, { prompt_tokens: 7, completion_tokens: 3 }),
        "[DONE]",
      ]);
    }) as typeof fetch;

    const deltas: { text?: string; reasoning?: string }[] = [];
    const res = await chat({
      modelId: "engine/small",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (d) => deltas.push(d),
    });

    expect(capturedBody.stream).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe("Hello world");
    expect(res.text).toBe("Hello world");
    expect(res.tokensIn).toBe(7);
    expect(res.tokensOut).toBe(3);
    expect(res.estimated).toBeUndefined();
  });

  test("reasoning_content deltas route to reasoning, not text", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        chunk(undefined, "thinking "),
        chunk(undefined, "step "),
        chunk("answer"),
        "[DONE]",
      ])) as typeof fetch;

    const deltas: { text?: string; reasoning?: string }[] = [];
    const res = await chat({
      modelId: "engine/small",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join("")).toBe("thinking step ");
    expect(res.text).toBe("answer");
    expect(res.reasoningContent).toBe("thinking step ");
  });

  test("usage-less stream estimates tokens and marks estimated", async () => {
    globalThis.fetch = (async () => sseResponse([chunk("some text here"), "[DONE]"])) as typeof fetch;
    const res = await chat({
      modelId: "engine/small",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    expect(res.text).toBe("some text here");
    expect(res.estimated).toBe(true);
    expect(res.tokensOut).toBeGreaterThan(0);
  });

  test("empty stream is the same empty-completion outcome as non-streaming", async () => {
    globalThis.fetch = (async () => sseResponse(["[DONE]"])) as typeof fetch;
    const res = await chat({
      modelId: "engine/small",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    expect(res.text).toBe("");
  });

  test("non-2xx stream start throws retryable LlmError like the sync path", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    let err: unknown;
    try {
      await chat({ modelId: "engine/small", messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { retryable?: boolean }).retryable).toBe(true);
  });

  test("caller abort mid-stream stops parsing and throws abort error", async () => {
    const ctl = new AbortController();
    globalThis.fetch = (async () =>
      sseResponse([chunk("a"), chunk("b"), chunk("c"), "[DONE]"])) as typeof fetch;
    const seen: string[] = [];
    let err: unknown;
    try {
      await chat({
        modelId: "engine/small",
        messages: [{ role: "user", content: "hi" }],
        signal: ctl.signal,
        onDelta: (d) => {
          if (d.text) seen.push(d.text);
          if (seen.length === 1) ctl.abort();
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(seen.length).toBeLessThanOrEqual(2);
  });
});

describe("chatRace() streaming leader election", () => {
  test("first slot to emit a delta becomes leader; only its deltas forwarded", async () => {
    // Slot A (slow to first token), Slot B (fast first token, wins).
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (body.model === "model-a") {
        // A emits its first delta only after B has already won.
        await new Promise((r) => setTimeout(r, 120));
        return sseResponse([chunk("AAA"), "[DONE]"]);
      }
      return sseResponse([chunk("B"), chunk("BB"), "[DONE]"]);
    }) as typeof fetch;

    const deltas: string[] = [];
    const res = await chatRace({
      modelId: "",
      candidates: ["model-a", "model-b"],
      messages: [{ role: "user", content: "hi" }],
      staggerMs: 0,
      onDelta: (d) => {
        if (d.text) deltas.push(d.text);
      },
    });

    expect(res.modelId).toBe("model-b");
    expect(res.text).toBe("BBB");
    expect(deltas.join("")).toBe("BBB"); // no A tokens leaked through
  });

  test("race without any streaming still works (completion-level win)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await chatRace({
      modelId: "",
      candidates: ["model-x"],
      messages: [{ role: "user", content: "hi" }],
      staggerMs: 0,
      onDelta: () => {},
    });
    expect(res.text).toBe("done");
    expect(res.modelId).toBe("model-x");
  });
});
