import { formatMemoryForPrompt, loadProjectMemory, saveProjectMemory, addMemoryItem, updateMemoryItem, deleteMemoryItem, loadFileRules } from "./memory.js";
// Native TypeScript Agent Engine HTTP API + SSE hub + WebSocket Terminal.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { AppSettings, ChangeProposal, ContextRef, Session, ChatMessage, TraceEvent } from "./types.js";
import { loadSettings, saveSettings, DATA_DIR, DEFAULT_MODELS, DEFAULT_ROUTER_BASE, NON_INTERACTIVE_ENV } from "./config.js";
import { searchWeb } from "./websearch.js";
import { registry, startRegistryAutoRefresh } from "./providers.js";
import { trace, loadTraces } from "./trace.js";
import { wire } from "./bus.js";
import { eventStore, startEventStore, toEventDto, legacyEvents, type CanonicalEvent } from "./events.js";
import * as sessions from "./sessions.js";
import { registerProject, projectIdFor, reconcileBootSessions } from "./sessions.js";
import { listRecent, listAllPending, decideApproval, getApproval, reloadApprovalsForBoot } from "./approvals.js";
import { putProposal, getProposal, updateProposal, listProposals } from "./proposals.js";
import { getCheckpoint, listCheckpoints, revertCheckpoint } from "./checkpoints.js";
import { buildIndex, ensureFresh, stats as indexStats } from "./retrieval.js";
import { runTask, stopTask, isRunning, resumeAfterApproval, ensureTask, enqueueNudge } from "./orchestrator.js";
import { BYTHEWAY_PROMPT } from "./prompts.js";
import { runChat } from "./chat.js";
import { buildSystemPrompt, estTokens, messagesTokens, renderContextBlock, resolvePinnedRefs } from "./context.js";
import { chat } from "./providers.js";
import { applyProposalPartial } from "./apply.js";
import { getRecent, tailLogFile, logger } from "./logger.js";
import type { LogLevel } from "./logger.js";
import { breakerSnapshot, probeAllModels } from "./router.js";
import { mkdirEntry, newFile, renameEntry, deleteEntry } from "./fsops.js";
import { toolSchemasForApi, TOOL_SPECS } from "./tools.js";
import * as term from "./terminal.js";

const app = new Hono();

// ── security helpers ──────────────────────────────────────────────────────
function inRoot(root: string, abs: string): boolean {
  const r = path.resolve(root) + path.sep;
  return abs === path.resolve(root) || abs.startsWith(r);
}

const ID_RE = /^[\w-]+$/;
function idsValid(...ids: (string | undefined)[]): boolean {
  return ids.every((i) => typeof i === "string" && i.length > 0 && ID_RE.test(i));
}

// Single source of truth for the approvals posture. Coerces any missing/unknown
// mode to the engine default ("gate") so GET/PUT/settings-on-disk can never
// disagree with toolRequiresApproval (which also defaults absent → gate).
// "gate" is the default because PS 8b requires human approval before EVERY
// side-effecting tool call; see the rationale in config.ts DEFAULT_SETTINGS.
const APPROVAL_MODES = new Set(["gate", "auto", "optimistic"]);
function normalizeApprovals(input: unknown): { mode: "gate" | "auto" | "optimistic" } {
  const mode = (input as { mode?: unknown } | undefined)?.mode;
  return { mode: typeof mode === "string" && APPROVAL_MODES.has(mode) ? (mode as "gate" | "auto" | "optimistic") : "gate" };
}

app.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

const LOG_SKIP_PATHS = /^\/api\/(events|term\/[^/]+\/stream)$/;
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (!LOG_SKIP_PATHS.test(c.req.path)) {
    httpLog.debug(`${c.req.method} ${c.req.path} → ${c.res.status}`, { ms: Date.now() - t0 });
  }
});

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const httpLog = logger.for("http");

// ── Phase 6 hardening: optional bearer auth + browser origin guard ────────
// Auth: when ENGINE_API_TOKEN is set (non-empty), every mutating /api route
// requires `Authorization: Bearer <token>`; missing/wrong → 401. /api/health
// stays open. Unset/empty env = auth completely off (dev ergonomics).
// Origin guard: state-changing /api requests carrying a browser Origin/Referer
// must come from the trusted local dev origins (or the same host as the
// request). Header-less clients (curl, the router, the watchdog) are allowed.
const ENGINE_API_TOKEN = (process.env.ENGINE_API_TOKEN ?? "").trim();
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TRUSTED_ORIGIN_PORTS = new Set(["4444", "5173", "4100", "4098"]);
// scripts/dev.sh picks a FREE web port when 4444 is busy and exports WEB_PORT,
// which this process inherits. Trust that dynamic port too, otherwise the browser
// UI's mutating requests (Origin: http://localhost:<dynamic>) would be 403'd.
const dynamicWebPort = (process.env.WEB_PORT ?? "").trim();
if (dynamicWebPort) TRUSTED_ORIGIN_PORTS.add(dynamicWebPort);

function browserOriginAllowed(originOrReferer: string, reqHost: string): boolean {
  let u: URL;
  try {
    u = new URL(originOrReferer);
  } catch {
    return false; // unparseable browser header → refuse
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && TRUSTED_ORIGIN_PORTS.has(port)) return true;
  // same host as the request itself (covers proxied/topology variants)
  return reqHost.length > 0 && u.host === reqHost;
}

function bearerTokenOk(authHeader: string): boolean {
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || token.length !== ENGINE_API_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ENGINE_API_TOKEN));
  } catch {
    return false;
  }
}

app.use("/api/*", async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method)) {
    const originOrReferer = c.req.header("origin") || c.req.header("referer");
    if (originOrReferer && !browserOriginAllowed(originOrReferer, c.req.header("host") || "")) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    if (ENGINE_API_TOKEN && c.req.path !== "/api/health" && !bearerTokenOk(c.req.header("authorization") || "")) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

// ── logs ──────────────────────────────────────────────────────────────────
app.get("/api/logs", (c) => {
  const level = c.req.query("level");
  const component = c.req.query("component") || undefined;
  const limitRaw = Number(c.req.query("limit") ?? 500);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 5000)) : 500;
  return c.json(getRecent(
    level && LOG_LEVELS.has(level) ? (level as LogLevel) : undefined,
    component,
    limit,
  ));
});

app.get("/api/logs/file", (c) => {
  const linesRaw = Number(c.req.query("lines") ?? 500);
  const lines = Number.isFinite(linesRaw) ? Math.max(1, Math.min(Math.trunc(linesRaw), 5000)) : 500;
  return c.json({ lines: tailLogFile(lines) });
});

// ── health / settings / models ────────────────────────────────────────────
app.get("/api/health", (c) => c.json({ ok: true, service: "agent-engine", version: "0.1.0", ts: Date.now() }));

// ── Settings security helpers ───────────────────────────────────────────────
/** Validate a provider base_url. Only http/https are allowed; link-local and
 *  cloud-metadata hosts are denied. This blocks the SSRF / stored-key
 *  exfiltration channel where an attacker points base_url at file:// (Bun's
 *  fetch reads local files), http://169.254.169.254/..., or an internal port and
 *  the engine then sends the preserved API key there as `Authorization: Bearer`.
 *  Loopback is intentionally ALLOWED (the local router + local Ollama/vLLM). */
function isSafeProviderBaseUrl(u: unknown): boolean {
  if (typeof u !== "string" || !u.trim()) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "169.254.169.254" || h === "metadata.google.internal") return false;
  if (h.startsWith("169.254.")) return false; // link-local
  return true;
}

/** Strip anything that is not printable ASCII from an error/detail string before
 *  it is logged or returned. Bun's invalid-header error echoes the full
 *  Authorization value, so a key containing CR/LF would otherwise leak verbatim
 *  into GET /api/logs and the test-endpoint response. */
function redactSecrets(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

app.get("/api/settings", (c) => {
  const s: any = loadSettings();
  // B25: NEVER return raw keys. A set key is always masked to "••••••••";
  // an absent/empty key stays empty (so the UI can tell "no key configured").
  const providers = (s.providers || []).map((p: any) => ({
    id: p.id || p.name || "engine-router",
    name: p.name || p.id || "Local Router",
    base_url: p.base_url || p.baseUrl || "http://127.0.0.1:4098/v1",
    baseUrl: p.baseUrl || p.base_url || "http://127.0.0.1:4098/v1",
    api_key: (p.api_key || p.apiKey) ? "••••••••" : "",
    apiKey: (p.apiKey || p.api_key) ? "••••••••" : "",
    enabled: p.enabled !== false,
    has_key: Boolean(p.apiKey || p.api_key),
    kind: p.kind || "openai-compatible",
  }));

  const models = (s.models && Array.isArray(s.models) && s.models.length) ? s.models : DEFAULT_MODELS;
  const routing = s.routing || { ctx_trigger_frac: 0.7, complexity_tiny_max: 0.25, complexity_mid_max: 0.65, min_health: 0.5 };
  const budgets = s.budgets || { max_cost_usd: 0.50, max_wall_s: 2700, max_steps: 40, max_llm_calls: 80, max_parallel_subagents: 3 };
  const approvals = normalizeApprovals(s.approvals);

  return c.json({
    ...s,
    providers,
    models,
    routing,
    budgets,
    approvals,
  });
});

app.put("/api/settings", async (c) => {
  const incoming: any = (await c.req.json()) as any;
  const current: any = loadSettings();
  let updatedProviders: any[];
  try {
  updatedProviders = (incoming.providers || []).map((newP: any) => {
    const newName = newP.name || newP.id;
    const newBase = newP.base_url || newP.baseUrl || "";

    // base_url must be a safe http(s) endpoint. Rejecting file:// / link-local /
    // metadata hosts here closes the SSRF + stored-key exfiltration channel.
    if (newBase && !isSafeProviderBaseUrl(newBase)) {
      throw new Error(`provider "${newName || newP.id}": unsafe or invalid base_url`);
    }

    // Match the prior provider by EXACT stable id only (audit I1). The old loose
    // 4-way id/name OR-match + baseUrl-fallback could attach provider A's stored
    // key to provider B (or copy a key onto a newcomer sharing a baseUrl).
    const oldMatch = (current.providers || []).find((p: any) => p.id && p.id === newP.id);
    const oldBase = oldMatch ? (oldMatch.base_url || oldMatch.baseUrl || "") : "";

    const incomingKey = typeof newP.api_key === "string" ? newP.api_key
      : typeof newP.apiKey === "string" ? newP.apiKey
      : "";
    let apiKey = incomingKey;
    if (!apiKey || apiKey.startsWith("••")) {
      // "keep existing key" — but ONLY if the endpoint did not change (audit C2).
      // Re-pointing a provider at a new base_url while silently reusing its stored
      // key is exactly how the key gets exfiltrated to an attacker-controlled URL,
      // so a base_url change forces explicit key re-entry.
      const baseChanged = oldMatch && newBase && oldBase && newBase !== oldBase;
      apiKey = baseChanged ? "" : (oldMatch?.apiKey || oldMatch?.api_key || "");
    }
    // Keys go out as an Authorization header; CR/LF or other control characters
    // make Bun's fetch throw and the error echoes the key (audit I8 / router F3).
    apiKey = apiKey.replace(/[^\x20-\x7E]/g, "");

    return {
      id: newP.id || newP.name,
      name: newP.name || newP.id,
      base_url: newBase || "http://127.0.0.1:4098/v1",
      baseUrl: newBase || "http://127.0.0.1:4098/v1",
      api_key: apiKey,
      apiKey: apiKey,
      enabled: newP.enabled !== false,
      kind: newP.kind || "openai-compatible",
    };
  });
  } catch (err: any) {
    return c.json({ ok: false, error: redactSecrets(String(err?.message || err)) }, 400);
  }

  const merged = {
    ...current,
    ...incoming,
    providers: updatedProviders,
    models: incoming.models || current.models || DEFAULT_MODELS,
    routing: incoming.routing || current.routing,
    budgets: incoming.budgets || current.budgets,
    approvals: normalizeApprovals(incoming.approvals ?? current.approvals),
  };

  saveSettings(merged);
  void registry.refresh();

  // Forward provider keys to the local router proxy. The router's /keys endpoint
  // lives at the router ROOT (not under /v1). Derive it from DEFAULT_ROUTER_BASE
  // (which tracks the live router port via ENGINE_ROUTER_BASE) — the old
  // hardcoded http://127.0.0.1:4098/keys silently failed whenever the router ran
  // on any other port (dynamic dev ports / restart), so UI-added keys never
  // reached the router.
  const routerKeysUrl = `${DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "")}/keys`;
  for (const p of updatedProviders) {
    if (p.api_key && !p.api_key.startsWith("••")) {
      void fetch(routerKeysUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, key: p.api_key }),
      }).catch(() => {});

      // Forward to canonical router upstream names (groq, openrouter, nvidia-nim, zen)
      const host = (p.base_url || "").toLowerCase();
      const idOrName = `${p.id || ""} ${p.name || ""}`.toLowerCase();
      let canonical: string | null = null;
      if (host.includes("groq.com") || idOrName.includes("groq")) canonical = "groq";
      else if (host.includes("openrouter.ai") || idOrName.includes("openrouter")) canonical = "openrouter";
      else if (host.includes("nvidia.com") || idOrName.includes("nvidia") || idOrName.includes("nim")) canonical = "nvidia-nim";
      else if (host.includes("opencode.ai") || idOrName.includes("zen")) canonical = "zen";

      if (canonical && canonical !== p.id) {
        void fetch(routerKeysUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: canonical, key: p.api_key }),
        }).catch(() => {});
      }
    }
  }

  return c.json({ ok: true, providers: merged.providers.length });
});

