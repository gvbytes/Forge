// Wire contract between backend REST/SSE and frontend. Shared by all UI components.
export interface ProviderCfg { id: string; name: string; base_url: string; api_key: string; enabled: boolean }
export interface ModelCfg {
  key: string; provider_id: string; id: string; params_b: number; ctx_window: number;
  cost_in: number; cost_out: number; tier: "tiny" | "mid" | "large"; notes?: string;
}
/** A model the engine discovered from a provider's GET /models (served at
 *  GET /api/models). CamelCase ModelSpec shape — distinct from the editable
 *  ModelCfg registry entries. */
export interface DiscoveredModel {
  id: string; label?: string; provider: string; baseUrl?: string;
  ctxWindow?: number; maxOutput?: number; costInPerM?: number; costOutPerM?: number;
  tags?: string[]; enabled?: boolean;
}
export interface SettingsDto {
  providers: ProviderCfg[]; models: ModelCfg[];
  routing: { ctx_trigger_frac: number; complexity_tiny_max: number; complexity_mid_max: number; min_health: number };
  budgets: { max_cost_usd: number; max_wall_s: number; max_steps: number; max_llm_calls: number; max_parallel_subagents: number };
  /** B7: "gate" = tools in requireApprovalFor park for a human click (default);
   *  "auto" = run ungated; "optimistic" (wave 26) = file writes apply immediately
   *  and are checkpointed for reject-and-revert, shell/git still gate. Engine
   *  honors this via settings PUT. */
  approvals: { mode: "gate" | "auto" | "optimistic" };
  /** Tool names always gated when approvals.mode === "gate". */
  requireApprovalFor?: string[];
  /** Per-role model overrides the engine honors (orchestrator selectedModels).
   *  Absent/empty = auto-route. */
  selectedModels?: Record<string, string>;
  disabledModels?: string[];
}
export interface TaskDto {
  id: string;
  sessionId?: string;
  projectId?: string;
  projectRoot?: string;
  projectName?: string;
  title: string;
  goal: string;
  status: string;
  budget?: Record<string, number>;
  created_ts?: number;
  updated_ts?: number;
  summary?: string;
  plan?: Array<{
    id: string;
    title: string;
    detail?: string;
    status?: string;
    dependsOn?: string[];
    accessList?: string[];
  }>;
}
/** Canonical event DTO — ONE shape for both REST history (GET /api/tasks/:id/events)
 *  and live SSE frames: `{ id: <number cursor>, cursor, type, payload, sessionId,
 *  taskId, createdAt }`, ordered by a per-session monotonic integer `cursor`.
 *  SSE sends `id: <cursor>` and honors Last-Event-ID. `ts`/`createdAt` are the
 *  same epoch-ms timestamp under two historical names; consumers read `ts`
 *  (normalized at ingestion). `eventId` is the stable UUID when provided. */
export interface EventDto {
  /** per-session monotonic integer cursor — the canonical order/dedupe key. */
  id: number;
  cursor?: number;
  /** stable event UUID (dedupe key) when the engine provides one. */
  eventId?: string;
  taskId: string;
  sessionId?: string;
  ts: number;
  createdAt?: number;
  type: string;
  payload: any;
}

export interface HunkDto {
  id: string; header: string; oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: string[]; status: "pending" | "accepted" | "rejected"; reason?: string;
}
export interface ProposalDto {
  id: string; task_id: string; path: string; base_sha: string; diff_text: string;
  hunks: HunkDto[]; status: "pending" | "partial" | "resolved" | "applied" | "discarded";
}
export interface SpanDto {
  id: string; task_id: string; parent_id: string | null; kind: "agent" | "llm" | "tool" |
  "retrieval" | "compaction" | "routing"; name: string; t0: number; t1: number | null;
  status: string; tokens_in: number; tokens_out: number; cost_usd: number;
  model: string; provider: string; meta: Record<string, any>;
}
export interface PinDto { path: string; start_line?: number; end_line?: number; label?: string }
export interface RoutingInfo { model_key: string; provider_id: string; tier: string; reasons: string[] }

/** Transparency snapshot of the local routing proxy (engine GET /api/router/status,
 *  which proxies the router's /routes). Lets the UI show what the router is doing
 *  instead of it being a black box. `reachable:false` = router offline. */
export interface RouterProviderStatus {
  id: string; kind?: string; baseURL?: string; notes?: string;
  models_seeded: number; key_configured: boolean; healthy: boolean;
  consecutive_429: number; consecutive_5xx: number; last_rate_limit_ts: number | null;
  rpm_last_minute: number;
}
export interface RouterTierModel {
  provider: string; model: string; ctx_window: number; price_in: number; price_out: number; param_b: number;
}
export interface RouterStatus {
  reachable: boolean; routerRoot?: string; error?: string;
  policy?: string;
  tiers?: { S: RouterTierModel[]; M: RouterTierModel[]; L: RouterTierModel[] };
  providers?: RouterProviderStatus[];
  keys?: {
    providers?: Record<string, { set: boolean; last4?: string }>;
    keys?: Array<{ provider: string; key: string }>;
  };
}
