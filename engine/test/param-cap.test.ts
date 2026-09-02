// PS 2a: every model used anywhere must be <=80B TOTAL parameters.
//
// The local router enforces this as a startup invariant — but a provider
// pointing straight at an upstream bypasses the router entirely, and that
// branch used to admit everything, merely tagging it "unverified". Observed in
// a real task: `openai/gpt-oss-120b` called twice through a direct NVIDIA NIM
// provider, 12,224 prompt tokens, $0.035 spent. A hard constraint violation.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { paramsBFromId, MAX_PARAM_B } from "../src/providers.js";

describe("paramsBFromId", () => {
  test("reads a plain size from the id", () => {
    expect(paramsBFromId("openai/gpt-oss-20b")).toBe(20);
    expect(paramsBFromId("openai/gpt-oss-120b")).toBe(120);
    expect(paramsBFromId("meta/llama-3.3-70b-instruct")).toBe(70);
  });

  test("takes the LARGEST size in an MoE id — the constraint is on TOTAL", () => {
    // Reading the active count would admit exactly what the rule excludes.
    expect(paramsBFromId("nvidia/nemotron-3-super-120b-a12b")).toBe(120);
    expect(paramsBFromId("nvidia/nemotron-3-ultra-550b-a55b")).toBe(550);
    expect(paramsBFromId("google/gemma-4-26b-a4b-it")).toBe(26);
  });

  test("returns null when the id states no size", () => {
    expect(paramsBFromId("meta/muse-glimmer")).toBeNull();
    expect(paramsBFromId("mistralai/mistral-nemotron")).toBeNull();
    expect(paramsBFromId("some/model")).toBeNull();
  });

  test("ignores version numbers that are not sizes", () => {
    // "3.3" and "2.5" must not be mistaken for parameter counts.
    expect(paramsBFromId("meta/llama-3.3-70b-instruct")).toBe(70);
    expect(paramsBFromId("qwen/qwen-2.5-coder-32b-instruct")).toBe(32);
  });
});

describe("admission decision (fail closed)", () => {
  const admits = (id: string): boolean => {
    const b = paramsBFromId(id);
    return b !== null && b <= MAX_PARAM_B;
  };

  test("ADMITS models provably within the cap", () => {
    for (const id of ["openai/gpt-oss-20b", "qwen/qwen3.8-27b", "meta/llama-3.3-70b-instruct", "google/gemma-4-31b-it"]) {
      expect(admits(id)).toBe(true);
    }
  });

  test("REJECTS the 120B model that was actually called", () => {
    expect(admits("openai/gpt-oss-120b")).toBe(false);
  });

  test("rejects MoE models that are over cap on total", () => {
    expect(admits("nvidia/nemotron-3-super-120b-a12b")).toBe(false);
    expect(admits("poolside/laguna-s-2.1")).toBe(false); // 118B total, no size in id
  });

  test("rejects UNKNOWN sizes rather than hoping", () => {
    // "Unverified" is the wrong default for a disqualifying constraint: not
    // being able to prove compliance must mean exclusion.
    expect(admits("meta/muse-glimmer")).toBe(false);
    expect(admits("mistralai/mistral-nemotron")).toBe(false);
  });

  test("the boundary itself is admitted", () => {
    expect(admits("vendor/model-80b")).toBe(true);
    expect(admits("vendor/model-81b")).toBe(false);
  });
});
