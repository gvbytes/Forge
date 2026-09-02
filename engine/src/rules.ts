// AGENTS.md & Persistent Project Memory loader (Cursor / Antigravity style):
// Injected into every agent system prompt and preserved across compactions.
import fs from "node:fs";
import path from "node:path";
import { formatMemoryForPrompt } from "./memory.js";

const CANDIDATES = [".cursorrules", "AGENTS.md", "agents.md", ".engine/rules.md", ".agentzero/rules.md"];

export function loadProjectRules(projectRoot: string): { rules: string | null; source: string | null } {
  try {
    const memoryBlock = formatMemoryForPrompt(projectRoot);
    if (memoryBlock && memoryBlock.trim()) {
      return { rules: memoryBlock.slice(0, 24_000), source: ".agentzero/memory.json" };
    }
  } catch {
    /* fallback to file reading */
  }

  for (const name of CANDIDATES) {
    const p = path.join(projectRoot, name);
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        const raw = fs.readFileSync(p, "utf8");
        if (raw.trim()) return { rules: raw.slice(0, 16_000), source: name };
      }
    } catch {
      /* not present */
    }
  }
  return { rules: null, source: null };
}
