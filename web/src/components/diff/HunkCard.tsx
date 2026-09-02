// One diff hunk: monospace body with +/- line coloring, line-number gutters,
// Accept ✓ / Reject ✗ buttons that disable once decided.
import { useMemo } from "react";
import type { HunkDto } from "../../lib/types";

interface Props {
  hunk: HunkDto;
  busy?: boolean;
  /** true when the whole proposal is applied/discarded — decisions locked */
  locked?: boolean;
  onDecide: (proposalId: string, hunkId: string, accept: boolean, reason?: string) => void;
  proposalId: string;
}

interface Line {
  oldNo: number | null;
  newNo: number | null;
  sign: string;
  text: string;
  cls: "add" | "del" | "meta" | "ctx";
}

function parseLines(hunk: HunkDto): Line[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((raw) => {
    const ch = raw.charAt(0);
    if (raw.startsWith("@@")) {
      return { oldNo: null, newNo: null, sign: "@", text: raw, cls: "meta" as const };
    }
    if (ch === "+") {
      const l = { oldNo: null, newNo, sign: "+", text: raw.slice(1), cls: "add" as const };
      newNo += 1;
      return l;
    }
    if (ch === "-") {
      const l = { oldNo, newNo: null, sign: "-", text: raw.slice(1), cls: "del" as const };
      oldNo += 1;
      return l;
    }
    if (ch === "\\") {
      // "\ No newline at end of file"
      return { oldNo: null, newNo: null, sign: "\\", text: raw, cls: "meta" as const };
    }
    const text = raw.startsWith(" ") || raw === "" ? raw.slice(1) : raw;
    const l = { oldNo, newNo, sign: " ", text, cls: "ctx" as const };
    oldNo += 1;
    newNo += 1;
    return l;
  });
}

export function HunkCard({ hunk, proposalId, busy = false, locked = false, onDecide }: Props) {
  const lines = useMemo(() => parseLines(hunk), [hunk]);
  const decided = hunk.status !== "pending";
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  // Cline-style per-hunk volume chip so reviewers gauge blast radius before
  // expanding a hunk (mirrors DiffEditRow's DiffStats).
  const adds = hunk.lines.filter((l) => l.startsWith("+")).length;
  const dels = hunk.lines.filter((l) => l.startsWith("-")).length;

  return (
    <div className="az-hunk-card" data-testid={`hunk-${hunk.id}`}>
      <div className="az-hunk-head">
        <span className="hid">hunk {hunk.id}</span>
        {(adds > 0 || dels > 0) && (
          <span style={{ whiteSpace: "nowrap", fontSize: "0.85em" }}>
            {adds > 0 && <b style={{ color: "#3fb950" }}>+{adds}</b>}
            {adds > 0 && dels > 0 && <span style={{ opacity: 0.6 }}> · </span>}
            {dels > 0 && <b style={{ color: "#f85149" }}>−{dels}</b>}
          </span>
        )}
        <span>{hunk.header || range}</span>
        <div className="az-hunk-actions">
          {decided ? (
            <>
              <span className={`az-decision ${hunk.status}`}>{hunk.status}</span>
              <button
                className="az-btn"
                disabled
                title={`decided (${hunk.status})`}
              >
                ✓
              </button>
              <button
                className="az-btn"
                disabled
                title={`decided (${hunk.status})`}
              >
                ✗
              </button>
            </>
          ) : (
            <>
              <button
                className="az-btn ok"
                disabled={busy || locked}
                onClick={() => onDecide(proposalId, hunk.id, true)}
              >
                Accept ✓
              </button>
              <button
                className="az-btn danger"
                disabled={busy || locked}
                onClick={() => {
                  // v1: optional reason via window.prompt; cancel ⇒ reject without reason
                  const r = window.prompt(`Reason for rejecting hunk ${hunk.id} (optional):`);
                  onDecide(proposalId, hunk.id, false, r == null ? undefined : r.trim() || undefined);
                }}
              >
                Reject ✗
              </button>
            </>
          )}
        </div>
      </div>

      {hunk.reason && decided && (
        <div className="az-reason-note">
          reason: {hunk.reason}
        </div>
      )}

      <pre className="az-code">
        {lines.map((l, i) => (
          <span key={i} className={`az-cline ${l.cls}`}>
            <span className="no">{l.oldNo ?? ""}</span>
            <span className="no">{l.newNo ?? ""}</span>
            <span className="sign">{l.sign === " " ? "" : l.sign}</span>
            <span className="txt">{l.text || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}