app.post("/api/settings/test/:id", async (c) => {
  const provId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as any;
  const s: any = loadSettings();
  let prov = (s.providers || []).find((p: any) => p.id === provId || p.name === provId);
  // Allow testing newly entered or edited provider credentials before clicking Save
  if (!prov && body?.provider) {
    prov = body.provider;
  } else if (prov && body?.provider?.api_key && !body.provider.api_key.startsWith("••")) {
    prov = { ...prov, api_key: body.provider.api_key, apiKey: body.provider.api_key };
  }
  if (!prov) return c.json({ ok: false, detail: "Unknown provider" }, 404);
  const targetUrl = prov.base_url || prov.baseUrl || "";
  if (!isSafeProviderBaseUrl(targetUrl)) {
    return c.json({ ok: false, detail: "Blocked: base_url is not a safe http(s) endpoint" }, 400);
  }
  const key = prov.api_key || prov.apiKey || "";
  const t0 = Date.now();
  try {
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t0;
    if (res.ok) {
      return c.json({ ok: true, detail: `Reachable (HTTP ${res.status} in ${latency}ms)`, latency_ms: latency });
    }
    return c.json({ ok: false, detail: `Reached with HTTP ${res.status} in ${latency}ms`, latency_ms: latency });
  } catch (err: any) {
    const latency = Date.now() - t0;
    return c.json({ ok: false, detail: redactSecrets(`Connection error: ${err.message || String(err)}`), latency_ms: latency });
  }
});

app.get("/api/models", async (c) => {
  let models = registry.list();
  if (!models.length) models = await registry.refresh();
  const snap = breakerSnapshot();
  return c.json({ models: models.map((m) => ({ ...m, health: snap[m.id] })) });
});

app.post("/api/models/refresh", async (c) => c.json({ models: await registry.refresh({ force: true }) }));

// ── projects ──────────────────────────────────────────────────────────────
// Default workspace root: takes caller terminal working directory from launcher
// (process.env.DEFAULT_PROJECT_ROOT / PROJECT_ROOT), or leaves empty to prompt the user.
let currentProjectRoot = (process.env.DEFAULT_PROJECT_ROOT || process.env.PROJECT_ROOT || "").trim();

if (currentProjectRoot && fs.existsSync(currentProjectRoot) && fs.statSync(currentProjectRoot).isDirectory()) {
  try {
    registerProject(currentProjectRoot);
  } catch {
    // ignore
  }
} else {
  currentProjectRoot = "";
}

const handleProjectOpen = async (c: any) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const targetPath = body.root || body.path || "";
  if (!targetPath) return c.json({ error: "root or path required" }, 400);
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (err: any) {
      return c.json({ error: `failed to create project directory: ${err.message}`, path: abs }, 400);
    }
  } else if (!fs.statSync(abs).isDirectory()) {
    return c.json({ error: "path exists and is not a directory", path: abs }, 400);
  }
  currentProjectRoot = abs;
  const info = registerProject(abs);
  void ensureFresh(abs, info.id).catch(() => {});
  return c.json({ project_id: info.id, root: abs, project: info, ok: true });
};

app.post("/api/project/open", handleProjectOpen);
app.post("/api/projects/open", handleProjectOpen);

app.get("/api/projects", (c) => {
  try {
    return c.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "projects.json"), "utf8")));
  } catch {
    return c.json([]);
  }
});

app.get("/api/projects/:pid/index-stats", (c) => c.json(indexStats(c.req.param("pid")) ?? { files: 0, chunks: 0 }));

// B18: retrieval index status/rebuild (UI index panel).
app.get("/api/index/status", (c) => {
  const projects: Record<string, { root: string; files: number; chunks: number; indexedAt?: number }> = {};
  for (const [pid, root] of sessions.projectRoots()) {
    projects[pid] = { root, ...(indexStats(pid) ?? { files: 0, chunks: 0 }) };
  }
  const currentPid = projectIdFor(path.resolve(currentProjectRoot || process.cwd()));
  return c.json({
    ok: true,
    currentProjectRoot: currentProjectRoot || null,
    currentProjectId: currentPid,
    projects,
  });
});

app.post("/api/index/rebuild", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
  let pid = body.projectId;
  let root: string;
  if (pid && sessions.projectRoots().has(pid)) {
    root = sessions.projectRoots().get(pid)!;
  } else {
    root = path.resolve(currentProjectRoot || process.cwd());
    pid = registerProject(root).id;
  }
  try {
    // ensureFresh() has no force flag — buildIndex() IS the unconditional
    // rebuild (re-walks, re-chunks, re-persists), so it is the force path.
    const result = await buildIndex(root, pid);
    return c.json({ ok: true, projectId: pid, root, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("retrieval", `index rebuild failed: ${msg.slice(0, 300)}`, { projectId: pid });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── task API adapter layer ────────────────────────────────────────────────
app.post("/api/tasks", async (c) => {
  const body = (await c.req.json()) as {
    prompt?: string;
    text?: string;
    projectId?: string;
    path?: string;
    contextRefs?: ContextRef[];
    refs?: ContextRef[];
    sessionId?: string;
  };
  const text = (body.prompt ?? body.text ?? "").trim();
  if (!text) return c.json({ error: "prompt or text required" }, 400);

  let pid = body.projectId;
  let rootPath = "";
  if (pid && sessions.projectRoots().has(pid)) {
    rootPath = sessions.projectRoots().get(pid)!;
  } else {
    rootPath = path.resolve(body.path || currentProjectRoot || process.cwd());
    const info = registerProject(rootPath);
    pid = info.id;
  }
  currentProjectRoot = rootPath;

  let sid = body.sessionId;
  let s = sid ? sessions.getSession(pid, sid) : null;
  if (!s && sid) {
    // Cross-project defense (mirrors /api/bytheway): a sessionId from another
    // project must NOT silently fork a NEW empty session here (conversation
    // context loss) — look up which project actually owns it and use THAT.
    const hit = findSessionByAnyId(sid);
    if (hit) {
      s = hit.s;
      pid = hit.pid;
      rootPath = sessions.projectRoots().get(hit.pid) ?? rootPath;
      currentProjectRoot = rootPath;
    }
  }
  if (!s) {
    s = sessions.newSession(pid);
    sid = s.id;
    wire.emit({ type: "session", session: s });
  }
  if (isRunning(s.id)) return c.json({ error: "task already running" }, 409);

  const refs = body.contextRefs ?? body.refs ?? [];
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    refs,
    at: Date.now(),
  };
  s.messages.push(msg);
  if (refs.length) {
    for (const r of refs) {
      if (!s.contextRefs.find((x) => x.path === r.path && x.startLine === r.startLine)) {
        s.contextRefs.push({ ...r, source: "user" });
      }
    }
  }
  if (s.title === "New session") s.title = text.slice(0, 60);
  // B19: create the TaskRecord SYNCHRONOUSLY (archiving a terminal previous
  // task via the shared wave-1 B9 rule) so this response carries the REAL task
  // UUID — runTask's own `session.task ??=` then no-ops on the fresh record.
  const task = ensureTask(s, text);
  sessions.saveSession(s);
  // Authoritative canonical logging: the event store is the single transcript
  // source of truth (SSE + REST backfill both serve this row). The payload
  // keeps the WireEvent message shape so assistant messages bridged from the
  // orchestrator and user messages appended here are one uniform contract.
  eventStore.append(
    s.id,
    "message",
    { type: "message", sessionId: s.id, message: msg },
    { id: msg.id, taskId: task.id, projectId: pid, createdAt: msg.at },
  );

  void runTask(sessions.getSession(pid, s.id)!, msg).catch((err: unknown) => {
    trace.emit({
      sessionId: s.id,
      spanId: crypto.randomUUID(),
      kind: "error",
      label: "runTask crashed",
      input: err instanceof Error ? err.stack ?? err.message : String(err).slice(0, 2000),
    });
  });

  return c.json({
    ok: true,
    id: task.id,
    taskId: task.id,
    sessionId: s.id,
    projectId: pid,
    projectRoot: rootPath,
    projectName: path.basename(rootPath),
  });
});

// B18: /bytheway side-question path — one routed chat turn (runChat) that
// never touches the task machinery. Session is resolved or created exactly
// like POST /api/tasks. LLM failure → 502 { error } (composer shows inline).
app.post("/api/bytheway", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: string;
    projectId?: string;
    path?: string;
    text?: string;
    prompt?: string;
    refs?: ContextRef[];
  };
  const text = (body.text ?? body.prompt ?? "").trim();
  if (!text) return c.json({ error: "text or prompt required" }, 400);

  let pid = body.projectId;
  let rootPath = "";
  if (pid && sessions.projectRoots().has(pid)) {
    rootPath = sessions.projectRoots().get(pid)!;
  } else {
    rootPath = path.resolve(body.path || currentProjectRoot || process.cwd());
    const info = registerProject(rootPath);
    pid = info.id;
  }

  let s = body.sessionId ? sessions.getSession(pid, body.sessionId) : undefined;
  if (!s && body.sessionId) {
    // defensive: the client may send a sessionId that lives under another project
    for (const [p2, r2] of sessions.projectRoots()) {
      const found = sessions.getSession(p2, body.sessionId);
      if (found) {
        s = found;
        pid = p2;
        rootPath = r2;
        break;
      }
    }
  }
  if (!s) {
    s = sessions.newSession(pid);
    wire.emit({ type: "session", session: s });
  }

  try {
    const { reply, modelId } = await runChat(s, rootPath, text, body.refs);
    return c.json({
      ok: true,
      answer: reply.content,
      messageId: reply.id,
      model: modelId,
      modelId,          // compat aliases (web accepts model_key|modelId)
      model_key: modelId,
      sessionId: s.id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("chat", `bytheway failed: ${msg.slice(0, 300)}`, { sessionId: s.id });
    return c.json({ error: msg }, 502);
  }
});

// --- Persistent Memory & Rules API (Cursor style) ---
app.get("/api/memory", async (c) => {
  const root = c.req.query("projectRoot") || currentProjectRoot || process.cwd();
  const memory = loadProjectMemory(root);
  const fileRules = loadFileRules(root);
  return c.json({ ok: true, memory, fileRules });
});

app.post("/api/memory", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const root = body.projectRoot || currentProjectRoot || process.cwd();
  if (!body.text || !body.category) {
    return c.json({ ok: false, error: "Missing required fields 'text' or 'category'" }, 400);
  }
  const item = addMemoryItem(root, body.category, body.text, body.source || "user");
  return c.json({ ok: true, item });
});

app.put("/api/memory/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as any;
  const root = body.projectRoot || currentProjectRoot || process.cwd();
  const ok = updateMemoryItem(root, id, body);
  return c.json({ ok });
});

app.delete("/api/memory/:id", async (c) => {
  const id = c.req.param("id");
  const root = c.req.query("projectRoot") || currentProjectRoot || process.cwd();
  const ok = deleteMemoryItem(root, id);
  return c.json({ ok });
});

app.get("/api/tasks", (c) => {
  // Folder scoping (RC2): ?projectId=<pid> restricts the scan to ONE project
  // (the web passes the id it got from POST /api/project/open). An unknown pid
  // returns [] — it must NEVER fall through to listing every project.
  const scopePid = c.req.query("projectId");
  const roots = sessions.projectRoots();
  const scopedRoot = scopePid ? roots.get(scopePid) : undefined;
  const iter: [string, string][] = scopePid
    ? (scopedRoot ? [[scopePid, scopedRoot]] : [])
    : [...roots];
  const all: any[] = [];
  for (const [pid, rootPath] of iter) {
    const projectName = path.basename(rootPath);
    for (const s of sessions.listSessions(pid)) {
      // Delegated subtask sessions (meta.delegated) are internal agent fan-out,
      // not user tasks — they must not pollute the task list.
      if (s.task?.meta?.delegated) continue;
      if (s.task) {
        const liveRunning = isRunning(s.id);
        const taskStatus = liveRunning ? "running" : (s.task.status === "running" ? "stopped" : s.task.status);
        all.push({
          ...s.task,
          status: taskStatus,
          sessionId: s.id,
          projectId: pid,
          projectRoot: rootPath,
          projectName,
          goal: s.task.goal || s.task.title || s.title || "Task",
          created_ts: s.task.createdAt || s.createdAt,
          updated_ts: s.task.updatedAt || s.updatedAt,
        });
      } else {
        all.push({
          id: s.id,
          sessionId: s.id,
          projectId: pid,
          projectRoot: rootPath,
          projectName,
          title: s.title,
          goal: s.title || "Session",
          status: "idle",
          created_ts: s.createdAt,
          updated_ts: s.updatedAt,
        });
      }
    }
  }
  all.sort((a, b) => (b.updated_ts || b.updatedAt || 0) - (a.updated_ts || a.updatedAt || 0));
  return c.json(all);
});

// ── Task/session identity resolution (RC1) ──────────────────────────────────
// One id space spans THREE identities: the session id, the CURRENT task UUID,
// and ARCHIVED pastTasks UUIDs (a followup to a terminal task archives it and
// mints a fresh UUID in the same session). Every identity-addressed route must
// resolve all three — an archived id silently falling through to "no match"
// used to strand the UI on a dead UUID (refresh-loses-task bug).
function findSessionByAnyId(id: string): { s: Session; pid: string; matchedTaskId: string } | null {
  for (const [pid, rootPath] of sessions.projectRoots()) {
    for (const s of sessions.listSessions(pid)) {
      if (s.id === id) return { s, pid, matchedTaskId: s.task?.id ?? id };
      if (s.task?.id === id) return { s, pid, matchedTaskId: id };
      if ((s.pastTasks ?? []).some((t) => t.id === id)) return { s, pid, matchedTaskId: id };
    }
  }
  return null;
}

app.get("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  const hit = findSessionByAnyId(id);
  if (!hit) return c.json({ error: "not found" }, 404);
  const { s, pid } = hit;
  const rootPath = sessions.projectRoots().get(pid)!;
  const liveRunning = isRunning(s.id);
  const task = s.task ? {
    ...s.task,
    status: liveRunning ? "running" : (s.task.status === "running" ? "stopped" : s.task.status),
  } : s.task;
  return c.json({
    ok: true,
    session: s,
    task,
    projectId: pid,
    projectRoot: rootPath,
    projectName: path.basename(rootPath),
  });
});

