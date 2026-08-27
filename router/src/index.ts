/**
 * Agent Router — server entry.
 *
 *   bun run src/index.ts          # listens on ROUTER_PORT (default 4098)
 *
 * Surface:
 *   POST /v1/chat/completions     smart-routing OpenAI-compatible proxy
 *   GET  /health                  liveness + db + provider health
 *   GET  /routes                  tier table + provider health/counters
 *   GET  /telemetry/calls         ?task=&limit=
 *   GET  /telemetry/task/:id      task ledger row + summary + recent calls
 *   GET  /telemetry/tree          ?task= nested trace tree (route->attempt+calls)
 *   GET  /telemetry/tasks         task ledger rows (dashboard task selector)
 *   POST /keys                    {provider, key}  (stored masked in replies)
 *   GET  /keys                    masked key inventory (providers map + legacy array)
 *   GET  /watchdog/status         active sessions, windows, interventions
 *   POST /watchdog/attach         {engineUrl, directory} — begin watching
 *   /fs/*                         jailed file mutations (mkdir/touch/write/
 *                                 rename/delete/info) for the web IDE
 *   GET /fs/events                SSE stream of {op,root,paths} mutation frames
 *                                 (cross-tab refresh for the IDE file tree)
 *
 * Env:
 *   ROUTER_PORT / PORT    listen port (default 4098)
 *   ROUTER_DB             sqlite path override
 *   ENGINE_URL            watchdog auto-attach target (default http://127.0.0.1:4100)
 *   WATCH_DIR             optional directory filter; unset = global attach
 *   EXTRA_ORIGIN          comma-separated extra trusted origins for the write guard
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  DEFAULT_PROVIDERS,
  MAX_PARAM_B,
  findProvider,
  findByModality,
  healthSnapshot,
  isProviderHealthy,
  rpmLastMinute,
  type Provider,
  type Tier,
} from "./providers";
import { defaultDbPath, telemetryRoutes, Telemetry } from "./telemetry";
import { proxyRoutes } from "./proxy";
import { RouteService, type RoutePolicy, type RouteServiceDeps } from "./router";
import { getWatchdog, startWatchdog, watchdogRoutes } from "./watchdog";
import { createFsRoutes } from "./fs";
import { AttributionService, ATTRIBUTION_STALE_MS } from "./attr";

export const DEFAULT_PORT = 4098;
/** Engine the watchdog auto-attaches to when ENGINE_URL is unset. */
export const DEFAULT_ENGINE_URL = "http://127.0.0.1:4100";
/** Retry cadence while the engine is absent at boot. */
export const AUTO_ATTACH_RETRY_MS = 30_000;

/**
 * Origins the web IDE is served from and that may issue state-changing requests.
 */
