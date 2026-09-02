// Regression suite for compaction.ts — tiered context compaction.
// Fresh-eyes edge-case audit: trigger threshold, pinned/system preservation,
// tiny-history no-op, NaN/negative token math, role alternation of outputs.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { Compactor, getEffectiveContextWindow } from "../src/compaction.js";
import type { ChatMessage, Role } from "../src/types.js";

let seq = 0;
function msg(role: Role, content: string): ChatMessage {
  seq += 1;
  return { id: `t${seq}`, role, content, at: 1000 + seq };
}

/** Adjacent same-role user/assistant pairs — rejected by some provider APIs. */
function alternationViolations(msgs: ChatMessage[]): number[] {
  const bad: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    const a = msgs[i - 1]!;
    const b = msgs[i]!;
    if (a.role === b.role && (b.role === "user" || b.role === "assistant")) bad.push(i);
  }
  return bad;
}

const PROTECTED_BLOCK = [
  "<<<PROTECTED>>>",
  "Always run bun test before done",
  "Never delete user files",
  "<<<END PROTECTED>>>",
].join("\n");

function sysMsg(): ChatMessage {
  return msg("system", `You are a coding agent.\n${PROTECTED_BLOCK}\n<<<PINNED:step-ctx>>>`);
}

/** system + 3 user/assistant turns */
function threeTurns(): ChatMessage[] {
  return [
    sysMsg(),
    msg("user", "ask-0"),
    msg("assistant", "ans-0"),
    msg("user", "ask-1"),
    msg("assistant", "ans-1"),
    msg("user", "ask-2"),
    msg("assistant", "ans-2"),
  ];
}

describe("compaction trigger threshold", () => {
  // estTokens = ceil(len/3.5); estimateMessages adds 4 per message.
  // Compactor triggerFrac 0.5 with modelCtx 1000 -> target = 500 tokens.
  const c = new Compactor({ triggerFrac: 0.5 });

  test("below threshold -> no-op (report null)", async () => {
    const res = await c.maybeCompact([msg("user", "x".repeat(1400))], 1000); // 4+400=404 <= 500
    expect(res.report).toBeNull();
  });

  test("exactly at threshold -> no-op (boundary locked)", async () => {
    const res = await c.maybeCompact([msg("user", "x".repeat(1736))], 1000); // 4+496=500 == target
    expect(res.report).toBeNull();
  });

  test("above threshold -> compaction fires", async () => {
    const res = await c.maybeCompact([msg("user", "x".repeat(1800))], 1000); // 4+515=519 > 500
    expect(res.report).not.toBeNull();
  });
});

describe("context window / incoming size sanity (NaN, negative, zero)", () => {
  test("getEffectiveContextWindow passes through valid ctx", () => {
    expect(getEffectiveContextWindow(4096)).toBe(4096);
  });

  test("getEffectiveContextWindow rejects 0/negative/NaN defaults", () => {
    expect(getEffectiveContextWindow(0)).toBe(128_000);
    expect(getEffectiveContextWindow(-5)).toBe(128_000);
    expect(getEffectiveContextWindow(Number.NaN)).toBe(128_000);
  });

  test("ENGINE_FORCE_CTX override still wins, garbage falls back", () => {
    process.env.ENGINE_FORCE_CTX = "999";
    try {
      expect(getEffectiveContextWindow(4096)).toBe(999);
      process.env.ENGINE_FORCE_CTX = "garbage";
      expect(getEffectiveContextWindow(4096)).toBe(4096);
    } finally {
      delete process.env.ENGINE_FORCE_CTX;
    }
  });

  test("NaN incomingSize must not false-trigger compaction", async () => {
    const c = new Compactor();
    const res = await c.maybeCompact([msg("user", "hello")], 128_000, Number.NaN);
    expect(res.report).toBeNull();
  });

  test("NaN/negative modelCtx must not false-trigger compaction", async () => {
    const c = new Compactor();
    const resNaN = await c.maybeCompact([msg("user", "hello")], Number.NaN, 0);
    expect(resNaN.report).toBeNull();
    const resNeg = await c.maybeCompact([msg("user", "hello")], -1, 0);
    expect(resNeg.report).toBeNull();
  });
});

describe("tiny conversations no-op safely", () => {
  test("empty history, no incoming -> untouched no-op", async () => {
    const c = new Compactor();
    const res = await c.maybeCompact([], 128_000, 0);
    expect(res.report).toBeNull();
    expect(res.messages).toEqual([]);
  });

  test("single message under threshold -> untouched no-op", async () => {
    const c = new Compactor();
    const one = [msg("user", "hi")];
    const res = await c.maybeCompact(one, 128_000);
    expect(res.report).toBeNull();
    expect(res.messages).toEqual(one);
  });

  test("huge incoming with empty history triggers but applies no tier -> tier 'none'", async () => {
    const c = new Compactor();
    // incoming 64k > 0.25*128k -> triggers; but 64k <= target 92.16k -> fits() immediately.
    const res = await c.maybeCompact([], 128_000, 64_000);
    expect(res.report).not.toBeNull();
    expect(res.report!.tier).toBe("none");
    expect(res.messages).toEqual([]);
  });
});

