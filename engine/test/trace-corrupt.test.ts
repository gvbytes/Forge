// loadTraces resilience: one corrupt/torn journal line must not discard the
// whole session's traces. The old implementation parsed every line in a single
// .map(JSON.parse), so ONE bad line threw and the outer catch returned [] for
// the entire session. Now each line is parsed independently and bad lines are
// skipped (mirrors eventStore.loadEvents torn-line handling).
import "./_env.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { loadTraces, currentEventId } from "../src/trace.js";

function writeJournal(sid: string, lines: string[]): void {
  const dir = path.join(DATA_DIR, "projects", sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "traces.jsonl"), lines.join("\n") + "\n");
}

describe("loadTraces corrupt-line resilience", () => {
  test("one corrupt line skips only that line, keeps the rest", () => {
    const sid = "corrupt-sess-1";
    writeJournal(sid, [
      JSON.stringify({ id: 1, sessionId: sid, type: "agent.start" }),
      '{"id":3,"broken":', // torn/corrupt line
      JSON.stringify({ id: 2, sessionId: sid, type: "agent.end" }),
    ]);
    const rows = loadTraces(sid) as unknown as { id: number }[];
    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe(1);
    expect(rows[1]?.id).toBe(2);
  });
  test("all-corrupt file returns [] (does not throw)", () => {
    const sid = "corrupt-sess-2";
    writeJournal(sid, ["not json", "{also broken"]);
    expect(loadTraces(sid)).toEqual([]);
  });
  test("missing file returns []", () => {
    expect(loadTraces("corrupt-sess-missing")).toEqual([]);
  });
});

describe("loadTraces torn-tail + BOM + id floor", () => {
  test("torn tail (no trailing newline) is truncated, complete lines kept", () => {
    const sid = "torn-sess-1";
    const dir = path.join(DATA_DIR, "projects", sid);
    fs.mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({ id: 10, sessionId: sid, type: "agent.start" });
    fs.writeFileSync(path.join(dir, "traces.jsonl"), good + "\n" + '{"id":11,"torn":');
    const rows = loadTraces(sid) as unknown as { id: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(10);
    const after = fs.readFileSync(path.join(dir, "traces.jsonl"), "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after).not.toContain('"torn"');
  });
  test("leading BOM is stripped, first line parses", () => {
    const sid = "bom-sess-1";
    const dir = path.join(DATA_DIR, "projects", sid);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ id: 20, sessionId: sid, type: "agent.start" });
    fs.writeFileSync(path.join(dir, "traces.jsonl"), "\uFEFF" + line + "\n");
    const rows = loadTraces(sid) as unknown as { id: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(20);
  });
  test("id floor advances past persisted ids (clock-skew guard)", () => {
    const sid = "floor-sess-1";
    writeJournal(sid, [JSON.stringify({ id: 999999999, sessionId: sid, type: "agent.start" })]);
    loadTraces(sid);
    expect(currentEventId() >= 999999999).toBe(true);
  });
});
