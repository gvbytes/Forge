/**
 * Stuck detection — loop detection on engine SSE streams.
 *
 * Per session, a sliding window (12 entries) of tool-call argsHashes fires a
 * stuck signal when:
 *   - any hash repeats >=3 times inside the window (loop), OR
 *   - the trailing four hashes form an alternating A,B,A,B period-2 loop,
 * and separately, 6 consecutive byte-identical error outputs fire an
 * error-spam signal.
 *
 * Response chain per stuck signal, configurable via StuckLimits:
 *   ["nudge","abort"] — first intervention nudges the session, later ones
 * abort. Cooldown: max 1 nudge / 3 min per session. Max 3 total interventions
 * per session-task; beyond that, abort-only.
 */
import type { StuckSignal } from "./types";

export const WINDOW_SIZE = 12;
export const REPEAT_THRESHOLD = 3; // ">=3 times within window"
export const ERROR_SPAM_THRESHOLD = 6; // consecutive identical error outputs
/** Period-2 loops need at least two full A,B cycles visible. */
export const PERIOD2_MIN_WINDOW = 4;

export class SessionWindow {
  private readonly hashes: string[] = [];
  private lastError: string | null = null;
  private errorStreak = 0;

  get size(): number {
    return this.hashes.length;
  }

  get errorStreakLength(): number {
    return this.errorStreak;
  }

  /** Push one tool-call hash; returns a stuck signal or null. */
  push(hash: string): StuckSignal | null {
    this.hashes.push(hash);
    if (this.hashes.length > WINDOW_SIZE) this.hashes.shift();

    // Loop: any hash appearing >= REPEAT_THRESHOLD times in the window.
    const counts = new Map<string, number>();
    for (const h of this.hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [h, n] of counts) {
      if (n >= REPEAT_THRESHOLD) {
        return {
          kind: "repeat-hash",
          detail: `identical call x${n} in last ${this.hashes.length} (hash ${h.slice(0, 8)})`,
        };
      }
    }

    // Alternating A,B,A,B (period-2) over the trailing window.
    const n = this.hashes.length;
    if (n >= PERIOD2_MIN_WINDOW) {
      const a = this.hashes[n - 4]!;
      const b = this.hashes[n - 3]!;
      const c = this.hashes[n - 2]!;
      const d = this.hashes[n - 1]!;
      if (a === c && b === d && a !== b) {
        return { kind: "period-2", detail: `alternating loop ${a.slice(0, 6)}<->${b.slice(0, 6)}` };
      }
    }
    return null;
  }

  /** Track consecutive byte-identical error outputs; fires at threshold. */
  recordError(output: string): StuckSignal | null {
    if (output === this.lastError) {
      this.errorStreak += 1;
    } else {
      this.lastError = output;
      this.errorStreak = 1;
    }
    if (this.errorStreak >= ERROR_SPAM_THRESHOLD) {
      return {
        kind: "error-spam",
        detail: `${this.errorStreak} identical errors in a row: "${output.slice(0, 80)}"`,
      };
    }
    return null;
  }

  /** A non-error tool result breaks an error spam streak. */
  recordHealthyCall(): void {
    this.errorStreak = 0;
  }
}

// ---------------------------------------------------------------------------
// Intervention state machine
// ---------------------------------------------------------------------------

export interface StuckLimits {
  /** Min gap between nudges for one session. Default: 1 / 3 min. */
  nudgeCooldownMs: number;
  /** Total interventions (nudges + aborts) before abort-only mode. Default: 3. */
  maxInterventionsPerTask: number;
  /** Action chain walked as detections repeat. */
  actionChain: readonly ("nudge" | "abort")[];
}

export const DEFAULT_LIMITS: StuckLimits = {
  nudgeCooldownMs: 180_000,
  maxInterventionsPerTask: 3,
  actionChain: ["nudge", "abort"],
};

export interface StuckActions {
  nudge(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string, reason: string): Promise<void>;
}

export type InterventionAction = "nudge" | "abort" | "skip-cooldown";

export const NUDGE_PREFIX = "Watchdog:";

export function nudgeText(tool: string, times: number): string {
  return `${NUDGE_PREFIX} you repeated ${tool} ${times} times with same result. Change approach or report blocker.`;
}

