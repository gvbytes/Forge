// DashboardView — PS requirement #11: full call hierarchy, drill into any node
// (input/output/thoughts/context/tokens/time), live (3s poll) AND post-hoc.
// Owns: layout + data plumbing. Children are dumb-ish: SpanTree / SpanDetail / TimelineFlame.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpanDto } from "../../lib/types";
import { api } from "../../lib/api";
import { SpanTree } from "./SpanTree";
import { SpanDetail } from "./SpanDetail";
import { TimelineFlame } from "./TimelineFlame";
import {
  ALL_KINDS,
  KIND_META,
  buildSpanTree,
  filterTree,
  fmtCost,
  fmtTokens,
  type SpanKind, toMs } from "./util";
import "../../dashboard.css";

export interface DashboardViewProps {
  taskId: string;
  /** while true, re-fetch spans every 3s; when false the view is static/post-hoc */
  live?: boolean;
}

const POLL_MS = 3000;

export function DashboardView({ taskId, live = true }: DashboardViewProps) {
  const [spans, setSpans] = useState<SpanDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [kindsOff, setKindsOff] = useState<Set<SpanKind>>(new Set());
  const [text, setText] = useState("");

  // ---- data: fetch once, then poll every 3s while live ----
  // The stall-detector reads the span count through a ref so the polling
  // effect itself depends only on [taskId, live]. (Previously spans.length
  // was a dependency: every newly-fetched span re-ran the effect, which
  // re-fired setSelectedId(null) and clobbered the user's live selection.)
  const spansLenRef = useRef(0);
  useEffect(() => {
    spansLenRef.current = spans.length;
  }, [spans.length]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSelectedId(null); // new task → drop stale selection
    const load = async () => {
      try {
        const s = await api.spans(taskId);
        if (!alive) return;
        setSpans(Array.isArray(s) ? s : []);
        setError(null);
      } catch (e: any) {
        if (alive) setError(String(e?.message ?? e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    if (!live) return () => { alive = false; };
    let stallCount = 0;
    let lastCount = 0;
    const iv = setInterval(() => {
      // auto-stop polling once the trace stops growing (task finished)
      if (spansLenRef.current === lastCount) {
        stallCount++;
        if (stallCount >= 4) { clearInterval(iv); return; }  // ~12s stable → stop
      } else {
        stallCount = 0;
        lastCount = spansLenRef.current;
      }
      void load();
    }, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [taskId, live]);

  // ---- derived: tree, counts, filtering ----
  const { roots, byId } = useMemo(() => buildSpanTree(spans), [spans]);

  const kindCounts = useMemo(() => {
    const m = new Map<SpanKind, number>();
    for (const k of ALL_KINDS) m.set(k, 0);
    for (const s of spans) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
    return m;
  }, [spans]);

  const pred = useCallback(
    (s: SpanDto) => {
      if (kindsOff.has(s.kind)) return false;
      if (!text.trim()) return true;
      const q = text.trim().toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.kind.includes(q) ||
        (s.model ?? "").toLowerCase().includes(q) ||
        (s.provider ?? "").toLowerCase().includes(q)
      );
    },
    [kindsOff, text],
  );

  const visibleRoots = useMemo(() => filterTree(roots, pred), [roots, pred]);
  const visibleSpans = useMemo(() => spans.filter(pred), [spans, pred]);

  /**
   * Peak simultaneous step spans, and the speedup that produced.
   *
   * Counted over agent step spans only (`coder · sN`), not every LLM/tool
   * span — a step's children are nested inside it and would inflate the count
   * without meaning anything about scheduling.
   */
  const concurrency = useMemo(() => {
    const steps = spans.filter(
      (s) => /^coder · s\d/.test(s.name ?? "") && Number.isFinite(s.t0) && s.t1 != null,
    );
    if (steps.length < 2) return { peak: 0, speedup: 1, busyMs: 0, wallMs: 0 };
    const edges: { t: number; d: number }[] = [];
    let busyMs = 0;
    for (const s of steps) {
      const a = toMs(s.t0), b = toMs(s.t1!);
      busyMs += Math.max(0, b - a);
      edges.push({ t: a, d: 1 }, { t: b, d: -1 });
    }
    edges.sort((x, y) => x.t - y.t || x.d - y.d);
    let cur = 0, peak = 0;
    for (const e of edges) { cur += e.d; peak = Math.max(peak, cur); }
    const wallMs = Math.max(...steps.map((s) => toMs(s.t1!))) - Math.min(...steps.map((s) => toMs(s.t0)));
    return { peak, speedup: wallMs > 0 ? busyMs / wallMs : 1, busyMs, wallMs };
  }, [spans]);

  const totals = useMemo(
    () =>
      visibleSpans.reduce(
        (acc, s) => ({
          tok: acc.tok + (Number(s.tokens_in) || 0) + (Number(s.tokens_out) || 0),
          cost: acc.cost + (Number(s.cost_usd) || 0),
        }),
        { tok: 0, cost: 0 },
      ),
    [visibleSpans],
  );

  // keep a valid selection; auto-select first root when nothing chosen
  useEffect(() => {
    if (byId.size === 0) {
      if (selectedId != null) setSelectedId(null);
      return;
    }
    if (selectedId == null || !byId.has(selectedId)) {
      setSelectedId(visibleRoots[0]?.span.id ?? null);
    }
  }, [byId, visibleRoots, selectedId]);

  const selectedNode = selectedId != null ? byId.get(selectedId) ?? null : null;

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = () => {
    const ids: string[] = [];
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        if (n.children.length > 0) ids.push(n.span.id);
        walk(n.children);
      }
    };
    walk(roots);
    setCollapsedIds(new Set(ids));
  };

  return (
    <div className="az-dash" data-testid="dashboard">
      {/* filter bar */}
      {/* Concurrency readout.
          Parallel execution was previously only provable by reading the tree
          and adding up step durations by hand. Peak concurrency and the
          speedup ratio state it directly: the sum of step wall-times against
          the task's own wall-time is exactly the work that would have been
          serial. */}
      <div className="az-dash-bar">
        <span className="az-dash-title">
          ▣ Trace <b>{taskId}</b>
        </span>
        <span className={`az-live-tag`} title={live ? "polling every 3s" : "static snapshot"}>
          <span className={`az-dot ${live ? "running" : ""}`} />
          {live ? "LIVE 3s" : "STATIC"}
        </span>
        <span className="az-chip" title="visible spans">{spans.length} spans</span>
        <span className="az-chip tok">Σ{fmtTokens(totals.tok)} tok</span>
        <span className="az-chip cost">{fmtCost(totals.cost)}</span>
        {concurrency.peak > 1 && (
          <span
            className="az-chip par"
            title={`${concurrency.peak} agent steps ran at the same time · ${Math.round(concurrency.busyMs / 1000)}s of step work completed in ${Math.round(concurrency.wallMs / 1000)}s of wall clock`}
          >
            ⇉ {concurrency.peak}× parallel · {concurrency.speedup.toFixed(1)}× faster
          </span>
        )}

        <span className="az-spacer" />

        <div className="az-kindchecks" role="group" aria-label="filter by kind">
          {ALL_KINDS.map((k) => {
            const on = !kindsOff.has(k);
            return (
              <label key={k} className={`az-kindcheck${on ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setKindsOff((prev) => {
                      const next = new Set(prev);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })
                  }
                  style={{ display: "none" }}
                />
                <span className="kdot" style={{ background: KIND_META[k].color }} aria-hidden />
                <span aria-hidden>{KIND_META[k].icon}</span> {KIND_META[k].label}
                <span className="cnt">{kindCounts.get(k)}</span>
              </label>
            );
          })}
        </div>

        <input
          className="az-search"
          placeholder="filter name/model…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <button className="az-minibtn" onClick={() => setCollapsedIds(new Set())}>expand all</button>
        <button className="az-minibtn" onClick={collapseAll}>collapse all</button>
      </div>

      {error && <div className="az-error-strip">spans fetch failed: {error}</div>}
      {loading && spans.length === 0 && !error && (
        <div className="az-empty">loading trace for “{taskId}”…</div>
      )}
      {!loading && spans.length === 0 && !error && (
        <div className="az-empty">
          no spans yet for “{taskId}”
          <br />
          <span style={{ fontSize: 11 }}>the dashboard fills in live as agents/tools/llm calls run</span>
        </div>
      )}

      {/* tree | detail */}
      <div className="az-dash-mid">
        <div className="az-dash-left">
          <SpanTree
            roots={visibleRoots}
            selectedId={selectedId}
            onSelect={setSelectedId}
            collapsedIds={collapsedIds}
            onToggleCollapse={toggleCollapse}
          />
        </div>
        <div className="az-dash-right">
          {selectedNode ? (
            <SpanDetail key={selectedNode.span.id} node={selectedNode} taskId={taskId} onSelectChild={setSelectedId} />
          ) : (
            <div className="az-empty">select a span to inspect its input / output / thoughts / context</div>
          )}
        </div>
      </div>

      {/* timeline */}
      <div style={{ height: 168, flex: "none", borderTop: "1px solid var(--az-border)" }}>
        <TimelineFlame spans={visibleSpans} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}

export default DashboardView;
