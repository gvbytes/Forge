// Session store: one JSON file per session under DATA_DIR/projects/<projectId>/sessions.
// projectId = short hash of the workspace root → per-project isolation (req 5b).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Session, ProjectInfo } from "./types.js";
import { DATA_DIR, ensureDataDir } from "./config.js";

export function projectRoots(): Map<string, string> {
  // populated by index.ts when user opens a folder; persisted in projects.json
  const map = new Map<string, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "projects.json"), "utf8")) as ProjectInfo[];
    for (const p of raw) map.set(p.id, p.path);
  } catch {}
  return map;
}

export function projectIdFor(absPath: string): string {
  return crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 12);
}

export function registerProject(absPath: string): ProjectInfo {
  ensureDataDir();
  const id = projectIdFor(absPath);
  const info: ProjectInfo = { id, path: absPath, name: path.basename(absPath) };
  let list: ProjectInfo[] = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "projects.json"), "utf8"));
  } catch {}
  if (!list.find((p) => p.id === id)) list.push(info);
  atomicWriteJson(path.join(DATA_DIR, "projects.json"), list);
  return info;
}

function dirFor(projectId: string): string {
  return path.join(DATA_DIR, "projects", projectId, "sessions");
}

export function listSessions(projectId: string): Session[] {
  const dir = dirFor(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Session;
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => Boolean(s))
    .sort((a, b) => b.updatedAt - a.updatedAt) as Session[];
}

export function reconcileBootSessions(): void {
  const roots = projectRoots();
  for (const [pid] of roots) {
    for (const s of listSessions(pid)) {
      const t = s.task;
      if (!t) continue;
      // B11: any task caught mid-flight by a crash/restart is no longer live.
      // Mark it stopped (a terminal status the UI renders honestly) and — when
      // a persisted runState anchor exists — flag bootInterrupted so
      // POST /resume can pick the task back up exactly where it died instead
      // of leaving it stranded in a live-looking status forever.
      // waiting-approval is equally dead across the process boundary — its
      // gate's waiter lived in the old process (the boot approval reconcile
      // force-denies the orphaned pending). Without this the UI showed a
      // live-looking "waiting-approval" task whose approval was already
      // auto-denied — a half-zombie.
      if (
        t.status === "running" || t.status === "planning" || t.status === "reviewing" ||
        t.status === "waiting-approval"
      ) {
        t.status = "stopped";
        if (t.meta?.runState) t.meta = { ...t.meta, bootInterrupted: true };
        saveSession(s);
      }
    }
  }
}

export function getSession(projectId: string, sessionId: string): Session | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirFor(projectId), `${sessionId}.json`), "utf8")) as Session;
  } catch {
    return undefined;
  }
}

/**
 * Anti-resurrect tombstones: DELETE removes the session file while its task
 * may still be unwinding in the background, and that task's `finally` block
 * calls saveSession() — recreating a zombie session the user just deleted.
 * A tombstoned id is refused by saveSession until newSession() (fresh ids)
 * clears it. Deliberately NOT cleared by plain reads: re-reading a deleted
 * session must not re-arm resurrection.
 */
const deletedSessions = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  deletedSessions.add(sessionId);
}

export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessions.has(sessionId);
}

/** Atomic JSON persistence: temp file in the SAME directory + fsync + rename.
 *  A crash mid-write can no longer leave a truncated JSON file that readers
 *  (listSessions/getSession) then silently drop — the session used to look
 *  DELETED after an ill-timed crash. rename is atomic on POSIX, so readers
 *  always see either the complete old file or the complete new one. */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Windows fallback if target is briefly locked
    try { fs.unlinkSync(filePath); } catch {}
    fs.renameSync(tmp, filePath);
  }
}

export function saveSession(session: Session): Session {
  if (deletedSessions.has(session.id)) return session; // tombstoned → never rewrite
  session.updatedAt = Date.now();
  atomicWriteJson(path.join(dirFor(session.projectId), `${session.id}.json`), session);
  return session;
}

export function newSession(projectId: string, title?: string): Session {
  const now = Date.now();
  const s: Session = {
    id: crypto.randomUUID(),
    projectId,
    title: title ?? "New session",
    messages: [],
    contextRefs: [],
    compactions: [],
    createdAt: now,
    updatedAt: now,
  };
  // Fresh ids can't collide with a tombstone in practice; clearing keeps the
  // set bounded if an id were ever reused.
  deletedSessions.delete(s.id);
  return saveSession(s);
}
