// B14: trivial-triage regression suite.
// The old isTrivial only matched text shaped like a question (interrogative
// lead or "?"), so short imperative asks needlessly spun up the planner, while
// the fix must NOT let real code asks (or anything naming repo artifacts)
// skip the planner.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { isTrivial } from "../src/orchestrator.js";

const TRIVIAL: string[] = [
  // pure questions (branch 1)
  "what is a closure?",
  "explain the difference between let and const",
  "why did the build fail?",
  "how does garbage collection work?",
  "who wrote the design doc?",
  "is bun faster than node for http servers?",
  "any idea when the meeting is?",
  "what's the weather like?",
  "describe the auth flow conceptually",
  "list the pros and cons of microservices",
  // tiny non-code asks (branch 2 — the broadened path)
  "thanks!",
  "hello there",
  "summarize the last change",
  "ok, understood",
];

const CODE_ASKS: string[] = [
  "fix the login bug in auth.ts",
  "add a retry to the fetch call",
  "implement the csv parser",
  "refactor this function to use async/await",
  "create a settings page component",
  "delete the unused helpers",
  "update the readme with the new steps",
  "write a unit test for the tokenizer",
  "rename the variable x to count everywhere",
  "debug the failing ci pipeline",
  "migrate the schema to v2",
  "install the new logging package",
  // BUGFIX: "make" and other creation verbs were missing from CODE_INTENT, so
  // these triaged as trivial → read-only lite path → no files written.
  "make a 3d flappy bird game",
  "make me a todo app",
  "generate a readme for the repo",
  "develop a REST API for users",
  "scaffold a new vite project",
  // BUGFIX: polite lead-ins ("can you …") used to hit the question branch even
  // when they carried a code-intent verb.
  "can you make a snake game",
  "can you create a landing page",
  "please write a script to rename files",
  "could you build a small calculator app",
  // repo-artifact mentions without a code verb must still go to the planner
  "change engine/src/tools.ts to log errors",
  "have a look at @src/index.ts for me",
];

describe("B14 isTrivial", () => {
  for (const t of TRIVIAL) {
    test(`trivial: "${t}"`, () => {
      expect(isTrivial(t)).toBe(true);
    });
  }
  for (const t of CODE_ASKS) {
    test(`code ask: "${t}"`, () => {
      expect(isTrivial(t)).toBe(false);
    });
  }
  test("question ABOUT a file is not trivial (needs explore)", () => {
    expect(isTrivial("what does engine/src/tools.ts do?")).toBe(false);
  });
  test("empty text is not trivial", () => {
    expect(isTrivial("")).toBe(false);
    expect(isTrivial("   ")).toBe(false);
  });
  test("long question stays trivial up to 60 words, not beyond", () => {
    const longQ = `what is ${Array.from({ length: 55 }, (_, i) => `word${i}`).join(" ")}?`;
    expect(isTrivial(longQ)).toBe(true);
    const tooLong = `what is ${Array.from({ length: 65 }, (_, i) => `word${i}`).join(" ")}?`;
    expect(isTrivial(tooLong)).toBe(false);
  });
});
