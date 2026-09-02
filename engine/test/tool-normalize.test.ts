// Regression suite for malformed tool calls from small models.
// Real-world captures: models emit "TOOLCALL:" (no underscore) and tool names
// without separators ("writefile", "listdir", "runcommand"). Previously the
// extractor required an exact "TOOL_CALL:" and normalizeTool had no alias for
// the separator-less names, so write_file never ran yet the step reported done.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { normalizeTool } from "../src/tools.js";
import { extractAllActions } from "../src/actions.js";

describe("normalizeTool — separator-less aliases", () => {
  test("writefile -> write_file", () => {
    expect(normalizeTool("writefile", { path: "a.txt", content: "x" }).name).toBe("write_file");
  });
  test("listdir -> list_dir", () => {
    expect(normalizeTool("listdir", { path: "." }).name).toBe("list_dir");
  });
  test("runcommand -> run_command", () => {
    expect(normalizeTool("runcommand", { cmd: "ls" }).name).toBe("run_command");
  });
  test("editfile -> edit_file", () => {
    expect(normalizeTool("editfile", { path: "a.txt" }).name).toBe("edit_file");
  });
  test("readfile -> read_file", () => {
    expect(normalizeTool("readfile", { path: "a.txt" }).name).toBe("read_file");
  });
  test("mixed-case WriteFile -> write_file", () => {
    expect(normalizeTool("WriteFile", { path: "a.txt" }).name).toBe("write_file");
  });
  test("existing alias still works: create_file -> write_file", () => {
    expect(normalizeTool("create_file", { target_file: "a.txt", code: "x" }).name).toBe("write_file");
  });
  test("canonical name passes through", () => {
    expect(normalizeTool("write_file", { path: "a.txt" }).name).toBe("write_file");
  });
  test("unknown tool stays unknown", () => {
    expect(normalizeTool("frobnicate", {}).name).toBe("frobnicate");
  });
});

describe("extractAllActions — TOOLCALL marker tolerance", () => {
  test("extracts 'TOOLCALL:' without underscore", () => {
    const calls = extractAllActions('TOOLCALL: {"name":"write_file","args":{"path":"index.html","content":"<html>"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("write_file");
    expect(calls[0]?.args.path).toBe("index.html");
  });
  test("extracts lowercase 'tool_call:'", () => {
    const calls = extractAllActions('tool_call: {"name":"list_dir","args":{"path":"."}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("list_dir");
  });
  test("still extracts standard 'TOOL_CALL:'", () => {
    const calls = extractAllActions('TOOL_CALL: {"name":"run_command","args":{"cmd":"ls"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("run_command");
  });
});
