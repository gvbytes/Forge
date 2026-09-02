import { restoreFetch } from "./_env.js";
import { describe, test, expect, afterEach } from "bun:test";

// This file stubs globalThis.fetch; bun shares one process across test files,
// so the stub MUST be torn down or it leaks into the next file.
afterEach(restoreFetch);
import { htmlToText, scrapeWeb } from "../src/websearch.js";

describe("htmlToText extraction", () => {
  test("extracts title and readable text, strips scripts/styles/comments", () => {
    const html = `
      <html><head><title>  My Page  </title>
      <style>.x{color:red}</style>
      <script>var a = 1; console.log("noise");</script>
      <!-- a comment -->
      </head><body>
      <h1>Welcome</h1>
      <p>Hello &amp; welcome to the site.</p>
      <p>Second paragraph.</p>
      </body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("My Page");
    expect(text).toContain("Welcome");
    expect(text).toContain("Hello & welcome to the site.");
    expect(text).toContain("Second paragraph.");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("a comment");
  });

  test("decodes entities and collapses whitespace per line", () => {
    const { text } = htmlToText("<p>Too&nbsp;&nbsp;many   spaces &lt;ok&gt;</p>");
    expect(text).toBe("Too many spaces <ok>");
  });

  test("returns empty title when absent", () => {
    const { title } = htmlToText("<div>no title here</div>");
    expect(title).toBe("");
  });
});

describe("scrapeWeb (fetch stubbed)", () => {
  test("returns title, url, and text for a 200 HTML page", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<title>Docs</title><p>Install with npm install.</p>", {
        status: 200, headers: { "content-type": "text/html" },
      })) as typeof fetch;
    try {
      const r = await scrapeWeb("https://example.com/docs");
      expect(r.url).toBe("https://example.com/docs");
      expect(r.title).toBe("Docs");
      expect(r.text).toContain("Install with npm install.");
      expect(r.truncated).toBe(false);
      expect(r.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("truncates text to maxChars and flags truncated", async () => {
    const realFetch = globalThis.fetch;
    const long = "word ".repeat(2000); // ~10000 chars
    globalThis.fetch = (async () =>
      new Response(`<title>T</title><p>${long}</p>`, { status: 200 })) as typeof fetch;
    try {
      const r = await scrapeWeb("https://example.com", 500);
      expect(r.text.length).toBeLessThanOrEqual(500);
      expect(r.truncated).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("reports non-200 as an error result, not an exception", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      const r = await scrapeWeb("https://example.com/missing");
      expect(r.status).toBe(404);
      expect(r.text).toContain("404");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("network failure returns an error result, not an exception", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    try {
      const r = await scrapeWeb("https://down.example.com");
      expect(r.status).toBeUndefined();
      expect(r.text.toLowerCase()).toContain("fetch failed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
