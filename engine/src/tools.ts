// Tool implementations for the Native TypeScript Engine.
// Every path-touching tool is jailed to the project root; every side-effect
// tool goes through the approval gate (approvals.ts) unless the orchestrator
// explicitly auto-approves it. Deps: node builtins + `diff` only.
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { ApprovalRequest, ChangeProposal, FileDiff } from "./types.js";
import { loadSettings, NON_INTERACTIVE_ENV } from "./config.js";
import { extractFileSymbols } from "./repomap.js";
import { echoAgentActivity } from "./terminal.js";
import { searchWeb, scrapeWeb } from "./websearch.js";
import { trace } from "./trace.js";
import { awaitDecision, createApproval, APPROVAL_TIMEOUT_MS } from "./approvals.js";
import { putProposal, updateProposal, noteGatedAppliedPaths } from "./proposals.js";
import { applyProposalPartial, buildFileDiff } from "./apply.js";
import { wire } from "./bus.js";
import { log } from "./logger.js";
import { retrieve } from "./retrieval.js";

// ── Public contracts ──────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  argsSchema: Record<string, "string" | "number" | "boolean">;
  sideEffect: boolean;
}

/**
 * TOOL_SPECS rendered as OpenAI function schemas, for models that are trained
 * on native tool calling.
 *
 * Why both protocols exist: this engine's text protocol (`TOOL_CALL: {...}`)
 * was chosen because sub-80B models emit malformed JSON in a native envelope.
 * That reasoning holds for many models — but NOT for tool-trained ones. Groq's
 * gpt-oss-20b in particular is trained to emit native calls, and when handed
 * the text protocol it tries to call a tool anyway; with no `tools` array
 * declared the provider rejects the whole request with
 *   "Tool choice is none, but model called a tool"
 * and the reply comes back with an empty `content`. That is the failure that
 * made every coder step return prose instead of a tool call.
 *
 * So: declare the tools natively, accept native calls when they come back, and
 * keep the text protocol as the fallback for models that do not emit them.
 */
export function toolSchemasForApi(allowed?: Set<string>): unknown[] {
  const jsonType = (t: "string" | "number" | "boolean"): string =>
    t === "number" ? "number" : t === "boolean" ? "boolean" : "string";
  return TOOL_SPECS.filter((t) => !allowed || allowed.has(t.name)).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.argsSchema).map(([k, v]) => [k, { type: jsonType(v) }]),
        ),
        // Every declared arg is required only where the handler truly needs it;
        // the handlers validate anyway, and over-requiring makes models refuse
        // to call at all. Left empty deliberately.
        required: [],
      },
    },
  }));
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a text file (relative to project root) with line numbers. Files over 400 lines return a SYMBOL MAP (names + line numbers) instead of content — follow it with read_range for the span you need.",
    argsSchema: { path: "string" },
    sideEffect: false,
  },
  {
    name: "read_range",
    description: "Read one file slice by 1-based inclusive line numbers [startLine..endLine].",
    argsSchema: { path: "string", startLine: "number", endLine: "number" },
    sideEffect: false,
  },
  {
    name: "list_dir",
    description: "Tree-style directory listing, ≤200 entries. Optional depth (default 2).",
    argsSchema: { path: "string", depth: "number" },
    sideEffect: false,
  },
  {
    name: "grep",
    description:
      "Regex search over the workspace (skips node_modules/.git/binaries). Returns 'path:line: text' lines.",
    argsSchema: { pattern: "string", path: "string", maxResults: "number" },
    sideEffect: false,
  },
  {
    name: "glob",
    description: "Find files by glob pattern; supports **, *, ? (e.g. 'src/**/*.ts').",
    argsSchema: { pattern: "string" },
    sideEffect: false,
  },
  {
    name: "write_file",
    description:
      "CREATE a new file with content (parent dirs auto-created). Do NOT use this to modify an existing file — use edit_file. Rewriting a file whose content is mostly unchanged is refused.",
    argsSchema: { path: "string", content: "string" },
    sideEffect: true,
  },
  {
    name: "edit_file",
    description:
      "Exact-match replace inside a file. Errors when oldText is absent or ambiguous without replaceAll:true.",
    argsSchema: { path: "string", oldText: "string", newText: "string", replaceAll: "boolean" },
    sideEffect: true,
  },
  {
    name: "run_command",
    description:
      "Run a shell command via bash -c inside the project. Timeout default 30s (cap 120s). Dangerous commands are blocked.",
    argsSchema: { command: "string", cwd: "string", timeoutMs: "number" },
    sideEffect: true,
  },
  {
    name: "git_status",
    description: "Short git status of the project (branch + porcelain entries).",
    argsSchema: {},
    sideEffect: false,
  },
  {
    name: "git_diff",
    description: "Unified diff of all uncommitted changes vs HEAD.",
    argsSchema: {},
    sideEffect: false,
  },
  {
    name: "git_commit",
    description: "Stage every change (git add -A) and commit with the given message.",
    argsSchema: { message: "string" },
    sideEffect: true,
  },
  {
    name: "git_branch",
    description: "Create and switch to a new git branch, optionally from a start point.",
    argsSchema: { name: "string", from: "string" },
    sideEffect: true,
  },
  {
    name: "git_merge",
    description: "Merge a branch into the current working branch with --no-edit.",
    argsSchema: { branch: "string" },
    sideEffect: true,
  },
  {
    name: "web_search",
    description: "Web search via DuckDuckGo HTML; returns top results with title, URL and snippet.",
    argsSchema: { query: "string" },
    sideEffect: false,
  },
  {
    name: "web_extract",
    description: "Extract readable Markdown content and links from a URL (Hermes Agent style).",
    argsSchema: { url: "string", maxChars: "number" },
    sideEffect: false,
  },
  {
    name: "web_scrape",
    description:
      "Fetch ONE URL and return its readable text content (scripts/styles stripped). Use to read a specific page — docs, an issue, a reference — to gather context before working. Not a search engine.",
    argsSchema: { url: "string", maxChars: "number" },
    sideEffect: false,
  },
  {
    name: "delegate",
    description: "Delegate a focused subtask to a specialized agent role (e.g. coder, explorer, reviewer).",
    argsSchema: { role: "string", goal: "string", instructions: "string" },
    sideEffect: false,
  },
  {
    name: "finish",
    description: "Declare the task complete with a final summary and evidence of verification.",
    argsSchema: { summary: "string" },
    sideEffect: false,
  },
  {
    name: "retrieve_code",
    description: "Semantic search and code retrieval across project files for symbols, patterns, or logic.",
    argsSchema: { query: "string", k: "number" },
    sideEffect: false,
  },
];

export interface ExecuteToolInput {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  name: string;
  args: Record<string, unknown>;
  /** orchestrator passes true ONLY for non-side-effect tools */
  autoApprove?: boolean;
  /** abort-awareness for the approval wait (Stop during a pending approval
   *  must unwind the task instead of parking up to APPROVAL_TIMEOUT_MS) */
  signal?: AbortSignal;
  /** Coder span the call belongs to (r4-tasks #5): without it tool.call/
   *  tool.result/approval traces rendered as unparented dashboard roots. */
  parentSpan?: string;
}

export interface ExecuteToolResult {
  ok: boolean;
  result: string;
  approvalId?: string;
  needsApproval?: boolean;
  /** Milliseconds spent WAITING on the human approval decision (excluding the
   *  tool's own execution). The orchestrator refunds exactly this much of the
   *  wall-clock deadline (engine low item: the old full-elapsed refund also
   *  refunded post-approval execution time — over-refund). */
  approvalWaitMs?: number;
}

