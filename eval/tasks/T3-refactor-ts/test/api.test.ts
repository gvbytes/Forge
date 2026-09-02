// Behavioural test-suite for the catalog service.
// Run with: npx -y tsx test/api.test.ts
//
// The first six checks pin the CURRENT pagination behaviour (they must
// keep passing through any refactor). The last three enforce the
// refactor goal itself: a shared helper in src/paginate.ts that all
// three list routes call, with identical windowing semantics.
import fs from "node:fs";
import assert from "node:assert/strict";

import { CUSTOMERS, ORDERS, PRODUCTS } from "../src/data.js";
import { handle } from "../src/routes.js";
import type { Row } from "../src/types.js";

// The shared helper is optional until the refactor lands; import it
// defensively so its absence is reported as exactly one failure.
type Paginate = <T>(items: readonly T[], page?: number, size?: number) => T[];
let paginate: Paginate | null = null;
let paginateError: unknown = null;
try {
  const mod = (await import("../src/paginate.js")) as { paginate: Paginate };
  paginate = mod.paginate;
} catch (err) {
  paginateError = err;
}

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    failures.push(name);
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`not ok ${passed + failures.length} - ${name}: ${msg}`);
  }
}

const idsOf = (body: { items: Row[] }): number[] => body.items.map((r) => r.id);

check("GET /orders?page=2&size=3 returns rows 4..6", () => {
  const res = handle("/orders", { page: 2, size: 3 });
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res.body as { items: Row[] }), [4, 5, 6]);
});

check("GET /orders defaults to page 1 / size 20 and reports totals", () => {
  const res = handle("/orders", {});
  assert.equal(res.status, 200);
  const body = res.body as { items: Row[]; page: number; size: number; total: number };
  assert.equal(body.items.length, ORDERS.length);
  assert.equal(body.page, 1);
  assert.equal(body.size, 20);
  assert.equal(body.total, ORDERS.length);
});

check("GET /customers?page=1&size=2 windows the collection", () => {
  const res = handle("/customers", { page: 1, size: 2 });
  const body = res.body as { items: Row[]; total: number };
  assert.deepEqual(idsOf(body), [1, 2]);
  assert.equal(body.total, CUSTOMERS.length);
});

check("GET /products?page=2&size=5 returns the short final page", () => {
  const res = handle("/products", { page: 2, size: 5 });
  assert.deepEqual(idsOf(res.body as { items: Row[] }), [6, 7, 8, 9]);
});

check("GET /products?page=9 past the end yields an empty page, not an error", () => {
  const res = handle("/products", { page: 9, size: 5 });
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res.body as { items: Row[] }), []);
});

check("unknown paths yield 404", () => {
  const res = handle("/nope", {});
  assert.equal(res.status, 404);
});

check("shared helper src/paginate.ts exists and exports paginate()", () => {
  assert.ok(paginate, `src/paginate.ts not importable: ${String(paginateError)}`);
});

check("paginate() windows rows identically to the old inline logic", () => {
  assert.ok(paginate, "helper missing");
  assert.deepEqual(paginate(ORDERS, 2, 3).map((r) => r.id), [4, 5, 6]);
  assert.deepEqual(paginate(PRODUCTS, 2, 5).map((r) => r.id), [6, 7, 8, 9]);
  assert.deepEqual(paginate(CUSTOMERS, 9, 5), []);
  assert.equal(paginate(ORDERS).length, ORDERS.length); // defaults page=1 size=20
});

check("all three list routes call the shared helper", () => {
  const source = fs.readFileSync(new URL("../src/routes.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/paginate\s*\(/g)].length;
  assert.ok(
    calls >= 3,
    `expected paginate( to be called at least 3 times in src/routes.ts, found ${calls}`,
  );
});

if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`PASSED: all ${passed} checks`);
