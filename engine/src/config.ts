import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppSettings, ProviderSettings } from "./types.js";

export const DATA_DIR =
  process.env.ENGINE_DATA ??
  process.env.AGENTZERO_DATA ??
  path.join(os.homedir(), ".agent-engine");

export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "projects"), { recursive: true });
}

export const DEFAULT_ROUTER_BASE =
  process.env.ENGINE_ROUTER_BASE ??
  process.env.ROUTER_URL ??
  process.env.AGENTZERO_ZEN_BASE ??
  "http://127.0.0.1:4098/v1";

/** True when DEFAULT_ROUTER_BASE came from an explicit env override (dev.sh sets
 *  ENGINE_ROUTER_BASE), not the bare :4098 fallback. Reconciling a stale
 *  persisted router baseUrl is only safe in that case: with the bare fallback the
 *  persisted URL may itself be the correct live router, and rewriting it to :4098
 *  would create the exact dead-URL bug the reconciliation is meant to cure. */
export const ROUTER_BASE_EXPLICIT = Boolean(
  process.env.ENGINE_ROUTER_BASE ?? process.env.ROUTER_URL ?? process.env.AGENTZERO_ZEN_BASE,
);

export const DEFAULT_MODELS = [
  { key: "engine-small", provider_id: "engine-router", id: "openai/gpt-oss-20b", params_b: 20, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "tiny" as const, notes: "Fast S-tier triage / explorer (≤80B)" },
  { key: "engine-coder", provider_id: "engine-router", id: "nvidia/nemotron-3.5-lightning-30b-a3b", params_b: 30, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "mid" as const, notes: "Coder M-tier structured tool use (≤80B)" },
  { key: "engine-reviewer", provider_id: "engine-router", id: "meta/muse-glimmer-30b", params_b: 30, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "mid" as const, notes: "Reviewer M-tier independent audit (≤80B)" },
  { key: "engine-large", provider_id: "engine-router", id: "google/gemma-4-31b-it", params_b: 31, ctx_window: 262144, cost_in: 0, cost_out: 0, tier: "large" as const, notes: "Planner L-tier deep reasoning (≤80B)" },
  { key: "engine-vision", provider_id: "engine-router", id: "meta/llama-3.2-11b-vision-instruct", params_b: 11, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "tiny" as const, notes: "Vision multimodal QA (≤80B)" },
];

export const DEFAULT_SETTINGS: any = {
  providers: [
    {
      id: "engine-router",
      name: "Local Router",
      base_url: DEFAULT_ROUTER_BASE,
      baseUrl: DEFAULT_ROUTER_BASE,
      api_key: "sk-engine-key",
      apiKey: "sk-engine-key",
      kind: "openai-compatible",
      enabled: true,
    },
  ],
  models: DEFAULT_MODELS,
  routing: {
    ctx_trigger_frac: 0.7,
    complexity_tiny_max: 0.25,
    complexity_mid_max: 0.65,
    min_health: 0.5,
  },
  budgets: {
    max_cost_usd: 0.50,
    max_wall_s: 2700,
    max_steps: 40,
    max_llm_calls: 80,
    max_parallel_subagents: 3,
  },
  approvals: {
    mode: "gate" as const,
  },
  selectedModels: {
    planner: "google/gemma-4-31b-it",
    coder: "nvidia/nemotron-3.5-lightning-30b-a3b",
    reviewer: "meta/muse-glimmer-30b",
    explorer: "openai/gpt-oss-20b",
    summarizer: "openai/gpt-oss-20b",
    router: "openai/gpt-oss-20b",
  },
  budgetPerTaskUsd: 0.50,
  maxTokensPerTask: 400_000,
  autoCompact: true,
  compactThreshold: 0.7,
  requireApprovalFor: ["write_file", "edit_file", "run_command", "git_commit", "git_branch"],
};

