// Settings-load regressions (audit F1/F3/F4/F5 + critique of the reconciliation):
//   The local-router provider's baseUrl is persisted to settings.json. When the
//   router comes back on a different port (dynamic dev ports / restart), the
//   persisted baseUrl points at a dead port while DEFAULT_ROUTER_BASE (fed by
//   ENGINE_ROUTER_BASE) already tracks the live one. reconcileRouterBaseUrl must
//   re-point ONLY the canonical router provider (id "engine-router" / name
//   "Local Router") — never a remote provider and never a legitimate local
//   non-router endpoint (Ollama / LM Studio / vLLM on 127.0.0.1), which the
//   earlier over-broad rewrite clobbered (and, via GET->UI->PUT, persisted).
import "./_env.js";
import { describe, test, expect } from "bun:test";
import { reconcileRouterBaseUrl, isLoopbackBase, DEFAULT_ROUTER_BASE } from "../src/config.js";

const LIVE = DEFAULT_ROUTER_BASE; // e.g. http://127.0.0.1:4098/v1 (or env override)

const prov = (o: { id?: string; name: string; baseUrl: string }) =>
  ({ ...o, apiKey: "k", kind: "openai-compatible" }) as any;

describe("reconcileRouterBaseUrl re-points only the canonical router provider", () => {
  test("router provider (id engine-router) on a dead loopback port is reconciled", () => {
    const ps = [prov({ id: "engine-router", name: "Local Router", baseUrl: "http://127.0.0.1:9/v1" })];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe(LIVE);
  });

  test("router provider matched by name 'Local Router' (no id) is reconciled", () => {
    const ps = [prov({ name: "Local Router", baseUrl: "http://localhost:9/v1" })];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe(LIVE);
  });

  test("snake_case base_url is rewritten alongside baseUrl", () => {
    const p: any = { id: "engine-router", name: "Local Router", baseUrl: "http://127.0.0.1:9/v1", base_url: "http://127.0.0.1:9/v1", apiKey: "k", kind: "openai-compatible" };
    reconcileRouterBaseUrl([p], LIVE);
    expect(p.baseUrl).toBe(LIVE);
    expect(p.base_url).toBe(LIVE);
  });

  test("CRITICAL (F1): a local non-router provider (Ollama) is NOT clobbered", () => {
    const ps = [
      prov({ id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" }),
      prov({ id: "engine-router", name: "Local Router", baseUrl: "http://127.0.0.1:9/v1" }),
    ];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe("http://127.0.0.1:11434/v1"); // Ollama untouched
    expect(ps[1].baseUrl).toBe(LIVE);                        // router reconciled
  });

  test("a remote provider baseUrl is never clobbered", () => {
    const ps = [prov({ id: "zen", name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1" })];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  test("no-op when the router baseUrl already equals the live base", () => {
    const ps = [prov({ id: "engine-router", name: "Local Router", baseUrl: LIVE })];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe(LIVE);
  });

  test("a router-named provider on a REMOTE host is not rewritten (not loopback)", () => {
    const ps = [prov({ id: "engine-router", name: "Local Router", baseUrl: "https://remote.example/v1" })];
    reconcileRouterBaseUrl(ps, LIVE);
    expect(ps[0].baseUrl).toBe("https://remote.example/v1");
  });
});

describe("isLoopbackBase", () => {
  test("recognizes 127.0.0.1 / localhost / 0.0.0.0", () => {
    expect(isLoopbackBase("http://127.0.0.1:4098/v1")).toBe(true);
    expect(isLoopbackBase("http://localhost:4098/v1")).toBe(true);
    expect(isLoopbackBase("http://0.0.0.0:4098/v1")).toBe(true);
  });
  test("recognizes bracketed IPv6 loopback [::1] (F4)", () => {
    expect(isLoopbackBase("http://[::1]:4098/v1")).toBe(true);
  });
  test("rejects remote + malformed + undefined", () => {
    expect(isLoopbackBase("https://opencode.ai/zen/v1")).toBe(false);
    expect(isLoopbackBase("not a url")).toBe(false);
    expect(isLoopbackBase(undefined)).toBe(false);
  });
});
