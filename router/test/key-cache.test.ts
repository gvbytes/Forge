/**
 * Wave 25 router speed (P1): getKey is called once per MODEL in planRoute's
 * candidate loop (~18x per request) plus per-attempt in the proxy. It used to
 * be a raw SQLite SELECT every time. Now an in-memory cache serves repeats and
 * setKey invalidates it. These tests pin the invalidation contract.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "../src/telemetry";

const dir = mkdtempSync(join(tmpdir(), "agent-keycache-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("P1 key lookup cache", () => {
  test("getKey returns what setKey wrote (round-trip)", () => {
    const t = new Telemetry(join(dir, "a.db"));
    t.setKey("zen", "sk-secret-1");
    expect(t.getKey("zen")).toBe("sk-secret-1");
  });

  test("repeated getKey is stable across calls", () => {
    const t = new Telemetry(join(dir, "b.db"));
    t.setKey("zen", "sk-secret-2");
    expect(t.getKey("zen")).toBe("sk-secret-2");
    expect(t.getKey("zen")).toBe("sk-secret-2");
    expect(t.getKey("zen")).toBe("sk-secret-2");
  });

  test("setKey invalidates a cached value", () => {
    const t = new Telemetry(join(dir, "c.db"));
    t.setKey("zen", "sk-old");
    expect(t.getKey("zen")).toBe("sk-old"); // populates cache
    t.setKey("zen", "sk-new");
    expect(t.getKey("zen")).toBe("sk-new"); // cache must not serve stale
  });

  test("unknown provider returns null and stays null", () => {
    const t = new Telemetry(join(dir, "d.db"));
    expect(t.getKey("ghost")).toBeNull();
    expect(t.getKey("ghost")).toBeNull();
    t.setKey("ghost", "sk-late");
    expect(t.getKey("ghost")).toBe("sk-late"); // null cache entry invalidated
  });

  test("cache survives a re-open only via DB (fresh process = fresh cache)", () => {
    const dbPath = join(dir, "e.db");
    const t1 = new Telemetry(dbPath);
    t1.setKey("zen", "sk-persisted");
    const t2 = new Telemetry(dbPath); // fresh cache, must read through to DB
    expect(t2.getKey("zen")).toBe("sk-persisted");
  });
});