// ── Constants / small helpers ─────────────────────────────────────────────

const READ_CAP = 40_000;

/**
 * Whole-file-rewrite guard (large-codebase safety).
 *
 * `write_file` replaces a file's ENTIRE contents. On a small file that is
 * harmless; on a real codebase it is the single most expensive and most
 * destructive thing an agent can do:
 *
 *   - Cost. Reading a 2,000-line file (~25k tokens) and writing it back
 *     (~25k tokens) spends ~50k tokens to change three lines. Under the
 *     scoring formula that is most of a task's budget for one edit.
 *   - Correctness. The model must reproduce every line it is NOT changing,
 *     from memory, inside one completion. Anything it silently drops or
 *     paraphrases is deleted from the file — and a reviewer reading a diff of
 *     "whole file replaced" cannot tell an intentional change from an omission.
 *
 * So a rewrite that is mostly a copy of what is already on disk is refused and
 * redirected to `edit_file`. The threshold is deliberately generous: genuine
 * rewrites (a real refactor, a regenerated file) share few lines with the
 * original and still go through.
 */
const REWRITE_GUARD_MIN_LINES = 60;      // below this a rewrite is cheap — allow
const REWRITE_GUARD_SIMILARITY = 0.5;    // >50% of old lines retained = an edit

/** Fraction of `before` lines that survive verbatim in `after`. */
export function retainedLineFraction(before: string, after: string): number {
  const beforeLines = before.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (beforeLines.length === 0) return 0;
  // Multiset intersection: a line repeated N times in `before` only counts as
  // retained as many times as it actually appears in `after`.
  const pool = new Map<string, number>();
  for (const l of after.split(/\r?\n/).map((x) => x.trim())) {
    if (l.length > 0) pool.set(l, (pool.get(l) ?? 0) + 1);
  }
  let kept = 0;
  for (const l of beforeLines) {
    const n = pool.get(l) ?? 0;
    if (n > 0) { kept++; pool.set(l, n - 1); }
  }
  return kept / beforeLines.length;
}

/** Null when the write is allowed; otherwise the refusal message. */
export function rewriteGuardVerdict(before: string | null, after: string): string | null {
  if (before === null) return null; // new file — nothing to preserve
  const beforeLines = before.split(/\r?\n/).length;
  if (beforeLines < REWRITE_GUARD_MIN_LINES) return null;
  const retained = retainedLineFraction(before, after);
  if (retained <= REWRITE_GUARD_SIMILARITY) return null; // a real rewrite
  const pct = Math.round(retained * 100);
  return (
    `write_file refused: this rewrites all ${beforeLines} lines of an existing file, but ${pct}% of them are unchanged — ` +
    `that is an edit, not a rewrite. Reproducing untouched code from memory risks silently dropping it, and costs ~${Math.round((before.length + after.length) / 3.5)} tokens. ` +
    `Use edit_file with oldText/newText for just the lines this step changes. ` +
    `If you genuinely must replace the whole file, say so in FINAL and the human can do it.`
  );
}
const GREP_CAP = 50;
const GREP_FILE_CAP = 5_000;
const GREP_FILE_MAX_BYTES = 2_000_000;
const LISTING_CAP = 200;
const GLOB_CAP = 200;
const OUT_CAP = 20_000;
const DIFF_PREVIEW_CAP = 4_000;
const TRACE_RESULT_CAP = 2_000;
const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const MAX_CMD_TIMEOUT_MS = 120_000;
// Single source of truth lives in approvals.ts. Was a local 300s — shorter
// than the time it took a human to reload the page and find the dock gone,
// guaranteeing unseen auto-denies.
const APPROVAL_TIMEOUT = APPROVAL_TIMEOUT_MS;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".cache", ".turbo", ".parcel-cache", "__pycache__",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wav", ".flac", ".ogg",
  ".wasm", ".node", ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".jar",
  ".sqlite", ".sqlite3", ".db", ".pyc", ".o", ".a", ".lib",
]);

