#!/usr/bin/env bun
/**
 * setup-keys.ts — configure every provider key in one pass, then prove it works.
 *
 *   bun run setup                      # interactive: prompts for each provider
 *   bun run setup --from-env           # non-interactive: reads the env vars
 *   bun run setup --show               # what is configured right now
 *
 * WHY THIS EXISTS
 * ---------------
 * Getting keys into this system used to mean knowing that the ROUTER owns the
 * key store (SQLite, POST /keys), that the ENGINE keeps its own provider list
 * in settings.json, and that env vars are only a fallback the router consults
 * when its table has no row. Three places, one of which is only reachable
 * through a modal in the web UI. Someone setting up on a clean machine — an
 * evaluator, a new contributor — has no way to know that.
 *
 * This writes the key to the router (the authority), verifies it with a real
 * two-token completion against every model that provider serves, and prints a
 * per-tier coverage summary so you can see at a glance whether routing has a
 * live model at every tier.
 *
 * Keys are never echoed: everything printed is masked to gsk…last4.
 */
import { DEFAULT_PROVIDERS, type Provider } from "../router/src/providers";

const ROUTER = process.env.ROUTER_URL ?? "http://127.0.0.1:4098";
const args = new Set(process.argv.slice(2));
const fromEnv = args.has("--from-env");
const showOnly = args.has("--show");

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const mask = (k: string): string => (k.length <= 8 ? "…" : `${k.slice(0, 4)}…${k.slice(-4)}`);

/** Where each provider's key comes from, for the human doing the setup. */
const SIGNUP: Record<string, string> = {
  groq: "console.groq.com/keys — free tier, no card",
  "nvidia-nim": "build.nvidia.com — free credits, no card",
  openrouter: "openrouter.ai/keys — free tier covers the ':free' models below",
  zen: "opencode.ai — free tier",
};

async function routerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function currentKeys(): Promise<Record<string, { set: boolean; last4: string }>> {
  try {
    const r = await fetch(`${ROUTER}/keys`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { providers?: Record<string, { set: boolean; last4: string }> };
    return j.providers ?? {};
  } catch {
    return {};
  }
}

async function putKey(provider: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${ROUTER}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:4444" },
      body: JSON.stringify({ provider, key }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Real two-token completion. A 429 counts as a pass: the id is valid, we are
 *  merely rate limited, which is exactly what a free tier does under load. */
async function probe(p: Provider, modelId: string, key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${p.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 2, temperature: 0 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true, detail: "answered" };
    if (res.status === 429) return { ok: true, detail: "rate limited (id valid)" };
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
    return { ok: false, detail: body || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 100) : String(e) };
  }
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const chunk of Bun.stdin.stream()) {
    return new TextDecoder().decode(chunk).trim();
  }
  return "";
}

async function main(): Promise<void> {
  console.log("");
  if (!(await routerUp())) {
    console.error(C.bad(`Router not reachable at ${ROUTER}.`));
    console.error(`Start the stack first:  ${C.bold("bash scripts/dev.sh")}`);
    process.exit(1);
  }

  const existing = await currentKeys();

  if (showOnly) {
    console.log(C.bold("Configured provider keys"));
    for (const p of DEFAULT_PROVIDERS) {
      const cur = existing[p.id];
      console.log(`  ${p.id.padEnd(12)} ${cur?.set ? C.ok(`set (…${cur.last4})`) : C.dim("not set")}`);
    }
    console.log("");
    return;
  }

  // ── collect ──────────────────────────────────────────────────────────────
  const keys = new Map<string, string>();
  for (const p of DEFAULT_PROVIDERS) {
    const envVal = (process.env[p.envKey] ?? "").trim();
    if (fromEnv) {
      if (envVal) keys.set(p.id, envVal);
      continue;
    }
    const cur = existing[p.id];
    const state = cur?.set ? C.ok(`already set (…${cur.last4})`) : envVal ? C.warn(`found in $${p.envKey}`) : C.dim("not set");
    console.log(`\n${C.bold(p.id)} — ${state}`);
    console.log(C.dim(`  ${SIGNUP[p.id] ?? p.baseURL}`));
    console.log(C.dim(`  serves: ${p.models.map((m) => `${m.tier}:${m.model_id_per_provider}`).join(", ")}`));
    const answer = await prompt(`  paste key (blank = ${cur?.set || envVal ? "keep current" : "skip"}): `);
    if (answer) keys.set(p.id, answer);
    else if (envVal && !cur?.set) keys.set(p.id, envVal);
  }

  // ── store + verify ───────────────────────────────────────────────────────
  console.log(`\n${C.bold("Storing and verifying")}\n`);
  const tierLive = new Map<string, number>();

  for (const p of DEFAULT_PROVIDERS) {
    const key = keys.get(p.id) ?? "";
    if (key) {
      const stored = await putKey(p.id, key);
      console.log(`${p.id.padEnd(12)} ${stored ? C.ok(`stored ${mask(key)}`) : C.bad("store FAILED")}`);
      if (!stored) continue;
    } else if (!existing[p.id]?.set) {
      console.log(`${p.id.padEnd(12)} ${C.dim("skipped (no key)")}`);
      continue;
    }

    // Verify with whatever key the router now holds for this provider.
    const effective = key || (process.env[p.envKey] ?? "");
    if (!effective) {
      console.log(`${"".padEnd(12)} ${C.dim("already stored — cannot re-probe without the plaintext key")}`);
      continue;
    }
    for (const m of p.models) {
      const r = await probe(p, m.model_id_per_provider, effective);
      const mark = r.ok ? C.ok("OK  ") : C.bad("DEAD");
      console.log(`  ${mark} ${m.tier}  ${m.model_id_per_provider.padEnd(40)} ${C.dim(r.detail)}`);
      if (r.ok) tierLive.set(m.tier, (tierLive.get(m.tier) ?? 0) + 1);
    }
  }

  // ── coverage ─────────────────────────────────────────────────────────────
  console.log(`\n${C.bold("Tier coverage")}`);
  let gaps = 0;
  for (const tier of ["S", "M", "L"]) {
    const n = tierLive.get(tier) ?? 0;
    if (n === 0) { gaps++; console.log(`  ${C.bad(`✗ ${tier}: no live model — tasks routed here will fail`)}`); }
    else if (n === 1) console.log(`  ${C.warn(`⚠ ${tier}: 1 live model — no fallback when it rate-limits`)}`);
    else console.log(`  ${C.ok(`✓ ${tier}: ${n} live models`)}`);
  }
  console.log("");
  if (gaps > 0) {
    console.log(C.warn("Add a key for another provider to close the gaps above.\n"));
    process.exit(1);
  }
  console.log(C.ok("Ready. Open http://localhost:4444 and start a task.\n"));
}

await main();
