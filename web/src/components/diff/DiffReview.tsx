// DiffReview — HITL hunk-level accept/reject (PS requirement #10) with
// sticky Accept-All / Reject-All, aggregate progress, and collapsed summary
// lines for applied/discarded proposals incl. rejected_ranges feedback.
// Ported from Cline's DiffEditRow: per-file +N/−M stats chip (DiffStats) and
// a collapsible diff card so large proposals review like GitHub, not walls.
import { useEffect, useMemo, useState } from "react";
import type { ProposalDto } from "../../lib/types";
import { api } from "../../lib/api";
import { HunkCard } from "./HunkCard";
import "../../dashboard.css";

export interface DiffReviewProps {
  proposals: ProposalDto[];
  /** called with the updated proposal after every successful resolve call */
  onResolved?: (updated: ProposalDto) => void;
}

const CLOSED: ProposalDto["status"][] = ["applied", "discarded"];

/** B6: per-file DTO ids are `${p.id}_${fileIdx}` — recover the file index so
 *  hunk PATCHes can address `${fileIdx}_${hunkIdx}` unambiguously. Single-file
 *  DTOs may carry the bare proposal id → file 0. */
function fileIdxOf(dtoId: string): number {
  const m = /_(\d+)$/.exec(dtoId);
  return m ? Number(m[1]) : 0;
}

function rejectedRanges(p: ProposalDto): string {
  const explicit = (p as any).rejected_ranges;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.join(", ");
  return (p.hunks || [])
    .filter((h) => h.status === "rejected")
    .map((h) => `@${h.oldStart}+${h.oldLines}`)
    .join(", ");
}

function counts(p: ProposalDto) {
  const hunks = p.hunks || [];
  const total = hunks.length;
  const decided = hunks.filter((h) => h.status !== "pending").length;
  const accepted = hunks.filter((h) => h.status === "accepted").length;
  const rejected = hunks.filter((h) => h.status === "rejected").length;
  return { total, decided, accepted, rejected, pending: total - decided };
}

/** Cline-style DiffStats: change volume at a glance ("+42 · −7"). */
function addDel(p: ProposalDto) {
  let add = 0;
  let del = 0;
  for (const h of (p.hunks || []))
    for (const raw of (h.lines || [])) {
      if (raw.startsWith("+")) add += 1;
      else if (raw.startsWith("-")) del += 1;
    }
  return { add, del };
}

function DiffStats({ add, del }: { add: number; del: number }) {
  if (add === 0 && del === 0) return null;
  return (
    <span style={{ whiteSpace: "nowrap", fontSize: "0.85em" }} data-testid="diff-stats">
      {add > 0 && (
        <span style={{ color: "#3fb950", fontWeight: 600 }} title={`${add} added lines`}>
          +{add}
        </span>
      )}
      {add > 0 && del > 0 && <span style={{ opacity: 0.6 }}> · </span>}
      {del > 0 && (
        <span style={{ color: "#f85149", fontWeight: 600 }} title={`${del} removed lines`}>
          −{del}
        </span>
      )}
    </span>
  );
}

/** Tiny pill for the app-shell top bar. Import: `import { DiffReviewBadge } from ".../diff/DiffReview"`. */
export function DiffReviewBadge({ count }: { count: number }) {
  const n = Math.max(0, Math.round(count) || 0);
  return (
    <span className={`az-badge-pill${n === 0 ? " zero" : ""}`} title={`${n} pending hunks awaiting review`}>
      {n}
    </span>
  );
}

function CollapsedSummary({ p }: { p: ProposalDto }) {
  const c = counts(p);
  const d = addDel(p);
  const ranges = rejectedRanges(p);
  return (
    <div className={`az-collapsed-line ${p.status}`} data-testid={`proposal-collapsed-${p.id}`}>
      <span className="mark">{p.status === "applied" ? "✓" : "✗"}</span>
      <span className="az-path">{p.path}</span>
      <span className="az-chip">{p.status}</span>
      <DiffStats add={d.add} del={d.del} />
      <span className="az-hunkcount">
        {c.accepted}/{c.total} hunks applied{c.rejected > 0 ? ` · ${c.rejected} rejected` : ""}
      </span>
      <span className="az-feedback-note">
        feedback to agent: continue around rejected ranges →{" "}
        {ranges ? <b>{ranges}</b> : "none — all hunks accepted"}
      </span>
    </div>
  );
}