class ToolError extends Error {}
function fail(msg: string): never {
  throw new ToolError(msg);
}
function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (+${s.length - max} chars truncated)`;
}

function spanId(): string {
  return randomUUID().slice(0, 8);
}

/** Jail any user/model-supplied path inside projectRoot. Absolute paths are
 *  allowed only when they already resolve inside the root. */
function resolveInRoot(projectRoot: string, p: string): string {
  if (!p || p.includes("\0")) fail(`invalid path: ${JSON.stringify(p)}`);
  const rootAbs = path.resolve(projectRoot);
  let normalized = p.trim();
  if (normalized === "/" || normalized === "/workspace" || normalized === "workspace" || normalized === ".") {
    return rootAbs;
  }
  if (normalized.startsWith("/workspace/")) {
    normalized = normalized.slice("/workspace/".length);
  }
  const target = normalized.startsWith(rootAbs)
    ? path.resolve(normalized)
    : path.resolve(rootAbs, normalized.replace(/^\/+/, ""));
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    fail(`path outside workspace: ${p}`);
  }
  return target;
}

/** B27: resolveInRoot is lexical only — a symlink INSIDE the project can point
 *  at /etc, $HOME, or anywhere else. realpath the deepest existing ancestor of
 *  the target (the target itself when it exists) and re-check containment.
 *  Refuses escapes; returns the resolved real path for callers that want it. */
async function assertRealInRoot(projectRoot: string, abs: string): Promise<string> {
  const rootReal = await fs.promises.realpath(path.resolve(projectRoot)).catch(() => path.resolve(projectRoot));
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = await fs.promises.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Not there yet (new file): climb to the deepest existing ancestor.
        const parent = path.dirname(probe);
        if (parent === probe) fail(`path outside workspace: ${abs}`);
        probe = parent;
        continue;
      }
      throw err;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      fail(`path escapes workspace via symlink: ${path.relative(path.resolve(projectRoot), abs) || abs} → ${real}`);
    }
    return real;
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8_000).includes(0);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v == null) fail(`missing required argument "${key}"`);
  return String(v);
}
function optStr(args: Record<string, unknown>, key: string, def: string): string {
  const v = args[key];
  return typeof v === "string" ? v : def;
}
function optNum(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return def;
}
function optBool(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key];
  return typeof v === "boolean" ? v : def;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── Filesystem walker (shared by grep/glob) ───────────────────────────────

interface FoundFile {
  abs: string;
  rel: string;
}

async function collectFiles(
  projectRoot: string,
  relBase: string,
  cap: number,
): Promise<{ files: FoundFile[]; capped: boolean }> {
  const rootAbs = path.resolve(projectRoot);
  const baseAbs = resolveInRoot(projectRoot, relBase);
  const files: FoundFile[] = [];
  let capped = false;

  // Skip well-known heavy/vendored dirs UNLESS the caller explicitly aimed
  // the walk at them (base equals or lives inside that directory).
  const aimedAt = (rel: string): boolean => relBase !== "." && (rel === relBase || relBase.startsWith(`${rel}/`));

  const stack: { abs: string; rel: string }[] = [{ abs: baseAbs, rel: relBase }];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip silently
    }
    const sorted = [...dirents].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of sorted) {
      const childAbs = path.join(dir.abs, d.name);
      const childRel = dir.rel === "." ? d.name : `${dir.rel}/${d.name}`;
      if (d.isSymbolicLink()) continue; // no symlink loops / escapes
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) && !aimedAt(childRel)) continue;
        stack.push({ abs: childAbs, rel: childRel });
      } else if (d.isFile()) {
        if (files.length >= cap) {
          capped = true;
          stack.length = 0;
          break;
        }
        files.push({ abs: childAbs, rel: childRel });
      }
    }
  }
  void rootAbs;
  return { files, capped };
}

// ── Command runner (shared by run_command + git_* wrappers) ───────────────

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// Whitelist approach guarantees API keys / tokens never reach child processes.
const SAFE_ENV_KEYS = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR"];
function scrubEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // Defence in depth: stdout here is a pipe, so git already disables its pager,
  // but the credential prompt and $EDITOR fallbacks do NOT depend on a TTY and
  // would still hang the tool until its timeout fires.
  return { ...env, ...NON_INTERACTIVE_ENV };
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    // B30: detached:true puts the child in its own process group so a timeout
    // can kill the WHOLE group (`bash -c` spawns grandchildren that a plain
    // child.kill leaves orphaned — `sleep 1000 &` outlived every step).
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: scrubEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let err = "";
    let timedOut = false;
    // bound memory even if the child spews output
    const RAW_CAP = 400_000;
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < RAW_CAP) out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < RAW_CAP) err += c.toString("utf8");
    });
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      resolve({
        code,
        stdout: out.slice(0, RAW_CAP),
        stderr: err.slice(0, RAW_CAP),
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the entire process group first; fall back to the direct child.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      finish(null);
    }, opts.timeoutMs);
    child.on("error", (e) => {
      err += String(e.message ?? e);
      finish(null);
    });
    child.on("exit", (code) => finish(code));
    child.on("close", (code) => finish(code));
  });
}

function composeShellResult(command: string, r: RunOutcome): string {
  const parts: string[] = [];
  parts.push(`$ ${command}`);
  parts.push(
    r.timedOut
      ? `exit: killed after timeout (${r.durationMs}ms)`
      : `exit: ${r.code ?? "unknown"} (${r.durationMs}ms)`,
  );
  const so = r.stdout.trim();
  const se = r.stderr.trim();
  const fixedBudget = OUT_CAP - parts.join("\n").length - 40;
  const outBudget = Math.max(1_000, Math.floor(fixedBudget * 0.6));
  const errBudget = Math.max(500, fixedBudget - outBudget);
  if (so) parts.push(`── stdout ──\n${clip(so, outBudget)}`);
  if (se) parts.push(`── stderr ──\n${clip(se, errBudget)}`);
  return clip(parts.join("\n"), OUT_CAP);
}

// ── Catastrophic-command guard ────────────────────────────────────────────

function catastrophicReason(cmd: string): string | null {
  const rules: [RegExp, string][] = [
    [/\bmkfs(\.\w+)?\b/i, "formats a filesystem"],
    [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|disk|mapper)/i, "raw-writes a block device"],
    [/>\s*\/dev\/(sd|nvme|hd)/i, "overwrites a raw device"],
    [/\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
    [/\b(shutdown|reboot|halt|poweroff)\b|\binit\s+0\b/i, "shuts the machine down"],
    [
      /\b(chmod|chown)\b[^|;&]*\s(--recursive|-R)\b[^|;&]*\s+\/(\s|$)/i,
      "recursively resets permissions/ownership from filesystem root",
    ],
    [/\bmkswap\b|\bfdisk\b|\bparted\b[^|;&]*\s--script/i, "repartitions a disk"],
    [/\b:\s*>\s*\/dev\/null\s*<\s*\/dev\/sd/i, "device overwrite"],
  ];
  for (const [re, why] of rules) {
    if (re.test(cmd)) return why;
  }
  if (rmRootTarget(cmd)) return "recursive forced delete at filesystem root (~, $HOME, / …)";
  return null;
}

function rmRootTarget(cmd: string): boolean {
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const m = seg.match(/\brm\b(.*)/i);
    if (!m) continue;
    const rest = m[1] ?? "";
    const flagMatches = rest.match(/(?:^|\s)-{1,2}[A-Za-z-]+/g) ?? [];
    const letters = flagMatches.join("").replace(/-{1,2}/g, "");
    const target = rest.replace(/(?:^|\s)-{1,2}[A-Za-z-]+/g, " ").trim().replace(/^["']|["']$/g, "");
    const hasR = /r/i.test(letters) || /--recursive/.test(rest);
    const hasF = /f/i.test(letters) || /--force/.test(rest);
    if (!(hasR && hasF)) continue;
    if (/^(\/|\/\*|~|~\/\*?|\$HOME\/?\*?)\s*$/.test(target)) return true;
    if (/^\/(etc|usr|var|boot|dev|bin|sbin|lib|opt|home|root|proc|sys)(\/|$|\*)/.test(target)) return true;
  }
  return false;
}

// ── Handlers ──────────────────────────────────────────────────────────────

type Handler = (ctx: { projectRoot: string; projectId: string; sessionId: string; args: Record<string, unknown>; signal?: AbortSignal }) => Promise<string>;

async function readTextFile(projectRoot: string, rawPath: string): Promise<{ abs: string; rel: string; text: string; totalLines: number }> {
  const abs = resolveInRoot(projectRoot, rawPath);
  await assertRealInRoot(projectRoot, abs); // B27: symlink escape check
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st) fail(`file not found: ${rawPath}`);
  if (st.isDirectory()) fail(`not a file (use list_dir): ${rawPath}`);
  if (st.size > 8 * 1024 * 1024) fail(`file too large (>8MB): ${rawPath}`);
  const buf = await fs.promises.readFile(abs);
  if (isBinary(buf)) fail(`binary file: ${rawPath}`);
  const text = buf.toString("utf8");
  return { abs, rel: rawPath, text, totalLines: text.split("\n").length };
}

function numberLines(lines: string[], startLine: number, width: number): string {
  return lines
    .map((l, i) => `${String(startLine + i).padStart(width)}| ${l}`)
    .join("\n");
}

/**
 * Above this many lines, read_file returns a STRUCTURAL MAP instead of content.
 *
 * Dumping a large file is the fastest way to destroy a small model's context:
 * a 1,500-line source file is ~20k tokens, which on a 128k-context model is
 * fine arithmetically but ruinous in practice — the step's actual instructions
 * end up buried under code the model does not need, and every subsequent turn
 * in the loop re-sends all of it.
 *
 * An outline (symbols + line numbers) is ~2% of the size and is strictly more
 * useful for deciding WHERE to look. The agent then pulls the one function it
 * needs with read_range. This is the difference between an agent that works on
 * a real repository and one that only works on toy files.
 */
const OUTLINE_THRESHOLD_LINES = 400;
const OUTLINE_HEAD_LINES = 40;

const read_file: Handler = async ({ projectRoot, args }) => {
  const f = await readTextFile(projectRoot, str(args, "path"));
  const width = Math.max(4, String(f.totalLines).length);

  if (f.totalLines > OUTLINE_THRESHOLD_LINES) {
    const symbols = extractFileSymbols(f.rel, f.text);
    const head = numberLines(f.text.split("\n").slice(0, OUTLINE_HEAD_LINES), 1, width);
    const outline = symbols.length
      ? symbols.map((sym) => `  ${String(sym.startLine).padStart(width)}  ${sym.kind} ${sym.name}`).join("\n")
      : "  (no symbols detected — use grep to locate the relevant region)";
    return [
      `${f.rel} · ${f.totalLines} lines — TOO LARGE to read whole; showing a structural map.`,
      "",
      `SYMBOLS (line · kind · name):`,
      outline,
      "",
      `FIRST ${OUTLINE_HEAD_LINES} LINES (imports / header):`,
      head,
      "",
      `Next: call read_range with the line span you actually need (e.g. the symbol above and ~20 lines around it), or grep to find a specific string. Do NOT ask for the whole file.`,
    ].join("\n");
  }

  const clipped = clip(f.text, READ_CAP);
  const body = numberLines(clipped.split("\n"), 1, width);
  const header = `${f.rel} · ${f.totalLines} lines`;
  return clipped.length < f.text.length
    ? `${header}\n${body}\n… truncated at ${READ_CAP} chars — use read_range for the rest`
    : `${header}\n${body}`;
};

const read_range: Handler = async ({ projectRoot, args }) => {
  const rawPath = str(args, "path");
  const f = await readTextFile(projectRoot, rawPath);
  const all = f.text.split("\n");
  const start = clamp(Math.floor(optNum(args, "startLine", NaN)), 1, all.length);
  if (!Number.isFinite(optNum(args, "startLine", NaN))) fail('missing required numeric argument "startLine"');
  const endArg = Math.floor(optNum(args, "endLine", NaN));
  if (!Number.isFinite(endArg)) fail('missing required numeric argument "endLine"');
  if (endArg < start) fail(`endLine (${endArg}) < startLine (${start})`);
  const end = clamp(endArg, start, all.length);
  const sliceLines = all.slice(start - 1, end);
  const width = Math.max(3, String(end).length);
  let body = numberLines(sliceLines, start, width);
  if (body.length > READ_CAP) {
    // trim whole lines under the char cap
    const kept: string[] = [];
    let size = 0;
    for (const l of body.split("\n")) {
      if (size + l.length + 1 > READ_CAP) break;
      kept.push(l);
      size += l.length + 1;
    }
    body = kept.join("\n") + `\n… truncated at ${READ_CAP} chars`;
  }
  return `${rawPath} · lines ${start}–${end} of ${f.totalLines}\n${body}`;
};

const list_dir: Handler = async ({ projectRoot, args }) => {
  const relBase = optStr(args, "path", ".") || ".";
  const depth = clamp(Math.floor(optNum(args, "depth", 2)), 1, 6);
  const baseAbs = resolveInRoot(projectRoot, relBase);
  const st = await fs.promises.stat(baseAbs).catch(() => null);
  if (!st) fail(`directory not found: ${relBase}`);
  if (!st.isDirectory()) fail(`not a directory: ${relBase}`);

  const lines: string[] = [];
  let truncated = false;
  const walk = async (abs: string, rel: string, level: number): Promise<void> => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      lines.push(`${"  ".repeat(level)}(unreadable)`);
      return;
    }
    const sorted = [...dirents].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of sorted) {
      if (lines.length >= LISTING_CAP) {
        truncated = true;
        return;
      }
      if (d.isSymbolicLink()) continue;
      const label = `${"  ".repeat(level)}${d.name}${d.isDirectory() ? "/" : ""}`;
      lines.push(label);
      if (d.isDirectory() && level + 1 < depth && !SKIP_DIRS.has(d.name)) {
        await walk(path.join(abs, d.name), rel === "." ? d.name : `${rel}/${d.name}`, level + 1);
      }
    }
  };
  await walk(baseAbs, relBase, 0);
  const footer = truncated ? "\n… truncated at 200 entries" : "";
  return `${lines.join("\n")}${footer}`;
};

/** Cheap static ReDoS screen for model-supplied regexes. Catastrophic
 *  backtracking needs a quantified group whose body can match the same text
 *  multiple ways — classically a nested quantifier ((a+)+, ([x]*y)*, (\d+){2,}).
 *  We reject the canonical nested-quantifier shapes outright; anything that
 *  slips past still hits the wall-clock budget in the grep loop. */
function rejectReDoS(pattern: string): void {
  // A group containing an inner quantifier, itself quantified: (…+)+, (…*){n,}, …
  // Scan with a small depth tracker instead of one mega-regex (the checker
  // itself must not be ReDoS-able).
  const isQuant = (ch: string | undefined): boolean => ch === "+" || ch === "*" || ch === "{";
  const stack: { start: number; innerQuant: boolean }[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      i++; // escaped char: nothing structural
      continue;
    }
    if (c === "[") {
      // skip character class body
      i++;
      if (pattern[i] === "]" || pattern[i] === "^") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") {
      stack.push({ start: i, innerQuant: false });
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g) continue;
      const groupQuantified = isQuant(pattern[i + 1]);
      if (g.innerQuant && groupQuantified) {
        fail("grep pattern rejected: nested quantifiers risk catastrophic backtracking (ReDoS)");
      }
      // A quantified group also poisons any enclosing group's body.
      if (groupQuantified || g.innerQuant) {
        const parent = stack[stack.length - 1];
        if (parent) parent.innerQuant = true;
      }
      continue;
    }
    if (isQuant(c) && stack.length > 0) {
      stack[stack.length - 1]!.innerQuant = true;
    }
  }
}

const GREP_TIME_BUDGET_MS = 5_000;

const grep: Handler = async ({ projectRoot, args }) => {
  const pattern = str(args, "pattern");
  // Critique #23: model-supplied regex is hostile input — cap length before
  // compilation; compile errors surface as a normal failed tool result.
  if (pattern.length > 500) fail(`regex pattern too long (${pattern.length} chars; cap is 500)`);
  rejectReDoS(pattern);
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    fail(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const relBase = optStr(args, "path", ".") || ".";
  const maxResults = clamp(Math.floor(optNum(args, "maxResults", GREP_CAP)), 1, GREP_CAP);

  const { files } = await collectFiles(projectRoot, relBase, GREP_FILE_CAP);
  const hits: string[] = [];
  let scanned = 0;
  let budgetHit = false;
  const t0 = Date.now();
  outer: for (const f of files) {
    if (hits.length >= maxResults) break;
    if (BINARY_EXT.has(path.extname(f.rel).toLowerCase())) continue;
    const buf = await fs.promises.readFile(f.abs).catch(() => null);
    if (!buf) continue;
    scanned++;
    if (isBinary(buf)) continue;
    if (buf.length > GREP_FILE_MAX_BYTES) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Hard wall-clock budget: a pathological pattern that slips past the
      // static screen must not hang the engine event loop forever.
      if ((i & 63) === 0 && Date.now() - t0 > GREP_TIME_BUDGET_MS) {
        budgetHit = true;
        break outer;
      }
      const line = lines[i];
      if (line === undefined) continue;
      if (re.test(line)) {
        hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
        if (hits.length >= maxResults) break;
      }
    }
  }
  const budgetNote = budgetHit ? ` (stopped early: ${GREP_TIME_BUDGET_MS / 1000}s time budget)` : "";
  if (hits.length === 0) return `no matches for /${pattern}/ in ${relBase} (scanned ${scanned} files)${budgetNote}`;
  return hits.join("\n") + budgetNote;
};

/** Minimal dependency-free glob: ** crosses directories, * within one, ? is a single char. */
function globToRegex(pattern: string): RegExp {
  if (pattern.includes("\0")) fail("invalid glob pattern");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${re}$`);
  } catch (e) {
    fail(`invalid glob: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const glob: Handler = async ({ projectRoot, args }) => {
  const pattern = str(args, "pattern");
  const re = globToRegex(pattern);
  const basenameOnly = !pattern.includes("/");
  const { files, capped } = await collectFiles(projectRoot, ".", GLOB_CAP * 10);
  const matches = files
    .filter((f) => (basenameOnly ? re.test(path.basename(f.rel)) : re.test(f.rel)))
    .map((f) => f.rel)
    .sort((a, b) => a.localeCompare(b));
  if (matches.length === 0) return `no matches for ${pattern}`;
  const shown = matches.slice(0, GLOB_CAP);
  const suffix =
    matches.length > GLOB_CAP ? `\n… ${matches.length - GLOB_CAP} more truncated` : capped ? "\n… (scan truncated)" : "";
  return `${matches.length} match(es):\n${shown.join("\n")}${suffix}`;
};

// edit_file shared core — used by preflight (approval payload) and handler.
async function computeEdit(
  projectRoot: string,
  args: Record<string, unknown>,
): Promise<{ rel: string; original: string; updated: string; count: number; diff: string; adds: number; dels: number }> {
  const rel = str(args, "path");
  const abs = resolveInRoot(projectRoot, rel);
  await assertRealInRoot(projectRoot, abs); // B27: symlink escape check
  const oldText = str(args, "oldText");
  const newText = typeof args.newText === "string" ? args.newText : fail('argument "newText" must be a string');
  const replaceAll = optBool(args, "replaceAll", false);
  if (oldText.length === 0) fail('"oldText" must be non-empty');

  const original = await fs.promises
    .readFile(abs, "utf8")
    .catch(() => fail(`file not found: ${rel}`));
  const parts = original.split(oldText);
  const count = parts.length - 1;
  if (count === 0) fail(`oldText not found in ${rel}`);
  if (count > 1 && !replaceAll) {
    fail(`oldText matches ${count} times in ${rel}; pass replaceAll:true or include more surrounding context`);
  }
  const updated = parts.join(newText);
  const diff = createTwoFilesPatch(rel, rel, original, updated, "before", "after", { context: 3 });
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { rel, original, updated, count, diff, adds, dels };
}

export function validateAndHealSyntax(content: string, filePath: string): { ok: boolean; content: string; warning?: string } {
  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);

  // 1. Bracket balance check
  const stack: { char: string; line: number }[] = [];
  const pairs: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  const opens: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

  let inString: string | null = null;
  let esc = false;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
        inString = ch;
        continue;
      }
      if (inString && ch === inString) {
        inString = null;
        continue;
      }
      if (inString) continue;

      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === "#" && (ext === ".py" || ext === ".sh" || ext === ".yaml" || ext === ".yml")) break;

      if (ch === "{" || ch === "[" || ch === "(") {
        stack.push({ char: ch, line: l + 1 });
      } else if (ch === "}" || ch === "]" || ch === ")") {
        const expected = pairs[ch];
        const last = stack.pop();
        if (!last || last.char !== expected) {
          return { ok: false, content, warning: `Unbalanced bracket '${ch}' at line ${l + 1}` };
        }
      }
    }
  }

  // Self-heal 1-3 unclosed brackets
  if (stack.length > 0) {
    if (stack.length <= 3) {
      const closing = stack.reverse().map((s) => opens[s.char]!).join("");
      const healed = content + (content.endsWith("\n") ? "" : "\n") + closing;
      return { ok: true, content: healed, warning: `Self-healed unclosed brackets by appending '${closing}'` };
    }
    const unclosed = stack.map((s) => `'${s.char}' at line ${s.line}`).join(", ");
    return { ok: false, content, warning: `Unclosed brackets: ${unclosed}` };
  }

  // 2. Python syntax check
  if (ext === ".py" || ext === ".pyi") {
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;
      if (
        /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|with|finally)\b/.test(trimmed) &&
        !trimmed.endsWith(":") &&
        !trimmed.endsWith("\\") &&
        !trimmed.includes("#")
      ) {
        if (!trimmed.includes("(") || trimmed.endsWith(")")) {
          lines[l] = line + ":";
          return { ok: true, content: lines.join("\n"), warning: `Self-healed missing colon at line ${l + 1}` };
        }
      }
    }
  }

  return { ok: true, content };
}

const write_file: Handler = async ({ projectRoot, args }) => {
  const rel = str(args, "path");
  const abs = resolveInRoot(projectRoot, rel);
  await assertRealInRoot(projectRoot, abs); // B27: symlink escape check
  const rawContent = typeof args.content === "string" ? args.content : fail('argument "content" must be a string');
  const validation = validateAndHealSyntax(rawContent, rel);
  const content = validation.content;
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  const warning = validation.warning ? ` (${validation.warning})` : "";
  return `wrote ${rel} (${bytes} bytes)${warning}`;
};

const edit_file: Handler = async ({ projectRoot, args }) => {
  const e = await computeEdit(projectRoot, args);
  const validation = validateAndHealSyntax(e.updated, e.rel);
  const writeAbs = resolveInRoot(projectRoot, e.rel);
  await assertRealInRoot(projectRoot, writeAbs); // B27: re-check before write
  await fs.promises.writeFile(writeAbs, validation.content, "utf8");
  const warning = validation.warning ? ` (${validation.warning})` : "";
  return `edited ${e.rel}: replaced ${e.count} occurrence(s), +${e.adds} −${e.dels} lines${warning}`;
};

const run_command: Handler = async ({ projectRoot, args, projectId }) => {
  const command = (optStr(args, "command", "") || optStr(args, "cmd", "")).trim();
  if (!command) fail('missing required argument "command"');
  const reason = catastrophicReason(command);
  if (reason) fail(`blocked dangerous command — ${reason}. Refused without execution.`);
  const cwdRel = optStr(args, "cwd", ".") || ".";
  const cwd = resolveInRoot(projectRoot, cwdRel);
  const st = await fs.promises.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) fail(`cwd not found: ${cwdRel}`);

  const isBg =
    /(?:^|[;&|]\s*)(?:nohup\b|disown\b)|\&\s*$/.test(command) ||
    optStr(args, "mode", "").toLowerCase() === "background" ||
    args.isDaemon === true ||
    args.background === true ||
    /\b(?:python\d*\s+-m\s+http\.server|http-server|live-server)\b/.test(command);

  if (isBg) {
    const bgCmd = command.endsWith("&") ? command : `${command} &`;
    const child = spawn("bash", ["-c", bgCmd], {
      cwd,
      env: scrubEnv(),
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    const pid = child.pid;
    await new Promise((r) => setTimeout(r, 250));
    return `$ ${command}\nexit: started in background (PID ${pid ?? "detached"})\n── status ──\nprocess spawned in background.`;
  }

  const timeoutMs = clamp(Math.floor(optNum(args, "timeoutMs", DEFAULT_CMD_TIMEOUT_MS)), 1_000, MAX_CMD_TIMEOUT_MS);
  // System-terminal integration: mirror the command into the terminal the user
  // is actually looking at, so agent activity and human activity share one
  // scrollback instead of the agent working invisibly behind a spinner.
  echoAgentActivity(projectId, command, "cmd");
  const r = await runProcess("bash", ["-c", command], { cwd, timeoutMs });
  const summary = r.timedOut
    ? `timed out after ${timeoutMs}ms`
    : `exit ${r.code ?? "?"} · ${(r.durationMs / 1000).toFixed(1)}s`;
  echoAgentActivity(projectId, summary, r.code === 0 && !r.timedOut ? "ok" : "err");
  return composeShellResult(command, r);
};

// ── git_* wrappers ────────────────────────────────────────────────────────

async function gitRun(projectRoot: string, gitArgs: string[]): Promise<RunOutcome & { text: string }> {
  // --no-pager belongs on EVERY git invocation, not just the two that
  // remembered it. Injected here so a new git tool cannot forget it.
  const args = gitArgs[0] === "--no-pager" ? gitArgs : ["--no-pager", ...gitArgs];
  const r = await runProcess("git", args, { cwd: path.resolve(projectRoot), timeoutMs: MAX_CMD_TIMEOUT_MS });
  const text = clip([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n"), OUT_CAP);
  return { ...r, text };
}

const git_status: Handler = async ({ projectRoot }) => {
  const r = await gitRun(projectRoot, ["status", "--porcelain=v1", "-b"]);
  if (r.code !== 0) fail(`git status failed: ${r.text}`);
  const body = r.text.trim();
  return body.length ? body : "(clean working tree)";
};

const git_diff: Handler = async ({ projectRoot }) => {
  let r = await gitRun(projectRoot, ["--no-pager", "diff", "HEAD"]);
  if (r.code !== 0) r = await gitRun(projectRoot, ["--no-pager", "diff"]); // unborn HEAD
  if (r.code !== 0) fail(`git diff failed: ${r.text}`);
  return r.text.trim().length ? r.text : "(no changes)";
};

const git_commit: Handler = async ({ projectRoot, args }) => {
  const message = str(args, "message").trim();
  if (!message) fail('"message" must be a non-empty string');
  const add = await gitRun(projectRoot, ["add", "-A"]);
  if (add.code !== 0) fail(`git add failed: ${add.text}`);
  const commit = await gitRun(projectRoot, ["commit", "-m", message]);
  if (commit.code !== 0) fail(`git commit failed: ${clip(commit.text, 2_000)}`);
  return commit.text.trim() || "committed";
};

function assertBranchName(name: string): void {
  if (
    !name ||
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//")
  ) {
    fail(`invalid branch name: ${JSON.stringify(name)}`);
  }
}

const git_branch: Handler = async ({ projectRoot, args }) => {
  const name = str(args, "name").trim();
  assertBranchName(name);
  const from = optStr(args, "from", "").trim();
  if (from) assertBranchName(from);
  const r = await gitRun(projectRoot, ["checkout", "-b", name, ...(from ? [from] : [])]);
  if (r.code !== 0) fail(`git branch failed: ${r.text}`);
  return r.text.trim() || `created branch ${name}`;
};

const git_merge: Handler = async ({ projectRoot, args }) => {
  const branch = str(args, "branch").trim();
  assertBranchName(branch);
  const r = await gitRun(projectRoot, ["merge", "--no-edit", branch]);
  if (r.code !== 0) fail(`git merge failed (potential conflict): ${r.text}`);
  return r.text.trim() || `merged branch ${branch}`;
};

// ── web_search ────────────────────────────────────────────────────────────

const web_search: Handler = async ({ args }) => {
  const query = str(args, "query").trim();
  if (!query) fail('"query" must be a non-empty string');
  // Shared multi-backend search (DuckDuckGo → Bing fallback) lives in websearch.ts.
  const results = await searchWeb(query);
  if (results.length === 0) return `no results for "${query}" (all search backends blocked/empty)`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ""}`)
    .join("\n\n");
};

