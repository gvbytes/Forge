// HITL approval queue: pending agent side-effect requests, rendered as a real
// diff (not a JSON dump) with keyboard-first approve/deny. PS 8b — the human
// in the loop.
//
// This is now the most-used surface in the IDE: "gate" is the default approval
// mode, so EVERY write, shell command and git operation lands here first. The
// previous version stringified the whole payload — which for a write_file
// meant a wall of escaped file content — and offered no way to act without
// reaching for the mouse. Reviewing a dozen of those per task is what makes
// human-in-the-loop feel like an obstacle rather than a control.
import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../stores/ui";

interface Pending {
  id: string;
  toolName?: string;
  tool?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  params?: Record<string, unknown>;
  req?: { tool?: string; params?: Record<string, unknown> };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** One unified-diff line, coloured by its marker. */
function DiffLine({ line }: { line: string }) {
  const cls = line.startsWith("+++") || line.startsWith("---")
    ? "d-meta"
    : line.startsWith("@@")
      ? "d-hunk"
      : line.startsWith("+")
        ? "d-add"
        : line.startsWith("-")
          ? "d-del"
          : "d-ctx";
  return <div className={`ap-diff-line ${cls}`}>{line || " "}</div>;
}

/**
 * Render whatever this tool actually does, in the form a human can judge:
 * a diff for file mutations, the literal command line for shell and git.
 */
function ApprovalBody({ tool, payload }: { tool: string; payload: Record<string, unknown> }) {
  const diff = str(payload.diff) ?? str(payload.diffPreview);
  const command = str(payload.command);
  const message = str(payload.message);

  if (diff) {
    const lines = diff.split("\n");
    // The leading `Index:`/`===` header from createTwoFilesPatch adds nothing
    // a reviewer needs — the path is already in the card title.
    const body = lines.filter((l) => !l.startsWith("Index:") && !/^=+$/.test(l));
    return (
      <div className="ap-diff" role="region" aria-label={`diff for ${tool}`}>
        {body.slice(0, 400).map((l, i) => <DiffLine key={i} line={l} />)}
        {body.length > 400 && (
          <div className="ap-diff-line d-meta">… {body.length - 400} more lines — open the file to review in full</div>
        )}
      </div>
    );
  }

  if (command) {
    return (
      <pre className="ap-cmd">
        <span className="ap-cmd-prompt">$ </span>{command}
        {message && <div className="ap-cmd-msg">message: {message}</div>}
      </pre>
    );
  }

  // Unknown tool shape — show the arguments, but never the raw escaped blob:
  // long string values are truncated so one big argument cannot bury the rest.
  const entries = Object.entries(payload).filter(([k]) => k !== "tool");
  return (
    <div className="ap-args">
      {entries.map(([k, v]) => (
        <div key={k}>
          <span className="ap-arg-key">{k}</span>
          <span className="ap-arg-val">
            {typeof v === "string" ? (v.length > 200 ? `${v.slice(0, 200)}…` : v) : JSON.stringify(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ApprovalsPanel() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const projectId = useUi((s) => s.projectId);
  const toast = useUi((s) => s.toast);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;

  useEffect(() => {
    let alive = true;
    // Drop the previous project's (or the pre-open unscoped) list immediately
    // so a stale approval is not clickable for one poll round-trip.
    setPending([]);
    const poll = async () => {
      try {
        // Folder isolation: ask only for THIS project's pendings — a prompt
        // from another folder (or a zombie from a previous process, which
        // the engine now force-denies at boot) must never surface here.
        const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        const r = await fetch(`/api/approvals/pending${qs}`);
        const list = (await r.json()) as Pending[];
        if (alive) setPending(Array.isArray(list) ? list : []);
      } catch { /* backend briefly down — retry next tick */ }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [projectId]);

  const decide = useCallback(async (id: string, approve: boolean) => {
    setBusy((b) => new Set(b).add(id));
    // Optimistic removal: the queue should feel instant when working through a
    // backlog. A failure restores the item on the next poll, two seconds out.
    setPending((p) => p.filter((x) => x.id !== id));
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Explicit boolean: the engine rejects a missing/non-boolean decision
        // rather than defaulting to deny (a silent deny on a gate is the worst
        // possible failure — the human says yes and the agent is told no).
        body: JSON.stringify({ approve }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        toast(`Approval failed: ${(detail as { error?: string }).error ?? res.status}`, "err");
      }
    } catch (e) {
      toast(`Approval failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(id); return n; });
    }
  }, [toast]);

  const decideAll = useCallback(async (approve: boolean) => {
    const ids = pendingRef.current.map((p) => p.id);
    for (const id of ids) await decide(id, approve);
  }, [decide]);

  // Keyboard-first: reviewing a queue of writes with the mouse is what makes
  // gate mode feel slow. A/D act on the OLDEST request (the top card), which
  // is the one the agent is actually blocked on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const top = pendingRef.current[0];
      if (!top) return;
      if (e.key === "a" || e.key === "A") { e.preventDefault(); void decide(top.id, true); }
      if (e.key === "d" || e.key === "D") { e.preventDefault(); void decide(top.id, false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  if (pending.length === 0) return null;

  return (
    <div className="ap-panel" role="region" aria-label="pending approvals">
      <div className="ap-head">
        <span className="ap-title">
          ⏸ Approval required
          {pending.length > 1 && <span className="ap-count">{pending.length}</span>}
        </span>
        <span className="ap-spacer" />
        <kbd className="ap-kbd">A</kbd><span className="ap-kbd-lbl">approve</span>
        <kbd className="ap-kbd">D</kbd><span className="ap-kbd-lbl">deny</span>
        {pending.length > 1 && (
          <>
            <button className="btn tiny ap-bulk" onClick={() => void decideAll(true)}>Approve all</button>
            <button className="btn tiny ap-bulk" onClick={() => void decideAll(false)}>Deny all</button>
          </>
        )}
      </div>

      {pending.map((a, i) => {
        const tool = a.toolName ?? a.tool ?? a.req?.tool ?? "tool";
        const payload = (a.payload ?? a.params ?? a.req?.params ?? {}) as Record<string, unknown>;
        const path = str(payload.path);
        return (
          <div key={a.id} className={`ap-card${i === 0 ? " ap-first" : ""}`}>
            <div className="ap-card-head">
              <span className="ap-tool">{tool}</span>
              {path && <span className="ap-path">{path}</span>}
              {a.summary && !path && <span className="ap-summary">{a.summary}</span>}
              {i === 0 && pending.length > 1 && <span className="ap-next">next</span>}
            </div>

            <ApprovalBody tool={tool} payload={payload} />

            <div className="ap-actions">
              <button
                className="btn tiny ap-ok"
                disabled={busy.has(a.id)}
                onClick={() => void decide(a.id, true)}
              >
                ✓ Approve{i === 0 ? " (A)" : ""}
              </button>
              <button
                className="btn tiny ap-no"
                disabled={busy.has(a.id)}
                onClick={() => void decide(a.id, false)}
              >
                ✗ Deny{i === 0 ? " (D)" : ""}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
