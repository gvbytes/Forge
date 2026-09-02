import "./_env.js";
import { describe, test, expect } from "bun:test";
import { resolveRoleOverride } from "../src/config.js";

/** Per-role model control (settings.selectedModels). The decision logic lives in
 *  the pure resolveRoleOverride helper (config.ts) because chat.test.ts replaces
 *  the router/providers modules with process-wide mocks, which would mask any
 *  logic embedded in decideRoute when the full suite runs. decideRoute wires this
 *  helper (verified in isolation); these tests pin the decision itself. */
describe("resolveRoleOverride (per-role model control)", () => {
  test("returns the pinned model when it is usable", () => {
    expect(resolveRoleOverride({ coder: "engine/small" }, "coder", () => true)).toBe("engine/small");
  });

  test("returns undefined for a role with no pin (auto-route)", () => {
    expect(resolveRoleOverride({ coder: "engine/small" }, "reviewer", () => true)).toBeUndefined();
  });

  test("returns undefined when the pinned model is not usable (disabled/unknown)", () => {
    expect(resolveRoleOverride({ coder: "engine/small" }, "coder", () => false)).toBeUndefined();
  });

  test("handles absent/empty selectedModels", () => {
    expect(resolveRoleOverride(undefined, "coder", () => true)).toBeUndefined();
    expect(resolveRoleOverride({}, "coder", () => true)).toBeUndefined();
  });

  test("only consults the requested role", () => {
    const sel = { planner: "a", coder: "b", reviewer: "c" };
    expect(resolveRoleOverride(sel, "planner", () => true)).toBe("a");
    expect(resolveRoleOverride(sel, "coder", () => true)).toBe("b");
    expect(resolveRoleOverride(sel, "reviewer", () => true)).toBe("c");
    expect(resolveRoleOverride(sel, "explorer", () => true)).toBeUndefined();
  });
});
