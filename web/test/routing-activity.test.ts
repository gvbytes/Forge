// "Which model is doing what, right now" must come from the SAME events the
// chat renders. A second endpoint reporting live state could disagree with the
// trace, and a routing view that contradicts the trace is worse than none.
import { describe, expect, test } from "bun:test";
import { foldRoleStates } from "../src/components/RoutingActivity";
import type { EventDto } from "../src/lib/types";

let n = 0;
const ev = (type: string, payload: unknown): EventDto =>
  ({ id: ++n, taskId: "t1", ts: 1000 + n, type, payload } as EventDto);

describe("foldRoleStates", () => {
  test("a role that started and not ended reads as running", () => {
    const rows = foldRoleStates([
      ev("route", { agentRole: "coder", input: { modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", provider: "nvidia-nim" } }),
      ev("agent.start", { agentRole: "coder" }),
    ], {});
    const coder = rows.find((r) => r.role === "coder")!;
    expect(coder.status).toBe("running");
    expect(coder.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
  });

  test("agent.end closes the role", () => {
    const rows = foldRoleStates([
      ev("agent.start", { agentRole: "planner" }),
      ev("agent.end", { agentRole: "planner" }),
    ], {});
    expect(rows.find((r) => r.role === "planner")!.status).toBe("done");
  });

  test("a fallback key is surfaced — otherwise key failover is invisible", () => {
    // Every attempt reads the same provider/model with one provider, so without
    // this the second key looks like a pointless retry of the first.
    const rows = foldRoleStates([
      ev("route", { agentRole: "coder", attempts: [{ key: "2/3", provider: "nvidia-nim" }] }),
    ], {});
    expect(rows.find((r) => r.role === "coder")!.key).toBe("2/3");
  });

  test("pinned-but-idle roles still appear", () => {
    // An empty panel would read as "not wired up"; "configured but idle" is
    // information the operator wants.
    const rows = foldRoleStates([], { planner: "google/gemma-4-31b-it", coder: "x" });
    expect(rows.map((r) => r.role).sort()).toEqual(["coder", "planner"]);
    expect(rows.every((r) => r.status === "idle")).toBe(true);
  });

  test("roles are ordered by pipeline position, not arrival", () => {
    const rows = foldRoleStates([
      ev("agent.start", { agentRole: "reviewer" }),
      ev("agent.start", { agentRole: "planner" }),
    ], {});
    expect(rows.map((r) => r.role)).toEqual(["planner", "reviewer"]);
  });

  test("events without a role are ignored rather than creating phantom rows", () => {
    expect(foldRoleStates([ev("route", { input: { modelId: "x" } })], {})).toHaveLength(0);
  });
});
