// Provider registry + OpenAI-compatible chat client with retry/fallback.
//
// Dynamic Model Registry + Native Engine Routing Headers
// 1. Dynamic /models endpoint discovery + models.dev enrichment.
// 2. Injects x-engine-task, x-session-id, x-agent-role headers for native routing.
// 3. Extracts reasoning_content and strips <think> tags from output.
// 4. Default baseUrl: http://127.0.0.1:4098/v1.

import { AppSettings, ModelSpec, ProviderSettings } from "./types.js";
import { loadSettings, DATA_DIR, DEFAULT_ROUTER_BASE } from "./config.js";
import { log, logger } from "./logger.js";
import fs from "node:fs";
import path from "node:path";

export const MODELS_DEV_URL =
  process.env.ENGINE_MODELS_DEV_URL ??
  process.env.AGENTZERO_MODELS_DEV_URL ??
  "https://models.dev/api.json";
const MODELS_DEV_CACHE_FILE = path.join(DATA_DIR, "models-dev.json");
const MODELS_DEV_TTL_MS = 12 * 3600_000;
const PROVIDER_MODELS_TTL_MS = 10 * 60_000;
export const REGISTRY_REFRESH_MS = 10 * 60_000;

// ── models.dev wire shapes ──────────────────────────────────────────────────
interface ModelsDevModel {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
}
interface ModelsDevProvider {
  id?: string;
  name?: string;
  api?: string;
  models?: Record<string, ModelsDevModel>;
}
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface ModelsDevCacheFile {
  fetchedAt: number;
  url: string;
  catalog: ModelsDevCatalog;
}

/** Default native seed models */
const NATIVE_MODELS: Omit<ModelSpec, "provider" | "baseUrl" | "enabled">[] = [
  { id: "engine/small", label: "Engine Small (Tier S)", ctxWindow: 128000, maxOutput: 8192, costInPerM: 0, costOutPerM: 0, tags: ["tier-s", "fast", "free"] },
  { id: "engine/medium", label: "Engine Medium (Tier M)", ctxWindow: 200000, maxOutput: 32000, costInPerM: 0, costOutPerM: 0, tags: ["tier-m", "reasoning", "free"] },
  { id: "engine/large", label: "Engine Large (Tier L)", ctxWindow: 256000, maxOutput: 64000, costInPerM: 0, costOutPerM: 0, tags: ["tier-l", "reasoning", "longctx", "free"] },
  { id: "nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning Free", ctxWindow: 128000, maxOutput: 8192, costInPerM: 0, costOutPerM: 0, tags: ["free", "fast", "tier-s"] },
];

export interface ModelRegistry {
  list(): ModelSpec[];
  get(id: string): ModelSpec | undefined;
  refresh(opts?: { force?: boolean }): Promise<ModelSpec[]>;
}

let cache: ModelSpec[] = [];

export function seedFromSettings(settings: AppSettings): ModelSpec[] {
  const providers = settings.providers?.length ? settings.providers : [{ name: "Local Router", baseUrl: DEFAULT_ROUTER_BASE }];
  // NATIVE_MODELS are the LOCAL ROUTER proxy's routing vocabulary (the
  // engine/small|medium|large tier aliases it understands, plus its seeded free
  // models). They must be seeded ONCE against the local router — never once per
  // provider. The old per-provider loop let refresh()'s byId merge (which keeps
  // the LAST duplicate) re-tag engine/small|medium|large to whichever provider
  // came last, so merely adding a custom provider (e.g. "OpenCode Zen") silently
  // pointed the tier aliases at that provider's baseUrl and made them unroutable.
  // Identify the router provider by its canonical id first, then by host:port
  // match (guarded against an unparseable DEFAULT_ROUTER_BASE whose hostOf is ""
  // and would otherwise match any garbage provider), then fall back to a label.
  const routerHost = hostOf(DEFAULT_ROUTER_BASE);
  const routerName =
    providers.find((p) => (p as { id?: string }).id === "engine-router")?.name ??
    (routerHost ? providers.find((p) => hostOf(p.baseUrl || "") === routerHost)?.name : undefined) ??
    "Local Router";
  return NATIVE_MODELS.map((m) => ({ ...m, provider: routerName, baseUrl: DEFAULT_ROUTER_BASE, enabled: true }));
}

// ── models.dev catalog loading ──────────────────────────────────────────────

function loadCatalogFromDisk(): ModelsDevCacheFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_DEV_CACHE_FILE, "utf8")) as ModelsDevCacheFile;
    if (typeof raw?.fetchedAt === "number" && raw.catalog && typeof raw.catalog === "object") return raw;
  } catch {
    /* ignore */
  }
  return null;
}