export function DiffReview({ proposals, onResolved }: DiffReviewProps) {
  // local mirror so resolve responses (which carry the new status/hunk states)
  // drive the UI immediately even if the parent hasn't re-rendered yet
  const [items, setItems] = useState<ProposalDto[]>(proposals);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => setItems(proposals), [proposals]);

  const totals = useMemo(() => {
    let total = 0;
    let decided = 0;
    for (const p of items) {
      const c = counts(p);
      total += c.total;
      decided += c.decided;
    }
    return { total, decided };
  }, [items]);

  const replaceProposal = (updated: ProposalDto) => {
    setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    onResolved?.(updated);
  };

  const run = async (key: string, fn: () => Promise<ProposalDto>) => {
    setErr(null);
    setBusy((prev) => new Set(prev).add(key));
    try {
      const updated = await fn();
      // response is the full updated ProposalDto; guard against engines that
      // answer a bare {ok} for whole-proposal rejects.
      if (updated && typeof updated.id === "string") replaceProposal(updated);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const decide = (proposalId: string, hunkId: string, accept: boolean, reason?: string) =>
    run(`${proposalId}/${hunkId}`, () => api.resolveHunk(proposalId, hunkId, accept, reason));

  const decideAll = (proposalId: string, accept: boolean) =>
    run(`${proposalId}/all`, () => api.resolveAll(proposalId, accept));

  if (items.length === 0) {
    return (
      <div className="az-diff-root" data-testid="diff-review">
        <div className="az-diff-aggregate">no proposals awaiting review</div>
      </div>
    );
  }

  return (
    <div className="az-diff-root" data-testid="diff-review">
      {/* aggregate progress */}
      <div className="az-diff-aggregate">
        <span>
          {totals.decided}/{totals.total} hunks resolved
        </span>
        <span className="az-progbar">
          <i style={{ width: `${totals.total === 0 ? 0 : (totals.decided / totals.total) * 100}%` }} />
        </span>
        <span className="az-hunkcount">{items.length} proposal{items.length > 1 ? "s" : ""}</span>
      </div>

      {err && <div className="az-error-strip">resolve failed: {err}</div>}

      {items.map((p) => {
        const closed = CLOSED.includes(p.status);
        if (closed) return <div key={p.id} className="az-prop-card"><CollapsedSummary p={p} /></div>;

        const c = counts(p);
        const allBusy = busy.has(`${p.id}/all`);
        const d = addDel(p);
        const isCollapsed = collapsed.has(p.id);
        const fileIdx = fileIdxOf(p.id);
        return (
          <div key={p.id} className="az-prop-card" data-testid={`proposal-${p.id}`}>
            {/* file header */}
            <div className="az-prop-head">
              <button
                className="az-btn"
                style={{ padding: "0 6px", lineHeight: "1.2" }}
                title={isCollapsed ? "expand diff" : "collapse diff"}
                data-testid={`proposal-toggle-${p.id}`}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id);
                    else next.add(p.id);
                    return next;
                  })
                }
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
              <span className="az-path">{p.path}</span>
              <span className="az-chip">{p.status}</span>
              <DiffStats add={d.add} del={d.del} />
              <span className="az-sha" title={`base ${p.base_sha}`}>{(p.base_sha || "").slice(0, 7)}</span>
              <span className="az-spacer" />
              <span className="az-hunkcount">
                {c.decided}/{c.total} resolved
              </span>
            </div>

            {/* hunks */}
            {!isCollapsed && (
              <div className="az-hunk-list">
                {(p.hunks && p.hunks.length > 0) ? (
                  p.hunks.map((h) => (
                    <HunkCard
                      key={h.id}
                      hunk={h}
                      proposalId={p.id}
                      busy={busy.has(`${p.id}/${fileIdx}_${h.id}`)}
                      onDecide={(pid, hunkId, accept, reason) =>
                        // B6: hid is `${fileIdx}_${hunkIdx}`-addressed per file
                        decide(pid, `${fileIdx}_${hunkId}`, accept, reason)
                      }
                    />
                  ))
                ) : (
                  <div style={{ padding: 12, color: "#8b949e", fontStyle: "italic", fontSize: "0.9em" }}>
                    Files were created/written directly by the agent and verified.
                  </div>
                )}
              </div>
            )}

            {/* sticky action bar */}
            {!isCollapsed && (
            <div className="az-sticky-bar">
              <span className="az-sticky-progress">
                {c.pending === 0 ? "all hunks decided" : `${c.pending} pending`}
              </span>
              <span className="az-spacer" />
              <button
                className="az-btn ok"
                disabled={c.pending === 0 || allBusy}
                onClick={() => decideAll(p.id, true)}
              >
                Accept All ✓
              </button>
              <button
                className="az-btn danger"
                disabled={c.pending === 0 || allBusy}
                onClick={() => decideAll(p.id, false)}
              >
                Reject All ✗
              </button>
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default DiffReview;
