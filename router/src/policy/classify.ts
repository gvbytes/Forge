/**
 * Complexity classifier — pure function, no I/O.
 *
 * Signal weight table (cheap -> expensive):
 * | signal          | condition                                   | weight |
 * |-----------------|---------------------------------------------|--------|
 * | length          | USER-message chars > 4000 (system excluded)  | +1     |
 * | fileMentions    | >2 file mentions in last user message       | +1     |
 * | hardKeywords    | any of refactor/architecture/migrat/        | +2     |
 * |                 | concurren/race/optimi[sz]e/security         |        |
 * | toolAvailability| body.tools present && tools.length > 8      | +1     |
 * | repoMapSize     | ctx.repoMapTokens > 40000                   | +1     |
 * | historyFailures | ctx.historyFailures >= 1                    | escalate flag
 *
 * Mapping: score <= 1 -> S · 2–3 -> M · >= 4 -> L.
 * `escalate` bumps the mapped tier one step (S->M, M->L).
 * L is reserved: classification alone never grants it to coder-class roles
 * (capped to M here). NOTE: verified-failure cascade escalation MAY
 * still carry a coder to L — that cap lives in the router/cascade, not here.
 * Every decision lands in `reasons[]` so the router can log the route reason.
 */
import type { ChatCompletionBody, Complexity, SessionCtx, Tier } from "./types";
import { TIERS, L_ROLES } from "./types";

export const LENGTH_THRESHOLD_CHARS = 4000;
export const FILE_MENTION_THRESHOLD = 2; // strictly greater than
export const HARD_KEYWORD_WEIGHT = 2;
export const TOOLS_THRESHOLD = 8; // strictly greater than
export const REPO_MAP_THRESHOLD_TOKENS = 40000;

/**
 * Flatten a message's content into plain text. OpenAI-compatible bodies may
 * send content either as a string or as an array of typed parts — usually
 * `{type:"text", text:"…"}` items (vision/tool parts ride along).
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item !== null && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          return typeof rec["text"] === "string" ? rec["text"] : JSON.stringify(item);
        }
        return String(item ?? "");
      })
      .join("\n");
  }
  return content === null || content === undefined ? "" : String(content);
}

/**
 * File-mention heuristic: @path mentions OR any token shaped like path.ext
 * (1–8 letter extension). Deduplicated case-insensitively so repeated
 * mentions of the same file count once.
 */
const FILE_MENTION_RE =
  /@[\w.-]+(?:\/[\w.-]+)*|[\w./\\-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;

/**
 * Hard keywords carry a left word-boundary so "race" does not fire inside
 * "trace"/"grace"; suffixes stay open (\w*) so "migration", "concurrency",
 * "optimizing" still match their keyword stems.
 */
const HARD_KEYWORD_RE =
  /\b(refactor\w*|architecture|migrat\w*|concurren\w*|race|optimi[sz]e\w*|security)\b/i;

/**
 * Substantial-creation signal: a from-scratch build of a real artifact
 * ("make a 3d flappy bird game", "build a dashboard", "create a website").
 * These short prompts otherwise score 0 -> tier S, and a tiny model cannot
 * plan/implement a multi-file artifact (it emits prose instead of the planner
 * JSON). Requires BOTH a creation verb AND an artifact noun so plain questions
 * and small edits don't fire it.
 */
export const CREATION_VERB_RE =
  /\b(make|build|create|generate|develop|scaffold)\b/i;
export const CREATION_ARTIFACT_RE =
  /\b(games?|apps?|applications?|websites?|webpages?|sites?|apis?|dashboards?|clones?|platforms?|blogs?|portfolios?)\b/i;
export const CREATION_WEIGHT = 2;

/** Count distinct file-like mentions in one message's text. */
export function countFileMentions(text: string): number {
  if (!text) return 0;
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_MENTION_RE)) {
    seen.add(match[0].toLowerCase());
  }
  return seen.size;
}

/** First hard keyword found in `text`, or null. */
export function firstHardKeyword(text: string): string | null {
  const m = HARD_KEYWORD_RE.exec(text);
  return m?.[1] ?? null;
}

export function classify(
  body: ChatCompletionBody,
  ctx: SessionCtx,
): Complexity {
  const reasons: string[] = [];
  let score = 0;

  // 1. Prompt length: USER messages only — system scaffolding
  // (AGENTS.md reinjection, tool schemas, repo context) is excluded.
  const messages = body.messages ?? [];
  const userChars = messages.reduce(
    (n, m) => (m.role === "user" ? n + contentText(m.content).length : n),
    0,
  );
  if (userChars > LENGTH_THRESHOLD_CHARS) {
    score += 1;
    reasons.push(`user prompt ${userChars}ch > ${LENGTH_THRESHOLD_CHARS} (+1)`);
  }

  // 2. File mentions in the last user message.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const mentions = countFileMentions(contentText(lastUser?.content));
  if (mentions > FILE_MENTION_THRESHOLD) {
    score += 1;
    reasons.push(`${mentions} file mentions > ${FILE_MENTION_THRESHOLD} (+1)`);
  }

  // 3. Hard keywords anywhere in the conversation.
  const allText = messages.map((m) => contentText(m.content)).join("\n");
  const keyword = firstHardKeyword(allText);
  if (keyword) {
    score += HARD_KEYWORD_WEIGHT;
    reasons.push(`hard keyword "${keyword}" (+${HARD_KEYWORD_WEIGHT})`);
  }

  // 3b. Substantial creation task: "make/build/create a game/app/website/…".
  // A from-scratch artifact is multi-file work even when the prompt is short,
  // so it must not land on tier S (a tiny model can't plan it). Requires both
  // a creation verb and an artifact noun.
  if (CREATION_VERB_RE.test(allText) && CREATION_ARTIFACT_RE.test(allText)) {
    score += CREATION_WEIGHT;
    reasons.push(`substantial creation task (verb + artifact) (+${CREATION_WEIGHT})`);
  }

  // 4. Tool availability.
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  if (toolCount > TOOLS_THRESHOLD) {
    score += 1;
    reasons.push(`${toolCount} tools > ${TOOLS_THRESHOLD} (+1)`);
  }

  // 5. Repo map size.
  const repoMapTokens = ctx.repoMapTokens ?? 0;
  if (repoMapTokens > REPO_MAP_THRESHOLD_TOKENS) {
    score += 1;
    reasons.push(
      `repoMap ${repoMapTokens}tok > ${REPO_MAP_THRESHOLD_TOKENS} (+1)`,
    );
  }

  // Escalate flag from session history (not part of the additive score).
  const historyFailures = ctx.historyFailures ?? 0;
  const escalate = historyFailures >= 1;
  if (escalate) {
    reasons.push(`historyFailures=${historyFailures} => escalate one tier`);
  }

  // Mapping with escalation bump, then role cap on L.
  const role = ctx.role ?? "coder";
  const baseIdx = score <= 1 ? 0 : score <= 3 ? 1 : 2;
  const idx = Math.min(baseIdx + (escalate ? 1 : 0), TIERS.length - 1);
  let tier: Tier = TIERS[idx]!;
  reasons.push(
    `score ${score} -> base ${TIERS[baseIdx]!}${escalate && baseIdx < idx ? " escalated" : ""}`,
  );
  if (tier === "L" && !L_ROLES.has(role)) {
    tier = "M";
    reasons.push(`L reserved for planner/diagnostician; role "${role}" capped to M`);
  }

  return { score, tier, escalate, reasons };
}
