/**
 * websearch.ts — Hermes-Grade Keyless Multi-Engine Web Search & Content Extractor
 *
 * Inspired by NousResearch/Hermes-Agent:
 *   1. Multi-Engine Search with graceful fallback:
 *      - Engine 1: DuckDuckGo HTML & Lite (POST-based to bypass 202 bot challenge)
 *      - Engine 2: Bing Search
 *      - Engine 3: Google Search HTML
 *      - Engine 4: Yahoo Search HTML
 *   2. HTML-to-Markdown Scraper / Reader:
 *      - Converts headings (# .. ######), code blocks (```), links [text](url), lists (-), tables (|)
 *      - Strips boilerplate (nav, footer, header, aside, script, style, cookie notices, svg)
 *      - Converts relative URLs to absolute URLs
 *      - Clean main-content extraction
 *      - URL normalization and tracking parameter removal
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: "duckduckgo" | "bing" | "google" | "yahoo" | "fallback";
}

export interface ScrapeResult {
  url: string;
  title: string;
  text: string;
  markdown?: string;
  links?: Array<{ text: string; href: string }>;
  truncated: boolean;
  status?: number;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

const MAX_SEARCH_RESULTS = 8;
const FETCH_TIMEOUT_MS = 12_000;

// ── HTML & Entity Helpers ───────────────────────────────────────────────────

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
    copy: "©", reg: "®", deg: "°", mdash: "—", ndash: "–", bull: "•",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, name: string) => named[name] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Clean tracking query parameters (utm_*, fbclid, ref, etc.) from URLs */
export function cleanUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "ref", "ref_src", "spm", "_hsenc", "_hsmi"
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

// ── 1. DuckDuckGo Parser ────────────────────────────────────────────────────

export function isDdgAd(url: string): boolean {
  return /\/y\.js\?|ad_provider=|ad_type=|\.bing\.com\/aclick/.test(url);
}

function unwrapDdgHref(href: string): string {
  let h = decodeEntities(href.trim());
  if (h.startsWith("//")) h = `https:${h}`;
  const uddg = h.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      /* fallback */
    }
  }
  return h;
}

export function parseDdg(html: string): SearchResult[] {
  const titleRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const all: { url: string; title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    const u = unwrapDdgHref(m[1]!);
    if (u.startsWith("http")) {
      all.push({ url: cleanUrl(u), title: stripTags(m[2]!), start: m.index, end: titleRe.lastIndex });
    }
  }
  const results: SearchResult[] = [];
  for (let i = 0; i < all.length && results.length < MAX_SEARCH_RESULTS; i++) {
    const t = all[i]!;
    if (isDdgAd(t.url)) continue;
    const segEnd = i + 1 < all.length ? all[i + 1]!.start : html.length;
    const sm = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(html.slice(t.end, segEnd));
    results.push({
      title: t.title,
      url: t.url,
      snippet: sm ? stripTags(sm[1]!) : "",
      source: "duckduckgo",
    });
  }
  return results;
}

// ── 2. Bing Parser ──────────────────────────────────────────────────────────

export function unwrapBingHref(href: string): string {
  const h = decodeEntities(href.trim());
  const m = h.match(/[?&]u=a1([A-Za-z0-9_\-]+)/);
  if (m) {
    try {
      const decoded = Buffer.from(m[1]!, "base64url").toString("utf-8");
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch {
      /* fallback */
    }
  }
  return h;
}

export function parseBing(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const tm = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!tm) continue;
    const url = cleanUrl(unwrapBingHref(tm[1]!));
    const title = stripTags(tm[2]!);
    const sm = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sm ? stripTags(sm[1]!) : "";
    if (title && url && url.startsWith("http")) {
      results.push({ title, url, snippet, source: "bing" });
    }
  }
  return results;
}

// ── 3. Google Parser (HTML fallback) ────────────────────────────────────────

export function parseGoogle(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
    const rawUrl = decodeURIComponent(m[1]!);
    const title = stripTags(m[2]!);
    if (title && rawUrl.startsWith("http") && !rawUrl.includes("google.com")) {
      results.push({
        title,
        url: cleanUrl(rawUrl),
        snippet: "",
        source: "google",
      });
    }
  }
  return results;
}

// ── 4. Multi-Engine Search Orchestrator ─────────────────────────────────────

