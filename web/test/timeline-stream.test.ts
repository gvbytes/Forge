// Wave 25 (fluid chat + reasoning): deriveTimeline streaming behavior.
//
// Locks in the contract between the engine's LIVE_ONLY `token` frames and the
// render timeline:
//   1. open streams render as in-flight thought bubbles (streaming:true)
//   2. reasoning deltas (kind:"thought") land in ThoughtItem.thinking
//   3. an llm.call trace with input.streamed seals the accumulator and renders
//      the FULL live text (not the 600-char clipped trace output)
//   4. a final `message` frame reusing the stream id also seals it (chat mode)
//   5. after reload (no token frames) llm.call degrades to its clipped output
import { describe, expect, test, beforeEach } from "bun:test";
import { deriveTimeline, type ThoughtItem } from "../src/stores/chat";
import type { EventDto } from "../src/lib/types";

let n = 0;
const ev = (type: string, payload: any): EventDto => ({
  id: ++n, taskId: "t1", ts: 1000 + n, type, payload,
});

const tok = (messageId: string, delta: string, kind?: "text" | "thought") =>
  ev("token", { messageId, delta, ...(kind ? { kind } : {}) });

beforeEach(() => { n = 0; });

describe("deriveTimeline streaming (wave 25)", () => {
  test("open stream renders as a streaming thought bubble", () => {
    const items = deriveTimeline([tok("s1", "Hel"), tok("s1", "lo")], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1);
    expect(th[0].text).toBe("Hello");
    expect(th[0].streaming).toBe(true);
  });

  test("reasoning deltas accumulate into thinking, not text", () => {
    const items = deriveTimeline([
      tok("s1", "let me think…", "thought"),
      tok("s1", "The answer is 4."),
    ], []);
    const th = items.find((i): i is ThoughtItem => i.kind === "thought")!;
    expect(th.thinking).toBe("let me think…");
    expect(th.text).toBe("The answer is 4.");
    expect(th.streaming).toBe(true);
  });

  test("llm.call with input.streamed=true seals by parentId and shows full text", () => {
    const items = deriveTimeline([
      tok("span-1", "FULL streamed "), tok("span-1", "coder output"),
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", input: { streamed: true }, output: "clipped…", tokensIn: 5, tokensOut: 7 } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1); // sealed — no leftover streaming bubble
    expect(th[0].text).toContain("FULL streamed coder output");
    expect(th[0].text).not.toContain("clipped");
    expect(th[0].streaming).toBeUndefined();
  });

  test("chat mode: llm.call(streamed=replyId) + message(id=replyId) → ONE bubble (no duplicate)", () => {
    // The engine emits BOTH an llm.call carrying input.streamed=replyId and a
    // final message frame reusing id=replyId. The llm.call bubble is suppressed
    // in chat mode so the message frame (canonical, reload-persistent) renders.
    const items = deriveTimeline([
      tok("reply-9", "chat says hi"),
      ev("trace", { event: { kind: "llm.call", model: "m", input: { streamed: "reply-9" }, output: "clip" } }),
      ev("message", { message: { id: "reply-9", role: "assistant", content: "chat says hi", meta: { reasoning: "chain" } } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1); // no duplicate bubble
    expect(th[0].text).toBe("chat says hi");
    expect(th[0].thinking).toBe("chain");
    expect(th[0].streaming).toBeUndefined();
  });

  test("final message frame seals the chat stream (no duplicate bubble)", () => {
    const items = deriveTimeline([
      tok("reply-9", "streamed text"),
      ev("message", { message: { id: "reply-9", role: "assistant", content: "streamed text", meta: { reasoning: "chain" } } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1); // message sealed the stream → single bubble
    expect(th[0].text).toBe("streamed text");
    expect(th[0].thinking).toBe("chain"); // reasoning survives via meta
    expect(th[0].streaming).toBeUndefined();
  });

  test("after reload (no token frames) llm.call falls back to clipped output", () => {
    const items = deriveTimeline([
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", input: { streamed: true }, output: "clipped output" } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1);
    expect(th[0].text).toContain("clipped output");
  });

  test("empty stream (no text, no thought) renders nothing", () => {
    const items = deriveTimeline([
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", input: { streamed: true }, output: "   " } }),
    ], []);
    expect(items.filter((i) => i.kind === "thought")).toHaveLength(0);
  });

  test("unsealed stream after a terminal frame renders static, not streaming (no forever-blink)", () => {
    // A call that errors before its llm.call leaves the accumulator open; the
    // task.end/error frame marks it dead so the cursor stops blinking.
    const items = deriveTimeline([
      tok("s1", "partial text"),
      ev("trace", { event: { kind: "task.end", output: { summary: "done" } } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1);
    expect(th[0].text).toBe("partial text");
    expect(th[0].streaming).toBeUndefined();
  });

  test("a still-live open stream (no terminal frame) keeps streaming:true", () => {
    const items = deriveTimeline([tok("s1", "still going")], []);
    const th = items.find((i): i is ThoughtItem => i.kind === "thought")!;
    expect(th.streaming).toBe(true);
  });

  test("llm.retry drops the failed attempt's partial deltas (no contamination)", () => {
    const items = deriveTimeline([
      tok("span-1", "garbage from dead attempt "),
      ev("trace", { event: { kind: "llm.retry", parentId: "span-1", label: "model failed → retry" } }),
      tok("span-1", "clean retry output"),
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", input: { streamed: true }, output: "clip" } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(1);
    expect(th[0].text).toContain("clean retry output");
    expect(th[0].text).not.toContain("garbage");
  });

  test("non-streamed llm.call discards a stale accumulator on the span", () => {
    const items = deriveTimeline([
      tok("span-1", "stale partial "),
      // non-streamed call (engine retry path dropped the stream hook/flag)
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", output: "non-streamed output" } }),
      tok("span-1", "fresh call text"),
      ev("trace", { event: { kind: "llm.call", parentId: "span-1", model: "m", input: { streamed: true }, output: "clip" } }),
    ], []);
    const th = items.filter((i): i is ThoughtItem => i.kind === "thought");
    expect(th).toHaveLength(2);
    expect(th[0].text).toContain("non-streamed output");
    expect(th[1].text).toContain("fresh call text");
    expect(th[1].text).not.toContain("stale partial");
  });
});
