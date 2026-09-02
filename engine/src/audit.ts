/**
 * audit.ts — independent, read-only verification of what actually changed.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything that decided whether a step succeeded was, until now, downstream
 * of the coder itself:
 *
 *   - the reviewer reads the UNIFIED DIFF, which is computed from the same
 *     writes the coder performed. A file written with broken syntax produces a
 *     perfectly clean-looking diff, and the reviewer passes it.
 *   - `step.resultSummary` — the text the re-planner reads when deciding what
 *     to do next — is `clip(run.finalText)`, i.e. the coder's own account of
 *     its work.
 *
 * So the agent was grading its own homework, and the manager was re-planning
 * from the grade. The failure that motivates this is specific and was observed:
 * a step reports "created quotes.js with the quote data", the diff shows the
 * file, the reviewer passes — and the file is a syntax error, or empty, or was
 * never written at all because the tool call was rejected after the summary
 * was composed.
 *
 * The auditor answers one question the coder cannot be trusted on: *what is
 * actually on disk now?* It never reads the coder's output and never accepts
 * its claims. Checks are cheap, deterministic, and read-only — no LLM call, so
 * an audit costs no tokens and cannot itself hallucinate.
 *
 * READ-ONLY IS A HARD CONSTRAINT. The auditor stats and parses files. It runs
 * no build, no test suite, no project command: those mutate state (caches,
 * fixtures, databases), and an auditor that changes the thing it is auditing
 * cannot certify it. Verification-by-test-run is the coder's job, via
 * run_command, where it is gated and visible.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NON_INTERACTIVE_ENV } from "./config.js";

export interface AuditCheck {
  /** Stable id so the same failure reads the same way across runs. */
  name: "exists" | "non-empty" | "syntax";
  ok: boolean;
  path: string;
  detail: string;
}

export interface AuditReport {
  ok: boolean;
  checks: AuditCheck[];
  /**
   * Verified statements about the workspace, phrased for a planner to read.
   * These are the ONLY step outcomes the re-planner should trust: unlike
   * resultSummary they are observations, not claims.
   */
  facts: string[];
}

const SYNTAX_TIMEOUT_MS = 8_000;

/**
 * Interpreters that can check a file for syntax errors WITHOUT executing it.
 *
 * Every entry must be parse-only. `python file.py` would run the module's
 * top-level code — that is execution, not audit, and on a real project it has
 * side effects. `py_compile` and `node --check` parse and exit.
 *
 * TypeScript is deliberately absent: a real check needs the project's tsconfig
 * and type graph, which is far too slow to run after every step, and a
 * syntax-only approximation would produce false failures on valid code. A
 * wrong audit is worse than no audit — it fails good work and sends the coder
 * chasing a defect that does not exist.
 */
const SYNTAX_CHECKERS: { ext: string[]; cmd: string; args: (abs: string) => string[] }[] = [
  { ext: [".py"], cmd: "python3", args: (a) => ["-m", "py_compile", a] },
  { ext: [".js", ".cjs", ".mjs"], cmd: "node", args: (a) => ["--check", a] },
  { ext: [".json"], cmd: "node", args: (a) => ["-e", `JSON.parse(require('fs').readFileSync(${JSON.stringify(a)},'utf8'))`] },
];

function checkerFor(rel: string): { cmd: string; args: string[] } | null {
  const ext = path.extname(rel).toLowerCase();
  for (const c of SYNTAX_CHECKERS) {
    if (c.ext.includes(ext)) return { cmd: c.cmd, args: c.args(rel) };
  }
  return null;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: SYNTAX_TIMEOUT_MS, env: { ...process.env, ...NON_INTERACTIVE_ENV } },
      (error, _stdout, stderr) => {
        const e = error as (Error & { code?: number }) | null;
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, err: String(stderr || e?.message || "") });
      },
    );
  });
}

/** First line of a compiler error — the rest is a stack trace the model does not need. */
function firstMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|SyntaxError|invalid|unexpected|expected/i.test(l));
  return (hit ?? lines[0] ?? "syntax check failed").slice(0, 220);
}

/**
 * Audit the paths a step claims to have changed.
 *
 * `deletedPaths` are expected to be absent; everything else must exist, be
 * non-empty, and parse. Files the auditor has no checker for pass the syntax
 * stage silently — an unverifiable file is not a failing file.
 */
export async function auditStep(
  projectRoot: string,
  changedPaths: string[],
  deletedPaths: string[] = [],
): Promise<AuditReport> {
  const checks: AuditCheck[] = [];
  const deleted = new Set(deletedPaths);

  for (const rel of changedPaths) {
    if (deleted.has(rel)) continue;
    const abs = path.resolve(projectRoot, rel);

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }

    if (!stat?.isFile()) {
      checks.push({
        name: "exists",
        ok: false,
        path: rel,
        detail: `the step reports changing ${rel}, but no such file is on disk`,
      });
      continue;
    }
    checks.push({ name: "exists", ok: true, path: rel, detail: `${rel} exists (${stat.size} bytes)` });

    if (stat.size === 0) {
      checks.push({
        name: "non-empty",
        ok: false,
        path: rel,
        detail: `${rel} is empty — a write that produced no content is not a completed change`,
      });
      continue;
    }

    const checker = checkerFor(rel);
    if (!checker) continue; // unverifiable ≠ failing
    const r = await run(checker.cmd, checker.args, projectRoot);
    if (r.code === 0) {
      checks.push({ name: "syntax", ok: true, path: rel, detail: `${rel} parses` });
    } else {
      // A missing interpreter must not be reported as broken code.
      if (/ENOENT|not found|command not found/i.test(r.err)) continue;
      checks.push({
        name: "syntax",
        ok: false,
        path: rel,
        detail: `${rel} does not parse: ${firstMeaningfulLine(r.err)}`,
      });
    }
  }

  // Deleted files must actually be gone.
  for (const rel of deleted) {
    const gone = !fs.existsSync(path.resolve(projectRoot, rel));
    checks.push({
      name: "exists",
      ok: gone,
      path: rel,
      detail: gone ? `${rel} removed` : `${rel} was reported deleted but is still on disk`,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  const verifiedFiles = new Set(checks.filter((c) => c.ok && c.name === "exists").map((c) => c.path));

  const facts: string[] =
    failed.length > 0
      ? failed.map((c) => `VERIFIED FAILURE: ${c.detail}`)
      : verifiedFiles.size > 0
        ? [`VERIFIED: ${[...verifiedFiles].join(", ")} present and parsing on disk`]
        : ["VERIFIED: no file changes detected on disk for this step"];

  return { ok: failed.length === 0, checks, facts };
}

/** One-line audit summary for a trace label. */
export function auditLabel(r: AuditReport): string {
  const pass = r.checks.filter((c) => c.ok).length;
  return r.ok ? `audit passed (${pass}/${r.checks.length} checks)` : `audit FAILED: ${r.checks.find((c) => !c.ok)?.detail ?? "unknown"}`;
}
