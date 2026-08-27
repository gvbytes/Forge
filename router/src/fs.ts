/**
 * FS routes: jailed REST file-mutation API for the web IDE.
 *
 * The engine only READS through its own tools; this sub-app is how the IDE
 * creates/moves/deletes workspace files directly:
 *
 *   POST /fs/mkdir   {root, path, recursive?=true}
 *   POST /fs/touch   {root, path}                    (fails if exists)
 *   POST /fs/write   {root, path, content, encoding?="utf8"|"base64"}
 *   POST /fs/rename  {root, from, to}
 *   POST /fs/delete  {root, paths[], permanent?=false}   (default = OS trash)
 *   GET  /fs/info?root=&path=                        -> {size,mtime,isDir,basename}
 *   GET  /fs/events                                  -> SSE stream of mutation
 *                                    frames `data: {"op","root","paths"}\n\n`
 *                                    so every open IDE surface (including other
 *                                    browser tabs sharing this router) can
 *                                    refresh its tree when files change.
 *
 * Security model (mandatory jail):
 *   - every target resolves via resolve(join(root, rel)) and must stay inside
 *     realpath(root) (+sep) — traversal (`../`) AND symlink escapes are
 *     rejected with 403 {"error":"outside_root"};
 *   - `root` itself must be an existing ABSOLUTE directory;
 *   - delete/rename never operate ON the jail root (400 {"error":
 *     "root_not_deletable"}) — spellings like "." resolve exactly to it;
 *   - NUL bytes anywhere in an input segment are rejected;
 *   - handlers never leak stacks — errors map to short {error} JSON.
 *
 * Delete defaults to the OS trash (`gio trash`, then the `trash` binary,
 * PATH lookup); when neither tool exists the request is refused with
 * 400 {"error":"no-trash-tool"} unless permanent=true hard-deletes.
 *
 * Audit: every successful mutation writes one telemetry trace row
 * (kind="fs", label=<op>, detail_json={root,paths,to}) so dashboard trace
 * views show file activity alongside route/attempt/watchdog rows.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Telemetry } from "./telemetry";

export interface FsRoutesOptions {
  /** Shared telemetry handle — fs mutations land in the traces table. */
  telemetry: Telemetry;
  /**
   * PATH lookup for trash binaries; defaults to Bun.which. Tests inject a
   * stub to simulate a machine without any trash tool installed.
   */
  which?: (name: string) => string | null;
}

/** One mutation notification, broadcast to every /fs/events subscriber. */
export interface FsEvent {
  op: string;
  root: string;
  paths: string[];
}

type FsSubscriber = (event: FsEvent) => void;

type JsonBody = Record<string, unknown>;
/** Every status this sub-app ever emits (keeps Hono's c.json typed). */
type FsStatus = 400 | 403 | 404 | 409 | 500;

interface Fail {
  ok: false;
  status: FsStatus;
  body: JsonBody;
}
type Prep<T> = { ok: true; value: T } | Fail;

function fail(status: FsStatus, error: string, extra?: JsonBody): Fail {
  return { ok: false, status, body: { error, ...extra } };
}

async function readJsonObject(c: { req: { json(): Promise<unknown> } }): Promise<JsonBody | null> {
  try {
    const v = await c.req.json();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as JsonBody;
    return null;
  } catch {
    return null;
  }
}

/** NUL bytes break syscalls on every platform — reject before anything else. */
function hasNul(v: unknown): boolean {
  return typeof v === "string" && v.includes("\0");
}

/**
 * Validate + canonicalize the jail root: existing absolute directory.
 * Returns both the lexical form (for joining) and the realpath (jail
 * boundary), which differ when ancestors of root are themselves symlinks.
 */
function prepareRoot(root: unknown): Prep<{ lex: string; real: string }> {
  if (typeof root !== "string" || root.length === 0) return fail(400, "root_required");
  if (hasNul(root)) return fail(400, "bad_path");
  if (!isAbsolute(root)) return fail(400, "root_must_be_absolute");
  const lex = resolve(root);
  let st;
  try {
    st = statSync(lex);
  } catch {
    return fail(400, "invalid_root");
  }
  if (!st.isDirectory()) return fail(400, "invalid_root");
  let real = lex;
  try {
    real = realpathSync(lex);
  } catch {
    /* stat already succeeded; keep lexical form as boundary fallback */
  }
  return { ok: true, value: { lex, real } };
}

