/**
 * Budget governor — watchdog caps per task.
 *
 *   halt     : spent >= budgetUsd            OR elapsed >= wallS
 *   finalize : spent >= 0.8 * budgetUsd      OR elapsed >= wallS - 500 s
 *   normal   : anything below finalize thresholds
 *
 * TWO ENVELOPES, NOT ONE
 * ----------------------
 * These defaults are the SCORE-OPTIMAL envelope, deliberately far tighter than
 * the evaluation's hard ceilings ($0.50 / 2700 s, breaching either scores the
 * task A=0). Sizing the governor at the disqualification line was the original
 * mistake: under
 *     S = 10A / (1 + 0.65(C/0.15) + 0.35(T/1320))^2.5
 * a task at $0.35 already scores 0.72·A and one at $0.50 about 0.5·A. A run
 * that approaches the hard cap has ALREADY lost, halted or not — so the
 * governor must steer toward the envelope where the score is still worth
 * having, and the hard ceilings act only as a backstop.
 *
 *   $0.05 halt / $0.04 finalize  →  worst case ~4.5·A instead of ~0.5·A
 *   2400 s wall                  →  300 s of margin under the 2700 s ceiling,
 *                                   and agrees with the engine's TASK_MAX_MS
 *                                   (they previously disagreed: 2700 vs 2400)
 *
 * With the free-tier lock on (the default) spend stays at $0 and the cost arm
 * never fires at all; it exists for operators who deliberately enable paid
 * models. Thresholds scale proportionally for non-default budgets so the
 * governor keeps its shape under a custom cap. Halt is checked first: at the
 * caps the run must stop, not merely finalize. Boundaries are inclusive (>=).
 */
import type { TaskLedger } from "./types";

export type BudgetMode = "normal" | "finalize" | "halt";

/** Score-optimal spend envelope. NOT the eval ceiling — see HARD_CEILING_USD. */
export const DEFAULT_BUDGET_USD = 0.05;
/** Score-optimal wall envelope, 300 s under the eval ceiling. */
export const DEFAULT_WALL_S = 2400;

/**
 * The evaluation's hard limits. Breaching either scores the task A=0 outright,
 * independent of the cost penalty in the scoring formula. Recorded here so the
 * relationship between the two envelopes is explicit in one place.
 */
export const HARD_CEILING_USD = 0.5;
export const HARD_CEILING_WALL_S = 2700;
export const FINALIZE_SPENT_FRACTION = 0.8; // * $0.5 = $0.4
export const FINALIZE_TIME_SLACK_S = 500; // 2700 - 500 = 2200 s

/**
 * Currency epsilon for the inclusive (>=) boundary comparisons.
 *
 * FINALIZE_SPENT_FRACTION * budgetUsd is binary floating point: at the $0.05
 * envelope 0.8 * 0.05 evaluates to 0.04000000000000001, so a ledger sitting at
 * exactly $0.04 compared strictly-greater-or-equal and stayed "normal" — the
 * documented inclusive boundary silently did not fire. A hundredth of a cent is
 * far below any real price granularity, so it can never mask a genuine
 * threshold crossing.
 */
const USD_EPSILON = 1e-9;

export function budgetMode(task: TaskLedger): BudgetMode {
  const budgetUsd = task.budgetUsd ?? DEFAULT_BUDGET_USD;
  const wallS = task.wallS ?? DEFAULT_WALL_S;

  if (task.spentUsd >= budgetUsd - USD_EPSILON || task.elapsedS >= wallS) return "halt";
  if (
    task.spentUsd >= FINALIZE_SPENT_FRACTION * budgetUsd - USD_EPSILON ||
    task.elapsedS >= wallS - FINALIZE_TIME_SLACK_S
  ) {
    return "finalize";
  }
  return "normal";
}

/**
 * Conservative planning rate ($ per 1M tokens) used to convert remaining USD
 * into a token allowance for <=80B open-weight models on free/pay-go APIs.
 */
export const REFERENCE_USD_PER_MTOK = 50;

/** Remaining spend expressed in tokens at `usdPerMTok` (floored). */
export function tokenBudgetRemaining(
  task: TaskLedger,
  usdPerMTok: number = REFERENCE_USD_PER_MTOK,
): number {
  if (usdPerMTok <= 0) return 0;
  const budgetUsd = task.budgetUsd ?? DEFAULT_BUDGET_USD;
  const remainingUsd = Math.max(0, budgetUsd - task.spentUsd);
  return Math.floor((remainingUsd * 1_000_000) / usdPerMTok);
}