const TRUSTED_ORIGINS = [
  "http://localhost:4444",
  "http://127.0.0.1:4444",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RouterOptions {
  /** Override sqlite path. Defaults to router/data/router.db. */
  dbPath?: string;
  /** Override provider registry (tests use fake local providers). */
  providers?: Provider[];
  policy?: RoutePolicy;
  attribution?: AttributionService;
}

export interface RouterApp {
  app: Hono;
  telemetry: Telemetry;
  providers: Provider[];
  policy: RoutePolicy;
  /** B22: the attribution instance the proxy uses, shared with the watchdog. */
  attribution: AttributionService;
}

function envKeyFor(providers: Provider[], providerId: string): string | null {
  const p = findProvider(providers, providerId);
  if (!p) return null;
  const v = process.env[p.envKey];
  // F4: return the trimmed value — an env key with stray whitespace would go out
  // as `Bearer <key> ` and 401 forever.
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function createRouterApp(opts: RouterOptions = {}): RouterApp {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  // Audit F6: enforce the <=80B cap for EVERY provider at startup. The seed-time
  // model() helper only guards DEFAULT_PROVIDERS; opts.providers was unvalidated
  // and param_b was never consulted at routing time (NaN also slipped past the
  // `> MAX_PARAM_B` check). Fail fast on a non-finite or over-cap entry.
  for (const prov of providers) {
    for (const m of prov.models) {
      if (!Number.isFinite(m.param_b) || m.param_b > MAX_PARAM_B) {
        throw new Error(
          `provider "${prov.id}" model "${m.model_id_per_provider}": param_b ${String(m.param_b)} is not finite or exceeds the ${MAX_PARAM_B}B cap`,
        );
      }
    }
  }
  const telemetry = new Telemetry(opts.dbPath ?? defaultDbPath());

  const resolveKey = (providerId: string, role?: string): string | null =>
    telemetry.getKeyForRole(providerId, role) ?? envKeyFor(providers, providerId);

  // Free-tier lock defaults ON: under the evaluation formula one cent of spend
  // costs the same score as 163 seconds of wall clock, so the router must not
  // reach a priced model unless an operator explicitly allows it.
  const allowPaid = /^(1|true|yes)$/i.test((process.env["ROUTER_ALLOW_PAID"] ?? "").trim());
  const policyDeps: RouteServiceDeps = { telemetry, providers, freeOnly: !allowPaid };
  const routeService = new RouteService(policyDeps);
  const policy: RoutePolicy = opts.policy ?? routeService;

  const app = new Hono();
  // CORS: expose x-engine-route so dashboard JS can read the route decision
  app.use("*", cors({ exposeHeaders: ["x-engine-route"] }));

  // Origin protection
  const extraOrigins = (process.env["EXTRA_ORIGIN"] ?? process.env["ROUTER_EXTRA_ORIGIN"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const trustedOrigins = new Set([...TRUSTED_ORIGINS, ...extraOrigins]);

  app.use("*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin !== undefined && !trustedOrigins.has(origin)) {
        return c.json({ error: "origin_not_allowed" }, 403);
      }
    }
    await next();
  });

  const attribution = opts.attribution ?? new AttributionService(ATTRIBUTION_STALE_MS);
  app.route("/", telemetryRoutes(telemetry));
  app.route(
    "/",
    proxyRoutes({
      providers,
      telemetry,
      policy,
      resolveKey,
      outcomes: policy === routeService ? routeService : undefined,
      attribution,
    }),
  );
  app.route("/", watchdogRoutes({ telemetry, attribution }));
  app.route("/", createFsRoutes({ telemetry }));

  app.get("/health", (c) => {
    const dbOk = telemetry.ping();
    const providerStates: Record<string, boolean> = {};
    for (const p of providers) providerStates[p.id] = isProviderHealthy(p.id);
    return c.json({
      ok: dbOk,
      service: "agent-router",
      version: "0.1.0",
      db: dbOk ? "ok" : "error",
      time: Date.now(),
      providers: providerStates,
    });
  });

  app.get("/models", (c) => {
    const list = providers.flatMap((p) => p.models.map((m) => ({ id: m.model_id_per_provider, object: "model", created: Date.now(), owned_by: p.id })));
    return c.json({ object: "list", data: list });
  });

  app.get("/v1/models", (c) => {
    const list = providers.flatMap((p) => p.models.map((m) => ({ id: m.model_id_per_provider, object: "model", created: Date.now(), owned_by: p.id })));
    return c.json({ object: "list", data: list });
  });

  app.get("/routes", (c) => {
    const snap = healthSnapshot();
    const tiers: Record<Tier, Array<{ provider: string; model: string; ctx_window: number; price_in: number; price_out: number; param_b: number }>> = {
      S: [],
      M: [],
      L: [],
    };
    for (const p of providers) {
      for (const m of p.models) {
        if (m.modality && m.modality !== "text") continue;
        tiers[m.tier].push({
          provider: p.id,
          model: m.model_id_per_provider,
          ctx_window: m.ctx_window,
          price_in: m.price_in,
          price_out: m.price_out,
          param_b: m.param_b,
        });
      }
    }
    return c.json({
      policy: policy.name,
      // Free-tier lock state, surfaced so the Settings screen and the routing
      // badge can show it without a second round trip (PS 3b: the routing
      // decision can never be hidden).
      free_tier_only: routeService.freeTierOnly,
      role_pins: routeService.rolePinSnapshot(),
      tiers,
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        baseURL: p.baseURL,
        notes: p.notes,
        models_seeded: p.models.length,
        key_configured: resolveKey(p.id) !== null,
        healthy: isProviderHealthy(p.id),
        consecutive_429: snap[p.id]?.consecutive_429 ?? 0,
        consecutive_5xx: snap[p.id]?.consecutive_5xx ?? 0,
        last_rate_limit_ts: snap[p.id]?.last_rate_limit_ts ?? null,
        rpm_last_minute: rpmLastMinute(p.id),
      })),
    });
  });

  // Role -> model capability pins (Forge pattern: a specific model per role).
  /**
   * Speech-to-text. One endpoint for the UI regardless of who actually serves
   * ASR, which matters here because the obvious provider does not: NVIDIA does
   * not expose Whisper on its hosted API (absent from /v1/models, five endpoint
   * shapes 404, only text-translation Riva models are reachable), so this
   * resolves to whichever catalogued provider declares the capability.
   *
   * The audio is streamed straight through as multipart — never buffered into
   * a data: URL — because a few minutes of speech is megabytes, and base64
   * inflates it by a third before it reaches the provider.
   */
  app.post("/v1/audio/transcriptions", async (c) => {
    const hit = findByModality(providers, "transcription");
    if (!hit) return c.json({ error: "no catalogued provider serves transcription" }, 501);

    const prov = findProvider(providers, hit.providerId);
    const key = resolveKey(hit.providerId, "transcriber");
    if (!prov || !key) {
      return c.json({ error: `transcription needs a ${hit.providerId} API key — add one in Settings` }, 401);
    }

    const inForm = await c.req.formData().catch(() => null);
    const file = inForm?.get("file");
    if (!file || typeof file === "string") return c.json({ error: "multipart field 'file' is required" }, 400);

    const out = new FormData();
    out.append("file", file);
    out.append("model", hit.model.model_id_per_provider);
    // Pass through the optional hints the OpenAI audio API defines.
    for (const k of ["language", "prompt", "temperature", "response_format"]) {
      const v = inForm?.get(k);
      if (typeof v === "string" && v) out.append(k, v);
    }

    const started = Date.now();
    try {
      const res = await fetch(`${prov.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: out,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
          // Routing is never hidden (PS 3b): say who transcribed and how long.
          "x-engine-route": JSON.stringify({
            provider: hit.providerId,
            model: hit.model.model_id_per_provider,
            modality: "transcription",
            latency_ms: Date.now() - started,
          }),
          "access-control-expose-headers": "x-engine-route",
        },
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  /** Which model serves a capability — the UI shows this before you record. */
  app.get("/capabilities", (c) => {
    const out: Record<string, unknown> = {};
    for (const m of ["vision", "transcription"] as const) {
      const hit = findByModality(providers, m);
      out[m] = hit
        ? { provider: hit.providerId, model: hit.model.model_id_per_provider,
            param_b: hit.model.param_b, key_present: !!resolveKey(hit.providerId) }
        : null;
    }
    return c.json(out);
  });

  app.get("/policy/role-pins", (c) => c.json({ pins: routeService.rolePinSnapshot() }));
  app.post("/policy/role-pins", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; model?: unknown };
    if (typeof body.role !== "string" || !body.role.trim()) {
      return c.json({ error: "role required" }, 400);
    }
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    // A pin naming a model outside the catalog would be silently ignored at
    // routing time; reject it here so the operator finds out immediately.
    if (model && !providers.some((p) => p.models.some((m) => m.model_id_per_provider === model))) {
      return c.json({ error: `model "${model}" is not in the <=80B catalog` }, 400);
    }
    routeService.setRolePin(body.role.trim(), model);
    return c.json({ pins: routeService.rolePinSnapshot() });
  });

  // Free-tier lock toggle. Locked by default; ROUTER_ALLOW_PAID=1 unlocks at
  // boot, and this route lets the Settings screen flip it live.
  app.get("/policy/free-tier", (c) => c.json({ free_tier_only: routeService.freeTierOnly }));
  app.post("/policy/free-tier", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof body.on !== "boolean") {
      return c.json({ error: 'body must be {"on": true|false}' }, 400);
    }
    routeService.setFreeTierOnly(body.on);
    return c.json({ free_tier_only: routeService.freeTierOnly });
  });

  return { app, telemetry, providers, policy, attribution };
}

export function startRouterServer(app: Hono, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
}

async function engineReachable(engineUrl: string): Promise<boolean> {
  try {
    await fetch(engineUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    return true;
  } catch {
    return false;
  }
}

async function tryAutoAttach(telemetry: Telemetry, attribution?: AttributionService): Promise<boolean> {
  if (getWatchdog()) return true;
  const engineUrl = (process.env["ENGINE_URL"] ?? process.env["ROUTER_ENGINE_URL"] ?? DEFAULT_ENGINE_URL).replace(/\/+$/, "");
  const watchDir = process.env["WATCH_DIR"] ?? process.env["ROUTER_WATCH_DIR"];
  const directory = watchDir && watchDir.trim().length > 0 ? watchDir.trim() : undefined;
  if (!(await engineReachable(engineUrl))) return false;
  // §5-19: a manual POST /watchdog/attach may have landed during the (up to 2.5s)
  // reachability probe — re-check so auto-attach does not clobber it.
  if (getWatchdog()) return true;
  // B22: share the SAME AttributionService instance the proxy uses, so headerless
  // calls the watchdog attributes actually land where the proxy reads them (no
  // split-brain between the getAttribution() singleton and the per-app instance).
  const handle = startWatchdog({ engineUrl, ...(directory ? { directory } : {}), telemetry, ...(attribution ? { attribution } : {}) });
  console.log(
    `[agent-router] watchdog attached to engine ${engineUrl}` +
      (directory ? ` (directory filter: ${directory})` : " (global)") +
      ` — attached:${handle.status().attached}`,
  );
  return true;
}

function scheduleAutoAttach(telemetry: Telemetry, attribution?: AttributionService): void {
  let warned = false;
  let inFlight = false;
  const attempt = async (): Promise<boolean> => {
    if (inFlight) return getWatchdog() !== null;
    inFlight = true;
    try {
      const ok = await tryAutoAttach(telemetry, attribution);
      if (!ok && !warned) {
        warned = true;
        console.warn(
          `[agent-router] engine unreachable at boot — retrying watchdog attach every ` +
            `${AUTO_ATTACH_RETRY_MS / 1000}s (env ENGINE_URL, or POST /watchdog/attach to override)`,
        );
      }
      return ok;
    } finally {
      inFlight = false;
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    void attempt().then((ok) => {
      if (ok && timer) clearInterval(timer);
    });
  }, AUTO_ATTACH_RETRY_MS);
  void attempt().then((ok) => {
    if (ok && timer) clearInterval(timer);
  });
}

async function main(): Promise<void> {
  const rawPort = Number.parseInt(process.env["ROUTER_PORT"] ?? process.env["PORT"] ?? "", 10);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT;
  const router = createRouterApp();
  const server = startRouterServer(router.app, port);
  console.log(
    `[agent-router] listening on http://localhost:${server.port} ` +
      `(db: ${router.telemetry.path}, providers: ${router.providers.map((p) => p.id).join(", ")})`,
  );
  scheduleAutoAttach(router.telemetry, router.attribution);
}

if (import.meta.main) {
  void main();
}
