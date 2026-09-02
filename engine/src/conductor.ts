// ── Forge Conductor Module ────────────────────────────────────────────────
// Encapsulates the 4-role Conductor orchestration pattern from Forge IDE.
// Maps Forge's ConductorWorkflowStep pattern into Agent IDE's existing
// PlanStep infrastructure, providing:
//   - WorkerSpec pool with role→model/key resolution via router DB
//   - Conductor prompt builder for DAG decomposition
//   - Access-list scoped context assembly (Sakana Fugu isolation)
//   - StructuredCriticVerdict parser with heuristic fallback
//   - Action-loop hash guard to prevent token burnout
import crypto from "node:crypto";
import { log } from "./logger.js";

// ── Worker Specifications ─────────────────────────────────────────────────

export interface WorkerSpec {
  worker_id: string;
  role_key: string;  // maps to RouterRole: "planner" | "coder" | "reviewer" | "router"
  name: string;
  role: string;
  specialty: string;
  costPer1kIn: number;
  costPer1kOut: number;
}

/** All Forge workers mapped to Agent IDE's RouterRole system. */
export const WORKER_POOL: readonly WorkerSpec[] = [
  {
    worker_id: "conductor",
    role_key: "planner",
    name: "Lead Conductor / Architect",
    role: "Planner",
    specialty: "DAG decomposition, topology, access lists, goal analysis",
    costPer1kIn: 0.0003,
    costPer1kOut: 0.0005,
  },
  {
    worker_id: "lead_engineer",
    role_key: "coder",
    name: "Primary Code Engineer",
    role: "Coder",
    specialty: "Multi-file implementation, diff patches, live code streaming",
    costPer1kIn: 0.0003,
    costPer1kOut: 0.0005,
  },
  {
    worker_id: "adversarial_debugger",
    role_key: "reviewer",
    name: "Adversarial Critic & Verifier",
    role: "Critic",
    specialty: "Red-team verification, edge-case analysis, AST syntax audits",
    costPer1kIn: 0.0003,
    costPer1kOut: 0.0005,
  },
  {
    worker_id: "fast_tool_agent",
    role_key: "router",
    name: "Fast Scout / Router",
    role: "Router",
    specialty: "Intent classification, sub-second triage, isolated queries",
    costPer1kIn: 0.0001,
    costPer1kOut: 0.0002,
  },
  {
    worker_id: "synthesizer",
    role_key: "coder",
    name: "Consensus Synthesizer",
    role: "Synthesizer",
    specialty: "Merge multi-agent outputs into verified unified patches",
    costPer1kIn: 0.0003,
    costPer1kOut: 0.0005,
  },
] as const;

/**
 * Get a worker spec by worker_id.
 * Falls back to lead_engineer if the id is unknown.
 */
export function getWorker(workerId: string): WorkerSpec {
  return WORKER_POOL.find((w) => w.worker_id === workerId)
    ?? WORKER_POOL.find((w) => w.worker_id === "lead_engineer")!;
}

/**
 * Map a worker_id to the RouterRole the engine/router uses.
 * The critic maps to "reviewer" for compatibility with existing role pins.
 */
export function workerToRole(workerId: string): string {
  const w = getWorker(workerId);
  return w.role_key;
}

/**
 * Build the pool manifest string included in the conductor prompt
 * so the planner knows what workers are available and what they do.
 */
export function poolManifest(): string {
  const lines = WORKER_POOL.filter((w) => w.worker_id !== "conductor").map(
    (w) => `- worker_id="${w.worker_id}" (${w.name}): ${w.specialty}`
  );
  return "AVAILABLE WORKERS:\n" + lines.join("\n");
}

// ── Conductor Workflow Step ───────────────────────────────────────────────

export interface ConductorWorkflowStep {
  step_id: number;
  worker_id: string;
  subtask: string;
  access_list: number[];
  strategy: "sequential" | "adversarial_debate" | "parallel";
}

/**
 * Parse a conductor's JSON response into ConductorWorkflowStep[].
 * Handles markdown fences, partial JSON, and falls back to a safe
 * default 3-step plan on any parse failure.
 */
export function parseConductorPlan(content: string, userGoal: string): ConductorWorkflowStep[] {
  try {
    let cleaned = content.trim();
    // Strip markdown fences
    if (cleaned.includes("```json")) {
      cleaned = cleaned.split("```json")[1]!.split("```")[0]!.trim();
    } else if (cleaned.includes("```")) {
      cleaned = cleaned.split("```")[1]!.split("```")[0]!.trim();
    }
    const raw = JSON.parse(cleaned);
    const arr = Array.isArray(raw) ? raw : (raw?.steps ?? raw?.workflow ?? [raw]);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error("empty plan");

    return arr.map((item: Record<string, unknown>, i: number) => ({
      step_id: (item.step_id as number) ?? i + 1,
      worker_id: (item.worker_id as string) ?? "lead_engineer",
      subtask: (item.subtask as string) ?? `Step ${i + 1}`,
      access_list: Array.isArray(item.access_list) ? (item.access_list as number[]) : [],
      strategy: (["sequential", "adversarial_debate", "parallel"].includes(item.strategy as string)
        ? item.strategy : "sequential") as ConductorWorkflowStep["strategy"],
    }));
  } catch {
    // Fallback: safe 3-step plan
    return [
      { step_id: 1, worker_id: "lead_engineer", subtask: `Implement core changes for: ${userGoal}`, access_list: [], strategy: "sequential" },
      { step_id: 2, worker_id: "adversarial_debugger", subtask: "Review implementation for edge cases and regressions.", access_list: [1], strategy: "adversarial_debate" },
      { step_id: 3, worker_id: "synthesizer", subtask: "Apply fixes from review and verify final state.", access_list: [1, 2], strategy: "sequential" },
    ];
  }
}

