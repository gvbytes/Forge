// ContextPanel — manual context control (PS requirement #7): list pins,
// remove, add-by-path ("path" | "path:L40-L80"), per-pin token estimate
// (~chars / 3.5, range-aware when the file content is fetchable).
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { parsePathRef } from "../lib/composer";
import type { PinDto } from "../lib/types";
import { useEditor } from "../stores/editor";
import { useUi } from "../stores/ui";

const MAX_CACHE_CHARS = 500_000;

export function ContextPanel() {
  const projectId = useUi((s) => s.projectId);
  const pins = useEditor((s) => s.pins);
  const refreshPins = useEditor((s) => s.refreshPins);
  const addPin = useEditor((s) => s.addPin);
  const removePin = useEditor((s) => s.removePin);
  const openFile = useEditor((s) => s.openFile);

  const [pathInput, setPathInput] = useState("");
  const [contents, setContents] = useState<Record<string, string>>({});

  useEffect(() => {
    void refreshPins();
    // Folder isolation: pins are relative paths — the content cache must not
    // reuse the OLD project's content for a same-named file in the new one.
    setContents({});
  }, [refreshPins, projectId]);

  // lazily pull content of pinned paths to estimate tokens
  useEffect(() => {
    const missing = [...new Set(pins.map((p) => p.path))].filter(
      (p) => !(p in contents),
    );
    if (missing.length === 0) return;
    let alive = true;
    void (async () => {
      const next = { ...contents };
      await Promise.all(
        missing.map(async (mp) => {
          try {
            const f = await api.readFile(mp);
            next[mp] = f.content.length > MAX_CACHE_CHARS ? "" : f.content;
          } catch {
            next[mp] = "";
          }
        }),
      );
      if (alive) setContents(next);
    })();
    return () => { alive = false; };
  }, [pins, contents]);

  const estimateTokens = (pin: PinDto): string => {
    const c = contents[pin.path];
    if (c === undefined) return "…";
    if (c === "") return "~?";
    const start = pin.start_line ?? 1;
    const end = pin.end_line ?? c.split("\n").length;
    const slice = pin.start_line !== undefined || pin.end_line !== undefined
      ? c.split("\n").slice(Math.max(0, start - 1), end).join("\n")
      : c;
    return `~${Math.max(1, Math.round(slice.length / 3.5))}`;
  };

  const submitPath = async () => {
    const pin = parsePathRef(pathInput);
    if (!pin) return;
    if (await addPin(pin)) setPathInput("");
  };

  const totalTokens = pins.reduce<number>((acc, p) => {
    const est = estimateTokens(p);
    const n = Number(est.replace(/[^\d]/g, ""));
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  return (
    <div className="context-panel">
      <div className="panel-head">
        <span>CONTEXT PINS</span>
        <span className="spacer" />
        <span className="dim tiny-text" title="rough estimate across pins">≈{totalTokens} tok</span>
        <button type="button" className="btn tiny" title="refresh pins" onClick={() => void refreshPins()}>⟳</button>
      </div>

      <div className="pin-list">
        {pins.length === 0 && (
          <p className="dim empty-hint">
            No pins. Hover a file in the tree for <b>＋pin</b>, or add by path below.
            Pins survive compaction (protected set).
          </p>
        )}
        {pins.map((p, i) => (
          <div key={`${p.path}:${p.start_line ?? ""}-${i}`} className="pin-row">
            <button
              type="button"
              className="pin-main"
              title={`open ${p.path}${p.start_line ? `:${p.start_line}` : ""}`}
              onClick={() => void openFile(p.path)}
            >
              <code>{p.path}</code>
              {(p.start_line !== undefined || p.end_line !== undefined) && (
                <span className="chip range">
                  L{p.start_line ?? 1}-L{p.end_line ?? p.start_line ?? "?"}
                </span>
              )}
            </button>
            <span className="chip est" title="≈ chars/3.5">{estimateTokens(p)}</span>
            <button
              type="button"
              className="btn tiny danger"
              title="remove pin"
              onClick={() => void removePin(i)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="pin-add">
        <input
          value={pathInput}
          placeholder="src/lib/api.ts or src/app.ts:L40-L80"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submitPath(); }}
        />
        <button type="button" className="btn" onClick={() => void submitPath()}>Add</button>
      </div>
    </div>
  );
}