const web_scrape: Handler = async ({ args }) => {
  const url = str(args, "url").trim();
  if (!url) fail('"url" must be a non-empty string');
  if (!/^https?:\/\//i.test(url)) fail('"url" must start with http:// or https://');
  const maxChars = optNum(args, "maxChars", 20_000);
  const r = await scrapeWeb(url, maxChars);
  const head = `URL: ${r.url}${r.status ? ` (HTTP ${r.status})` : ""}${r.title ? `\nTitle: ${r.title}` : ""}${r.truncated ? `\n[truncated to ${maxChars} chars]` : ""}`;
  return `${head}\n\n${r.text || "(no readable text extracted)"}`;
};

// ── Wave 25 subagents: delegate runner injection ──────────────────────────
// The real delegation logic lives in the orchestrator (it needs runTask-level
// primitives: sessions, tool loops, budgets). tools.ts cannot import the
// orchestrator (circular — orchestrator imports executeTool/TOOL_SPECS), so the
// orchestrator registers a runner at startup via setDelegateRunner. When no
// runner is registered (unit tests, early boot) the tool degrades gracefully.
export interface DelegateInput {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  role: string;
  goal: string;
  instructions: string;
  /** Parent task's abort signal — Stop on the parent must kill the subtask. */
  signal?: AbortSignal;
}
export type DelegateRunner = (input: DelegateInput) => Promise<string>;
let delegateRunner: DelegateRunner | null = null;
export function setDelegateRunner(fn: DelegateRunner | null): void {
  delegateRunner = fn;
}

const delegate: Handler = async ({ sessionId, projectId, projectRoot, args, signal }) => {
  const role = optStr(args, "role", "coder");
  // Small models sometimes emit the subtask under "task" instead of "goal" —
  // accept both rather than failing the call (falls back to str() so a truly
  // missing goal still errors with ok:false).
  const goal = optStr(args, "goal", "") || optStr(args, "task", "") || str(args, "goal");
  const instructions = optStr(args, "instructions", "");
  if (!delegateRunner) {
    return `[delegate] delegation is not available in this context — goal was: ${goal}`;
  }
  return delegateRunner({ sessionId, projectId, projectRoot, role, goal, instructions, signal });
};

const finish: Handler = async ({ args }) => {
  const summary = optStr(args, "summary", "Task completed.");
  return `[finish]\n${summary}`;
};

const retrieve_code: Handler = async ({ projectId, args, sessionId }) => {
  const query = str(args, "query");
  const k = optNum(args, "k", 6);
  const hits = await retrieve({ projectId, query, k, sessionId });
  if (!hits.length) return "no matching code chunks found";
  return hits.map((h) => `${h.path}:${h.startLine}-${h.endLine} (score ${h.score})${h.symbol ? ` [${h.symbol}]` : ""}:\n${h.preview}`).join("\n\n");
};

const HANDLERS: Record<string, Handler> = {
  read_file,
  read_range,
  list_dir,
  grep,
  glob,
  write_file,
  edit_file,
  run_command,
  git_status,
  git_diff,
  git_commit,
  git_branch,
  git_merge,
  web_search,
  web_scrape,
  web_extract: web_scrape,
  delegate,
  finish,
  retrieve_code,
};

// ── Approval plumbing ─────────────────────────────────────────────────────

function summarizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      if (k === "content") out[k] = `<${v.length} chars>`;
      else out[k] = v.length > 300 ? v.slice(0, 300) + "…" : v;
    } else {
      out[k] = v;
    }
  }
  void name;
  return out;
}

