// Seed data for the catalog service (small, deterministic).
import type { Row } from "./types.js";

export const ORDERS: Row[] = [
  { id: 1, name: "order-001" },
  { id: 2, name: "order-002" },
  { id: 3, name: "order-003" },
  { id: 4, name: "order-004" },
  { id: 5, name: "order-005" },
  { id: 6, name: "order-006" },
  { id: 7, name: "order-007" },
];

export const CUSTOMERS: Row[] = [
  { id: 1, name: "Ada Lovelace" },
  { id: 2, name: "Blaise Pascal" },
  { id: 3, name: "Charles Babbage" },
  { id: 4, name: "Donald Knuth" },
  { id: 5, name: "Edsger Dijkstra" },
];

export const PRODUCTS: Row[] = [
  { id: 1, name: "mechanical keyboard" },
  { id: 2, name: "ergonomic mouse" },
  { id: 3, name: "4k monitor" },
  { id: 4, name: "usb-c hub" },
  { id: 5, name: "laptop stand" },
  { id: 6, name: "desk mat" },
  { id: 7, name: "webcam" },
  { id: 8, name: "studio mic" },
  { id: 9, name: "ring light" },
];
