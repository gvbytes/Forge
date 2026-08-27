/**
 * POST /v1/chat/completions — OpenAI-compatible smart-routing proxy.
 *
 * Per attempt: forward the request body with `model` REWRITTEN to the
 * candidate's concrete per-provider model id, write one kind="attempt"
 * trace row + calls row linked to the completion's kind="route" trace,
 * and on success attach `x-engine-route: {provider, model, tier, reason, attempts}`.
 * Streaming responses pipe upstream SSE bytes through a TransformStream untouched
 * and append one trailing SSE comment line echoing the route header (`: x-engine-route {...}`).
 * On abort the upstream reader is cancelled and a best-effort `: upstream aborted`
 * comment is emitted before close.
 *
 * Attribution: explicit x-session-id wins; otherwise the call is
 * attributed to the most recently active engine session reported by the
 * watchdog listener (AttributionService), and that sessionID doubles as the
 * task-ledger key so BudgetGovernor/cascade see the traffic.
 */
import { Hono } from "hono";
import type { Provider } from "./providers";
import {
  allModels,
  findProvider,
  isProviderHealthy,
  isTier,
  markRateLimited,
  markServerError,
  markSuccess,
  priceFor,
  RATE_LIMIT_COOLDOWN_MAX_S,
} from "./providers";
import type { RouteCandidate, RouteDecision, RouteOutcomeSink, RoutePolicy } from "./router";
import { aliasTierFor, planRoute } from "./router";
import { getAttribution, type AttributionService } from "./attr";
import type { Telemetry } from "./telemetry";

const MAX_ATTEMPTS = 3;
// Wave 25 P0: was 120s — a provider that accepts TCP but never sends headers
// cost up to 120s × 3 attempts = 6 MINUTES per request. Free providers queue
// under load, so keep headroom, but 45s covers the slowest observed real TTFB
// (nemotron-3-ultra p50 ≈ 19s) with margin; worst case is now 3 × 45s = 135s.
const UPSTREAM_TIMEOUT_MS = 30_000;
const ERROR_SNIPPET_MAX = 300;

export interface AttemptLog {
  provider: string;
  model: string;
  /**
   * Which key served this attempt, as "2/3" — never the key itself.
   *
   * With one provider and three keys, "it fell back" is invisible unless the
   * trace says which key was used: every attempt otherwise reads
   * nvidia-nim/gpt-oss-20b and looks like a pointless retry of the same thing.
   */
  key?: string;
  status: "ok" | "fail" | "skipped";
  http: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface ProxyDeps {
  providers: Provider[];
  telemetry: Telemetry;
  policy: RoutePolicy;
  /** keys table first, then env var; never logged. */
  /** Role-aware: a provider may hold several keys, pinned per agent role. */
  resolveKey: (providerId: string, role?: string) => string | null;
  /**
   * Outcome feedback into the per-task cascade (RouteService).
   */
  outcomes?: RouteOutcomeSink;
  /** Session attribution; defaults to the process-wide shared service. */
  attribution?: AttributionService;
}

interface UsagePair {
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

// ---------------------------------------------------------------------------
// parsing helpers (strict TS, no `any`)
// ---------------------------------------------------------------------------

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= ERROR_SNIPPET_MAX ? t : `${t.slice(0, ERROR_SNIPPET_MAX)}…`;
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const n = Number.parseFloat(headerValue);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.round(n), 1), RATE_LIMIT_COOLDOWN_MAX_S);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readUsage(obj: Record<string, unknown>): UsagePair {
  const u = obj["usage"];
  if (!u || typeof u !== "object" || Array.isArray(u)) {
    return { prompt_tokens: null, completion_tokens: null };
  }
  const rec = u as Record<string, unknown>;
  return { prompt_tokens: numOrNull(rec["prompt_tokens"]), completion_tokens: numOrNull(rec["completion_tokens"]) };
}