/** Validate a side-effect call BEFORE creating an approval so invalid calls
 *  never ping the human, and build a rich payload (diff preview / command).
 *  For file-mutating tools it also returns the would-be FileDiff (critique
 *  #3: the human reviews REAL hunks before any byte lands) plus the success
 *  text the tool will report once that diff is materialized. */
async function preflight(
  name: string,
  projectRoot: string,
  args: Record<string, unknown>,
): Promise<{
  summary: string;
  payload: Record<string, unknown>;
  files?: FileDiff[];
  resultText?: string;
}> {
  switch (name) {
    case "write_file": {
      const rel = str(args, "path");
      const abs = resolveInRoot(projectRoot, rel); // throws on escape
      await assertRealInRoot(projectRoot, abs); // B27: symlink escape check
      const content = typeof args.content === "string" ? args.content : fail('argument "content" must be a string');
      const kb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
      let before: string | null = null;
      try {
        const st = await fs.promises.stat(abs);
        if (st.isFile() && st.size <= 4_000_000) before = await fs.promises.readFile(abs, "utf8");
      } catch {
        /* new file → before stays null (diff status "added") */
      }
      // Large-codebase guard: refuse a "rewrite" that is really an edit. Runs
      // in preflight so the refusal reaches the model as a tool error it can
      // act on, and no diff/approval is ever created for the bad write.
      const guard = rewriteGuardVerdict(before, content);
      if (guard) fail(guard);
      // Critique #16: emit BOTH key generations — `content`/`preview` for text,
      // `diff` as the real unified patch — so any client renders this card.
      const diff = createTwoFilesPatch(rel, rel, before ?? "", content, "before", "after", { context: 3 });
      return {
        summary: `write_file ${rel} (${kb} KB)`,
        payload: { tool: name, path: rel, bytes: content.length, preview: clip(content, 1_200), content: clip(content, 1_200), diff: clip(diff, DIFF_PREVIEW_CAP) },
        files: [buildFileDiff(rel, before, content)],
        resultText: `wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes)`,
      };
    }
    case "edit_file": {
      const e = await computeEdit(projectRoot, args); // validates path + match count
      return {
        summary: `edit_file ${e.rel} (+${e.adds} −${e.dels})`,
        payload: { tool: name, path: e.rel, occurrences: e.count, diff: clip(e.diff, DIFF_PREVIEW_CAP), diffPreview: clip(e.diff, DIFF_PREVIEW_CAP) },
        files: [buildFileDiff(e.rel, e.original, e.updated)],
        resultText: `edited ${e.rel}: replaced ${e.count} occurrence(s), +${e.adds} −${e.dels} lines`,
      };
    }
    case "run_command": {
      // Low-item fix: the handler accepts BOTH `command` and `cmd`, so the
      // preflight must too — otherwise `cmd`-shaped calls failed validation
      // with a confusing "missing required argument" before the gate.
      const command = (optStr(args, "command", "") || optStr(args, "cmd", "")).trim();
      if (!command) fail('missing required argument "command" (or "cmd")');
      return { summary: `run_command: ${clip(command, 120)}`, payload: { tool: name, command } };
    }
    case "git_commit": {
      const message = str(args, "message").trim();
      if (!message) fail('"message" must be a non-empty string');
      return {
        summary: `git_commit: ${clip(message, 80)}`,
        payload: { tool: name, message, command: "git add -A && git commit -m <message>" },
      };
    }
    case "git_branch": {
      const bname = str(args, "name").trim();
      assertBranchName(bname);
      const from = optStr(args, "from", "").trim();
      if (from) assertBranchName(from);
      return {
        summary: `git_branch: ${bname}${from ? ` (from ${from})` : ""}`,
        payload: { tool: name, name: bname, from: from || undefined, command: `git checkout -b ${bname}` },
      };
    }
    case "git_merge": {
      const bname = str(args, "branch").trim();
      assertBranchName(bname);
      return {
        summary: `git_merge: ${bname}`,
        payload: { tool: name, branch: bname, command: `git merge --no-edit ${bname}` },
      };
    }
    default:
      return { summary: `${name}`, payload: { tool: name, args } };
  }
}

