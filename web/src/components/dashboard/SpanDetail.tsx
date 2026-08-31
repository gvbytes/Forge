// Right pane: drill-in for one span — header, stat row, tabbed payload inspector.
import { useEffect, useState } from "react";
import type { SpanDto } from "../../lib/types";
import type { SpanNode } from "./util";
import {
  KIND_META,
  fmtAbs,
  fmtCost,
  fmtMs,
  fmtTokens,
  spanIsRunning,
  spanStatusTone,
  spanWall,
  toMs,
} from "./util";

interface CtxMsg {
  role: string;
  content: string;
  tokens?: number;
}

interface Props {
  node: SpanNode;
  taskId: string;
  onSelectChild: (id: string) => void;
  /** optionally force the initially-shown tab (tests / deep-links) */
  initialTab?: TabKey;
}

type TabKey = "input" | "output" | "thoughts" | "context" | "children";

function pretty(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Collect thought-like strings from common meta slots. */
function collectThoughts(meta: Record<string, any>): string[] {
  const out: string[] = [];
  if (typeof meta.thought === "string" && meta.thought.trim()) out.push(meta.thought);
  if (Array.isArray(meta.thoughts)) {
    for (const t of meta.thoughts) if (typeof t === "string" && t.trim()) out.push(t);
  } else if (typeof meta.thoughts === "string" && meta.thoughts.trim()) {
    out.push(meta.thoughts);
  }
  if (
    typeof meta.reasoning === "string" &&
    meta.reasoning.trim() &&
    !out.includes(meta.reasoning)
  ) {
    out.push(meta.reasoning);
  }
  return out;
}

function metaNum(meta: Record<string, any>, keys: string[]): number | null {
  for (const k of keys) {
    const v = meta?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Normalize a context snapshot payload (defensive about shapes). */
function normMessages(raw: unknown): CtxMsg[] {
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, any>;
    if (Array.isArray(o.messages)) arr = o.messages;
    else if (Array.isArray(o.messages_json)) arr = o.messages_json;
    else if (typeof o.messages_json === "string") {
      try {
        const p = JSON.parse(o.messages_json);
        if (Array.isArray(p)) arr = p;
      } catch {
        /* tolerate unparsable */
      }
    }
  }
  return arr.map((m) => {
    if (typeof m === "string") return { role: "user", content: m };
    return {
      role: String(m?.role ?? "unknown"),
      content: typeof m?.content === "string" ? m.content : pretty(m?.content ?? m),
      tokens:
        typeof m?.tokens === "number"
          ? m.tokens
          : typeof m?.token_count === "number"
            ? m.token_count
            : undefined,
    };
  });
}

function estimateTokens(msgs: CtxMsg[]): number {
  return msgs.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
}

function MessageList({ title, msgs, total }: { title: string; msgs: CtxMsg[]; total?: number }) {
  if (msgs.length === 0) return <div className="az-none">no messages recorded</div>;
  const sum = total ?? msgs.reduce((a, m) => a + (m.tokens ?? 0), 0);
  return (
    <div className="az-msglist">
      <div className="az-hunkcount">
        {title}: {msgs.length} messages · ~{fmtTokens(sum)} tokens
      </div>
      {msgs.map((m, i) => (
        <div key={i} className="az-msg">
          <div className="az-msg-head">
            <span className={`az-role-${(m.role || "other").toLowerCase()}`}>{m.role}</span>
            <span className="tok az-chip tok">
              {m.tokens != null ? fmtTokens(m.tokens) : `~${fmtTokens(Math.ceil(m.content.length / 4))}`}
            </span>
          </div>
          <div className="az-msg-body">{m.content}</div>
        </div>
      ))}
    </div>
  );
}

export function SpanDetail({ node, taskId, onSelectChild, initialTab }: Props) {
  const s: SpanDto = node.span;
  const meta = (s.meta ?? {}) as Record<string, any>;
  const km = KIND_META[s.kind] ?? { icon: "·", label: s.kind };
  const tone = spanStatusTone(s);
  const running = spanIsRunning(s);

  const thoughts = collectThoughts(meta);
  const ctxMsgs = normMessages(meta.context_snapshot);
  // PS 11b(iv): file/chunk references the engine extracted from this agent's
  // assembled prompt (emitted alongside context_snapshot by the orchestrator).
  const ctxFiles: Array<{ path: string; lines?: string }> = Array.isArray(meta.files)
    ? (meta.files as unknown[]).flatMap((f) => {
        const r = f as { path?: unknown; lines?: unknown };
        return typeof r?.path === "string"
          ? [{ path: r.path, ...(typeof r.lines === "string" ? { lines: r.lines } : {}) }]
          : [];
      })
    : [];
  const reasoningTok = metaNum(meta, ["reasoning_tokens", "tokens_reasoning", "reasoning"]);

  const defaultTab: TabKey = initialTab ?? (meta.input != null ? "input" : "output");
  const [tab, setTab] = useState<TabKey>(defaultTab);

  useEffect(() => {
    // reset when inspecting a different span
    setTab(defaultTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  // B5#1: t0/t1 are epoch seconds → normalize to ms for real durations.
  const wallMs = running ? Date.now() - toMs(s.t0) : toMs(s.t1!) - toMs(s.t0);
  const tokIn = Number(s.tokens_in) || 0;
  const tokOut = Number(s.tokens_out) || 0;

  const tabs: { key: TabKey; label: string; n?: number; disabled?: boolean }[] = [
    { key: "input", label: "Input", disabled: meta.input == null },
    { key: "output", label: "Output", disabled: meta.output == null },
    { key: "thoughts", label: "Thoughts", n: thoughts.length || undefined, disabled: thoughts.length === 0 },
    { key: "context", label: "Context", n: ctxMsgs.length || undefined, disabled: ctxMsgs.length === 0 },
    { key: "children", label: "Children", n: node.children.length || undefined, disabled: node.children.length === 0 },
  ];

  return (
    <div className="az-detail" data-testid="span-detail">
      {/* header */}
      <div className="az-detail-head">
        <div className="az-detail-titleline">
          <span className="kicon" aria-hidden>{km.icon}</span>
          <span className="az-detail-name">{s.name}</span>
          <span className="az-chip">{km.label}</span>
          <span className={`az-statuschip ${tone}`}>{running && tone !== "err" ? "running" : s.status}</span>
        </div>
        <div className="az-model-line">
          model <b>{s.model || "—"}</b>@{s.provider || "—"}
          {" · id "}
          <span style={{ color: "var(--az-faint)" }}>{s.id}</span>
          {s.parent_id ? <> · parent {s.parent_id}</> : <> · root</>}
        </div>
      </div>

      {/* stat row */}
      <div className="az-stats">
        <div className="az-stat">
          <div className="lbl">tokens_in</div>
          <div className="val">{fmtTokens(tokIn)}</div>
        </div>
        <div className="az-stat">
          <div className="lbl">tokens_out</div>
          <div className="val">{fmtTokens(tokOut)}</div>
          {reasoningTok != null && reasoningTok > 0 && tokOut > 0 && (
            <div className="sub">
              incl. reasoning {fmtTokens(reasoningTok)} ({Math.round((reasoningTok / tokOut) * 100)}%)
            </div>
          )}
        </div>
        <div className="az-stat">
          <div className="lbl">cost</div>
          <div className="val" style={{ color: "var(--az-ok)" }}>{fmtCost(node.agg.costUsd)}</div>
          {node.agg.costUsd > (Number(s.cost_usd) || 0) + 1e-9 && (
            <div className="sub">Σ subtree</div>
          )}
        </div>
        <div className="az-stat">
          <div className="lbl">wall time</div>
          <div className="val">{fmtMs(wallMs)}</div>
          {running && <div className="sub">still running…</div>}
        </div>
        <div className="az-stat">
          <div className="lbl">t₀ absolute</div>
          <div className="val" style={{ fontSize: 11 }}>{fmtAbs(s.t0)}</div>
        </div>
      </div>

      {/* tabs */}
      <div className="az-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`az-tab${tab === t.key ? " on" : ""}`}
            style={t.disabled ? { opacity: 0.35, cursor: "default" } : undefined}
            onClick={() => !t.disabled && setTab(t.key)}
          >
            {t.label}
            {t.n != null && <span className="n">({t.n})</span>}
          </button>
        ))}
      </div>

      <div className="az-tabbody" role="tabpanel">
        {tab === "input" && (
          meta.input != null ? <pre className="az-preblock">{pretty(meta.input)}</pre> : <div className="az-none">(not recorded)</div>
        )}

        {tab === "output" &&
          (meta.output == null ? (
            <div className="az-none">(not recorded)</div>
          ) : meta.output === "" ? (
            // B5#6: an empty string output used to render a blank tab.
            <div className="az-none dim">(empty response)</div>
          ) : (
            <pre className="az-preblock md-pre">{pretty(meta.output)}</pre>
          ))}

        {tab === "thoughts" &&
          (thoughts.length > 0 ? (
            thoughts.map((t, i) => (
              <p key={i} className="az-thought">
                {t}
              </p>
            ))
          ) : (
            <div className="az-none">(no thoughts recorded)</div>
          ))}

        {tab === "context" && (
          // B18: snapshot fetch UI removed (engine will not implement
          // /api/snapshots for now) — inline context_snapshot only.
          ctxMsgs.length > 0 ? (
            <>
              {/* PS 11b(iv): "the exact files or code chunks in each agent's
                  context". The message list alone answers "what did it read";
                  this answers "which code, at which lines". */}
              {ctxFiles.length > 0 && (
                <div className="az-ctx-files">
                  <div className="az-sub">files &amp; chunks in context: {ctxFiles.length}</div>
                  <ul>
                    {ctxFiles.map((f, i) => (
                      <li key={`${f.path}:${f.lines ?? ""}:${i}`}>
                        <span className="az-ctx-path">{f.path}</span>
                        {f.lines && <span className="az-ctx-lines">:{f.lines}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <MessageList title="context_snapshot" msgs={ctxMsgs} />
            </>
          ) : (
            <div className="az-none">no inline context snapshot in meta</div>
          )
        )}

        {tab === "children" && (
          <table className="az-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Status</th>
                <th className="r">Wall</th>
                <th className="r">Σ Tok</th>
                <th className="r">Σ Cost</th>
              </tr>
            </thead>
            <tbody>
              {node.children.map((c) => {
                const ckm = KIND_META[c.span.kind] ?? { icon: "·", label: c.span.kind };
                const ctone = spanStatusTone(c.span);
                return (
                  <tr key={c.span.id} className="click" onClick={() => onSelectChild(c.span.id)}>
                    <td>
                      {ckm.icon} {c.span.name}
                    </td>
                    <td className="muted">{ckm.label}</td>
                    <td>
                      <span className={`az-dot ${ctone}`} />{" "}
                      <span className="muted">{c.span.status}</span>
                    </td>
                    <td className="r">{fmtMs(spanIsRunning(c.span) ? null : spanWall(c.span))}</td>
                    <td className="r">{fmtTokens(c.agg.tokensIn + c.agg.tokensOut)}</td>
                    <td className="r">{fmtCost(c.agg.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