app.post("/api/tasks/:id/stop", (c) => {
  const id = c.req.param("id");
  const hit = findSessionByAnyId(id);
  if (!hit) return c.json({ error: "task not found" }, 404);
  // An ARCHIVED pastTasks id is already terminal — stopping it must be an
  // HONEST 404, never a silent {ok:true} that hides the mismatch.
  const isArchivedOnly = hit.s.task?.id !== id && (hit.s.pastTasks ?? []).some((t) => t.id === id);
  if (isArchivedOnly) return c.json({ error: "task is archived (terminal)" }, 404);
  stopTask(hit.s.id);
  return c.json({ ok: true });
});

app.post("/api/tasks/:id/resume", (c) => {
  const id = c.req.param("id");
  const hit = findSessionByAnyId(id);
  if (!hit) return c.json({ error: "task not found" }, 404);
  const isArchivedOnly = hit.s.task?.id !== id && (hit.s.pastTasks ?? []).some((t) => t.id === id);
  if (isArchivedOnly) return c.json({ error: "task is archived (terminal); send a followup instead" }, 404);
  void resumeAfterApproval(hit.s.id).catch(() => {});
  return c.json({ ok: true, taskId: hit.s.task?.id ?? id, sessionId: hit.s.id });
});

app.post("/api/tasks/:id/message", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { message?: string; text?: string; prompt?: string; content?: string };
  const text = (body.content ?? body.message ?? body.text ?? body.prompt ?? "").trim();
  if (!text) return c.json({ error: "message required" }, 400);

  const hit = findSessionByAnyId(id);
  if (!hit) return c.json({ error: "task/session not found" }, 404);
  const { s, pid } = hit;
  // B44: a RUNNING task gets the message injected into the LIVE tool loop via
  // the wave-1 nudge queue (drained between LLM calls) instead of parking it
  // in history where the agent would never see it.
  if (isRunning(s.id)) {
    const liveTaskId = s.task?.id ?? id;
    const queued = enqueueNudge(liveTaskId, text);
    if (!queued) {
      // Running per controllers, but the nudge index has no live entry for
      // this task (transient finalize race) — honest 409, not ok.
      return c.json({ error: "task is running but the nudge queue is unavailable" }, 409);
    }
    // taskId: the live task id — a followup may have landed mid-rollover, the
    // web needs the CURRENT id to follow the conversation.
    return c.json({ ok: true, delivered: "loop", taskId: liveTaskId, sessionId: s.id });
  }
  // Non-running: append to history (and kick a fresh run — the pre-existing
  // contract for message-while-idle). A followup to a TERMINAL task archives
  // it (ensureTask inside runTask) and mints a NEW task UUID in the same
  // session — respond with that id so the web can follow the rollover (RC1).
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    at: Date.now(),
  };
  s.messages.push(msg);
  // runTask archives the terminal task + mints the fresh record; ensureTask
  // here (synchronously, same rule) so the response can carry the NEW id.
  const task = ensureTask(s, text);
  sessions.saveSession(s);
  // Authoritative canonical logging (see POST /api/tasks) — the wire bridge
  // would dedupe by message id anyway, but appending here keeps the
  // user-message path explicit and carries task/project identity.
  eventStore.append(
    s.id,
    "message",
    { type: "message", sessionId: s.id, message: msg },
    { id: msg.id, taskId: task.id, projectId: pid, createdAt: msg.at },
  );
  void runTask(s, msg).catch((err) => logger.error("engine", `runTask failed after message: ${err}`));
  return c.json({ ok: true, delivered: "history", taskId: task.id, sessionId: s.id });
});

// ── Observability & Spans API adapter ────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true, service: "agent-engine", status: "ready" }));
app.get("/api/tools", (c) => c.json(toolSchemasForApi()));
app.get("/api/skills", (c) => c.json({
  skills: [
    {
      name: "web-research",
      description: "Keyless multi-engine web search (DuckDuckGo + Bing) and Markdown content scraper (Hermes Agent style)",
      tools: ["web_search", "web_scrape", "web_extract"],
      enabled: true
    }
  ]
}));

app.get("/api/tasks/:id/spans", (c) => {
  const id = c.req.param("id");
  const hit = findSessionByAnyId(id);
  if (!hit) return c.json([]);
  const { s } = hit;
  const events = trace.getEvents(s.id);
  return c.json(mergeSpans(events, s.task?.id ?? s.id));
});

// Real-time live context window & token accounting endpoint (Claude Code style)
app.get("/api/tasks/:id/context", (c) => {
  const id = c.req.param("id");
  const hit = findSessionByAnyId(id);
  if (!hit) {
    return c.json({
      ok: false,
      contextWindow: { activeTokens: 0, maxTokens: 128000, percent: 0, breakdown: { inputTokens: 0, memoryTokens: 0, historyTokens: 0, outputTokens: 0 } },
      budget: { costUsd: 0, maxCostUsd: 0.50, costPercent: 0, stepsDone: 0, maxSteps: 40, stepsPercent: 0, totalTokens: 0 }
    });
  }
  const { s, pid } = hit;
  const rootPath = sessions.projectRoots().get(pid) || currentProjectRoot || process.cwd();
  
  // Real token accounting directly from memory, pinned context, and history
  const memoryBlock = formatMemoryForPrompt(rootPath);
  const memoryTokens = estTokens(memoryBlock);
  
  const pinnedRefs = resolvePinnedRefs(rootPath, s.contextRefs || []);
  const pinnedTokens = estTokens(renderContextBlock(pinnedRefs));
  
  const historyTokens = messagesTokens(s.messages || []);
  const baseSysTokens = estTokens(buildSystemPrompt({ agentsMdRules: null, rolePrompt: "CODER" }));
  const activeTokens = Math.max(1, baseSysTokens + memoryTokens + pinnedTokens + historyTokens);
  
  const events = trace.getEvents(s.id);
  const spans = mergeSpans(events, s.task?.id ?? s.id);
  const tokensIn = spans.reduce((acc, sp) => acc + (sp.tokens_in || 0), 0);
  const tokensOut = spans.reduce((acc, sp) => acc + (sp.tokens_out || 0), 0);
  const totalTokens = tokensIn + tokensOut;
  const costUsd = spans.reduce((acc, sp) => acc + (sp.cost_usd || 0), 0) || s.task?.costUsd || 0;
  
  // TaskRecord has budgetUsdCap / maxTokensPerTask. Read budgets from settings with $0.50 ceiling.
  const settingsNow = loadSettings();
  const budgetCapUsd = s.task?.budgetUsdCap ?? (settingsNow as any).budgets?.max_cost_usd ?? settingsNow.budgetPerTaskUsd ?? 0.50;
  const maxSteps = (settingsNow as { budgets?: { max_steps?: number } }).budgets?.max_steps ?? (s.task?.meta as any)?.max_steps ?? 40;
  // Count genuine action steps (agent starts, tool calls, plan steps), not raw micro-spans / telemetry events
  const actionSteps = spans.filter((sp) => sp.kind === "tool.call" || sp.kind === "agent.start" || sp.kind === "step").length;
  const stepsDone = typeof s.task?.stepCount === "number" && s.task.stepCount > 0 ? s.task.stepCount : actionSteps;
  
  // The model is a per-CALL routing decision, not a task field; the most recent
  // llm.call span is the honest answer to "what is this running on".
  const modelId =
    [...spans].reverse().find((sp) => sp.kind === "llm.call" && sp.model)?.model ?? "engine/small";
  const modelInfo = registry.get(modelId);
  const maxCtxTokens = modelInfo?.ctxWindow || 128000;
  const ctxPercent = Math.min(100, Math.round((activeTokens / maxCtxTokens) * 100));

  return c.json({
    ok: true,
    contextWindow: {
      activeTokens,
      maxTokens: maxCtxTokens,
      percent: ctxPercent,
      breakdown: {
        inputTokens: Math.max(0, activeTokens - memoryTokens - historyTokens),
        memoryTokens,
        historyTokens,
        outputTokens: tokensOut,
      },
    },
    budget: {
      costUsd,
      maxCostUsd: budgetCapUsd,
      costPercent: Math.min(100, Math.round((costUsd / budgetCapUsd) * 100)),
      stepsDone,
      maxSteps,
      stepsPercent: Math.min(100, Math.round((stepsDone / maxSteps) * 100)),
      totalTokens,
    },
  });
});

/**
 * Fold trace events into ONE span row per spanId.
 *
 * A span is reported as two events — `agent.start` when work begins and
 * `agent.end` when it finishes, sharing a spanId. Emitting one row per EVENT
 * produced two rows with the same id, and got the second one's timing wrong:
 * it set t0 to the END timestamp and t1 to end + durationMs, placing every
 * finished span in the future by its own duration.
 *
 * The visible cost was that the dashboard could not show concurrency. Three
 * steps that genuinely ran in parallel rendered as three zero-width marks at
 * t0 plus three bars in the wrong place, so overlapping work — the thing the
 * timeline exists to show — was invisible. Folding start+end into one row with
 * a real [t0, t1] interval is what makes parallel execution legible.
 *
 * A span with a start and no end is still RUNNING; it gets t1: null, which the
 * dashboard already renders as an open bar. That is how live and finished
 * tasks share one view (PS 11c).
 */
interface SpanRow {
  id: string; task_id: string; parent_id: string | null; kind: string; name: string;
  t0: number; t1: number | null; status: string;
  tokens_in: number; tokens_out: number; cost_usd: number;
  model: string; provider: string; meta: Record<string, unknown>;
}