// ── executeTool ───────────────────────────────────────────────────────────

/**
 * B7: the approval gate reads operator settings, not just the spec.
 * Posture comes from settings.approvals.mode. The effective DEFAULT is
 * "gate" (config.ts DEFAULT_SETTINGS, and the reading for ABSENT/empty
 * settings — loadSettings merges the default, and index.ts normalizeApprovals
 * coerces unknown → gate, so every path agrees):
 *   • "gate" (DEFAULT): park whenever the spec declares a side effect OR the
 *     name is listed in requireApprovalFor. This is the posture PS 8b
 *     mandates — writes, deletes, shell and git all wait for a human.
 *   • "optimistic" (default): write_file/edit_file apply immediately (they are
 *     checkpointed + revertable), so work never blocks; shell/git and any
 *     side-effect tool still gate.
 *   • "gate": park when the spec declares side effects OR the name is listed in
 *     requireApprovalFor (listed names gate even without a sideEffect flag).
 *   • "auto": nothing gates (explicit operator choice).
 * Orchestrator reuses this predicate for status flips + deadline refunds so
 * both sides agree on what is actually gated.
 */
export function toolRequiresApproval(name: string): boolean {
  const s = loadSettings();
  const mode = s.approvals?.mode ?? "gate";
  if (mode === "auto") return false;
  if (mode === "optimistic") {
    // Wave 26: file mutations apply immediately (checkpointed + revertable via
    // the checkpoint store) so work never blocks on a human. Arbitrary-shell
    // and git tools still gate — those are the irreversible/dangerous ones.
    if (name === "write_file" || name === "edit_file") return false;
    if ((s.requireApprovalFor ?? []).includes(name)) return true;
    const specO = TOOL_SPECS.find((t) => t.name === name);
    return !!specO?.sideEffect;
  }
  if ((s.requireApprovalFor ?? []).includes(name)) return true;
  const spec = TOOL_SPECS.find((t) => t.name === name);
  return !!spec?.sideEffect;
}

