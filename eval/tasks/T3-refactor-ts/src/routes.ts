// HTTP route handlers for the catalog service.
//
// NOTE: the pagination block inside the three list handlers below is
// copy-pasted between them (it grew organically). Behaviour must remain
// byte-for-byte identical if this code is ever consolidated.
import { CUSTOMERS, ORDERS, PRODUCTS } from "./data.js";
import type { ListBody, Query, Reply, Row } from "./types.js";

function listBody(items: Row[], page: number, size: number, total: number): ListBody {
  return { items, page, size, total };
}

export function listOrders(q: Query): Reply {
  const page = q.page ?? 1;
  const size = q.size ?? 20;
  const start = (page - 1) * size;
  const items = ORDERS.slice(start, start + size);
  return { status: 200, body: listBody(items, page, size, ORDERS.length) };
}

export function listCustomers(q: Query): Reply {
  const page = q.page ?? 1;
  const size = q.size ?? 20;
  const start = (page - 1) * size;
  const items = CUSTOMERS.slice(start, start + size);
  return { status: 200, body: listBody(items, page, size, CUSTOMERS.length) };
}

export function listProducts(q: Query): Reply {
  const page = q.page ?? 1;
  const size = q.size ?? 20;
  const start = (page - 1) * size;
  const items = PRODUCTS.slice(start, start + size);
  return { status: 200, body: listBody(items, page, size, PRODUCTS.length) };
}

export function handle(path: string, q: Query = {}): Reply {
  switch (path) {
    case "/orders":
      return listOrders(q);
    case "/customers":
      return listCustomers(q);
    case "/products":
      return listProducts(q);
    default:
      return { status: 404, body: { error: `unknown route ${path}` } };
  }
}
