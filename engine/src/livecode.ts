/**
 * livecode.ts — incremental "watch it type" extraction for the editor.
 *
 * The Cursor / Antigravity behaviour users expect is seeing code land in the
 * editor as the model produces it, not a diff card that appears once the call
 * is already finished. The obstacle here is the tool protocol: this engine
 * deliberately uses a strict text protocol instead of native tool calling
 * (small models emit malformed JSON far too often), so a file write arrives as
 *
 *     TOOL_CALL: {"name":"write_file","args":{"path":"a.ts","content":"…"}}
 *
 * and the code is a JSON-ESCAPED STRING inside a payload that is not valid
 * JSON until the very last token. Waiting for the closing brace means waiting
 * for the whole file — exactly the delay we are trying to remove.
 *
 * So this module decodes the `content` string incrementally: it scans the
 * partial buffer, finds the write target, and JSON-unescapes as far as the
 * bytes allow, stopping cleanly on a dangling escape (`"\` or `"\u00`) so a
 * split escape sequence is never mis-decoded. Callers get only the NEW
 * characters since the previous call, which they forward to the UI.
 *
 * Pure and synchronous: no I/O, no clock. `feed()` is a state machine over an
 * append-only buffer, which is what makes it unit-testable against the exact
 * chunk boundaries a real stream produces.
 */

/** Per-stream cursor. One per LLM call; created by `newLiveCodeState()`. */
export interface LiveCodeState {
  /** Resolved write target, once the `path` argument has been seen. */
  path?: string;
  /** Which tool this stream is writing through (write_file | edit_file). */
  tool?: "write_file" | "edit_file";
  /** Count of decoded characters already handed to the caller. */
  emitted: number;
  /** True once the content string's closing quote has been consumed. */
  closed: boolean;
}

export function newLiveCodeState(): LiveCodeState {
  return { emitted: 0, closed: false };
}

export interface LiveCodeDelta {
  path: string;
  /** Newly decoded characters since the previous feed() call. */
  delta: string;
  /** True on the frame that completes the content string. */
  done: boolean;
}

/** `"name"` may be quoted with either quote style and spaced arbitrarily. */
const TOOL_NAME_RE = /["']?name["']?\s*:\s*["'](write_file|edit_file)["']/;
/** Accepts path | target_file | file_path (normalizeTool's accepted aliases). */
const PATH_RE = /["']?(?:path|target_file|file_path)["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** Content key for write_file (`content`) and edit_file (`newText`). */
const CONTENT_KEY_RE = /["']?(?:content|newText|new_str|code)["']?\s*:\s*"/;

/**
 * Decode a JSON string body that may be cut off mid-escape.
 *
 * Returns the decoded text, whether the closing quote was reached, and how
 * many RAW characters were consumed. A trailing partial escape (`\`, `\u`,
 * `\u0`, `\u00`, `\u00A`) is left undecoded so the next chunk completes it —
 * decoding it early would emit a literal backslash into the user's file.
 */
export function decodePartialJsonString(raw: string): { text: string; closed: boolean } {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') return { text: out, closed: true };
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    // Escape sequence — needs at least one more character.
    if (i + 1 >= raw.length) break; // dangling backslash: wait for more input
    const e = raw[i + 1]!;
    if (e === "u") {
      if (i + 6 > raw.length) break; // partial \uXXXX: wait
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // Malformed — pass through literally rather than dropping bytes.
        out += raw.slice(i, i + 6);
      } else {
        out += String.fromCharCode(parseInt(hex, 16));
      }
      i += 6;
      continue;
    }
    switch (e) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      // Unknown escape: keep the character itself (lenient, matching the
      // salvaging posture of actions.ts — small models invent escapes).
      default: out += e; break;
    }
    i += 2;
  }
  return { text: out, closed: false };
}

/**
 * Feed the accumulated assistant text; get back any newly decoded file content.
 *
 * `buf` must be the FULL text so far (append-only), not just the latest chunk —
 * the write target may have been announced many tokens ago.
 *
 * Returns null when there is nothing new to show: no write action yet, no
 * content key yet, or no additional decoded characters this round.
 */
export function feed(buf: string, st: LiveCodeState): LiveCodeDelta | null {
  if (st.closed) return null;

  // 1. Is this stream a file write at all? Cache the answer once known.
  if (!st.tool) {
    const m = TOOL_NAME_RE.exec(buf);
    if (!m) return null;
    st.tool = m[1] as "write_file" | "edit_file";
  }

  // 2. Resolve the target path. Until the path argument has fully arrived we
  //    cannot attribute the code to a file, so hold everything back.
  if (!st.path) {
    const m = PATH_RE.exec(buf);
    if (!m) return null;
    const decoded = decodePartialJsonString(`${m[1]!}"`);
    const p = decoded.text.trim();
    if (!p) return null;
    st.path = p;
  }

  // 3. Locate the content string and decode as far as the bytes allow.
  const key = CONTENT_KEY_RE.exec(buf);
  if (!key) return null;
  const bodyStart = key.index + key[0].length;
  const { text, closed } = decodePartialJsonString(buf.slice(bodyStart));

  if (text.length <= st.emitted && !closed) return null;
  const delta = text.slice(st.emitted);
  st.emitted = text.length;
  if (closed) st.closed = true;
  if (!delta && !closed) return null;

  return { path: st.path, delta, done: closed };
}
