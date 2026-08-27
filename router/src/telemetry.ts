/**
 * Telemetry: bun:sqlite persistence at router/data/router.db (WAL mode)
 * plus the /telemetry/* and /keys* HTTP API.
 *
 * Key values are stored for outbound auth only and are NEVER returned in full:
 * every read path goes through maskKey().
 */
import { Database } from "bun:sqlite";

/** Slots that name an agent role. Anything else is a general-purpose key. */
export const ROLE_SLOTS = new Set(["planner", "coder", "reviewer", "explorer", "summarizer", "router"]);
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_BUDGET_USD, DEFAULT_WALL_S } from "./policy/budget";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    task TEXT,
    session TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tier TEXT,
    reason TEXT,
    status TEXT NOT NULL,
    http INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost_usd REAL,
    latency_ms INTEGER,
    error TEXT,
    trace_id INTEGER,
    parent_id INTEGER
  )`,
  // NOTE: the budget/wall columns keep the eval HARD CEILINGS as their SQL
  // defaults, deliberately. They are the backstop, not the target — every row
  // is INSERTed with the score-optimal envelope explicitly (see
  // getOrCreateTask), so these defaults only ever apply to a row written by
  // some other path. Changing the constants in policy/budget.ts alone is NOT
  // enough: a NOT NULL DEFAULT here wins over the TS fallback, which is
  // exactly how the tightened envelope was silently inert for real tasks.
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    created_ts INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    budget_usd REAL NOT NULL DEFAULT 0.5,
    wall_deadline_s INTEGER NOT NULL DEFAULT 2700,
    spent_usd REAL NOT NULL DEFAULT 0,
    started_ts INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS keys (
    provider TEXT PRIMARY KEY,
    key TEXT NOT NULL
  )`,
  /**
   * Multiple keys per provider, addressed by SLOT.
   *
   * Free tiers meter per ACCOUNT, not per key, so the practical ceiling on a
   * free-tier agent is one account's rate limit shared by every role. Holding
   * several keys for the same provider and spreading roles across them
   * multiplies that ceiling — four NVIDIA NIM accounts give four times the
   * credits, and a rate-limited planner no longer starves the coder.
   *
   * `slot` is either an agent role ("planner", "coder", …) for a deliberate
   * pin, or "default" for keys that any role may draw on. The legacy single-key
   * `keys` table above is kept and still read, so an existing install keeps
   * working without a migration.
   */
  `CREATE TABLE IF NOT EXISTS provider_keys (
    provider TEXT NOT NULL,
    slot TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY (provider, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    task TEXT,
    kind TEXT NOT NULL,
    parent_id INTEGER,
    label TEXT,
    detail_json TEXT
  )`,
];

function ensureColumns(db: Database): void {
  const wanted: Array<{ column: string; decl: string }> = [
    { column: "trace_id", decl: "INTEGER" },
    { column: "parent_id", decl: "INTEGER" },
  ];
  const existing = () =>
    new Set(
      (db.query("PRAGMA table_info(calls)").all() as unknown as Array<{ name: string }>).map((r) => r.name),
    );
  let cols = existing();
  for (const w of wanted) {
    if (cols.has(w.column)) continue;
    try {
      db.exec(`ALTER TABLE calls ADD COLUMN ${w.column} ${w.decl}`);
    } catch (e) {
      // §5-20: do NOT fall back to `DROP TABLE calls` — that silently destroys the
      // entire call ledger on a migration hiccup. Fail loud so it gets investigated.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[telemetry] migration failed adding calls.${w.column}: ${msg} — refusing to drop call history`);
      throw new Error(`telemetry migration failed (calls.${w.column}): ${msg}`);
    }
    cols = existing();
  }
}

export interface CallInsert {
  ts: number;
  task: string | null;
  session: string | null;
  provider: string;
  model: string;
  tier: string | null;
  reason: string | null;
  status: "success" | "error" | "streaming" | "aborted";
  http: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  error: string | null;
  trace_id?: number | null;
  parent_id?: number | null;
}