export function mergeSpans(events: TraceEvent[], taskId: string): SpanRow[] {
  const byId = new Map<string, SpanRow>();
  const order: string[] = [];

  for (const e of events) {
    const id = e.spanId || String(e.id);
    const isEnd = e.kind.endsWith(".end");
    const existing = byId.get(id);

    if (!existing) {
      order.push(id);
      byId.set(id, {
        id,
        task_id: taskId,
        parent_id: e.parentId ?? null,
        kind: e.kind,
        name: e.label || e.kind,
        t0: e.at,
        // A lone .end (its .start was lost to a restart) still yields a real
        // interval by walking back over its own duration.
        t1: isEnd ? e.at : e.durationMs ? e.at + e.durationMs : null,
        status: isEnd ? "done" : "running",
        tokens_in: e.tokensIn || 0,
        tokens_out: e.tokensOut || 0,
        cost_usd: e.costUsd || 0,
        model: e.model || "engine/small",
        provider: "local-proxy",
        meta: buildSpanMeta(e),
      });
      if (!existing && isEnd && e.durationMs) byId.get(id)!.t0 = e.at - e.durationMs;
      continue;
    }

    // Second event for a known span: extend the interval and accumulate.
    existing.t0 = Math.min(existing.t0, e.at);
    if (isEnd) {
      existing.t1 = e.at;
      existing.status = "done";
      // The end event carries the outcome; its label is the useful one.
      if (e.label) existing.name = e.label;
    } else if (e.durationMs) {
      existing.t1 = Math.max(existing.t1 ?? 0, e.at + e.durationMs);
    }
    existing.tokens_in += e.tokensIn || 0;
    existing.tokens_out += e.tokensOut || 0;
    existing.cost_usd += e.costUsd || 0;
    if (e.model) existing.model = e.model;
    existing.parent_id = existing.parent_id ?? e.parentId ?? null;
    // Merge meta so an end event's output joins the start event's input.
    existing.meta = { ...existing.meta, ...buildSpanMeta(e) };
  }

  const rows = order.map((id) => byId.get(id)!);

  // Close everything once the task has ended.
  //
  // task.start and task.end are emitted as SEPARATE spans (each gets a fresh
  // id), so the opener never received an end event and stayed status:"running"
  // forever. Two visible consequences: a finished task's root node reported
  // RUNNING in the detail panel, and the timeline treated its t1 as "now" —
  // stretching the window to hours and shattering lane packing into hundreds
  // of lanes, which hid the real bars completely.
  //
  // Nothing can still be running after the task ended, so any span left open
  // is clamped to the terminal timestamp. Live tasks have no task.end and are
  // untouched, which is what keeps the running and finished views identical.
  const terminal = rows.reduce<number | null>(
    (acc, r) => (r.kind === "task.end" ? Math.max(acc ?? 0, r.t1 ?? r.t0) : acc),
    null,
  );
  if (terminal !== null) {
    for (const r of rows) {
      if (r.t1 === null) {
        r.t1 = Math.max(r.t0, terminal);
        r.status = "done";
      }
    }
  }
  return rows;
}

/**
 * Span meta for the dashboard.
 *
 * Most kinds carry their payload under meta.input / meta.output. The
 * context.snapshot kind is different: SpanDetail reads `meta.context_snapshot`
 * and `meta.files` FLAT (see web/src/dev/mockData.ts for the contract), so its
 * payload is lifted out of `input` here. Without this the Context tab stayed
 * empty even once the orchestrator started emitting snapshots.
 */
function buildSpanMeta(e: { kind: string; input?: unknown; output?: unknown }): Record<string, unknown> {
  const base: Record<string, unknown> = e.input || e.output ? { input: e.input, output: e.output } : {};
  if (e.kind === "context.snapshot" && e.input && typeof e.input === "object") {
    const payload = e.input as Record<string, unknown>;
    if (payload.context_snapshot !== undefined) base.context_snapshot = payload.context_snapshot;
    if (payload.files !== undefined) base.files = payload.files;
    if (payload.total_tokens !== undefined) base.total_tokens = payload.total_tokens;
  }
  return base;
}

// Authoritative Canonical Event Stream (REST backfill).
// Rows come ONLY from the canonical event store for the resolved session,
// ordered by cursor ASC, one canonical DTO per row:
//   { id: cursor, cursor, eventId, taskId, sessionId, ts, createdAt, type, payload }
// ?after=<cursor> (and legacy ?since=) filter to cursor > after. Sessions that
// predate the store (empty journal) get a deterministic legacy backfill from
// the durable sources (task record, session messages, traces.jsonl) with
// synthetic cursors 1..n — once a session has store rows, the store alone is
// served, so live and history can never diverge again.
app.get("/api/tasks/:id/events", (c) => {
  const id = c.req.param("id");
  const sinceRaw = Number(c.req.query("after") ?? c.req.query("since") ?? 0);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const hit = findSessionByAnyId(id);
  if (!hit) return c.json([]);
  const { s, pid, matchedTaskId } = hit;
  // RC1: a row's taskId fallback honors the REQUESTED identity — for an
  // archived pastTasks id that is the archived id itself, NOT the session's
  // current task (misattribution made the web match dead frames wrongly).
  const taskId = matchedTaskId ?? s.task?.id ?? s.id;
  // Store-backed sessions: serve store rows only (even when the `after` cursor
  // filters everything out — an empty array is the honest answer, never a
  // fall back to resynthesized history).
  if (eventStore.getLatestCursor(s.id) > 0) {
    const rows = eventStore.getEvents(s.id, since);
    return c.json(rows.map((e) => toEventDto(e, taskId)));
  }
  // Legacy backfill for sessions created before the canonical store.
  const legacy = legacyEvents({
    sessionId: s.id,
    taskId,
    task: s.task,
    messages: s.messages,
    traces: trace.getEvents(s.id),
    projectId: pid,
  });
  return c.json(since > 0 ? legacy.filter((e) => e.id > since) : legacy);
});

interface HunkDto {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  status: "pending" | "accepted" | "rejected";
  reason?: string;
}

interface ProposalDto {
  id: string;
  task_id: string;
  path: string;
  base_sha: string;
  diff_text: string;
  hunks: HunkDto[];
  status: "pending" | "partial" | "resolved" | "applied" | "discarded";
}

function toProposalDtos(p: ChangeProposal): ProposalDto[] {
  if (!p.files || p.files.length === 0) {
    return [{
      id: p.id,
      task_id: p.taskId ?? p.sessionId,
      path: p.rationale || "(no files modified)",
      base_sha: "",
      diff_text: "",
      hunks: [],
      status: p.status === "rejected" ? "discarded" : p.status === "pending" ? "pending" : "applied",
    }];
  }

  return p.files.map((f, fileIdx) => {
    const hunks: HunkDto[] = f.hunks.map((h) => {
      const match = h.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      // groups 1 and 3 are guaranteed by the regex above when match is non-null
      const oldStart = match ? parseInt(match[1]!, 10) : 1;
      const oldLines = match && match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = match ? parseInt(match[3]!, 10) : 1;
      const newLines = match && match[4] !== undefined ? parseInt(match[4], 10) : 1;
      const lines = h.lines.map((l) => {
        const prefix = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
        return prefix + l.text;
      });
      return {
        // B6: the hunk DTO id stays the BARE hunkIndex — web prefixes the file
        // index itself and PATCHes `${fileIdx}_${hunkIdx}` (DiffReview B6).
        id: `${h.hunkIndex}`,
        header: h.header,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines,
        // B5: per-hunk decisions win once persisted; until then derive from
        // the whole-proposal status (legacy behavior).
        status: h.status ?? (p.status === "rejected" ? "rejected" : p.status === "applied" ? "accepted" : "pending"),
        ...(h.reason ? { reason: h.reason } : {}),
      };
    });

    return {
      id: p.files.length === 1 ? p.id : `${p.id}_${fileIdx}`,
      task_id: p.taskId ?? p.sessionId,
      path: f.path,
      base_sha: "",
      diff_text: f.summary ?? "",
      hunks,
      status: p.status === "rejected" ? "discarded" : p.status === "pending" ? "pending" : "applied",
    };
  });
}

app.get("/api/tasks/:id/proposals", (c) => {
  const id = c.req.param("id");
  for (const [pid] of sessions.projectRoots()) {
    for (const s of sessions.listSessions(pid)) {
      if (s.id === id || s.task?.id === id) {
        const raw = listProposals(s.id);
        return c.json(raw.flatMap(toProposalDtos));
      }
    }
  }
  return c.json([]);
});


// ── sessions (project scoped) ─────────────────────────────────────────────
app.get("/api/projects/:pid/sessions", (c) => c.json(sessions.listSessions(c.req.param("pid"))));
app.post("/api/projects/:pid/sessions", (c) => {
  const s = sessions.newSession(c.req.param("pid"));
  wire.emit({ type: "session", session: s });
  return c.json(s);
});
app.get("/api/projects/:pid/sessions/:sid", (c) => {
  if (!idsValid(c.req.param("pid"), c.req.param("sid"))) return c.json({ error: "invalid id" }, 400);
  const s = sessions.getSession(c.req.param("pid"), c.req.param("sid"));
  return s ? c.json(s) : c.json({ error: "not found" }, 404);
});
app.delete("/api/projects/:pid/sessions/:sid", (c) => {
  if (!idsValid(c.req.param("pid"), c.req.param("sid"))) return c.json({ error: "invalid id" }, 400);
  const sid = c.req.param("sid");
  if (isRunning(sid)) stopTask(sid);
  sessions.markSessionDeleted(sid);
  const dir = path.join(DATA_DIR, "projects", c.req.param("pid"), "sessions");
  try {
    fs.rmSync(path.join(dir, `${sid}.json`));
  } catch {}
  wire.emit({ type: "status", sessionId: sid, status: "session-deleted" });
  return c.json({ ok: true });
});

// Manual context pins (PS requirement #7). Pins are stored ON THE ACTIVE
// SESSION's contextRefs (source:"user") so they actually reach the model —
// the old in-memory-only array was a dead store: lost on restart, not
// project-scoped, and never consulted by prompt assembly. The array response
// shape is kept for the ContextPanel; rows mirror back from every session in
// the current project so the UI sees what the agent sees.
function projectContextPins(projectId: string): Array<{ path: string; start_line?: number; end_line?: number; label?: string }> {
  const out: Array<{ path: string; start_line?: number; end_line?: number; label?: string }> = [];
  for (const s of sessions.listSessions(projectId)) {
    for (const r of s.contextRefs) {
      if (r.source !== "user") continue;
      if (out.some((p) => p.path === r.path && p.start_line === r.startLine && p.end_line === r.endLine)) continue;
      out.push({ path: r.path, start_line: r.startLine, end_line: r.endLine });
    }
  }
  return out;
}

function currentProjectId(): string {
  return projectIdFor(path.resolve(currentProjectRoot || process.cwd()));
}

app.get("/api/context/pins", (c) => {
  return c.json(projectContextPins(currentProjectId()));
});

app.post("/api/context/pins", async (c) => {
  try {
    const body = await c.req.json();
    if (body && typeof body.path === "string") {
      // Register on the most recent session of the current project so the pin
      // lands in the agent's context (resolvePinnedRefs reads contextRefs).
      const pid = currentProjectId();
      const target = body.sessionId
        ? sessions.getSession(pid, String(body.sessionId))
        : sessions.listSessions(pid)[0];
      if (target) {
        const exists = target.contextRefs.some(
          (r) => r.source === "user" && r.path === body.path && r.startLine === body.start_line && r.endLine === body.end_line,
        );
        if (!exists) {
          const start = body.start_line ? Number(body.start_line) : undefined;
          const end = body.end_line ? Number(body.end_line) : undefined;
          const ref: ContextRef = {
            kind: start !== undefined || end !== undefined ? "lines" : "file",
            path: String(body.path),
            ...(start !== undefined ? { startLine: start } : {}),
            ...(end !== undefined ? { endLine: end } : {}),
            source: "user",
          };
          target.contextRefs.push(ref);
          sessions.saveSession(target);
        }
      }
    }
    return c.json(projectContextPins(currentProjectId()));
  } catch (e: any) {
    return c.json({ error: String(e) }, 400);
  }
});

app.delete("/api/context/pins/:idx", (c) => {
  const idx = parseInt(c.req.param("idx"), 10);
  if (!isNaN(idx) && idx >= 0) {
    // Mirror-delete from every session in the current project (the pin list
    // is project-wide; the index maps to the merged view).
    const pid = currentProjectId();
    const merged = projectContextPins(pid);
    const victim = merged[idx];
    if (victim) {
      for (const s of sessions.listSessions(pid)) {
        const before = s.contextRefs.length;
        s.contextRefs = s.contextRefs.filter(
          (r) => !(r.source === "user" && r.path === victim.path && r.startLine === victim.start_line && r.endLine === victim.end_line),
        );
        if (s.contextRefs.length !== before) sessions.saveSession(s);
      }
    }
  }
  return c.json(projectContextPins(currentProjectId()));
});

