/**
 * Watchdog assembly: SSE client -> stuck monitor -> engine actions,
 * plus the budget governor poll. Exported singleton consumed by src/index.ts:
 *
 *   GET  /watchdog/status                 active sessions, windows, interventions
 *   POST /watchdog/attach {engineUrl, directory}   begin watching
 */
import { Hono } from "hono";
import { WatchdogClient, type WatchdogCallbacks } from "./events";
import {
  DEFAULT_LIMITS,
  StuckMonitor,
  type InterventionResult,
  type StuckActions,
  type StuckLimits,
} from "./stuck";
import { BudgetGovernor, DEFAULT_POLL_INTERVAL_MS, telemetryBudgetSource } from "./budget";
import { denyNudgeMessage } from "./messages";
import { DEFAULT_DENY_NUDGE_LIMITS, type DenyNudgeLimits } from "./types";
import type { WatchdogTelemetry } from "./types";
import { getAttribution, type AttributionService, type ActivitySample } from "../attr";

export { canonicalJSON, argsHash } from "./events";

const NUDGE_TRACE = "watchdog.nudge";
const ABORT_TRACE = "watchdog.abort";
const DENY_NUDGE_TRACE = "watchdog.deny-nudge";

/** Per-session deny-nudge bookkeeping: last fire time and lifetime count. */
type DenyNudgeState = { lastAt: number; count: number };

export interface StartWatchdogOptions {
  engineUrl: string;
  directory?: string;
  /** Real router telemetry or a test fake (structural). */
  telemetry: WatchdogTelemetry;
  /** Override limits in tests; defaults: 3 min cooldown, cap 3. */
  limits?: Partial<StuckLimits>;
  /** Override deny-nudge limits in tests; defaults: 2 min, cap 5. */
  denyNudgeLimits?: Partial<DenyNudgeLimits>;
  budgetIntervalMs?: number;
  attribution?: AttributionService;
}

export interface WatchdogStatus {
  attached: boolean;
  /** B22: true only while the SSE stream is actively connected. False during
   * reconnect backoff after an engine restart / transient disconnect — so the
   * status no longer claims a live watch while the stream is down. */
  live: boolean;
  engineUrl: string | null;
  directory: string | null;
  sessions: ReturnType<StuckMonitor["statusSnapshot"]>;
  totals: StuckMonitor["totals"];
  budget: Array<{ task: string; mode: string }>;
  /** Total permission-denial nudges sent since attach. */
  denyNudges: number;
  /** Most recently active engine session. */
  lastActiveSession: ActivitySample | null;
}

export interface WatchdogHandle {
  status(): WatchdogStatus;
  stop(): void;
  readonly monitor: StuckMonitor;
  readonly governor: BudgetGovernor;
  /** Awaitable list of recent intervention results (test seam). */
  readonly recentInterventions: () => Promise<InterventionResult[]>;
}

let active: WatchdogHandle | null = null;

export function getWatchdog(): WatchdogHandle | null {
  return active;
}

