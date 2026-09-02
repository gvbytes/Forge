// Provider wire-format + racing-outcome regressions:
//   B28 — responseFormat:"json" must actually be serialized into the request
//         body (response_format: {type:"json_object"}), not accepted-and-dropped.
//   B15 — when upstream omits usage, tokens fall back to the char heuristic
//         and are marked estimated (budget/token caps stay enforceable).
//   B16 — an empty 200-OK completion is its OWN race outcome ("empty") with
//         usage reported, not a status-less error filed as 5xx; a late
//         200-OK loser still reports its spent tokens ("aborted" + usage).
// The tests stub globalThis.fetch (restored after each test) so no network
// is touched and no server is started.
import "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";
import { chat, chatRace, seedFromSettings, mergeDiscovered, normalizeResponsesToChat, isResponsesOnlyModel } from "../src/providers.js";
import { DEFAULT_ROUTER_BASE } from "../src/config.js";
import type { AppSettings, ModelSpec } from "../src/types.js";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: Record<string, unknown>;
}
interface StubReply {
  status: number;
  json: unknown;
  delayMs?: number;
}

let captured: Captured[] = [];
let respond: (body: Record<string, unknown>) => StubReply;

function stubFetch(): void {
  captured = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    captured.push({ url, body });
    const r = respond(body);
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const completion = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }): unknown => ({
  choices: [{ message: { content } }],
  ...(usage ? { usage } : {}),
});

describe("B28 responseFormat:'json' is serialized into the request body", () => {
  test("json mode sends response_format:{type:'json_object'}", async () => {
    stubFetch();
    respond = () => ({ status: 200, json: completion('{"ok":true}', { prompt_tokens: 10, completion_tokens: 5 }) });
    const res = await chat({
      modelId: "engine/small",
      messages: [{ role: "user", content: "answer in json" }],
      responseFormat: "json",
    });
    expect(res.text).toBe('{"ok":true}');
    const req = captured[captured.length - 1]!;
    const rf = req.body.response_format as { type?: string } | undefined;
    expect(rf?.type).toBe("json_object");
  });

  test("without json mode no response_format field is sent", async () => {
    stubFetch();
    respond = () => ({ status: 200, json: completion("plain text", { prompt_tokens: 10, completion_tokens: 5 }) });
    await chat({ modelId: "engine/small", messages: [{ role: "user", content: "hi" }] });
    const req = captured[captured.length - 1]!;
    expect(req.body.response_format).toBeUndefined();
  });
});

describe("B15 usage fallback when upstream omits usage", () => {
  test("missing usage → heuristic token counts marked estimated", async () => {
    stubFetch();
    respond = () => ({ status: 200, json: completion("a reasonable length answer") });
    const res = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "hello world, please answer at some length" }] });
    expect(res.estimated).toBe(true);
    expect(res.tokensIn).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
  });

  test("provider-reported usage wins and is not marked estimated", async () => {
    stubFetch();
    respond = () => ({ status: 200, json: completion("short", { prompt_tokens: 42, completion_tokens: 7 }) });
    const res = await chat({ modelId: "engine/small", messages: [{ role: "user", content: "hi" }] });
    expect(res.tokensIn).toBe(42);
    expect(res.tokensOut).toBe(7);
    expect(res.estimated).toBeUndefined();
  });
});