app.put("/api/projects/:pid/sessions/:sid/context", async (c) => {
  if (!idsValid(c.req.param("pid"), c.req.param("sid"))) return c.json({ error: "invalid id" }, 400);
  const { add, remove } = (await c.req.json()) as { add?: ContextRef[]; remove?: ContextRef[] };
  const s = sessions.getSession(c.req.param("pid"), c.req.param("sid"));
  if (!s) return c.json({ error: "not found" }, 404);
  for (const r of add ?? []) {
    if (!s.contextRefs.find((x) => x.path === r.path && x.startLine === r.startLine && x.endLine === r.endLine))
      s.contextRefs.push(r);
  }
  for (const r of remove ?? []) {
    s.contextRefs = s.contextRefs.filter(
      (x) => !(x.path === r.path && x.startLine === r.startLine && x.endLine === r.endLine),
    );
  }
  sessions.saveSession(s);
  wire.emit({ type: "session", session: s });
  return c.json({ ok: true, refs: s.contextRefs });
});

app.post("/api/projects/:pid/sessions/:sid/prompt", async (c) => {
  if (!idsValid(c.req.param("pid"), c.req.param("sid"))) return c.json({ error: "invalid id" }, 400);
  const { text, refs } = (await c.req.json()) as { text: string; refs?: ContextRef[] };
  if (!text?.trim()) return c.json({ error: "text required" }, 400);
  const pid = c.req.param("pid");
  const s = sessions.getSession(pid, c.req.param("sid"));
  if (!s) return c.json({ error: "not found" }, 404);
  if (isRunning(s.id)) return c.json({ error: "task already running" }, 409);
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    refs: refs ?? [],
    at: Date.now(),
  };
  s.messages.push(msg);
  if (refs?.length) for (const r of refs) if (!s.contextRefs.find((x) => x.path === r.path && x.startLine === r.startLine)) s.contextRefs.push({ ...r, source: "user" });
  if (s.title === "New session") s.title = text.slice(0, 60);
  sessions.saveSession(s);
  // Authoritative canonical logging (see POST /api/tasks).
  eventStore.append(
    s.id,
    "message",
    { type: "message", sessionId: s.id, message: msg },
    { id: msg.id, taskId: s.task?.id, projectId: pid, createdAt: msg.at },
  );

  void runTask(sessions.getSession(pid, s.id)!, msg).catch((err: unknown) => {
    trace.emit({
      sessionId: s.id,
      spanId: crypto.randomUUID(),
      kind: "error",
      label: "runTask crashed",
      input: err instanceof Error ? (err.stack ?? err.message) : String(err).slice(0, 2000),
    });
  });
  return c.json({ ok: true });
});

app.post("/api/projects/:pid/sessions/:sid/stop", (c) => {
  const sid = c.req.param("sid");
  if (!idsValid(sid)) return c.json({ error: "invalid id" }, 400);
  stopTask(sid);
  return c.json({ ok: true });
});

app.post("/api/projects/:pid/sessions/:sid/resume", (c) => {
  const sid = c.req.param("sid");
  if (!idsValid(sid)) return c.json({ error: "invalid id" }, 400);
  void resumeAfterApproval(sid).catch(() => {});
  return c.json({ ok: true });
});

// ── approvals ─────────────────────────────────────────────────────────────
app.get("/api/approvals/pending", (c) => {
  // Folder isolation: the chat-pane panel polls with the CURRENT project so a
  // pending approval from another folder never prompts here. No param = the
  // global list (settings modal back-compat).
  const pid = c.req.query("projectId");
  if (!pid) return c.json(listAllPending());
  const all = listAllPending();
  const scoped = all.filter((a) => findSessionByAnyId(a.sessionId)?.pid === pid);
  return c.json(scoped);
});

app.get("/api/approvals", (c) => {
  const sid = c.req.query("sessionId");
  return c.json(sid ? listRecent(sid) : listAllPending());
});

/**
 * Approval decision — shared by PATCH /api/approvals/:id and
 * POST /api/approvals/:id/decision.
 *
 * Both keys are accepted (`approve` and `approved`) because both are already
 * in use by different clients, and a MISSING/invalid value is a 400 rather than
 * a silent deny.
 *
 * Defaulting to deny was a real bug: the two routes had different contracts
 * (PATCH took either key, POST took only `approved`), so a client sending
 * `{approve:true}` to the POST route had it read as undefined → false → the
 * write was rejected while the caller believed it had approved. On an approval
 * gate a silent deny is the worst possible failure mode: the human says yes,
 * the agent is told no, and the step fails for a reason nothing reports.
 */
export function readApprovalDecision(body: unknown): boolean | null {
  const b = (body ?? {}) as { approve?: unknown; approved?: unknown };
  if (typeof b.approve === "boolean") return b.approve;
  if (typeof b.approved === "boolean") return b.approved;
  return null;
}

