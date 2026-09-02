import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadProjectMemory,
  saveProjectMemory,
  addMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  formatMemoryForPrompt,
} from "../src/memory";

describe("Persistent Memory & Rules Engine (Cursor style)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentzero-mem-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("loads and creates default structured memory in .agentzero/memory.json", () => {
    const mem = loadProjectMemory(tmpDir);
    expect(mem.version).toBe(1);
    expect(mem.items.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(tmpDir, ".agentzero", "memory.json"))).toBe(true);
  });

  it("adds, updates, and deletes memory items cleanly", () => {
    const item = addMemoryItem(tmpDir, "architecture", "SQLite used for checkpoint storage");
    expect(/^mem-/.test(item.id)).toBe(true);
    expect(item.category).toBe("architecture");

    const updated = updateMemoryItem(tmpDir, item.id, { text: "SQLite v3 for checkpoints" });
    expect(updated).toBe(true);

    let mem = loadProjectMemory(tmpDir);
    const found = mem.items.find((x) => x.id === item.id);
    expect(found?.text).toBe("SQLite v3 for checkpoints");

    const deleted = deleteMemoryItem(tmpDir, item.id);
    expect(deleted).toBe(true);

    mem = loadProjectMemory(tmpDir);
    expect(mem.items.find((x) => x.id === item.id)).toBeUndefined();
  });

  it("formats structured memory and .cursorrules into clean prompt injection", () => {
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "Always format code with 2 spaces.");
    addMemoryItem(tmpDir, "preference", "Use functional React components with hooks");
    addMemoryItem(tmpDir, "learned", "Avoid cyclic imports in barrel files");

    const promptBlock = formatMemoryForPrompt(tmpDir);
    expect(promptBlock).toContain("PERSISTENT PROJECT MEMORY & RULES");
    expect(promptBlock).toContain("Always format code with 2 spaces.");
    expect(promptBlock).toContain("Use functional React components with hooks");
    expect(promptBlock).toContain("Avoid cyclic imports in barrel files");
  });
});