describe("B16 chatRace outcome classification", () => {
  test("empty 200-OK is outcome:'empty' with usage, winner unaffected", async () => {
    stubFetch();
    respond = (body) =>
      body.model === "m-empty"
        ? { status: 200, json: completion("   ", { prompt_tokens: 7, completion_tokens: 0 }) } // empty first
        : { status: 200, json: completion("winner text", { prompt_tokens: 7, completion_tokens: 3 }), delayMs: 60 };
    const losers: { modelId: string; outcome: string; tokensIn?: number; tokensOut?: number }[] = [];
    const res = await chatRace({
      modelId: "m-empty",
      candidates: ["m-empty", "m-win"],
      messages: [{ role: "user", content: "go" }],
      staggerMs: 0,
      onLoser: (info) => losers.push(info),
    });
    expect(res.modelId).toBe("m-win");
    expect(res.text).toBe("winner text");
    const empty = losers.find((l) => l.outcome === "empty");
    expect(empty).toBeDefined();
    expect(empty?.modelId).toBe("m-empty");
    // B15: the empty 200-OK still spent tokens — they are reported upstream
    expect(empty?.tokensIn).toBe(7);
    // no error-class loser was invented for the empty reply
    expect(losers.some((l) => l.outcome === "error")).toBe(false);
  });

  test("late 200-OK loser reports spent tokens as outcome:'aborted'", async () => {
    stubFetch();
    respond = (body) =>
      body.model === "m-fast"
        ? { status: 200, json: completion("fast wins", { prompt_tokens: 5, completion_tokens: 2 }), delayMs: 30 }
        : { status: 200, json: completion("slow but finished", { prompt_tokens: 5, completion_tokens: 4 }), delayMs: 120 };
    const losers: { modelId: string; outcome: string; tokensIn?: number; tokensOut?: number }[] = [];
    const res = await chatRace({
      modelId: "m-fast",
      candidates: ["m-fast", "m-slow"],
      messages: [{ role: "user", content: "go" }],
      staggerMs: 0,
      onLoser: (info) => losers.push(info),
    });
    expect(res.modelId).toBe("m-fast");
    const late = losers.find((l) => l.modelId === "m-slow");
    expect(late).toBeDefined();
    expect(late?.outcome).toBe("aborted");
    expect(late?.tokensIn).toBe(5);
    expect(late?.tokensOut).toBe(4);
  });
});

