// context.ts regression tests (fresh-eyes edge-case audit).
// Covers: token budgeting (cap/NaN/negative), huge single blob truncation,
// empty inputs, truncation/slice off-by-ones, and "undefined"/"null" literal
// injection into rendered prompts. maybeCompact tests stub globalThis.fetch
// (restored after each test, same pattern as providers.test.ts) so no network
// is touched and no server is started.
import "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estTokens,
  messagesTokens,
  renderContextBlock,
  resolveRefContent,
  resolvePinnedRefs,
  buildSystemPrompt,
  maybeCompact,
} from "../src/context.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import type { ChatMessage, ContextRef, Session } from "../src/types.js";

const CAP = 24_000; // CONTEXT_BLOCK_CAP_TOKENS (mirrors src/context.ts)
const ZONE_CAP = 90_000; // ZONE_TRANSCRIPT_CAP_TOKENS (mirrors src/context.ts)

// ── helpers ─────────────────────────────────────────────────────────────────

let mid = 0;
function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: `m${++mid}`, role, content, at: Date.now(), ...extra };
}

function mkSession(messages: ChatMessage[]): Session {
  return {
    id: `s-${++mid}`,
    projectId: "ctx-test-project",
    title: "ctx test",
    messages,
    contextRefs: [],
    compactions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function ref(r: Partial<ContextRef> & { kind: ContextRef["kind"]; path: string }): ContextRef {
  return { source: "user", ...r };
}

const realFetch = globalThis.fetch;
let captured: { url: string; body: Record<string, unknown> }[] = [];

function stubFetch(summaryText: string): void {
  captured = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    captured.push({ url, body });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: summaryText } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── 1. token estimation & budget sanity ─────────────────────────────────────

describe("token estimation", () => {
  test("estTokens: empty is 0, ceil(chars/4), never NaN/negative", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
    expect(Number.isFinite(estTokens("x".repeat(1_000_001)))).toBe(true);
  });

  test("messagesTokens: empty conversation is 0; refs rendering is counted", () => {
    expect(messagesTokens([])).toBe(0);
    const withRef = msg("user", "", { refs: [ref({ kind: "snippet", path: "s.ts", content: "code();" })] });
    expect(messagesTokens([withRef])).toBeGreaterThan(4); // overhead + rendered block
  });
});

// ── 2. renderContextBlock: caps, huge blobs, empty inputs ───────────────────

describe("renderContextBlock", () => {
  test("empty/missing refs produce an empty string (no crash)", () => {
    expect(renderContextBlock([])).toBe("");
  });

  test("file ref line range: startLine/endLine slice is exact (no off-by-one)", () => {
    const out = renderContextBlock([
      ref({ kind: "lines", path: "f.ts", startLine: 5, endLine: 6, content: "a\nb\nc" }),
    ]);
    expect(out).toContain("lines 5-6 (2 lines)");
    expect(out).toContain("5 | a");
    expect(out).toContain("6 | b");
    expect(out).not.toContain("| c"); // endLine clamps: line 7 ("c") must not render
  });

  test("adjacent ranges of one file merge; shared lines render exactly once", () => {
    const out = renderContextBlock([
      ref({ kind: "lines", path: "f.ts", startLine: 1, endLine: 2, content: "a\nb" }),
      ref({ kind: "lines", path: "f.ts", startLine: 3, endLine: 4, content: "c\nd" }),
    ]);
    expect(out).toContain("lines 1-4 (4 lines)");
    expect((out.match(/\| a/g) ?? []).length).toBe(1);
    expect((out.match(/\| d/g) ?? []).length).toBe(1);
  });

  test("one huge file ref is truncated near the 24k cap with a marker", () => {
    const big = "line\n".repeat(50_000); // 250k chars ≈ 62.5k est. tokens
    const out = renderContextBlock([ref({ kind: "file", path: "big.ts", content: big })]);
    expect(out).toContain("[truncated]");
    expect(estTokens(out)).toBeLessThanOrEqual(CAP + 32); // marker slack beyond the budget
    expect(estTokens(out)).toBeGreaterThan(15_000); // not over-trimmed
  });

  test("one huge snippet is truncated near the 24k cap", () => {
    const big = "x".repeat(400_000); // 100k est. tokens, single line
    const out = renderContextBlock([ref({ kind: "snippet", path: "big.ts", content: big })]);
    expect(out).toContain("[truncated]");
    expect(estTokens(out)).toBeLessThanOrEqual(CAP + 32);
  });

  test("several huge refs together stay under the total cap", () => {
    const refs = [1, 2, 3].map((i) =>
      ref({ kind: "file", path: `f${i}.ts`, content: "line\n".repeat(30_000) }),
    );
    const out = renderContextBlock(refs);
    expect(estTokens(out)).toBeLessThanOrEqual(CAP + 128);
    for (const i of [1, 2, 3]) expect(out).toContain(`f${i}.ts`); // no ref disappears outright
  });
});

// ── 3. server-side ref resolution ────────────────────────────────────────────

describe("resolveRefContent / resolvePinnedRefs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-resolve-"));
  fs.writeFileSync(path.join(root, "sub.txt"), "L1\nL2\nL3\nL4\nL5");

  test("honors line range and rewrites startLine/endLine", () => {
    const out = resolveRefContent(root, ref({ kind: "file", path: "sub.txt", startLine: 2, endLine: 4 }), 10_000);
    expect(out.content).toBe("L2\nL3\nL4");
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(4);
  });

  test("char budget slices content and adjusts endLine", () => {
    const out = resolveRefContent(root, ref({ kind: "file", path: "sub.txt", startLine: 2 }), 5);
    expect(out.content).toBe("L2\nL3");
    expect(out.endLine).toBe(3);
  });

  test("startLine beyond EOF leaves the ref untouched (no crash)", () => {
    const r = ref({ kind: "file", path: "sub.txt", startLine: 99 });
    const out = resolveRefContent(root, r, 10_000);
    expect(out.content).toBeUndefined();
  });

  test("path traversal outside root is refused", () => {
    const out = resolveRefContent(root, ref({ kind: "file", path: "../outside.txt" }), 10_000);
    expect(out.content).toBeUndefined();
  });

  test("files above the 2MB read limit are skipped", () => {
    fs.writeFileSync(path.join(root, "huge.bin"), "x".repeat(2_000_001));
    const out = resolveRefContent(root, ref({ kind: "file", path: "huge.bin" }), 10_000);
    expect(out.content).toBeUndefined();
  });

  test("shared char budget across pinned refs is enforced", () => {
    fs.writeFileSync(path.join(root, "a.txt"), "a".repeat(20_000));
    fs.writeFileSync(path.join(root, "b.txt"), "b".repeat(20_000));
    const resolved = resolvePinnedRefs(root, [
      ref({ kind: "file", path: "a.txt" }),
      ref({ kind: "file", path: "b.txt" }),
    ]);
    const a = resolved[0]!;
    const b = resolved[1]!;
    expect(a.content?.length).toBe(20_000);
    expect(b.content?.length).toBe(4_000); // 24k shared cap − 20k spent on a.txt
    expect((a.content?.length ?? 0) + (b.content?.length ?? 0)).toBeLessThanOrEqual(24_000);
  });
});

