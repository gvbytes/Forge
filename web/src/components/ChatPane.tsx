// ChatPane — the event-stream cockpit: goal/plan/thought/tool/HITL/bytheway/
// summary timeline, routing transparency badges, live SSE status, inline task
// controls, and the composer with @path pins + /bytheway + /plan + followups.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { extractRefs, sendFollowup } from "../lib/composer";
import { Markdown } from "../lib/markdown";
import {
  LOCAL_NO_TASK, nextLocalId, useChat, useTimeline,
  type BythewayItem, type HitlItem, type NoticeItem, type PlanItem, type ToolItem, type VisionItem,
} from "../stores/chat";
import { useEditor } from "../stores/editor";
import { useUi } from "../stores/ui";
import { useStickBottom } from "../hooks/useStickBottom";
import { RoutingBadge } from "./RoutingBadge";
import { ClickableText } from "./ClickableText";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { TokenMeterPopover } from "./TokenMeterPopover";
import {
  useCapabilities, readImageFile, AttachmentStrip, VoiceButton, CapabilityNote,
  type Attachment,
} from "./Multimodal";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * A tool row already prints the tool's NAME. The emoji beside it added no
 * information the label did not already carry, and a column of mixed
 * pictograms is the loudest thing in a transcript you are trying to read.
 * Kept for the two tools whose glyph IS the convention developers read by.
 */
const TOOL_ICON: Record<string, string> = {
  bash: "❯",
  git: "⑂",
};

/**
 * Task lifecycle, as the orchestrator actually reports it.
 *
 * The previous strip listed seven stages — Triage, Research, Planner, Coder,
 * Critic, Synthesize, Done — most of which the engine never emits. It inferred
 * them from worker ids that only exist on some paths, so the highlighted stage
 * was frequently a guess presented as fact. task.status only ever takes the
 * values below, so those are the only ones shown.
 *
 * "Waiting" is called out because it is the one state that needs the operator:
 * the task is blocked on a human approving a side effect, and nothing moves
 * until they act.
 */