/**
 * Resolve `rel` inside the jail and verify BOTH boundaries:
 *  1. lexical — resolve(join(root, rel)) must be root or under it;
 *  2. physical — climb to the deepest EXISTING ancestor, realpath it, rebuild
 *     the tail. This catches symlinked directories pointing outside the jail,
 *     which a plain lstat on the final component would miss.
 */
function resolveJailed(root: { lex: string; real: string }, rel: unknown): Prep<string> {
  if (typeof rel !== "string" || rel.length === 0) return fail(400, "path_required");
  if (hasNul(rel)) return fail(400, "bad_path");
  const raw = resolve(join(root.lex, rel));

  // Climb from the raw path up to the first existing component.
  let cur = raw;
  const tail: string[] = [];
  for (;;) {
    if (cur === dirname(cur)) return fail(403, "outside_root"); // walked off "/" — hostile chain
    try {
      lstatSync(cur);
      break; // exists (possibly AS a symlink)
    } catch {
      tail.unshift(basename(cur));
      cur = dirname(cur);
    }
  }
  let realBase: string;
  try {
    realBase = realpathSync(cur); // throws on broken symlinks -> conservative reject
  } catch {
    return fail(403, "outside_root");
  }
  const abs = tail.length > 0 ? resolve(realBase, ...tail) : realBase;
  if (abs !== root.real && !abs.startsWith(root.real + sep)) return fail(403, "outside_root");
  return { ok: true, value: abs };
}

/**
 * Map filesystem errno to short JSON errors — never expose raw stacks.
 */
export function mapFsError(e: unknown): Fail {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "EEXIST":
      return fail(409, "already_exists");
    case "ENOENT":
      return fail(404, "not_found");
    case "ENOTDIR":
      return fail(400, "not_a_directory");
    case "EISDIR":
      return fail(400, "is_a_directory");
    case "ENOTEMPTY":
      return fail(400, "directory_not_empty");
    case "EINVAL":
      return fail(400, "invalid_rename");
    case "ENAMETOOLONG":
      return fail(400, "name_too_long");
    case "EPERM":
    case "EACCES":
      return fail(403, "permission_denied");
    default:
      return fail(500, "io_error");
  }
}

/** One audit row per successful mutation, mirroring watchdog trace writes. */
function audit(
  opts: FsRoutesOptions,
  op: string,
  root: string,
  paths: string[],
  to: string | null,
  extra?: Record<string, unknown>,
): void {
  try {
    opts.telemetry.addTrace({
      ts: Date.now(),
      task: null,
      kind: "fs",
      parent_id: null,
      label: op,
      detail_json: JSON.stringify({ root, paths, to, ...extra }),
    });
  } catch {
    /* auditing must never break the mutation it describes */
  }
}

