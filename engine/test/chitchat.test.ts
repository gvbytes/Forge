// "Hello" cost ~2,557 tokens: answerLite spins up a tool loop with the
// read-only tool schemas declared, and a tool-trained model handed a roster
// uses it — the transcript showed a directory listing being run to answer a
// greeting. This routes social messages to a single tiny completion instead.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { isChitchat, isTrivial } from "../src/orchestrator.js";

describe("isChitchat", () => {
  test("catches the greetings and acknowledgements that cost the most", () => {
    for (const t of ["hi", "Hello", "hey!", "yo", "good morning", "thanks", "thank you",
                     "thx", "ok", "cool", "got it", "nvm", "bye", "cheers", "ping"]) {
      expect(isChitchat(t)).toBe(true);
    }
  });

  test("a question is never chitchat, however short", () => {
    // "hi?" is someone checking the agent is alive — that still deserves the
    // normal path, and more importantly "what is this?" must not be swallowed.
    expect(isChitchat("hi?")).toBe(false);
    expect(isChitchat("ok?")).toBe(false);
  });

  test("a greeting carrying real work falls through to the normal path", () => {
    expect(isChitchat("hi, can you fix the parser")).toBe(false);
    expect(isChitchat("thanks, now add a multiply function")).toBe(false);
    expect(isChitchat("ok update main.py")).toBe(false);
  });

  test("anything naming a repo artifact is not chitchat", () => {
    expect(isChitchat("ok src/app.ts")).toBe(false);
  });

  test("a bare \"test\" is work, not a greeting", () => {
    // CODE_INTENT claims it: someone typing "test" almost certainly means
    // "run the tests", and answering "Hey!" to that would be a real failure.
    expect(isChitchat("test")).toBe(false);
  });

  test("long messages are never chitchat even if they start socially", () => {
    expect(isChitchat("hello " + "x".repeat(60))).toBe(false);
  });

  test("empty input is not chitchat", () => {
    expect(isChitchat("")).toBe(false);
    expect(isChitchat("   ")).toBe(false);
  });

  test("chitchat is a strict subset of trivial — it can never reach the planner", () => {
    // If something is chitchat it must also pass isTrivial, otherwise the
    // ordering in runTask would be the only thing keeping it off the planner.
    for (const t of ["hi", "thanks", "ok", "bye"]) {
      expect(isChitchat(t)).toBe(true);
      expect(isTrivial(t)).toBe(true);
    }
  });
});
