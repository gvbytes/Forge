// Test environment shim: point DATA_DIR at a throwaway temp dir BEFORE any
// module under test loads (config.ts reads ENGINE_DATA at import time, and
// ESM evaluates imports in declaration order — so every test file must import
// this module FIRST).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-data-"));
process.env.ENGINE_DATA = TEST_DATA_DIR;
// index.ts binds ENGINE_PORT at import time; tests that import the app must
// not collide with a real engine on 4100 → ephemeral port (0 = OS-assigned).
process.env.ENGINE_PORT ??= "0";

/**
 * Pristine `fetch`, captured before any test file can replace it.
 *
 * bun runs every test file in ONE process, so a file that assigns
 * `globalThis.fetch = mock` without restoring leaks that mock into whichever
 * file runs next. That is what made stream.test.ts fail in the full run while
 * passing in isolation: websearch/webscrape installed mocks and never put the
 * real one back, so chatRace() saw another file's canned response.
 *
 * Any test file that stubs fetch must `afterEach(restoreFetch)`.
 */
const PRISTINE_FETCH = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = PRISTINE_FETCH;
}
