/**
 * FS routes test (jailed file-mutation API).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createFsRoutes, mapFsError, type FsEvent } from "../src/fs";
import { createRouterApp } from "../src/index";
import { Telemetry } from "../src/telemetry";

const tmpTop = mkdtempSync(join(tmpdir(), "agent-fs-test-"));
const outsideDir = join(tmpTop, "outside");
mkdirSync(outsideDir, { recursive: true });
writeFileSync(join(outsideDir, "secret.txt"), "TOP SECRET");

const realJailParent = join(tmpTop, "real-jail-parent");
const linkParent = join(tmpTop, "link-jail-parent");
mkdirSync(realJailParent, { recursive: true });
symlinkSync(realJailParent, linkParent, "dir");
const jail = join(linkParent, "workspace");
const jailReal = join(realJailParent, "workspace");
mkdirSync(jailReal, { recursive: true });

const telemetry = new Telemetry(join(tmpTop, "fs.db"));
const app = new Hono();
app.route("/", createFsRoutes({ telemetry }));

const appNoTool = new Hono();
appNoTool.route("/", createFsRoutes({ telemetry, which: () => null }));

const routerApp = createRouterApp({ dbPath: join(tmpTop, "fssec-origin.db") });

function post(pathname: string, body: unknown, a: Hono = app): Promise<Response> {
  return Promise.resolve(
    a.request(pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function infoQuery(p: string): string {
  return `/fs/info?root=${encodeURIComponent(jail)}&path=${encodeURIComponent(p)}`;
}

function cleanTrash(names: string[]): void {
  const base = join(homedir(), ".local", "share", "Trash");
  for (const name of names) {
    try {
      rmSync(join(base, "files", name), { recursive: true, force: true });
      rmSync(join(base, "info", `${name}.trashinfo`), { force: true });
    } catch {
      /* ignore */
    }
  }
}

afterAll(() => {
  telemetry.close();
  routerApp.telemetry.close();
  cleanTrash(["agent-fs-trash-me.txt"]);
  rmSync(tmpTop, { recursive: true, force: true });
});

describe("fs jail security", () => {
  test("../ traversal is rejected with 403 on every endpoint family", async () => {
    const w = await post("/fs/write", { root: jail, path: "../escaped.txt", content: "nope" });
    expect(w.status).toBe(403);
    expect(((await w.json()) as { error: string }).error).toBe("outside_root");
    expect(existsSync(join(realJailParent, "escaped.txt"))).toBe(false);
    expect(existsSync(join(tmpTop, "escaped.txt"))).toBe(false);

    const deepEscape = await post("/fs/mkdir", { root: jail, path: "sub/../../evil" });
    expect(deepEscape.status).toBe(403);

    expect((await post("/fs/touch", { root: jail, path: ".." })).status).toBe(403);

    const infoEsc = await app.request(infoQuery("../outside"));
    expect(infoEsc.status).toBe(403);
  });

  test("in-jail symlinks pointing outside cannot be written through", async () => {
    symlinkSync(join(outsideDir, "secret.txt"), join(jailReal, "leak.txt"));
    const viaFileLink = await post("/fs/write", { root: jail, path: "leak.txt", content: "pwned" });
    expect(viaFileLink.status).toBe(403);
    expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("TOP SECRET");

    symlinkSync(outsideDir, join(jailReal, "leakdir"));
    const viaDirLink = await post("/fs/write", { root: jail, path: "leakdir/inner.txt", content: "pwned" });
    expect(viaDirLink.status).toBe(403);
    expect(existsSync(join(outsideDir, "inner.txt"))).toBe(false);

    symlinkSync(join(outsideDir, "never-created"), join(jailReal, "dangling"));
    const viaDangling = await post("/fs/write", { root: jail, path: "dangling", content: "x" });
    expect(viaDangling.status).toBe(403);
  });

  test("NUL bytes and bad roots are rejected before touching the filesystem", async () => {
    expect((await post("/fs/write", { root: jail, path: "a\0b", content: "x" })).status).toBe(400);

    const relRoot = await post("/fs/mkdir", { root: "relative/path", path: "x" });
    expect(relRoot.status).toBe(400);
    expect(((await relRoot.json()) as { error: string }).error).toBe("root_must_be_absolute");

    const missingRoot = await post("/fs/mkdir", { root: join(tmpTop, "does-not-exist"), path: "x" });
    expect(missingRoot.status).toBe(400);
    expect(((await missingRoot.json()) as { error: string }).error).toBe("invalid_root");

    const fileRoot = await post("/fs/touch", { root: join(outsideDir, "secret.txt"), path: "x" });
    expect(fileRoot.status).toBe(400);

    const noPath = await post("/fs/write", { root: jail, content: "x" });
    expect(noPath.status).toBe(400);
  });
});