async function loadModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
  const cached = loadCatalogFromDisk();
  if (cached && Date.now() - cached.fetchedAt < MODELS_DEV_TTL_MS) return cached.catalog;
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as ModelsDevCatalog;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        MODELS_DEV_CACHE_FILE,
        JSON.stringify({ fetchedAt: Date.now(), url: MODELS_DEV_URL, catalog } satisfies ModelsDevCacheFile),
      );
    } catch {
      /* ignore */
    }
    logger.info("providers", "models.dev catalog fetched", {
      url: MODELS_DEV_URL,
      providers: Object.keys(catalog).length,
    });
    return catalog;
  } catch (err) {
    logger.warn("providers", "models.dev unreachable" + (cached ? " — using stale cache" : ""), {
      url: MODELS_DEV_URL,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return cached?.catalog ?? null;
  }
}

function matchModelsDevProvider(p: ProviderSettings, catalog: ModelsDevCatalog): ModelsDevProvider | undefined {
  const split = (u: string): { host: string; path: string } | null => {
    try {
      const x = new URL(u);
      return { host: x.host.toLowerCase(), path: x.pathname.replace(/\/+$/, "") };
    } catch {
      return null;
    }
  };
  const mine = p.baseUrl ? split(p.baseUrl) : null;
  if (mine) {
    for (const dev of Object.values(catalog)) {
      if (!dev.api) continue;
      const theirs = split(dev.api);
      if (!theirs || theirs.host !== mine.host) continue;
      if (theirs.path === mine.path || theirs.path.startsWith(mine.path) || mine.path.startsWith(theirs.path)) {
        return dev;
      }
    }
  }
  const needle = p.name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return undefined;
  for (const [key, dev] of Object.entries(catalog)) {
    const hay = `${key} ${dev.name ?? ""}`.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
    if (hay.split(/\s+/).some((tok) => tok === needle) || hay.replace(/\s+/g, "").includes(needle)) return dev;
  }
  return undefined;
}

function tagsFromDevMetadata(dev: ModelsDevModel, ctxWindow: number, costIn: number, costOut: number): string[] {
  const tags: string[] = [];
  if ((dev.cost?.input ?? 0) === 0 && (dev.cost?.output ?? 0) === 0 && dev.cost != null) tags.push("free");
  if (costIn === 0 && costOut === 0 && dev.cost == null) tags.push("free");
  if (dev.reasoning) tags.push("reasoning");
  if (ctxWindow >= 200_000) tags.push("longctx");
  if (dev.modalities?.input?.includes("image")) tags.push("vision");
  if (dev.tool_call) tags.push("tools");
  return tags;
}

// ── Per-provider /models endpoint ──────────────────────────────────────────

interface EndpointModel {
  id: string;
  context_length?: number;
  pricing?: { input?: unknown; output?: unknown };
  /** The local router's /models tags each model with the REAL upstream provider
   *  it proxies (zen/openrouter/groq/nvidia-nim). We surface this so a
   *  model is shown as "…@openrouter" instead of an opaque "…@Local Router". */
  owned_by?: string;
}

/** Decide whether a router-discovered model is usable, from its upstream provider
 *  id (owned_by) and the router's per-provider key status. A model whose upstream
 *  provider has NO key configured cannot be called (the router would 401), so it
 *  is disabled + tagged "needs-key" instead of being shown as available. Unknown
 *  key status (null map — the /routes probe failed) degrades to enabled so a
 *  transient probe failure never locks every model out. Exported for tests. */
export function classifyRouterModel(
  ownedBy: string | undefined,
  routerKeys: Map<string, boolean> | null,
): { enabled: boolean; needsKey: boolean } {
  const hasKey = ownedBy !== undefined && routerKeys ? routerKeys.get(ownedBy) : undefined;
  const needsKey = ownedBy !== undefined && hasKey === false;
  return { enabled: !needsKey, needsKey };
}

/** Probe the local router's /routes for per-provider key status. Returns null when
 *  unreachable (callers must treat unknown as enabled, not lock everything out). */
async function fetchRouterKeys(routerBase: string): Promise<Map<string, boolean> | null> {
  try {
    const root = routerBase.replace(/\/v1\/?$/, "");
    const res = await fetch(`${root}/routes`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { providers?: { id?: string; key_configured?: boolean }[] };
    const map = new Map<string, boolean>();
    for (const p of json.providers ?? []) {
      if (typeof p.id === "string") map.set(p.id, Boolean(p.key_configured));
    }
    return map;
  } catch {
    return null;
  }
}

/** TTL cache for per-provider /models responses (was referenced but never
 *  declared — every refresh re-fetched every endpoint). */
const providerModelsCache = new Map<string, { at: number; data: EndpointModel[] }>();

/** Audit I7 caps: bound a provider's /models payload so a hostile endpoint cannot
 *  OOM/CPU-pin the engine. */
const MAX_PROVIDER_MODELS_BYTES = 2_000_000; // ~2 MB
const MAX_PROVIDER_MODELS_COUNT = 1000;

/** Audit M4: coerce an endpoint numeric to a finite number (0 fallback). A
 *  non-numeric pricing field (e.g. {"input":{}}) used to yield NaN, and NaN cost
 *  accumulations silently defeat the `>= budgetCapUsd` guard. */
function finiteNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchProviderModels(p: ProviderSettings, force: boolean): Promise<EndpointModel[] | null> {
  const hit = providerModelsCache.get(p.name);
  if (!force && hit && Date.now() - hit.at < PROVIDER_MODELS_TTL_MS) return hit.data;
  try {
    const url = `${(p.baseUrl || DEFAULT_ROUTER_BASE).replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn("providers", "/models endpoint not ok", { provider: p.name, status: res.status });
      return null;
    }
    // Audit I7: bound the response. A malicious/compromised endpoint could serve a
    // multi-GB /models and OOM/CPU-pin the engine on every refresh. Read as text
    // with a size cap, then parse, then cap the entry count.
    const text = await res.text();
    if (text.length > MAX_PROVIDER_MODELS_BYTES) {
      log("warn", "providers", "provider /models response too large — rejected", {
        provider: p.name,
        bytes: text.length,
      });
      return null;
    }
    let parsed: { data?: EndpointModel[] } | null = null;
    try {
      parsed = JSON.parse(text) as { data?: EndpointModel[] };
    } catch {
      return null;
    }
    const data = ((parsed?.data ?? []).filter((m) => typeof m?.id === "string")).slice(0, MAX_PROVIDER_MODELS_COUNT);
    providerModelsCache.set(p.name, { at: Date.now(), data });
    return data;
  } catch (err) {
    log("warn", "providers", "provider unreachable during refresh", {
      provider: p.name,
      baseUrl: p.baseUrl,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    return null;
  }
}

function specFromEndpointAndCatalog(
  p: ProviderSettings,
  ep: EndpointModel,
  dev: ModelsDevModel | undefined,
  unverified: boolean,
  routerKeys?: Map<string, boolean> | null,
): ModelSpec {
  const ctxWindow = finiteNum(dev?.limit?.context ?? ep.context_length, 128_000);
  const maxOutput = finiteNum(dev?.limit?.output, 8192);
  const costInPerM = dev?.cost?.input != null ? finiteNum(dev.cost.input) : ep.pricing?.input != null ? finiteNum(ep.pricing.input) * 1e6 : 0;
  const costOutPerM = dev?.cost?.output != null ? finiteNum(dev.cost.output) : ep.pricing?.output != null ? finiteNum(ep.pricing.output) * 1e6 : 0;
  const deprecated = dev?.status === "deprecated";
  const tags = dev ? tagsFromDevMetadata(dev, ctxWindow, costInPerM, costOutPerM) : [];
  if (unverified && !tags.includes("unverified")) tags.push("unverified");
  // Router-proxied models (routerKeys !== undefined): show the REAL upstream
  // provider from owned_by instead of the opaque router name, and disable models
  // whose upstream has no key (they would 401 — see classifyRouterModel). The
  // router ignores the incoming Bearer and resolves its own upstream keys, so
  // re-tagging the provider does not change how the call is authenticated.
  const isRouterModel = routerKeys !== undefined;
  const upstream = isRouterModel && ep.owned_by ? ep.owned_by : undefined;
  const admission = isRouterModel ? classifyRouterModel(upstream, routerKeys ?? null) : { enabled: true, needsKey: false };
  if (admission.needsKey && !tags.includes("needs-key")) tags.push("needs-key");
  return {
    id: ep.id,
    label: dev?.name ?? ep.id,
    provider: upstream ?? p.name,
    baseUrl: p.baseUrl || DEFAULT_ROUTER_BASE,
    ctxWindow,
    maxOutput,
    costInPerM,
    costOutPerM,
    tags,
    enabled: !deprecated && admission.enabled,
  };
}

export const registry: ModelRegistry = {
  list() {
    return cache.length ? cache : seedFromSettings(loadSettings());
  },
  get(id) {
    return this.list().find((m) => m.id === id);
  },
  /** Phase 6 (FIX-PLAN): real discovery via each provider's GET /models —
   *  the local router (:4098) emits real per-provider ids there. The dead
   *  fetchProviderModels/specFromEndpointAndCatalog/models.dev paths are now
   *  the live pipeline. Any failure (router down, empty list, bad JSON)
   *  degrades gracefully to the NATIVE_MODELS seed — refresh never throws.
   *  Called at startup (startRegistryAutoRefresh) and on settings save
   *  (PUT /api/settings), plus the 10-minute auto-refresh interval. */
  async refresh(opts) {
    const settings = loadSettings();
    const seeded = seedFromSettings(settings);
    const force = opts?.force ?? false;

    let catalog: ModelsDevCatalog | null = null;
    try {
      catalog = await loadModelsDevCatalog();
    } catch {
      catalog = null; // enrichment is optional — discovery works without it
    }

    const providers: ProviderSettings[] = settings.providers?.length
      ? settings.providers
      : [{ name: "Local Router", baseUrl: DEFAULT_ROUTER_BASE, apiKey: "", kind: "openai-compatible" }];
    const routerHost = hostOf(DEFAULT_ROUTER_BASE);
    const allowlist = settings.customModelAllowlist ?? [];
    // Per-provider key status from the router, so models proxied from a keyless
    // upstream are disabled + tagged "needs-key" instead of shown as available.
    let routerKeys: Map<string, boolean> | null = null;
    let routerKeysFetched = false;

    const discovered: ModelSpec[] = [];
    for (const p of providers) {
      // Audit I3: a disabled provider must not be probed (its key Bearer-sent),
      // nor have its models admitted/routable. Disabling previously disabled nothing.
      if ((p as { enabled?: boolean }).enabled === false) continue;
      let eps = await fetchProviderModels(p, force);
      if (!eps || eps.length === 0) continue; // unreachable/empty → skip provider
      const isRouterProv = hostOf(p.baseUrl || DEFAULT_ROUTER_BASE) === routerHost;
      if (isRouterProv && !routerKeysFetched) {
        routerKeysFetched = true;
        routerKeys = await fetchRouterKeys(DEFAULT_ROUTER_BASE);
      }
      // ≤80B GATE FOR DIRECT PROVIDERS — fail closed.
      //
      // The local router enforces the cap as a startup invariant, but a
      // provider configured to point straight at an upstream BYPASSES the
      // router entirely. This branch used to admit everything such a provider
      // listed, merely tagging it "unverified" — so the engine happily
      // discovered and called `openai/gpt-oss-120b` (120B) through a direct
      // NVIDIA NIM entry. Observed in a real task: 2 calls, 12,224 prompt
      // tokens, $0.035 spent. That is a hard constraint violation, not a
      // quality issue.
      //
      // "Unverified" is the wrong default for a disqualifying constraint. A
      // model is admitted only if its id PROVES it is within the cap, or an
      // operator listed it explicitly. Unknown size => excluded.
      let unverified = false;
      if (hostOf(p.baseUrl || DEFAULT_ROUTER_BASE) !== routerHost) {
        if (allowlist.length > 0) {
          eps = eps.filter((m) => allowlist.includes(m.id));
          if (eps.length === 0) continue;
        } else {
          const before = eps.length;
          const rejected: string[] = [];
          eps = eps.filter((m) => {
            const b = paramsBFromId(m.id);
            if (b !== null && b <= MAX_PARAM_B) return true;
            rejected.push(`${m.id}${b !== null ? ` (${b}B)` : " (size unknown)"}`);
            return false;
          });
          unverified = true;
          if (rejected.length > 0 && !warnedCustomProviders.has(p.name)) {
            warnedCustomProviders.add(p.name);
            console.warn(
              `[providers] direct provider "${p.name}": excluded ${rejected.length}/${before} models that are not provably <=${MAX_PARAM_B}B — ` +
                `${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? ", …" : ""}. ` +
                `Set customModelAllowlist to admit a specific id you have verified.`,
            );
          }
          if (eps.length === 0) continue;
        }
      }
      const dev = catalog ? matchModelsDevProvider(p, catalog) : undefined;
      for (const ep of eps) {
        discovered.push(specFromEndpointAndCatalog(p, ep, dev?.models?.[ep.id], unverified, isRouterProv ? routerKeys : undefined));
      }
    }

    if (discovered.length === 0) {
      cache = seeded; // graceful fallback: NATIVE_MODELS (engine/* tier aliases)
      return cache;
    }
    cache = mergeDiscovered(seeded, discovered);
    return cache;
  },
};

/** Wave 25 catalog hygiene (2026-08-28 telemetry + live-probe audit): models
 *  confirmed dead. A direct custom provider (e.g. OpenCode Zen in
 *  settings.json) is probed at its OWN /models endpoint, which still lists
 *  these — so the router's curated catalog alone is not enough while a
 *  parallel direct provider exists. Filtered at mergeDiscovered, the single
 *  chokepoint every seeded + discovered model passes through, so they can
 *  never enter the routable registry from ANY provider.
 *    nemotron-3.5-lightning-free — 27.3% success, chronic 45s timeouts
 *    mimo-v2.5-free              — 0% success
 *    big-pickle                  — 429 quota-dead
 *    deepseek-v4-flash-free      — 400 unavailable                       */
export const DISABLED_MODELS: ReadonlySet<string> = new Set([
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "big-pickle",
  "deepseek-v4-flash-free",
]);

/** Merge seeded (native) models with discovered ones. Discovered specs win on id
 *  clash (they carry real ctx/pricing from the endpoint + models.dev) — EXCEPT
 *  the reserved `engine/*` tier-alias namespace, which is the local router
 *  proxy's routing vocabulary and must never be hijackable by a provider's
 *  /models response (a custom/malicious endpoint returning id "engine/small"
 *  would otherwise silently re-point the tier alias at itself). Models on the
 *  DISABLED_MODELS blocklist are dropped outright (wave 25). */
export function mergeDiscovered(seeded: ModelSpec[], discovered: ModelSpec[]): ModelSpec[] {
  const byId = new Map<string, ModelSpec>();
  for (const m of seeded) {
    if (DISABLED_MODELS.has(m.id)) continue; // never admit a dead model, even if seeded
    byId.set(m.id, m);
  }
  for (const m of discovered) {
    // Reserved namespace: engine/* tier aliases belong to the local router proxy.
    if (m.id.startsWith("engine/")) continue;
    if (DISABLED_MODELS.has(m.id)) continue; // wave 25: confirmed-dead model
    byId.set(m.id, m);
  }
  return [...byId.values()];
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}
const warnedCustomProviders = new Set<string>();

let autoRefreshTimer: NodeJS.Timeout | undefined;
export function startRegistryAutoRefresh(): void {
  void registry.refresh().catch(() => {});
  autoRefreshTimer ??= setInterval(() => void registry.refresh().catch(() => {}), REGISTRY_REFRESH_MS);
  autoRefreshTimer.unref?.();
}

// ── Chat completion ────────────────────────────────────────────────────────
export interface StreamDelta {
  /** Incremental visible content token. */
  text?: string;
  /** Incremental reasoning/thinking token (models that expose reasoning_content). */
  reasoning?: string;
  /**
   * Incremental fragment of a NATIVE tool call's `arguments` JSON.
   *
   * Tool-trained models stream a write_file as `tool_calls[].function.arguments`
   * — a JSON string arriving in pieces — with `content` empty. The live-coding
   * decoder reads exactly that JSON shape, so forwarding these fragments is what
   * lets the editor type a file out as the model produces it. Without it the
   * feature silently stopped working the moment native tool calls were adopted:
   * the decoder was watching a text channel the model no longer used.
   */
  toolArgs?: string;
  /** Name of the tool whose arguments are streaming, once known. */
  toolName?: string;
}

export interface ChatParams {
  modelId: string;
  messages: { role: string; content: unknown }[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  responseFormat?: "json";
  timeoutMs?: number;
  taskId?: string;
  sessionId?: string;
  agentRole?: string;
  /** Wave 25 (forge-parity fluid chat): when set, the request is made with
   *  stream:true and each upstream SSE delta is forwarded here as it arrives.
   *  The returned ChatResult still carries the FULL aggregated text, so
   *  callers that only care about the result keep working unchanged. */
  onDelta?: (d: StreamDelta) => void;
  /** OpenAI function schemas to declare on the request. Supply these for any
   *  tool-using call — see toolSchemasForApi() in tools.ts for why. */
  tools?: unknown[];
  /**
   * Reasoning budget hint for reasoning models ("low" | "medium" | "high").
   *
   * The coder was spending 15-18s composing an entire file inside its reasoning
   * before emitting the tool call that writes it — the content is drafted
   * twice, the editor shows nothing until the draft finishes, and the reasoning
   * copy is discarded. Low effort keeps reasoning for DECIDING and pushes the
   * writing into the tool call, where it streams straight to the editor.
   *
   * Providers that do not understand the field ignore it; Groq rejects values
   * outside low/medium/high, so only those three are ever sent.
   */
  reasoningEffort?: "low" | "medium" | "high";
  /** Allow an empty `content` to fall back to the model's reasoning text.
   *  Default FALSE: in a tool loop that fallback disguises a non-answer as an
   *  answer. Chat-style callers set it true. */
  allowReasoningAsText?: boolean;
}

/** Incremental SSE parser for OpenAI-style chat completion streams.
 *  Feeds complete `data:` JSON payloads to onJson; returns the incomplete
 *  tail (everything after the last blank-line boundary) to be re-fed with
 *  the next network chunk. Tolerates CRLF, keep-alive comments (":"),
 *  empty lines, and the terminal `[DONE]` sentinel. When shouldStop()
 *  becomes true (caller abort mid-buffer), parsing halts immediately.
 *  Exported for tests. */
export function parseChatSse(buf: string, onJson: (j: unknown) => void, shouldStop?: () => boolean): string {
  // Split on blank lines (event boundary); the last segment may be partial.
  const parts = buf.split(/\r?\n\r?\n/);
  const tail = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      if (shouldStop?.()) return ""; // aborted — discard the rest
      if (!line.startsWith("data:")) continue; // comments (":") & event: lines
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        onJson(JSON.parse(raw));
      } catch {
        /* partial/corrupt data line — skip, never kill the stream */
      }
    }
  }
  return tail;
}

export const CHAT_TIMEOUT_MS = 180_000;

function fuseSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!signal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : t;
}

function mapFetchAbort(err: unknown, signal: AbortSignal | undefined, timeoutMs: number): unknown {
  if (err instanceof LlmError) return err;
  if (!(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) return err;
  if (signal?.aborted) return err;
  const name = err.name === "TimeoutError" || signal?.reason?.name === "TimeoutError" ? "timeout" : "abort";
  return new LlmError(`LLM call ${name}: aborted after ${timeoutMs}ms hard cap`, 504, true);
}

export interface NativeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  reasoningContent?: string;
  /** Native `message.tool_calls` from tool-trained models, already parsed.
   *  Callers prefer these over scraping TOOL_CALL: lines out of `text`. */
  toolCalls?: NativeToolCall[];
  /**
   * The upstream stopped because it hit max_tokens, not because it finished.
   *
   * Nothing read finish_reason before this. A completion cut off mid-file was
   * indistinguishable from a complete one, so a write_file carrying half a
   * PyTorch script was executed and the truncated file landed on disk. That is
   * the mechanism behind "code generation is incomplete": not a weak model, a
   * missing check.
   */
  truncated?: boolean;
  /**
   * The router's ACTUAL upstream decision, read from `x-engine-route`.
   *
   * The engine asks for an alias ("engine/small") and the router resolves it to
   * a concrete model on a concrete provider. Nothing read that answer back, so
   * every trace and every badge in the UI said "engine/small@Local Router" —
   * the alias and the proxy, not the model that did the work. The user could
   * not see which model answered, which the brief forbids outright: the routing
   * decision can never be hidden.
   */
  upstream?: { provider: string; model: string; tier?: string; reason?: string };
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  raw?: unknown;
  /** B15: true when tokensIn/tokensOut are heuristics (upstream omitted
   *  usage) rather than provider-reported counts. */
  estimated?: boolean;
}

/** B15 token heuristic: free/proxied upstreams routinely omit usage, which
 *  made cost/token caps unenforceable ($0 forever). chars/3.5 matches the
 *  compactor's estimator. Local on purpose — context.ts imports THIS file. */
/** Hard cap on TOTAL parameters, mirroring the router's own invariant. */
export const MAX_PARAM_B = 80;

/**
 * Parameter count implied by a model id, in billions, or null when the id does
 * not state one.
 *
 * Takes the LARGEST size token in the id on purpose. MoE ids advertise both
 * counts (`nemotron-3-super-120b-a12b` = 120B total, 12B active) and the
 * constraint is on TOTAL, so reading the smaller number would admit exactly the
 * models the rule exists to exclude.
 */
export function paramsBFromId(id: string): number | null {
  const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)\s*b\b/gi)].map((m) => Number(m[1]));
  const plausible = sizes.filter((n) => Number.isFinite(n) && n > 0 && n <= 5000);
  return plausible.length ? Math.max(...plausible) : null;
}

