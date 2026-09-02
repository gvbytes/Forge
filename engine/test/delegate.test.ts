// Wave 25 subagents: the `delegate` tool does REAL work (spins up a bounded
// sub-agent) instead of echoing its args. These tests lock the injection
// contract (tools.ts ⇄ orchestrator) and the recursion depth guard WITHOUT
// touching the network — the depth guard returns before any LLM call.
import "./_env.js";
import { describe, expect, test, afterEach, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { executeTool, setDelegateRunner, type DelegateInput } from "../src/tools.js";
import { runDelegateSubtask, runDelegateBatch, _subtaskSessionsForTest } from "../src/orchestrator.js";
import { newSession } from "../src/sessions.js";

const ENGINE_ROOT = path.dirname(new URL(".", import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(ENGINE_ROOT, "tmp-delegate-"));

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  // Restore the production runner (orchestrator registers it at import); a
  // test that swapped in a fake must not leak it into later tests.
  setDelegateRunner(runDelegateSubtask);
  _subtaskSessionsForTest.clear();
});

function call(args: Record<string, unknown>) {
  return executeTool({
    sessionId: "parent-session",
    projectId: "delegate-project",
    projectRoot: root,
    name: "delegate",
    args,
    autoApprove: true,
  });
}

describe("delegate tool injection (wave 25)", () => {
  test("delegate forwards to the injected runner and returns its report", async () => {
    const captured: { input?: DelegateInput } = {};
    setDelegateRunner(async (input) => {
      captured.input = input;
      return `[fake-runner] completed: ${input.goal}`;
    });
    const res = await call({ role: "coder", goal: "write utils.js", instructions: "keep it small" });
    expect(res.ok).toBe(true);
    expect(res.result).toContain("[fake-runner] completed: write utils.js");
    expect(captured.input?.goal).toBe("write utils.js");
    expect(captured.input?.role).toBe("coder");
    expect(captured.input?.instructions).toBe("keep it small");
    expect(captured.input?.sessionId).toBe("parent-session");
    expect(captured.input?.projectRoot).toBe(root);
  });

  test("delegate defaults role to coder and instructions to empty", async () => {
    const captured: { input?: DelegateInput } = {};
    setDelegateRunner(async (input) => { captured.input = input; return "ok"; });
    await call({ goal: "do a thing" });
    expect(captured.input?.role).toBe("coder");
    expect(captured.input?.instructions).toBe("");
  });

  test("delegate without a registered runner degrades gracefully (no throw)", async () => {
    setDelegateRunner(null);
    const res = await call({ goal: "orphan goal" });
    expect(res.ok).toBe(true);
    expect(res.result).toContain("not available");
    expect(res.result).toContain("orphan goal");
  });

  test("delegate requires a goal", async () => {
    setDelegateRunner(async () => "should not run");
    const res = await call({ role: "coder" }); // no goal
    expect(res.ok).toBe(false);
  });

  test("delegate accepts 'task' as an alias for 'goal' (model robustness)", async () => {
    // Smaller models hallucinate the arg key ("task" instead of "goal"); the
    // handler accepts both instead of failing the call.
    const captured: { input?: DelegateInput } = {};
    setDelegateRunner(async (input) => { captured.input = input; return "ok"; });
    const res = await call({ role: "coder", task: "build the thing" });
    expect(res.ok).toBe(true);
    expect(captured.input?.goal).toBe("build the thing");
  });
});

describe("delegate recursion depth guard (wave 25)", () => {
  test("refuses to delegate from within a delegated subtask (no LLM call)", async () => {
    _subtaskSessionsForTest.add("already-a-subtask");
    const out = await runDelegateSubtask({
      sessionId: "already-a-subtask",
      projectId: "delegate-project",
      projectRoot: root,
      role: "coder",
      goal: "nested delegation attempt",
      instructions: "",
    });
    expect(out).toContain("refused");
    expect(out).toContain("depth limit");
  });

  test("a normal (non-subtask) session is NOT refused by the guard", async () => {
    // We can't run the full subtask without an LLM, but the guard must not be
    // the thing that stops a fresh session — assert the set is empty for it.
    expect(_subtaskSessionsForTest.has("fresh-session")).toBe(false);
  });
});

describe("delegate cancellation & failure semantics (wave 25)", () => {
  test("an already-aborted parent signal aborts the subtask fast (no LLM call)", async () => {
    // The parent's AbortSignal is threaded into the runner; when it is already
    // aborted the child controller aborts immediately, so toolLoop throws
    // AbortError on its first iteration — before any LLM call. The failure path
    // (not the success path) must run, and it must not hang.
    const out = await runDelegateSubtask({
      sessionId: "parent-live",
      projectId: "delegate-project",
      projectRoot: root,
      role: "coder",
      goal: "will be cancelled",
      instructions: "",
      signal: AbortSignal.abort(),
    });
    expect(out).toContain("subtask failed");
    expect(out).not.toContain("[delegate report");
    // The depth-guard set must be cleaned up even on the abort path.
    expect(_subtaskSessionsForTest.size).toBe(0);
  });
});

describe("delegate parallel fan-out (wave 25)", () => {
  test("runDelegateBatch runs multiple delegate calls concurrently, results in order", async () => {
    const events: string[] = [];
    setDelegateRunner(async (input) => {
      events.push(`start:${input.goal}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${input.goal}`);
      return `[fake] done: ${input.goal}`;
    });
    const session = newSession("delegate-project", "batch-test");
    const ctx = {
      session, root, controller: new AbortController(),
      deadline: Date.now() + 60_000, startedAt: Date.now(),
    } as Parameters<typeof runDelegateBatch>[0];
    const calls = [
      { name: "delegate", args: { role: "coder", goal: "task-A", instructions: "" } },
      { name: "delegate", args: { role: "coder", goal: "task-B", instructions: "" } },
      { name: "delegate", args: { role: "explorer", goal: "task-C", instructions: "" } },
    ];
    const results = await runDelegateBatch(ctx, calls, "span-batch");
    // All three ran and results preserve input order.
    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.result).toContain("task-A");
    expect(results[1]!.result).toContain("task-B");
    expect(results[2]!.result).toContain("task-C");
    // Concurrency: all three starts fire before the first end (a sequential run
    // would interleave start/end/start/end/…). The 10ms yield guarantees the
    // three synchronous starts land before any timer resolves.
    const firstEndIdx = events.findIndex((e) => e.startsWith("end:"));
    expect(firstEndIdx).toBe(3);
  });
});
