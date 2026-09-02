import "./_env.js";
import { describe, test, expect } from "bun:test";
import { readWithDeadline, LlmError, STREAM_TTFB_MS, STREAM_STALL_MS } from "../src/providers.js";

// A provider that ACCEPTS the request, opens an SSE stream, then delivers
// nothing is already dead. Waiting out CHAT_TIMEOUT_MS (180s) to find that out
// was measured burning 180s of a 600s step budget on a free tier — and the
// retry that followed succeeded in 42s. Wall-clock time is scored directly
// (T in S = 10·A/(1 + w_C·C/C_base + w_T·T/T_base)^2.5), so a silent stream has
// to be abandoned on its own liveness budget rather than the whole-call cap.

/** A stream that opens and then says nothing, ever. */
const silent = () => new ReadableStream<Uint8Array>({ start() { /* no enqueue, no close */ } }).getReader();

/** A stream that delivers one chunk immediately. */
const speaking = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); },
  }).getReader();

describe("SSE stream liveness budget", () => {
  test("a silent stream is abandoned on its budget, not the 180s call cap", async () => {
    const started = Date.now();
    let err: unknown;
    await readWithDeadline(silent(), 300, "first byte", "stall-test").catch((e) => { err = e; });
    const elapsed = Date.now() - started;

    expect(err instanceof LlmError).toBe(true);
    // Retryable is the load-bearing part: it is what makes the router fall
    // through to the next provider instead of failing the whole step.
    expect((err as LlmError).retryable).toBe(true);
    expect((err as LlmError).status).toBe(504);
    expect((err as LlmError).message).toContain("stalled");
    expect((err as LlmError).message).toContain("first byte");
    expect(elapsed).toBeLessThan(3_000);
  });

  test("the message names the model so the trace says which provider went quiet", async () => {
    const err = await readWithDeadline(silent(), 100, "next chunk", "groq/some-model").catch((e) => e);
    expect((err as LlmError).message).toContain("groq/some-model");
    expect((err as LlmError).message).toContain("next chunk");
  });

  test("a stream that IS delivering is passed straight through", async () => {
    const r = await readWithDeadline(speaking("data: hi\n\n"), 5_000, "first byte", "ok-model");
    expect(r.done).toBe(false);
    expect(new TextDecoder().decode(r.value)).toBe("data: hi\n\n");
  });

  test("a closed stream reports done rather than stalling", async () => {
    const reader = new ReadableStream<Uint8Array>({ start(c) { c.close(); } }).getReader();
    expect((await readWithDeadline(reader, 5_000, "first byte", "m")).done).toBe(true);
  });

  test("budgets are positive and well under the whole-call cap", () => {
    for (const ms of [STREAM_TTFB_MS, STREAM_STALL_MS]) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(180_000);
    }
  });
});