// ── Access-List Scoped Context ────────────────────────────────────────────

/**
 * Build the scoped context for a step using its access_list.
 * Only includes outputs from explicitly listed prior steps,
 * preventing context collapse (Sakana Fugu isolation).
 */
export function buildScopedContext(
  step: ConductorWorkflowStep,
  stepOutputs: Map<number, { workerId: string; output: string }>,
): string {
  if (step.access_list.length === 0) return "";

  const sections: string[] = [];
  for (const priorId of step.access_list) {
    const prior = stepOutputs.get(priorId);
    if (prior) {
      sections.push(
        `=== Output from [${prior.workerId}] (Step ${priorId}) ===\n${prior.output}`
      );
    }
  }
  if (sections.length === 0) return "";
  return "\n=== Accessible Context from Prior Agents ===\n" + sections.join("\n\n") + "\n";
}

// ── Structured Critic Verdict ─────────────────────────────────────────────

export interface CriticVerdict {
  passed: boolean;
  reason: string;
  suggestedFixCategory: string;
}

/**
 * Parse a critic's response into a structured verdict.
 * Handles JSON responses, markdown-wrapped JSON, and falls back
 * to heuristic keyword analysis.
 */
export function parseCriticVerdict(text: string): CriticVerdict {
  try {
    // Try to extract JSON from the response
    let cleaned = text.trim();
    cleaned = cleaned.replace(/```json\s*|\s*```/g, "").trim();
    const match = cleaned.match(/\{[^{}]*"passed"[^{}]*\}/) ?? cleaned.match(/\{.*?\}/s);
    if (match) {
      const data = JSON.parse(match[0]);
      const passed = Boolean(data.passed ?? true);
      let reason = String(data.reason ?? "Verified").trim();
      // Sanity: if reason contains code or prompt regurgitation, replace with clean text
      if (/subtask:|code:|```|evaluate whether/i.test(reason)) {
        reason = passed
          ? "Code structure and logic verified."
          : "Logic defect identified during audit.";
      }
      return {
        passed,
        reason,
        suggestedFixCategory: String(data.suggested_fix_category ?? data.suggestedFixCategory ?? "none"),
      };
    }
  } catch { /* fall through to heuristic */ }

  // Heuristic fallback
  const failWords = ["reject", "failed", "error", "bug", "regression", "flaw", "issue", "vulnerability"];
  const passed = !failWords.some((w) => text.toLowerCase().includes(w));
  return {
    passed,
    reason: passed ? "Verification passed cleanly." : "Edge-case defect identified during audit.",
    suggestedFixCategory: passed ? "none" : "logic_error",
  };
}

// ── Action Loop Hash Guard ────────────────────────────────────────────────

const actionHashes = new Map<string, Map<string, number>>(); // taskId → hash → count
const ACTION_LOOP_LIMIT = 3;

/**
 * Track action hashes per task to detect infinite loops.
 * Returns true if the same action signature has been seen >= 3 times,
 * indicating the model is stuck in a loop.
 */
export function isActionLoop(taskId: string, stepId: number, actionType: string, errorSig: string): boolean {
  const hash = crypto.createHash("md5").update(`${stepId}:${actionType}:${errorSig}`).digest("hex");
  const taskHashes = actionHashes.get(taskId) ?? new Map<string, number>();
  const count = (taskHashes.get(hash) ?? 0) + 1;
  taskHashes.set(hash, count);
  actionHashes.set(taskId, taskHashes);

  if (count >= ACTION_LOOP_LIMIT) {
    log("warn", "conductor", `action loop detected: hash=${hash.slice(0, 8)} repeated ${count}x`, { taskId, stepId, actionType });
    return true;
  }
  return false;
}

/**
 * Clear action hashes for a task (on task completion/failure).
 */
export function clearActionHashes(taskId: string): void {
  actionHashes.delete(taskId);
}

// ── Worker System Prompt Builder ──────────────────────────────────────────

/**
 * Build the system prompt for a specific worker, including
 * its role description and project-specific AGENTS.md rules.
 */
export function buildWorkerSystemPrompt(worker: WorkerSpec, agentsMd: string): string {
  let prompt = `You are the '${worker.name}' (Role: ${worker.role}, Specialty: ${worker.specialty}).\n`
    + "You are working in an autonomous multi-agent engineering team.\n"
    + "Execute your assigned subtask rigorously. Produce clean, production-grade code or verified diff patches.";
  if (agentsMd) {
    prompt += `\n\nProject AGENTS.md Rules:\n${agentsMd}`;
  }
  return prompt;
}
