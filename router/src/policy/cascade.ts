/**
 * Outcome cascade — per-task state machine.
 *
 * Rules:
 * - startTier(role): planner/diagnostician start at L; every other role starts at S.
 * - onFailure(): escalate one tier for the next attempt (S->M->L).
 *   Repeated verified failures allow any role to escalate up to L.
 *   Resets any success streak and any active demotion.
 * - onSuccess(tier): two consecutive successes at the same tier T demote one
 *   tier below the current floor for the next subtask to save cost.
 *   A different tier in between breaks the streak; a failure clears it.
 *
 * Pure/deterministic: no clock, no I/O.
 */
import type { Tier } from "./types";
import { TIERS, L_ROLES } from "./types";

/** Max escalations above a role's start tier (S->M->L = 2 hops). */
const MAX_ESCALATIONS = TIERS.length - 1;
/** Consecutive same-tier successes required before trying to demote. */
export const DEMOTE_AFTER_SUCCESSES = 2;

/** Starting tier for a role: planner/diagnostician -> L, everyone else -> S. */
export function startTier(role: string): Tier {
  return L_ROLES.has(role) ? "L" : "S";
}

export class Cascade {
  readonly taskId: string;
  /**
   * Net escalation offset applied on top of startTier(lastRole). Stored
   * relative to the last role queried via currentFor() — cascades are
   * per-task, single-role in practice (defaults to "coder").
   */
  private escalations = 0;
  /** Role whose start tier `escalations` is relative to. */
  private lastRole = "coder";
  private streakTier: Tier | null = null;
  private streakCount = 0;
  /**
   * True while the live floor came from a success-streak demotion. The
   * router lets a demoted floor OVERRIDE the classifier's upward pressure
   * (final = cascadeFloor) because demotion exists to save cost; an escalated
   * floor instead raises the floor via max(classifyTier, cascadeFloor).
   */
  private demoteActive = false;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  private idxFor(role: string): number {
    const baseIdx = TIERS.indexOf(startTier(role));
    return Math.max(0, Math.min(baseIdx + this.escalations, MAX_ESCALATIONS));
  }

  /** Verification failure -> escalate one tier for the next attempt. */
  onFailure(): void {
    this.escalations = Math.min(this.escalations + 1, MAX_ESCALATIONS);
    this.streakTier = null;
    this.streakCount = 0;
    this.demoteActive = false;
  }

  /**
   * Verified success at `tier`. Two consecutive successes at the same tier
   * demote one tier below the *current* floor for the next subtask. Already
   * at the S floor => no-op: a clamped demotion must not consume the next
   * escalation nor fake a demotion. A different tier in between breaks the
   * streak; a failure clears it.
   */
  onSuccess(tier: Tier): void {
    if (this.streakTier === tier) {
      this.streakCount += 1;
    } else {
      this.streakTier = tier;
      this.streakCount = 1;
    }
    if (this.streakCount >= DEMOTE_AFTER_SUCCESSES) {
      const currentIdx = this.idxFor(this.lastRole);
      const targetIdx = Math.max(0, currentIdx - 1);
      if (targetIdx < currentIdx) this.demoteActive = true; // actually lowered
      this.escalations = targetIdx - TIERS.indexOf(startTier(this.lastRole));
      this.streakTier = null;
      this.streakCount = 0;
    }
  }

  /**
   * Tier the next request/subtask for `role` should use — the routing FLOOR.
   */
  currentFor(role: string): Tier {
    this.lastRole = role;
    return TIERS[this.idxFor(role)]!;
  }

  /**
   * True when the current floor was lowered by the demote-after-2-successes
   * rule (and not yet cleared by a failure).
   */
  get demoted(): boolean {
    return this.demoteActive;
  }
}
