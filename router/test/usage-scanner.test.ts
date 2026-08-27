/**
 * Wave 25 P5: incremental stream-usage scanner. Pins the behavior the old
 * end-of-stream full-body scan provided (last data line with usage wins),
 * without the whole-stream accumulation.
 */
import { describe, test, expect } from "bun:test";
import { createUsageScanner } from "../src/proxy";

const usageChunk = (prompt: number, completion: number) =>
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${prompt},"completion_tokens":${completion},"total_tokens":${prompt + completion}}}\n\n`;

describe("createUsageScanner (P5)", () => {
  test("finds usage in the final chunk", () => {
    const s = createUsageScanner();
    s.feed('data: {"choices":[{"delta":{"content":"He"}}]}\n\n');
    s.feed('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    s.feed(usageChunk(5, 2));
    s.feed("data: [DONE]\n\n");
    expect(s.finish()).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
  });

  test("last usage line wins when several carry usage", () => {
    const s = createUsageScanner();
    s.feed(usageChunk(1, 1));
    s.feed(usageChunk(9, 4));
    expect(s.finish()).toEqual({ prompt_tokens: 9, completion_tokens: 4 });
  });

  test("handles chunks split mid-line across feed() calls", () => {
    const s = createUsageScanner();
    const full = usageChunk(7, 3);
    s.feed(full.slice(0, 10));
    s.feed(full.slice(10));
    expect(s.finish()).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
  });

  test("no usage anywhere → null", () => {
    const s = createUsageScanner();
    s.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    s.feed("data: [DONE]\n\n");
    expect(s.finish()).toBeNull();
  });

  test("delta chunks without usage are never JSON-parsed (pre-filter)", () => {
    const s = createUsageScanner();
    // Malformed JSON that DOES NOT mention usage must be skipped by the
    // pre-filter — if it were parsed it would be ignored anyway, but a
    // malformed chunk WITH "usage" text must not crash the scanner.
    s.feed('data: {"broken json no quote\n\n');
    s.feed('data: {"usage": broken}\n\n');
    expect(s.finish()).toBeNull();
  });
});