export function estTokensText(text: string): number {
  return Math.ceil(Math.max(0, text.length) / 3.5);
}

/**
 * Parse the router's `x-engine-route` header.
 *
 * Best-effort by design: a direct-to-provider call (no local router) has no
 * such header, and a malformed one must not break a completion that already
 * succeeded — losing the badge is cosmetic, losing the answer is not.
 */
export function parseUpstreamRoute(header: string | null): ChatResult["upstream"] {
  if (!header) return undefined;
  try {
    const j = JSON.parse(header) as { provider?: unknown; model?: unknown; tier?: unknown; reason?: unknown };
    if (typeof j.provider !== "string" || typeof j.model !== "string") return undefined;
    return {
      provider: j.provider,
      model: j.model,
      ...(typeof j.tier === "string" ? { tier: j.tier } : {}),
      ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Normalize an OpenAI `message.tool_calls` array into the engine's shape.
 *
 * Arguments arrive as a JSON *string*, and small models routinely emit a
 * malformed one — so a parse failure degrades to an empty arg object rather
 * than dropping the call entirely; the tool handler's own validation then
 * produces a useful error the model can react to, which beats silence.
 */
export function parseNativeToolCalls(raw: unknown): NativeToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeToolCall[] = [];
  for (const c of raw) {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = fn?.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        /* malformed args → empty; the handler reports what is missing */
      }
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    }
    out.push({ name, args });
  }
  return out;
}

