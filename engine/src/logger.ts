// ── Native Agent Engine structured logger ─────────────────────────────────
// This module gives every component one call: log(level, component, message, data).
// Each entry goes to THREE places:
//   1. stderr   — pretty single line
//   2. DATA_DIR/logs/engine.log — strict JSON lines, rotated at 10 MB
//   3. in-memory ring (5000) — served live by GET /api/logs
// No dependencies; failures to persist must never break the caller.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const RING_CAP = 5000;
const ring: LogEntry[] = [];

const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "engine.log");
const ROTATE_BYTES = 10 * 1024 * 1024;
const ROTATE_KEEP = 3; // engine.log.1 .. .3

/** Cached file size so rotation doesn't stat() on every append. */
let fileSize = -1;

function rotateIfNeeded(): void {
  try {
    if (fileSize < 0) {
      fileSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    }
    if (fileSize < ROTATE_BYTES) return;
    // shift .2→.3, .1→.2, current→.1; drop the oldest beyond KEEP
    const old = path.join(LOG_DIR, `engine.log.${ROTATE_KEEP}`);
    if (fs.existsSync(old)) fs.rmSync(old);
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      const from = path.join(LOG_DIR, `engine.log.${i}`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(LOG_DIR, `engine.log.${i + 1}`));
    }
    fs.renameSync(LOG_FILE, path.join(LOG_DIR, "engine.log.1"));
    fileSize = 0;
  } catch {
    /* rotation is best-effort — never break the caller */
  }
}

function appendFileLine(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + "\n");
    fileSize += Buffer.byteLength(line) + 1;
  } catch {
    /* disk trouble must not take down the server */
  }
}

const two = (n: number): string => String(n).padStart(2, "0");
function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}Z`;
}

/** Compact single-line JSON for data payloads (undefined omitted entirely so
 *  log lines stay greppable). */
function dataJson(data: unknown): string {
  if (data === undefined) return "";
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return String(data); // circular / bigint — still one line
  }
}

export function log(level: LogLevel, component: string, message: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, component, message, ...(data !== undefined ? { data } : {}) };
  ring.push(entry);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);

  const dj = dataJson(entry.data);
  // stderr: pretty single line — time LEVEL [component] message {data}
  const sev = level.toUpperCase().padEnd(5);
  process.stderr.write(`${fmtTs(entry.ts)} ${sev} [${component}] ${message}${dj ? ` ${dj}` : ""}\n`);
  // file: strict JSON lines (machine-parseable, what /api/logs/file tails)
  appendFileLine(JSON.stringify({ ts: entry.ts, level, component, message, ...(dj ? { data: JSON.parse(dj) as unknown } : {}) }));
}

/** Component-curried helpers: logger.info("providers", "chat ok", {...}) or
 *  const l = logger.for("orchestrator"); l.warn("stuck", {...}). */
export const logger = {
  debug: (component: string, message: string, data?: unknown): void => log("debug", component, message, data),
  info: (component: string, message: string, data?: unknown): void => log("info", component, message, data),
  warn: (component: string, message: string, data?: unknown): void => log("warn", component, message, data),
  error: (component: string, message: string, data?: unknown): void => log("error", component, message, data),
  for: (component: string) => ({
    debug: (message: string, data?: unknown): void => log("debug", component, message, data),
    info: (message: string, data?: unknown): void => log("info", component, message, data),
    warn: (message: string, data?: unknown): void => log("warn", component, message, data),
    error: (message: string, data?: unknown): void => log("error", component, message, data),
  }),
};

/** Ring query. `level` is a MINIMUM severity (warn ⇒ warn+error) — the common
 *  diagnostic ask is "show me everything serious", not one exact level.
 *  `component` is a case-insensitive substring match. Newest last. */
export function getRecent(level?: LogLevel, component?: string, limit = 500): LogEntry[] {
  const min = level ? LEVEL_SEVERITY[level] : 0;
  const comp = component?.trim().toLowerCase();
  const out = ring.filter((e) =>
    LEVEL_SEVERITY[e.level] >= min && (!comp || e.component.toLowerCase().includes(comp)));
  return out.slice(-Math.max(1, Math.min(limit, RING_CAP)));
}

/** Tail the on-disk JSONL log (parsed entries newest-last). Reads across the
 *  active file only — rotated segments are for archaeology, not the API. */
export function tailLogFile(lines = 500): LogEntry[] {
  try {
    const n = Math.max(1, Math.min(lines, 5000));
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    const all = raw.split("\n").filter(Boolean);
    const out: LogEntry[] = [];
    for (const l of all.slice(-n)) {
      try { out.push(JSON.parse(l) as LogEntry); } catch { /* torn write — skip */ }
    }
    return out;
  } catch {
    return [];
  }
}
