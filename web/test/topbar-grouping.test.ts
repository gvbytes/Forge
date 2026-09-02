// Regression: the task select grouped rows via Object.entries(<Map>) — which
// returns [] (Maps have no own enumerable props) — rendering an EMPTY task
// select while the store had all tasks. groupTasksByFolder now returns plain
// pairs; this test pins that contract so it can never silently regress.
import { describe, expect, test } from "bun:test";

// jsdom-free: ui.ts touches window.localStorage at import time.
declare global {
  // eslint-disable-next-line no-var
  var localStorage: Storage;
  // eslint-disable-next-line no-var
  var window: unknown;
}
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
(globalThis as any).window = { localStorage: (globalThis as any).localStorage };

const { groupTasksByFolder } = await import("../src/components/TopBar");

describe("groupTasksByFolder (RC2 regression: Map/Object.entries)", () => {
  const rows = (projectName: string | undefined, projectRoot: string | undefined, id: string) =>
    ({ id, sessionId: id, title: id, goal: id, status: "done", projectName, projectRoot, projectId: "p1" }) as any;

  test("returns array pairs (NOT a Map) — iterable by plain .map()", () => {
    const out = groupTasksByFolder([rows("alpha", "/p/alpha", "t1"), rows("beta", "/p/beta", "t2")]);
    expect(Array.isArray(out)).toBe(true);
    // a Map would silently render zero groups via Object.entries
    expect(Object.entries(out).length).toBe(2);
    expect(out.map(([folder]) => folder)).toEqual(["alpha", "beta"]);
  });

  test("groups rows by projectName, falls back to basename of projectRoot, then 'unknown'", () => {
    const out = groupTasksByFolder([
      rows("alpha", "/p/a", "t1"),
      rows("alpha", "/p/a", "t2"),
      rows(undefined, "/p/justbasename", "t3"),
      rows(undefined, undefined, "t4"),
    ]);
    expect(out.length).toBe(3);
    expect(out[0][0]).toBe("alpha");
    expect(out[0][1].length).toBe(2);
    expect(out[1][0]).toBe("justbasename");
    expect(out[2][0]).toBe("unknown");
  });
});