describe("pinned/system messages survive every tier", () => {
  test("T2 keeps system prompt, keystone and recent turns; probe passes", async () => {
    const c = new Compactor({ keepRecentTurns: 1 });
    const summarizer = async (_p: string) => `${PROTECTED_BLOCK}\nSummary: touched files, ran commands.`;
    const { messages: out, report } = await c.t2RollingSummary(threeTurns(), summarizer);
    expect(out.some((m) => m.role === "system" && m.content.includes("PROTECTED"))).toBe(true);
    expect(out.some((m) => m.content === "ask-0")).toBe(true); // keystone
    expect(out.some((m) => m.content === "ask-2")).toBe(true); // recent turn
    expect(out.some((m) => m.content === "ans-2")).toBe(true);
    expect(report.preservedProtected).toBe(true);
    expect(alternationViolations(out)).toEqual([]);
  });

  test("T3 keeps system prompt, keystone and last turn", () => {
    const c = new Compactor({ keepRecentTurns: 1 });
    const { messages: out } = c.t3EmergencyRebuild(threeTurns(), { goal: "Ship feature" });
    expect(out.some((m) => m.role === "system" && m.content.includes("PROTECTED"))).toBe(true);
    expect(out.some((m) => m.content.includes("ask-0"))).toBe(true); // keystone
    expect(out.some((m) => m.content.includes("ask-2"))).toBe(true); // last turn
    expect(out.some((m) => m.content.includes("Goal: Ship feature"))).toBe(true);
  });

  test("full maybeCompact cascade preserves system + last turn", async () => {
    const c = new Compactor({ keepRecentTurns: 1 });
    const summarizer = async (_p: string) => `${PROTECTED_BLOCK}\nSummary: did things.`;
    const { messages: out, report } = await c.maybeCompact(threeTurns(), 64, 0, summarizer);
    expect(report).not.toBeNull();
    expect(out.some((m) => m.role === "system" && m.content.includes("PROTECTED"))).toBe(true);
    expect(out.some((m) => m.content.includes("ask-2"))).toBe(true);
    expect(alternationViolations(out)).toEqual([]);
  });
});

describe("compaction outputs keep role alternation valid", () => {
  test("T3 with a fresh user ask must not emit user,user", () => {
    const c = new Compactor();
    const { messages: out } = c.t3EmergencyRebuild([sysMsg(), msg("user", "do X")], {});
    expect(alternationViolations(out)).toEqual([]);
    expect(out.some((m) => m.content.includes("do X"))).toBe(true);
    expect(out.some((m) => m.content.includes("[CONTEXT REBUILT"))).toBe(true);
  });

  test("T3 with keystone + last turn must not emit user,user", () => {
    const c = new Compactor();
    const { messages: out } = c.t3EmergencyRebuild(
      [sysMsg(), msg("user", "ask-0"), msg("assistant", "ans-0"), msg("user", "ask-1"), msg("assistant", "ans-1")],
      {}
    );
    expect(alternationViolations(out)).toEqual([]);
    expect(out.some((m) => m.content.includes("ask-0"))).toBe(true);
    expect(out.some((m) => m.content.includes("ask-1"))).toBe(true);
  });

  test("T1.5 forget marker must not create user,user", () => {
    const c = new Compactor({ keepRecentTurns: 1 }); // trigger 4 turns, target 2
    const msgs: ChatMessage[] = [sysMsg()];
    for (let i = 0; i < 5; i++) {
      msgs.push(msg("user", `ask-${i}`), msg("assistant", `ans-${i}`));
    }
    const { messages: out, dropped } = c.t15AmortizedForget(msgs);
    expect(dropped).toBeGreaterThan(0);
    expect(alternationViolations(out)).toEqual([]);
    const merged = out.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(merged.includes("[AMORTIZED FORGET]")).toBe(true);
    expect(merged.includes("ask-0")).toBe(true); // keystone content survives
    expect(merged.includes("ask-3")).toBe(true); // recent turn content survives
  });

  test("T1 tool-result summary must not create user,user", () => {
    const c = new Compactor({ keepRecentTurns: 1 });
    const msgs = [
      msg("user", "ask-0"),
      msg("tool", "tool output A"),
      msg("tool", "tool output B"),
      msg("user", "ask-1"),
      msg("assistant", "ans-1"),
      msg("user", "ask-2"),
      msg("assistant", "ans-2"),
    ];
    const { messages: out, replaced } = c.t1SummarizeOldToolResults(msgs);
    expect(replaced).toBe(2);
    expect(alternationViolations(out)).toEqual([]);
    expect(out.some((m) => m.content.includes("[SUMMARIZED TOOL RESULTS x2]"))).toBe(true);
    expect(out.some((m) => m.content.includes("ask-1"))).toBe(true);
  });
});
