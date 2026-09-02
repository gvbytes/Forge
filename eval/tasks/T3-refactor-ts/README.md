# catalog-service

A tiny express-ish TypeScript service exposing three list endpoints over
in-memory seed data. There are no HTTP dependencies: handlers are pure
functions from `{page, size}` queries to reply objects, which keeps the
suite fast and deterministic.

## Routes

| Path          | Query            | Behaviour                                   |
|---------------|------------------|---------------------------------------------|
| `/orders`     | `page`, `size`   | windowed slice of the orders table          |
| `/customers`  | `page`, `size`   | windowed slice of the customers table       |
| `/products`   | `page`, `size`   | windowed slice of the products table        |
| anything else | —                | `404 { error }`                             |

Defaults: `page=1`, `size=20`. Replies look like
`{ items, page, size, total }`.

## Layout

```
src/server.ts     entry point (`npx tsx src/server.ts`)
src/routes.ts     route handlers (pagination is copy-pasted 3x here)
src/data.ts       deterministic seed rows
src/types.ts      shared interfaces
test/api.test.ts  assert-based suite — run with `npx -y tsx test/api.test.ts`
```

## Development notes

The pagination block in `src/routes.ts` was copy-pasted into each list
handler as the API grew; consolidating it into a shared helper is the
agreed next refactor. Whatever changes are made, the wire behaviour
(items, defaults, totals, short final pages) must stay exactly as it is.
