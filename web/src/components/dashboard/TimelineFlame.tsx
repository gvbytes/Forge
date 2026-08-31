// Bottom timeline strip: absolutely-positioned bars over a shared time axis.
// Pure CSS hover tooltips, greedy lane packing so bars never overlap.
import { useMemo } from "react";
import type { SpanDto } from "../../lib/types";
import { KIND_META, fmtCost, fmtMs, fmtTokens, spanStatusTone, toMs } from "./util";
import "./TimelineFlame.css";

interface Props {
  spans: SpanDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Bar {
  span: SpanDto;
  leftPct: number;
  widthPct: number;
  lane: number;
}

interface Layout {
  bars: Bar[];
  laneCount: number;
  ticks: { pct: number; label: string }[];
  windowMs: number;
}

function layout(spans: SpanDto[]): Layout {
  if (spans.length === 0) return { bars: [], laneCount: 0, ticks: [], windowMs: 0 };
  const now = Date.now();
  let minT = Infinity;
  let maxT = -Infinity;
  // B5#1: t0/t1 are epoch seconds — normalize to ms before any arithmetic.
  for (const s of spans) {
    const t0 = Number.isFinite(s.t0) ? toMs(s.t0) : now;
    const t1 = s.t1 == null ? now : toMs(s.t1);
    if (t0 < minT) minT = t0;
    if (t1 > maxT) maxT = t1;
    if (t0 > maxT) maxT = t0; // degenerate zero-length span
  }
  const windowMs = Math.max(1, maxT - minT);

  // greedy lane packing by start time
  const laneEnds: number[] = [];
  const bars: Bar[] = [];
  const ordered = [...spans]
    .filter((s) => Number.isFinite(s.t0))
    .sort((a, b) => a.t0 - b.t0 || a.name.localeCompare(b.name));
  for (const s of ordered) {
    const start = toMs(s.t0);
    const end = s.t1 == null ? Math.max(start, now) : Math.max(start, toMs(s.t1));
    let lane = laneEnds.findIndex((endTs) => endTs <= start);
    if (lane === -1) {
      laneEnds.push(end);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = end;
    }
    // B5#1: width is the true duration/window ratio (no 1ms clamp); keep a
    // hairline so zero-length spans stay clickable, and never overflow 100%.
    const leftPct = Math.min(((start - minT) / windowMs) * 100, 100);
    const ratioPct = ((end - start) / windowMs) * 100;
    const widthPct = Math.min(Math.max(0.4, ratioPct), Math.max(0, 100 - leftPct));
    bars.push({ span: s, leftPct, widthPct, lane });
  }

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => ({
    pct: (i / (tickCount - 1)) * 100,
    label: i === 0 ? "t₀" : `+${fmtMs((windowMs * i) / (tickCount - 1))}`,
  }));
  return { bars, laneCount: laneEnds.length, ticks, windowMs };
}

export function TimelineFlame({ spans, selectedId, onSelect }: Props) {
  const lay = useMemo(() => layout(spans), [spans]);
  return (
    <div className="az-tl" data-testid="timeline">
      <div className="az-tl-head">
        Timeline
        <span className="az-hunkcount">
          {spans.length} spans · {lay.laneCount} lanes · window {fmtMs(lay.windowMs)}
        </span>
      </div>
      {lay.bars.length === 0 ? (
        <div className="az-tl-empty">no spans to plot</div>
      ) : (
        <>
          <div className="az-tl-ruler">
            {lay.ticks.map((t) => (
              <span key={t.pct} className="az-tl-tick" style={{ left: `${t.pct}%` }}>
                {t.label}
              </span>
            ))}
          </div>
          <div className="az-tl-body">
            {Array.from({ length: lay.laneCount }, (_, lane) => (
              <div key={lane} className="az-tl-lane">
                {lay.bars
                  .filter((b) => b.lane === lane)
                  .map((b) => {
                    const tone = spanStatusTone(b.span);
                    const km = KIND_META[b.span.kind] ?? { icon: "·", label: b.span.kind };
                    const dur = b.span.t1 == null ? null : toMs(b.span.t1) - toMs(b.span.t0);
                    const tok = (b.span.tokens_in || 0) + (b.span.tokens_out || 0);
                    return (
                      <div
                        key={b.span.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${km.label} ${b.span.name}`}
                        className={[
                          "az-tl-bar",
                          `az-k-${b.span.kind}`,
                          tone === "running" ? "running" : "",
                          b.span.id === selectedId ? "sel" : "",
                        ].join(" ").trim()}
                        style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
                        onClick={() => onSelect(b.span.id)}
                        onKeyDown={(e) => e.key === "Enter" && onSelect(b.span.id)}
                      >
                        <span className="az-tl-tip">
                          {km.icon} <b>{b.span.name}</b>
                          <br />
                          <span className="m">{km.label}</span>
                          {" · "}
                          {tone === "running" ? "running…" : fmtMs(dur)}
                          {tok > 0 && (
                            <>
                              {" · "}
                              {fmtTokens(tok)} tok
                            </>
                          )}
                          {(b.span.cost_usd || 0) > 0 && (
                            <>
                              {" · "}
                              <span className="cost">{fmtCost(b.span.cost_usd)}</span>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
