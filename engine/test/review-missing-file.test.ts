// Deterministic false-pass guard: a source file explicitly named in the step
// goal that is NEITHER in the diff NOR pre-existing was meant to be created but
// wasn't. Seen live under concurrent load: planner fell back to a single step,
// coder wrote index.html (referencing quotes.js) but never created quotes.js,
// and the reviewer LLM passed. This guard fails the step so the coder retries.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { goalNamedFilesMissing } from "../src/orchestrator.js";

const step = (title: string, detail = "") => ({ title, detail }) as unknown as Parameters<typeof goalNamedFilesMissing>[0];
// REALISTIC jsdiff createTwoFilesPatch format — what computeDiffs actually emits
// ("Index: path", NOT "diff --git"). Synthetic diff --git patches would not catch
// a regression where extractChangedPaths only matched git-style headers.
const diff = (...paths: string[]) => paths.map((p) => `Index: ${p}\n===================================================================\n--- ${p}\tbefore\n+++ ${p}\tafter\n@@ -0,0 +1 @@\n+x`).join("\n");
// git-style format (run_command git-diff fallback chunks) — also must be matched.
const gitdiff = (...paths: string[]) => paths.map((p) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+x`).join("\n");

describe("goalNamedFilesMissing (false-pass guard)", () => {
  test("flags a goal-named source file absent from diff and snapshot", () => {
    const s = step("execute goal directly", "make a random quote page index.html + quotes.js");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined)).toEqual(["quotes.js"]);
  });
  test("no flag when every goal-named file is in the diff", () => {
    const s = step("execute goal directly", "make a random quote page index.html + quotes.js");
    expect(goalNamedFilesMissing(s, diff("index.html", "quotes.js"), undefined)).toEqual([]);
  });
  test("no flag for a pre-existing (snapshot) file not touched", () => {
    const s = step("refactor to use utils.js", "main.js already uses utils.js");
    const pre = new Map<string, string | null>([["utils.js", "old"], ["main.js", "old"]]);
    // diff modifies main.js only; utils.js pre-exists -> not missing
    expect(goalNamedFilesMissing(s, diff("main.js"), pre)).toEqual([]);
  });
  test("data extensions (.json/.csv/.txt/.md) are not flagged (inputs)", () => {
    const s = step("process data", "read config.json and data.csv, write notes.md");
    expect(goalNamedFilesMissing(s, diff("process.py"), undefined)).toEqual([]);
  });
  test("goal naming no source files -> empty", () => {
    expect(goalNamedFilesMissing(step("Summarize the approach"), "", undefined)).toEqual([]);
  });
  test("basename matching: diff path with dir matches bare goal name", () => {
    const s = step("create app", "index.html and quotes.js");
    expect(goalNamedFilesMissing(s, diff("app/index.html", "app/quotes.js"), undefined)).toEqual([]);
  });
});

describe("goalNamedFilesMissing includeDetail scoping (multi-step vs single-step)", () => {
  test("multi-step (includeDetail=false): detail naming a later step's file is NOT flagged", () => {
    // step 1 title names only index.html; its detail mentions stopwatch.js (step 2's file)
    const s = step("Create index.html with stopwatch UI", "The page loads stopwatch.js for the logic");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual([]);
  });
  test("multi-step (includeDetail=false): title-named file that is missing IS flagged", () => {
    const s = step("Create stopwatch.js with timer logic", "implement start/stop/lap");
    // only index.html in diff (accumulated from step 1); stopwatch.js absent
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual(["stopwatch.js"]);
  });
  test("single-step (includeDetail=true): detail-named missing file IS flagged", () => {
    const s = step("execute goal directly", "make a quote page index.html + quotes.js");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, true)).toEqual(["quotes.js"]);
  });
  test("multi-step: title REFERENCING other steps' files (linking/loading) NOT flagged", () => {
    // step 1 creates index.html but references style.css/game.js (created in steps 2/3)
    const s = step("Create index.html linking style.css and loads game.js", "the page links the css and loads the js");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual([]);
  });
  test("multi-step: create-verb file missing while referenced file present IS flagged", () => {
    const s = step("Create game.js loading index.html", "wire the logic");
    // only index.html in diff; game.js (the create-verb object) absent
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual(["game.js"]);
  });
});

describe("goalNamedFilesMissing audit fixes (realistic diff + edge cases)", () => {
  test("bug#1: jsdiff 'Index:' format diff paths ARE extracted", () => {
    const s = step("execute goal directly", "make index.html and quotes.js");
    expect(goalNamedFilesMissing(s, diff("index.html", "quotes.js"), undefined)).toEqual([]);
  });
  test("bug#1: git-style diff paths ARE also extracted", () => {
    const s = step("execute goal directly", "make index.html and quotes.js");
    expect(goalNamedFilesMissing(s, gitdiff("index.html", "quotes.js"), undefined)).toEqual([]);
  });
  test("bug#1: Index:-format created file satisfies the guard (no false positive)", () => {
    const s = step("Create index.html with UI", "");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual([]);
  });
  test("bug#2: FAILED write (null snapshot, not in diff) IS flagged", () => {
    const s = step("execute goal directly", "make index.html and quotes.js");
    // both attempted (snapshot keys, null = new); only index.html actually written
    const pre = new Map<string, string | null>([["index.html", null], ["quotes.js", null]]);
    expect(goalNamedFilesMissing(s, diff("index.html"), pre)).toEqual(["quotes.js"]);
  });
  test("bug#2: genuinely pre-existing file (non-null) NOT flagged", () => {
    const s = step("refactor to use utils.js", "main.js uses utils.js");
    const pre = new Map<string, string | null>([["utils.js", "old content"]]);
    expect(goalNamedFilesMissing(s, diff("main.js"), pre)).toEqual([]);
  });
  test("bug#5: dotted-suffix app.js.map is NOT parsed as app.js", () => {
    const s = step("execute goal directly", "create app.js.map sourcemap");
    expect(goalNamedFilesMissing(s, diff("app.js.map"), undefined)).toEqual([]);
  });
  test("bug#6: a URL is NOT treated as a local file to create", () => {
    const s = step("execute goal directly", "see https://cdn.example.com/widget.js docs, create index.html");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined)).toEqual([]);
  });
  test("bug#3: gerund 'Creating quotes.js' IS matched and flagged when absent", () => {
    const s = step("Creating quotes.js with the data", "");
    expect(goalNamedFilesMissing(s, diff("index.html"), undefined, false)).toEqual(["quotes.js"]);
  });
});
