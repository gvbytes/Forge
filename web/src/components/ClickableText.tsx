// PS 7b: file & line tags in chat OUTPUT are clickable — clicking opens the
// file in an editor tab (line scrolled into view when a :N or :L-N suffix exists).
import React from "react";
import { useEditor } from "../stores/editor";

const TOKEN =
  /((?:[\w./-]+\/)*[\w.-]+\.(?:py|js|jsx|ts|tsx|cpp|h|hpp|c|java|go|rb|rs|md|json|yaml|yml|css|html))(:L?(\d+)(?:-L?(\d+))?)?/g;

export function ClickableText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  let key = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    const [full, path, , lineFrom, lineTo] = m;
    if (m.index > last) parts.push(text.slice(last, m.index));
    // skip bare numbers / version-ish tokens: require a known code-ish ext (regex does) + slash-or-rel look
    const looksReal = path.includes("/") || /\.[a-z]{2,4}$/.test(path);
    if (!looksReal) {
      parts.push(full);
    } else {
      parts.push(
        <button
          key={`ct${key++}`}
          className="file-tag"
          title={lineTo ? `${path} lines ${lineFrom}–${lineTo}` : lineFrom ? `${path}:${lineFrom}` : path}
          onClick={() => {
            void useEditor.getState().openFile(path.replace(/^\.\//, ""));
            if (lineFrom) {
              window.setTimeout(() => {
                document.querySelector(`[data-line="${lineFrom}"]`)?.scrollIntoView({ block: "center" });
              }, 350);
            }
          }}
        >
          {lineFrom ? `${path}:${lineFrom}` : path}
        </button>,
      );
    }
    last = m.index + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
