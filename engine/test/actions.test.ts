// B13: TOOL_CALL salvage must never execute JSON that the model merely QUOTED
// mid-sentence in prose. Only explicit instruction shapes are actionable:
// TOOL_CALL: markers, XML/DSML tags, fenced ```json blocks, or JSON that
// starts at the beginning of a line.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { extractAllActions, parseAction } from "../src/actions.js";

describe("B13 salvage discipline", () => {
  test("mid-sentence quoted JSON in prose is NOT executed", () => {
    const text =
      'To call the tool you would write {"name": "write_file", "args": {"path": "x.ts"}} somewhere in your reply, but I will not do that now.';
    expect(extractAllActions(text)).toEqual([]);
    expect(parseAction(text)).toBeNull();
  });

  test("explaining the format with an inline example is NOT executed", () => {
    const text =
      'The schema looks like this: {"name": "run_command", "args": {"command": "rm -rf /"}} — never emit that mid-paragraph.';
    expect(extractAllActions(text)).toEqual([]);
  });

  test("fenced json block IS executed", () => {
    const text = '```json\n{"name": "read_file", "args": {"path": "a.ts"}}\n```';
    const acts = extractAllActions(text);
    expect(acts.length).toBe(1);
    expect(acts[0]!.name).toBe("read_file");
    expect(acts[0]!.args.path).toBe("a.ts");
  });

  test("line-start JSON block IS executed", () => {
    const text = 'Here is the call:\n{"name": "grep", "args": {"pattern": "foo"}}\nDone.';
    const acts = extractAllActions(text);
    expect(acts.length).toBe(1);
    expect(acts[0]!.name).toBe("grep");
  });

  test("TOOL_CALL: marker wins and is not duplicated by the raw-JSON resort", () => {
    const text = 'TOOL_CALL: {"name": "list_dir", "args": {"path": "."}}';
    const acts = extractAllActions(text);
    expect(acts.length).toBe(1);
    expect(acts[0]!.name).toBe("list_dir");
  });

  test("XML tool_call tag is parsed", () => {
    const text = '<tool_call>{"name": "glob", "args": {"pattern": "*.ts"}}</tool_call>';
    const acts = extractAllActions(text);
    expect(acts.length).toBe(1);
    expect(acts[0]!.name).toBe("glob");
  });

  test("JSON indented under a list item (not line-start) is NOT executed", () => {
    const text = 'Remember the shape:\n  - example: {"name": "edit_file", "args": {"path": "b.ts"}}';
    expect(extractAllActions(text)).toEqual([]);
  });

  test("plain prose without any JSON yields nothing", () => {
    expect(extractAllActions("I will now think about the problem.")).toEqual([]);
  });
});
