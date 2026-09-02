// Models reach for tables constantly when explaining code. The renderer had no
// table branch, so every one arrived in the transcript as raw pipe soup
// ("| Step | What it does |") — a large share of why the chat read as noisy.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";

/** Walk the React element tree collecting every element type present. */
function types(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { node.forEach((n) => types(n, out)); return out; }
  if (node && typeof node === "object" && "type" in node) {
    const el = node as { type: unknown; props?: { children?: unknown } };
    if (typeof el.type === "string") out.push(el.type);
    if (el.props?.children) types(el.props.children, out);
  }
  return out;
}

describe("markdown tables", () => {
  test("a GFM table renders as a real table, not pipe text", () => {
    const t = types(renderMarkdown("| Step | Does |\n|------|------|\n| 1 | thing |\n"));
    expect(t).toContain("table");
    expect(t).toContain("th");
    expect(t).toContain("td");
  });

  test("a lone pipe line is NOT a table — the delimiter row is what decides", () => {
    // Without requiring the delimiter, any prose containing "|" became a table.
    expect(types(renderMarkdown("use a | b to pipe output\n"))).not.toContain("table");
  });

  test("ragged rows do not lose or misalign cells", () => {
    const t = types(renderMarkdown("| a | b | c |\n|---|---|---|\n| 1 |\n"));
    // Cells are emitted per HEADER column, so a short row still yields 3 tds.
    expect(t.filter((x) => x === "td").length).toBe(3);
  });

  test("a table stops at the first blank line", () => {
    const out = renderMarkdown("| a |\n|---|\n| 1 |\n\nAfter the table.\n");
    expect(types(out)).toContain("table");
    expect(JSON.stringify(out)).toContain("After the table.");
  });
});