async function handleApprovalDecision(c: any) {
  const decision = readApprovalDecision(await c.req.json().catch(() => ({})));
  if (decision === null) {
    return c.json({ error: 'body must contain a boolean "approve" (or "approved")' }, 400);
  }
  const a = getApproval(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const decided = decideApproval(c.req.param("id"), decision);
  if (!decided) return c.json({ error: "not found" }, 404);
  return c.json(decided);
}

app.patch("/api/approvals/:id", handleApprovalDecision);

app.post("/api/approvals/:id/decision", handleApprovalDecision);

// ── proposals / diff review ───────────────────────────────────────────────
function projectRootForSession(sessionId: string): string | undefined {
  if (!idsValid(sessionId)) return undefined;
  for (const [pid, root] of sessions.projectRoots()) {
    if (!idsValid(pid)) continue;
    if (sessions.getSession(pid, sessionId)?.id === sessionId) return root;
  }
  return undefined;
}

function totalHunks(p: ChangeProposal): number {
  return p.files.reduce((n, f) => n + f.hunks.length, 0);
}

app.get("/api/proposals/:sessionId", (c) => {
  if (!idsValid(c.req.param("sessionId"))) return c.json([]);
  const raw = listProposals(c.req.param("sessionId"));
  return c.json(raw.flatMap(toProposalDtos));
});

app.post("/api/proposals/:id/apply", async (c) => {
  const rawId = c.req.param("id");
  const propId = rawId.split("_")[0] ?? "";
  const body = (await c.req.json()) as { acceptedHunks?: Record<string, number[]>; rejectAll?: boolean };
  const p = getProposal(propId);
  if (!p) return c.json({ error: "not found" }, 404);
  if (p.status === "rejected") return c.json({ error: "proposal already rejected" }, 409);
  const root = projectRootForSession(p.sessionId) || process.cwd();
  const jailed = { ...p, files: p.files.filter((fd) => inRoot(root, path.resolve(root, fd.path))) };
  const result = applyProposalPartial(jailed, root, body.rejectAll ? undefined : body.acceptedHunks ?? {}, !!body.rejectAll);
  let updated: ChangeProposal | undefined = p;
  if (body.rejectAll) {
    updated = updateProposal(p.id, { status: "rejected" });
  } else if (result.appliedCount > 0) {
    updated = updateProposal(p.id, {
      status: result.appliedCount >= totalHunks(jailed) ? "applied" : "partially-applied",
    });
  }
  if (!updated) return c.json({ error: "proposal vanished" }, 409);
  if (updated !== p) wire.emit({ type: "proposal", proposal: updated });
  return c.json(result);
});

// Granular hunk resolution (B5 + B6).
// B6: web addresses hunks as `${fileIdx}_${hunkIdx}` (route param may look
// like "2_0") — the decision applies ONLY to p.files[fileIdx]. Legacy clients
// sending a bare numeric hid get the old behavior: first file containing that
// hunkIndex wins. pid may be the bare proposal id or the per-file DTO id
// `${p.id}_${fileIdx}` (proposal ids are UUIDs — no underscores — so the
// split is safe).
// B5: accept BOTH { accept } and { accepted }; decisions persist per hunk
// (DiffHunk.status/reason in types.ts) — including REJECT, which used to be
// a no-op — and the response is the full updated ProposalDto via
// toProposalDtos so web's replaceProposal matches by id.
app.patch("/api/proposals/:pid/hunks/:hid", async (c) => {
  const rawPid = c.req.param("pid");
  const pid = rawPid.split("_")[0] ?? "";
  const rawHid = c.req.param("hid");
  const body = (await c.req.json().catch(() => ({}))) as { accept?: boolean; accepted?: boolean; reason?: string };
  const accept = body.accept ?? body.accepted ?? false;
  const p = getProposal(pid);
  if (!p) return c.json({ error: "proposal not found" }, 404);

  // B6: parse file-scoped addressing with legacy numeric fallback.
  let fileIdx = -1;
  let hunkIdx = NaN;
  const scoped = rawHid.match(/^(\d+)_(\d+)$/);
  if (scoped) {
    fileIdx = Number(scoped[1]);
    hunkIdx = Number(scoped[2]);
  } else {
    hunkIdx = Number(rawHid);
    if (Number.isFinite(hunkIdx)) {
      fileIdx = p.files.findIndex((f) => f.hunks.some((h) => h.hunkIndex === hunkIdx));
    }
  }
  const file = fileIdx >= 0 ? p.files[fileIdx] : undefined;
  const hunk = file?.hunks.find((h) => h.hunkIndex === hunkIdx);
  if (!file || !hunk) return c.json({ error: "hunk not found" }, 404);

  const root = projectRootForSession(p.sessionId) || process.cwd();
  if (accept) {
    // Apply ONLY the addressed file/hunk (jailed proposal copy).
    const result = applyProposalPartial({ ...p, files: [file] }, root, { [file.path]: [hunkIdx] }, false);
    const skipped = result.skipped.find((sk) => sk.path === file.path && sk.hunkIndex === hunkIdx);
    if (result.appliedCount === 0 && skipped) {
      return c.json({ error: `hunk not applied: ${skipped.reason}` }, 409);
    }
  }

  // B5: persist the per-hunk decision (IMMUTABLY — getProposal returns a
  // fresh disk parse, and updateProposal may merge into a different in-memory
  // object, so mutating the local copy would be lost).
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined;
  const files = p.files.map((f, i) =>
    i !== fileIdx
      ? f
      : {
          ...f,
          hunks: f.hunks.map((h) =>
            h.hunkIndex !== hunkIdx
              ? h
              : { ...h, status: accept ? ("accepted" as const) : ("rejected" as const), ...(reason ? { reason } : {}) },
          ),
        },
  );
  // Proposal status follows the per-hunk ledger.
  const allHunks = files.flatMap((f) => f.hunks);
  const acceptedCount = allHunks.filter((h) => h.status === "accepted").length;
  const rejectedCount = allHunks.filter((h) => h.status === "rejected").length;
  const status: ChangeProposal["status"] =
    allHunks.length === 0
      ? p.status
      : acceptedCount === allHunks.length
        ? "applied"
        : acceptedCount + rejectedCount === allHunks.length && acceptedCount === 0
          ? "rejected"
          : acceptedCount > 0
            ? "partially-applied"
            : "pending";
  const updated = updateProposal(p.id, { status, files });
  if (!updated) return c.json({ error: "proposal vanished" }, 409);
  wire.emit({ type: "proposal", proposal: updated });
  const dtos = toProposalDtos(updated);
  const dto = dtos.find((d) => d.id === rawPid) ?? dtos[fileIdx] ?? dtos[0];
  return c.json(dto);
});

app.post("/api/proposals/:pid/resolve_all", async (c) => {
  const rawPid = c.req.param("pid");
  const pid = rawPid.split("_")[0] ?? "";
  const body = (await c.req.json()) as { accept?: boolean; rejectAll?: boolean };
  const p = getProposal(pid);
  if (!p) return c.json({ error: "proposal not found" }, 404);
  const root = projectRootForSession(p.sessionId) || process.cwd();
  const accept = body.accept ?? !body.rejectAll;
  if (!accept) {
    const updated = updateProposal(p.id, { status: "rejected" });
    if (updated) wire.emit({ type: "proposal", proposal: updated });
    return c.json({ ok: true, status: "rejected" });
  }
  const result = applyProposalPartial(p, root, undefined, false);
  const updated = updateProposal(p.id, {
    status: result.appliedCount >= totalHunks(p) ? "applied" : "partially-applied",
  });
  if (updated) wire.emit({ type: "proposal", proposal: updated });
  return c.json({ ok: true, result, proposal: updated });
});

// ── checkpoints (wave 26 optimistic execution / reject-and-revert) ────────
// Resolve a task/session id to its project + root + task id (mirrors the
// /api/tasks/:id scan). `id` may be a sessionId or a taskId.
function resolveTaskProject(id: string): { pid: string; root: string; taskId?: string; sessionId?: string } | undefined {
  if (!idsValid(id)) return undefined;
  for (const [pid, root] of sessions.projectRoots()) {
    if (!idsValid(pid)) continue;
    for (const s of sessions.listSessions(pid)) {
      if (s.task?.id === id) return { pid, root, taskId: s.task.id, sessionId: s.id };
      if (s.id === id) return { pid, root, taskId: s.task?.id, sessionId: s.id };
    }
  }
  return undefined;
}

function checkpointDto(cp: { id: string; taskId: string; label: string; createdAt: number; updatedAt: number; reverted?: boolean; revertedAt?: number; files: Record<string, string | null> }) {
  return {
    id: cp.id, taskId: cp.taskId, label: cp.label, createdAt: cp.createdAt, updatedAt: cp.updatedAt,
    reverted: !!cp.reverted, revertedAt: cp.revertedAt,
    files: Object.entries(cp.files).map(([p, pre]) => ({ path: p, existed: pre !== null, bytes: pre === null ? 0 : Buffer.byteLength(pre, "utf8") })),
  };
}

app.get("/api/tasks/:id/checkpoint", (c) => {
  const r = resolveTaskProject(c.req.param("id"));
  if (!r || !r.taskId) return c.json({ checkpoint: null });
  const cp = getCheckpoint(r.pid, r.taskId);
  return c.json({ checkpoint: cp ? checkpointDto(cp) : null });
});

app.post("/api/tasks/:id/revert", (c) => {
  const r = resolveTaskProject(c.req.param("id"));
  if (!r || !r.taskId) return c.json({ error: "task not found" }, 404);
  // Server-side guard (the UI also disables the button): reverting a task that is
  // still writing would restore files out from under the agent → mixed state.
  if (r.sessionId && isRunning(r.sessionId)) return c.json({ error: "task is still running; stop it before reverting" }, 409);
  const res = revertCheckpoint(r.pid, r.taskId, r.root);
  if (!res) return c.json({ error: "no checkpoint for task" }, 404);
  return c.json({ ok: true, taskId: r.taskId, ...res });
});

app.get("/api/checkpoints", (c) => {
  const pid = c.req.query("projectId");
  if (!pid || !idsValid(pid)) return c.json([]);
  return c.json(listCheckpoints(pid).map((cp) => ({
    id: cp.id, taskId: cp.taskId, label: cp.label, createdAt: cp.createdAt, updatedAt: cp.updatedAt,
    reverted: !!cp.reverted, fileCount: Object.keys(cp.files).length,
  })));
});

// ── filesystem & directory browser ────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv"]);

app.get("/api/fs/list", (c) => {
  let qPath = c.req.query("path");
  // Phase 6: default to the current project root, NOT the user's home dir
  // (and never expose `home` in the response — project picker only).
  if (!qPath || qPath === "undefined" || qPath === "null") qPath = currentProjectRoot || process.cwd();
  const abs = path.resolve(qPath);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return c.json({ error: "not a directory", path: abs }, 400);
    }
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const nodes = entries
      .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => {
        const itemAbs = path.join(abs, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(itemAbs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {}
        return {
          name: e.name,
          path: itemAbs,
          isDirectory: e.isDirectory(),
          size,
          mtime,
        };
      })
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    return c.json({
      path: abs,
      parent: path.dirname(abs) !== abs ? path.dirname(abs) : null,
      dirs: nodes.filter((n) => n.isDirectory).map((n) => ({ name: n.name, path: n.path })),
      entries: nodes,
    });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Files routes adapter
function buildRecursiveTree(dir: string, baseDir: string, currentDepth = 0, maxDepth = 6): any[] {
  if (currentDepth > maxDepth) return [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const nodes: any[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const fullPath = path.join(dir, e.name);
      const relPath = path.relative(baseDir, fullPath);
      if (e.isDirectory()) {
        const subChildren = buildRecursiveTree(fullPath, baseDir, currentDepth + 1, maxDepth);
        nodes.push({
          name: e.name,
          path: relPath,
          type: "dir",
          is_dir: true,
          children: subChildren,
        });
      } else {
        nodes.push({
          name: e.name,
          path: relPath,
          type: "file",
          is_dir: false,
        });
      }
    }
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  } catch {
    return [];
  }
}

app.get("/api/files/tree", (c) => {
  const pid = c.req.query("projectId") ?? "";
  const root = (pid && sessions.projectRoots().get(pid)) || currentProjectRoot || process.cwd();
  const tree = buildRecursiveTree(root, root, 0, 6);
  return c.json({ tree, root, entries: tree });
});

app.get("/api/files/content", (c) => {
  const pid = c.req.query("projectId") ?? "";
  const root = (pid && sessions.projectRoots().get(pid)) || currentProjectRoot || process.cwd();
  const rel = c.req.query("path") ?? "";
  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
    if (stat.size > 2_000_000) return c.json({ error: "file too large" }, 413);
    return c.json({ content: fs.readFileSync(abs, "utf8"), size: stat.size, mtime: stat.mtimeMs, path: rel });
  } catch {
    return c.json({ error: "unreadable" }, 404);
  }
});

const handleFileWrite = async (c: any) => {
  const { projectId, path: rel, content, expected_mtime } = (await c.req.json()) as {
    projectId?: string; path: string; content: string; expected_mtime?: number;
  };
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();
  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);

  // B37 save-conflict contract: when the client supplies expected_mtime,
  // refuse to clobber a file that changed on disk since the client read it
  // (e.g. the agent wrote it). 409 + current_mtime (+ current content preview)
  // lets the editor offer overwrite-vs-reload. mtimeMs round-trips exactly
  // through JSON (IEEE754 both ways), so strict equality is sound.
  try {
    const st = fs.statSync(abs);
    if (st.isFile() && typeof expected_mtime === "number" && st.mtimeMs !== expected_mtime) {
      let current: string | undefined;
      try {
        current = fs.readFileSync(abs, "utf8").slice(0, 4000);
      } catch { /* unreadable — conflict info stays mtime-only */ }
      return c.json({
        error: "mtime mismatch",
        current_mtime: st.mtimeMs,
        ...(current !== undefined ? { current } : {}),
      }, 409);
    }
  } catch {
    // missing (or vanishing) file → created below; expected_mtime is moot
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  const mtime = fs.statSync(abs).mtimeMs;
  return c.json({ ok: true, bytes: Buffer.byteLength(content), mtime });
};
app.post("/api/files/write", handleFileWrite);
app.put("/api/files/write", handleFileWrite);

app.post("/api/files/create", async (c) => {
  const { projectId, path: rel, content } = (await c.req.json()) as { projectId?: string; path: string; content?: string };
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();
  const r = newFile(root, rel, content);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
});

const handleFileDelete = async (c: any) => {
  const { projectId, path: rel } = (await c.req.json()) as { projectId?: string; path: string };
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();
  const r = deleteEntry(root, rel);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
};
app.post("/api/files/delete", handleFileDelete);
app.delete("/api/files/delete", handleFileDelete);

app.post("/api/files/rename", async (c) => {
  const { projectId, path: from, newName: to, from: fromAlt, to: toAlt } = (await c.req.json()) as any;
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();
  const src = from || fromAlt;
  const dest = to || toAlt;
  const r = renameEntry(root, src, dest);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
});

// ── POST /api/run — execute or preview the active file ─────────────────────
// B17 hardening: this endpoint used to spawn a caller-supplied `cmd` directly
// with the engine's FULL process.env — an unguarded execution primitive any
// local process (or malicious web page via localhost) could invoke. Now:
//   (a) raw caller-supplied `cmd` support is REMOVED — only the server-side
//       interpreter-by-extension table below can pick a binary. Full approval
//       gating for custom commands is deferred to the contract wave (it
//       belongs on the run_command tool gate in tools.ts, which this wave
//       must not edit); until then /api/run simply refuses raw commands.
//   (b) children get a scrubbed env: a small PATH/HOME/LANG/TERM-style
//       whitelist, minus anything whose name smells like a credential
//       (mirrors tools.ts scrubEnv, replicated locally because tools.ts is
//       read-only for this wave).
//   (c) stdout and stderr buffers are each capped at 1 MB.
const RUN_ENV_KEEP = [
  "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR",
  // Windows essentials
  "SystemRoot", "SYSTEMROOT", "COMSPEC", "comspec", "PATHEXT", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMDRIVE", "USERNAME", "OS"
];
const RUN_ENV_DROP_RE = /KEY|TOKEN|SECRET/i;
function scrubRunEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of RUN_ENV_KEEP) {
    if (RUN_ENV_DROP_RE.test(k)) continue; // defense-in-depth
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (process.platform === "win32") {
    if (!env.SystemRoot && process.env.SystemRoot) {
      env.SystemRoot = process.env.SystemRoot;
    }
    if (fs.existsSync("C:\\mingw64\\bin") && (!env.PATH || !env.PATH.includes("mingw64"))) {
      env.PATH = `C:\\mingw64\\bin;${env.PATH || ""}`;
    }
  }
  // A file run from the editor must not be able to block on a pager, a git
  // credential prompt, or $EDITOR — nobody is watching that process's stdin.
  return { ...env, ...NON_INTERACTIVE_ENV };
}
const RUN_STREAM_CAP = 1_000_000; // 1 MB per stream

app.post("/api/run", async (c) => {
  const { path: rel, projectId, cmd, timeout_s = 30 } = (await c.req.json()) as {
    path?: string; projectId?: string; cmd?: string; timeout_s?: number;
  };
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();

  // B17: raw caller-supplied commands are no longer executed (see block comment).
  if (cmd) {
    return c.json({
      ok: false,
      cmd: "run",
      output: "raw cmd execution is disabled on /api/run (B17 hardening); the interpreter is chosen by file extension",
      code: 1,
    }, 400);
  }

  // If no file path — nothing to run
  if (!rel) return c.json({ ok: false, cmd: "run", output: "no file path provided", code: 1 });

  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs)) return c.json({ ok: false, cmd: "run", output: "path outside workspace", code: 1 });
  if (!fs.existsSync(abs)) return c.json({ ok: false, cmd: "run", output: `file not found: ${rel}`, code: 1 });

  const ext = path.extname(rel).toLowerCase();

  // HTML/CSS — just return a preview URL (Vite serves files via /api/preview)
  if (ext === ".html" || ext === ".css") {
    // Serve as static file via the engine's own static handler isn't set up,
    // but we can tell the UI to open it in the iframe preview.
    const previewUrl = `/api/preview?path=${encodeURIComponent(rel)}&projectId=${encodeURIComponent(projectId ?? "")}`;
    return c.json({ ok: true, cmd: "preview", output: previewUrl, code: 0, previewUrl });
  }

  // Pick interpreter based on extension (server-controlled table only — B17)
  let command: string;
  let args: string[];
  const isWin = process.platform === "win32";

  if (ext === ".py") {
    // Windows installs Python as `python.exe` (or `py.exe`), whereas Unix typically uses `python3`
    command = isWin ? "python" : "python3";
    args = [abs];
  } else if (ext === ".js" || ext === ".mjs") {
    command = "node"; args = [abs];
  } else if (ext === ".ts") {
    command = "bun"; args = ["run", abs];
  } else if (ext === ".sh") {
    command = isWin ? "powershell.exe" : "bash";
    args = isWin ? ["-File", abs] : [abs];
  } else if (ext === ".cpp" || ext === ".cc" || ext === ".c") {
    const compiler = ext === ".c" ? "gcc" : "g++";
    const outExe = path.join(path.dirname(abs), `.${path.basename(abs, ext)}.out${isWin ? ".exe" : ""}`);
    const timeoutMs = Math.min(Math.max(timeout_s, 5), 120) * 1000;

    return new Promise<Response>((resolve) => {
      const comp = spawn(compiler, [abs, "-o", outExe], { cwd: root, env: scrubRunEnv(), windowsHide: true });
      let compErr = "";
      comp.stderr.on("data", (d) => compErr += d.toString());
      comp.stdout.on("data", (d) => compErr += d.toString());
      comp.on("error", (err) => {
        resolve(c.json({ ok: false, cmd: `${compiler} "${abs}"`, output: `Compiler error: ${err.message}\n\n[Make sure MinGW-w64 is installed at C:\\mingw64 or in PATH]`, code: 1 }));
      });
      comp.on("close", (code) => {
        if (code !== 0) {
          return resolve(c.json({ ok: false, cmd: `${compiler} "${abs}"`, output: compErr || `Compilation failed (code ${code})`, code: code ?? 1 }));
        }
        const runProc = spawn(outExe, [], { cwd: root, env: scrubRunEnv(), windowsHide: true });
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let outLen = 0;
        let errLen = 0;
        const timer = setTimeout(() => {
          runProc.kill("SIGKILL");
          try { if (fs.existsSync(outExe)) fs.unlinkSync(outExe); } catch {}
          resolve(c.json({ ok: false, cmd: path.basename(outExe), output: `timed out after ${timeout_s}s`, code: 124 }));
        }, timeoutMs);

        runProc.stdout.on("data", (d: Buffer) => {
          if (outLen < RUN_STREAM_CAP) { outChunks.push(d); outLen += d.length; }
        });
        runProc.stderr.on("data", (d: Buffer) => {
          if (errLen < RUN_STREAM_CAP) { errChunks.push(d); errLen += d.length; }
        });
        runProc.on("close", (runCode) => {
          clearTimeout(timer);
          try { if (fs.existsSync(outExe)) fs.unlinkSync(outExe); } catch {}
          const output = Buffer.concat([...outChunks, ...errChunks]).toString("utf8").slice(0, 20000);
          resolve(c.json({ ok: runCode === 0, cmd: `${compiler} & run`, output: output || "[Program finished with exit code 0]", code: runCode ?? 0 }));
        });
        runProc.on("error", (err) => {
          clearTimeout(timer);
          try { if (fs.existsSync(outExe)) fs.unlinkSync(outExe); } catch {}
          resolve(c.json({ ok: false, cmd: path.basename(outExe), output: `Execution error: ${err.message}`, code: 1 }));
        });
      });
    });
  } else {
    return c.json({ ok: false, cmd: "run", output: `no runner for ${ext} files`, code: 1 });
  }

  const timeoutMs = Math.min(Math.max(timeout_s, 5), 120) * 1000;
  const cmdStr = [command, ...args].join(" ");

  return new Promise<Response>((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const proc = spawn(command, args, { cwd: root, env: scrubRunEnv(), windowsHide: true });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(c.json({ ok: false, cmd: cmdStr, output: `timed out after ${timeout_s}s`, code: 124 }));
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => {
      if (outLen < RUN_STREAM_CAP) { outChunks.push(d); outLen += d.length; }
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (errLen < RUN_STREAM_CAP) { errChunks.push(d); errLen += d.length; }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat([...outChunks, ...errChunks])
        .toString("utf8")
        .slice(0, 20000);
      resolve(c.json({ ok: code === 0, cmd: cmdStr, output, code: code ?? 1 }));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(c.json({ ok: false, cmd: cmdStr, output: `spawn error: ${err.message}`, code: 1 }));
    });
  });
});