const STAGES = [
  { key: "plan", label: "Plan" },
  { key: "code", label: "Code" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

function stageFor(status: string | undefined): { stage: StageKey; blocked: boolean; failed: boolean } {
  switch (status) {
    case "planning": return { stage: "plan", blocked: false, failed: false };
    case "reviewing": return { stage: "review", blocked: false, failed: false };
    case "waiting-approval": return { stage: "code", blocked: true, failed: false };
    case "failed":
    case "stopped": return { stage: "done", blocked: false, failed: true };
    case "done": return { stage: "done", blocked: false, failed: false };
    default: return { stage: "code", blocked: false, failed: false };
  }
}

function PipelineStrip({ task }: { task?: { status?: string } }) {
  if (!task || !task.status || task.status === "idle") return null;
  const { stage, blocked, failed } = stageFor(task.status);
  const activeIdx = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="pipe" role="status" aria-label={`task ${task.status}`}>
      {STAGES.map((s, i) => (
        <span
          key={s.key}
          className={
            "pipe-stage" +
            (i < activeIdx ? " is-past" : "") +
            (i === activeIdx ? (failed ? " is-failed" : " is-active") : "")
          }
        >
          {s.label}
        </span>
      ))}
      {blocked && <span className="pipe-blocked">needs approval</span>}
    </div>
  );
}

/** Empty state names the CURRENT folder so a post-switch empty pane reads as
 *  deliberate ("switched + cleared") rather than as lost state. */
/**
 * Chat empty state.
 *
 * Was a paragraph of prose describing the command syntax. Nobody reads syntax
 * documentation in an empty panel — they read the first thing that looks
 * clickable. These starters seed the composer instead of explaining it, which
 * teaches the same three commands by using them once.
 */
function EmptyHint() {
  const projectRoot = useUi((s) => s.projectRoot);
  const folder = projectRoot ? projectRoot.split("/").filter(Boolean).pop() : null;
  const seed = (text: string) => useUi.setState({ composerSeed: text });

  const starters: { label: string; hint: string; text: string }[] = [
    { label: "Explain this codebase", hint: "/bytheway · zero prior context", text: "/bytheway what does this repo do and how is it structured?" },
    { label: "Plan a change", hint: "/plan · breaks work into steps", text: "/plan " },
    { label: "Find something", hint: "asks the agent to search", text: "Where is the entry point and what does it set up?" },
  ];

  return (
    <div className="chat-empty">
      <p className="ce-title">{folder ? folder : "No folder open"}</p>
      <p className="ce-sub">
        {folder
          ? "No task running. Start one below, or try a starter."
          : "Open a folder from the top bar to begin."}
      </p>
      {folder && (
        <div className="ce-starters">
          {starters.map((st) => (
            <button key={st.label} type="button" className="ce-starter" onClick={() => seed(st.text)}>
              <span className="ce-starter-label">{st.label}</span>
              <span className="ce-starter-hint">{st.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function oneLiner(item: ToolItem): string {
  const inp = (item.input ?? {}) as Record<string, any>;
  const cand =
    inp.command ?? inp.cmd ?? inp.path ?? inp.query ?? inp.pattern ?? inp.goal ??
    inp.repo ?? inp.url ?? inp.name ?? inp.tool;
  if (Array.isArray(cand)) return cand.join(" ");
  if (typeof cand === "string") return cand.length > 90 ? `${cand.slice(0, 90)}…` : cand;
  if (item.tool === "finish") return "agent finished";
  return item.phase === "result" ? (item.ok === false ? "(failed)" : "(done)") : "(running)";
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICON[item.tool] ?? "";
  const stateClass =
    item.ok === false
      ? "err"
      : item.phase === "result"
        ? "ok"
        : "dim";
  return (
    <div className={`tool-row ${stateClass}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="ticon" aria-hidden>{icon}</span>
        <code className="tool-name">{item.tool}</code>
        <span className="tool-line dim">{oneLiner(item)}</span>
        <span className="tool-state">
          {item.phase === "running" && <span className="spin">⠋</span>}
          {item.phase === "result" && (item.ok === false ? <span className="err-text">✗</span> : <span className="ok-text">✓</span>)}
          <span className="caret">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="tool-detail mono">
          <div className="detail-label">input</div>
          <pre>{item.input !== undefined ? JSON.stringify(item.input, null, 2) : "—"}</pre>
          <div className="detail-label">output</div>
          <pre>{item.output !== undefined
            ? typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)
            : "—"}</pre>
        </div>
      )}
    </div>
  );
}

function PlanCard({ item }: { item: PlanItem }) {
  const doneCount = item.steps.filter((s) => s.done).length;
  return (
    <div className="card plan-card">
      <div className="card-head"><b>PLAN</b><span className="chip">{doneCount}/{item.steps.length} done</span></div>
      <ol className="plan-steps">
        {item.steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""}>
            {s.text}
            {s.dependsOn && s.dependsOn.length > 0 && (
              <span className="dim tiny-text" style={{ marginLeft: 6 }}>
                (after {s.dependsOn.join(", ")})
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function NoticeLine({ item }: { item: NoticeItem }) {
  return (
    <div className={`notice ${item.level}`}>
      <span aria-hidden>{item.icon}</span> {item.text}
    </div>
  );
}

function BythewayBubble({ item }: { item: BythewayItem }) {
  return (
    <div className="bubble bytheway">
      <span className="bw-label">zero-context</span>
      <p className="bw-q">{item.question}</p>
      {item.pending ? (
        <p className="dim bw-a">thinking outside the main context…</p>
      ) : (
        <div className="bw-a"><Markdown text={item.answer ?? ""} /></div>
      )}
      {item.modelKey && !item.pending && <span className="route-static mono">{item.modelKey}</span>}
    </div>
  );
}

function VisionBubble({ item }: { item: VisionItem }) {
  return (
    <div className="bubble vision-bubble" style={{
      borderLeft: "3px solid #d19a3e",
      background: "#161b22",
      padding: "10px 12px",
      borderRadius: 6,
      margin: "8px 0",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span className="chip ok" style={{ fontSize: 10, background: "rgba(209, 154, 62, 0.15)", color: "#d19a3e", border: "1px solid rgba(209, 154, 62, 0.3)" }}>
          📷 Image Vision
        </span>
        {item.modelKey && <span className="dim tiny-text mono">{item.modelKey}</span>}
      </div>

      {item.images && item.images.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {item.images.map((img, idx) => (
            <img
              key={idx}
              src={img.dataUrl}
              alt={img.name}
              title={img.name}
              style={{
                maxHeight: 140,
                maxWidth: 220,
                borderRadius: 4,
                border: "1px solid #30363d",
                objectFit: "contain",
                background: "#0d1117",
              }}
            />
          ))}
        </div>
      )}

      {item.prompt && (
        <p style={{ fontWeight: 500, margin: "4px 0 8px", color: "#e6edf3" }}>
          {item.prompt}
        </p>
      )}

      {item.pending ? (
        <p className="dim tiny-text" style={{ fontStyle: "italic", margin: 0 }}>
          Analyzing image with vision model…
        </p>
      ) : item.error ? (
        <p className="err-text tiny-text" style={{ margin: 0 }}>
          ⚠ {item.error}
        </p>
      ) : (
        <div className="thought-text" style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>
          <Markdown text={item.answer ?? ""} />
        </div>
      )}
    </div>
  );
}

const resolvedProposals = new Map<string, "accepted" | "rejected">();
/** Clear module-level caches on task switch (web #26). */
export function clearChatCaches(): void {
  resolvedProposals.clear();
}

function HitlCard({ item }: { item: HitlItem }) {
  const setDiffOverlayOpen = useUi((s) => s.setDiffOverlayOpen);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const done = item.proposalId ? resolvedProposals.get(item.proposalId) : null;

  const resolve = async (accept: boolean) => {
    if (!item.proposalId) return;
    setBusy(true);
    try {
      await api.resolveAll(item.proposalId, accept);
      resolvedProposals.set(item.proposalId, accept ? "accepted" : "rejected");
      setTick((t) => t + 1);
    } catch (e) {
      console.error("resolveAll failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card hitl-card">
      <div className="card-head">
        <b>HITL PROPOSAL</b>
        <button type="button" className="btn tiny" onClick={() => setDiffOverlayOpen(true)}>
          review ⇄
        </button>
      </div>
      <p><code>{item.path}</code></p>
      <p className="dim">{item.hunks !== undefined ? `${item.hunks} hunk(s)` : ""} awaiting your accept/reject per hunk.</p>
      {done ? (
        <p style={{ color: done === "accepted" ? "#3fb950" : "#f85149", fontWeight: 600 }}>
          {done === "accepted" ? "✓ All hunks accepted" : "✗ All hunks rejected"}
        </p>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn tiny"
            style={{ background: "#238636", color: "#fff" }}
            disabled={busy || !item.proposalId}
            onClick={() => void resolve(true)}
          >
            {busy ? "…" : "✓ Accept All"}
          </button>
          <button
            type="button"
            className="btn tiny"
            style={{ background: "#b62324", color: "#fff" }}
            disabled={busy || !item.proposalId}
            onClick={() => void resolve(false)}
          >
            {busy ? "…" : "✗ Reject All"}
          </button>
        </div>
      )}
    </div>
  );
}


function ThinkingBox({ thinking, streaming }: { thinking: string; streaming?: boolean }) {
  const [elapsed, setElapsed] = useState<number>(0);
  const [startTime] = useState<number>(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => {
      setElapsed(Math.max(0, (Date.now() - startTime) / 1000));
    }, 100);
    return () => clearInterval(interval);
  }, [streaming, startTime]);

  const copyThought = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void navigator.clipboard.writeText(thinking);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const formattedTime = streaming ? `${elapsed.toFixed(1)}s` : `${Math.max(0.4, (thinking.length / 140)).toFixed(1)}s`;

  return (
    <details className={`thinking-box cursor-thinking-drawer ${streaming ? "is-streaming" : "is-sealed"}`} open={streaming || undefined}>
      <summary className="thinking-summary">
        <div className="thinking-summary-left">
          <span className="thinking-title">
            {streaming ? "Thinking..." : "Thought Process"}
          </span>
          <span className="thinking-duration-badge">
            {formattedTime}
          </span>
          {thinking && <span className="thinking-words">{thinking.split(/\s+/).length}w</span>}
        </div>
        <div className="thinking-summary-right">
          <button
            type="button"
            className="btn-tiny-ghost"
            title="Copy thought trace"
            onClick={copyThought}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </summary>
      <div className="thinking-content-body">
        <div className="thinking-text mono">{thinking}</div>
      </div>
    </details>
  );
}

function TimelineEntry({ item }: { item: ReturnType<typeof useTimeline>[number] }) {
  switch (item.kind) {
    case "goal":
      return (
        <div className="bubble goal">
          <span className="goal-label">GOAL{item.title ? ` · ${item.title}` : ""}</span>
          <p><ClickableText text={item.text} /></p>
        </div>
      );
    case "user":
      return (
        <div className={`bubble user${item.status === "failed" ? " failed" : ""}`} title={item.status}>
          <p>{item.text}</p>
          {item.status === "failed" && <span className="tiny-text err-text">send failed — endpoint missing?</span>}
        </div>
      );
    case "thought":
      return (
        <div className={`bubble assistant${item.streaming ? " streaming" : ""}`}>
          {item.route && <RoutingBadge route={item.route} />}
          {item.thinking && <ThinkingBox thinking={item.thinking} streaming={item.streaming} />}
          {item.text.trim() ? (
            <div className="thought-text">
              <Markdown text={item.text} />
              {item.streaming && <span className="stream-cursor" aria-hidden>▍</span>}
            </div>
          ) : item.streaming ? (
            <div className="thought-text dim">
              <span className="stream-cursor" aria-hidden>▍</span>
            </div>
          ) : null}
        </div>
      );
    case "plan": return <PlanCard item={item} />;
    case "tool": return <ToolRow item={item} />;
    case "notice": return <NoticeLine item={item} />;
    case "hitl": return <HitlCard item={item} />;
    case "bytheway": return <BythewayBubble item={item} />;
    case "vision": return <VisionBubble item={item} />;
    case "summary":
      return <div className="card summary-card"><div className="card-head"><b>SUMMARY</b></div><div className="md"><Markdown text={item.text} /></div></div>;
  }
}

function TaskControls() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const tasks = useUi((s) => s.tasks);
  const refreshTasks = useUi((s) => s.refreshTasks);
  const toast = useUi((s) => s.toast);
  // B19: match both task UUID and sessionId.
  const task = tasks.find((t) => t.id === activeTaskId || (activeTaskId != null && t.sessionId === activeTaskId)) ?? null;
  if (!activeTaskId || !task) return null;

  // B33: engine status vocabulary — planning|running|waiting-approval|
  // reviewing|done|failed|stopped. There is NO paused/queued state.
  const busyStatuses = ["planning", "running", "waiting-approval", "reviewing"];
  const canStop = busyStatuses.includes(task.status);
  const canResume = ["stopped", "failed"].includes(task.status);
  const canRevert = !busyStatuses.includes(task.status);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(`${label} → ok`, "ok");
      await refreshTasks();
    } catch (e) {
      toast(`${label} failed: ${String(e)}`, "err");
    }
  };

  // Wave 26 reject-and-revert: show the task's checkpoint, confirm, then restore
  // every captured file to its pre-task state (created files are deleted).
  const doRevert = async () => {
    try {
      const { checkpoint } = await api.checkpoint(activeTaskId);
      if (!checkpoint || !checkpoint.files?.length) {
        toast("no checkpoint for this task — nothing to revert", "err");
        return;
      }
      // Sanitize (paths are agent-controlled: strip newlines to avoid spoofing the
      // dialog) and cap the list so a huge task doesn't produce a giant modal.
      const clean = (p: string) => String(p).replace(/[\r\n]+/g, " ");
      const lines = checkpoint.files.map((f: any) => `${f.existed ? "restore" : "delete "} ${clean(f.path)}`);
      const MAXLINES = 20;
      const shown = lines.slice(0, MAXLINES).join("\n") + (lines.length > MAXLINES ? `\n…and ${lines.length - MAXLINES} more` : "");
      if (!window.confirm(`Revert this task's ${checkpoint.files.length} file change(s)?\n\n${shown}`)) return;
      const res = await api.revertTask(activeTaskId);
      // Reconcile the editor so no open tab keeps (or re-saves) rejected content:
      // close tabs for removed files, refetch restored ones still open.
      useEditor.getState().revertSync(res.restored, res.removed);
      toast(`reverted: ${res.restored.length} restored, ${res.removed.length} removed${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`, "ok");
      await refreshTasks();
    } catch (e) {
      toast(`revert failed: ${String(e)}`, "err");
    }
  };

  return (
    <span className="task-controls">
      <button
        type="button" className="btn tiny"
        disabled={!canResume}
        title={canResume ? "resume task exactly where it left off" : `cannot resume (${task.status})`}
        onClick={() => void act("resume", () => api.resumeTask(activeTaskId))}
      >▶ Resume</button>
      <button
        type="button" className="btn tiny danger"
        disabled={!canStop}
        title={canStop ? "stop task" : `cannot stop (${task.status})`}
        onClick={() => void act("stop", () => api.stopTask(activeTaskId))}
      >■ Stop</button>
      <button
        type="button" className="btn tiny"
        disabled={!canRevert}
        title={canRevert ? "reject this task's changes — revert files to their pre-task state" : `cannot revert while ${task.status}`}
        onClick={() => void doRevert()}
      >↩ Revert</button>
    </span>
  );
}

export function ChatPane() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const tasks = useUi((s) => s.tasks);
  const task = tasks.find((t) => t.id === activeTaskId || (activeTaskId != null && t.sessionId === activeTaskId)) ?? undefined;
  const connState = useChat((s) => (activeTaskId ? s.conn[activeTaskId] : undefined)) ?? "idle";
  const items = useTimeline(activeTaskId);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const caps = useCapabilities();

  const addFiles = useCallback(async (files: FileList | File[]): Promise<void> => {
    for (const f of Array.from(files)) {
      try {
        const att = await readImageFile(f);
        setAttachments((prev) => [...prev, att]);
      } catch (e) {
        useUi.getState().toast(e instanceof Error ? e.message : String(e), "err");
      }
    }
  }, []);
  const [engineChip, setEngineChip] = useState<"multi-agent" | "single-agent">("multi-agent");
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Wave 25: depend on the timeline ARRAY (identity changes on every SSE
  // frame, including in-place token growth) — items.length alone stays flat
  // while a stream bubble grows, so the pane would not follow live text.
  // Pass activeTaskId so a task switch re-engages the pin (fresh stream follows).
  const stick = useStickBottom(items, activeTaskId);

  // task switch → clear module-level caches (resolvedProposals etc.)
  useEffect(() => {
    clearChatCaches();
  }, [activeTaskId]);

  // seeded composer (e.g. "New Task" button drops "/plan ")
  const seed = useUi((s) => s.composerSeed);
  useEffect(() => {
    if (seed !== null) {
      setText(seed);
      useUi.setState({ composerSeed: null });
      taRef.current?.focus();
    }
  }, [seed]);

  const connDot = connState === "live" ? "ok" : connState === "offline" ? "err" : connState === "connecting" ? "warn" : "dim";

  async function send() {
    const raw = text.trim();
    // An image alone is a legitimate turn ("what is this?"), so the guard is
    // "nothing at all", not "no text".
    if (!raw && attachments.length === 0) return;

    // --- attached images: independent image model interaction in the chat stream ---
    // The vision model answers directly without kicking off a coding agent task or creating files.
    if (attachments.length > 0 && !raw.startsWith("/plan ") && raw !== "/plan") {
      const pending = attachments;
      const askPrompt = raw;
      setAttachments([]);
      setText("");
      const key = activeTaskId ?? LOCAL_NO_TASK;
      const id = nextLocalId();

      useChat.getState().addLocal(key, {
        kind: "vision",
        id,
        ts: Date.now(),
        prompt: askPrompt,
        images: pending.map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
        pending: true,
      });

      try {
        const res = await fetch("/api/vision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: askPrompt || undefined, images: pending.map((a) => a.dataUrl) }),
        });
        const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string; model?: string };
        if (!res.ok || !j.text) throw new Error(j.error ?? "vision model returned nothing");

        useChat.getState().patchLocal(key, id, (it) =>
          it.kind === "vision"
            ? { ...it, answer: j.text, modelKey: j.model, pending: false }
            : it,
        );
      } catch (e) {
        useChat.getState().patchLocal(key, id, (it) =>
          it.kind === "vision"
            ? { ...it, error: e instanceof Error ? e.message : String(e), pending: false }
            : it,
        );
        useUi.getState().toast(e instanceof Error ? e.message : String(e), "err");
      }
      return;
    }

    let prompt = raw;
    if (attachments.length > 0) {
      // User explicitly typed /plan with an attachment
      const pending = attachments;
      setAttachments([]);
      useUi.getState().toast(`Reading ${pending.length} image(s) for plan…`, "ok");
      try {
        const res = await fetch("/api/vision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: raw || undefined, images: pending.map((a) => a.dataUrl) }),
        });
        const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string; model?: string };
        if (!res.ok || !j.text) throw new Error(j.error ?? "vision model returned nothing");
        const names = pending.map((a) => a.name).join(", ");
        prompt = `${raw}\n\n[Attached image(s): ${names} — read by ${j.model ?? "the vision model"}]\n${j.text}`;
      } catch (e) {
        setAttachments(pending);
        useUi.getState().toast(e instanceof Error ? e.message : String(e), "err");
        return;
      }
    }

    // --- /bytheway <q>: zero-context side question -----------------------
    if (raw.startsWith("/bytheway ")) {
      const q = raw.slice("/bytheway ".length).trim();
      setText("");
      if (!q) return;
      const key = activeTaskId ?? LOCAL_NO_TASK;
      const id = nextLocalId();
      useChat.getState().addLocal(key, {
        kind: "bytheway", id, ts: Date.now(), question: q, pending: true,
      });
      try {
        // contract: POST /api/bytheway {sessionId?, text}
        const sid = useUi.getState().activeSessionId ?? activeTaskId;
        const res = await api.bytheway(sid, q);
        useChat.getState().patchLocal(key, id, (it) =>
          it.kind === "bytheway"
            ? { ...it, answer: res.answer, modelKey: res.model_key, pending: false }
            : it,
        );
      } catch (e) {
        useChat.getState().patchLocal(key, id, (it) =>
          it.kind === "bytheway" ? { ...it, answer: `⚠ ${String(e)}`, pending: false } : it,
        );
      }
      return;
    }

    // --- /plan <goal>: ALWAYS create a NEW task (even with one active) ----
    // B3#11: bare "/plan" / "/plan   " → usage toast, no task, no send.
    if (raw === "/plan" || raw.startsWith("/plan ")) {
      const goal = raw.slice("/plan".length).trim();
      if (!goal) {
        useUi.getState().toast("usage: /plan <goal>", "err");
        return;
      }
      setText("");
      await useUi.getState().newTask(goal, engineChip);
      return;
    }

    // --- plain text: @refs become pins; rest is a followup instruction ---
    const refs = extractRefs(raw);
    for (const pin of refs) void useEditor.getState().addPin(pin);

    if (!activeTaskId) {
      // First-run ergonomics: a plain goal with no active task STARTS one.
      // (@refs are still pinned first so they apply to the new task.)
      setText("");
      void (async () => {
        const t = await useUi.getState().newTask(prompt, engineChip);
        if (!t) useUi.getState().toast("Could not create task — is the backend up?", "err");
      })();
      return;
    }

    const id = nextLocalId();
    useChat.getState().addLocal(activeTaskId, {
      kind: "user", id, ts: Date.now(), text: raw, status: "sent",
    });
    setText("");
    // optimistic followup; endpoint may not exist yet → bubble flips to failed.
    // B32: when the server returns the stored message id, mark the local
    // bubble with it so the SSE echo with the same id is suppressed (the
    // text-based dedupe in deriveTimeline covers engines that don't).
    void sendFollowup(activeTaskId, prompt)
      .then((res) => {
        const msgId = res?.messageId ?? res?.id;
        if (msgId) {
          useChat.getState().patchLocal(activeTaskId, id, (it) =>
            it.kind === "user" ? { ...it, msgId } : it,
          );
        }
        // RC1 — rollover follow: a followup to a TERMINAL task archives it
        // server-side and mints a NEW task UUID in the same session. The old
        // id in activeTaskId is now dead (select row gone on next refresh,
        // TaskControls/BudgetMeter unmount). Switch to the live task id the
        // engine reports; the local optimistic bubble must follow too.
        const rolledTo = res?.taskId;
        if (rolledTo && rolledTo !== activeTaskId) {
          const ui = useUi.getState();
          const chat = useChat.getState();
          // ORDER MATTERS: selectTask(rolledTo) re-keys useTaskStream, whose
          // effect calls resetTask(rolledTo) — that WIPES buffers under the
          // new key. So switch the selection FIRST, then migrate the old
          // buffers into the fresh key (migrateLocal appends, so the just-
          // wiped key receives the optimistic bubble + old conversation).
          ui.selectTask(rolledTo);
          if (res.sessionId) useUi.setState({ activeSessionId: res.sessionId });
          chat.migrateLocal(activeTaskId, rolledTo);
          chat.migrateEvents(activeTaskId, rolledTo);
          void ui.refreshTasks();
        }
      })
      .catch(() => {
        useChat.getState().patchLocal(activeTaskId, id, (it) =>
          it.kind === "user" ? { ...it, status: "failed" } : it,
        );
      });
  }

  return (
    <section className="chat-pane" aria-label="chat">
      <div className="panel-head chat-head">
        <span className={`conn-dot ${connDot}`} title={`stream: ${connState}`} />
        CHAT
        <TaskControls />
      </div>

      <PipelineStrip task={task as any} />

      <div className="msg-list" ref={stick.ref} onScroll={stick.onScroll}>
        {!activeTaskId && (
          <EmptyHint />
        )}
        {items.map((it) => <TimelineEntry key={it.id} item={it} />)}
      </div>

      <div className="composer">
        <div style={{display:"flex",gap:6,marginBottom:4}}>
            <button
              type="button"
              className="chip engine-chip"
              onClick={() => setEngineChip((e) => (e === "multi-agent" ? "single-agent" : "multi-agent"))}
              title="orchestration mode: multi-agent team vs single agent"
            >
              {engineChip === "multi-agent" ? "multi-agent" : "single-agent"}
            </button>
          </div>
          <ErrorBoundary fallback={<div className="dim tiny-text">Approvals unavailable</div>}>
            <ApprovalsPanel />
          </ErrorBoundary>
        <AttachmentStrip items={attachments} onRemove={(id) => setAttachments((p) => p.filter((a) => a.id !== id))} />
        <textarea
          ref={taRef}
          className={dragging ? "is-drop" : undefined}
          value={text}
          rows={3}
          placeholder={activeTaskId ? "Reply to the running task…" : "Describe a change, or /plan <goal>"}
          onChange={(e) => setText(e.target.value)}
          // Screenshots arrive by paste far more often than by file dialog.
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (imgs.length) { e.preventDefault(); void addFiles(imgs); }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          spellCheck={false}
        />
        <div className="composer-bar">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
          />
          <button
            type="button"
            className="btn tiny mm-btn"
            onClick={() => fileRef.current?.click()}
            disabled={!caps?.vision?.key_present}
            title={caps?.vision
              ? `Attach image · ${caps.vision.model} @ ${caps.vision.provider}`
              : "No vision model configured"}
          >
            + Image
          </button>
          <VoiceButton cap={caps?.transcription ?? null} onText={(t) => setText((cur) => (cur ? `${cur} ${t}` : t))} />
          <span className="spacer" />
          <TokenMeterPopover />
          <button
            type="button"
            className="btn primary"
            onClick={() => void send()}
            disabled={!text.trim() && attachments.length === 0}
          >
            Send ⏎
          </button>
        </div>
        <div className="composer-bar mm-caps">
          <span className="dim tiny-text composer-hint">
            <code>@path</code> pins context · <code>/plan</code> · <code>/bytheway</code>
          </span>
          <span className="spacer" />
          {attachments.length > 0 && <CapabilityNote cap={caps?.vision ?? null} kind="image" />}
        </div>
      </div>
    </section>
  );
}
