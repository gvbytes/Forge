// Apply accepted hunks of a ChangeProposal back onto the workspace.
// Block-level accept/reject (req 10b): user selects hunks per file; we
// reconstruct each file's post-image from accepted hunks + context lines and
// write it. Rejected hunks leave the file as-is (agent works around them).
//
// Critique #4 hardening baked in:
//   * drift correction re-derives BOTH the offset and the anchor actually
//     used by the splice (the old code fixed `offset` but spliced at the
//     stale pre-drift position),
//   * rejected hunks never run drift math, so they cannot shift later
//     accepted hunks,
//   * anchor verification compares against the hunk's FIRST del-or-ctx line
//     (its real old-file start), not "first context line anywhere",
//   * re-applying an already-applied hunk is a no-op: when the del lines are
//     gone and the add lines already sit at the anchor, the hunk is skipped,
//   * every resolved path is jailed to projectRoot; escapees are skipped.
import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { ChangeProposal, FileDiff } from "./types.js";

export interface ApplyResult {
  appliedFiles: string[];
  appliedCount: number;
  skipped: { path: string; hunkIndex: number; reason: string }[];
}

function readLines(p: string): string[] {
  return fs.readFileSync(p, "utf8").split("\n");
}

function writeLines(p: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join("\n"));
}

/** Containment check for a resolved absolute path (sibling-prefix safe:
 *  `/parent/agentzero-secrets/x` must NOT pass for root `/parent/agentzero`). */
function inRoot(root: string, abs: string): boolean {
  const r = path.resolve(root) + path.sep;
  return abs === path.resolve(root) || abs.startsWith(r);
}

/** B27: lexical containment is not enough — a symlink INSIDE the project can
 *  point at /etc or $HOME. realpath the deepest existing ancestor of the
 *  target (the target itself when it exists) and re-check containment. */
function realInRoot(root: string, abs: string): boolean {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(root));
  } catch {
    rootReal = path.resolve(root);
  }
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(probe);
        if (parent === probe) return false;
        probe = parent;
        continue;
      }
      return false;
    }
    return real === rootReal || real.startsWith(rootReal + path.sep);
  }
}

/**
 * Build a FileDiff from before/after text. Single source of truth for both
 * proposal producers: tools.ts (would-be diff BEFORE approval) and
 * orchestrator.ts (snapshot/git-derived step diffs).
 *
 * Handles added/deleted status from null sides and fabricates a whole-content
 * hunk when the unified format cannot express the change (e.g. empty target).
 */
export function buildFileDiff(relPath: string, before: string | null, after: string | null): FileDiff {
  const patch = createTwoFilesPatch(relPath, relPath, before ?? "", after ?? "", "before", "after", { context: 3 });
  const fd = parseUnifiedPatch(relPath, patch);
  if (before === null && after !== null) fd.status = "added";
  else if (after === null && before !== null) fd.status = "deleted";
  // Ground truth beats marker inference: we HAVE the strings, so set the
  // trailing-newline hint directly (the unified format only encodes it via
  // "\ No newline at end of file" markers).
  fd.noTrailingNewline = after !== null && after.length > 0 && !after.endsWith("\n");

  if (fd.hunks.length === 0 && (before ?? "") !== (after ?? "")) {
    // Degenerate case (empty file / headers-only patch): one synthetic hunk
    // carrying the full content so review+apply still see the change.
    const lines: FileDiff["hunks"][number]["lines"] = [];
    if (before) before.split("\n").forEach((text, i) => lines.push({ type: "del", text, oldLn: i + 1 }));
    if (after) after.split("\n").forEach((text, i) => lines.push({ type: "add", text, newLn: i + 1 }));
    fd.hunks = [{ hunkIndex: 0, header: "@@ -1 +1 @@", lines }];
  }
  fd.additions = fd.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0);
  fd.deletions = fd.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "del").length, 0);
  fd.summary = `--- ${relPath} (+${fd.additions} −${fd.deletions}) ---\n${fd.hunks.map((h) => h.header).join("\n")}`;
  return fd;
}

/** Unified-diff text → FileDiff hunks (bare line text, original numbering
 *  preserved, bounded size). Exported so producers share ONE parser. */