export function normalizeTool(name: string, rawArgs: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  let n = name.trim().toLowerCase();
  const a = { ...rawArgs };
  if (["shell", "bash", "cmd", "terminal", "exec", "execute_command"].includes(n)) {
    n = "run_command";
    if (a.command && !a.cmd) a.cmd = a.command;
    if (a.commandLine && !a.cmd) a.cmd = a.commandLine;
  } else if (["create_file", "save_file", "new_file"].includes(n)) {
    n = "write_file";
    if (a.target_file && !a.path) a.path = a.target_file;
    if (a.file_path && !a.path) a.path = a.file_path;
    if (a.code && !a.content) a.content = a.code;
    if (a.contents && !a.content) a.content = a.contents;
  } else if (["str_replace_editor", "modify_file"].includes(n)) {
    n = "edit_file";
    if (a.target_file && !a.path) a.path = a.target_file;
    if (a.old_str && !a.oldText) a.oldText = a.old_str;
    if (a.new_str && !a.newText) a.newText = a.new_str;
  } else if (["view_file", "cat"].includes(n)) {
    n = "read_file";
    if (a.target_file && !a.path) a.path = a.target_file;
    if (a.file_path && !a.path) a.path = a.file_path;
  } else if (["search_files", "ripgrep"].includes(n)) {
    n = "grep";
  } else if (["find_files", "find_by_name"].includes(n)) {
    n = "glob";
  }
  // BUGFIX: small models drop separators and emit "writefile"/"listdir"/
  // "runcommand". Match the separator-stripped name against the canonical tool
  // names as a last resort so the call still resolves (and the approval gate
  // sees the real tool, not an unknown alias).
  if (!TOOL_SPECS.some((t) => t.name === n)) {
    const stripped = n.replace(/[^a-z0-9]/g, "");
    const hit = TOOL_SPECS.find((t) => t.name.replace(/[^a-z0-9]/g, "") === stripped);
    if (hit) n = hit.name;
  }
  if (typeof a.path === "string" && (a.path.includes("<arg_value>") || a.path.includes("<arg_key>"))) {
    const parts = a.path.split(/<arg_value>|<arg_key>/i);
    a.path = parts[0]!.replace(/<\/?(?:arg_key|arg_value|key|value)>/gi, "").trim();
    if (!a.content && parts[1]) {
      a.content = parts.slice(1).join("").replace(/<\/?(?:arg_key|arg_value|key|value)>/gi, "").trim();
    }
  }
  return { name: n, args: a };
}