/** Pull the final usage-bearing chunk out of an SSE body without altering it. */
/** Wave 25 P5: incremental stream-usage scanner. The old path accumulated the
 *  ENTIRE SSE body in memory and re-parsed EVERY data line once the stream
 *  ended (5–20ms delay at stream close + a second copy of the whole stream).
 *  Usage rides in at most one chunk (usually the final one), so scan lines as
 *  bytes pass through and keep the last line carrying usage. The `"usage"`
 *  pre-filter skips JSON.parse for the ~99% of chunks that carry only deltas.
 *  Exported for tests. */
export function createUsageScanner(): { feed: (text: string) => void; finish: () => UsagePair | null } {
  let tail = "";
  let found: UsagePair | null = null;
  const scanLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    if (!payload.includes('"usage"')) return; // cheap pre-filter — no parse
    const obj = tryParseObject(payload);
    if (!obj) return;
    const u = readUsage(obj);
    if (u.prompt_tokens !== null || u.completion_tokens !== null) found = u;
  };
  return {
    feed(text: string): void {
      tail += text;
      const lines = tail.split("\n");
      tail = lines.pop() ?? ""; // keep the possibly-incomplete last line
      for (const line of lines) scanLine(line);
    },
    finish(): UsagePair | null {
      if (tail) scanLine(tail);
      tail = "";
      return found;
    },
  };
}

function computeCost(prices: { price_in: number; price_out: number } | null, usage: UsagePair): number | null {
  if (!prices) return null;
  if (usage.prompt_tokens === null && usage.completion_tokens === null) return null;
  const pt = usage.prompt_tokens ?? 0;
  const ct = usage.completion_tokens ?? 0;
  return (pt * prices.price_in + ct * prices.price_out) / 1_000_000;
}

/** Matches rate-limit signals in the STRUCTURED error fields only (never in
 * arbitrary completion content). Also accepts a plain-string error body, which
 * some providers use instead of an error object. */
const RATE_LIMIT_ERROR_RE = /rate.?limit|too many requests|quota/i;

function looksLikeRateLimitError(err: unknown): boolean {
  if (typeof err === "string") return RATE_LIMIT_ERROR_RE.test(err);
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const fields = ["code", "type", "message", "status"];
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === "string" && RATE_LIMIT_ERROR_RE.test(v)) return true;
    if (typeof v === "number" && v === 429) return true;
  }
  return false;
}

function errorObjectSnippet(err: unknown): string {
  if (err === null || err === undefined) return "unknown upstream error";
  if (typeof err === "string") return snippet(err);
  try {
    return snippet(JSON.stringify(err));
  } catch {
    return "unserializable upstream error";
  }
}

const HEADER_UNICODE_STANDINS: ReadonlyArray<[RegExp, string]> = [
  [/→/g, "->"],
  [/⇒/g, "=>"],
  [/↔/g, "<->"],
  [/…/g, "..."],
];