export function parseUnifiedPatch(rel: string, patch: string): FileDiff {
  const hunks: FileDiff["hunks"] = [];
  let cur: FileDiff["hunks"][number] | null = null;
  let oldLn = 0, newLn = 0, adds = 0, dels = 0;
  let noNlOnAdd = false; // saw "\ No newline at end of file" on the new side
  let prevType: "add" | "del" | "ctx" | null = null;
  const rows = patch.split("\n");
  // Drop the trailing "" ONLY when it is the split artifact of a terminating
  // newline. A patch that does NOT end in "\n" can carry a real empty context
  // line in that slot — popping it unconditionally lost the line (engine low).
  if (rows.length > 0 && rows[rows.length - 1] === "" && patch.endsWith("\n")) rows.pop();
  for (const line of rows) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      cur = { hunkIndex: hunks.length, header: line, lines: [] };
      hunks.push(cur);
      oldLn = parseInt(h[1] ?? "0", 10); newLn = parseInt(h[2] ?? "0", 10);
      prevType = null;
      continue;
    }
    if (!cur) continue; // skip ---/+++ headers
    if (line.startsWith("\\")) {
      // "\ No newline at end of file": annotates the side of the preceding
      // line. After an add (or shared ctx) ⇒ the NEW image has no trailing \n.
      if (prevType === "add" || prevType === "ctx") noNlOnAdd = true;
      continue;
    }
    if (line.startsWith("+")) { cur.lines.push({ type: "add", text: line.slice(1), newLn }); newLn++; adds++; prevType = "add"; }
    else if (line.startsWith("-")) { cur.lines.push({ type: "del", text: line.slice(1), oldLn }); oldLn++; dels++; prevType = "del"; }
    else { cur.lines.push({ type: "ctx", text: line.slice(1), oldLn, newLn }); oldLn++; newLn++; prevType = "ctx"; }
    if (hunks.length >= 50) break; // bound pathological outputs
  }
  return {
    path: rel, status: "modified", hunks, additions: adds, deletions: dels,
    ...(noNlOnAdd ? { noTrailingNewline: true } : {}),
    summary: `--- ${rel} (+${adds} −${dels}) ---\n${hunks.map((h) => h.header).join("\n")}`,
  };
}

/**
 * Apply only selected hunks. We apply per-file sequentially, recomputing an
 * offset because earlier accepted hunks shift line numbers for later ones.
 * For added files, any accepted hunk means the whole content lands.
 */
