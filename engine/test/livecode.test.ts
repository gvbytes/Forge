// livecode.ts — incremental decode of a write_file payload arriving token by
// token. The interesting cases are all boundary cases: a chunk that splits an
// escape sequence, a path that has not arrived yet, and the closing quote.
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { feed, newLiveCodeState, decodePartialJsonString } from "../src/livecode.js";

/** Replay `full` through feed() in fixed-size chunks, concatenating deltas. */
function replay(full: string, chunkSize: number): { text: string; path?: string; done: boolean } {
  const st = newLiveCodeState();
  let buf = "";
  let out = "";
  let path: string | undefined;
  let done = false;
  for (let i = 0; i < full.length; i += chunkSize) {
    buf += full.slice(i, i + chunkSize);
    const d = feed(buf, st);
    if (d) {
      out += d.delta;
      path = d.path;
      if (d.done) done = true;
    }
  }
  return { text: out, path, done };
}

describe("decodePartialJsonString", () => {
  test("decodes standard escapes", () => {
    const r = decodePartialJsonString(String.raw`line1\nline2\ttab\"quote\\slash"`);
    expect(r.closed).toBe(true);
    expect(r.text).toBe('line1\nline2\ttab"quote\\slash');
  });

  test("stops on a dangling backslash instead of emitting it literally", () => {
    // A chunk boundary landing between "\\" and "n" must NOT produce a stray
    // backslash in the user's file — the next chunk completes the escape.
    const r = decodePartialJsonString("abc\\");
    expect(r.text).toBe("abc");
    expect(r.closed).toBe(false);
  });

  test("stops on a partial \\uXXXX sequence", () => {
    expect(decodePartialJsonString("x\\u00").text).toBe("x");
    expect(decodePartialJsonString("x\\u0041").text).toBe("xA");
  });

  test("reports not-closed while the string is still open", () => {
    expect(decodePartialJsonString("half a file").closed).toBe(false);
  });
});

describe("feed() — live code extraction", () => {
  const payload =
    'TOOL_CALL: {"name":"write_file","args":{"path":"src/app.ts",' +
    '"content":"export function hi() {\\n  return \\"hello\\";\\n}\\n"}}';
  const expected = 'export function hi() {\n  return "hello";\n}\n';

  test("reconstructs the file exactly, at every chunk size", () => {
    // Chunk-size sweep is the real test: any off-by-one in the escape handling
    // shows up at one specific boundary and nowhere else.
    for (const size of [1, 2, 3, 5, 7, 11, 23, 64, 4096]) {
      const r = replay(payload, size);
      expect(r.text).toBe(expected);
      expect(r.path).toBe("src/app.ts");
      expect(r.done).toBe(true);
    }
  });

  test("emits nothing before the tool name is known", () => {
    const st = newLiveCodeState();
    expect(feed('TOOL_CALL: {"na', st)).toBeNull();
    expect(feed('TOOL_CALL: {"name":"write_file"', st)).toBeNull();
  });

  test("holds content back until the path has fully arrived", () => {
    const st = newLiveCodeState();
    // Content key present but path not yet closed — attributing code to an
    // unknown file would write it into the wrong editor tab.
    expect(feed('{"name":"write_file","args":{"path":"src/pa', st)).toBeNull();
    const d = feed('{"name":"write_file","args":{"path":"src/pay.ts","content":"ok', st);
    expect(d?.path).toBe("src/pay.ts");
    expect(d?.delta).toBe("ok");
  });

  test("never re-emits characters already sent", () => {
    const st = newLiveCodeState();
    const base = '{"name":"write_file","args":{"path":"a.ts","content":"';
    expect(feed(`${base}abc`, st)?.delta).toBe("abc");
    expect(feed(`${base}abc`, st)).toBeNull(); // no new bytes
    expect(feed(`${base}abcdef`, st)?.delta).toBe("def");
  });

  test("marks done exactly once and stops afterwards", () => {
    const st = newLiveCodeState();
    const full = '{"name":"write_file","args":{"path":"a.ts","content":"x"}}';
    expect(feed(full, st)?.done).toBe(true);
    expect(feed(`${full} trailing junk`, st)).toBeNull();
  });

  test("ignores non-write tool calls", () => {
    const st = newLiveCodeState();
    expect(feed('{"name":"read_file","args":{"path":"a.ts"}}', st)).toBeNull();
    expect(feed('{"name":"run_command","args":{"command":"ls"}}', st)).toBeNull();
  });

  test("supports edit_file via its newText argument", () => {
    const st = newLiveCodeState();
    const d = feed('{"name":"edit_file","args":{"path":"b.ts","newText":"patched"', st);
    expect(d?.path).toBe("b.ts");
    expect(d?.delta).toBe("patched");
  });

  test("accepts the target_file / file_path aliases small models emit", () => {
    for (const key of ["target_file", "file_path"]) {
      const st = newLiveCodeState();
      const d = feed(`{"name":"write_file","args":{"${key}":"c.ts","content":"z"`, st);
      expect(d?.path).toBe("c.ts");
    }
  });

  test("a unicode escape split across chunks decodes to one character", () => {
    const payload2 = '{"name":"write_file","args":{"path":"u.ts","content":"\\u00e9x"}}';
    for (const size of [1, 2, 3, 4, 5, 6]) {
      expect(replay(payload2, size).text).toBe("éx");
    }
  });
});
