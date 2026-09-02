// A reply cut off at max_tokens is half an answer, and nothing checked for it:
// the engine never read finish_reason. The partial text still parses as a
// write_file call, so a half-written file reached disk — and every downstream
// check then reported success (the reviewer reads a clean-looking diff, the
// auditor sees a file that exists and parses as far as it goes).
import "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";
import { restoreFetch } from "./_env.js";
import { chat } from "../src/providers.js";

afterEach(restoreFetch);

const reply = (finish: string, content: string) =>
  new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }), { status: 200, headers: { "content-type": "application/json" } });

describe("truncation detection", () => {
  test("finish_reason 'length' marks the result truncated", async () => {
    globalThis.fetch = (async () => reply("length", "def train(")) as typeof fetch;
    const r = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "x" }] });
    expect(r.truncated).toBe(true);
  });

  test("a normal stop is NOT truncated", async () => {
    globalThis.fetch = (async () => reply("stop", "def train(): pass")) as typeof fetch;
    const r = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "x" }] });
    expect(r.truncated).toBeUndefined();
  });

  test("a tool_calls finish is not truncation either", async () => {
    globalThis.fetch = (async () => reply("tool_calls", "")) as typeof fetch;
    const r = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "x" }] });
    expect(r.truncated).toBeUndefined();
  });

  test("STREAMING: a truncated stream is flagged too", async () => {
    // The streaming path reconstructs its own response object, so it needs its
    // own finish_reason capture — the coder streams, so this is the path that
    // actually mattered for the half-written files.
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "def train(" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = (async () =>
      new Response(new ReadableStream({
        start(c) { const e = new TextEncoder(); for (const ch of chunks) c.enqueue(e.encode(ch)); c.close(); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const r = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "x" }], onDelta: () => {} });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("def train(");
  });

  test("streaming that completes normally is not flagged", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = (async () =>
      new Response(new ReadableStream({
        start(c) { const e = new TextEncoder(); for (const ch of chunks) c.enqueue(e.encode(ch)); c.close(); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const r = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "x" }], onDelta: () => {} });
    expect(r.truncated).toBeUndefined();
  });
});
