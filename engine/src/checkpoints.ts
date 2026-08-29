// Checkpoint store — Antigravity-style revert base for optimistic execution.
//
// Every file mutation a task makes is captured HERE (pre-state content, or null
// when the file did not exist yet) so the whole task's footprint can be undone
// later: revert restores each captured file to its pre-task content and deletes
// files the task created. One checkpoint per task, persisted under
// DATA_DIR/projects/<projectId>/checkpoints/<taskId>.json so it survives task
// completion and engine restarts (the in-memory `snapshots` map in the
// orchestrator is diff-base only and is dropped when a task finishes).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export interface Checkpoint {
  /** Stable id — equals taskId (one checkpoint per task). */
  id: string;
  taskId: string;
  sessionId: string;
  projectId: string;
  /** Project root at capture time (revert resolves rel paths against it). */
  root: string;
  /** Human label — the task goal/title at capture time. */
  label: string;
  createdAt: number;
  updatedAt: number;
  /** relPath → pre-task content; null means the file did not exist yet. */
  files: Record<string, string | null>;
  reverted?: boolean;
  revertedAt?: number;
}

export interface RevertResult {
  restored: string[];
  removed: string[];
  skipped: string[];
}

function safeId(id: string): string {
  return id.replace(/[^\w-]/g, "_");
}

function dirFor(projectId: string): string {
  return path.join(DATA_DIR, "projects", safeId(projectId), "checkpoints");
}

function fileFor(projectId: string, taskId: string): string {
  return path.join(dirFor(projectId), `${safeId(taskId)}.json`);
}

export function getCheckpoint(projectId: string, taskId: string): Checkpoint | undefined {
  try {
    return JSON.parse(fs.readFileSync(fileFor(projectId, taskId), "utf8")) as Checkpoint;
  } catch {
    return undefined;
  }
}

/** Normalize a captured rel path and reject anything that could escape the
 *  project root. Returns "" for invalid inputs (caller skips). Defense-in-depth:
 *  the file tools already jail writes, but the rel comes raw from model args. */
function normalizeRel(rel: string): string {
  const n = path.normalize(String(rel ?? ""));
  if (!n || n === "." || n === "..") return "";
  if (path.isAbsolute(n)) return "";
  // Reject any ".." SEGMENT (after normalize, an escaping path leads with one),
  // but allow legit filenames that merely begin with dots (e.g. "..hidden.txt").
  if (n.split(path.sep).includes("..")) return "";
  return n;
}

/** Upsert one captured file into the task's checkpoint (first-capture-wins per
 *  path — the earliest pre-state in the task is the true revert base). */
export function recordCheckpointFile(opts: {
  projectId: string;
  taskId: string;
  sessionId: string;
  root: string;
  label: string;
  rel: string;
  preContent: string | null;
}): Checkpoint {
  const now = Date.now();
  const existing = getCheckpoint(opts.projectId, opts.taskId);
  const rel = normalizeRel(opts.rel);
  if (!rel) {
    // Escaping/absolute/empty path — never stored. Return the existing
    // checkpoint (or an unpersisted shell) so callers keep a valid shape.
    return existing ?? {
      id: opts.taskId, taskId: opts.taskId, sessionId: opts.sessionId,
      projectId: opts.projectId, root: opts.root, label: opts.label,
      createdAt: now, updatedAt: now, files: {},
    };
  }
  const cp: Checkpoint = existing ?? {
    id: opts.taskId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    root: opts.root,
    label: opts.label,
    createdAt: now,
    updatedAt: now,
    files: {},
  };
  if (!(rel in cp.files)) cp.files[rel] = opts.preContent;
  // A new capture after a revert supersedes it — clear the stale flag so the
  // DTO doesn't claim "reverted" while un-reverted files accumulate.
  if (cp.reverted) {
    cp.reverted = false;
    cp.revertedAt = undefined;
  }
  cp.updatedAt = now;
  fs.mkdirSync(dirFor(opts.projectId), { recursive: true });
  const target = fileFor(opts.projectId, opts.taskId);
  const tmp = `${target}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cp));
  fs.renameSync(tmp, target);
  return cp;
}

/** All checkpoints for a project, newest first. Corrupt files are skipped. */
export function listCheckpoints(projectId: string): Checkpoint[] {
  const dir = dirFor(projectId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Checkpoint[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as Checkpoint);
    } catch {
      // skip corrupt checkpoint files
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function inRoot(root: string, resolved: string): boolean {
  const r = path.resolve(root);
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return resolved === r || resolved.startsWith(prefix);
}

/** Symlink-aware containment check. `inRoot` is lexical only; a symlink inside
 *  root can point outside, and writeFileSync/rmSync would follow it. Walk up from
 *  the target to its DEEPEST EXISTING ancestor and resolve that, so a symlinked
 *  ancestor is caught even when the immediate parent dir doesn't exist yet
 *  (e.g. root/link -> /outside, target root/link/sub/file). Returns false on any
 *  resolution error. */
function realInRoot(root: string, resolved: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached filesystem root
      probe = parent;
    }
    if (!fs.existsSync(probe)) return true; // nothing exists anywhere; lexical check already passed
    const real = fs.realpathSync(probe);
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return real === realRoot || real.startsWith(prefix);
  } catch {
    return false;
  }
}

/** Undo a task's footprint: restore captured files to their pre-state, delete
 *  files the task created. Returns undefined when the checkpoint is missing.
 *  `rootOverride` lets the caller supply the live project root (the checkpoint
 *  also records its capture-time root as a fallback). */
export function revertCheckpoint(projectId: string, taskId: string, rootOverride?: string): RevertResult | undefined {
  const cp = getCheckpoint(projectId, taskId);
  if (!cp) return undefined;
  const root = rootOverride || cp.root;
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const [rel, pre] of Object.entries(cp.files)) {
    const resolved = path.resolve(root, rel);
    if (!inRoot(root, resolved) || !realInRoot(root, resolved)) {
      skipped.push(rel);
      continue;
    }
    try {
      if (pre === null) {
        // File was created by the task → remove it.
        if (fs.existsSync(resolved)) {
          fs.rmSync(resolved);
          removed.push(rel);
        } else {
          skipped.push(rel);
        }
      } else {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, pre);
        restored.push(rel);
      }
    } catch {
      skipped.push(rel);
    }
  }
  cp.reverted = true;
  cp.revertedAt = Date.now();
  try {
    const target = fileFor(projectId, taskId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort persistence of the reverted flag
  }
  return { restored, removed, skipped };
}
