/**
 * Shared types for the routing policy module.
 *
 * Kept structural and dependency-free so router.ts can pass real
 * OpenAI-compatible request bodies straight in.
 */

/** Model tier. S/M/L per routing policy. */
export type Tier = "S" | "M" | "L";

export const TIERS: readonly Tier[] = ["S", "M", "L"];

/** Roles allowed to touch the L tier (planner/diagnostician only). */
export const L_ROLES: ReadonlySet<string> = new Set(["planner", "diagnostician"]);

export interface ChatMessage {
  role: string;
  /** OpenAI-compatible content: a plain string OR an array of typed parts
   * (e.g. `{type:"text", text:"…"}` items). classify() flattens both via
   * contentText(), so the wire type is deliberately `unknown`. */
  content: unknown;
}

/** Structural subset of an OpenAI-compatible /v1/chat/completions body. */
export interface ChatCompletionBody {
  messages: ChatMessage[];
  tools?: unknown[];
}

/** Per-request session context supplied by the router. */
export interface SessionCtx {
  /** Agent role for this request ("coder" assumed when omitted). */
  role?: string;
  /** Verification failures observed earlier in this session/task (>=1 => escalate). */
  historyFailures?: number;
  /** Size of the injected repo map in tokens (>40000 => +1). */
  repoMapTokens?: number;
}

/** Result of classify(): transparent, logged as x-engine-route reason. */
export interface Complexity {
  /** Additive signal score (0..6) — see classify.ts weight table. */
  score: number;
  tier: Tier;
  /** True when session history forces a one-tier escalation. */
  escalate: boolean;
  /** Human-readable reasons for every triggered signal and mapping step. */
  reasons: string[];
}

/** Watchdog ledger for one task (budget governor input). */
export interface TaskLedger {
  spentUsd: number;
  elapsedS: number;
  /** Default $0.5 per task. */
  budgetUsd?: number;
  /** Default 2700 s wall clock per task. */
  wallS?: number;
}
