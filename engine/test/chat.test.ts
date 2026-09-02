// chat.ts edge-case regressions (fresh-eyes audit):
//   EC1 — empty/missing text must not crash runChat nor blank the session title
//   EC2 — history replay only includes user/assistant roles (lock)
//   EC3 — non-string text (number/object) must not crash or leak "[object Object]"
//   EC4 — title/history clipping stays bounded (lock)
//   EC5 — null/undefined inputs must not throw TypeError mid-turn
// Hermetic: providers.chatRace + router.decideRoute are injected via chat.ts's
// _setChatDeps seam, so no network/router/LLM is touched; everything else runs
// for real against the _env temp DATA_DIR.
import "./_env.js";
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, Session } from "../src/types.js";

let raceCalls: { messages: { role: string; content: string }[] }[] = [];
let raceText = "hello from model";

// Hermetic via chat.ts's injection seam (_setChatDeps), NOT mock.module:
// Bun preloads every test file's module graph before running any test, so
// mock.module patches the registry process-wide and leaks into other files
// (it previously broke stream.test.ts's real-chatRace assertions). The seam
// is scoped to this file and torn down in afterAll.
const { runChat, _setChatDeps } = await import("../src/chat.js");

_setChatDeps({
  chatRace: (async (p: { messages: { role: string; content: string }[] }) => {
    raceCalls.push(p);
    return { text: raceText, modelId: "engine/small", latencyMs: 3, tokensIn: 5, tokensOut: 7 };
  }) as never,
  decideRoute: (async () => ({
    modelId: "engine/small", provider: "mock", reason: "mock", signals: [],
    complexity: 0, fallbacks: [], at: Date.now(),
  })) as never,
  recordOutcome: (() => {}) as never,
});

afterAll(() => _setChatDeps());



const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-root-"));

function makeSession(title = "New session"): Session {
  return {
    id: crypto.randomUUID(), projectId: "chat-test-proj", title,
    messages: [], contextRefs: [], compactions: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function msg(role: ChatMessage["role"], content: unknown): ChatMessage {
  return { id: crypto.randomUUID(), role, content: content as string, at: Date.now() };
}
const lastPrompt = (): string => raceCalls[raceCalls.length - 1]!.messages[1]!.content;

beforeEach(() => {
  raceCalls = [];
  raceText = "hello from model";
});

describe("EC1/EC5: empty or missing text never crashes, never blanks title", () => {
  test("undefined text → valid empty message instead of TypeError", async () => {
    const s = makeSession();
    const { reply } = await runChat(s, ROOT, undefined as unknown as string);
    expect(s.messages[0]!.role).toBe("user");
    expect(s.messages[0]!.content).toBe("");
    expect(reply.content).toBe("hello from model");
  });

  test("null text → valid empty message instead of TypeError", async () => {
    const s = makeSession();
    await runChat(s, ROOT, null as unknown as string);
    expect(s.messages[0]!.content).toBe("");
  });

  test("empty text does not blank the session title", async () => {
    const s = makeSession();
    await runChat(s, ROOT, "");
    expect(s.title).toBe("New session");
  });

  test("whitespace-only text does not blank the session title", async () => {
    const s = makeSession();
    await runChat(s, ROOT, "   ");
    expect(s.title).toBe("New session");
  });
});

describe("EC2: history replay is role-filtered (lock)", () => {
  test("only user/assistant messages are replayed into the prompt", async () => {
    const s = makeSession("titled");
    s.messages.push(msg("tool", "TOOLSECRET"));
    s.messages.push(msg("user", "hello-usr"));
    s.messages.push(msg("assistant", "hello-asst"));
    await runChat(s, ROOT, "q");
    const prompt = lastPrompt();
    expect(prompt).toContain("user: hello-usr");
    expect(prompt).toContain("assistant: hello-asst");
    expect(prompt).not.toContain("TOOLSECRET");
  });
});

describe("EC3: non-string text is coerced, never leaks [object Object]", () => {
  test("number text is stringified, not a crash", async () => {
    const s = makeSession();
    await runChat(s, ROOT, 123 as unknown as string);
    expect(s.messages[0]!.content).toBe("123");
    expect(s.title).toBe("123");
  });

  test("object text becomes JSON, not '[object Object]'", async () => {
    const s = makeSession("titled");
    await runChat(s, ROOT, { a: 1 } as unknown as string);
    expect(s.messages[0]!.content).toBe('{"a":1}');
    expect(lastPrompt()).toContain('{"a":1}');
    expect(lastPrompt()).not.toContain("[object Object]");
  });

  test("non-string content in persisted history cannot crash the turn", async () => {
    const s = makeSession("titled");
    s.messages.push(msg("user", 42));
    const { reply } = await runChat(s, ROOT, "q");
    expect(reply.content).toBe("hello from model");
    expect(lastPrompt()).toContain("user: 42");
  });
});

describe("EC4: bounded growth (lock)", () => {
  test("title is clipped to 60 chars", async () => {
    const s = makeSession();
    await runChat(s, ROOT, "x".repeat(5000));
    expect(s.title).toBe("x".repeat(60));
  });

  test("history messages are clipped to 400 chars + ellipsis", async () => {
    const s = makeSession("titled");
    s.messages.push(msg("user", "y".repeat(1000)));
    await runChat(s, ROOT, "q");
    expect(lastPrompt()).toContain("y".repeat(400) + "…");
    expect(lastPrompt()).not.toContain("y".repeat(401));
  });

  test("empty LLM reply falls back to '(empty reply)'", async () => {
    raceText = "   ";
    const s = makeSession("titled");
    const { reply } = await runChat(s, ROOT, "q");
    expect(reply.content).toBe("(empty reply)");
  });
});
