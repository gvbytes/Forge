// Unit tests for DAG-based planning, topological validation, and dependency scheduling
import "./_env.js";
import { describe, expect, test } from "bun:test";
import {
  sanitizePlan,
  validateAndSortDAG,
  type PlanShape,
} from "../src/orchestrator.js";
import type { PlanStep } from "../src/types.js";

describe("validateAndSortDAG", () => {
  test("sorts a valid DAG with independent parallel branches", () => {
    // s1 (root) -> s2, s3 (parallel independent branches) -> s4 (joins s2 and s3)
    const steps: PlanStep[] = [
      { id: "s4", title: "Integration", detail: "Integrate s2 and s3", status: "pending", attempts: 0, dependsOn: ["s2", "s3"] },
      { id: "s2", title: "Math Module", detail: "Implement math.ts", status: "pending", attempts: 0, dependsOn: ["s1"] },
      { id: "s3", title: "Logger Module", detail: "Implement logger.ts", status: "pending", attempts: 0, dependsOn: ["s1"] },
      { id: "s1", title: "Core Types", detail: "Define types.ts", status: "pending", attempts: 0, dependsOn: [] },
    ];

    const { steps: sorted, hasCycle } = validateAndSortDAG(steps);
    expect(hasCycle).toBe(false);
    expect(sorted.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  test("handles independent parallel root steps", () => {
    // s1 and s2 can run immediately in parallel; s3 depends on both
    const steps: PlanStep[] = [
      { id: "s3", title: "Finalize", detail: "All done", status: "pending", attempts: 0, dependsOn: ["s1", "s2"] },
      { id: "s1", title: "Feature A", detail: "Build A", status: "pending", attempts: 0, dependsOn: [] },
      { id: "s2", title: "Feature B", detail: "Build B", status: "pending", attempts: 0, dependsOn: [] },
    ];

    const { steps: sorted, hasCycle } = validateAndSortDAG(steps);
    expect(hasCycle).toBe(false);
    expect(sorted.findIndex((s) => s.id === "s1")).toBeLessThan(sorted.findIndex((s) => s.id === "s3"));
    expect(sorted.findIndex((s) => s.id === "s2")).toBeLessThan(sorted.findIndex((s) => s.id === "s3"));
  });

  test("detects circular dependencies and recovers safely with linear fallback", () => {
    // Cycle: s1 -> s2 -> s1
    const steps: PlanStep[] = [
      { id: "s1", title: "Step 1", detail: "Do 1", status: "pending", attempts: 0, dependsOn: ["s2"] },
      { id: "s2", title: "Step 2", detail: "Do 2", status: "pending", attempts: 0, dependsOn: ["s1"] },
    ];

    const { steps: sorted, hasCycle } = validateAndSortDAG(steps);
    expect(hasCycle).toBe(true);
    // When a cycle is detected, validateAndSortDAG must break it by imposing linear dependencies
    expect(sorted[0]!.dependsOn).toEqual([]);
    expect(sorted[1]!.dependsOn).toEqual(["s1"]);
  });

  test("filters out non-existent dependency IDs and self-dependencies", () => {
    const steps: PlanStep[] = [
      { id: "s1", title: "Step 1", detail: "Do 1", status: "pending", attempts: 0, dependsOn: ["s1", "ghost_step"] },
    ];

    const { steps: sorted, hasCycle } = validateAndSortDAG(steps);
    expect(hasCycle).toBe(false);
    expect(sorted[0]!.dependsOn).toEqual([]);
  });
});

describe("sanitizePlan with DAG support", () => {
  test("preserves valid dependsOn arrays in plan output", () => {
    const raw: PlanShape = {
      steps: [
        { id: "s1", title: "Create types.ts", detail: "Export interface", dependsOn: [] },
        { id: "s2", title: "Create math.ts", detail: "Math functions", dependsOn: ["s1"] },
        { id: "s3", title: "Create util.ts", detail: "Utilities", dependsOn: ["s1"] },
        { id: "s4", title: "Create main.ts", detail: "Main entry point", dependsOn: ["s2", "s3"] },
      ],
      complexity: "medium",
    };

    const out = sanitizePlan(raw);
    expect(out).not.toBeNull();
    expect(out?.steps).toHaveLength(4);
    expect(out?.steps[1]?.dependsOn).toEqual(["s1"]);
    expect(out?.steps[2]?.dependsOn).toEqual(["s1"]);
    expect(out?.steps[3]?.dependsOn).toEqual(["s2", "s3"]);
  });

  test("handles plans without explicit dependsOn gracefully", () => {
    const raw: PlanShape = {
      steps: [
        { title: "First step", detail: "First detail" },
        { title: "Second step", detail: "Second detail" },
      ],
      complexity: "easy",
    };

    const out = sanitizePlan(raw);
    expect(out).not.toBeNull();
    expect(out?.steps).toHaveLength(2);
    expect(out?.steps[0]?.id).toBe("s1");
    expect(out?.steps[1]?.id).toBe("s2");
  });
});
