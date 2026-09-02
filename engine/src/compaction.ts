/**
 * Tiered context compaction for Native TypeScript Engine.
 *
 * Tiers:
 *   T0   truncate stale/large tool outputs (>900 chars -> head 400 + [truncated] + tail 400)
 *   T1   summarize old tool-result runs to lines (paths, exit codes, first/last lines, dedupe)
 *   T1.5 amortized forgetting (deterministic middle-drop preserving keystone goal + failure lessons)
 *   T2   rolling LLM summary of old turns with deterministic substring integrityProbe
 *   T3   emergency state floor (rebuild from system + keystone + last turn + state manifest)
 *
 * Estimation ratio: 3.5 chars/token.
 * Env override: ENGINE_FORCE_CTX.
 */
import crypto from "node:crypto";
import { ChatMessage, Role } from "./types.js";
import { log, logger } from "./logger.js";

export const CHARS_PER_TOKEN = 3.5;
export const PROTECTED_BEGIN = "<<<PROTECTED>>>";
export const PROTECTED_END = "<<<END PROTECTED>>>";

export const TOOL_TRUNC_HEAD = 400;
export const TOOL_TRUNC_TAIL = 400;
export const TOOL_STALE_MIN_LEN = 900;

export const LESSON_RE = /\b(error|failed|failure|fatal|traceback|exception)\b/i;
export const PATH_RE = /[A-Za-z0-9_\-.~]+(?:\/[A-Za-z0-9_\-.~]+)+/g;
export const EXIT_RE = /(?:exit(?:\s*code|\s*status)?|rc|status)\s*[:=]?\s*(\d{1,3})/i;

export const TRANSCRIPT_MSG_CAP = 1500;
export const TRANSCRIPT_TOTAL_CAP = 24_000;

export type SummarizerFn = (prompt: string) => Promise<string>;

export interface CompactionReport {
  tier: "T0" | "T1" | "T1.5" | "T2" | "T3" | "none";
  tokensBefore: number;
  tokensAfter: number;
  dropped: number;
  summarized: number;
  preservedProtected: boolean;
  notes: string[];
}

export function estTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
export const estimateTokens = estTokens;

export function estimateMessages(msgs: ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += 4 + estTokens(m.content);
  }
  return total;
}

