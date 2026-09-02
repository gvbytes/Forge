// ChangeProposal store: in-memory + persisted per session for post-crash review.
import fs from "node:fs";
import path from "node:path";
import { ChangeProposal } from "./types.js";
import { DATA_DIR } from "./config.js";

const mem = new Map<string, ChangeProposal>();

/** Session ids become directory names — strip anything that could traverse
 *  (`../`, separators, nulls). HTTP routes also validate `/^[\w-]+$/`; this is
 *  the second line of defense for internal callers. */
function safeId(sessionId: string): string {
  return sessionId.replace(/[^\w-]/g, "_");
}

function fileFor(sessionId: string): string {
  return path.join(DATA_DIR, "projects", safeId(sessionId), "proposals.json");
}

export function putProposal(p: ChangeProposal): void {
  mem.set(p.id, p);
  try {
    fs.mkdirSync(path.dirname(fileFor(p.sessionId)), { recursive: true });
    const all = listProposals(p.sessionId).filter((x) => x.id !== p.id);
    all.push(p);
    fs.writeFileSync(fileFor(p.sessionId), JSON.stringify(all, null, 2));
  } catch {
    /* persistence best-effort */
  }
}

export function getProposal(id: string): ChangeProposal | undefined {
  // Critique #13: memory dies with the process but proposals persist per
  // session dir — scan the disk FIRST so Apply works after a restart, then
  // fall back to the in-process map.
  try {
    const root = path.join(DATA_DIR, "projects");
    for (const dir of fs.readdirSync(root)) {
      try {
        const file = path.join(root, dir, "proposals.json");
        if (!fs.existsSync(file)) continue;
        const hit = (JSON.parse(fs.readFileSync(file, "utf8")) as ChangeProposal[]).find((p) => p.id === id);
        if (hit) return hit;
      } catch {
        /* unreadable session dir/file — keep scanning */
      }
    }
  } catch {
    /* projects dir missing/unreadable → memory fallback below */
  }
  return mem.get(id);
}

export function listProposals(sessionId: string): ChangeProposal[] {
  try {
    return JSON.parse(fs.readFileSync(fileFor(sessionId), "utf8")) as ChangeProposal[];
  } catch {
    return [...mem.values()].filter((p) => p.sessionId === sessionId);
  }
}

export function updateProposal(id: string, patch: Partial<ChangeProposal>): ChangeProposal | undefined {
  // getProposal is disk-first (critique #13), so a proposal that only exists
  // on disk after a restart still updates instead of silently returning void.
  const p = mem.get(id) ?? getProposal(id);
  if (!p) return undefined;
  const next = { ...p, ...patch };
  mem.set(id, next);
  putProposal(next);
  return next;
}

// ── Tool-gated path tracking (P2 misattribution fix) ────────────────────────
// tools.ts records which paths were materialized by HUMAN-approved gated
// write/edit calls; orchestrator.recordProposal consults this at step end and
// skips those paths so a human-approved edit isn't re-published inside the
// agent's batch "step" proposal. Shared here because both sides already
// import this module (a direct tools→orchestrator import would cycle).
const gatedApplied = new Map<string, Set<string>>(); // sessionId → rel paths

export function noteGatedAppliedPaths(sessionId: string, paths: string[]): void {
  if (!paths.length) return;
  const set = gatedApplied.get(sessionId) ?? new Set<string>();
  for (const p of paths) set.add(p);
  gatedApplied.set(sessionId, set);
}

export function gatedAppliedPaths(sessionId: string): Set<string> {
  return gatedApplied.get(sessionId) ?? new Set<string>();
}

/** Called when a new step begins: only coverage from THIS step hides paths. */
export function resetGatedAppliedPaths(sessionId: string): void {
  gatedApplied.delete(sessionId);
}