export const CONTEXT_OVERFLOW_RE = /context length|maximum context|too many tokens|context_length_exceeded/i;

export class LlmError extends Error {
  readonly overflow: boolean;
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.overflow = CONTEXT_OVERFLOW_RE.test(message);
  }
}

/** Strip <think>, <thought>, <thinking> tags and extract reasoning */
export function sanitizeThinkTags(rawText: string): { text: string; reasoning?: string } {
  let text = rawText || "";
  const thoughts: string[] = [];

  // 1. Extract closed <think>...</think>, <thought>...</thought>, <thinking>...</thinking>
  const tagRe = /<(?:think|thought|thinking)>([\s\S]*?)<\/(?:think|thought|thinking)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[1] && m[1].trim()) {
      thoughts.push(m[1].trim());
    }
  }
  text = text.replace(tagRe, "").trim();

  // 2. Extract unclosed <think>... if model was cut off or stopped before closing tag
  const unclosedRe = /^<(?:think|thought|thinking)>([\s\S]*)$/i;
  const unclosedMatch = text.match(unclosedRe);
  if (unclosedMatch) {
    const unclosedContent = unclosedMatch[1]!.trim();
    // If it contains a FINAL: or Response: section, split it
    const finalSplit = unclosedContent.split(/(?=(?:FINAL:|Response:|Answer:))/i);
    if (finalSplit.length > 1) {
      thoughts.push(finalSplit[0]!.trim());
      text = finalSplit.slice(1).join("").trim();
    } else {
      thoughts.push(unclosedContent);
      text = "";
    }
  }

  // 3. Extract CoT scratchpad prefixes if model output begins with "I need to ..." / "Protocol reminder: ..." before FINAL:
  if (!thoughts.length && /^(?:The user (?:wants|says|asked)|Protocol reminder|Let's check|I need to|Wait, looking)/i.test(text)) {
    const finalMarker = text.search(/(?:FINAL:|Response:|Answer:)/i);
    if (finalMarker > 0) {
      thoughts.push(text.slice(0, finalMarker).trim());
      text = text.slice(finalMarker).trim();
    }
  }

  const reasoning = thoughts.length > 0 ? thoughts.join("\n\n---\n\n") : undefined;
  return { text, reasoning };
}

