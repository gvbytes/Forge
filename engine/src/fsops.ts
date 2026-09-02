// Pure filesystem mutation handlers backing the editor FileTree.
// Every op resolves path.resolve(projectRoot, rel) and is jailed to the
// project root (same containment rule as index.ts's inRoot helper).
// Handlers never throw: any failure — jail escape, missing entry, ENOENT —
// comes back as {ok:false,error} so the HTTP layer can 400 it verbatim.
import fs from "node:fs";
import path from "node:path";

export type FsOpResult = { ok: boolean; error?: string };

/** Containment check defeating sibling-prefix escapes (`/p/root-evil` must
 *  not pass for root `/p/root`): exact root or under root+sep only. */
export function inRoot(root: string, abs: string): boolean {
  const r = path.resolve(root) + path.sep;
  return abs === path.resolve(root) || abs.startsWith(r);
}

/** B27: lexical containment is not enough — a symlink INSIDE the project can
 *  point outside. realpath the deepest existing ancestor of the target (the
 *  target itself when it exists) and re-check containment. */
export function realInRoot(root: string, abs: string): boolean {
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

function fail(error: string): FsOpResult {
  return { ok: false, error };
}

function resolveJailed(projectRoot: string, rel: string): string | null {
  const abs = path.resolve(projectRoot, rel);
  return inRoot(projectRoot, abs) ? abs : null;
}

/** Combined lexical + symlink containment gate (B27). */
function jailedReal(projectRoot: string, abs: string): FsOpResult | null {
  return realInRoot(projectRoot, abs) ? null : fail("path escapes workspace via symlink");
}

export function mkdirEntry(projectRoot: string, rel: string): FsOpResult {
  try {
    if (!rel || rel === "/") return fail("empty or root path");
    const abs = resolveJailed(projectRoot, rel);
    if (!abs) return fail("outside workspace");
    const escape = jailedReal(projectRoot, abs);
    if (escape) return escape;
    if (fs.existsSync(abs)) return fail("already exists");
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function newFile(projectRoot: string, rel: string, content?: string): FsOpResult {
  try {
    if (!rel || rel === "/") return fail("empty or root path");
    // r2b-term F-6: the UI used to silently trim "  spaced  " → "spaced".
    // Names with leading/trailing whitespace are now refused verbatim so the
    // user's requested name is never quietly mutated.
    const base = rel.split("/").pop() ?? "";
    if (base.trim() !== base) return fail("name has leading/trailing spaces");
    const abs = resolveJailed(projectRoot, rel);
    if (!abs) return fail("outside workspace");
    const escape = jailedReal(projectRoot, abs);
    if (escape) return escape;
    // "wx" makes the create-if-absent atomic; the pre-check just yields a
    // friendlier message than a raw EEXIST.
    if (fs.existsSync(abs)) return fail("already exists");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? "", { flag: "wx" });
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function renameEntry(projectRoot: string, rel: string, newName: string): FsOpResult {
  try {
    // Same-dir rename only: newName is a bare entry name, never a path.
    if (!newName || newName.includes("/") || newName.includes("..") || newName.length > 255) {
      return fail("invalid name");
    }
    // r2b-term F-6: refuse (don't trim) whitespace-padded names — same rule
    // as newFile, so a rename can never silently rewrite what the user typed.
    if (newName.trim() !== newName) return fail("name has leading/trailing spaces");
    if (!rel || rel === "/") return fail("empty or root path");
    const abs = resolveJailed(projectRoot, rel);
    if (!abs) return fail("outside workspace");
    const escape = jailedReal(projectRoot, abs);
    if (escape) return escape;
    if (!fs.existsSync(abs)) return fail("not found");
    const dest = path.join(path.dirname(abs), newName);
    if (!inRoot(projectRoot, dest)) return fail("outside workspace");
    const destEscape = jailedReal(projectRoot, dest);
    if (destEscape) return destEscape;
    if (fs.existsSync(dest)) return fail("target already exists");
    fs.renameSync(abs, dest);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function deleteEntry(projectRoot: string, rel: string): FsOpResult {
  try {
    if (!rel || rel === "/" || rel === ".") return fail("refusing to delete project root");
    const abs = resolveJailed(projectRoot, rel);
    if (!abs) return fail("outside workspace");
    // Belt & suspenders: "" / "." style rels also land on the exact root here.
    if (abs === path.resolve(projectRoot)) return fail("refusing to delete project root");
    const escape = jailedReal(projectRoot, abs);
    if (escape) return escape;
    if (!fs.existsSync(abs)) return fail("not found");
    fs.rmSync(abs, { recursive: true });
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
