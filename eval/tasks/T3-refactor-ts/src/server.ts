// Entry point: `npx tsx src/server.ts` prints the route table.
// The real deployment fronts these handlers with node:http; the pure
// handler functions in routes.ts are what the test-suite exercises.
import { handle } from "./routes.js";
import type { ListBody, Query } from "./types.js";

export function request(path: string, query: Query = {}): { status: number; json: ListBody | { error: string } } {
  const reply = handle(path, query);
  return { status: reply.status, json: reply.body };
}

function isDirectRun(): boolean {
  return typeof process !== "undefined" && process.argv[1]?.endsWith("server.ts");
}

if (isDirectRun()) {
  for (const route of ["/orders", "/customers", "/products"]) {
    const res = request(route, { page: 1, size: 3 });
    if ("items" in res.json) {
      console.log(`${route} -> ${res.status} (${res.json.items.length}/${res.json.total} shown)`);
    } else {
      console.log(`${route} -> ${res.status} (error)`);
    }
  }
}
