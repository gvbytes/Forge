// Review-diff truncation regression.
// The old naive `clip(patchText, PATCH_CHAR_CAP)` sliced a large multi-file
// diff at the char cap and silently dropped later files, so the reviewer failed
// steps with "file X is missing from the diff" even though X was written
// (observed on a 6-file 3D game build: Game.js truncated out of a >6KB patch).
// truncatePatchForReview must keep EVERY changed path visible — a manifest lists
// all files, full hunks are included while budget lasts, and elided files are
// explicitly marked present-on-disk so the reviewer never reports them missing.
import "./_env.js";
import { describe, expect, test } from "bun:test";
import { truncatePatchForReview } from "../src/orchestrator.js";

function fileChunk(rel: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`).join("\n");
  return [
    `diff --git a/${rel} b/${rel}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${rel}`,
    `@@ -0,0 +1,${lines} @@`,
    body,
  ].join("\n");
}

describe("truncatePatchForReview", () => {
  test("patch under cap is returned unchanged", () => {
    const patch = fileChunk("src/a.js", 5);
    expect(truncatePatchForReview(patch, 100_000)).toBe(patch);
  });

  test("oversized multi-file patch keeps EVERY file path visible", () => {
    const files = ["one.js", "two.js", "three.js", "four.js", "five.js", "six.js"];
    const patch = files.map((f) => fileChunk(`src/${f}`, 60)).join("\n\n");
    const out = truncatePatchForReview(patch, 1200); // force heavy elision
    for (const f of files) {
      expect(out).toContain(`src/${f}`); // no file may vanish from the reviewer's view
    }
  });

  test("elided files are marked present, never 'missing'", () => {
    const files = ["a.js", "b.js", "c.js", "d.js"];
    const patch = files.map((f) => fileChunk(`src/${f}`, 80)).join("\n\n");
    const out = truncatePatchForReview(patch, 1000);
    expect(out).toContain("FILE IS PRESENT");
    expect(out).toContain("do not report missing");
  });

  test("files that fit within budget still expose their hunks", () => {
    const small = fileChunk("src/small.js", 3);
    const big = fileChunk("src/big.js", 200);
    const patch = [small, big].join("\n\n");
    const out = truncatePatchForReview(patch, 800);
    expect(out).toContain("src/small.js");
    expect(out).toContain("src/big.js");
    expect(out).toContain("+const v0 = 0;"); // small file's real hunk survives
  });
});
