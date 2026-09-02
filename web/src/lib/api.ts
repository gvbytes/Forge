// Thin REST + SSE client. All UI data flows through here.
import type { ProviderCfg, SettingsDto, TaskDto, ProposalDto, SpanDto, EventDto, PinDto, DiscoveredModel, RouterStatus } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

/** Error with the HTTP status attached (lets callers branch on 413/415/…). */
export class ApiError extends Error {
  detail: string;
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    try {
      this.detail = JSON.parse(message).detail ?? message;
    } catch {
      this.detail = message;
    }
  }
}

async function j<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json() as Promise<T>;
}

export const api = {
  // settings (mandatory screen)
  getSettings: () => j<SettingsDto>(fetch(`${BASE}/api/settings`)),
  saveSettings: (s: SettingsDto) =>
    j<{ ok: boolean }>(fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) })),
  // The backend tests the SAVED provider config only — it no longer accepts a
  // body-supplied provider (that was an SSRF vector). The draft is still sent for
  // backwards compat but ignored server-side. F10: encode the provider id.
  testProvider: (id: string, provider?: ProviderCfg) =>
    j<{ ok: boolean; detail: string; latency_ms: number }>(fetch(`${BASE}/api/settings/test/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(provider !== undefined ? { provider } : {}),
    })),
  // F7: discovered models — the engine's live registry (GET /api/models), incl.
  // models discovered from custom providers (e.g. OpenCode Zen). Read-only view.
  models: async (): Promise<DiscoveredModel[]> => {
    const r = await j<DiscoveredModel[] | { models: DiscoveredModel[] }>(fetch(`${BASE}/api/models`));
    return Array.isArray(r) ? r : (r?.models ?? []);
  },
  refreshModels: async (): Promise<DiscoveredModel[]> => {
    const r = await j<DiscoveredModel[] | { models: DiscoveredModel[] }>(fetch(`${BASE}/api/models/refresh`, { method: "POST" }));
    return Array.isArray(r) ? r : (r?.models ?? []);
  },
  // Transparency: the local router's own introspection (policy, tier contents,
  // per-provider health/key/rate-limit state), proxied by the engine. Always
  // resolves — `reachable:false` means the router is offline, not an exception.
  routerStatus: () => j<RouterStatus>(fetch(`${BASE}/api/router/status`)),

  // persistent memory & rules (Cursor style)
  getMemory: (projectRoot?: string) =>
    j<{ ok: boolean; memory: any; fileRules: any[] }>(fetch(`${BASE}/api/memory${projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ""}`)),
  addMemory: (category: string, text: string, projectRoot?: string) =>
    j<{ ok: boolean; item: any }>(fetch(`${BASE}/api/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, text, projectRoot }) })),
  updateMemory: (id: string, updates: any, projectRoot?: string) =>
    j<{ ok: boolean }>(fetch(`${BASE}/api/memory/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...updates, projectRoot }) })),
  deleteMemory: (id: string, projectRoot?: string) =>
    j<{ ok: boolean }>(fetch(`${BASE}/api/memory/${encodeURIComponent(id)}${projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ""}`, { method: "DELETE" })),

  taskContext: (id: string) =>
    j<{
      ok: boolean;
      contextWindow: {
        activeTokens: number;
        maxTokens: number;
        percent: number;
        breakdown: { inputTokens: number; memoryTokens: number; historyTokens: number; outputTokens: number };
      };
      budget: {
        costUsd: number;
        maxCostUsd: number;
        costPercent: number;
        stepsDone: number;
        maxSteps: number;
        stepsPercent: number;
        totalTokens: number;
      };
    }>(fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}/context`)),

  // projects & tasks
  openProject: (root: string) => j<{ project_id: string; root: string }>(fetch(`${BASE}/api/project/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root }) })),
  indexStatus: () => j<any>(fetch(`${BASE}/api/index/status`)),
  reindex: () => j<any>(fetch(`${BASE}/api/index/rebuild`, { method: "POST" })),
  createTask: (goal: string, title?: string, engine: string = "engine", projectRoot?: string, projectId?: string) =>
    j<TaskDto>(fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, prompt: goal, text: goal, title, engine, path: projectRoot, projectId }),
    })),
  /** RC2: pass a projectId to scope the list to ONE folder; omit for all. */
  listTasks: (projectId?: string) =>
    j<TaskDto[]>(fetch(`${BASE}/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`)),
  /** RC1: resolve any task identity (task UUID, session id, archived pastTask
   *  id) to its owning session + that session's CURRENT task. */
  taskInfo: (id: string) => j<{ ok: boolean; session: { id: string }; task: { id: string; status?: string } | null }>(fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`)),
  resumeTask: (id: string) => j<TaskDto>(fetch(`${BASE}/api/tasks/${id}/resume`, { method: "POST" })),
  stopTask: (id: string) => j<any>(fetch(`${BASE}/api/tasks/${id}/stop`, { method: "POST" })),
  bytheway: async (sessionId: string | null, text: string): Promise<{ answer: string; model_key?: string }> => {
    // Contract: POST /api/bytheway {sessionId?, text} → normal chat answer.
    // Response shape is defensive: accept {answer|reply{content}|text} + {model_key|modelId}.
    const r = await fetch(`${BASE}/api/bytheway`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId ?? undefined, text }),
    });
    if (!r.ok) throw new ApiError(r.status, await r.text());
    const b = (await r.json()) as any;
    const answer =
      typeof b?.answer === "string" ? b.answer
      : typeof b?.reply?.content === "string" ? b.reply.content
      : typeof b?.text === "string" ? b.text
      : typeof b === "string" ? b
      : "";
    return { answer, model_key: b?.model_key ?? b?.modelId ?? b?.reply?.meta?.model };
  },
  mkdir: (params: { path?: string; parentPath?: string; name?: string; projectId?: string }) =>
    j<{ ok: boolean; path: string; name: string }>(fetch(`${BASE}/api/fs/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })),

  // context control
  pins: () => j<PinDto[]>(fetch(`${BASE}/api/context/pins`)),
  addPin: (p: PinDto) => j<PinDto[]>(fetch(`${BASE}/api/context/pins`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })),
  removePin: (idx: number) => j<PinDto[]>(fetch(`${BASE}/api/context/pins/${idx}`, { method: "DELETE" })),

  // files
  fileTree: () => j<any>(fetch(`${BASE}/api/files/tree`)),
  writeFile: (path: string, content: string, expected_mtime?: number) => j<{ ok: boolean; mtime?: number }>(fetch(`${BASE}/api/files/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content, expected_mtime }) })),
  runFile: (body: { path?: string; cmd?: string; timeout_s?: number }) => j<{ ok: boolean; cmd: string; output: string; code: number }>(fetch(`${BASE}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
  fileCreate: (path: string, kind: "file" | "dir") => j<{ ok: boolean }>(fetch(`${BASE}/api/files/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, kind }) })),
  fileDelete: (path: string) => j<{ ok: boolean }>(fetch(`${BASE}/api/files/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })),
  fileRename: (from: string, to: string) => j<{ ok: boolean }>(fetch(`${BASE}/api/files/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) })),
  termWsUrl: (projectId?: string | null) =>
    `${BASE.replace(/^http/, "ws")}/api/term${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
  readFile: (path: string) => j<{ path: string; content: string; mtime?: number }>(fetch(`${BASE}/api/files/content?path=${encodeURIComponent(path)}`)),
  searchWeb: (q: string) => j<any[]>(fetch(`${BASE}/api/websearch?query=${encodeURIComponent(q)}`)),

  // HITL
  proposals: (taskId: string) => j<ProposalDto[]>(fetch(`${BASE}/api/tasks/${taskId}/proposals`)),
  resolveHunk: async (proposalId: string, hunkId: string, accept: boolean, reason?: string): Promise<ProposalDto> => {
    // PATCH /api/proposals/:pid/hunks/:hid — hid is `${fileIdx}_${hunkIdx}`; the
    // engine parses file identity from the DTO id `${p.id}_${fileIdx}`. Response
    // is the full updated ProposalDto (unwrap defensively if it arrives wrapped).
    const res = await j<any>(fetch(`${BASE}/api/proposals/${proposalId}/hunks/${hunkId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept, reason }) }));
    return (res && typeof res.id === "string" ? res : res?.proposal) as ProposalDto;
  },
  resolveAll: async (proposalId: string, accept: boolean): Promise<ProposalDto> => {
    const res = await j<any>(fetch(`${BASE}/api/proposals/${proposalId}/resolve_all`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept }) }));
    return (res && typeof res.id === "string" ? res : res?.proposal) as ProposalDto;
  },
  pendingApprovals: () => j<any[]>(fetch(`${BASE}/api/approvals/pending`)),
  decideApproval: (id: string, approve: boolean, reason?: string) => j<any>(fetch(`${BASE}/api/approvals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve, reason }) })),

  // checkpoints (wave 26 optimistic execution / reject-and-revert)
  checkpoint: (taskId: string) => j<{ checkpoint: any | null }>(fetch(`${BASE}/api/tasks/${taskId}/checkpoint`)),
  revertTask: (taskId: string) => j<{ ok: boolean; taskId: string; restored: string[]; removed: string[]; skipped: string[] }>(fetch(`${BASE}/api/tasks/${taskId}/revert`, { method: "POST" })),
  checkpoints: (projectId: string) => j<any[]>(fetch(`${BASE}/api/checkpoints?projectId=${encodeURIComponent(projectId)}`)),

  // observability
  spans: (taskId: string) => j<SpanDto[]>(fetch(`${BASE}/api/tasks/${taskId}/spans`)),
  events: (taskId: string, since = 0) => j<EventDto[]>(fetch(`${BASE}/api/tasks/${taskId}/events?since=${since}`)),

  // Multi-key: several API keys per provider, addressed by slot. A slot named
  // after an agent role pins that role to the key; "default" is the shared
  // pool that unpinned roles round-robin across.
  keySlots: () => j<{ slots: Record<string, { slot: string; last4: string }[]> }>(fetch(`${BASE}/api/router/keys`)),
  setKeySlot: (provider: string, slot: string, key: string) =>
    j<{ provider: string; slot: string }>(
      fetch(`${BASE}/api/router/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, slot, key }),
      }),
    ),
  deleteKeySlot: (provider: string, slot: string) =>
    j<{ deleted: boolean }>(
      fetch(`${BASE}/api/router/keys/${encodeURIComponent(provider)}/${encodeURIComponent(slot)}`, { method: "DELETE" }),
    ),

  // Free-tier lock (router policy, not engine settings). Proxied by the engine
  // so the browser keeps talking to one origin.
  freeTier: () => j<{ free_tier_only: boolean }>(fetch(`${BASE}/api/router/free-tier`)),
  setFreeTier: (on: boolean) =>
    j<{ free_tier_only: boolean }>(
      fetch(`${BASE}/api/router/free-tier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on }),
      }),
    ),

  // Role Pins (Forge pattern: specific model per agent role)
  rolePins: () => j<{ pins: Record<string, string> }>(fetch(`${BASE}/api/router/role-pins`)),
  setRolePin: (role: string, model: string | null) =>
    j<{ pins: Record<string, string> }>(
      fetch(`${BASE}/api/router/role-pins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, model }),
      }),
    ),

  sseUrl: (taskId: string) => `${BASE}/api/events/${taskId}`,
};
