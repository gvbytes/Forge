#!/usr/bin/env bun
/**
 * preflight-models.ts — prove every catalogued model actually answers.
 *
 *   bun run scripts/preflight-models.ts
 *   bun run scripts/preflight-models.ts --json      # machine-readable
 *   bun run scripts/preflight-models.ts --tier S    # one tier only
 *
 * WHY THIS EXISTS
 * ---------------
 * The whole routing surface is nine hardcoded `model_id_per_provider` strings.
 * The existing "catalog hygiene" test only asserts that strings we hardcoded
 * are present in the array we hardcoded them into — it is circular and cannot
 * fail. Nothing verified that the ids still RESOLVE upstream.
 *
 * That matters because model ids get renamed and retired, and the failure is
 * silent until routing time: tier S has only two entries and Cerebras offers
 * only tier L, so one dead id can remove an entire tier. Under evaluation,
 * where a judge supplies their own keys, that surfaces as a task failure
 * (A = 0) rather than a config error.
 *
 * This sends a real two-token completion to every (provider, model) pair using
 * whichever key is configured, and prints a pass/fail table. Exit code is
 * non-zero when any KEYED provider has a dead model, so it can gate CI.
 * Providers with no key are reported as SKIP, never as failures.
 */
import { DEFAULT_PROVIDERS, allModels, type Provider } from "../router/src/providers";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const tierArg = (() => {
  const i = process.argv.indexOf("--tier");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

// Some free endpoints cold-start slowly: OpenCode Zen's nemotron answers in
// ~45s on a cold queue. A 20s probe reported it DEAD when it was merely slow,
// which would have had us delete a working provider.
const TIMEOUT_MS = 60_000;

interface Result {
  provider: string;
  model: string;
  tier: string;
  paramB: number;
  priced: boolean;
  status: "ok" | "dead" | "skip";
  httpStatus?: number;
  latencyMs?: number;
  detail: string;
}

function keyFor(p: Provider): string | null {
  const v = process.env[p.envKey];
  return v && v.trim() ? v.trim() : null;
}

async function probe(p: Provider, modelId: string): Promise<{ ok: boolean; httpStatus?: number; latencyMs: number; detail: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${p.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${keyFor(p) ?? ""}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 2,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    if (res.ok) return { ok: true, httpStatus: res.status, latencyMs, detail: "answered" };

    const body = await res.text().catch(() => "");
    // A 429 means the id is FINE and we are merely rate limited — that is a
    // pass for the purpose of "does this model exist", which is what we are
    // checking. Only 4xx-not-429 indicates a bad id / bad key.
    if (res.status === 429) {
      return { ok: true, httpStatus: 429, latencyMs, detail: "rate limited (id valid)" };
    }
    return {
      ok: false,
      httpStatus: res.status,
      latencyMs,
      detail: body.slice(0, 160).replace(/\s+/g, " ").trim() || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
    };
  }
}

async function main(): Promise<void> {
  const results: Result[] = [];

  for (const p of DEFAULT_PROVIDERS) {
    const key = keyFor(p);
    for (const m of p.models) {
      if (tierArg && m.tier !== tierArg) continue;
      const priced = m.price_in > 0 || m.price_out > 0;
      const base = {
        provider: p.id,
        model: m.model_id_per_provider,
        tier: m.tier,
        paramB: m.param_b,
        priced,
      };
      if (!key) {
        results.push({ ...base, status: "skip", detail: `no key (${p.envKey} unset)` });
        continue;
      }
      const r = await probe(p, m.model_id_per_provider);
      results.push({
        ...base,
        status: r.ok ? "ok" : "dead",
        ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
        latencyMs: r.latencyMs,
        detail: r.detail,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    const w = { p: 12, m: 40, t: 5, s: 6 };
    const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
    console.log("");
    console.log(`${pad("PROVIDER", w.p)}${pad("MODEL", w.m)}${pad("TIER", w.t)}${pad("STATE", w.s)}DETAIL`);
    console.log("─".repeat(110));
    for (const r of results) {
      const mark = r.status === "ok" ? "\x1b[32mOK\x1b[0m    " : r.status === "dead" ? "\x1b[31mDEAD\x1b[0m  " : "\x1b[90mSKIP\x1b[0m  ";
      const lat = r.latencyMs != null && r.status === "ok" ? ` (${r.latencyMs}ms)` : "";
      const price = r.priced ? " \x1b[33m$PAID\x1b[0m" : "";
      console.log(`${pad(r.provider, w.p)}${pad(r.model, w.m)}${pad(r.tier, w.t)}${mark}${r.detail}${lat}${price}`);
    }
    console.log("");

    // Tier coverage: a tier with no live model is a routing dead end, which is
    // the failure mode that actually loses tasks under evaluation.
    for (const tier of ["S", "M", "L"]) {
      const inTier = results.filter((r) => r.tier === tier);
      if (inTier.length === 0) continue;
      const live = inTier.filter((r) => r.status === "ok");
      const freeLive = live.filter((r) => !r.priced);
      const probed = inTier.filter((r) => r.status !== "skip");
      if (probed.length === 0) {
        // Nothing was actually tested — say so rather than claiming the tier is
        // dead, which would send someone editing a catalog that is probably fine.
        console.log(`\x1b[90m· tier ${tier}: not probed (no keys configured for its providers)\x1b[0m`);
      } else if (live.length === 0) {
        console.log(`\x1b[31m✗ tier ${tier}: NO live model — every task routed here will fail\x1b[0m`);
      } else if (freeLive.length === 0) {
        console.log(`\x1b[33m⚠ tier ${tier}: ${live.length} live but ALL PRICED — the free-tier lock will refuse this tier\x1b[0m`);
      } else {
        console.log(`\x1b[32m✓ tier ${tier}: ${freeLive.length} free live model(s)\x1b[0m`);
      }
    }
    const skipped = results.filter((r) => r.status === "skip").length;
    if (skipped > 0) console.log(`\x1b[90m  (${skipped} skipped — no key configured)\x1b[0m`);
    console.log("");
  }

  const dead = results.filter((r) => r.status === "dead");
  if (dead.length > 0) {
    if (!asJson) {
      console.error(`\x1b[31m${dead.length} catalogued model(s) did not answer. Fix or remove them in router/src/providers.ts.\x1b[0m`);
    }
    process.exit(1);
  }
}

await main();
