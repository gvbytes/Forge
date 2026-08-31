// Shared helpers for the observability dashboard (tree building, formatting).
// Local to the dashboard folder; does not touch lib/ contracts.
import type { SpanDto } from "../../lib/types";

export type SpanKind = SpanDto["kind"];

export const KIND_META: Record<SpanKind, { icon: string; label: string; color: string }> = {
  agent: { icon: "🤖", label: "agent", color: "#d19a3e" },
  tool: { icon: "⚙️", label: "tool", color: "#2dd4bf" },
  llm: { icon: "🧠", label: "llm", color: "#bc8cff" },
  retrieval: { icon: "🔎", label: "retrieval", color: "#d29922" },
  compaction: { icon: "🗜️", label: "compaction", color: "#f778ba" },
  routing: { icon: "🧭", label: "routing", color: "#ffa657" },
};

export const ALL_KINDS: SpanKind[] = ["agent", "llm", "tool", "retrieval", "compaction", "routing"];

/** A span plus its nested children and subtree rollups. */
export interface SpanNode {
  span: SpanDto;
  children: SpanNode[];
  depth: number;
  agg: { tokensIn: number; tokensOut: number; costUsd: number };
}

/**
 * B5#1: span t0/t1 arrive as epoch SECONDS from the backend; everything in the
 * dashboard reasons in milliseconds. Normalize defensively (values that are
 * already ms-sized pass through, matching fmtAbs's convention).
 */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function spanWall(s: SpanDto): number | null {
  if (s.t1 == null) return null;
  return Math.max(0, toMs(s.t1) - toMs(s.t0));
}

export function spanIsRunning(s: SpanDto): boolean {
  return s.t1 == null || s.status === "running";
}

export type StatusTone = "ok" | "err" | "running" | "neutral";

export function spanStatusTone(s: SpanDto): StatusTone {
  const st = String(s.status ?? "").toLowerCase();
  if (st === "running" || s.t1 == null) return "running";
  if (["ok", "success", "done", "completed", "finished"].includes(st)) return "ok";
  if (["error", "failed", "err"].includes(st)) return "err";
  return "neutral";
}

/**
 * Build a forest from a flat span list.
 * Data-gap tolerant: null parents AND parents missing from the payload become
 * roots; cycles are cut defensively instead of hanging the render.
 */
export function buildSpanTree(spans: SpanDto[]): { roots: SpanNode[]; byId: Map<string, SpanNode> } {
  const ordered = [...spans].sort((a, b) => a.t0 - b.t0);
  const nodes = new Map<string, SpanNode>();
  for (const s of ordered) {
    nodes.set(s.id, {
      span: s,
      children: [],
      depth: 0,
      agg: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
  }
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parent_id ? nodes.get(node.span.parent_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node); // null parent or dangling parent_id
  }
  roots.sort((a, b) => a.span.t0 - b.span.t0);

  // reachability pass: rescue nodes trapped in cycles / weird structures
  const seen = new Set<string>();
  const walk = (n: SpanNode, stack: Set<string>) => {
    if (stack.has(n.span.id)) return;
    stack.add(n.span.id);
    if (!seen.has(n.span.id)) {
      seen.add(n.span.id);
      for (const c of n.children) walk(c, stack);
    }
    stack.delete(n.span.id);
  };
  for (const r of roots) walk(r, new Set());
  for (const n of nodes.values()) {
    if (!seen.has(n.span.id)) {
      roots.push(n);
      walk(n, new Set());
    }
  }

  // depth + subtree aggregates
  const finalize = (n: SpanNode, depth: number): void => {
    n.depth = depth;
    n.children.sort((a, b) => a.span.t0 - b.span.t0);
    let ti = Number(n.span.tokens_in) || 0;
    let to = Number(n.span.tokens_out) || 0;
    let cost = Number(n.span.cost_usd) || 0;
    for (const ch of n.children) {
      finalize(ch, depth + 1);
      ti += ch.agg.tokensIn;
      to += ch.agg.tokensOut;
      cost += ch.agg.costUsd;
    }
    n.agg = { tokensIn: ti, tokensOut: to, costUsd: cost };
  };
  for (const r of roots) finalize(r, 0);

  return { roots, byId: nodes };
}

/** Prune tree to matching spans; ancestors of matches are always kept. */
export function filterTree(roots: SpanNode[], pred: (s: SpanDto) => boolean): SpanNode[] {
  const keep = (n: SpanNode): SpanNode | null => {
    const kids = n.children.map(keep).filter((x): x is SpanNode => x != null);
    if (kids.length > 0 || pred(n.span)) return { ...n, children: kids };
    return null;
  };
  return roots.map(keep).filter((x): x is SpanNode => x != null);
}

/* ---------------- formatting ---------------- */

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtCost(usd: number | null | undefined): string {
  const v = usd ?? 0;
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Absolute timestamp; tolerates epoch-seconds payloads (< 1e12). */
export function fmtAbs(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
