import "./_env.js";
import { describe, test, expect } from "bun:test";
import { parseResizeFrame, scriptArgsFor, cleanEnvForTest } from "../src/terminal.js";
import { NON_INTERACTIVE_ENV } from "../src/config.js";

/** The web terminal sends resize as an OBJECT frame {"resize":{cols,rows}} (and
 *  input as {"input":"..."}). The server historically only accepted the ARRAY
 *  form {"resize":[c,r]}, so every object resize frame fell through to
 *  writeInput() and the raw JSON was dumped into the shell — the garbage the UI
 *  showed. parseResizeFrame must accept BOTH shapes and reject everything else. */
describe("parseResizeFrame (terminal control-frame protocol)", () => {
  test("accepts the object form {cols,rows} the web client sends", () => {
    expect(parseResizeFrame({ resize: { cols: 120, rows: 30 } })).toEqual({ cols: 120, rows: 30 });
  });
  test("accepts the legacy array form [cols,rows]", () => {
    expect(parseResizeFrame({ resize: [80, 24] })).toEqual({ cols: 80, rows: 24 });
  });
  test("coerces numeric strings", () => {
    expect(parseResizeFrame({ resize: { cols: "100", rows: "25" } })).toEqual({ cols: 100, rows: 25 });
  });
  test("rejects an input frame", () => {
    expect(parseResizeFrame({ input: "ls\r" })).toBeNull();
  });
  test("rejects a malformed resize (missing rows / non-numeric)", () => {
    expect(parseResizeFrame({ resize: { cols: 80 } })).toBeNull();
    expect(parseResizeFrame({ resize: { cols: "x", rows: "y" } })).toBeNull();
    expect(parseResizeFrame({ resize: [80] })).toBeNull();
  });
  test("rejects non-object / empty frames", () => {
    expect(parseResizeFrame(null)).toBeNull();
    expect(parseResizeFrame("hi")).toBeNull();
    expect(parseResizeFrame({})).toBeNull();
  });
});

// Cross-platform PTY spawn: `script(1)` exists at the same path on Linux and
// macOS but takes INCOMPATIBLE arguments. The original code always used the
// util-linux form, so every macOS terminal died with "illegal option -- f".
describe("scriptArgsFor — util-linux vs BSD script(1)", () => {
  test("util-linux form passes the shell via -c and the file trailing", () => {
    expect(scriptArgsFor("/bin/bash", false)).toEqual(["-qfc", "/bin/bash", "/dev/null"]);
  });

  test("BSD form puts the file FIRST and the shell as a positional command", () => {
    // BSD usage: script [-aeFkpqr] [-t time] [file [command ...]]
    // There is no -c, and -f does not exist (it is -F).
    expect(scriptArgsFor("/bin/zsh", true)).toEqual(["-q", "/dev/null", "/bin/zsh"]);
  });

  test("neither form ever emits the -f flag BSD rejects", () => {
    for (const bsd of [true, false]) {
      const args = scriptArgsFor("/bin/sh", bsd);
      expect(args.some((a) => a === "-f" || a === "-qf")).toBe(false);
    }
  });
});

// Git in an interactive PTY pages through `less` and sits at a `:` prompt,
// swallowing the terminal. It also blocks forever on credential prompts and
// falls back to $EDITOR on a merge. None of those are recoverable by an agent.
describe("NON_INTERACTIVE_ENV — git cannot hang the terminal", () => {
  test("disables the pager on both the git-specific and generic vars", () => {
    expect(NON_INTERACTIVE_ENV.GIT_PAGER).toBe("cat");
    expect(NON_INTERACTIVE_ENV.PAGER).toBe("cat");
  });

  test("makes credential prompts fail fast instead of blocking", () => {
    // An agent can react to "authentication failed"; it cannot react to a
    // process sitting on a blocked read of stdin.
    expect(NON_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("neutralises the editor fallback", () => {
    expect(NON_INTERACTIVE_ENV.GIT_EDITOR).toBe("true");
    expect(NON_INTERACTIVE_ENV.EDITOR).toBe("true");
  });

  test("the PTY env applies it and a host PAGER cannot override it", () => {
    const prev = process.env.PAGER;
    process.env.PAGER = "less -R"; // hostile host setting
    try {
      const env = cleanEnvForTest();
      expect(env.PAGER).toBe("cat");
      expect(env.GIT_PAGER).toBe("cat");
      expect(env.TERM).toBe("xterm-256color"); // still a usable terminal
    } finally {
      if (prev === undefined) delete process.env.PAGER;
      else process.env.PAGER = prev;
    }
  });
});
