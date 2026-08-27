/** Watchdog message templates (kept together so tests and actions agree). */

export const FINALIZE_MESSAGE =
  "FINALIZE MODE: wrap up current subtask, apply best-so-far changes, " +
  "run available tests, then summarize completed work and remaining gaps.";

/**
 * Sent once after the user rejects a permission ask: the engine ends
 * the turn silently on denial, so the watchdog nudges the agent to acknowledge
 * and adapt instead of leaving a dead turn.
 */
export const denyNudgeMessage = (tool?: string) =>
  tool
    ? `Your last ${tool} action was denied by the user. Briefly acknowledge the denial and propose/attempt an alternative approach — do not retry the identical action.`
    : "Your last action was denied by the user. Briefly acknowledge the denial and propose/attempt an alternative approach — do not retry the identical action.";