export async function executeTool(rawInput: ExecuteToolInput): Promise<ExecuteToolResult> {
  const norm = normalizeTool(rawInput.name, rawInput.args);
  const input: ExecuteToolInput = { ...rawInput, name: norm.name, args: norm.args };
  const started = Date.now();
  const spec = TOOL_SPECS.find((t) => t.name === input.name);
  if (!spec) return { ok: false, result: `unknown tool: ${input.name}` };
  // ONE span per executeTool call: call + result share it, so the dashboard
  // merges them into a single closed row with real duration instead of an
  // eternally-open orphan bucket.
  const sp = spanId();

  trace.emit({
    sessionId: input.sessionId,
    spanId: sp,
    parentId: input.parentSpan,
    kind: "tool.call",
    label: `tool: ${input.name}`,
    agentRole: "coder",
    input: summarizeArgs(input.name, input.args),
  });
  // r7-A: tool calls at info — the "what did the agent actually DO" timeline.
  log("info", "tools", `tool call: ${input.name}`, {
    sessionId: input.sessionId, gated: toolRequiresApproval(input.name) && !input.autoApprove,
    args: summarizeArgs(input.name, input.args),
  });

  let approval: ApprovalRequest | undefined;
  let approvalWaitMs: number | undefined;
  try {
    // Set when the proposal path already materialized the effect (approved
    // write_file/edit_file land through the reviewed diff, NOT the raw
    // handler — what's on disk is exactly what the user accepted).
    let preapplied: string | undefined;
    // autoApprove stays an override for read-only/internal use; side-effect
    // tools NOT in requireApprovalFor run ungated by explicit operator choice.
    if (toolRequiresApproval(input.name) && !input.autoApprove) {
      const pf = await preflight(input.name, input.projectRoot, input.args);

      // ── Proposal lifecycle (critique #3/#4): file-mutating tools park a
      // PENDING block-level diff BEFORE awaiting approval; command-shaped
      // effects keep the legacy gate (orchestrator records their batch
      // "applied" proposal afterwards).
      let proposal: ChangeProposal | undefined;
      if ((input.name === "write_file" || input.name === "edit_file") && pf.files?.length) {
        proposal = {
          id: randomUUID(),
          sessionId: input.sessionId,
          files: pf.files,
          rationale: `${input.name} ${String(input.args.path ?? "")}`.trim(),
          createdAt: Date.now(),
          status: "pending",
        };
        putProposal(proposal);
        wire.emit({ type: "proposal", proposal });
      }

      approval = createApproval({
        sessionId: input.sessionId,
        toolName: input.name,
        summary: pf.summary,
        payload: proposal ? { ...pf.payload, proposalId: proposal.id } : pf.payload,
      }, input.parentSpan);
      const waitStarted = Date.now();
      const decided = await awaitDecision(approval.id, APPROVAL_TIMEOUT, input.signal, input.parentSpan);
      approvalWaitMs = Date.now() - waitStarted;
      if (decided.status !== "approved") {
        if (proposal) {
          const rejected = updateProposal(proposal.id, { status: "rejected" });
          if (rejected) wire.emit({ type: "proposal", proposal: rejected });
        }
        const why = decided.decidedBy === "aborted" ? "aborted" : "user denied";
        log("warn", "tools", `tool ${input.name} not approved`, { sessionId: input.sessionId, outcome: why });
        trace.emit({
          sessionId: input.sessionId,
          spanId: sp,
          parentId: input.parentSpan,
          kind: "tool.result",
          label: `tool: ${input.name}`,
          output: { ok: false, result: why, approvalId: approval.id, ...(proposal ? { proposalId: proposal.id } : {}) },
          durationMs: Date.now() - started,
        });
        return { ok: false, result: why, approvalId: approval.id, needsApproval: true, ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}) };
      }

      if (proposal) {
        // Approved → splice accepted hunks (default: ALL) onto disk.
        const total = proposal.files.reduce((n, f) => n + f.hunks.length, 0);
        const allHunks = Object.fromEntries(proposal.files.map((f) => [f.path, f.hunks.map((h) => h.hunkIndex)]));
        const applied = applyProposalPartial(proposal, input.projectRoot, allHunks, false);
        const status: ChangeProposal["status"] =
          applied.appliedCount === 0
            ? "rejected"
            : total > 0 && applied.appliedCount >= total
              ? "applied"
              : "partially-applied";
        const updated = updateProposal(proposal.id, { status });
        if (updated) wire.emit({ type: "proposal", proposal: updated });
        // P2 misattribution guard: these paths were materialized by a HUMAN-
        // approved tool gate in the current step — record them so the
        // orchestrator's batch step proposal doesn't re-list the same diff as
        // if the agent had produced it unprompted.
        noteGatedAppliedPaths(input.sessionId, proposal.files.map((f) => f.path));
        preapplied = pf.resultText ?? `${input.name}: applied ${applied.appliedCount}/${total} hunk(s)`;
      }
    }

    let result: string;
    if (preapplied !== undefined) {
      result = preapplied;
    } else {
      const handler = HANDLERS[input.name];
      if (!handler) return { ok: false, result: `unknown tool: ${input.name}` };
      result = await handler({ projectRoot: input.projectRoot, projectId: input.projectId, sessionId: input.sessionId, args: input.args, signal: input.signal });
    }

    trace.emit({
      sessionId: input.sessionId,
      spanId: sp,
      parentId: input.parentSpan,
      kind: "tool.result",
      label: `tool: ${input.name}`,
      agentRole: "coder",
      output: { ok: true, result: clip(result, TRACE_RESULT_CAP), ...(approval ? { approvalId: approval.id } : {}) },
      durationMs: Date.now() - started,
    });
    log("info", "tools", `tool ok: ${input.name}`, { sessionId: input.sessionId, durationMs: Date.now() - started });
    return {
      ok: true,
      result,
      ...(approval ? { approvalId: approval.id, needsApproval: true } : {}),
      ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}),
    };
  } catch (err) {
    const msg =
      err instanceof ToolError
        ? err.message
        : `tool ${input.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    trace.emit({
      sessionId: input.sessionId,
      spanId: sp,
      parentId: input.parentSpan,
      kind: "tool.result",
      label: `tool: ${input.name}`,
      output: { ok: false, error: msg, ...(approval ? { approvalId: approval.id } : {}) },
      durationMs: Date.now() - started,
    });
    log("warn", "tools", `tool failed: ${input.name}`, { sessionId: input.sessionId, error: msg.slice(0, 300) });
    return {
      ok: false,
      result: msg,
      ...(approval ? { approvalId: approval.id, needsApproval: true } : {}),
      ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}),
    };
  }
}
