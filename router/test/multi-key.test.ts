// Free tiers meter per ACCOUNT, so one key is the practical ceiling on a
// free-tier agent: every role shares one rate limit and a busy planner starves
// the coder. Holding several keys per provider and spreading roles across them
// multiplies that ceiling — this is the pattern the Forge prototype used with
// four NVIDIA NIM accounts (planner / coder / critic / router).
import { describe, expect, test, beforeEach } from "bun:test";
import { Telemetry } from "../src/telemetry";

const mk = () => new Telemetry(":memory:");

describe("multi-key per provider", () => {
  let t: Telemetry;
  beforeEach(() => { t = mk(); });

  test("a role-pinned key wins for that role", () => {
    t.setKeySlot("nvidia-nim", "planner", "KEY_PLANNER");
    t.setKeySlot("nvidia-nim", "coder", "KEY_CODER");
    expect(t.getKeyForRole("nvidia-nim", "planner")).toBe("KEY_PLANNER");
    expect(t.getKeyForRole("nvidia-nim", "coder")).toBe("KEY_CODER");
  });

  test("an unpinned role ROUND-ROBINS across the shared pool", () => {
    // Always picking the first key would leave the other accounts idle until
    // the first one 429s, which defeats the point of holding several.
    t.setKeySlot("groq", "default", "A");
    t.setKeySlot("groq", "spare1", "B");
    t.setKeySlot("groq", "spare2", "C");
    const picks = [0, 1, 2, 3, 4, 5].map(() => t.getKeyForRole("groq", "reviewer"));
    expect(new Set(picks).size).toBe(3);      // all three get used
    expect(picks[0]).not.toBe(picks[1]);      // consecutive calls differ
  });

  test("a pinned role does not consume the shared pool's rotation", () => {
    t.setKeySlot("nvidia-nim", "planner", "PINNED");
    t.setKeySlot("nvidia-nim", "default", "SHARED");
    expect(t.getKeyForRole("nvidia-nim", "planner")).toBe("PINNED");
    expect(t.getKeyForRole("nvidia-nim", "coder")).toBe("SHARED");
    expect(t.getKeyForRole("nvidia-nim", "explorer")).toBe("SHARED");
  });

  test("falls back to the shared pool when the role has no pin", () => {
    t.setKeySlot("zen", "default", "ONLY");
    expect(t.getKeyForRole("zen", "planner")).toBe("ONLY");
    expect(t.getKeyForRole("zen", undefined)).toBe("ONLY");
  });

  test("a provider with no keys resolves to null, never another provider's", () => {
    t.setKeySlot("groq", "default", "GROQ_KEY");
    expect(t.getKeyForRole("openrouter", "coder")).toBeNull();
  });

  test("legacy single-key installs keep working without migration", () => {
    t.setKey("groq", "LEGACY");
    expect(t.getKeyForRole("groq", "coder")).toBe("LEGACY");
    expect(t.listKeys("groq").some((k) => k.slot === "default")).toBe(true);
  });

  test("updating a slot replaces it rather than duplicating", () => {
    t.setKeySlot("groq", "coder", "OLD");
    t.setKeySlot("groq", "coder", "NEW");
    expect(t.getKeyForRole("groq", "coder")).toBe("NEW");
    expect(t.listKeys("groq")).toHaveLength(1);
  });

  test("deleting a slot removes only that key", () => {
    t.setKeySlot("nvidia-nim", "planner", "P");
    t.setKeySlot("nvidia-nim", "coder", "C");
    t.deleteKeySlot("nvidia-nim", "planner");
    expect(t.getKeyForRole("nvidia-nim", "planner")).toBe("C"); // falls through to the pool
    expect(t.listKeys("nvidia-nim")).toHaveLength(1);
  });

  test("allKeySlots reports the multi-key layout per provider", () => {
    t.setKeySlot("nvidia-nim", "planner", "P");
    t.setKeySlot("nvidia-nim", "coder", "C");
    t.setKeySlot("groq", "default", "G");
    const layout = t.allKeySlots();
    expect(layout["nvidia-nim"]!.sort()).toEqual(["coder", "planner"]);
    expect(layout["groq"]).toEqual(["default"]);
  });
});