export function startWatchdog(opts: StartWatchdogOptions): WatchdogHandle {
  if (active) active.stop();

  const engineBase = opts.engineUrl.replace(/\/+$/, "");
  const limits: StuckLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const interventions: InterventionResult[] = [];
  const attribution = opts.attribution ?? getAttribution();

  // Engine actions: nudge = POST /api/tasks/${taskId}/message, abort = POST /api/tasks/${taskId}/stop
  const actions: StuckActions = {
    async nudge(taskId, text) {
      opts.telemetry.addTrace({
        ts: Date.now(),
        task: null,
        kind: NUDGE_TRACE,
        parent_id: null,
        label: taskId,
        detail_json: JSON.stringify({ text, task: taskId }),
      });
      await fetch(`${engineBase}/api/tasks/${encodeURIComponent(taskId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, parts: [{ type: "text", text }] }),
      }).catch((e: unknown) => {
        console.warn(`[watchdog] nudge to ${taskId} failed:`, e instanceof Error ? e.message : String(e));
      });
    },
    async abort(taskId, reason) {
      opts.telemetry.addTrace({
        ts: Date.now(),
        task: null,
        kind: ABORT_TRACE,
        parent_id: null,
        label: taskId,
        detail_json: JSON.stringify({ reason, task: taskId }),
      });
      await fetch(`${engineBase}/api/tasks/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      }).catch((e: unknown) => {
        console.warn(`[watchdog] abort of ${taskId} failed:`, e instanceof Error ? e.message : String(e));
      });
    },
  };

  const monitor = new StuckMonitor(actions, limits);

  const denyLimits: DenyNudgeLimits = { ...DEFAULT_DENY_NUDGE_LIMITS, ...opts.denyNudgeLimits };
  const denyState = new Map<string, DenyNudgeState>();
  const lastAskAction = new Map<string, string>();
  let denyNudgeCount = 0;
  const DENY_STATE_CAP = 1000;

  const pruneDenyState = () => {
    while (denyState.size > DENY_STATE_CAP) {
      const oldest = denyState.keys().next().value;
      if (oldest === undefined) break;
      denyState.delete(oldest);
    }
    while (lastAskAction.size > DENY_STATE_CAP) {
      const oldest = lastAskAction.keys().next().value;
      if (oldest === undefined) break;
      lastAskAction.delete(oldest);
    }
  };

  const handlePermissionReplied = (e: { sessionID: string; reply: string; action?: string }) => {
    if (e.reply !== "reject") return;
    pruneDenyState();
    const state = denyState.get(e.sessionID) ?? { lastAt: 0, count: 0 };
    const now = Date.now();
    if (now - state.lastAt < denyLimits.cooldownMs) return;
    if (state.count >= denyLimits.maxPerSession) return;
    denyState.set(e.sessionID, { lastAt: now, count: state.count + 1 });
    denyNudgeCount += 1;
    opts.telemetry.addTrace({
      ts: now,
      task: null,
      kind: DENY_NUDGE_TRACE,
      parent_id: null,
      label: e.sessionID,
      detail_json: JSON.stringify({ action: e.action ?? null, session: e.sessionID }),
    });
    void actions.nudge(e.sessionID, denyNudgeMessage(e.action ?? lastAskAction.get(e.sessionID)));
  };

  const callbacks: WatchdogCallbacks = {
    onToolCall: (e) => {
      const signal = monitor.observeToolCall(e.sessionID, e.argsHash, e.errorOutput);
      if (signal) {
        void monitor
          .handle(e.sessionID, signal, e.tool)
          .then((r) => interventions.push(r))
          .catch(() => {});
      }
    },
    onError: (e) => {
      const signal = monitor.observeError(e.sessionID, e.message);
      if (signal) {
        void monitor
          .handle(e.sessionID, signal, "unknown")
          .then((r) => interventions.push(r))
          .catch(() => {});
      }
    },
    onIdle: () => {
      /* idle marks episode end; windows persist for status inspection */
    },
    onPermissionAsked: (e) => {
      if (e.action) lastAskAction.set(e.sessionID, e.action);
    },
    onPermissionReplied: handlePermissionReplied,
    onSessionActivity: (e) => {
      attribution.observe(e.sessionID, { directory: e.directory ?? null });
    },
  };

  const client = new WatchdogClient(callbacks, { directory: opts.directory });

  // B40: periodically prune stale per-session monitor state (bounded maps).
  const PRUNE_INTERVAL_MS = 5 * 60_000;
  const PRUNE_MAX_IDLE_MS = 60 * 60_000;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  const governor = new BudgetGovernor(
    telemetryBudgetSource(opts.telemetry),
    {
      sendMessage: (sessionId, text) => actions.nudge(sessionId, text),
      abortSession: (sessionId, reason) => actions.abort(sessionId, reason),
    },
    (row) => opts.telemetry.addTrace(row),
  );

  const handle: WatchdogHandle = {
    monitor,
    governor,
    recentInterventions: () => Promise.resolve([...interventions]),
    status(): WatchdogStatus {
      return {
        attached: client.connected,
        live: client.live,
        engineUrl: engineBase,
        directory: opts.directory ?? null,
        sessions: monitor.statusSnapshot(),
        totals: { ...monitor.totals },
        budget: governor.modeSnapshot(),
        denyNudges: denyNudgeCount,
        lastActiveSession: attribution.snapshot(),
      };
    },
    stop(): void {
      client.close();
      governor.stop();
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = null;
      if (active === handle) active = null;
    },
  };

  void client.connect(
    `${engineBase}/global/event`,
    opts.directory ? `${engineBase}/event?directory=${encodeURIComponent(opts.directory)}` : `${engineBase}/event`,
  );
  governor.start(opts.budgetIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  pruneTimer = setInterval(() => {
    monitor.pruneStale(PRUNE_MAX_IDLE_MS);
  }, PRUNE_INTERVAL_MS);
  active = handle;
  return handle;
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function readJsonObject(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function watchdogRoutes(deps: {
  telemetry: WatchdogTelemetry;
  attribution?: AttributionService;
}): Hono {
  const app = new Hono();

  app.get("/watchdog/status", (c) => {
    const wd = getWatchdog();
    if (!wd) {
      return c.json<WatchdogStatus>({
        attached: false,
        live: false,
        engineUrl: null,
        directory: null,
        sessions: [],
        totals: { signals: 0, nudges: 0, aborts: 0 },
        budget: [],
        denyNudges: 0,
        lastActiveSession: null,
      });
    }
    return c.json(wd.status());
  });

  app.post("/watchdog/attach", async (c) => {
    const body = await readJsonObject(c);
    const engineUrl = typeof body?.["engineUrl"] === "string" ? body["engineUrl"].trim() : "";
    const directory = typeof body?.["directory"] === "string" ? body["directory"].trim() : undefined;
    if (engineUrl.length === 0) {
      return c.json({ error: "engineUrl required" }, 400);
    }
    const wd = startWatchdog({ engineUrl, directory, telemetry: deps.telemetry, attribution: deps.attribution });
    return c.json(wd.status());
  });

  return app;
}