/** Models only served by the OpenAI Responses API (POST /responses with `input`),
 *  not /chat/completions. The engine calls a model's baseUrl directly, so these
 *  must be detected and translated here (the router has its own equivalent). */
const RESPONSES_ONLY_RE = /muse-spark/i;
export function isResponsesOnlyModel(modelId: string): boolean {
  return RESPONSES_ONLY_RE.test(modelId);
}

/** Translate an OpenAI Responses API payload back to chat/completions shape so
 *  the shared text/usage extraction works unchanged. */
export function normalizeResponsesToChat(json: {
  id?: string;
  model?: string;
  created_at?: number;
  output?: unknown;
  usage?: unknown;
}): Record<string, unknown> {
  let content = "";
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (item && typeof item === "object" && (item as { type?: unknown }).type === "message") {
        const c = (item as { content?: unknown }).content;
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part && typeof part === "object" && (part as { type?: unknown }).type === "output_text") {
              const t = (part as { text?: unknown }).text;
              if (typeof t === "string") content += t;
            }
          }
        }
      }
    }
  }
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = num(u["input_tokens"]);
  const completion = num(u["output_tokens"]);
  return {
    id: json.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: json.created_at ?? Math.floor(Date.now() / 1000),
    model: json.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: num(u["total_tokens"]) || prompt + completion,
    },
  };
}

/**
 * Stream liveness budgets — how long a stream may say NOTHING before we give up
 * on it and let the router fall back.
 *
 * These are deliberately separate from CHAT_TIMEOUT_MS (the 180s cap on a whole
 * call). A provider that accepts the request, opens a stream, and then delivers
 * zero bytes is already dead; waiting out the full call budget to discover that
 * was measured costing 180 seconds of a 600s step budget on a free tier, and
 * the retry that followed succeeded in 42s. Execution time is scored (T in
 * S = 10·A/(1 + w_C·C/C_base + w_T·T/T_base)^2.5), so 180s spent learning
 * nothing is a direct hit to the score for no accuracy gained.
 *
 * TTFB is the generous one: a reasoning model may think for a while before its
 * first token. Once bytes ARE flowing, a long gap means the stream broke, so
 * the inter-chunk budget can be tighter. Both are env-tunable because free-tier
 * latency varies wildly by provider and time of day — a machine on a slow link
 * must be able to relax them without a rebuild.
 */
export const STREAM_TTFB_MS = Number(process.env.STREAM_TTFB_MS ?? 30_000);
export const STREAM_STALL_MS = Number(process.env.STREAM_STALL_MS ?? 30_000);

/**
 * reader.read() bounded by a deadline.
 *
 * Returns the chunk, or throws a retryable LlmError so the router treats a
 * silent stream exactly like a 5xx and moves to the next candidate. The timer
 * is always cleared: a pending timer per chunk would leak on every token.
 */
