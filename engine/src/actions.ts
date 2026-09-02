/**
 * Native TypeScript Action Parser & Lenient JSON Salvager.
 *
 * Capabilities:
 * - Bracket-depth state machine scanner for balanced JSON objects/arrays.
 * - Smart quote normalization (“ ” ‘ ’ -> " ').
 * - Python literal replacement (None -> null, True -> true, False -> false).
 * - Trailing comma cleanup in objects and arrays.
 * - Unescaped control characters in JSON strings escaping.
 * - DSML / AntML / XML tool call salvage:
 *   - <tool_call>{"name": ..., "args": {...}}</tool_call>
 *   - <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
 *   - <action name="...">...</action>
 *   - <invoke name="...">...</invoke>
 *   - TOOL_CALL: {...}
 */

export interface ToolCallAction {
  name: string;
  args: Record<string, unknown>;
  raw?: string;
}

/** Normalize smart quotes to standard ASCII quotes */
export function normalizeSmartQuotes(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'");
}

/** Convert Python literals (None, True, False) to JSON (null, true, false) outside strings */
export function normalizePythonLiterals(text: string): string {
  let result = "";
  let inStr = false;
  let quoteChar = "";
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      result += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      result += c;
      if (inStr) esc = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!inStr) {
        inStr = true;
        quoteChar = c;
      } else if (c === quoteChar) {
        inStr = false;
      }
      result += c;
      continue;
    }

    if (!inStr) {
      if (text.startsWith("None", i) && !/[A-Za-z0-9_]/.test(text[i + 4] || "") && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) {
        result += "null";
        i += 3;
        continue;
      }
      if (text.startsWith("True", i) && !/[A-Za-z0-9_]/.test(text[i + 4] || "") && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) {
        result += "true";
        i += 3;
        continue;
      }
      if (text.startsWith("False", i) && !/[A-Za-z0-9_]/.test(text[i + 5] || "") && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) {
        result += "false";
        i += 4;
        continue;
      }
    }
    result += c;
  }
  return result;
}

/** Remove trailing commas before closing braces/brackets */
export function removeTrailingCommas(text: string): string {
  let result = "";
  let inStr = false;
  let quoteChar = "";
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      result += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      result += c;
      if (inStr) esc = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!inStr) {
        inStr = true;
        quoteChar = c;
      } else if (c === quoteChar) {
        inStr = false;
      }
      result += c;
      continue;
    }

    if (!inStr && c === ",") {
      // Look ahead past whitespace to see if next non-whitespace char is } or ]
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) {
        // Skip this comma
        continue;
      }
    }
    result += c;
  }
  return result;
}

/** Escape unescaped control characters inside JSON double-quoted strings */
export function escapeControlCharacters(text: string): string {
  let result = "";
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      result += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      result += c;
      if (inStr) esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      result += c;
      continue;
    }

    if (inStr) {
      if (c === "\n") {
        result += "\\n";
        continue;
      }
      if (c === "\r") {
        result += "\\r";
        continue;
      }
      if (c === "\t") {
        result += "\\t";
        continue;
      }
      if (c.charCodeAt(0) < 32) {
        result += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    result += c;
  }
  return result;
}

/** Convert single-quoted keys and strings to double-quoted JSON */
export function fixSingleQuotes(text: string): string {
  // If already valid or mostly double quotes, try standard transforms
  return text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, content: string) => {
    const escaped = content.replace(/"/g, '\\"').replace(/\\'/g, "'");
    return `"${escaped}"`;
  });
}

/** Bracket-depth state machine scanner for balanced JSON objects/arrays */
export function findBalancedJsonSpan(text: string, startIdx = 0): { start: number; end: number } | null {
  const firstBrace = text.indexOf("{", startIdx);
  const firstBracket = text.indexOf("[", startIdx);

  let start = -1;
  let openChar = "{";
  let closeChar = "}";

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    openChar = "{";
    closeChar = "}";
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openChar = "[";
    closeChar = "]";
  } else {
    return null;
  }

  let depth = 0;
  let inStr = false;
  let quoteChar = "";
  let esc = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      if (inStr) esc = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!inStr) {
        inStr = true;
        quoteChar = c;
      } else if (c === quoteChar) {
        inStr = false;
      }
      continue;
    }
    if (inStr) continue;

    if (c === openChar) {
      depth++;
    } else if (c === closeChar) {
      depth--;
      if (depth === 0) {
        return { start, end: i };
      }
    }
  }

  return null;
}