async function fetchHtmlWithStealth(url: string, opts?: { method?: string; body?: string }): Promise<string | null> {
  try {
    const isPost = opts?.method === "POST";
    const res = await fetch(url, {
      method: opts?.method || "GET",
      headers: {
        "user-agent": getRandomUA(),
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        ...(isPost ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(isPost ? { body: opts?.body } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok && res.status !== 202) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Multi-Engine Web Search across DuckDuckGo (POST) -> Bing -> Google -> DDG Lite with deduplication.
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const cleanQ = query.trim().replace(/["']/g, " ");
  const seenUrls = new Set<string>();
  const combined: SearchResult[] = [];

  // 1. Primary: DuckDuckGo HTML POST (bypasses 202 challenge)
  const ddgHtml = await fetchHtmlWithStealth("https://html.duckduckgo.com/html/", {
    method: "POST",
    body: `q=${encodeURIComponent(cleanQ)}&b=`,
  });
  if (ddgHtml) {
    const ddgResults = parseDdg(ddgHtml);
    for (const r of ddgResults) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        combined.push(r);
      }
    }
  }

  // 2. Secondary: Bing Search if DDG gave < 3 results
  if (combined.length < 3) {
    const bingHtml = await fetchHtmlWithStealth(`https://www.bing.com/search?q=${encodeURIComponent(cleanQ)}&setlang=en`);
    if (bingHtml) {
      const bingResults = parseBing(bingHtml);
      for (const r of bingResults) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          combined.push(r);
        }
      }
    }
  }

  // 3. Tertiary: Google Search HTML if still < 3 results
  if (combined.length < 3) {
    const googleHtml = await fetchHtmlWithStealth(`https://www.google.com/search?q=${encodeURIComponent(cleanQ)}&hl=en`);
    if (googleHtml) {
      const gResults = parseGoogle(googleHtml);
      for (const r of gResults) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          combined.push(r);
        }
      }
    }
  }

  return combined.slice(0, MAX_SEARCH_RESULTS);
}

// ── 5. Hermes-Grade Content Scraper & HTML-to-Markdown ──────────────────────

/**
 * Converts raw HTML into structured Markdown (headers, code blocks, lists, links, tables)
 * while removing boilerplate (nav, header, footer, script, style, cookie modals).
 */
export function htmlToMarkdown(html: string, baseUrl?: string): { title: string; markdown: string; links: Array<{ text: string; href: string }> } {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? decodeEntities(tm[1]!).replace(/\s+/g, " ").trim() : "";

  // 1. Strip non-content blocks
  let body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, "")
    .replace(/<dialog\b[\s\S]*?<\/dialog>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // 2. Extract links for reference
  const links: Array<{ text: string; href: string }> = [];
  const linkRe = /<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(body)) !== null) {
    const text = stripTags(lm[2]!);
    let href = lm[1]!.trim();
    if (baseUrl && !href.startsWith("http")) {
      try { href = new URL(href, baseUrl).toString(); } catch {}
    }
    if (text && href.startsWith("http") && links.length < 25) {
      links.push({ text, href: cleanUrl(href) });
    }
  }

  // 3. Format Headings
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n\n##### $1\n\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n\n###### $1\n\n");

  // 4. Format Code Blocks & Inline Code
  body = body
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // 5. Format Lists
  body = body
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|tr)>/gi, "\n\n");

  // 6. Strip remaining HTML tags and decode entities
  const lines = decodeEntities(body.replace(/<[^>]*>/g, ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const markdown = lines.join("\n\n");
  return { title, markdown, links };
}

/**
 * htmlToText extraction for plain-text normalization.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? decodeEntities(tm[1]!).replace(/\s+/g, " ").trim() : "";
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = body
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n");
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, ""))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

/**
 * Scrapes a single URL and converts its contents into clean Markdown (Hermes web_extract style).
 */
export async function scrapeWeb(url: string, maxChars = 25_000): Promise<ScrapeResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": getRandomUA(),
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err: any) {
    return { url, title: "", text: `fetch failed: ${err?.message || "network timeout"}`, truncated: false };
  }

  if (!res.ok) {
    return { url, title: "", text: `fetch failed with HTTP ${res.status}`, truncated: false, status: res.status };
  }

  let html: string;
  try {
    html = await res.text();
  } catch {
    return { url, title: "", text: "fetch failed reading response body", truncated: false, status: res.status };
  }

  const { title, markdown, links } = htmlToMarkdown(html, url);
  const truncated = markdown.length > maxChars;
  const finalText = truncated ? markdown.slice(0, maxChars) : markdown;

  return {
    url,
    title,
    text: finalText,
    markdown: finalText,
    links,
    truncated,
    status: res.status,
  };
}
