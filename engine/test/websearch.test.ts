import { restoreFetch } from "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";

// This file stubs globalThis.fetch; bun shares one process across test files,
// so the stub MUST be torn down or it leaks into the next file.
afterEach(restoreFetch);
import { isDdgAd, unwrapBingHref, parseDdg, parseBing, searchWeb } from "../src/websearch.js";

describe("web_search ad filtering (isDdgAd)", () => {
  test("detects DuckDuckGo sponsored y.js redirect URLs", () => {
    const ad =
      "https://duckduckgo.com/y.js?ad_domain=jetbrains.com&ad_provider=bingv7aa&ad_type=txad&click_metadata=abc&rut=def&u3=xyz";
    expect(isDdgAd(ad)).toBe(true);
  });
  test("detects bare ad markers", () => {
    expect(isDdgAd("https://duckduckgo.com/y.js?foo=1")).toBe(true);
    expect(isDdgAd("https://example.com/x?ad_provider=bing")).toBe(true);
    expect(isDdgAd("https://example.com/x?ad_type=txad")).toBe(true);
  });
  test("does NOT flag organic URLs", () => {
    expect(isDdgAd("https://bun.sh/")).toBe(false);
    expect(isDdgAd("https://github.com/oven-sh/bun")).toBe(false);
    expect(isDdgAd("https://docs.yjs.dev/api")).toBe(false);
  });
});

describe("parseDdg drops ads as a unit and pairs snippets", () => {
  test("filters an ad and keeps organic title+snippet aligned", () => {
    const html = `
      <div><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bing&ad_type=txad">Sponsored IDE</a>
      <a class="result__snippet">Ad blurb text</a></div>
      <div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F">Bun runtime</a>
      <a class="result__snippet">A fast all-in-one runtime</a></div>
    `;
    const r = parseDdg(html);
    expect(r.length).toBe(1);
    expect(r[0]!.url).toBe("https://bun.sh/");
    expect(r[0]!.title).toBe("Bun runtime");
    expect(r[0]!.snippet).toBe("A fast all-in-one runtime");
  });
});

describe("Bing fallback parsing", () => {
  test("unwrapBingHref decodes the ck/a click-tracking redirect", () => {
    // u=a1<base64url of "https://bun.sh/">
    const href = "https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9idW4uc2gv&ntb=1";
    expect(unwrapBingHref(href)).toBe("https://bun.sh/");
  });
  test("unwrapBingHref passes through non-redirect hrefs", () => {
    expect(unwrapBingHref("https://example.com/page")).toBe("https://example.com/page");
  });
  test("parseBing extracts title, unwrapped url, and snippet", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9idW4uc2gv">Bun runtime</a></h2>
          <p>A fast all-in-one JavaScript runtime.</p></li>
        <li class="b_algo"><h2><a href="https://github.com/oven-sh/bun">oven-sh/bun</a></h2>
          <p>GitHub repository.</p></li>
      </ol>
    `;
    const r = parseBing(html);
    expect(r.length).toBe(2);
    expect(r[0]!.url).toBe("https://bun.sh/");
    expect(r[0]!.title).toBe("Bun runtime");
    expect(r[0]!.snippet).toBe("A fast all-in-one JavaScript runtime.");
    expect(r[1]!.url).toBe("https://github.com/oven-sh/bun");
  });
});

describe("searchWeb backend fallback (reliability)", () => {
  test("falls back to Bing when DuckDuckGo is blocked/empty", async () => {
    const bingHtml = '<li class="b_algo"><h2><a href="https://example.com/x">Example</a></h2><p>Snippet.</p></li>';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const u = String(input);
      if (u.includes("duckduckgo.com")) return new Response("challenge page, no results", { status: 202 });
      if (u.includes("bing.com")) return new Response(bingHtml, { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const results = await searchWeb("anything");
      expect(results.length).toBe(1);
      expect(results[0]!.url).toBe("https://example.com/x");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns [] when every backend is blocked", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
    try {
      const results = await searchWeb("anything");
      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