// ── GET /api/router/status — transparency proxy for the local router ────────
// De-blackbox: surface the router's own /routes introspection (routing policy,
// S/M/L tier contents, and per-provider health / key / rate-limit state) to the
// web UI through the engine, so the "Local Router" is not an opaque box. Always
// returns 200 with a `reachable` flag — an unreachable router is a UI state to
// show, not an exception to throw.
// Multi-key management proxied to the router (which owns the key store).
app.get("/api/router/keys", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${routerRoot}/keys`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return c.json({ error: `router HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.post("/api/router/keys", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const res = await fetch(`${routerRoot}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return c.json((await res.json()) as object, res.ok ? 200 : 502);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.delete("/api/router/keys/:provider/:slot", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(
      `${routerRoot}/keys/${encodeURIComponent(c.req.param("provider"))}/${encodeURIComponent(c.req.param("slot"))}`,
      { method: "DELETE", signal: AbortSignal.timeout(5_000) },
    );
    return c.json((await res.json()) as object, res.ok ? 200 : 502);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// Free-tier lock (router policy) proxied so the browser talks to one origin.
// GET reports the live state; POST {on:boolean} flips it.
app.get("/api/router/free-tier", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${routerRoot}/policy/free-tier`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return c.json({ error: `router HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * Ask the vision model about attached images.
 *
 * The result is TEXT that then flows into the normal agent pipeline, rather
 * than images being threaded through every stage. That is deliberate: the
 * planner, coder and reviewer are text models chosen by tier, and only one
 * catalogued model can see an image at all. Describing once and passing the
 * description forward keeps the image on the one model able to read it, and
 * costs a single extra call instead of re-sending megabytes of base64 to every
 * subsequent step.
 *
 * The trade-off is real and worth stating: whatever the vision model fails to
 * mention is invisible to everything downstream. So the prompt asks for a
 * literal transcription of the image rather than an interpretation of it.
 */
app.post("/api/vision", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; images?: string[] };
  const images = (body.images ?? []).filter((u) => typeof u === "string" && u.startsWith("data:image/"));
  if (images.length === 0) return c.json({ error: "at least one data:image/... URL required" }, 400);

  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  let visionModel = "";
  try {
    const caps = (await (await fetch(`${routerRoot}/capabilities`, { signal: AbortSignal.timeout(5_000) })).json()) as
      { vision?: { model?: string; key_present?: boolean } | null };
    if (!caps.vision) return c.json({ error: "no vision model is configured" }, 501);
    if (!caps.vision.key_present) return c.json({ error: "vision model has no API key — add one in Settings" }, 401);
    visionModel = String(caps.vision.model ?? "");
  } catch (e) {
    return c.json({ error: `router unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  const ask = (body.prompt ?? "").trim() ||
    "Describe this image precisely and completely. If it contains code, an error " +
    "message, a stack trace, a terminal session or a UI, transcribe the text verbatim. " +
    "Do not speculate about anything not visible.";

  try {
    const res = await fetch(`${DEFAULT_ROUTER_BASE.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-engine-key" },
      body: JSON.stringify({
        model: visionModel,
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: ask },
            // The content-array form matters: NIM accepts an <img src="data:">
            // embed in a plain string too, but silently ignores the image and
            // answers "I can't see images" — a bad request that looks like a
            // model limitation.
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await res.json().catch(() => ({}))) as
      { choices?: { message?: { content?: unknown } }[]; error?: unknown };
    if (!res.ok) return c.json({ error: `vision call failed (${res.status})`, detail: j.error ?? null }, 502);
    const out = j.choices?.[0]?.message?.content;
    return c.json({
      text: typeof out === "string" ? out : "",
      model: visionModel,
      route: res.headers.get("x-engine-route"),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * The configured role -> model assignment, and the live tier catalog.
 *
 * This is the STATIC half of "which model is doing what": what each role is
 * pinned to, and what the tiers hold. The live half — which role is mid-call
 * right now — is derived in the UI from the `route` events it already streams,
 * because those carry both agentRole and the chosen model. Re-deriving that
 * here would mean a second source of truth that could disagree with the trace.
 */
app.get("/api/router/activity", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const [pinsRes, routesRes] = await Promise.all([
      fetch(`${routerRoot}/policy/role-pins`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${routerRoot}/routes`, { signal: AbortSignal.timeout(5_000) }),
    ]);
    const pins = pinsRes.ok ? ((await pinsRes.json()) as { pins?: Record<string, string> }).pins ?? {} : {};
    const routes = routesRes.ok ? ((await routesRes.json()) as { tiers?: unknown }) : {};
    return c.json({ pins, tiers: routes.tiers ?? null });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Which model serves vision / speech, so the composer can name it up front. */
app.get("/api/router/capabilities", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${routerRoot}/capabilities`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return c.json({ error: `router HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * Speech-to-text for the composer's voice button.
 *
 * Streams the upload straight through to the router as multipart rather than
 * buffering it — a few minutes of speech is megabytes, and the long timeout is
 * because that is genuinely how long a long recording takes to transcribe.
 */
app.post("/api/transcribe", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return c.json({ error: "audio file required" }, 400);

  const out = new FormData();
  out.append("file", file);
  const lang = form?.get("language");
  if (typeof lang === "string" && lang) out.append("language", lang);

  try {
    const res = await fetch(`${routerRoot}/v1/audio/transcriptions`, {
      method: "POST",
      body: out,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.post("/api/router/free-tier", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return c.json({ error: 'body must be {"on": true|false}' }, 400);
  try {
    const res = await fetch(`${routerRoot}/policy/free-tier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: body.on }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return c.json({ error: `router HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.get("/api/router/role-pins", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${routerRoot}/policy/role-pins`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return c.json({ error: `router HTTP ${res.status}` }, 502);
    return c.json((await res.json()) as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.post("/api/router/role-pins", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const res = await fetch(`${routerRoot}/policy/role-pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return c.json((await res.json()) as object, res.ok ? 200 : 502);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.get("/api/router/status", async (c) => {
  const routerRoot = DEFAULT_ROUTER_BASE.replace(/\/v1\/?$/, "");
  try {
    const [resRoutes, resKeys] = await Promise.all([
      fetch(`${routerRoot}/routes`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${routerRoot}/keys`, { signal: AbortSignal.timeout(5_000) }).catch(() => null),
    ]);
    if (!resRoutes.ok) return c.json({ reachable: false, routerRoot, error: `router HTTP ${resRoutes.status}` });
    const routes = (await resRoutes.json()) as object;
    let keys: unknown = null;
    if (resKeys && resKeys.ok) {
      try {
        keys = await resKeys.json();
      } catch {
        keys = null;
      }
    }
    return c.json({ reachable: true, routerRoot, ...(routes as object), keys });
  } catch (e) {
    return c.json({ reachable: false, routerRoot, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/websearch — multi-backend web search (DDG → Bing fallback) ─────
// B18. The web_search handler in tools.ts is module-private (only reachable
// through executeTool, which would drag in session/trace/approval machinery),
// so this shares the same searchWeb() from websearch.ts. Returns a JSON array of
// { title, url, snippet } (web's searchWeb expects an array).
app.get("/api/websearch", async (c) => {
  const query = (c.req.query("query") ?? "").trim();
  if (!query) return c.json({ error: "query required" }, 400);
  const results = await searchWeb(query);
  return c.json(results);
});

// ── GET /api/preview — serve a static file from the workspace ──────────────
app.get("/api/preview", (c) => {
  const rel = c.req.query("path") ?? "";
  const projectId = c.req.query("projectId") ?? "";
  const root = (projectId && sessions.projectRoots().get(projectId)) || currentProjectRoot || process.cwd();
  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs) || !fs.existsSync(abs)) return c.text("not found", 404);
  const ext = path.extname(rel).toLowerCase();
  const mime: Record<string, string> = {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif",
  };
  const ct = mime[ext] ?? "text/plain";
  const body = fs.readFileSync(abs);
  return new Response(body, { headers: { "Content-Type": ct } });
});

// Backward-compatible /api/fs endpoints
app.get("/api/fs/tree", async (c) => {
  const pid = c.req.query("projectId") ?? "";
  const root = sessions.projectRoots().get(pid);
  if (!root) return c.json({ error: "no project" }, 400);
  const rel = c.req.query("path") ?? "";
  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const nodes = entries
      .filter((e) => !SKIP_DIRS.has(e.name))
      .slice(0, 300)
      .map((e) => ({
        name: e.name,
        path: path.posix.join(rel, e.name),
        type: e.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return c.json({ entries: nodes });
  } catch {
    return c.json({ entries: [] });
  }
});

app.get("/api/fs/file", (c) => {
  const pid = c.req.query("projectId") ?? "";
  const root = sessions.projectRoots().get(pid);
  if (!root) return c.json({ error: "no project" }, 400);
  const abs = path.resolve(root, c.req.query("path") ?? "");
  if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
    if (stat.size > 1_500_000) return c.json({ error: "file too large" }, 413);
    return c.json({ content: fs.readFileSync(abs, "utf8"), size: stat.size });
  } catch {
    return c.json({ error: "unreadable" }, 404);
  }
});

app.put("/api/fs/file", async (c) => {
  const { projectId, path: rel, content } = (await c.req.json()) as { projectId: string; path: string; content: string };
  const root = sessions.projectRoots().get(projectId);
  if (!root) return c.json({ error: "no project" }, 400);
  const abs = path.resolve(root, rel);
  if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);
  if (!fs.existsSync(path.dirname(abs))) {
    return c.json({ error: "parent directory missing" }, 409);
  }
  fs.writeFileSync(abs, content);
  return c.json({ ok: true, bytes: Buffer.byteLength(content) });
});

app.post("/api/fs/mkdir", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: string;
    path?: string;
    parentPath?: string;
    name?: string;
  };
  const targetPath = body.path || (body.parentPath ? path.join(body.parentPath, body.name || "") : "");
  if (!targetPath) return c.json({ error: "path or (parentPath + name) required" }, 400);

  let abs = "";
  if (body.projectId) {
    const root = sessions.projectRoots().get(body.projectId) || currentProjectRoot || process.cwd();
    abs = path.resolve(root, targetPath);
    if (!inRoot(root, abs)) return c.json({ error: "outside workspace" }, 403);
  } else {
    abs = path.resolve(targetPath);
  }

  try {
    fs.mkdirSync(abs, { recursive: true });
    return c.json({ ok: true, path: abs, name: path.basename(abs) });
  } catch (err: any) {
    return c.json({ error: err.message || "failed to create directory" }, 500);
  }
});

app.post("/api/fs/newfile", async (c) => {
  const { projectId, path: rel, content } = (await c.req.json()) as { projectId: string; path: string; content?: string };
  const root = sessions.projectRoots().get(projectId);
  if (!root) return c.json({ error: "no project" }, 400);
  const r = newFile(root, rel, content);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
});

app.post("/api/fs/rename", async (c) => {
  const { projectId, path: rel, newName } = (await c.req.json()) as { projectId: string; path: string; newName: string };
  const root = sessions.projectRoots().get(projectId);
  if (!root) return c.json({ error: "no project" }, 400);
  const r = renameEntry(root, rel, newName);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
});

app.post("/api/fs/delete", async (c) => {
  const { projectId, path: rel } = (await c.req.json()) as { projectId: string; path: string };
  const root = sessions.projectRoots().get(projectId);
  if (!root) return c.json({ error: "no project" }, 400);
  const r = deleteEntry(root, rel);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error ?? "failed" }, 400);
});

// ── traces ────────────────────────────────────────────────────────────────
app.get("/api/traces/:sessionId", (c) => {
  const sid = c.req.param("sessionId");
  if (!idsValid(sid)) return c.json([]);
  return c.json(loadTraces(sid));
});

// ── SSE hub ───────────────────────────────────────────────────────────────
// Canonical event stream. Replay and live delivery both forward the SAME
// canonical DTO as GET /api/tasks/:id/events, with `id: <cursor>` on every
// frame. Reconnect protocol: the client's last canonical cursor arrives via
// Last-Event-ID (or ?since/?after); we subscribe to the store BEFORE reading
// history, buffer live rows during replay, replay stored rows after the
// cursor, then drain buffered rows newer than the replay high-water and go
// live — no gap, no duplicate, and a transport sequence can never poison the
// cursor. Writes are serialized per client (one awaited chain); a failed
// write marks the stream closed and unsubscribes (no fire-and-forget).
const sseHandler = (c: any) => {
  const reqId = c.req.param("id") || c.req.query("taskId") || c.req.query("sessionId") || c.req.header("x-task-id");
  const lastEventId = c.req.header("Last-Event-ID") || c.req.query("since") || c.req.query("after");
  const sinceCursor = lastEventId ? parseInt(lastEventId, 10) || 0 : 0;

  // Resolve the target task/session identity (task UUID, session id, or an
  // archived pastTask id all map to the owning session) via the SHARED
  // resolver — one id space, one rule. RC1: the taskId fallback honors the
  // requested identity so an archived id's frames are attributed to it.
  let targetSessionId: string | undefined = reqId || undefined;
  let targetTaskId: string | undefined;
  if (reqId) {
    const hit = findSessionByAnyId(reqId);
    if (hit) {
      targetSessionId = hit.s.id;
      targetTaskId = hit.matchedTaskId;
    }
  } else {
    targetSessionId = undefined; // no target → global stream (all sessions)
  }

  return streamSSE(c, async (stream) => {
    let open = true;
    let unsub: () => void = () => {};
    const close = (): void => {
      if (open) {
        open = false;
        unsub();
      }
    };

    // Per-connection serialized write chain: frames leave strictly in cursor
    // order even under backpressure, and a failed write closes the stream.
    let chain: Promise<void> = Promise.resolve();
    const writeCanonical = (ev: CanonicalEvent): Promise<void> => {
      if (!open) return Promise.resolve();
      const dto = toEventDto(ev, targetTaskId ?? targetSessionId);
      const frame = `id: ${ev.cursor}\ndata: ${JSON.stringify(dto)}\n\n`;
      chain = chain.then(async () => {
        if (!open) return;
        try {
          await stream.write(frame);
        } catch {
          close(); // write failed → mark closed + unsubscribe
        }
      });
      return chain;
    };

    // 1. Subscribe BEFORE replaying; buffer live rows while replaying.
    const queue: CanonicalEvent[] = [];
    let replaying = true;
    let highWater = sinceCursor;
    unsub = eventStore.subscribe((ev) => {
      if (!open) return;
      if (replaying) {
        queue.push(ev);
      } else {
        void writeCanonical(ev);
      }
    }, targetSessionId);

    // 2. Replay stored rows after the client's cursor (authoritative store).
    if (targetSessionId) {
      for (const ev of eventStore.getEvents(targetSessionId, sinceCursor)) {
        if (!open) break;
        if (ev.cursor > highWater) highWater = ev.cursor;
        await writeCanonical(ev);
      }
    }

    // 3. Drain buffered rows newer than the high-water mark, then go live.
    //    Enqueue the whole drain into the write chain SYNCHRONOUSLY (no await
    //    between rows): awaiting per-row would yield to the event loop, letting
    //    a live row from a still-running task chain in BEFORE a later queued
    //    row and thus deliver frames out of cursor order (which the client's
    //    `id <= last.id` guard would then drop). The serialized chain already
    //    preserves order + backpressure, so synchronous enqueue is safe.
    replaying = false;
    for (const ev of queue) {
      if (!open) break;
      if (ev.cursor > highWater) {
        highWater = ev.cursor;
        void writeCanonical(ev);
      }
    }

    stream.onAbort(() => {
      open = false;
      unsub();
    });

    while (open) {
      // Keep-alive ping through the SAME serialized chain (a dead peer is
      // detected here and closes the stream instead of failing silently).
      chain = chain.then(async () => {
        if (!open) return;
        try {
          await stream.write(": ping\n\n");
        } catch {
          close();
        }
      });
      await stream.sleep(15_000);
    }
  });
};

app.get("/api/events", sseHandler);
app.get("/api/events/:id", sseHandler);
app.get("/global/event", sseHandler);
app.get("/event", sseHandler);

// ── user terminal ─────────────────────────────────────────────────────────
// B36: web sends ?projectId=… on the query string; accept body too (legacy).
app.post("/api/term", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
  const projectId = c.req.query("projectId") || body.projectId || "default";
  const root = sessions.projectRoots().get(projectId) || currentProjectRoot || process.cwd();
  const s = term.getOrCreate(projectId, root);
  return c.json({ id: s.id, replay: s.ring });
});

app.get("/api/term/:projectId/stream", (c) => {
  const projectId = c.req.param("projectId");
  // Race-free 404 probe WITHOUT subscribe/unsubscribe/resubscribe (B36): the
  // old pattern dropped every chunk emitted between the two subscribes.
  if (!term.exists(projectId)) return c.json({ error: "no terminal" }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    // Per-connection write chain: frames leave strictly in order, so the
    // replay frame always precedes live chunks even under backpressure.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (frame: string) => {
      chain = chain
        .then(async () => {
          if (open) await stream.write(frame);
        })
        .catch(() => {});
    };
    // SINGLE subscribe: term.subscribe registers the listener and captures the
    // ring buffer in one synchronous step; we enqueue the replay first, and no
    // chunk can arrive between those two synchronous statements, so nothing
    // emitted before or after connect is lost.
    const sub = term.subscribe(projectId, (chunk) => {
      enqueue(`data: ${JSON.stringify({ chunk })}\n\n`);
    });
    if ("error" in sub) {
      // terminal died between exists() and subscribe()
      await stream.write(`data: ${JSON.stringify({ error: sub.error })}\n\n`).catch(() => {});
      return;
    }
    enqueue(`data: ${JSON.stringify({ replay: sub.replay })}\n\n`);
    stream.onAbort(() => {
      open = false;
      sub.unsubscribe();
    });
    while (open) {
      enqueue(`data: ${JSON.stringify({ ping: true })}\n\n`);
      await stream.sleep(5_000);
    }
  });
});

app.post("/api/term/:projectId/in", async (c) => {
  const { data } = (await c.req.json()) as { data: string };
  return c.json(term.writeInput(c.req.param("projectId"), data ?? ""));
});

app.post("/api/term/:projectId/clear", (c) => {
  term.clearRing(c.req.param("projectId"));
  return c.json({ ok: true });
});

app.post("/api/term/:projectId/kill", (c) => c.json(term.kill(c.req.param("projectId"))));

const port = Number(process.env.ENGINE_PORT ?? process.env.AGENTZERO_PORT ?? 4100);

// Canonical event store: the trace→store and wire→store bridges register
// EXACTLY ONCE, before any request can emit (idempotent guard inside).
startEventStore();
startRegistryAutoRefresh();
reconcileBootSessions();
// Boot zombie approvals: anything still pending across the process boundary
// belonged to a waiter in the PREVIOUS process — no one can decide it and
// resurfacing it made the UI prompt for stale permissions right after boot.
reloadApprovalsForBoot();

// ── bind host ─────────────────────────────────────────────────────────────
// @hono/node-server binds 0.0.0.0 when no hostname is given, so the previous
// `serve({fetch, port})` exposed this process — which runs shell commands,
// writes files and serves a PTY — to the whole local network, while the boot
// log claimed 127.0.0.1. Loopback is now the default.
//
// ENGINE_HOST can widen the bind for a LAN demo, but only WITH a token: an
// engine reachable off-host and unauthenticated is remote code execution, so
// a non-loopback host without ENGINE_API_TOKEN is a hard boot failure rather
// than a silent downgrade.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const host = (process.env.ENGINE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
if (!LOOPBACK_HOSTS.has(host) && !ENGINE_API_TOKEN) {
  console.error(
    `[agent-engine] refusing to start: ENGINE_HOST=${host} is not loopback and ENGINE_API_TOKEN is unset.\n` +
      `  A non-loopback engine without a token is an unauthenticated remote shell.\n` +
      `  Set ENGINE_API_TOKEN=<secret>, or drop ENGINE_HOST to bind 127.0.0.1.`,
  );
  process.exit(1);
}

export const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[agent-engine] server running on http://${host}:${info.port}`);
  if (!LOOPBACK_HOSTS.has(host)) {
    console.warn(`[agent-engine] WARNING: bound to ${host} (off-loopback) — bearer auth is required and active.`);
  }
  void probeAllModels().catch((e) => logger.warn("router", `startup probe error: ${e}`));
});

// WebSocket Terminal server on /api/term
export const wss = new WebSocketServer({ noServer: true });

(server as any).on?.("upgrade", (req: any, socket: any, head: any) => {
  const url = new URL(req.url || "", `http://${req.headers?.host || "127.0.0.1"}`);
  if (url.pathname === "/api/term" || url.pathname === "/api/term/ws") {
    // ── PTY upgrade guard ──────────────────────────────────────────────────
    // This socket hands the caller a live pty. WebSocket upgrades are NOT
    // subject to CORS, so the browser-origin guard on /api/* never ran here —
    // the endpoint was an unauthenticated shell behind a URL. Apply the same
    // posture the mutating REST routes use, at the upgrade.
    //
    // Browsers always send Origin on a WS handshake, so an absent Origin means
    // a non-browser client (the web IDE's own dev proxy, tests, curl) and is
    // allowed through to the token check, exactly as on the REST side.
    const origin = req.headers?.origin;
    if (typeof origin === "string" && origin.length > 0 && !browserOriginAllowed(origin, req.headers?.host || "")) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Token, when configured. A WS handshake cannot carry an Authorization
    // header from the browser API, so the token may also arrive as a query
    // param — compared with the same timing-safe helper.
    if (ENGINE_API_TOKEN) {
      const headerAuth = req.headers?.authorization || "";
      const queryToken = url.searchParams.get("token") || "";
      const ok = bearerTokenOk(headerAuth) || (queryToken && bearerTokenOk(`Bearer ${queryToken}`));
      if (!ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const projectId = url.searchParams.get("projectId") || "default";
    if (!ID_RE.test(projectId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const root = sessions.projectRoots().get(projectId) || currentProjectRoot || process.cwd();
    wss.handleUpgrade(req, socket, head, (ws) => {
      term.handleWsConnection(ws, projectId, root);
    });
  } else {
    socket.destroy();
  }
});

export { app };
