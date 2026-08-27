/**
 * Session->task attribution.
 *
 * Engine requests can pass `x-session-id` on OpenAI-compatible calls for explicit
 * task attribution (feeding the budget governor and cascade).
 * If the explicit header is omitted, the router attributes calls to the most
 * recently active engine session reported by the watchdog listener (AttributionService).
 *
 * The attributed sessionID doubles as the task ledger key: on first use a
 * tasks row is upserted (started_ts = now) so BudgetGovernor sees live tasks
 * without an explicit x-engine-task header.
 */

export interface ActivitySample {
  sessionID: string;
  /** Watched directory the event arrived under (null when unscoped). */
  directory: string | null;
  ts: number;
}

/** §5-18: expire attribution samples after this much idle so a headerless request
 * long after the engine went quiet is NOT billed to a dead session. */
export const ATTRIBUTION_STALE_MS = 10 * 60_000;

export class AttributionService {
  /** Most recent activity sample per watched directory. */
  private readonly lastByDir = new Map<string, ActivitySample>();

  /**
   * @param staleAfterMs samples older than this (relative to the query time) are
   * ignored. Defaults to Infinity (no staleness) so unit tests with synthetic
   * timestamps keep working; production instances pass ATTRIBUTION_STALE_MS.
   */
  constructor(private readonly staleAfterMs: number = Number.POSITIVE_INFINITY) {}

  /**
   * Record session activity. Any event kind counts as "active" — callers pass
   * whatever they observed; only recency matters here.
   */
  observe(
    sessionID: string,
    opts: { directory?: string | null; now?: number } = {},
  ): void {
    if (!sessionID) return;
    const dir = opts.directory ?? null;
    // Keyed by directory ("(none)" = unscoped) so several attached engines
    // each keep their own lastActiveSession.
    this.lastByDir.set(dir ?? "(none)", { sessionID, directory: dir, ts: opts.now ?? Date.now() });
  }

  /**
   * Most recently active session across all attached directories (max ts).
   * Returns null before any event has been observed, and ignores samples that
   * have gone stale (§5-18).
   */
  mostRecent(nowMs = Date.now()): ActivitySample | null {
    let best: ActivitySample | null = null;
    for (const sample of this.lastByDir.values()) {
      if (nowMs - sample.ts > this.staleAfterMs) continue;
      if (!best || sample.ts > best.ts) best = sample;
    }
    return best;
  }

  /** Snapshot for /watchdog/status. */
  snapshot(): ActivitySample | null {
    return this.mostRecent();
  }

  /** Test hook. */
  reset(): void {
    this.lastByDir.clear();
  }
}

/**
 * Process-wide instance shared by the watchdog listener (writer) and the
 * proxy (reader). Both sides live in the same Bun process by design.
 */
let shared: AttributionService | null = null;

export function getAttribution(): AttributionService {
  if (!shared) shared = new AttributionService(ATTRIBUTION_STALE_MS);
  return shared;
}

/** Test hook: drop the shared instance (next getAttribution() makes a fresh one). */
export function resetAttribution(): void {
  shared = new AttributionService();
}