export async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetMs: number,
  what: "first byte" | "next chunk",
  modelId: string,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LlmError(`stream stalled: no ${what} from ${modelId} in ${budgetMs}ms`, 504, true)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([reader.read(), stall]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wave 25: consume an OpenAI-style SSE completion stream, forwarding deltas
 *  to params.onDelta as they arrive, and rebuild the equivalent non-streaming
 *  JSON ({choices:[{message:{content,reasoning_content}}], usage}) so the
 *  shared extraction/sanitization path below works unchanged. Caller-abort is
 *  checked between network chunks and cancels the upstream reader. */
async function readSseCompletion(res: Response, params: ChatParams): Promise<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  let inThinkTag = false;
  let usage: any;
  let finishReason: string | undefined;
  // Native tool calls stream as INDEXED fragments: the name arrives once, then
  // `arguments` accumulates across many deltas. Keyed by index, joined at end.
  const toolAcc = new Map<number, { name: string; args: string }>();
  const onDelta = params.onDelta!;
  // Which budget applies: the generous first-byte one, or the tighter
  // inter-chunk one that starts once the provider has proven it is alive.
  let sawBytes = false;
  try {
    for (;;) {
      if (params.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("aborted", "AbortError");
      }
      const { done, value } = await readWithDeadline(
        reader,
        sawBytes ? STREAM_STALL_MS : STREAM_TTFB_MS,
        sawBytes ? "next chunk" : "first byte",
        params.modelId,
      );
      if (done) break;
      sawBytes = true;
      buf += decoder.decode(value, { stream: true });
      buf = parseChatSse(
        buf,
        (j) => {
          const r = j as any;
          if (r && typeof r === "object" && r.usage) usage = r.usage;
          const fr = r?.choices?.[0]?.finish_reason;
          if (typeof fr === "string" && fr) finishReason = fr;
          const delta = r?.choices?.[0]?.delta;
          if (!delta) return;
          if (typeof delta.content === "string" && delta.content) {
            const chunk = delta.content;
            text += chunk;
            
            // DeepSeek-style dynamic tag stream demuxing
            if (chunk.includes("<think>") || chunk.includes("<thought>") || chunk.includes("<thinking>")) {
              inThinkTag = true;
              const clean = chunk.replace(/<(?:think|thought|thinking)>/gi, "");
              if (clean) {
                reasoning += clean;
                try { onDelta({ reasoning: clean }); } catch {}
              }
            } else if (chunk.includes("</think>") || chunk.includes("</thought>") || chunk.includes("</thinking>")) {
              inThinkTag = false;
              const clean = chunk.replace(/<\/(?:think|thought|thinking)>/gi, "");
              if (clean) {
                try { onDelta({ text: clean }); } catch {}
              }
            } else if (inThinkTag) {
              reasoning += chunk;
              try { onDelta({ reasoning: chunk }); } catch {}
            } else {
              try { onDelta({ text: chunk }); } catch { /* listener errors never break the stream */ }
            }
          }
          const rc = delta.reasoning_content ?? delta.reasoning;
          if (typeof rc === "string" && rc) {
            reasoning += rc;
            try { onDelta({ reasoning: rc }); } catch { /* ditto */ }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc?.index === "number" ? tc.index : 0;
              const cur = toolAcc.get(idx) ?? { name: "", args: "" };
              if (typeof tc?.function?.name === "string" && tc.function.name) cur.name = tc.function.name;
              const frag = tc?.function?.arguments;
              if (typeof frag === "string" && frag) {
                cur.args += frag;
                // Forward the fragment so the live-coding decoder can render the
                // file as it is written, rather than after the call completes.
                try { onDelta({ toolArgs: frag, ...(cur.name ? { toolName: cur.name } : {}) }); }
                catch { /* listener errors never break the stream */ }
              }
              toolAcc.set(idx, cur);
            }
          }
        },
        () => params.signal?.aborted === true,
      );
    }
  } catch (err) {
    // Tear the response down before propagating. releaseLock() alone leaves the
    // upstream connection open — on a stalled stream that holds a socket (and
    // the provider's concurrency slot, which on a free tier is the scarce
    // resource) until the whole fetch budget expires. cancel() also settles the
    // read still pending from the Promise.race, so releaseLock cannot throw.
    await reader.cancel().catch(() => {});
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (params.signal?.aborted) throw new DOMException("aborted", "AbortError");
    throw err;
  } finally {
    try { reader.releaseLock?.(); } catch { /* already released by cancel() */ }
  }
  const tool_calls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ type: "function", function: { name: v.name, arguments: v.args } }))
    .filter((t) => t.function.name);
  return {
    choices: [{
      message: {
        content: text,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(tool_calls.length ? { tool_calls } : {}),
      },
      ...(finishReason ? { finish_reason: finishReason } : {}),
    }],
    ...(usage ? { usage } : {}),
  };
}

