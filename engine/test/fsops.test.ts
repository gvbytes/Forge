// B27: realpath containment in the jailed fs layer (fsops.realInRoot).
import "./_env.js";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realInRoot } from "../src/fsops.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "engine-fsops-test-"));
}

describe("B27 realInRoot symlink containment", () => {
  test("plain in-root path passes", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    expect(realInRoot(root, path.join(root, "a.txt"))).toBe(true);
  });

  test("symlink escaping the root is rejected", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "x");
    const link = path.join(root, "esc.txt");
    fs.symlinkSync(victim, link);
    expect(realInRoot(root, link)).toBe(false);
  });

  test("symlink chain staying inside the root passes", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub/real.txt"), "x");
    const link = path.join(root, "alias.txt");
    fs.symlinkSync(path.join(root, "sub/real.txt"), link);
    expect(realInRoot(root, link)).toBe(true);
  });

  test("directory symlink escaping the root is rejected", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    const link = path.join(root, "escdir");
    fs.symlinkSync(outside, link);
    expect(realInRoot(root, path.join(link, "anything.txt"))).toBe(false);
  });

  test("nonexistent path inside root (nothing to realpath) passes lexically", () => {
    const root = tmpRoot();
    // No such file yet: walk-up finds the root as deepest existing ancestor.
    expect(realInRoot(root, path.join(root, "not/yet/created.txt"))).toBe(true);
  });

  test("nonexistent path whose existing ancestor escapes is rejected", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    const link = path.join(root, "escdir2");
    fs.symlinkSync(outside, link);
    expect(realInRoot(root, path.join(link, "future.txt"))).toBe(false);
  });
});
