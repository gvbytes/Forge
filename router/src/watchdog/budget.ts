/**
 * Budget governor polling loop.
 *
 * Polls telemetry every 15s for active task rows:
 *   spent_usd = SUM(cost_usd) over that task's call rows (sumCostByTask),
 *   elapsed   = now − started_ts.
 * budgetMode() classifies each task; on TRANSITIONS:
 *   finalize -> POST a FINALIZE MODE message to the task's recent sessions;
 *   halt     -> abort those sessions + trace row kind="watchdog.halt".
 */
import { budgetMode, type BudgetMode } from "../policy/budget";
import { FINALIZE_MESSAGE } from "./messages";
import type { WatchdogTelemetry } from "./types";

export { FINALIZE_MESSAGE };

export interface BudgetTaskRow {
  id: string;
  spentUsd: number;
  startedTs: number | null;
  budgetUsd: number;
  wallDeadlineS: number;
}

export interface BudgetSource {
  activeTasks(): BudgetTaskRow[];
  sessionsForTask(taskId: string): string[];
  /** B40: ts of the task's most recent attributed call (null if never called). */
  lastActivityTs?(taskId: string): number | null;
  /** B40: move an idle task row out of 'active' so the governor stops policing it. */
  finalizeTask?(taskId: string, state: string): void;
}

export function telemetryBudgetSource(telemetry: WatchdogTelemetry): BudgetSource {
  return {
    activeTasks(): BudgetTaskRow[] {
      return telemetry
        .listActiveTasks()
        .filter((t) => t.state === "active")
        .map((t) => ({
          id: t.id,
          spentUsd: telemetry.sumCostByTask(t.id),
          startedTs: t.started_ts,
          budgetUsd: t.budget_usd,
          wallDeadlineS: t.wall_deadline_s,
        }));
    },
    sessionsForTask(taskId: string): string[] {
      const seen: string[] = [];
      for (const call of telemetry.listCalls(taskId, 200)) {
        if (call.session && !seen.includes(call.session)) seen.push(call.session);
        if (seen.length >= 5) break;
      }
      return seen;
    },
    lastActivityTs(taskId: string): number | null {
      return telemetry.lastCallTs(taskId);
    },
    finalizeTask(taskId: string, state: string): void {
      telemetry.setTaskState(taskId, state);
    },
  };
}

export interface BudgetActions {
  sendMessage(sessionId: string, text: string): Promise<void>;
  abortSession(sessionId: string, reason: string): Promise<void>;
}

export type TraceFn = (row: {
  ts: number;
  task: string | null;
  kind: string;
  parent_id: number | null;
  label: string | null;
  detail_json: string | null;
}) => number;

export interface TickResult {
  task: string;
  mode: BudgetMode;
  acted: boolean;
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** B40: a task with no attributed call for this long is finalized as 'idle' so the
 * wall-clock halt can't fire on an abandoned $0 session 45 min later. */
export const IDLE_FINALIZE_MS = 10 * 60_000;

export class BudgetGovernor {
  private readonly lastMode = new Map<string, BudgetMode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** B40: bound the lastMode map so it cannot grow without limit. */
  private static readonly MAX_TRACKED_TASKS = 1000;

  constructor(
    private readonly source: BudgetSource,
    private readonly actions: BudgetActions,
    private readonly trace: TraceFn,
  ) {}

  async tick(nowMs: number = Date.now()): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (const task of this.source.activeTasks()) {
      // B40: finalize idle tasks before budget classification — an idle task must
      // not be halted/finalized by the wall-clock governor.
      const lastAct = this.source.lastActivityTs?.(task.id) ?? null;
      const idleAnchor = lastAct ?? task.startedTs ?? nowMs;
      if (nowMs - idleAnchor >= IDLE_FINALIZE_MS) {
        this.source.finalizeTask?.(task.id, "idle");
        this.lastMode.delete(task.id);
        results.push({ task: task.id, mode: "normal", acted: false });
        continue;
      }

      const elapsedS = task.startedTs ? Math.max(0, (nowMs - task.startedTs) / 1000) : 0;
      const mode = budgetMode({
        spentUsd: task.spentUsd,
        elapsedS,
        budgetUsd: task.budgetUsd,
        wallS: task.wallDeadlineS,
      });
      const prev = this.lastMode.get(task.id) ?? "normal";
      let acted = false;

      if (mode !== prev && mode !== "normal") {
        const sessions = this.source.sessionsForTask(task.id);
        if (mode === "halt") {
          for (const sid of sessions) {
            await this.actions.abortSession(sid, `budget halt: task ${task.id} hit its cap`);
          }
          this.trace({
            ts: Date.now(),
            task: task.id,
            kind: "watchdog.halt",
            parent_id: null,
            label: `halted ${sessions.length} session(s)`,
            detail_json: JSON.stringify({
              spentUsd: task.spentUsd,
              budgetUsd: task.budgetUsd,
              elapsedS,
              sessions,
            }),
          });
          acted = true;
        } else if (mode === "finalize") {
          for (const sid of sessions) {
            await this.actions.sendMessage(sid, FINALIZE_MESSAGE);
          }
          this.trace({
            ts: Date.now(),
            task: task.id,
            kind: "watchdog.finalize",
            parent_id: null,
            label: `finalized ${sessions.length} session(s)`,
            detail_json: JSON.stringify({
              spentUsd: task.spentUsd,
              budgetUsd: task.budgetUsd,
              elapsedS,
              sessions,
            }),
          });
          acted = true;
        }
      }
      this.lastMode.set(task.id, mode);
      this.capLastMode();
      results.push({ task: task.id, mode, acted });
    }
    return results;
  }

  /** B40: evict the oldest entries once the map exceeds the cap (Map keeps
   * insertion order, so the first keys are the oldest). */
  private capLastMode(): void {
    if (this.lastMode.size <= BudgetGovernor.MAX_TRACKED_TASKS) return;
    const excess = this.lastMode.size - BudgetGovernor.MAX_TRACKED_TASKS;
    let n = 0;
    for (const key of this.lastMode.keys()) {
      if (n >= excess) break;
      this.lastMode.delete(key);
      n += 1;
    }
  }

  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(intervalMs, 250));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  modeSnapshot(): Array<{ task: string; mode: BudgetMode }> {
    return [...this.lastMode.entries()].map(([task, mode]) => ({ task, mode }));
  }
}