function headerSafe(value: string): string {
  let out = value;
  for (const [pattern, replacement] of HEADER_UNICODE_STANDINS) out = out.replace(pattern, replacement);
  return out.replace(/[^\x20-\x7E]+/g, "?");
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export function proxyRoutes(deps: ProxyDeps): Hono {
  const app = new Hono();
  const attribution = deps.attribution ?? getAttribution();

  app.post("/v1/chat/completions", async (c) => {
    const rawBody = await c.req.text();

    let bodyJson: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodyJson = parsed as Record<string, unknown>;
      }
    } catch {
      bodyJson = null;
    }
    if (!bodyJson) {
      return c.json({ error: "invalid_request", detail: "body must be a JSON object" }, 400);
    }
    const wantsStream = bodyJson["stream"] === true;

    const sessionHeader = headerOrUndefined(c, "x-session-id");
    const taskHeader = headerOrUndefined(c, "x-engine-task");
    const bodyModel = typeof bodyJson["model"] === "string" ? (bodyJson["model"] as string) : undefined;
    // B21b: the body `model` forces exact-model routing ONLY when it is a known
    // catalog id. Unknown ids ("auto", dynamically-discovered, typos) fall through
    // to normal tier routing instead of 503-ing. The x-router-model header always
    // forces (explicit operator intent).
    const knownModelIds = new Set(allModels(deps.providers).map((m) => m.model_id_per_provider));
    const explicitModel = bodyModel !== undefined && !bodyModel.startsWith("engine/") && knownModelIds.has(bodyModel) ? bodyModel : undefined;
    const forceModel = headerOrUndefined(c, "x-router-model") ?? explicitModel;
    const forceTierRaw = headerOrUndefined(c, "x-router-tier");
    const role = headerOrUndefined(c, "x-agent-role");
    const repomapRaw = headerOrUndefined(c, "x-context-tokens");
    const repomapNum = repomapRaw !== undefined ? Number.parseFloat(repomapRaw) : Number.NaN;
    const repoMapTokens = Number.isFinite(repomapNum) && repomapNum > 0 ? Math.round(repomapNum) : 0;
    const headerTier = isTier(forceTierRaw) ? forceTierRaw : undefined;
    const alias = aliasTierFor(bodyJson["model"]);
    const forceTier = headerTier ?? alias;

    let session: string | undefined = sessionHeader;
    let taskId: string | null = taskHeader ?? null;
    if (!session) {
      const hit = attribution.mostRecent();
      if (hit) {
        session = hit.sessionID;
        if (!taskId) taskId = hit.sessionID;
      }
    }
    if (taskId) deps.telemetry.getOrCreateTask(taskId);

    const keyPresent = (providerId: string): boolean => deps.resolveKey(providerId, role) !== null;
    const plan = planRoute({
      policy: deps.policy,
      providers: deps.providers,
      keyPresent,
      body: bodyJson,
      session: {
        session,
        // The EFFECTIVE task key (explicit header, else the attributed session id)
        // — must match the key notifyOutcome()/getOrCreateTask() use below, or the
        // cascade reads "(no-task)" while outcomes are written under the session id
        // and the budget governor never sees the attributed task ledger.
        task: taskId ?? undefined,
        forceModel,
        forceTier,
        role,
        repoMapTokens,
      },
    });

    const decision: RouteDecision | null = plan.decision;
    const routeTraceId = deps.telemetry.addTrace({
      ts: Date.now(),
      task: taskId,
      kind: "route",
      parent_id: null,
      label: decision ? `${decision.model}@${decision.providerId}` : "no-route",
      detail_json: JSON.stringify({
        reason: decision ? decision.reason : plan.nullReason ?? "no healthy provider with a configured key",
        session: session ?? null,
        task: taskId,
        attributed: !sessionHeader && session !== undefined,
        force_model: forceModel ?? null,
        force_tier: forceTier ?? null,
        chain: plan.chain,
      }),
    });

    if (!decision) {
      // B38: tell the cascade the request failed even on the no-route path, so a
      // subsequent request for the same task can escalate.
      deps.outcomes?.notifyOutcome(taskId, "failure");
      return c.json(
        { error: "no provider configured", attempts: [] },
        503,
        {
          "x-engine-route": headerSafe(
            JSON.stringify({
              provider: null,
              model: null,
              tier: forceTier ?? null,
              reason: plan.nullReason ?? "no healthy provider with a configured key",
              attempts: [] as AttemptLog[],
            }),
          ),
        },
      );
    }

    const routeHeaderFor = (cand: RouteCandidate | null, attempts: AttemptLog[]): string =>
      headerSafe(
        JSON.stringify({
          provider: cand !== null ? cand.providerId : null,
          model: cand !== null ? cand.model : null,
          tier: decision.tier,
          reason: decision.reason,
          attempts,
        }),
      );

    // Sanitize messages so strict provider gateways (like Groq) don't reject
    // internal properties like `at`, `id`, `refs`, or `meta` with HTTP 400.
    const sanitizeMessage = (m: unknown): Record<string, unknown> | null => {
      if (!m || typeof m !== "object") return null;
      const raw = m as Record<string, unknown>;
      const clean: Record<string, unknown> = {
        role: raw["role"] ?? "user",
        content: raw["content"] ?? "",
      };
      if (raw["name"] !== undefined) clean["name"] = raw["name"];
      if (raw["tool_calls"] !== undefined) clean["tool_calls"] = raw["tool_calls"];
      if (raw["tool_call_id"] !== undefined) clean["tool_call_id"] = raw["tool_call_id"];
      return clean;
    };
    const sanitizeMessages = (messages: unknown): unknown[] => {
      if (!Array.isArray(messages)) return [];
      return messages.map(sanitizeMessage).filter(Boolean);
    };

    // Wave 25 P3: the body used to be re-stringified on EVERY attempt (up to
    // 3× per request, 100KB–1MB+ context each). Memoize per distinct model —
    // the model id is the only field that varies between attempts.
    const outboundBodyCache = new Map<string, string>();
    const outboundBodyFor = (cand: RouteCandidate): string => {
      let s = outboundBodyCache.get(cand.model);
      if (s === undefined) {
        const { messages, ...rest } = bodyJson as { messages?: unknown } & Record<string, unknown>;
        s = JSON.stringify({ ...rest, messages: sanitizeMessages(messages), model: cand.model });
        outboundBodyCache.set(cand.model, s);
      }
      return s;
    };

    // ── Responses-API support (audit F1) ────────────────────────────────────
    // Some models (muse-spark) are only served by the OpenAI Responses API
    // (POST /responses with `input`), not /chat/completions. For those we call
    // /responses non-streaming and translate both the request and the response
    // back to chat/completions shape so downstream usage/cost parsing is reused.
    const isResponsesCandidate = (cand: RouteCandidate): boolean =>
      deps.providers.some(
        (p) =>
          p.id === cand.providerId &&
          p.models.some((m) => m.model_id_per_provider === cand.model && m.endpoint === "responses"),
      );

    const outboundForResponses = (cand: RouteCandidate): string => {
      const { messages, ...rest } = bodyJson as { messages?: unknown } & Record<string, unknown>;
      return JSON.stringify({
        ...rest,
        model: cand.model,
        input: sanitizeMessages(messages),
        stream: false,
      });
    };

    const responsesToChatCompletion = (r: Record<string, unknown>, modelId: string): Record<string, unknown> => {
      let content = "";
      const out = r["output"];
      if (Array.isArray(out)) {
        for (const item of out) {
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
      const u = (r["usage"] ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const prompt = num(u["input_tokens"]);
      const completion = num(u["output_tokens"]);
      return {
        id: typeof r["id"] === "string" ? r["id"] : `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: typeof r["created_at"] === "number" ? r["created_at"] : Math.floor(Date.now() / 1000),
        model: typeof r["model"] === "string" ? r["model"] : modelId,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: prompt ?? 0,
          completion_tokens: completion ?? 0,
          total_tokens: num(u["total_tokens"]) ?? (prompt ?? 0) + (completion ?? 0),
        },
      };
    };

    const logAttempt = (
      cand: RouteCandidate,
      status: "success" | "error" | "streaming" | "aborted",
      http: number | null,
      latencyMs: number | null,
      error: string | null,
      usage?: UsagePair,
      cost?: number | null,
    ): number => {
      const attemptTraceId = deps.telemetry.addTrace({
        ts: Date.now(),
        task: taskId,
        kind: "attempt",
        parent_id: routeTraceId,
        label: `${cand.model}@${cand.providerId}`,
        detail_json: JSON.stringify({
          provider: cand.providerId,
          model: cand.model,
          status,
          http,
          latency_ms: latencyMs,
          error,
        }),
      });
      return deps.telemetry.recordCall({
        ts: Date.now(),
        task: taskId,
        session: session ?? null,
        provider: cand.providerId,
        model: cand.model,
        tier: cand.tier,
        reason: decision.reason,
        status,
        http,
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
        cost_usd: cost ?? null,
        latency_ms: latencyMs,
        error,
        trace_id: attemptTraceId,
        parent_id: routeTraceId,
      });
    };

    const attempts: AttemptLog[] = [];
    let fetched = 0;
    // B23: track whether the chain was exhausted entirely by rate limits, so the
    // router can answer an honest 429 (engine quota-backoff) instead of a 503.
    let any429 = false;
    let allFailures429 = true;
    let anyAttemptFailed = false;
    let maxRetryAfterS = 0;

    // Expand the route chain into (candidate x KEY) attempts.
    //
    // With a single text provider the chain is short — often one entry — so a
    // rate-limited or revoked key used to fail the whole request while two
    // perfectly good keys sat unused in the table. The keys ARE the fallback
    // chain here, and separate accounts have genuinely independent quotas, so
    // walking them is the difference between a 429 and a served request.
    //
    // Expanding up front rather than nesting a loop keeps every existing rule
    // (health skips, MAX_ATTEMPTS, the rate-limit-exhaustion tracking) working
    // unchanged — each attempt is still one entry.
    const planned: { cand: RouteCandidate; apiKey: string | null; keyIndex: number; keyCount: number }[] = [];
    for (const cand of plan.chain) {
      const keys = deps.telemetry.listKeysForRole(cand.providerId, role);
      if (keys.length === 0) {
        planned.push({ cand, apiKey: null, keyIndex: 0, keyCount: 0 });
        continue;
      }
      keys.forEach((k, i) => planned.push({ cand, apiKey: k, keyIndex: i, keyCount: keys.length }));
    }

    for (const { cand, apiKey: plannedKey, keyIndex, keyCount } of planned) {
      if (fetched >= MAX_ATTEMPTS) break;

      if (!isProviderHealthy(cand.providerId)) {
        // B38: scope the last-resort skip to the CHAIN, not every provider — a
        // healthy provider outside this chain cannot serve this request's tier/model.
        const otherHealthy = plan.chain.some(
          (other) => other.providerId !== cand.providerId && deps.resolveKey(other.providerId, role) !== null && isProviderHealthy(other.providerId)
        );
        if (otherHealthy) {
          attempts.push({
            provider: cand.providerId,
            model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
            status: "skipped",
            http: null,
            latency_ms: null,
            error: "rate_limit_cooldown",
          });
          continue;
        }
      }
      // The key for THIS attempt, chosen when the plan was expanded above:
      // role-pinned first, then round-robin across the shared pool.
      const apiKey = plannedKey;
      if (!apiKey) {
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "skipped",
          http: null,
          latency_ms: null,
          error: "no_key",
        });
        continue;
      }
      const prov = findProvider(deps.providers, cand.providerId);
      if (!prov) continue;
      fetched += 1;

      const started = performance.now();
      let res: Response | null = null;
      let netError: string | null = null;
      // §5-17c: propagate a downstream client abort to the upstream fetch so an
      // engine race-loser abort cancels the provider call instead of letting the
      // router complete (and pay for) a response nobody consumes.
      const clientSignal = c.req.raw.signal;
      // The upstream timeout guards connect + headers only. AbortSignal.timeout()
      // stays armed for the whole fetch lifetime and would also abort the BODY
      // read once it fires — killing any SSE response still streaming after
      // UPSTREAM_TIMEOUT_MS. A manual controller is cleared as soon as headers
      // arrive so long streams survive; client aborts still propagate via
      // clientSignal.
      const timeoutAc = new AbortController();
      const timeoutId = setTimeout(
        () => timeoutAc.abort(new DOMException("The operation timed out.", "TimeoutError")),
        UPSTREAM_TIMEOUT_MS,
      );
      const upstreamSignal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([clientSignal, timeoutAc.signal])
          : timeoutAc.signal;
      try {
        const useResponses = isResponsesCandidate(cand);
        const upstreamUrl = `${prov.baseURL.replace(/\/+$/, "")}/${useResponses ? "responses" : "chat/completions"}`;
        res = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            // Responses-API calls are always made non-streaming (translated below).
            accept: wantsStream && !useResponses ? "text/event-stream" : "application/json",
          },
          body: useResponses ? outboundForResponses(cand) : outboundBodyFor(cand),
          signal: upstreamSignal,
        });
      } catch (e) {
        netError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      } finally {
        clearTimeout(timeoutId);
      }
      const latencyMs = Math.round(performance.now() - started);

      if (!res) {
        // §5-17c: if the CLIENT went away, record "aborted" (not a provider error)
        // and stop the chain — there is no one left to receive a fallback response.
        const clientGone = clientSignal.aborted;
        if (clientGone) {
          attempts.push({
            provider: cand.providerId,
            model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
            status: "fail",
            http: null,
            latency_ms: latencyMs,
            error: "client disconnected",
          });
          logAttempt(cand, "aborted", null, latencyMs, "client disconnected");
          break;
        }
        anyAttemptFailed = true;
        allFailures429 = false;
        // Wave 25 P0: a connect/header timeout or network failure used to just
        // `continue` with NO cooldown — the next request happily re-selected the
        // same hanging provider (another 45-120s). Cool the provider down like a
        // 5xx so the health tracker excludes it while it is flapping.
        markServerError(cand.providerId, null);
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "fail",
          http: null,
          latency_ms: latencyMs,
          error: netError,
        });
        logAttempt(cand, "error", null, latencyMs, netError);
        continue;
      }

      const httpStatus = res.status;

      if (httpStatus === 429 || httpStatus >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (httpStatus === 429) {
          markRateLimited(cand.providerId, retryAfter);
          any429 = true;
          if (retryAfter !== null && retryAfter > maxRetryAfterS) maxRetryAfterS = retryAfter;
        } else {
          // B39: track 5xx streaks so a repeatedly-failing provider gets cooled
          // down instead of being re-selected on every request. Honor a
          // Retry-After header when the failing response carried one.
          markServerError(cand.providerId, retryAfter);
          allFailures429 = false;
        }
        anyAttemptFailed = true;
        const bodyText = await safeText(res);
        const parsedErr = tryParseObject(bodyText);
        const errMsg = parsedErr?.["error"] !== undefined ? errorObjectSnippet(parsedErr["error"]) : snippet(bodyText);
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "fail",
          http: httpStatus,
          latency_ms: latencyMs,
          error: errMsg,
        });
        logAttempt(cand, "error", httpStatus, latencyMs, errMsg);
        continue;
      }

      if (httpStatus < 200 || httpStatus > 299) {
        const bodyText = await safeText(res);
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "fail",
          http: httpStatus,
          latency_ms: latencyMs,
          error: snippet(bodyText),
        });
        logAttempt(cand, "error", httpStatus, latencyMs, snippet(bodyText));
        return new Response(bodyText, {
          status: httpStatus,
          headers: {
            "content-type": res.headers.get("content-type") ?? "application/json",
            "x-engine-route": routeHeaderFor(cand, attempts),
          },
        });
      }

      if (wantsStream && res.body && !isResponsesCandidate(cand)) {
        // §5-17a: push the streaming attempt BEFORE building the route header so the
        // x-engine-route header (and trailing SSE comment) include their own attempt,
        // matching the non-streaming path.
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "ok",
          http: res.status,
          latency_ms: latencyMs,
          error: null,
        });
        return respondStreaming(deps, {
          cand,
          attempts,
          upstream: res,
          routeHeaderValue: routeHeaderFor(cand, attempts),
          routeTraceId,
          taskId,
          session,
          latencyMs,
          clientSignal: c.req.raw.signal,
          logAttempt,
        });
      }

      const text = await safeText(res);
      let parsed = tryParseObject(text);
      // Responses-API models: translate the /responses body back to
      // chat/completions shape so readUsage/computeCost work unchanged.
      // Wave 25 P4: track whether translation happened — an untranslated body
      // is forwarded as the ORIGINAL text instead of paying a full
      // parse→stringify round-trip for nothing.
      let translated = false;
      if (parsed && isResponsesCandidate(cand)) {
        parsed = responsesToChatCompletion(parsed, cand.model);
        translated = true;
      }

      if (!parsed) {
        anyAttemptFailed = true;
        allFailures429 = false;
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "fail",
          http: httpStatus,
          latency_ms: latencyMs,
          error: "invalid upstream JSON",
        });
        logAttempt(cand, "error", httpStatus, latencyMs, "invalid upstream JSON");
        continue;
      }

      if (parsed["error"] !== undefined && parsed["error"] !== null) {
        const rl = looksLikeRateLimitError(parsed["error"]);
        anyAttemptFailed = true;
        if (rl) {
          // B39: an in-body quota error on a 2xx response must advance the
          // provider's 429 counters exactly like a real 429 status — otherwise
          // free-tier providers that wrap rate limits in error bodies never cool
          // down. Honour a Retry-After header when present.
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          markRateLimited(cand.providerId, retryAfter);
          if (retryAfter !== null && retryAfter > maxRetryAfterS) maxRetryAfterS = retryAfter;
          any429 = true;
        } else {
          allFailures429 = false;
        }
        const msg = errorObjectSnippet(parsed["error"]);
        attempts.push({
          provider: cand.providerId,
          model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
          status: "fail",
          http: httpStatus,
          latency_ms: latencyMs,
          error: msg,
        });
        logAttempt(cand, "error", httpStatus, latencyMs, msg);
        if (rl) continue;
        return new Response(text, {
          status: httpStatus,
          headers: {
            "content-type": res.headers.get("content-type") ?? "application/json",
            "x-engine-route": routeHeaderFor(cand, attempts),
          },
        });
      }

      markSuccess(cand.providerId);
      const usage = readUsage(parsed);
      const cost = computeCost(priceFor(deps.providers, cand.providerId, cand.model), usage);
      attempts.push({
        provider: cand.providerId,
        model: cand.model,
        key: keyCount > 0 ? `${keyIndex + 1}/${keyCount}` : undefined,
        status: "ok",
        http: httpStatus,
        latency_ms: latencyMs,
        error: null,
      });
      const rowId = logAttempt(cand, "success", httpStatus, latencyMs, null, usage, cost);
      if (taskId && cost !== null) deps.telemetry.addSpent(taskId, cost);
      void rowId;
      deps.telemetry.updateTraceLabel(routeTraceId, `${cand.model}@${cand.providerId}`);
      if (usage.prompt_tokens !== null || usage.completion_tokens !== null) {
        deps.outcomes?.notifyOutcome(taskId, "success", cand.tier);
      }

      // Wave 25 P4: forward the original upstream bytes unless we translated a
      // Responses-API body — avoids a pointless parse→stringify round-trip.
      const payload = translated ? JSON.stringify(parsed) : text;
      // A responses-API model was called non-streaming upstream, but the client
      // asked for a stream — wrap the single completion as one SSE chunk + [DONE].
      if (wantsStream && isResponsesCandidate(cand)) {
        return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-engine-route": routeHeaderFor(cand, attempts),
          },
        });
      }
      return new Response(payload, {
        status: httpStatus,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
          "x-engine-route": routeHeaderFor(cand, attempts),
        },
      });
    }

    deps.outcomes?.notifyOutcome(taskId, "failure");
    // B23: chain exhausted on rate limits → honest 429 (with the max Retry-After
    // seen) so the engine's quota-backoff fires; a genuine no-config stays 503.
    if (anyAttemptFailed && allFailures429 && any429) {
      return c.json({ error: "all providers rate-limited", attempts }, 429, {
        ...(maxRetryAfterS > 0 ? { "retry-after": String(Math.round(maxRetryAfterS)) } : {}),
        "x-engine-route": routeHeaderFor(null, attempts),
      });
    }
    return c.json({ error: "no provider configured", attempts }, 503, {
      "x-engine-route": routeHeaderFor(null, attempts),
    });
  });

  return app;
}

function headerOrUndefined(c: { req: { header(name: string): string | undefined } }, name: string): string | undefined {
  const v = c.req.header(name);
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

interface StreamArgs {
  cand: RouteCandidate;
  attempts: AttemptLog[];
  upstream: Response;
  routeHeaderValue: string;
  routeTraceId: number;
  taskId: string | null;
  session: string | undefined;
  latencyMs: number;
  /** §5-17b: downstream client signal, used to tell a client disconnect from an
   * upstream failure so disconnects don't inflate provider/task error stats. */
  clientSignal?: AbortSignal;
  logAttempt: (
    cand: RouteCandidate,
    status: "success" | "error" | "streaming" | "aborted",
    http: number | null,
    latencyMs: number | null,
    error: string | null,
    usage?: UsagePair,
    cost?: number | null,
  ) => number;
}

function respondStreaming(deps: ProxyDeps, args: StreamArgs): Response {
  const { upstream } = args;
  // NOTE: the streaming attempt is pushed into args.attempts by the CALLER (before
  // building routeHeaderValue) so the route header includes it — see §5-17a.
  const rowId = args.logAttempt(args.cand, "streaming", upstream.status, args.latencyMs, null);
  deps.telemetry.updateTraceLabel(args.routeTraceId, `${args.cand.model}@${args.cand.providerId}`);

  const passThrough = new TransformStream<Uint8Array, Uint8Array>();
  const writer = passThrough.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  void (async () => {
    // Wave 25 P5: scan for usage incrementally as bytes pass through — no
    // whole-stream accumulation, no end-of-stream re-parse.
    const scanner = createUsageScanner();
    const reader = upstream.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          scanner.feed(decoder.decode(value, { stream: true }));
          await writer.write(value);
        }
      }
      scanner.feed(decoder.decode());
      markSuccess(args.cand.providerId);
      const usage = scanner.finish();
      let cost: number | null = null;
      if (usage) {
        cost = computeCost(priceFor(deps.providers, args.cand.providerId, args.cand.model), usage);
        if (args.taskId && cost !== null) deps.telemetry.addSpent(args.taskId, cost);
      }
      deps.telemetry.completeStreamedCall(
        rowId,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        cost,
        "success",
      );
      if (usage && (usage.prompt_tokens !== null || usage.completion_tokens !== null)) {
        deps.outcomes?.notifyOutcome(args.taskId, "success", args.cand.tier);
      }
      await writer.write(encoder.encode(`: x-engine-route ${args.routeHeaderValue}\n\n`));
      await writer.close();
    } catch {
      // §5-17b: a downstream client disconnect makes writer.write throw — record it
      // as "aborted" (not "error") so client-side disconnects don't inflate
      // provider/task error stats. Only a genuine upstream failure is "error".
      const clientGone = args.clientSignal?.aborted === true;
      deps.telemetry.completeStreamedCall(
        rowId,
        null,
        null,
        null,
        clientGone ? "aborted" : "error",
        clientGone ? "client disconnected" : "stream aborted before completion",
      );
      try {
        await reader.cancel();
      } catch {
        /* upstream already gone */
      }
      try {
        await writer.write(encoder.encode("\n: upstream aborted\n"));
        await writer.close();
      } catch {
        try {
          await writer.abort();
        } catch {
          /* already closed */
        }
      }
    }
  })();

  return new Response(passThrough.readable, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      "x-engine-route": args.routeHeaderValue,
    },
  });
}
