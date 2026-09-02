// B44: nudge queue contract. The positive path (queue → toolLoop injection)
// needs a live task with an LLM in the loop, so it is covered by the wave-2
// HTTP integration; here we pin the exported contract: signature, input
// validation, and honest failure for tasks that are not live in this process.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { enqueueNudge } from "../src/orchestrator.js";

describe("B44 enqueueNudge contract", () => {
  test("is a (taskId, text) => boolean function (wave-2 route contract)", () => {
    expect(typeof enqueueNudge).toBe("function");
  });

  test("rejects unknown task ids instead of pretending success", () => {
    expect(enqueueNudge("no-such-task", "please hurry up")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(enqueueNudge("", "nudge text")).toBe(false);
    expect(enqueueNudge("task-1", "")).toBe(false);
    expect(enqueueNudge("task-1", "   ")).toBe(false);
  });
});