export function getEffectiveContextWindow(defaultCtx = 128_000): number {
  const envOverride = process.env.ENGINE_FORCE_CTX ?? process.env.AGENTZERO_FORCE_CTX;
  if (envOverride) {
    const parsed = Number.parseInt(envOverride, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Guard: an invalid model ctx (0/negative/NaN — e.g. a ModelSpec with an
  // unknown ctx_window) used to make target <= 0 or NaN, so EVERY comparison
  // failed and maybeCompact triggered on every single call.
  if (Number.isFinite(defaultCtx) && defaultCtx > 0) return defaultCtx;
  return 128_000;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Group non-system messages into turns; turn starts at each user message */
export function splitTurns(messages: ChatMessage[]): number[][] {
  const turns: number[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    if (m.role === "user" || turns.length === 0) {
      turns.push([]);
    }
    turns[turns.length - 1]!.push(i);
  }
  return turns;
}

export function firstUserIndex(messages: ChatMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") return i;
  }
  return null;
}

const TOOL_RESULT_PREFIXES = ["[tool", "[delegate report]", "[retrieve_code result]"];
const TOOL_TAG_RE = /^\[[A-Za-z0-9_]+ (?:ok|ERROR)\]/;

export function isToolResult(msg: ChatMessage): boolean {
  if (msg.role === "tool") return true;
  if (msg.role !== "user") return false;
  const c = msg.content || "";
  return TOOL_RESULT_PREFIXES.some((p) => c.startsWith(p)) || TOOL_TAG_RE.test(c);
}

export function extractProtected(messages: ChatMessage[]): string {
  const keyI = firstUserIndex(messages);
  const parts: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system" || i === keyI || (m.content && m.content.includes(PROTECTED_BEGIN))) {
      parts.push(m.content || "");
    }
  }

  const combined = parts.filter((p) => p.trim().length > 0).join("\n");
  const b = combined.indexOf(PROTECTED_BEGIN);
  if (b >= 0) {
    const e = combined.indexOf(PROTECTED_END, b);
    if (e >= 0) {
      return combined.slice(b, e + PROTECTED_END.length);
    }
  }
  return combined.trim();
}

function truncateMiddle(text: string, head: number, tail: number): string {
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}...[truncated ${cut} chars]...${text.slice(text.length - tail)}`;
}

/**
 * Compaction inserts synthetic user-role messages (T1 summaries, T1.5 forget
 * marker, T3 rebuild) and drops ranges, which can place two user (or two
 * assistant) messages directly adjacent — a shape some provider APIs reject.
 * Merge such adjacent same-role pairs, preserving content and order.
 * system/tool messages are never merged (tool msgs carry distinct toolCallIds).
 */
function mergeAdjacentSameRole(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && (m.role === "user" || m.role === "assistant")) {
      out[out.length - 1] = {
        ...prev,
        content: prev.content ? `${prev.content}\n\n${m.content}` : m.content,
        meta: { ...(prev.meta ?? {}), ...(m.meta ?? {}) },
      };
    } else {
      out.push(m);
    }
  }
  return out;
}

function toolSummaryLine(msg: ChatMessage): string {
  const c = msg.content || "";
  const lines = c.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ? lines[0].slice(0, 160) : "";
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== first) {
      last = lines[i]!.slice(0, 160);
      break;
    }
  }

  const exitM = c.match(EXIT_RE);
  const exitCode = exitM ? exitM[1] : "?";

  const paths: string[] = [];
  const pathMatches = c.match(PATH_RE) ?? [];
  for (const p of pathMatches) {
    if (!paths.includes(p) && p.includes(".")) {
      paths.push(p);
    }
    if (paths.length >= 5) break;
  }

  const name = msg.toolName || "tool";
  const parts = [`[${name}]`, `exit=${exitCode}`];
  if (paths.length) parts.push(`files=${paths.join(",")}`);
  const body = first === last ? first : first && last ? `${first} ... ${last}` : first || last;
  return parts.join(" ") + (body ? ` :: ${body}` : "");
}

export function integrityProbe(protectedText: string, kept: ChatMessage[], summaryText: string): boolean {
  const hay = norm(
    kept
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n") + "\n" + summaryText
  );

  let missing = 0;
  for (const line of protectedText.split(/\r?\n/)) {
    const n = norm(line);
    if (n.length < 3) continue;
    if (!hay.includes(n)) {
      missing++;
    }
  }

  if (missing > 0) {
    logger.warn("compaction", `integrity probe: ${missing} protected line(s) missing`);
    return false;
  }
  return true;
}

export class Compactor {
  triggerFrac: number;
  keepRecentTurns: number;
  maxToolResultChars: number;
  forgetTriggerTurns: number;
  forgetTargetTurns: number;
  summarizer?: SummarizerFn;

  constructor(opts: {
    triggerFrac?: number;
    keepRecentTurns?: number;
    maxToolResultChars?: number;
    forgetTriggerTurns?: number;
    forgetTargetTurns?: number;
    summarizer?: SummarizerFn;
  } = {}) {
    this.triggerFrac = opts.triggerFrac ?? 0.72;
    this.keepRecentTurns = Math.max(1, opts.keepRecentTurns ?? 6);
    this.maxToolResultChars = opts.maxToolResultChars ?? 20_000;
    this.forgetTriggerTurns = opts.forgetTriggerTurns ?? 4 * this.keepRecentTurns;
    this.forgetTargetTurns = opts.forgetTargetTurns ?? 2 * this.keepRecentTurns;
    this.summarizer = opts.summarizer;
  }

  t0TruncateStaleToolOutputs(messages: ChatMessage[]): { messages: ChatMessage[]; changed: number } {
    const keep = this.keepRecentTurns;
    const turns = splitTurns(messages);
    const nOld = Math.max(0, turns.length - keep);
    const staleIdx = new Set<number>();
    for (let i = 0; i < nOld; i++) {
      for (const idx of turns[i]!) staleIdx.add(idx);
    }

    const out: ChatMessage[] = [];
    let changed = 0;
    const hardCap = this.maxToolResultChars;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (isToolResult(m) && staleIdx.has(i) && m.content.length > TOOL_STALE_MIN_LEN) {
        out.push({
          ...m,
          content: truncateMiddle(m.content, TOOL_TRUNC_HEAD, TOOL_TRUNC_TAIL),
          meta: { ...(m.meta ?? {}), truncated: true },
        });
        changed++;
      } else if (isToolResult(m) && m.content.length > hardCap) {
        const side = Math.floor((hardCap - 128) / 2);
        out.push({
          ...m,
          content: truncateMiddle(m.content, side, side),
          meta: { ...(m.meta ?? {}), truncated: true },
        });
        changed++;
      } else {
        out.push(m);
      }
    }

    return { messages: out, changed };
  }

  t1SummarizeOldToolResults(messages: ChatMessage[]): {
    messages: ChatMessage[];
    groups: number;
    replaced: number;
  } {
    const keep = this.keepRecentTurns;
    const turns = splitTurns(messages);
    const nOld = Math.max(0, turns.length - keep);
    const staleIdx = new Set<number>();
    for (let i = 0; i < nOld; i++) {
      for (const idx of turns[i]!) staleIdx.add(idx);
    }

    const out: ChatMessage[] = [];
    let groups = 0;
    let replaced = 0;
    const run: ChatMessage[] = [];

    const flush = () => {
      if (!run.length) return;
      const lines = run.map((m) => toolSummaryLine(m));
      const counted: Array<{ line: string; count: number }> = [];

      for (const l of lines) {
        if (counted.length && counted[counted.length - 1]!.line === l) {
          counted[counted.length - 1]!.count += 1;
        } else {
          counted.push({ line: l, count: 1 });
        }
      }

      const summaryText =
        `[SUMMARIZED TOOL RESULTS x${run.length}]\n` +
        counted.map((c) => (c.count > 1 ? `• ${c.line} ×${c.count}` : `• ${c.line}`)).join("\n");

      out.push({
        id: crypto.randomUUID(),
        role: "user",
        content: summaryText,
        meta: { compaction: "t1_tool_results" },
        at: Date.now(),
      });

      groups += 1;
      replaced += run.length;
      run.length = 0;
    };

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (isToolResult(m) && staleIdx.has(i)) {
        run.push(m);
        continue;
      }
      flush();
      out.push(m);
    }
    flush();

    return { messages: mergeAdjacentSameRole(out), groups, replaced };
  }

  failureLessons(oldMessages: ChatMessage[]): string[] {
    const lessons: string[] = [];
    const seen = new Set<string>();

    for (const m of oldMessages) {
      for (const raw of (m.content || "").split(/\r?\n/)) {
        const s = raw.trim();
        if (s && LESSON_RE.test(s) && !seen.has(norm(s))) {
          seen.add(norm(s));
          lessons.push(s.slice(0, 240));
        }
        if (lessons.length >= 15) return lessons;
      }
    }
    return lessons;
  }

  t15AmortizedForget(messages: ChatMessage[]): { messages: ChatMessage[]; dropped: number } {
    const turns = splitTurns(messages);
    if (turns.length <= this.forgetTriggerTurns) {
      return { messages, dropped: 0 };
    }

    const target = this.forgetTargetTurns;
    const forgetN = Math.max(1, turns.length - target);
    const forgetIdx = new Set<number>();
    for (let i = 0; i < forgetN; i++) {
      for (const idx of turns[i]!) forgetIdx.add(idx);
    }

    const keyI = firstUserIndex(messages);
    if (keyI !== null) forgetIdx.delete(keyI); // keystone survives

    const droppedMsgs: ChatMessage[] = [];
    for (const idx of Array.from(forgetIdx).sort((a, b) => a - b)) {
      droppedMsgs.push(messages[idx]!);
    }

    if (!droppedMsgs.length) return { messages, dropped: 0 };

    const lines = [
      `[AMORTIZED FORGET] ${droppedMsgs.length} oldest messages (${forgetN} turns) dropped deterministically — no summary was computed for this range.`,
    ];
    const lessons = this.failureLessons(droppedMsgs).slice(0, 8);
    if (lessons.length) {
      lines.push("Failure lessons retained from the dropped range:");
      lines.push(...lessons.map((l) => `- ${l}`));
    }

    const marker: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: lines.join("\n"),
      meta: { compaction: "t15_amortized" },
      at: Date.now(),
    };

    const out: ChatMessage[] = [];
    let inserted = false;

    for (let i = 0; i < messages.length; i++) {
      if (forgetIdx.has(i)) {
        if (!inserted) {
          out.push(marker);
          inserted = true;
        }
        continue;
      }
      out.push(messages[i]!);
    }

    return { messages: mergeAdjacentSameRole(out), dropped: droppedMsgs.length };
  }

  transcript(oldMessages: ChatMessage[]): string {
    const picked: string[] = [];
    let total = 0;

    for (let i = oldMessages.length - 1; i >= 0; i--) {
      const m = oldMessages[i]!;
      const body = (m.content || "").slice(0, TRANSCRIPT_MSG_CAP);
      const line = `${m.role}: ${body}`;
      if (total + line.length > TRANSCRIPT_TOTAL_CAP && picked.length > 0) {
        break;
      }
      picked.push(line);
      total += line.length;
    }

    return picked.reverse().join("\n");
  }

  pinnedLabels(messages: ChatMessage[]): string[] {
    const sysText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const matches = sysText.match(/<<<PINNED:(.+?)>>>/g) ?? [];
    return matches.map((m) => m.replace(/^<<<PINNED:/, "").replace(/>>>$/, "").trim());
  }

  t2Prompt(protectedText: string, labels: string[], oldMessages: ChatMessage[]): string {
    const labelLine = labels.length ? labels.join(", ") : "(none)";
    return [
      "You are compacting the history of a coding agent session.",
      "Output PLAIN TEXT only. FIRST reproduce the PROTECTED BLOCK below",
      "VERBATIM including its <<< >>> fence lines — rules and preferences",
      "must never be paraphrased or dropped. THEN summarize the older turns:",
      "goal progress, files touched, commands tried, outcomes, open threads.",
      "Keep the whole answer under 400 words after the protected block.\n",
      `${PROTECTED_BEGIN}\n${protectedText}\n${PROTECTED_END}\n`,
      `Pinned context labels that MUST stay known: ${labelLine}\n`,
      "--- OLDER TURNS TRANSCRIPT ---",
      this.transcript(oldMessages),
    ].join("\n");
  }

  async t2RollingSummary(
    messages: ChatMessage[],
    summarizerFn: SummarizerFn
  ): Promise<{ messages: ChatMessage[]; report: CompactionReport }> {
    const keep = this.keepRecentTurns;
    const protectedText = extractProtected(messages);
    const labels = this.pinnedLabels(messages);
    const sysMsgs = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const turns = splitTurns(rest);

    if (turns.length <= keep) {
      return {
        messages,
        report: {
          tier: "T2",
          tokensBefore: estimateMessages(messages),
          tokensAfter: estimateMessages(messages),
          dropped: 0,
          summarized: 0,
          preservedProtected: true,
          notes: ["no old turns to summarize"],
        },
      };
    }

    const oldFlat: ChatMessage[] = [];
    const keystone: ChatMessage[] = [];
    const keyI = firstUserIndex(rest);

    const oldTurns = turns.slice(0, turns.length - keep);
    for (const turn of oldTurns) {
      for (const idx of turn) {
        if (keyI !== null && idx === keyI) {
          keystone.push(rest[idx]!);
          continue;
        }
        oldFlat.push(rest[idx]!);
      }
    }

    const keptFlat: ChatMessage[] = [];
    for (const turn of turns.slice(turns.length - keep)) {
      for (const idx of turn) keptFlat.push(rest[idx]!);
    }

    const prompt = this.t2Prompt(protectedText, labels, oldFlat);
    let summaryOut = "";
    try {
      summaryOut = await summarizerFn(prompt);
    } catch (err) {
      logger.warn("compaction", `summarizer call failed: ${err}`);
      throw err;
    }

    const lessons = this.failureLessons(oldFlat);
    const sections = [
      "[COMPACTED HISTORY SUMMARY]",
      `Pinned labels: ${labels.length ? labels.join(", ") : "(none)"}`,
    ];
    if (lessons.length) {
      sections.push("Lessons (deterministic extraction from old turns):");
      sections.push(...lessons.map((l) => `- ${l}`));
    }
    sections.push("Summary of older turns:");
    sections.push(summaryOut.trim());

    const summaryMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: sections.join("\n"),
      meta: { compaction: "t2_rolling" },
      at: Date.now(),
    };

    const keptForProbe = [...sysMsgs, ...keystone, ...keptFlat];
    const ok = integrityProbe(protectedText, keptForProbe, summaryMsg.content);
    // Chronology fix (engine low): the summary stands in for the OLDER turns,
    // so it must sit BEFORE the recent kept turns — appending it after them put
    // "what happened earlier" after "what just happened", inverting history for
    // the model. System + keystone still lead.
    const out = mergeAdjacentSameRole([...sysMsgs, ...keystone, summaryMsg, ...keptFlat]);

    return {
      messages: out,
      report: {
        tier: "T2",
        tokensBefore: estimateMessages(messages),
        tokensAfter: estimateMessages(out),
        dropped: oldFlat.length,
        summarized: turns.length - keep,
        preservedProtected: ok,
        notes: [
          `T2 summarized ${turns.length - keep} old turns into 1 message (${oldFlat.length} msgs folded); keystone=${keystone.length ? "kept" : "n/a"}; integrity_probe=${ok ? "pass" : "FAIL"}`,
        ],
      },
    };
  }

  t3EmergencyRebuild(
    messages: ChatMessage[],
    taskState: Record<string, unknown> = {}
  ): { messages: ChatMessage[]; report: CompactionReport } {
    const sysMsgs = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const turns = splitTurns(rest);
    const lastTurn: ChatMessage[] = turns.length
      ? turns[turns.length - 1]!.map((idx) => rest[idx]!)
      : [];

    const keyI = firstUserIndex(rest);
    const keystone: ChatMessage[] = [];
    if (keyI !== null && (!turns.length || !turns[turns.length - 1]!.includes(keyI))) {
      keystone.push(rest[keyI]!);
    }

    // B29 guard: an empty task state used to emit "Goal: (unknown goal)" — a
    // confident-looking lie the model then treated as the real objective. Only
    // emit a Goal line when there IS one (callers pass task.goal); otherwise
    // fall back to the keystone user turn, which carries the original ask.
    const goal = taskState["goal"];
    const lines = ["[CONTEXT REBUILT — EMERGENCY COMPACTION]"];
    if (typeof goal === "string" && goal.trim()) {
      lines.push(`Goal: ${goal}`);
    } else if (keystone.length > 0 && keystone[0]!.content.trim()) {
      lines.push(`Goal: ${keystone[0]!.content.trim().slice(0, 400)}`);
    }

    const artifacts = taskState["artifacts"];
    if (Array.isArray(artifacts) && artifacts.length) {
      lines.push("Artifacts:");
      lines.push(...artifacts.slice(0, 25).map((a) => `- ${a}`));
    }

    const nextAction = taskState["next_action"];
    if (nextAction) {
      lines.push(`Next action: ${nextAction}`);
    }

    for (const [k, v] of Object.entries(taskState)) {
      if (["goal", "artifacts", "next_action"].includes(k)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        lines.push(`${k}: ${v}`);
      } else if (Array.isArray(v) && v.length) {
        lines.push(`${k}:`);
        lines.push(...v.slice(0, 25).map((item) => `- ${item}`));
      }
    }

    const rebuildMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: lines.join("\n"),
      meta: { compaction: "t3_rebuild" },
      at: Date.now(),
    };

    const out = mergeAdjacentSameRole([
      ...sysMsgs,
      ...keystone,
      ...lastTurn,
      ...(turns.length ? [rebuildMsg] : []),
    ]);
    const dropped = Math.max(0, rest.length - lastTurn.length - keystone.length);

    return {
      messages: out,
      report: {
        tier: "T3",
        tokensBefore: estimateMessages(messages),
        tokensAfter: estimateMessages(out),
        dropped,
        summarized: 0,
        preservedProtected: true,
        notes: [
          `T3 rebuilt: kept ${sysMsgs.length} system${keystone.length ? " +keystone" : ""} + last turn (${lastTurn.length} msgs) + state manifest`,
        ],
      },
    };
  }

  async maybeCompact(
    messages: ChatMessage[],
    modelCtx = 128_000,
    incomingSize = 0,
    summarizerFn?: SummarizerFn,
    taskState?: Record<string, unknown>
  ): Promise<{ messages: ChatMessage[]; report: CompactionReport | null }> {
    const effectiveCtx = getEffectiveContextWindow(modelCtx);
    const estBefore = estimateMessages(messages);
    const target = this.triggerFrac * effectiveCtx;
    // Guard: NaN/Infinity/negative incomingSize poisoned `projected` (NaN makes
    // every <= comparison false) and false-triggered compaction on every call.
    const incoming = Number.isFinite(incomingSize) && incomingSize > 0 ? incomingSize : 0;
    const projected = estBefore + incoming;

    if (projected <= target && incoming <= 0.25 * effectiveCtx) {
      return { messages, report: null };
    }

    logger.info("compaction", "compaction triggered", {
      estBefore,
      incomingSize: incoming,
      target,
      effectiveCtx,
    });

    const summ = summarizerFn || this.summarizer;
    let working = [...messages];
    const notes: string[] = [];
    let droppedTotal = 0;
    let summarizedTotal = 0;
    const applied: string[] = [];
    let preserved = true;

    const fits = () => estimateMessages(working) + incoming <= target;

    const tiers = ["T0", "T1", "T2", "T3"];
    let idx = 0;

    while (idx < tiers.length) {
      if (fits()) break;
      const tier = tiers[idx];

      if (tier === "T0") {
        const { messages: nextMsgs, changed } = this.t0TruncateStaleToolOutputs(working);
        working = nextMsgs;
        const saved = estBefore - estimateMessages(working);
        applied.push("T0");
        notes.push(`T0 truncated ${changed} stale tool outputs (~${saved} tok freed)`);
        idx++;
      } else if (tier === "T1") {
        const { messages: nextMsgs, groups, replaced } = this.t1SummarizeOldToolResults(working);
        working = nextMsgs;
        droppedTotal += replaced;
        summarizedTotal += groups;
        applied.push("T1");
        notes.push(`T1 folded ${replaced} tool msgs into ${groups} summary lines`);
        idx++;
      } else if (tier === "T2") {
        if (!summ) {
          // Degrade to T1.5 amortized forgetting
          const { messages: nextMsgs, dropped } = this.t15AmortizedForget(working);
          if (dropped > 0) {
            working = nextMsgs;
            droppedTotal += dropped;
            applied.push("T1.5");
            notes.push(`T1.5 amortized forgetting dropped ${dropped} msgs`);
            continue; // Re-check fits()
          }
          notes.push("T2 unavailable (no summarizer) -> escalating to T3");
          idx++;
          continue;
        }

        try {
          const { messages: nextMsgs, report } = await this.t2RollingSummary(working, summ);
          if (report.preservedProtected) {
            working = nextMsgs;
            applied.push("T2");
            summarizedTotal += report.summarized;
            droppedTotal += report.dropped;
            notes.push(...report.notes);
            idx++;
          } else {
            notes.push("integrity probe FAILED after T2 -> falling back to T3 rebuild");
            idx++;
          }
        } catch {
          notes.push("T2 failed -> falling back to T3");
          idx++;
        }
      } else {
        // T3
        const { messages: nextMsgs, report } = this.t3EmergencyRebuild(working, taskState);
        working = nextMsgs;
        applied.push("T3");
        droppedTotal += report.dropped;
        notes.push(...report.notes);
        idx = tiers.length;
      }
    }

    const finalReport: CompactionReport = {
      tier: (applied[applied.length - 1] as CompactionReport["tier"]) || "none",
      tokensBefore: estBefore,
      tokensAfter: estimateMessages(working),
      dropped: droppedTotal,
      summarized: summarizedTotal,
      preservedProtected: preserved,
      notes,
    };

    return { messages: working, report: finalReport };
  }
}