// Regression: adding a second (custom) provider used to re-seed every native
// model once per provider. refresh() merges seeded models by id keeping the
// LAST duplicate, so the engine/small|medium|large tier aliases — the local
// router proxy's routing vocabulary — ended up tagged to whichever provider
// came last (e.g. a newly-added "OpenCode Zen"), pointing at the wrong baseUrl
// and becoming unroutable. Native models must always seed against the local
// router, exactly once.
describe("seedFromSettings keeps native tier aliases on the local router", () => {
  const twoProviderSettings = (): AppSettings =>
    ({
      providers: [
        { name: "Local Router", baseUrl: DEFAULT_ROUTER_BASE, apiKey: "", kind: "openai-compatible" },
        { name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", apiKey: "k", kind: "openai-compatible" },
      ],
    }) as unknown as AppSettings;

  test("native models are never seeded against a custom provider", () => {
    const seeded = seedFromSettings(twoProviderSettings());
    expect(seeded.length).toBeGreaterThan(0);
    for (const m of seeded) {
      expect(m.provider).toBe("Local Router");
      expect(m.baseUrl).toBe(DEFAULT_ROUTER_BASE);
    }
  });

  test("each native model is seeded exactly once (no id duplicates)", () => {
    const seeded = seedFromSettings(twoProviderSettings());
    const ids = seeded.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("engine/small survives the refresh-by-id merge pointing at the router", () => {
    const seeded = seedFromSettings(twoProviderSettings());
    // Mirror refresh()'s merge: new Map(seeded.map(m=>[m.id,m])) keeps the LAST
    // duplicate. The surviving engine/small must still target the local router.
    const byId = new Map(seeded.map((m) => [m.id, m]));
    const small = byId.get("engine/small");
    expect(small).toBeDefined();
    expect(small!.provider).toBe("Local Router");
    expect(small!.baseUrl).toBe(DEFAULT_ROUTER_BASE);
  });
});

// Regression (audit C1): refresh()'s merge let ANY discovered model overwrite a
// seeded native id. A custom/malicious provider whose GET /models returns
// {"id":"engine/small"} would re-point the tier alias at its own baseUrl, so all
// tier-routed prompts POST to the attacker bearing the resolved provider key.
// The engine/* namespace is the local router's routing vocabulary and must never
// be hijackable; non-reserved ids still let the discovered spec win (it carries
// real ctx/pricing from the endpoint).
describe("mergeDiscovered protects the reserved engine/* tier-alias namespace", () => {
  const spec = (id: string, provider: string, baseUrl: string): ModelSpec => ({
    id, label: id, provider, baseUrl, ctxWindow: 1000, maxOutput: 100,
    costInPerM: 0, costOutPerM: 0, tags: [], enabled: true,
  });

  test("a discovered model cannot hijack a seeded engine/* alias", () => {
    const seeded = [spec("engine/small", "Local Router", DEFAULT_ROUTER_BASE)];
    const discovered = [spec("engine/small", "Evil Provider", "https://evil.example/v1")];
    const merged = mergeDiscovered(seeded, discovered);
    const small = merged.find((m) => m.id === "engine/small");
    expect(small?.provider).toBe("Local Router");
    expect(small?.baseUrl).toBe(DEFAULT_ROUTER_BASE);
  });

  test("every engine/* alias is protected, not just engine/small", () => {
    const seeded = [
      spec("engine/small", "Local Router", DEFAULT_ROUTER_BASE),
      spec("engine/medium", "Local Router", DEFAULT_ROUTER_BASE),
      spec("engine/large", "Local Router", DEFAULT_ROUTER_BASE),
    ];
    const discovered = [
      spec("engine/medium", "Evil", "https://evil.example/v1"),
      spec("engine/large", "Evil", "https://evil.example/v1"),
    ];
    const merged = mergeDiscovered(seeded, discovered);
    for (const id of ["engine/small", "engine/medium", "engine/large"]) {
      const m = merged.find((x) => x.id === id);
      expect(m?.provider).toBe("Local Router");
    }
  });

  test("non-reserved discovered models still win on id clash", () => {
    const seeded = [spec("hy3-free", "Local Router", DEFAULT_ROUTER_BASE)];
    const discovered = [spec("hy3-free", "OpenCode Zen", "https://opencode.ai/zen/v1")];
    const merged = mergeDiscovered(seeded, discovered);
    const m = merged.find((x) => x.id === "hy3-free");
    expect(m?.provider).toBe("OpenCode Zen");
    expect(m?.baseUrl).toBe("https://opencode.ai/zen/v1");
  });
});

// Wave 25 catalog hygiene (2026-08-28 telemetry + live-probe audit): a direct
// custom provider (e.g. OpenCode Zen in settings.json) is probed at its OWN
// /models endpoint, which still lists models we have confirmed dead. Without a
// discovery-time blocklist those dead models enter the routable registry and
// the router can pick them (observed live: coder → nemotron-3.5-lightning-free
// → 45s hang, zero tokens). mergeDiscovered is the single chokepoint every
// discovered model passes through, so the blocklist lives there.
describe("mergeDiscovered drops confirmed-dead models (wave 25 blocklist)", () => {
  const spec = (id: string, provider: string, baseUrl: string): ModelSpec => ({
    id, label: id, provider, baseUrl, ctxWindow: 1000, maxOutput: 100,
    costInPerM: 0, costOutPerM: 0, tags: [], enabled: true,
  });

  test("a dead model discovered via a direct provider is NOT admitted", () => {
    const seeded = [spec("hy3-free", "Local Router", DEFAULT_ROUTER_BASE)];
    const discovered = [
      spec("nemotron-3.5-lightning-free", "OpenCode Zen", "https://opencode.ai/zen/v1"),
      spec("hy3-free", "OpenCode Zen", "https://opencode.ai/zen/v1"),
    ];
    const merged = mergeDiscovered(seeded, discovered);
    expect(merged.find((m) => m.id === "nemotron-3.5-lightning-free")).toBeUndefined();
    expect(merged.find((m) => m.id === "hy3-free")).toBeDefined(); // healthy model unaffected
  });

  test("every blocklisted model is dropped", () => {
    const dead = ["nemotron-3.5-lightning-free", "mimo-v2.5-free", "big-pickle", "deepseek-v4-flash-free"];
    const discovered = dead.map((id) => spec(id, "OpenCode Zen", "https://opencode.ai/zen/v1"));
    const merged = mergeDiscovered([], discovered);
    for (const id of dead) expect(merged.find((m) => m.id === id)).toBeUndefined();
    expect(merged).toHaveLength(0);
  });

  test("a blocklisted model is dropped even if it was (mistakenly) seeded", () => {
    const seeded = [spec("nemotron-3.5-lightning-free", "Local Router", DEFAULT_ROUTER_BASE)];
    const merged = mergeDiscovered(seeded, []);
    expect(merged.find((m) => m.id === "nemotron-3.5-lightning-free")).toBeUndefined();
  });
});

// Regression (audit F1): muse-spark is only served via the OpenAI Responses API
// (/responses), not /chat/completions. The engine calls a model's baseUrl
// directly, so it must translate the Responses payload back to chat/completions
// shape (choices + usage) for the text/usage extraction to work.
describe("Responses-API support (muse-spark)", () => {
  test("isResponsesOnlyModel flags muse-spark but not ordinary models", () => {
    expect(isResponsesOnlyModel("muse-spark-1.2-contributor-free")).toBe(true);
    expect(isResponsesOnlyModel("hy3-free")).toBe(false);
    expect(isResponsesOnlyModel("engine/small")).toBe(false);
  });

  test("normalizeResponsesToChat maps output_text + usage to chat shape", () => {
    const responses = {
      id: "rs_123",
      status: "completed",
      model: "muse-spark-1.2-contributor-free",
      created_at: 1700000000,
      output: [
        { type: "reasoning", id: "r1", summary: [] },
        { type: "message", id: "m1", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "hello ", annotations: [] }, { type: "output_text", text: "world", annotations: [] }] },
      ],
      usage: { input_tokens: 12, output_tokens: 166, total_tokens: 178 },
    };
    const chatShape: any = normalizeResponsesToChat(responses as any);
    expect(chatShape.object).toBe("chat.completion");
    expect(chatShape.choices[0].message.content).toBe("hello world");
    expect(chatShape.usage.prompt_tokens).toBe(12);
    expect(chatShape.usage.completion_tokens).toBe(166);
    expect(chatShape.usage.total_tokens).toBe(178);
  });

  test("normalizeResponsesToChat tolerates missing output/usage", () => {
    const chatShape: any = normalizeResponsesToChat({ id: "x" } as any);
    expect(chatShape.choices[0].message.content).toBe("");
    expect(chatShape.usage.total_tokens).toBe(0);
  });
});

// ── F: router-discovered model admission (upstream transparency + keyless) ──
import { classifyRouterModel } from "../src/providers.js";

describe("classifyRouterModel (router model admission)", () => {
  test("a keyed upstream provider stays enabled, no needs-key", () => {
    const keys = new Map<string, boolean>([["zen", true]]);
    expect(classifyRouterModel("zen", keys)).toEqual({ enabled: true, needsKey: false });
  });
  test("a keyless upstream provider is disabled + tagged needs-key", () => {
    const keys = new Map<string, boolean>([["nvidia-nim", false]]);
    expect(classifyRouterModel("nvidia-nim", keys)).toEqual({ enabled: false, needsKey: true });
  });
  test("unknown key status (null map) degrades to enabled — never lock out on a fetch failure", () => {
    expect(classifyRouterModel("openrouter", null)).toEqual({ enabled: true, needsKey: false });
  });
  test("missing owned_by degrades to enabled", () => {
    const keys = new Map<string, boolean>([["zen", false]]);
    expect(classifyRouterModel(undefined, keys)).toEqual({ enabled: true, needsKey: false });
  });
  test("provider not present in the key map is treated as enabled", () => {
    const keys = new Map<string, boolean>([["zen", true]]);
    expect(classifyRouterModel("groq", keys)).toEqual({ enabled: true, needsKey: false });
  });
});