export function applyProposalPartial(
  proposal: ChangeProposal,
  projectRoot: string,
  acceptedHunks: Record<string, number[]> | undefined,
  rejectAll: boolean,
): ApplyResult {
  const out: ApplyResult = { appliedFiles: [], appliedCount: 0, skipped: [] };

  for (const fd of proposal.files) {
    const abs = path.resolve(projectRoot, fd.path);
    if (!inRoot(projectRoot, abs)) {
      out.skipped.push({ path: fd.path, hunkIndex: -1, reason: "path outside workspace" });
      continue;
    }
    if (!realInRoot(projectRoot, abs)) {
      out.skipped.push({ path: fd.path, hunkIndex: -1, reason: "path escapes workspace via symlink" });
      continue;
    }
    const wanted: Set<number> = rejectAll ? new Set() : new Set(acceptedHunks?.[fd.path] ?? []);
    // B12: "accept everything" is an explicit mode that arrives as
    // `acceptedHunks === undefined` OR as an EMPTY RECORD (the HTTP apply route
    // normalizes a missing selection to {}). Either form must touch EVERY file.
    // The old `wanted.size === 0 → continue` conflated accept-all with
    // "nothing selected for this file" and silently applied NOTHING to
    // modified files (only added/deleted landed) — the reported B12 symptom.
    const allAccepted = !rejectAll && (acceptedHunks === undefined || Object.keys(acceptedHunks).length === 0);
    if (!rejectAll && !allAccepted && wanted.size === 0) continue;

    if (fd.status === "added") {
      // Reconstruct full new-file content from the add-lines of accepted
      // hunks. appliedCount is PER HUNK, not per file: the caller compares it
      // against the proposal's total hunk count to pick "applied" vs
      // "partially-applied", so a 3-hunk added file must report 3 or
      // accept-all would land as a lie ("partially-applied").
      const lines: string[] = [];
      let appliedHunks = 0;
      for (const h of fd.hunks) {
        const accepted = allAccepted || wanted.has(h.hunkIndex);
        if (!accepted) continue;
        if (!hunkLinesValid(h)) {
          out.skipped.push({ path: fd.path, hunkIndex: h.hunkIndex, reason: "malformed hunk" });
          continue;
        }
        for (const l of h.lines) if (l.type === "add") lines.push(l.text);
        appliedHunks++;
      }
      if (appliedHunks > 0) {
        // Line arrays carry content without terminators — restore the trailing
        // newline unless the diff says the image ends without one.
        const body = lines.join("\n");
        const text = lines.length > 0 && !fd.noTrailingNewline ? `${body}\n` : body;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        out.appliedFiles.push(fd.path);
        out.appliedCount += appliedHunks;
      }
      continue;
    }

    if (fd.status === "deleted") {
      if (allAccepted || wanted.size > 0) {
        try {
          fs.rmSync(abs);
          out.appliedFiles.push(fd.path);
          out.appliedCount++;
        } catch (e) {
          out.skipped.push({ path: fd.path, hunkIndex: -1, reason: String(e) });
        }
      }
      continue;
    }

    // modified: splice accepted hunks into old file honoring context anchors
    let lines: string[];
    try {
      lines = readLines(abs);
    } catch {
      out.skipped.push({ path: fd.path, hunkIndex: -1, reason: "file missing" });
      continue;
    }
    let offset = 0;
    let touched = false;
    for (const h of [...fd.hunks].sort((a, b) => firstOld(a) - firstOld(b))) {
      // B12: accept-ALL is a real mode here too — the modified branch used to
      // demand an explicit hunk selection, so "accept all" silently applied
      // nothing to modified files (only added/deleted landed).
      const accepted = allAccepted || wanted.has(h.hunkIndex);
      if (!accepted) continue; // rejected hunks must NOT drift-check or shift offsets

      // Malformed hunks are skipped, never fatal — a 500 here used to take
      // the whole apply route down with it.
      if (!hunkLinesValid(h)) {
        out.skipped.push({ path: fd.path, hunkIndex: h.hunkIndex, reason: "malformed hunk" });
        continue;
      }

      // The hunk's first old-file line is its first del-or-ctx line — that is
      // what lines[anchor] must match (firstOld() returns exactly it).
      const lead = h.lines.find((l) => l.type === "del" || l.type === "ctx");
      let anchor = firstOld(h) > 0 ? firstOld(h) - 1 + offset : 0; // 0-based

      const newImage = h.lines.filter((l) => l.type !== "del").map((l) => l.text);
      const oldImage = h.lines.filter((l) => l.type !== "add").map((l) => l.text);

      // Idempotent re-apply (critique #3): the new image already sits at the
      // anchor while the old image is gone ⇒ hunk was applied earlier; skip
      // without touching the file but count it as in-effect.
      const runMatches = (want: string[]): boolean =>
        want.length === 0 ||
        want.every((t, i) => {
          const ln = lines[anchor + i];
          return ln !== undefined && fuzzyLineEq(ln, t);
        });
      if (runMatches(newImage) && !runMatches(oldImage)) {
        out.appliedCount++;
        continue;
      }

      // Drift correction: re-anchor by scanning ±40 lines around expectation.
      const anchorLine = lines[anchor];
      if (lead && lead.text !== "" && (anchorLine === undefined || !fuzzyLineEq(anchorLine, lead.text))) {
        const found = findAnchor(lines, lead.text, anchor);
        if (found === -1) {
          out.skipped.push({ path: fd.path, hunkIndex: h.hunkIndex, reason: "context drifted" });
          continue;
        }
        offset += found - anchor;
        anchor = found; // THE fix: splice must use the corrected position
      }

      // Strict walk: consume exactly the hunk's old span (ctx+del), rebuild
      // its new image (ctx verbatim + adds). Handles ctx-before-del hunks the
      // naive splice(anchor, delCount, adds) mangled.
      let pos = anchor;
      const rebuilt: string[] = [];
      let failed = false;
      for (const l of h.lines) {
        if (l.type === "add") { rebuilt.push(l.text); continue; }
        const cur = lines[pos];
        if (cur === undefined || !fuzzyLineEq(cur, l.text)) { failed = true; break; }
        if (l.type === "ctx") rebuilt.push(cur);
        pos++;
      }
      if (failed) {
        // second-chance idempotency: new image present mid-hunk (applied with
        // different surrounding edits) → treat as done rather than corrupt.
        if (newImage.length > 0 && newImage.every((t, i) => { const ln = lines[anchor + i]; return ln !== undefined && fuzzyLineEq(ln, t); })) {
          out.appliedCount++;
          continue;
        }
        out.skipped.push({ path: fd.path, hunkIndex: h.hunkIndex, reason: "context drifted" });
        continue;
      }
      lines.splice(anchor, pos - anchor, ...rebuilt);
      offset += rebuilt.length - (pos - anchor);
      touched = true;
      out.appliedCount++;
    }
    if (touched) {
      writeLines(abs, lines);
      out.appliedFiles.push(fd.path);
    }
  }
  return out;
}

function firstOld(h: FileDiff["hunks"][number]): number {
  if (!Array.isArray(h.lines)) return 0; // malformed shape sorts as "first"
  for (const l of h.lines) {
    if (l !== null && typeof l === "object" && l.oldLn != null) return l.oldLn;
  }
  return 0;
}

function fuzzyLineEq(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Hunk lines may be malformed (older persisted proposals, or model-shaped
 *  FileDiffs where `lines` entries degraded to bare strings). Touching such
 *  an entry used to throw deep inside fuzzyLineEq → HTTP 500. Validate up
 *  front and treat the whole hunk as skippable instead. */
function hunkLinesValid(h: FileDiff["hunks"][number]): boolean {
  return (
    Array.isArray(h.lines) &&
    h.lines.every(
      (l) =>
        l !== null &&
        typeof l === "object" &&
        (l.type === "add" || l.type === "del" || l.type === "ctx") &&
        typeof l.text === "string",
    )
  );
}

function findAnchor(lines: string[], text: string, near: number): number {
  for (let d = 0; d < 40; d++) {
    for (const i of [near + d, near - d]) {
      const ln = lines[i];
      if (i >= 0 && i < lines.length && ln !== undefined && fuzzyLineEq(ln, text)) return i;
    }
  }
  return -1;
}
