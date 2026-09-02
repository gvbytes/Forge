/**
 * memory.ts — Persistent Project Memory & Rules Manager (Cursor / Antigravity style)
 *
 * Persists and loads structured memories across task sessions into:
 *   1. `<projectRoot>/.agentzero/memory.json` (Structured user preferences, architecture, learned conventions)
 *   2. `<projectRoot>/.cursorrules` or `<projectRoot>/AGENTS.md` (Project rule files)
 *
 * Formats memories into compact, high-signal system prompt sections that survive
 * context compaction events.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type MemoryCategory = "preference" | "convention" | "architecture" | "learned";

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  text: string;
  createdAt: number;
  source?: string;
  active?: boolean;
}

export interface ProjectMemory {
  version: number;
  projectName?: string;
  updatedAt: number;
  items: MemoryItem[];
}

const MEMORY_DIR = ".agentzero";
const MEMORY_FILE = "memory.json";
const RULE_FILES = [".cursorrules", "AGENTS.md", "agents.md", ".agentzero/rules.md"];

/** Returns default initial memory for a new project workspace. */
function defaultMemory(projectRoot: string): ProjectMemory {
  const projectName = path.basename(projectRoot);
  return {
    version: 1,
    projectName,
    updatedAt: Date.now(),
    items: [
      {
        id: "default-pref-1",
        category: "preference",
        text: "Keep code clean, modular, and well-typed. Prefer explicit error handling over silent failures.",
        createdAt: Date.now(),
        active: true,
      },
      {
        id: "default-pref-2",
        category: "convention",
        text: "Perform surgical line-level edits on existing files instead of rewriting from scratch.",
        createdAt: Date.now(),
        active: true,
      },
    ],
  };
}

/** Resolves path to .agentzero/memory.json in project root. */
export function getMemoryFilePath(projectRoot: string): string {
  return path.join(projectRoot, MEMORY_DIR, MEMORY_FILE);
}

/** Loads structured project memory, creating default if missing. */
export function loadProjectMemory(projectRoot: string): ProjectMemory {
  const filePath = getMemoryFilePath(projectRoot);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        return parsed as ProjectMemory;
      }
    }
  } catch {
    /* fallback to default on parse failure */
  }

  const initial = defaultMemory(projectRoot);
  saveProjectMemory(projectRoot, initial);
  return initial;
}

/** Atomically persists structured project memory to disk. */
export function saveProjectMemory(projectRoot: string, memory: ProjectMemory): void {
  try {
    const dirPath = path.join(projectRoot, MEMORY_DIR);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const filePath = getMemoryFilePath(projectRoot);
    const tempPath = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    memory.updatedAt = Date.now();
    fs.writeFileSync(tempPath, JSON.stringify(memory, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error("Failed to save project memory:", err);
  }
}

/** Appends a new memory item to the project memory store. */
export function addMemoryItem(
  projectRoot: string,
  category: MemoryCategory,
  text: string,
  source?: string
): MemoryItem {
  const mem = loadProjectMemory(projectRoot);
  const newItem: MemoryItem = {
    id: `mem-${crypto.randomUUID().slice(0, 8)}`,
    category,
    text: text.trim(),
    createdAt: Date.now(),
    source: source || "user",
    active: true,
  };
  mem.items.push(newItem);
  saveProjectMemory(projectRoot, mem);
  return newItem;
}

/** Toggles or updates an existing memory item. */
export function updateMemoryItem(
  projectRoot: string,
  id: string,
  updates: Partial<Omit<MemoryItem, "id" | "createdAt">>
): boolean {
  const mem = loadProjectMemory(projectRoot);
  const idx = mem.items.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  // findIndex already proved this exists; bind it so the type reflects that
  // (spreading the indexed access widened `id` to string | undefined).
  const existing = mem.items[idx]!;
  mem.items[idx] = { ...existing, ...updates };
  saveProjectMemory(projectRoot, mem);
  return true;
}

/** Deletes a memory item by ID. */
export function deleteMemoryItem(projectRoot: string, id: string): boolean {
  const mem = loadProjectMemory(projectRoot);
  const prevLen = mem.items.length;
  mem.items = mem.items.filter((item) => item.id !== id);
  if (mem.items.length !== prevLen) {
    saveProjectMemory(projectRoot, mem);
    return true;
  }
  return false;
}

/** Reads all file-based project rules (.cursorrules, AGENTS.md, etc.). */
export function loadFileRules(projectRoot: string): { content: string; file: string }[] {
  const rules: { content: string; file: string }[] = [];
  for (const name of RULE_FILES) {
    const full = path.join(projectRoot, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const text = fs.readFileSync(full, "utf8").trim();
        if (text) {
          rules.push({ content: text.slice(0, 16_000), file: name });
        }
      }
    } catch {
      /* ignore unreadable file */
    }
  }
  return rules;
}

/**
 * Formats active structured memories and rule files into a prompt block for system prompt injection.
 */
export function formatMemoryForPrompt(projectRoot: string): string {
  const mem = loadProjectMemory(projectRoot);
  const activeItems = (mem.items || []).filter((it) => it.active !== false);

  const categorized: Record<MemoryCategory, string[]> = {
    preference: [],
    convention: [],
    architecture: [],
    learned: [],
  };

  for (const it of activeItems) {
    if (categorized[it.category]) {
      categorized[it.category].push(`- ${it.text}`);
    }
  }

  const sections: string[] = [];

  if (categorized.preference.length) {
    sections.push(`[User Preferences]\n${categorized.preference.join("\n")}`);
  }
  if (categorized.convention.length) {
    sections.push(`[Project Conventions]\n${categorized.convention.join("\n")}`);
  }
  if (categorized.architecture.length) {
    sections.push(`[Architecture Facts]\n${categorized.architecture.join("\n")}`);
  }
  if (categorized.learned.length) {
    sections.push(`[Learned Project Lessons]\n${categorized.learned.join("\n")}`);
  }

  // Include .cursorrules and AGENTS.md if present
  const fileRules = loadFileRules(projectRoot);
  for (const r of fileRules) {
    sections.push(`[Rules from ${r.file}]\n${r.content}`);
  }

  if (!sections.length) return "";
  return `=== PERSISTENT PROJECT MEMORY & RULES (Cursor / Antigravity) ===\n${sections.join("\n\n")}\n=== END PERSISTENT MEMORY ===\n`;
}