describe("fs mutations", () => {
  test("mkdir: recursive creates nested dirs; non-recursive without parent fails", async () => {
    const ok = await post("/fs/mkdir", { root: jail, path: "proj/src/deep", recursive: true });
    expect(ok.status).toBe(200);
    expect(statSync(join(jailReal, "proj/src/deep")).isDirectory()).toBe(true);

    expect((await post("/fs/mkdir", { root: jail, path: "proj/src/deep" })).status).toBe(200);

    const strict = await post("/fs/mkdir", { root: jail, path: "no/such/parent", recursive: false });
    expect(strict.status).toBe(404);
    expect(((await strict.json()) as { error: string }).error).toBe("not_found");
    expect(existsSync(join(jailReal, "no"))).toBe(false);
  });

  test("touch: creates an empty file; duplicate touch fails with 409", async () => {
    const ok = await post("/fs/touch", { root: jail, path: "proj/newfile.ts" });
    expect(ok.status).toBe(200);
    expect(statSync(join(jailReal, "proj/newfile.ts")).size).toBe(0);

    const dup = await post("/fs/touch", { root: jail, path: "proj/newfile.ts" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("already_exists");
  });

  test("write: utf8 roundtrip preserves unicode; overwrite allowed; parents must exist", async () => {
    const payload = "héllo 🚀 agent\nline two";
    const w1 = await post("/fs/write", { root: jail, path: "proj/readme.md", content: payload });
    expect(w1.status).toBe(200);
    expect(readFileSync(join(jailReal, "proj/readme.md"), "utf8")).toBe(payload);

    const w2 = await post("/fs/write", { root: jail, path: "proj/readme.md", content: "v2" });
    expect(w2.status).toBe(200);
    expect(readFileSync(join(jailReal, "proj/readme.md"), "utf8")).toBe("v2");

    expect(
      (await post("/fs/write", { root: jail, path: "proj/x", content: "x", encoding: "hex" })).status,
    ).toBe(400);

    const orphan = await post("/fs/write", { root: jail, path: "ghost-dir/f.txt", content: "x" });
    expect(orphan.status).toBe(404);
    expect(existsSync(join(jailReal, "ghost-dir"))).toBe(false);
  });

  test("write: base64 roundtrip preserves binary bytes exactly", async () => {
    expect((await post("/fs/mkdir", { root: jail, path: "blob" })).status).toBe(200);
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    const res = await post("/fs/write", {
      root: jail,
      path: "blob/data.bin",
      content: binary.toString("base64"),
      encoding: "base64",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bytes: number };
    expect(json.bytes).toBe(binary.length);
    const back = readFileSync(join(jailReal, "blob/data.bin"));
    expect(back.equals(binary)).toBe(true);
  });

  test("rename: moves within the jail; refuses existing target and missing source", async () => {
    await post("/fs/touch", { root: jail, path: "proj/old-name.ts" });
    const mv = await post("/fs/rename", { root: jail, from: "proj/old-name.ts", to: "proj/new-name.ts" });
    expect(mv.status).toBe(200);
    expect(existsSync(join(jailReal, "proj/old-name.ts"))).toBe(false);
    expect(existsSync(join(jailReal, "proj/new-name.ts"))).toBe(true);

    await post("/fs/touch", { root: jail, path: "proj/collide.ts" });
    const clash = await post("/fs/rename", {
      root: jail,
      from: "proj/new-name.ts",
      to: "proj/collide.ts",
    });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toBe("target_exists");

    const ghost = await post("/fs/rename", { root: jail, from: "proj/ghost.ts", to: "proj/any.ts" });
    expect(ghost.status).toBe(404);

    const out = await post("/fs/rename", { root: jail, from: "proj/new-name.ts", to: "../../stolen" });
    expect(out.status).toBe(403);
  });

  test("delete permanent=true hard-deletes files and nested trees, batches included", async () => {
    await post("/fs/mkdir", { root: jail, path: "tmpdir/nested", recursive: true });
    await post("/fs/write", { root: jail, path: "tmpdir/nested/file.txt", content: "bye" });
    const del = await post("/fs/delete", { root: jail, paths: ["tmpdir"], permanent: true });
    expect(del.status).toBe(200);
    const json = (await del.json()) as { mode: string; removed: string[] };
    expect(json.mode).toBe("permanent");
    expect(json.removed).toEqual(["tmpdir"]);
    expect(existsSync(join(jailReal, "tmpdir"))).toBe(false);

    await post("/fs/touch", { root: jail, path: "m1" });
    await post("/fs/touch", { root: jail, path: "m2" });
    const batch = await post("/fs/delete", { root: jail, paths: ["m1", "m2"], permanent: true });
    expect(batch.status).toBe(200);
    expect(existsSync(join(jailReal, "m1"))).toBe(false);
    expect(existsSync(join(jailReal, "m2"))).toBe(false);
  });

  test("delete default: no trash tool -> 400 no-trash-tool + hint; with tool -> trashed", async () => {
    await post("/fs/touch", { root: jail, path: "doomed.txt" });
    const refused = await post("/fs/delete", { root: jail, paths: ["doomed.txt"] }, appNoTool);
    expect(refused.status).toBe(400);
    const refJson = (await refused.json()) as { error: string; hint?: string };
    expect(refJson.error).toBe("no-trash-tool");
    expect(refJson.hint).toContain("permanent=true");
    expect(existsSync(join(jailReal, "doomed.txt"))).toBe(true);

    await post("/fs/touch", { root: jail, path: "agent-fs-trash-me.txt" });
    const res = await post("/fs/delete", { root: jail, paths: ["agent-fs-trash-me.txt"] });
    expect([200, 400, 500]).toContain(res.status);
    if (res.status === 200) {
      const json = (await res.json()) as { mode: string };
      expect(json.mode).toBe("trash");
      expect(existsSync(join(jailReal, "agent-fs-trash-me.txt"))).toBe(false);
    } else if (res.status === 400) {
      expect(((await res.json()) as { error: string }).error).toBe("no-trash-tool");
    } else {
      expect(((await res.json()) as { error: string }).error).toBe("trash_failed");
    }

    expect((await post("/fs/delete", { root: jail, paths: [] })).status).toBe(400);
  });

  test("GET /fs/info reports size/mtime/isDir/basename; 404 when missing", async () => {
    await post("/fs/mkdir", { root: jail, path: "info" });
    await post("/fs/write", { root: jail, path: "info/me.txt", content: "12345" });

    const file = await app.request(infoQuery("info/me.txt"));
    expect(file.status).toBe(200);
    const fj = (await file.json()) as { size: number; mtime: number; isDir: boolean; basename: string };
    expect(fj.size).toBe(5);
    expect(fj.isDir).toBe(false);
    expect(fj.basename).toBe("me.txt");
    expect(typeof fj.mtime).toBe("number");
    expect(fj.mtime).toBeLessThanOrEqual(Date.now() + 1000);

    const dir = await app.request(infoQuery("info"));
    expect(dir.status).toBe(200);
    const dj = (await dir.json()) as { isDir: boolean; basename: string };
    expect(dj.isDir).toBe(true);
    expect(dj.basename).toBe("info");

    expect((await app.request(infoQuery("info/nope.txt"))).status).toBe(404);
    expect((await app.request("/fs/info?path=x")).status).toBe(400);
  });

  test("every successful mutation wrote an fs audit trace row; failures did not", async () => {
    const traces = telemetry.listTraces(500).filter((t) => t.kind === "fs");
    const labels = traces.map((t) => t.label);
    for (const op of ["mkdir", "touch", "write", "rename", "delete"]) {
      expect(labels).toContain(op);
    }
    const renameRow = traces.find((t) => t.label === "rename");
    expect(renameRow).toBeDefined();
    const detail = JSON.parse(renameRow!.detail_json ?? "{}") as {
      root: string;
      paths: string[];
      to: string | null;
    };
    expect(detail.root).toBe(jail);
    expect(detail.paths).toEqual(["proj/old-name.ts"]);
    expect(detail.to).toBe("proj/new-name.ts");

    const delRows = traces.filter((t) => t.label === "delete");
    expect(
      delRows.some(
        (t) => (JSON.parse(t.detail_json ?? "{}") as { permanent?: boolean }).permanent === true,
      ),
    ).toBe(true);

    const before = telemetry.listTraces(500).filter((t) => t.kind === "fs").length;
    await post("/fs/touch", { root: jail, path: "proj/newfile.ts" });
    expect(telemetry.listTraces(500).filter((t) => t.kind === "fs").length).toBe(before);
  });

  test("mapped errors are short {error} JSON — never raw stacks", async () => {
    const res = await post("/fs/write", { root: jail, path: "proj", content: "x" });
    expect([400, 500]).toContain(res.status);
    const text = await res.text();
    const json = JSON.parse(text) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeLessThan(40);
    expect(text).not.toContain("at ");
  });
});

describe("origin allowlist middleware", () => {
  function postWithOrigin(pathname: string, body: unknown, origin?: string): Promise<Response> {
    return Promise.resolve(
      routerApp.app.request(pathname, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  test("forged foreign Origin on a mutating request -> 403 origin_not_allowed", async () => {
    const res = await postWithOrigin("/fs/touch", { root: jail, path: "o-forged.txt" }, "http://evil.com");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_not_allowed");
    expect(existsSync(join(jailReal, "o-forged.txt"))).toBe(false);

    const get = await routerApp.app.request("/health", { headers: { origin: "http://evil.com" } });
    expect(get.status).toBe(200);
  });

  test("no-Origin request still works", async () => {
    const res = await postWithOrigin("/fs/touch", { root: jail, path: "o-no-origin.txt" });
    expect(res.status).toBe(200);
    expect(statSync(join(jailReal, "o-no-origin.txt")).isFile()).toBe(true);
  });

  test("allowlisted Origin works; EXTRA_ORIGIN extends the list", async () => {
    const ok = await postWithOrigin("/fs/touch", { root: jail, path: "o-allowed.txt" }, "http://localhost:4444");
    expect(ok.status).toBe(200);

    const ok5173 = await postWithOrigin("/fs/touch", { root: jail, path: "o-allowed-5173.txt" }, "http://localhost:5173");
    expect(ok5173.status).toBe(200);

    process.env["EXTRA_ORIGIN"] = "https://ide.example.dev, http://127.0.0.1:5555";
    try {
      const extraApp = createRouterApp({ dbPath: join(tmpTop, "fssec-extra-origin.db") });
      const extra = await extraApp.app.request("/fs/touch", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://ide.example.dev" },
        body: JSON.stringify({ root: jail, path: "o-extra.txt" }),
      });
      expect(extra.status).toBe(200);
      extraApp.telemetry.close();
    } finally {
      delete process.env["EXTRA_ORIGIN"];
    }
  });
});

describe("root self-destruction guard", () => {
  test("delete rejects paths resolving to the jail root; mixed batch refuses atomically", async () => {
    const del = await post("/fs/delete", { root: jail, paths: ["."], permanent: true });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toBe("root_not_deletable");
    expect(existsSync(jailReal)).toBe(true);

    await post("/fs/touch", { root: jail, path: "keepme.txt" });
    const mixed = await post("/fs/delete", { root: jail, paths: ["keepme.txt", "."], permanent: true });
    expect(mixed.status).toBe(400);
    expect(existsSync(join(jailReal, "keepme.txt"))).toBe(true);
  });

  test("rename onto the jail root is refused", async () => {
    await post("/fs/touch", { root: jail, path: "proj/moveroot-src.txt" });
    const mv = await post("/fs/rename", { root: jail, from: "proj/moveroot-src.txt", to: "." });
    expect(mv.status).toBe(400);
    expect(((await mv.json()) as { error: string }).error).toBe("root_not_deletable");
    expect(existsSync(join(jailReal, "proj/moveroot-src.txt"))).toBe(true);
  });
});

describe("fs events SSE", () => {
  function parseFrame(raw: string): FsEvent {
    expect(raw.startsWith("data: ")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(true);
    return JSON.parse(raw.slice("data: ".length)) as FsEvent;
  }

  async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder): Promise<FsEvent> {
    let buffered = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out waiting for an SSE frame")), 2_000);
          }),
        ]);
        clearTimeout(timer);
        timer = undefined;
        expect(done).toBe(false);
        buffered += decoder.decode(value, { stream: true });
        const end = buffered.indexOf("\n\n");
        if (end !== -1) return parseFrame(buffered.slice(0, end + 2));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  test("every successful mutation broadcasts one {op, root, paths} frame", async () => {
    await post("/fs/mkdir", { root: jail, path: "evt", recursive: true });
    const res = await app.request("/fs/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    try {
      await post("/fs/touch", { root: jail, path: "evt/one.txt" });
      const touch = await readFrame(reader, decoder);
      expect(touch.op).toBe("touch");
      expect(touch.root).toBe(jail);
      expect(touch.paths).toEqual(["evt/one.txt"]);

      await post("/fs/write", { root: jail, path: "evt/one.txt", content: "x" });
      const write = await readFrame(reader, decoder);
      expect(write.op).toBe("write");
      expect(write.paths).toEqual(["evt/one.txt"]);

      await post("/fs/mkdir", { root: jail, path: "evt/dir" });
      const mkdir = await readFrame(reader, decoder);
      expect(mkdir.op).toBe("mkdir");

      await post("/fs/rename", { root: jail, from: "evt/one.txt", to: "evt/two.txt" });
      const rename = await readFrame(reader, decoder);
      expect(rename.op).toBe("rename");
      expect(rename.paths).toEqual(["evt/one.txt", "evt/two.txt"]);

      await post("/fs/delete", { root: jail, paths: ["evt/two.txt", "evt/dir"], permanent: true });
      const del = await readFrame(reader, decoder);
      expect(del.op).toBe("delete");
      expect(del.paths).toEqual(["evt/two.txt", "evt/dir"]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  test("failed mutations emit no frame; the next success is the FIRST frame", async () => {
    const res = await app.request("/fs/events");
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    try {
      const dup = await post("/fs/touch", { root: jail, path: "proj/newfile.ts" });
      expect(dup.status).toBe(409);
      await post("/fs/touch", { root: jail, path: "evt/first-success.txt" });

      const frame = await readFrame(reader, decoder);
      expect(frame.op).toBe("touch");
      expect(frame.paths).toEqual(["evt/first-success.txt"]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
});

describe("fs errno mapping", () => {
  test("rename of a directory into its own subtree answers 400 invalid_rename, never internal_error", async () => {
    mkdirSync(join(jailReal, "selfchild"), { recursive: true });
    const res = await post("/fs/rename", { root: jail, from: "selfchild", to: "selfchild/sub2" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_rename");
    expect(body.error).not.toBe("internal_error");
    expect(existsSync(join(jailReal, "selfchild"))).toBe(true);
  });

  test("trailing-slash spellings normalize before the syscall — same invalid_rename", async () => {
    const res = await post("/fs/rename", { root: `${jail}/`, from: "selfchild/", to: "selfchild/sub2/" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_rename");
  });

  test("names over 255 bytes answer 400 name_too_long on create endpoints", async () => {
    const longName = "x".repeat(300);
    for (const route of ["/fs/touch", "/fs/mkdir"]) {
      const res = await post(route, { root: jail, path: longName });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("name_too_long");
    }
  });

  test("mapFsError covers every realistic errno class with named codes", () => {
    const codeOf = (e: unknown) => ((mapFsError(e).body as { error: string })["error"]);
    expect(codeOf({ code: "EINVAL" })).toBe("invalid_rename");
    expect(codeOf({ code: "ENAMETOOLONG" })).toBe("name_too_long");
    expect(codeOf({ code: "ENOTEMPTY" })).toBe("directory_not_empty");
    expect(codeOf({ code: "EEXIST" })).toBe("already_exists");
    expect(codeOf({ code: "ENOENT" })).toBe("not_found");
    expect(codeOf({ code: "EPERM" })).toBe("permission_denied");
    expect(codeOf({ code: "EXDEV" })).toBe("io_error");
    expect(codeOf({})).toBe("io_error");
  });
});