export async function chat(params: ChatParams): Promise<ChatResult> {
  const model = registry.get(params.modelId);
  const baseUrl = model?.baseUrl || DEFAULT_ROUTER_BASE;
  const settings = loadSettings();
  const provider = settings.providers.find((p) => p.name === model?.provider);
  const apiKey = provider?.apiKey || "sk-engine-key";

  const started = Date.now();
  const timeoutMs = params.timeoutMs ?? CHAT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (params.taskId) headers["x-engine-task"] = params.taskId;
  if (params.sessionId) headers["x-session-id"] = params.sessionId;
  if (params.agentRole) headers["x-agent-role"] = params.agentRole;

  const cleanMessages = params.messages.map((m: any) => {
    const c: Record<string, unknown> = {
      role: m.role,
      content: typeof m.content === "string" ? m.content : (m.content !== undefined ? String(m.content) : ""),
    };
    if (m.name !== undefined) c.name = m.name;
    if (m.tool_calls !== undefined) c.tool_calls = m.tool_calls;
    if (m.tool_call_id !== undefined) c.tool_call_id = m.tool_call_id;
    return c;
  });

  let res: Response;
  const useResponses = isResponsesOnlyModel(params.modelId);
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/${useResponses ? "responses" : "chat/completions"}`, {
      method: "POST",
      headers,
      body: useResponses
        ? JSON.stringify({
            model: params.modelId,
            input: cleanMessages,
            temperature: params.temperature ?? 0.2,
            max_output_tokens: Math.min(params.maxTokens ?? 4096, model?.maxOutput ?? 16384),
            stream: false,
          })
        : JSON.stringify({
            model: params.modelId,
            messages: cleanMessages,
            temperature: params.temperature ?? 0.2,
            max_tokens: Math.min(params.maxTokens ?? 4096, model?.maxOutput ?? 16384),
            // Wave 25: token streaming for fluid chat UI (forge parity). Only
            // for chat/completions endpoints — Responses-API models stay
            // non-streaming (the router wraps their single completion).
            ...(params.onDelta ? { stream: true } : {}),
            // Declare tools natively when the caller supplies them. Without
            // this a tool-trained model still tries to call a tool and the
            // provider 400s with "Tool choice is none, but model called a
            // tool", returning an empty content field.
            ...(params.tools && params.tools.length ? { tools: params.tools } : {}),
            ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
            // B28: responseFormat:"json" used to be dropped on the floor — the
            // planner/reviewer JSON contracts silently relied on fence-stripping.
            // OpenAI-compatible endpoints understand json_object.
            ...(params.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
          }),
      signal: fuseSignal(params.signal, timeoutMs),
    });
  } catch (err) {
    const mapped = mapFetchAbort(err, params.signal, timeoutMs);
    if (mapped instanceof LlmError) {
      log("warn", "providers", "chat aborted at hard cap", { model: params.modelId, timeoutMs, error: mapped.message.slice(0, 300) });
    } else {
      log("debug", "providers", "chat aborted by caller", { model: params.modelId });
    }
    throw mapped;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const clientBlame = /\b(invalid|exceed|too long|too large|required|unsupported|not support|malformed|missing|empty|context length)\b/i.test(body);
    const modelDead = /\b(unavailable|not found|does not exist|no longer|deactivated|deprecated)\b/i.test(body);
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 400 && (modelDead || !clientBlame));
    log(retryable ? "warn" : "error", "providers", "chat failed", {
      model: params.modelId,
      status: res.status,
      latencyMs: Date.now() - started,
      retryable,
      error: body.slice(0, 300),
    });
    throw new LlmError(`${res.status} ${body.slice(0, 300)}`, res.status, retryable);
  }

  // Capture the router's real decision BEFORE the body is consumed. Works for
  // both paths: the proxy sets the header on the streaming response too.
  const upstream = parseUpstreamRoute(res.headers.get("x-engine-route"));

  let json: any;
  const ctype = res.headers.get("content-type") ?? "";
  if (params.onDelta && !useResponses && ctype.includes("text/event-stream") && res.body) {
    // ── Streaming path (wave 25): parse SSE, forward deltas, aggregate ──
    //
    // This read MUST go through mapFetchAbort like the two paths around it.
    // Once the response headers arrive, the hard-cap timer is still armed
    // against the body: a provider that opens a stream and then stalls trips it
    // from INSIDE this read. Unmapped, that surfaces as a bare DOMException
    // ("The operation timed out."), which is not an LlmError — so the router
    // never marks it retryable, no fallback model is tried, and the step dies
    // as "internal error" after 180s of total silence. Observed killing a task
    // whose files were already correctly written to disk.
    try {
      json = await readSseCompletion(res, params);
    } catch (err) {
      const mapped = mapFetchAbort(err, params.signal, timeoutMs);
      if (mapped instanceof LlmError) {
        log("warn", "providers", "stream aborted at hard cap", { model: params.modelId, timeoutMs });
      }
      throw mapped;
    }
  } else {
    try {
      json = (await res.json()) as any;
    } catch (err) {
      throw mapFetchAbort(err, params.signal, timeoutMs);
    }
  }
  // Responses-API models: translate the payload back to chat/completions shape
  // so the choices/usage extraction below works unchanged.
  if (useResponses && json) json = normalizeResponsesToChat(json);

  const choice = json.choices?.[0];
  const rawText: string =
    typeof choice?.message?.content === "string"
      ? choice.message.content
      : Array.isArray(choice?.message?.content)
        ? choice.message.content.map((c: any) => c.text ?? "").join("")
        : "";

  let reasoningContent: string | undefined =
    choice?.message?.reasoning_content || choice?.message?.reasoning || undefined;

  const toolCalls = parseNativeToolCalls(choice?.message?.tool_calls);
  const truncated = choice?.finish_reason === "length";

  let { text, reasoning } = sanitizeThinkTags(rawText);
  if (!reasoningContent && reasoning) {
    reasoningContent = reasoning;
  }
  // Reasoning is NOT an answer.
  //
  // This fallback used to run unconditionally, and it is what turned "the model
  // produced no content" into "the model said <its internal monologue>". In the
  // tool loop that is actively harmful: the monologue parses as prose, no
  // TOOL_CALL is found, a nudge is burned, and the step eventually fails with a
  // summary like "We need to edit calc.py. Let's list directory." — the model
  // thinking out loud, recorded as its output.
  //
  // Leaving `text` empty instead lets the real recovery paths fire: chatRace
  // files an `empty` outcome (small penalty, retry on another model) and the
  // tool loop nudges against an obviously-empty reply. Chat-style callers that
  // genuinely want reasoning-as-answer opt in via allowReasoningAsText.
  if (!text.trim() && toolCalls.length === 0 && params.allowReasoningAsText) {
    if (reasoning || reasoningContent || rawText.trim()) {
      text = (reasoning || reasoningContent || rawText).trim();
    }
  }

  // B15: usage fallback. Provider-reported counts win; when they are missing
  // (free/proxied upstreams) estimate from prompt + completion size so budget
  // and token caps can actually trip. Marked estimated for honest accounting.
  const usage = json.usage;
  const promptChars = params.messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length),
    0,
  );
  const reportedIn = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const reportedOut = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const estimated = reportedIn === undefined || reportedOut === undefined;
  const tokensIn = reportedIn ?? Math.ceil(promptChars / 3.5);
  const tokensOut = reportedOut ?? estTokensText(text);

  log("info", "providers", "chat ok", {
    model: params.modelId,
    status: res.status,
    latencyMs: Date.now() - started,
    tokensIn,
    tokensOut,
    ...(estimated ? { estimated: true } : {}),
  });

  return {
    text,
    reasoningContent,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(upstream ? { upstream } : {}),
    tokensIn,
    tokensOut,
    latencyMs: Date.now() - started,
    raw: json,
    ...(estimated ? { estimated: true } : {}),
  };
}

export const SWEEP_TIMEOUT_MS = 30_000;
const SWEEP_SKIP_PENALTY = 2.0;

export async function chatSweep(params: ChatParams, exclude: string[]): Promise<ChatResult & { modelId: string }> {
  let routerMod: typeof import("./router.js") | undefined;
  try {
    routerMod = await import("./router.js");
  } catch {
    /* ignore */
  }
  const excludeSet = new Set(exclude.filter(Boolean));
  // B16: the last-resort sweep used to ignore the operator's disabled list and
  // the breaker entirely — it happily hammered models the human switched off
  // or the breaker had opened. Honor both.
  const disabled = new Set(loadSettings().disabledModels ?? []);
  const pool = registry.list().filter((m) => {
    if (!m.enabled || excludeSet.has(m.id) || disabled.has(m.id)) return false;
    const bState = routerMod ? routerMod.effectiveBreakerState(m.id) : "closed";
    return bState === "closed" || bState === "half-open" || bState === "degraded";
  });
  const tried: string[] = [];
  const skippedHealth: string[] = [];
  let lastErr: unknown = new LlmError("sweep: no eligible models", undefined, false);

  for (const m of pool) {
    if (params.signal?.aborted) break;
    const penalty = routerMod ? routerMod.effectivePenalty(m.id) : 0;
    if (penalty >= SWEEP_SKIP_PENALTY) {
      skippedHealth.push(m.id);
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await chat({
        ...params,
        modelId: m.id,
        timeoutMs: Math.min(params.timeoutMs ?? SWEEP_TIMEOUT_MS, SWEEP_TIMEOUT_MS),
      });
      if (!r.text.trim()) throw new LlmError(`${m.id}: empty completion`, undefined, true);
      // B16: success is recorded ONCE — by the caller (orchestrator's
      // sweepLastResort records the winner). Recording here too double-fed
      // the health ledger for every swept success.
      return { ...r, modelId: m.id };
    } catch (err) {
      tried.push(m.id);
      const latencyMs = Date.now() - t0;
      const status = err instanceof LlmError ? err.status : undefined;
      const retryable = !(err instanceof LlmError) || err.retryable;
      log(retryable ? "warn" : "error", "providers", "sweep attempt failed", {
        model: m.id, status, latencyMs, error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
      // B26: pass the REAL status — recordOutcome's 4xx exemption already
      // keeps request-blame (400/401/403) out of the health ledger. Remapping
      // 400→503 used to poison healthy models for config errors.
      routerMod?.recordOutcome(m.id, false, latencyMs, status);
      lastErr = err;
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new LlmError(
    `full-registry sweep exhausted (${tried.length} tried${skippedHealth.length ? `, ${skippedHealth.length} health-skipped` : ""}): ${detail}`,
    lastErr instanceof LlmError ? lastErr.status : 503,
    true,
  );
}

export interface RaceError extends Error {
  raceModelId?: string;
}

export interface ChatRaceParams extends ChatParams {
  candidates: string[];
  staggerMs?: number;
  maxSlotMs?: number;
  onWinner?: (modelId: string) => void;
  /** B15: for outcome:"empty" the loser DID return a 200-OK completion, so its
   *  (usually prompt-side) token usage is reported here and must be counted by
   *  the caller — tokens spent are tokens spent, winner or not. */
  onLoser?: (info: { modelId: string; outcome: "error" | "aborted" | "empty"; latencyMs: number; error?: unknown; tokensIn?: number; tokensOut?: number; estimated?: boolean }) => void;
}

function raceErrorRank(err: unknown): number {
  if (err instanceof LlmError) return err.status !== undefined ? 2 : 1;
  return 0;
}

export async function chatRace(params: ChatRaceParams): Promise<ChatResult & { modelId: string }> {
  const candidates = params.candidates.filter(Boolean).slice(0, 3);
  if (candidates.length === 0) throw new LlmError("chatRace: no candidates", undefined, false);
  const staggerMs = Math.max(0, params.staggerMs ?? 1500);
  // B16: 45 s per-slot used to kill slow-but-healthy models mid-thought; the
  // orchestrator passes role-specific caps (coder/reviewer get 120 s) and the
  // default here is raised to match real completion times.
  const maxSlotMs = Math.max(5000, params.maxSlotMs ?? 90_000);

  interface Slot { modelId: string; ctl: AbortController; done: boolean; failed: boolean }
  const slots: Slot[] = candidates.map((modelId) => ({ modelId, ctl: new AbortController(), done: false, failed: false }));
  const staggerCancels: (() => void)[] = [];
  let winner: (ChatResult & { modelId: string }) | null = null;
  let callerAborted = false;
  /** Wave 25: index of the first slot that emitted a stream delta (-1 = none). */
  let leaderIdx = -1;
  const failErrs: unknown[] = [];
  const errModel = new Map<unknown, string>();

  const stopLosers = (exceptIdx: number): void => {
    slots.forEach((s, i) => {
      if (i !== exceptIdx && !s.done) s.ctl.abort();
    });
    for (const cancel of staggerCancels) cancel();
  };

  const runOne = async (slot: Slot): Promise<void> => {
    const started = Date.now();
    const slotTimer = setTimeout(() => {
      if (!slot.done) {
        slot.ctl.abort();
      }
    }, maxSlotMs);
    if (typeof (slotTimer as unknown as { unref?: () => void }).unref === "function") {
      (slotTimer as unknown as { unref: () => void }).unref();
    }

    const signal =
      params.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([params.signal, slot.ctl.signal])
        : slot.ctl.signal;
    // Wave 25 streaming race: the FIRST slot to emit a real delta becomes the
    // leader — its deltas are forwarded to the caller, and every other slot is
    // aborted immediately (token-level race: losers stop spending as soon as a
    // leader is visible, instead of running to completion). Slots whose model
    // answers without streaming (JSON path) can still win by completing first.
    const slotIdx = slots.indexOf(slot);
    const slotOnDelta = params.onDelta
      ? (d: StreamDelta) => {
          if (leaderIdx === -1 && (d.text || d.reasoning)) {
            leaderIdx = slotIdx;
            slots.forEach((s, i) => {
              if (i !== slotIdx && !s.done) s.ctl.abort();
            });
            for (const cancel of staggerCancels) cancel();
          }
          if (leaderIdx === slotIdx) params.onDelta!(d);
        }
      : undefined;
    try {
      const res = await chat({
        ...params,
        modelId: slot.modelId,
        signal,
        ...(slotOnDelta ? { onDelta: slotOnDelta } : {}),
      });
      if (!res.text.trim()) {
        // B16: an empty 200-OK is its OWN outcome. It used to throw a
        // status-less LlmError that recordOutcome filed as fail5xx += 0.8 and
        // the breaker could trip — one empty reply demoted a healthy model
        // for minutes. Callers now get outcome:"empty" and apply a small,
        // non-breaker penalty instead.
        slot.done = true;
        slot.failed = true;
        const latencyMs = Date.now() - started;
        const emptyErr = new LlmError(`${slot.modelId}: empty completion`, undefined, true);
        failErrs.push(emptyErr);
        errModel.set(emptyErr, slot.modelId);
        params.onLoser?.({
          modelId: slot.modelId, outcome: "empty", latencyMs, error: emptyErr,
          // B15: report the 200-OK usage so the caller can count it.
          tokensIn: res.tokensIn, tokensOut: res.tokensOut,
          ...(res.estimated ? { estimated: true } : {}),
        });
        return;
      }
      slot.done = true;
      if (winner) {
        // B15: a late 200-OK finisher still spent its tokens even though it
        // lost the race — report them (outcome stays "aborted": no health
        // impact, that is the race working) so the caller can count them.
        params.onLoser?.({
          modelId: slot.modelId, outcome: "aborted", latencyMs: Date.now() - started,
          tokensIn: res.tokensIn, tokensOut: res.tokensOut,
          ...(res.estimated ? { estimated: true } : {}),
        });
        return;
      }
      winner = { ...res, modelId: slot.modelId };
      stopLosers(slots.indexOf(slot));
      params.onWinner?.(slot.modelId);
    } catch (err) {
      slot.done = true;
      const latencyMs = Date.now() - started;
      if (slot.ctl.signal.aborted || params.signal?.aborted) {
        params.onLoser?.({ modelId: slot.modelId, outcome: "aborted", latencyMs, error: err });
        if (params.signal?.aborted) callerAborted = true;
        return;
      }
      slot.failed = true;
      failErrs.push(err);
      errModel.set(err, slot.modelId);
      params.onLoser?.({ modelId: slot.modelId, outcome: "error", latencyMs, error: err });
    } finally {
      clearTimeout(slotTimer);
    }
  };

  const launchOrSkip = async (idx: number): Promise<void> => {
    if (idx > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, idx * staggerMs);
        staggerCancels.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (winner || slots[idx]!.done || params.signal?.aborted) return;
    await runOne(slots[idx]!);
  };

  await Promise.all(slots.map((_s, i) => launchOrSkip(i)));

  if (winner) return winner;
  if (callerAborted) throw new DOMException("aborted", "AbortError");
  const best = [...failErrs].sort((a, b) => raceErrorRank(a) - raceErrorRank(b)).pop();
  if (best instanceof Error) (best as RaceError).raceModelId = errModel.get(best);
  throw best ?? new LlmError("all racing models failed", 503, true);
}