export type CallRow = CallInsert & { id: number };

export interface TaskRow {
  id: string;
  created_ts: number;
  state: string;
  budget_usd: number;
  wall_deadline_s: number;
  spent_usd: number;
  started_ts: number | null;
}

export interface TaskSummary {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  errors: number;
}

export interface TraceInsert {
  ts: number;
  task: string | null;
  kind: string;
  parent_id: number | null;
  label: string | null;
  detail_json: string | null;
}

export interface TraceRow extends TraceInsert {
  id: number;
}

/** Mask a secret for any API response or log line. Never log the raw value. */
export function maskKey(key: string | null | undefined): string {
  if (!key) return "(not set)";
  // F5: first-3 + last-4 reveals most of a short secret (7 of 9 chars). Mask
  // fully below 16 chars.
  if (key.length < 16) return "***";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function defaultDbPath(): string {
  const override = process.env["ROUTER_DB"];
  if (override && override.trim().length > 0) return override;
  return join(import.meta.dir, "..", "data", "router.db");
}

interface RawTaskRow {
  id: string;
  created_ts: number;
  state: string;
  budget_usd: number;
  wall_deadline_s: number;
  spent_usd: number;
  started_ts: number | null;
}

interface RawSummaryRow {
  calls: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  errors: number;
}

function toTaskRow(row: RawTaskRow): TaskRow {
  return {
    id: row.id,
    created_ts: row.created_ts,
    state: row.state,
    budget_usd: row.budget_usd,
    wall_deadline_s: row.wall_deadline_s,
    spent_usd: row.spent_usd,
    started_ts: row.started_ts,
  };
}

export class Telemetry {
  private readonly db: Database;
  public readonly path: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt);
    ensureColumns(this.db);
  }

  ping(): boolean {
    try {
      const row = this.db.query("SELECT 1 AS ok").get() as { ok: number } | null;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  recordCall(row: CallInsert): number {
    const res = this.db
      .query(
        `INSERT INTO calls (ts, task, session, provider, model, tier, reason, status, http,
          prompt_tokens, completion_tokens, cost_usd, latency_ms, error, trace_id, parent_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .run(
        row.ts,
        row.task,
        row.session,
        row.provider,
        row.model,
        row.tier,
        row.reason,
        row.status,
        row.http,
        row.prompt_tokens,
        row.completion_tokens,
        row.cost_usd,
        row.latency_ms,
        row.error,
        row.trace_id ?? null,
        row.parent_id ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  completeStreamedCall(
    id: number,
    promptTokens: number | null,
    completionTokens: number | null,
    costUsd: number | null,
    status: "success" | "error" | "aborted",
    error?: string | null,
  ): void {
    this.db
      .query(
        `UPDATE calls SET prompt_tokens = ?2, completion_tokens = ?3, cost_usd = ?4,
         status = ?5, error = ?6 WHERE id = ?1`,
      )
      .run(id, promptTokens, completionTokens, costUsd, status, error ?? null);
  }

  listCalls(task?: string | null, limit = 100): CallRow[] {
    const lim = Math.min(Math.max(Math.round(limit) || 100, 1), 1000);
    if (task) {
      return this.db
        .query("SELECT * FROM calls WHERE task = ?1 ORDER BY id DESC LIMIT ?2")
        .all(task, lim) as unknown as CallRow[];
    }
    return this.db.query("SELECT * FROM calls ORDER BY id DESC LIMIT ?1").all(lim) as unknown as CallRow[];
  }

  /**
   * Create the task ledger row, stamping the SCORE-OPTIMAL budget envelope
   * explicitly rather than relying on the column defaults.
   *
   * The columns default to the evaluation HARD CEILINGS ($0.50 / 2700 s), and
   * a NOT NULL DEFAULT always wins over budgetMode()'s TS-side fallback — so
   * a row created without these values made the governor believe it had 10x
   * the budget and 300 s more wall clock than intended. Passing them here is
   * what actually makes DEFAULT_BUDGET_USD / DEFAULT_WALL_S take effect.
   */
  getOrCreateTask(id: string, nowMs = Date.now()): TaskRow {
    this.db
      .query(
        `INSERT INTO tasks (id, created_ts, state, started_ts, budget_usd, wall_deadline_s)
         VALUES (?1, ?2, 'active', ?2, ?3, ?4)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, nowMs, DEFAULT_BUDGET_USD, DEFAULT_WALL_S);
    return this.getTask(id) as TaskRow;
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?1").get(id) as unknown as RawTaskRow | null;
    return row ? toTaskRow(row) : null;
  }

  addSpent(taskId: string, deltaUsd: number): void {
    this.db
      .query("UPDATE tasks SET spent_usd = spent_usd + ?2 WHERE id = ?1")
      .run(taskId, deltaUsd);
  }

  taskSummary(taskId: string): TaskSummary {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(status = 'error'), 0) AS errors
         FROM calls WHERE task = ?1`,
      )
      .get(taskId) as unknown as RawSummaryRow | null;
    const r = row ?? { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, errors: 0 };
    return {
      calls: r.calls,
      prompt_tokens: r.prompt_tokens ?? 0,
      completion_tokens: r.completion_tokens ?? 0,
      cost_usd: r.cost_usd ?? 0,
      errors: r.errors,
    };
  }

  sumCostByTask(taskId: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM calls WHERE task = ?1")
      .get(taskId) as { total: number | null } | null;
    return row?.total ?? 0;
  }

  /** B40: timestamp of the task's most recent attributed call (null if none). */
  lastCallTs(taskId: string): number | null {
    const row = this.db
      .query("SELECT MAX(ts) AS last_ts FROM calls WHERE task = ?1")
      .get(taskId) as { last_ts: number | null } | null;
    return row?.last_ts ?? null;
  }

  /** B40: move a task row out of 'active' (e.g. to 'idle'/'done'). */
  setTaskState(id: string, state: string): void {
    this.db.query("UPDATE tasks SET state = ?2 WHERE id = ?1").run(id, state);
  }

  listActiveTasks(): TaskRow[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE state = 'active' ORDER BY created_ts ASC")
      .all() as unknown as RawTaskRow[];
    return rows.map(toTaskRow);
  }

  listTasks(limit = 500): TaskRow[] {
    const lim = Math.min(Math.max(Math.round(limit) || 500, 1), 5000);
    const rows = this.db
      .query("SELECT * FROM tasks ORDER BY created_ts DESC LIMIT ?1")
      .all(lim) as unknown as RawTaskRow[];
    return rows.map(toTaskRow);
  }

  setKey(provider: string, key: string): void {
    this.db
      .query(
        `INSERT INTO keys (provider, key) VALUES (?1, ?2)
         ON CONFLICT(provider) DO UPDATE SET key = excluded.key`,
      )
      .run(provider, key);
    this.keyCache.set(provider, key); // invalidate/refresh the P1 cache
    this.slotCache.delete(provider);  // listKeys folds in the legacy row
  }

  /** Wave 25 P1: getKey runs once per MODEL in planRoute's candidate loop
   *  (~18x per request) plus per proxy attempt — it used to be a raw SQLite
   *  SELECT each time. Keys change only via setKey (POST /keys), so an
   *  in-memory cache serves repeats; setKey keeps it fresh. `null` entries
   *  cache "provably absent" and are likewise invalidated by setKey. */
  private readonly keyCache = new Map<string, string | null>();

  /** Every key held for a provider, as [slot, key]. */
  /**
   * Slot cache for the hot path.
   *
   * getKeyForRole runs once per MODEL in planRoute's candidate loop plus once
   * per proxy attempt, so an uncached listKeys() meant two SQLite reads per
   * candidate. The single-key getKey() already had a cache for exactly this
   * reason; the multi-key path needs its own. Invalidated wholesale by
   * setKeySlot/deleteKeySlot, which are operator actions and rare.
   *
   * Measured at ~2.6µs uncached vs ~0.3µs cached — small in absolute terms
   * (0.03ms per request), but it is a hot loop that grows with the provider
   * count, and the comment on the original cache exists because someone
   * already paid for this lesson once.
   */
  private readonly slotCache = new Map<string, { slot: string; key: string }[]>();

  listKeys(provider: string): { slot: string; key: string }[] {
    const cached = this.slotCache.get(provider);
    if (cached) return cached;
    const rows = this.db
      .query("SELECT slot, key FROM provider_keys WHERE provider = ?1 ORDER BY slot")
      .all(provider) as { slot: string; key: string }[];
    const legacy = this.db.query("SELECT key FROM keys WHERE provider = ?1").get(provider) as { key: string } | null;
    if (legacy?.key && !rows.some((r) => r.slot === "default")) {
      rows.push({ slot: "default", key: legacy.key });
    }
    this.slotCache.set(provider, rows);
    return rows;
  }

  /** Every provider that has at least one key, with its slots (keys masked by the caller). */
  allKeySlots(): Record<string, string[]> {
    const rows = this.db.query("SELECT provider, slot FROM provider_keys ORDER BY provider, slot").all() as
      { provider: string; slot: string }[];
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.provider] ??= []).push(r.slot);
    for (const r of this.db.query("SELECT provider FROM keys").all() as { provider: string }[]) {
      if (!out[r.provider]?.includes("default")) (out[r.provider] ??= []).push("default");
    }
    return out;
  }

  setKeySlot(provider: string, slot: string, key: string): void {
    this.db
      .query(
        `INSERT INTO provider_keys (provider, slot, key) VALUES (?1, ?2, ?3)
         ON CONFLICT(provider, slot) DO UPDATE SET key = excluded.key`,
      )
      .run(provider, slot, key);
    this.keyCache.clear(); // slot set changed — invalidate the whole cache
    this.slotCache.clear();
  }

  deleteKeySlot(provider: string, slot: string): void {
    this.db.query("DELETE FROM provider_keys WHERE provider = ?1 AND slot = ?2").run(provider, slot);
    if (slot === "default") this.db.query("DELETE FROM keys WHERE provider = ?1").run(provider);
    this.keyCache.clear();
    this.slotCache.clear();
  }

  /** Round-robin cursor per provider, so unpinned roles spread across keys. */
  private readonly rrCursor = new Map<string, number>();

  /**
   * Resolve the key a given role should use.
   *
   *   1. a key pinned to that exact role  — deliberate, deterministic
   *   2. otherwise round-robin over the provider's remaining keys, so load
   *      spreads across accounts instead of hammering one
   *   3. otherwise the legacy single key
   *
   * Round-robin beats always-first because the point of holding several keys is
   * to raise the aggregate rate limit; always picking the first would leave the
   * others idle until the first one 429s.
   */
  getKeyForRole(provider: string, role?: string): string | null {
    const all = this.listKeys(provider);
    if (all.length === 0) return null;
    if (role) {
      const pinned = all.find((k) => k.slot === role);
      if (pinned) return pinned.key;
    }
    const pool = all.filter((k) => k.slot === "default" || !ROLE_SLOTS.has(k.slot));
    const usable = pool.length > 0 ? pool : all;
    const i = (this.rrCursor.get(provider) ?? 0) % usable.length;
    this.rrCursor.set(provider, i + 1);
    return usable[i]!.key;
  }

  /**
   * Every key for a provider, in the order they should be TRIED.
   *
   * getKeyForRole picks one key. That is right for load-spreading but wrong for
   * recovery: when the chosen key is rate-limited or revoked, the request fails
   * even though two perfectly good keys are sitting in the table. With a single
   * text provider there is no other provider to fall back to, so the keys ARE
   * the fallback chain and the proxy has to be able to walk it.
   *
   * Order: the role-pinned key first (an operator dedicating a key to a role
   * meant it), then the shared pool, then anything else. Round-robin still
   * decides where the shared pool starts, so load stays spread across accounts
   * rather than every request hammering the same key first.
   */
  listKeysForRole(provider: string, role?: string): string[] {
    const all = this.listKeys(provider);
    if (all.length === 0) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (k: string): void => { if (!seen.has(k)) { seen.add(k); out.push(k); } };

    if (role) {
      const pinned = all.find((k) => k.slot === role);
      if (pinned) push(pinned.key);
    }
    const pool = all.filter((k) => k.slot === "default" || !ROLE_SLOTS.has(k.slot));
    const usable = pool.length > 0 ? pool : all;
    const start = (this.rrCursor.get(provider) ?? 0) % usable.length;
    this.rrCursor.set(provider, start + 1);
    for (let i = 0; i < usable.length; i++) push(usable[(start + i) % usable.length]!.key);
    for (const k of all) push(k.key);
    return out;
  }

  getKey(provider: string): string | null {
    const hit = this.keyCache.get(provider);
    if (hit !== undefined) return hit;
    const row = this.db.query("SELECT key FROM keys WHERE provider = ?1").get(provider) as
      | { key: string }
      | null;
    const val = row?.key ?? null;
    this.keyCache.set(provider, val);
    return val;
  }

  listKeysMasked(): Array<{ provider: string; key: string }> {
    const rows = this.db.query("SELECT provider, key FROM keys ORDER BY provider").all() as unknown as Array<{
      provider: string;
      key: string;
    }>;
    return rows.map((r) => ({ provider: r.provider, key: maskKey(r.key) }));
  }

  keyProviders(): Record<string, { set: boolean; last4: string }> {
    const rows = this.db.query("SELECT provider, key FROM keys ORDER BY provider").all() as unknown as Array<{
      provider: string;
      key: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.provider, { set: true, last4: r.key.slice(-4) }]));
  }

  addTrace(t: TraceInsert): number {
    const res = this.db
      .query(
        `INSERT INTO traces (ts, task, kind, parent_id, label, detail_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .run(t.ts, t.task, t.kind, t.parent_id, t.label, t.detail_json);
    return Number(res.lastInsertRowid);
  }

  updateTraceLabel(id: number, label: string): void {
    this.db.query("UPDATE traces SET label = ?2 WHERE id = ?1").run(id, label);
  }

  listTraces(limit = 100): TraceRow[] {
    const lim = Math.min(Math.max(Math.round(limit) || 100, 1), 1000);
    return this.db.query("SELECT * FROM traces ORDER BY id DESC LIMIT ?1").all(lim) as unknown as TraceRow[];
  }

  listTracesByTask(task: string): TraceRow[] {
    return this.db
      .query("SELECT * FROM traces WHERE task = ?1 ORDER BY id ASC")
      .all(task) as unknown as TraceRow[];
  }

  listCallsByTaskAsc(task: string): CallRow[] {
    return this.db
      .query("SELECT * FROM calls WHERE task = ?1 ORDER BY id ASC")
      .all(task) as unknown as CallRow[];
  }

  traceTree(task: string): TraceTreeNode | null {
    const traces = this.listTracesByTask(task);
    const calls = this.listCallsByTaskAsc(task);
    const nodes = new Map<number, TraceTreeNode>();
    const roots: TraceTreeNode[] = [];
    for (const t of traces) {
      nodes.set(t.id, {
        id: t.id,
        kind: t.kind,
        label: t.label,
        detail: t.detail_json,
        children: [],
        calls: [],
      });
    }
    for (const t of traces) {
      const node = nodes.get(t.id)!;
      const parent = t.parent_id !== null && t.parent_id !== undefined ? nodes.get(t.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    for (const call of calls) {
      let host =
        call.trace_id !== null && call.trace_id !== undefined
          ? nodes.get(call.trace_id)
          : undefined;
      if (!host && call.parent_id !== null && call.parent_id !== undefined) {
        host = nodes.get(call.parent_id);
      }
      if (!host) host = roots[0];
      if (host) host.calls.push(call);
    }
    return {
      id: null,
      kind: "task",
      label: `task:${task}`,
      detail: null,
      children: roots,
      calls: [],
    };
  }
}

export interface TraceTreeNode {
  id: number | null;
  kind: string;
  label: string | null;
  detail: string | null;
  children: TraceTreeNode[];
  calls: CallRow[];
}

async function readJsonObject(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function telemetryRoutes(telemetry: Telemetry): Hono {
  const app = new Hono();

  app.get("/telemetry/calls", (c) => {
    const task = c.req.query("task") || null;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    return c.json({ calls: telemetry.listCalls(task, limit) });
  });

  app.get("/telemetry/task/:id", (c) => {
    const id = c.req.param("id");
    const task = telemetry.getTask(id);
    if (!task) return c.json({ error: "task_not_found" }, 404);
    return c.json({
      task,
      summary: telemetry.taskSummary(id),
      recent_calls: telemetry.listCalls(id, 50),
    });
  });

  app.get("/telemetry/tree", (c) => {
    const task = c.req.query("task") ?? "";
    if (task.length === 0) return c.json({ error: "task query param required" }, 400);
    return c.json({ task, tree: telemetry.traceTree(task) });
  });

  app.get("/telemetry/tasks", (c) => {
    return c.json({ tasks: telemetry.listTasks() });
  });

  app.post("/keys", async (c) => {
    const body = await readJsonObject(c);
    const provider = typeof body?.["provider"] === "string" ? body["provider"].trim() : "";
    // F3: strip control characters (CR/LF). A key with an interior line break makes
    // Bun's fetch throw `Header 'Authorization' has invalid value` on every request,
    // permanently breaking that provider with an opaque network error.
    const key = typeof body?.["key"] === "string" ? body["key"].replace(/[^\x20-\x7E]/g, "").trim() : "";
    if (provider.length === 0 || key.length === 0) {
      return c.json({ error: "provider and key required" }, 400);
    }
    // `slot` addresses one of several keys for the same provider: an agent
    // role name pins that role to this key, "default" is the shared pool.
    const rawSlot = typeof body?.["slot"] === "string" ? body["slot"].trim().toLowerCase() : "";
    const slot = rawSlot || "default";
    if (!/^[a-z0-9_-]{1,32}$/.test(slot)) {
      return c.json({ error: "slot must be a short alphanumeric label (role name or 'default')" }, 400);
    }
    telemetry.setKeySlot(provider, slot, key);
    // Keep the legacy single-key row in step so an older reader still resolves.
    if (slot === "default") telemetry.setKey(provider, key);
    return c.json({ provider, slot, key: maskKey(key) });
  });

  /** Remove one key slot. Deleting "default" also clears the legacy row. */
  app.delete("/keys/:provider/:slot", (c) => {
    const provider = c.req.param("provider");
    const slot = c.req.param("slot");
    telemetry.deleteKeySlot(provider, slot);
    return c.json({ provider, slot, deleted: true });
  });

  app.get("/keys", (c) => {
    // `slots` is the multi-key view: which roles each provider has pinned, and
    // how many keys it can spread load across. Keys are never returned in full.
    const slots: Record<string, { slot: string; last4: string }[]> = {};
    for (const provider of Object.keys(telemetry.allKeySlots())) {
      slots[provider] = telemetry.listKeys(provider).map((k) => ({
        slot: k.slot,
        last4: k.key.length >= 4 ? k.key.slice(-4) : "****",
      }));
    }
    return c.json({
      providers: telemetry.keyProviders(),
      keys: telemetry.listKeysMasked(),
      slots,
    });
  });

  return app;
}
