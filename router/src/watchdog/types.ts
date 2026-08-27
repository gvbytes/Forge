/** Shared watchdog types. */

export type StuckKind = "repeat-hash" | "period-2" | "error-spam";

export interface StuckSignal {
  kind: StuckKind;
  /** Human-readable evidence included in nudge/abort messages and traces. */
  detail: string;
}

/** Rate limits for permission-denial nudges. */
export interface DenyNudgeLimits {
  /** Minimum gap between two deny nudges for the same session. */
  cooldownMs: number;
  /** Hard cap of deny nudges per session, ever. */
  maxPerSession: number;
}

export const DEFAULT_DENY_NUDGE_LIMITS: DenyNudgeLimits = { cooldownMs: 2 * 60_000, maxPerSession: 5 };

/** Minimal telemetry surface the watchdog needs — satisfied by Telemetry. */
export interface WatchdogTelemetry {
  addTrace(t: {
    ts: number;
    task: string | null;
    kind: string;
    parent_id: number | null;
    label: string | null;
    detail_json: string | null;
  }): number;
  listActiveTasks(): Array<{
    id: string;
    created_ts: number;
    state: string;
    budget_usd: number;
    wall_deadline_s: number;
    spent_usd: number;
    started_ts: number | null;
  }>;
  listCalls(task?: string | null, limit?: number): Array<{ session: string | null; ts: number }>;
  sumCostByTask(taskId: string): number;
  /** B40: ts of the task's most recent attributed call (null if none). */
  lastCallTs(taskId: string): number | null;
  /** B40: move a task row out of 'active'. */
  setTaskState(id: string, state: string): void;
}