/** Lenient JSON parser */
export function parseJsonLenient<T = unknown>(text: string): T | null {
  if (!text || !text.trim()) return null;
  const unthought = text
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<thought[\s\S]*?<\/thought>/gi, "");
  const trimmed = unthought.trim();

  // 1. Direct standard parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continue
  }

  // 2. Strip code fences if present
  let clean = trimmed;
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
    try {
      return JSON.parse(clean) as T;
    } catch {
      // continue
    }
  }

  // 3. Find balanced JSON slice
  const span = findBalancedJsonSpan(clean);
  if (span) {
    const slice = clean.slice(span.start, span.end + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      // continue with repairs
    }

    // Step-by-step repair pipeline
    let repaired = normalizeSmartQuotes(slice);
    repaired = normalizePythonLiterals(repaired);
    repaired = removeTrailingCommas(repaired);
    repaired = escapeControlCharacters(repaired);

    try {
      return JSON.parse(repaired) as T;
    } catch {
      // Try single-quote repair
      try {
        const sqRepaired = fixSingleQuotes(repaired);
        return JSON.parse(sqRepaired) as T;
      } catch {
        // continue
      }
    }
  }

  // 4. Try whole cleaned text with repairs
  let repairedAll = normalizeSmartQuotes(clean);
  repairedAll = normalizePythonLiterals(repairedAll);
  repairedAll = removeTrailingCommas(repairedAll);
  repairedAll = escapeControlCharacters(repairedAll);

  try {
    return JSON.parse(repairedAll) as T;
  } catch {
    try {
      return JSON.parse(fixSingleQuotes(repairedAll)) as T;
    } catch {
      return null;
    }
  }
}

/** Alias kept for the smoke harness (test_engine.ts) which imports this name. */
export const lenientJsonParse = parseJsonLenient;

/** Parse a raw JSON object into a tool action if it carries a name/args
 *  shape. Shared by the fenced + line-start last-resort extractors (B13). */
function rawJsonToAction(raw: string): ToolCallAction | null {
  const parsed = parseJsonLenient<{ name?: unknown; tool?: unknown; action?: unknown; args?: unknown; parameters?: unknown; input?: unknown }>(raw);
  if (parsed && typeof parsed === "object") {
    const name = (parsed.name || parsed.tool || parsed.action) as string | undefined;
    if (typeof name === "string" && name.trim()) {
      const args = (parsed.args || parsed.parameters || parsed.input || {}) as Record<string, unknown>;
      return {
        name: name.trim(),
        args: typeof args === "object" && args !== null ? args : {},
        raw,
      };
    }
  }
  return null;
}

/** Extract tool call action from text, handling DSML/AntML/XML and JSON formats */
export function parseAction(text: string): ToolCallAction | null {
  const all = extractAllActions(text);
  return all.length > 0 ? all[0]! : null;
}