export function createFsRoutes(opts: FsRoutesOptions): Hono {
  const app = new Hono();
  const which = opts.which ?? ((name: string) => Bun.which(name) || null);

  const subscribers = new Set<FsSubscriber>();
  const publish = (op: string, root: string, paths: string[]): void => {
    const event: FsEvent = { op, root, paths };
    for (const sub of subscribers) {
      try {
        sub(event);
      } catch {
        /* one broken sink must not stop the others */
      }
    }
  };

  app.post("/fs/mkdir", async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const r = prepareRoot(body["root"]);
    if (!r.ok) return c.json(r.body, r.status);
    const p = resolveJailed(r.value, body["path"]);
    if (!p.ok) return c.json(p.body, p.status);
    const recursive = body["recursive"] === undefined ? true : body["recursive"] === true;
    try {
      mkdirSync(p.value, { recursive });
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    audit(opts, "mkdir", r.value.lex, [String(body["path"])], null);
    publish("mkdir", r.value.lex, [String(body["path"])]);
    return c.json({ ok: true, path: body["path"] });
  });

  app.post("/fs/touch", async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const r = prepareRoot(body["root"]);
    if (!r.ok) return c.json(r.body, r.status);
    const p = resolveJailed(r.value, body["path"]);
    if (!p.ok) return c.json(p.body, p.status);
    try {
      const fd = openSync(p.value, "wx");
      closeSync(fd);
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    audit(opts, "touch", r.value.lex, [String(body["path"])], null);
    publish("touch", r.value.lex, [String(body["path"])]);
    return c.json({ ok: true, path: body["path"] });
  });

  app.post("/fs/write", async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const r = prepareRoot(body["root"]);
    if (!r.ok) return c.json(r.body, r.status);
    const encoding = body["encoding"] === undefined ? "utf8" : body["encoding"];
    if (encoding !== "utf8" && encoding !== "base64") return c.json({ error: "bad_encoding" }, 400);
    const content = body["content"];
    if (typeof content !== "string") return c.json({ error: "content_required" }, 400);
    const p = resolveJailed(r.value, body["path"]);
    if (!p.ok) return c.json(p.body, p.status);
    const data =
      encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    try {
      writeFileSync(p.value, data);
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    audit(opts, "write", r.value.lex, [String(body["path"])], null);
    publish("write", r.value.lex, [String(body["path"])]);
    return c.json({ ok: true, path: body["path"], bytes: data.length });
  });

  app.post("/fs/rename", async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const r = prepareRoot(body["root"]);
    if (!r.ok) return c.json(r.body, r.status);
    const from = resolveJailed(r.value, body["from"]);
    if (!from.ok) return c.json(from.body, from.status);
    const to = resolveJailed(r.value, body["to"]);
    if (!to.ok) return c.json(to.body, to.status);
    if (to.value === r.value.real) return c.json({ error: "root_not_deletable" }, 400);
    try {
      lstatSync(from.value);
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    if (existsEntry(to.value)) return c.json({ error: "target_exists" }, 409);
    try {
      renameSync(from.value, to.value);
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    audit(opts, "rename", r.value.lex, [String(body["from"])], String(body["to"]));
    publish("rename", r.value.lex, [String(body["from"]), String(body["to"])]);
    return c.json({ ok: true, from: body["from"], to: body["to"] });
  });

  app.post("/fs/delete", async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const r = prepareRoot(body["root"]);
    if (!r.ok) return c.json(r.body, r.status);
    const rels = body["paths"];
    if (!Array.isArray(rels) || rels.length === 0 || rels.some((x) => typeof x !== "string")) {
      return c.json({ error: "paths_required" }, 400);
    }
    const absList: string[] = [];
    for (const rel of rels) {
      const p = resolveJailed(r.value, rel);
      if (!p.ok) return c.json(p.body, p.status);
      if (p.value === r.value.real) return c.json({ error: "root_not_deletable" }, 400);
      absList.push(p.value);
    }
    const permanent = body["permanent"] === true;

    if (permanent) {
      for (const abs of absList) {
        try {
          rmSync(abs, { recursive: true, force: true });
        } catch (e) {
          const m = mapFsError(e);
          return c.json(m.body, m.status);
        }
      }
      audit(opts, "delete", r.value.lex, rels as string[], null, { permanent: true });
      publish("delete", r.value.lex, rels as string[]);
      return c.json({ ok: true, mode: "permanent", removed: rels });
    }

    const gioBin = which("gio");
    const trashBin = gioBin ? null : which("trash");
    if (!gioBin && !trashBin) {
      return c.json({ error: "no-trash-tool", hint: "pass permanent=true to hard-delete" }, 400);
    }
    const args = gioBin ? ["trash", ...absList] : [...absList];
    const run = spawnSync(gioBin ?? trashBin!, args, { timeout: 15_000 });
    if (run.error || run.status !== 0) return c.json({ error: "trash_failed" }, 500);
    audit(opts, "delete", r.value.lex, rels as string[], null, { permanent: false });
    publish("delete", r.value.lex, rels as string[]);
    return c.json({ ok: true, mode: "trash", removed: rels });
  });

  app.get("/fs/info", (c) => {
    const r = prepareRoot(c.req.query("root"));
    if (!r.ok) return c.json(r.body, r.status);
    const p = resolveJailed(r.value, c.req.query("path"));
    if (!p.ok) return c.json(p.body, p.status);
    let st;
    try {
      st = statSync(p.value);
    } catch (e) {
      const m = mapFsError(e);
      return c.json(m.body, m.status);
    }
    return c.json({
      size: st.size,
      mtime: st.mtimeMs,
      isDir: st.isDirectory(),
      basename: basename(p.value),
    });
  });

  app.get("/fs/events", (c) =>
    streamSSE(c, async (stream) => {
      const sub: FsSubscriber = (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      };
      subscribers.add(sub);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      subscribers.delete(sub);
    }),
  );

  return app;
}

function existsEntry(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