export function loadSettings(): AppSettings {
  ensureDataDir();
  let s: AppSettings;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // Deep-copy the fallback so later mutation (e.g. reconciliation) can never
    // corrupt the shared in-process DEFAULT_SETTINGS object.
    s = structuredClone(DEFAULT_SETTINGS);
  }
  // Reconcile the canonical local-router provider's persisted baseUrl with the
  // live DEFAULT_ROUTER_BASE — but ONLY when the router base is env-explicit
  // (with the bare :4098 fallback the persisted URL may itself be the correct
  // live router) and ONLY for the router provider itself. Rewriting ANY loopback
  // provider would clobber legitimate local endpoints (Ollama / LM Studio / vLLM
  // on 127.0.0.1) and, via the GET -> UI -> PUT round-trip, persist that loss.
  if (ROUTER_BASE_EXPLICIT && Array.isArray(s.providers)) {
    reconcileRouterBaseUrl(s.providers, DEFAULT_ROUTER_BASE);
  }
  return s;
}

/** Point the canonical local-router provider (id "engine-router" / name
 *  "Local Router") at `routerBase` when its persisted baseUrl is a stale loopback
 *  address (the router restarted on a new port). Never touches remote providers
 *  or local non-router providers. Exported for tests. */
export function reconcileRouterBaseUrl(providers: ProviderSettings[], routerBase: string): ProviderSettings[] {
  for (const p of providers) {
    const anyP = p as { base_url?: string; id?: string };
    const isRouter = anyP.id === "engine-router" || p.name === "Local Router";
    if (isRouter && isLoopbackBase(p.baseUrl) && p.baseUrl !== routerBase) {
      p.baseUrl = routerBase;
      if (anyP.base_url) anyP.base_url = routerBase;
    }
  }
  return providers;
}

/** True when a baseUrl points at the local machine (the router proxy always does). */
export function isLoopbackBase(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets: [::1] -> ::1
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
  } catch {
    return false;
  }
}

export function saveSettings(s: AppSettings): AppSettings {
  ensureDataDir();
  // Audit M1/M2: write atomically (tmp + rename) so a concurrent loadSettings
  // never reads a truncated file, and chmod 0600 so cleartext provider keys are
  // not world-readable.
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
  return s;
}

/** Per-role model-override resolution (pure). Returns the pinned model id for a
 *  role when the caller's `isUsable` predicate accepts it (exists, enabled, not
 *  operator-disabled); otherwise undefined so the caller degrades to auto-routing.
 *  Extracted from router.decideRoute so the decision is unit-testable on its own —
 *  test mocks replace the router/providers modules process-wide, so logic embedded
 *  in decideRoute cannot be exercised in the full suite. */
export function resolveRoleOverride(
  selectedModels: Record<string, string> | undefined,
  role: string,
  isUsable: (modelId: string) => boolean,
): string | undefined {
  const id = selectedModels?.[role];
  if (!id) return undefined;
  return isUsable(id) ? id : undefined;
}

/**
 * Environment that makes git (and friends) safe to run without a human at the
 * keyboard. Applied to the PTY terminal, the tool runner, and /api/run.
 *
 * Three distinct hangs this prevents:
 *
 *  1. THE PAGER. On a real TTY — which the web terminal is — `git log`,
 *     `git diff` and a long `git status` pipe themselves through `less`, which
 *     swallows the terminal and sits at a `:` prompt. The user sees a frozen
 *     terminal with no obvious escape. (The tool path happens to dodge this
 *     because its stdout is a pipe and git auto-disables the pager there, but
 *     relying on that is fragile.)
 *
 *  2. THE CREDENTIAL PROMPT. `git push`/`git fetch` against an authenticated
 *     remote blocks forever asking for a username. GIT_TERMINAL_PROMPT=0 makes
 *     git fail with a clear error instead — an autonomous agent can act on an
 *     error, it cannot act on a blocked prompt.
 *
 *  3. THE EDITOR. A merge that needs a commit message, or any git command that
 *     falls back to $EDITOR, opens vi inside the PTY. GIT_EDITOR=true makes it
 *     a no-op that exits 0.
 */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  EDITOR: "true",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  // Stops npm/pip/apt-style tools drawing progress spinners into the replay
  // buffer, and keeps them from prompting.
  CI: "1",
  DEBIAN_FRONTEND: "noninteractive",
  NO_COLOR: "",
};
