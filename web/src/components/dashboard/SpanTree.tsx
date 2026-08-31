// Left pane: span hierarchy with indent guides, kind icons, chips, status dots.
import type { SpanNode } from "./util";
import { KIND_META, fmtCost, fmtMs, fmtTokens, spanIsRunning, spanStatusTone, spanWall } from "./util";

interface Props {
  roots: SpanNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
}

function Row({
  node,
  selectedId,
  onSelect,
  collapsedIds,
  onToggleCollapse,
}: {
  node: SpanNode;
} & Omit<Props, "roots">) {
  const { span } = node;
  const km = KIND_META[span.kind] ?? { icon: "·", label: span.kind };
  const hasKids = node.children.length > 0;
  const collapsed = collapsedIds.has(span.id);
  const tone = spanStatusTone(span);
  const wall = spanWall(span);
  const tokTotal = node.agg.tokensIn + node.agg.tokensOut;

  return (
    <>
      <div
        role="treeitem"
        aria-selected={span.id === selectedId}
        aria-level={node.depth + 1}
        tabIndex={-1}
        className={`az-row${span.id === selectedId ? " sel" : ""}${tone === "err" ? " dim" : ""}`}
        onClick={() => onSelect(span.id)}
        onKeyDown={(e) => e.key === "Enter" && onSelect(span.id)}
        title={`${km.label} · ${span.name}\nstatus=${span.status} model=${span.model || "—"}@${
          span.provider || "—"
        }\nΣ ${fmtTokens(tokTotal)} tok · ${fmtCost(node.agg.costUsd)}`}
      >
        <span className="az-guides">
          {Array.from({ length: node.depth }, (_, i) => (
            <i key={i} className={`az-guide${i === node.depth - 1 ? " active" : ""}`} />
          ))}
        </span>
        <button
          className={`az-caret${hasKids ? "" : " leaf"}`}
          aria-label={collapsed ? "expand" : "collapse"}
          onClick={(e) => {
            e.stopPropagation();
            if (hasKids) onToggleCollapse(span.id);
          }}
        >
          {hasKids ? (collapsed ? "▶" : "▼") : "•"}
        </button>
        <span className="az-kicon" aria-hidden>
          {km.icon}
        </span>
        <span className="az-name">{span.name}</span>
        <span className="az-spacer" />
        {span.model ? <span className="az-sub">{span.model}</span> : null}
        <span className="az-chip dur" title="own wall time">
          {tone === "running" ? "…" : fmtMs(wall)}
        </span>
        <span className="az-chip tok" title="subtree Σ tokens_in+out">
          Σ{fmtTokens(tokTotal)}
        </span>
        <span className="az-chip cost" title="subtree Σ cost">
          {fmtCost(node.agg.costUsd)}
        </span>
        <span className={`az-dot ${tone}`} title={span.status} />
      </div>
      {hasKids && !collapsed && (
        <div role="group">
          {node.children.map((c) => (
            <Row
              key={c.span.id}
              node={c}
              selectedId={selectedId}
              onSelect={onSelect}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function SpanTree({ roots, ...rest }: Props) {
  if (roots.length === 0) {
    return (
      <div className="az-empty">
        no spans match the current filter
        <br />
        <span style={{ fontSize: 11 }}>waiting for trace data or loosen the kind/text filters</span>
      </div>
    );
  }
  return (
    <div className="az-tree" role="tree" aria-label="trace span tree">
      {roots.map((r) => (
        <Row key={r.span.id} node={r} {...rest} />
      ))}
    </div>
  );
}
