// Tiny dependency-free markdown renderer for chat bubbles (web #19).
// Supports: # headers, ``` code fences, `inline code`, **bold**, *italic*,
// [links](url), "- " / "* " bullet lists, "1. " numbered lists, paragraphs.
// Built as React elements (never dangerouslySetInnerHTML), so all text is
// HTML-escaped by construction. Leaf text runs through ClickableText so
// @file:line tags stay clickable.
import React from "react";
import { ClickableText } from "../components/ClickableText";

/** Inline spans: bold / italic / inline code / links; everything else plain. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  // Fresh global-flag regex per call: recursive invocations (nested bold /
  // italic) would otherwise clobber a shared module-level regex's lastIndex,
  // restarting the outer scan at index 0 and looping forever on the first
  // **bold** / *italic* token.
  const INLINE =
    /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(`([^`\n]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<ClickableText key={`${keyBase}t${k++}`} text={text.slice(last, m.index)} />);
    if (m[1] !== undefined) {
      nodes.push(<strong key={`${keyBase}b${k++}`}>{renderInline(m[2], `${keyBase}b${k}-`)}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={`${keyBase}i${k++}`}>{renderInline(m[4], `${keyBase}i${k}-`)}</em>);
    } else if (m[5] !== undefined) {
      nodes.push(<em key={`${keyBase}u${k++}`}>{renderInline(m[6], `${keyBase}u${k}-`)}</em>);
    } else if (m[7] !== undefined) {
      nodes.push(<code key={`${keyBase}c${k++}`} className="md-code">{m[8]}</code>);
    } else if (m[9] !== undefined) {
      const href = m[11];
      const safe = /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
      nodes.push(
        safe ? (
          <a key={`${keyBase}a${k++}`} className="md-link" href={safe} target="_blank" rel="noreferrer noopener">
            {m[10]}
          </a>
        ) : (
          <span key={`${keyBase}a${k++}`}>{m[9]}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<ClickableText key={`${keyBase}t${k++}`} text={text.slice(last)} />);
  return nodes;
}

/** Block-level: fences, headers, lists, paragraphs. */
export function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence (or run past EOF)
      blocks.push(
        <pre key={`pre${key++}`} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // header
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div key={`h${key++}`} className={`md-h md-h${level}`}>
          {renderInline(h[2], `h${key}-`)}
        </div>,
      );
      i += 1;
      continue;
    }

    // GFM table.
    //
    // Models reach for tables constantly when explaining code — "| Step | What
    // it does |" — and without this branch every one of them rendered as raw
    // pipe soup in the transcript. A table is a block of consecutive pipe rows
    // whose SECOND row is the delimiter (|---|:--:|), which is what separates a
    // real table from a line that merely happens to contain a pipe.
    const isRow = (l: string | undefined): boolean => !!l && /\|/.test(l);
    const isDelim = (l: string | undefined): boolean => !!l && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(l) && /\|/.test(l);
    if (isRow(line) && isDelim(lines[i + 1])) {
      const cells = (l: string): string[] =>
        l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      // Alignment comes from the delimiter row (:--, --:, :--:).
      const align = cells(lines[i + 1]).map((d) =>
        d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : "left",
      );
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isRow(lines[i]) && lines[i].trim() !== "") {
        body.push(cells(lines[i]));
        i += 1;
      }
      blocks.push(
        // Wrapped so a wide table scrolls inside itself instead of forcing the
        // whole chat column sideways.
        <div className="md-table-wrap" key={`tbl-${key++}`}>
          <table className="md-table">
            <thead>
              <tr>{head.map((h, n) => (
                <th key={n} style={{ textAlign: align[n] ?? "left" }}>{renderInline(h, `th-${key}-${n}`)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>{head.map((_, n) => (
                  <td key={n} style={{ textAlign: align[n] ?? "left" }}>{renderInline(row[n] ?? "", `td-${key}-${r}-${n}`)}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`ul${key++}`} className="md-list">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ul${key}-${j}-`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={`ol${key++}`} className="md-list">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ol${key}-${j}-`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // paragraph: consecutive non-empty, non-special lines
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`p${key++}`} className="md-p">
        {buf.map((l, j) => (
          <React.Fragment key={j}>
            {j > 0 && <br />}
            {renderInline(l, `p${key}-${j}-`)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return <span className="md">{blocks}</span>;
}

/** Convenience component for chat bubbles. Memoized: during live streaming the
 *  timeline re-derives every token frame, but only the actively-streaming bubble's
 *  `text` changes — every settled bubble keeps the same string and skips re-parse. */
export const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return <>{renderMarkdown(text)}</>;
});