// ── 4. system prompt composition ─────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  test("null rules / empty role still produce a valid prompt, no 'undefined'/'null'", () => {
    const out = buildSystemPrompt({ agentsMdRules: null, rolePrompt: "You are X." });
    expect(out).toContain("<role>");
    expect(out).toContain("You are X.");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("null");
    expect(out).not.toContain("agents_md_rules");
  });

  test("whitespace-only rules and missing extra are skipped", () => {
    const out = buildSystemPrompt({ agentsMdRules: "   \n  ", rolePrompt: "R" });
    expect(out).not.toContain("agents_md_rules");
    expect(out).not.toContain("<extra>");
  });

  test("runtime-undefined rolePrompt/extra cannot leak literal 'undefined'", () => {
    const out = buildSystemPrompt({ agentsMdRules: null, rolePrompt: undefined as unknown as string, extra: undefined });
    expect(out).not.toContain("undefined");
    expect(out).toContain("<role>");
  });
});

// ── 5. maybeCompact ──────────────────────────────────────────────────────────

describe("maybeCompact", () => {
  test("empty session: no trigger, no crash, no LLM call", async () => {
    stubFetch("## Goal\n- none");
    const session = mkSession([]);
    const res = await maybeCompact({ session, settings: { ...DEFAULT_SETTINGS }, modelCtxWindow: 128_000 });
    expect(res.compacted).toBe(false);
    expect(res.beforeTokens).toBe(0);
    expect(captured.length).toBe(0);
  });

  test("non-finite compactThreshold is clamped, never NaN", async () => {
    stubFetch("## Goal\n- none");
    const session = mkSession([msg("user", "hello")]);
    const settings = { ...DEFAULT_SETTINGS, compactThreshold: Number.NaN };
    const res = await maybeCompact({ session, settings, modelCtxWindow: 0 });
    expect(res.compacted).toBe(false);
    expect(Number.isFinite(res.beforeTokens)).toBe(true);
  });

  test("bloat confined to the kept tail: aborts without an LLM call", async () => {
    stubFetch("## Goal\n- none");
    // 6 messages (all kept tail) each ~30k tokens → over any hard threshold,
    // but the zone is empty → nothing to summarize.
    const session = mkSession(
      Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(120_000))),
    );
    const res = await maybeCompact({ session, settings: { ...DEFAULT_SETTINGS }, modelCtxWindow: 128_000 });
    expect(res.compacted).toBe(false);
    expect(captured.length).toBe(0);
    expect(session.messages.length).toBe(6); // untouched
  });

  test("huge zone: summarizer transcript is actually bounded by the zone cap", async () => {
    stubFetch("## Goal\n- compacted");
    // 10 zone messages × 60k est. tokens (10 is a multiple of 10 — the case
    // where head(70%)+tail(30%) floors drop ZERO middle messages) + 6 tail.
    const zone = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 ? "assistant" : "user", "x".repeat(240_000)),
    );
    const tail = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", `tail ${i}`));
    const session = mkSession([...zone, ...tail]);

    const res = await maybeCompact({ session, settings: { ...DEFAULT_SETTINGS }, modelCtxWindow: 128_000 });

    expect(res.compacted).toBe(true);
    expect(captured.length).toBe(1); // first attempt succeeded — no retry
    const body = captured[0]!.body;
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0]!.content).toContain("context-compaction module");
    const transcript = msgs[1]!.content;
    expect(transcript).not.toContain("undefined");
    // The whole point: the transcript must fit the summarizer's window.
    expect(estTokens(transcript)).toBeLessThanOrEqual(ZONE_CAP + 16);
    expect(estTokens(transcript)).toBeGreaterThan(50_000); // not gutted to nothing
    expect(transcript).toContain("truncated to fit summarizer window");

    // Session shape after compaction: summary + verbatim tail.
    expect(session.messages.length).toBe(7);
    expect(session.messages[0]!.meta?.compaction).toBe(true);
    expect(session.messages[0]!.content).toContain("[COMPACTED CONTEXT");
    expect(session.messages.at(-1)?.content).toBe("tail 5");
    expect(session.compactions.length).toBe(1);
  });
});