/** Extract all tool actions found in a completion text */
export function extractAllActions(text: string): ToolCallAction[] {
  if (!text || !text.trim()) return [];
  const actions: ToolCallAction[] = [];

  // 1. TOOL_CALL: prefix marker (tolerant of "TOOLCALL:" / mixed case — small
  //    models drop the underscore; see orchestrator.extractToolCalls).
  const marker = /(?:^|\n)[ \t]*(?:\*\*)?TOOL[_ ]?CALL:[ \t]*(?:\*\*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) {
    const startIdx = m.index + m[0].length;
    const span = findBalancedJsonSpan(text, startIdx);
    if (span) {
      const raw = text.slice(span.start, span.end + 1);
      const parsed = parseJsonLenient<{ name?: unknown; tool?: unknown; action?: unknown; args?: unknown; parameters?: unknown; input?: unknown }>(raw);
      if (parsed && typeof parsed === "object") {
        const name = (parsed.name || parsed.tool || parsed.action) as string | undefined;
        if (typeof name === "string" && name.trim()) {
          const args = (parsed.args || parsed.parameters || parsed.input || {}) as Record<string, unknown>;
          actions.push({
            name: name.trim(),
            args: typeof args === "object" && args !== null ? args : {},
            raw,
          });
          marker.lastIndex = span.end + 1;
          continue;
        }
      }
      marker.lastIndex = span.end + 1;
    }
  }

  // 2. <tool_call> XML tags (JSON inside or key-value inside, supports <tool_call:ID> tags)
  const toolCallXml = /<tool_call(?::[\w_]+)?>\s*([\s\S]*?)\s*<\/tool_call(?::[\w_]+)?>/gi;
  while ((m = toolCallXml.exec(text)) !== null) {
    const inner = m[1]!.trim();
    // Try JSON inside
    const parsed = parseJsonLenient<{ name?: unknown; tool?: unknown; action?: unknown; args?: unknown }>(inner);
    if (parsed && typeof parsed === "object") {
      const name = (parsed.name || parsed.tool || parsed.action) as string | undefined;
      if (typeof name === "string" && name.trim()) {
        const args = (parsed.args ?? {}) as Record<string, unknown>;
        actions.push({ name: name.trim(), args: typeof args === "object" && args !== null ? args : {}, raw: m[0] });
        continue;
      }
    }

    // Try key-value inside: <arg_key>k</arg_key><arg_value>v</arg_value>
    const nameMatch = inner.match(/^\s*([\w.]+)/);
    if (nameMatch) {
      const name = nameMatch[1]!;
      const args: Record<string, unknown> = {};
      const tagPattern = /<(arg_key|arg_value|key|value)>\s*([\s\S]*?)(?:<\/(?:arg_key|arg_value|key|value)>|(?=<(?:arg_key|arg_value|key|value)>)|$)/gi;
      let match: RegExpExecArray | null;
      let currentKey: string | null = null;
      
      while ((match = tagPattern.exec(inner)) !== null) {
        const tag = match[1]!.toLowerCase();
        let val = match[2]!.trim();
        val = val.replace(/^<\/?(?:arg_key|key|arg_value|value)>/i, "").trim();
        
        if (tag.includes("key")) {
          currentKey = val.replace(/[^a-zA-Z0-9_-]/g, "").trim();
        } else if (tag.includes("value")) {
          if (!currentKey && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) {
            currentKey = val;
          } else if (currentKey) {
            const parsedVal = parseJsonLenient(val);
            args[currentKey] = parsedVal !== null ? parsedVal : val;
            currentKey = null;
          }
        }
      }
      
      if (Object.keys(args).length > 0) {
        actions.push({ name, args, raw: m[0] });
      }
    }
  }

  // 3. <action name="...">...</action> or <invoke name="...">...</invoke> (AntML / DSML)
  const tagAction = /<(?:action|invoke)\s+(?:name|tool)=["']([^"']+)["'](?:\s+[^>]*)?>([\s\S]*?)<\/(?:action|invoke)>/gi;
  while ((m = tagAction.exec(text)) !== null) {
    const name = m[1]!.trim();
    const inner = m[2]!.trim();
    const parsed = parseJsonLenient<Record<string, unknown>>(inner);
    if (parsed && typeof parsed === "object") {
      actions.push({ name, args: parsed, raw: m[0] });
    } else {
      // Check for <parameter name="k">v</parameter>
      const paramRe = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
      const args: Record<string, unknown> = {};
      let p: RegExpExecArray | null;
      let hasParams = false;
      while ((p = paramRe.exec(inner)) !== null) {
        hasParams = true;
        const pk = p[1]!;
        const pv = p[2]!.trim();
        const pParsed = parseJsonLenient(pv);
        args[pk] = pParsed !== null ? pParsed : pv;
      }
      if (hasParams) {
        actions.push({ name, args, raw: m[0] });
      } else if (inner) {
        actions.push({ name, args: { input: inner }, raw: m[0] });
      } else {
        actions.push({ name, args: {}, raw: m[0] });
      }
    }
  }

  // B13: explicit instruction formats win outright. Returning here keeps a
  // reply that already used TOOL_CALL / XML / DSML from ALSO tripping the
  // raw-JSON last resort (duplicate actions from one instruction).
  if (actions.length > 0) return actions;

  // 4. Last-resort raw JSON — but ONLY a genuine instruction block (B13).
  // The old code treated ANY balanced JSON with a name/tool/action key
  // ANYWHERE in the prose as a tool call, so explaining the format or
  // echoing an example executed it. Now we accept exactly two shapes:
  //   a) a fenced block:  ```json\n{...}\n```
  //   b) JSON that starts at the beginning of a line (an instruction block
  //      the model emitted standalone, not quoted mid-sentence).
  // JSON embedded mid-prose is deliberately ignored.
  const fenceRe = /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    const inner = fm[1]!.trim();
    if (!inner.startsWith("{")) continue; // only object-shaped payloads
    const span = findBalancedJsonSpan(inner);
    if (!span) continue;
    const act = rawJsonToAction(inner.slice(span.start, span.end + 1));
    if (act) actions.push(act);
  }
  if (actions.length > 0) return actions;

  // Line-start JSON: the balanced span must open at column 0 of some line.
  const lineStarts = new Set<number>([0]);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.add(i + 1);
  }
  let cursor = 0;
  while (cursor < text.length) {
    const span = findBalancedJsonSpan(text, cursor);
    if (!span) break;
    if (lineStarts.has(span.start)) {
      const act = rawJsonToAction(text.slice(span.start, span.end + 1));
      if (act) actions.push(act);
    }
    cursor = span.end + 1;
  }

  return actions;
}