export interface InterventionResult {
  sessionId: string;
  signal: StuckSignal;
  action: InterventionAction;
}

export class StuckMonitor {
  private readonly windows = new Map<string, SessionWindow>();
  private readonly interventions = new Map<string, number>();
  private readonly lastActionTs = new Map<string, number>();
  /** B40: last time each session produced any observable activity. */
  private readonly lastSeen = new Map<string, number>();
  /** Aggregate counters surfaced by GET /watchdog/status. */
  readonly totals = { signals: 0, nudges: 0, aborts: 0 };

  constructor(
    private readonly actions: StuckActions,
    private readonly limits: StuckLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  statusSnapshot(): Array<{
    sessionId: string;
    windowSize: number;
    interventions: number;
    msSinceLastAction: number | null;
  }> {
    const t = this.now();
    return [...this.windows.entries()].map(([sessionId, w]) => ({
      sessionId,
      windowSize: w.size,
      interventions: this.interventions.get(sessionId) ?? 0,
      msSinceLastAction: this.lastActionTs.has(sessionId)
        ? t - (this.lastActionTs.get(sessionId) ?? 0)
        : null,
    }));
  }

  observeToolCall(sessionId: string, argsHash: string, errorOutput?: string): StuckSignal | null {
    const w = this.windowFor(sessionId);
    let spam: StuckSignal | null = null;
    if (errorOutput === undefined || errorOutput === "") {
      w.recordHealthyCall();
    } else {
      spam = w.recordError(errorOutput);
    }
    return w.push(argsHash) ?? spam;
  }

  observeError(sessionId: string, message: string): StuckSignal | null {
    return this.windowFor(sessionId).recordError(message);
  }

  async handle(sessionId: string, signal: StuckSignal, tool: string): Promise<InterventionResult> {
    this.totals.signals += 1;
    const done = this.interventions.get(sessionId) ?? 0;

    const last = this.lastActionTs.get(sessionId);
    if (last !== undefined && this.now() - last < this.limits.nudgeCooldownMs) {
      return { sessionId, signal, action: "skip-cooldown" };
    }

    const abortOnly = done >= this.limits.maxInterventionsPerTask;
    const action: "nudge" | "abort" = abortOnly
      ? "abort"
      : this.limits.actionChain[Math.min(done, this.limits.actionChain.length - 1)]!;

    this.lastActionTs.set(sessionId, this.now());
    this.interventions.set(sessionId, done + 1);

    if (action === "nudge") {
      this.totals.nudges += 1;
      await this.actions.nudge(sessionId, nudgeText(tool, timesFor(signal)));
      return { sessionId, signal, action: "nudge" };
    }

    this.totals.aborts += 1;
    await this.actions.abort(sessionId, `watchdog stuck: ${signal.kind} — ${signal.detail}`);
    return { sessionId, signal, action: "abort" };
  }

  private windowFor(sessionId: string): SessionWindow {
    this.lastSeen.set(sessionId, this.now());
    let w = this.windows.get(sessionId);
    if (!w) {
      w = new SessionWindow();
      this.windows.set(sessionId, w);
    }
    return w;
  }

  /** B40: drop per-session state that has been inactive longer than maxIdleMs so
   * the windows/interventions/lastActionTs/lastSeen maps cannot grow without bound.
   * Returns the number of sessions pruned. */
  pruneStale(maxIdleMs: number): number {
    const t = this.now();
    let pruned = 0;
    for (const [sessionId, seen] of [...this.lastSeen.entries()]) {
      if (t - seen < maxIdleMs) continue;
      this.windows.delete(sessionId);
      this.interventions.delete(sessionId);
      this.lastActionTs.delete(sessionId);
      this.lastSeen.delete(sessionId);
      pruned += 1;
    }
    return pruned;
  }
}

function timesFor(signal: StuckSignal): number {
  const m = /[x×](\d+)/.exec(signal.detail);
  if (m) return Number.parseInt(m[1]!, 10);
  if (signal.kind === "period-2") return 2;
  const streak = /^(\d+) identical/.exec(signal.detail);
  if (streak) return Number.parseInt(streak[1]!, 10);
  return REPEAT_THRESHOLD;
}
