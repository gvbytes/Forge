// Multi-tab code editor with Monaco: syntax highlight for all major languages,
// context-pin gutter marks + highlight ranges, unsaved-edit indicators ("●"),
// save (Ctrl+S) via REST, and in-band run output.
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useEditor } from "../stores/editor";
import { useUi } from "../stores/ui";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

interface DecorationOpts {
  range: { startLineNumber: number; endLineNumber: number };
  options: {
    isWholeLine?: boolean;
    className?: string;
    linesDecorationsClassName?: string;
  };
}
interface MonacoHandle {
  deltaDecorations(old: string[], add: DecorationOpts[]): string[];
  layout(): void;
}

class EditorErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", json: "json", css: "css", scss: "scss", html: "html",
    md: "markdown", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
    rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", sql: "sql",
  };
  return map[ext] ?? "plaintext";
}

function CodeView({ path, value, onChange, readOnly = false }: { path: string; value: string; onChange: (v: string) => void; readOnly?: boolean }) {
  const allPins = useEditor((s) => s.pins);
  const pins = useMemo(() => allPins.filter((p: { path: string }) => p.path === path), [allPins, path]);
  const edRef = useRef<MonacoHandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const decoRef = useRef<string[]>([]);
  // bumped on every Monaco (re)mount so the decoration effect re-runs against
  // the fresh instance — the effect alone runs before the async onMount fires,
  // so without this the pin marks never appear on first open / tab switch.
  const [editorMounts, setEditorMounts] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      try {
        edRef.current?.layout?.();
      } catch {}
    });
    ro.observe(containerRef.current);
    const onWinResize = () => {
      try {
        edRef.current?.layout?.();
      } catch {}
    };
    window.addEventListener("resize", onWinResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
    };
  }, []);

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    try {
      decoRef.current = ed.deltaDecorations(
        decoRef.current,
        pins.map((p: { start_line?: number; end_line?: number }) => ({
          range: {
            startLineNumber: Math.max(1, p.start_line ?? 1),
            endLineNumber: Math.max(1, p.end_line ?? p.start_line ?? 1),
          },
          options: {
            isWholeLine: true,
            className: "pin-line-hl",
            linesDecorationsClassName: "pin-gutter-mark",
          },
        })),
      );
    } catch {}
  }, [pins, path, value, editorMounts]);

  return (
    <EditorErrorBoundary
      fallback={<pre className="code-fallback">{value}</pre>}
    >
      <Suspense fallback={<div className="code-loading dim">loading editor…</div>}>
        <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 0, position: "relative" }}>
          <MonacoEditor
            key={path}
            language={langOf(path)}
            theme="vs-dark"
            value={value}
            onChange={(v: string | undefined) => onChange(v ?? "")}
            options={{
              readOnly,
              fontSize: 13,
              minimap: { enabled: true, scale: 1 },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderWhitespace: "selection",
              smoothScrolling: true,
            }}
            onMount={(editor: unknown) => {
              edRef.current = editor as unknown as MonacoHandle;
              decoRef.current = []; // decoration ids belong to the previous (disposed) instance
              setEditorMounts((n) => n + 1); // apply pin decorations to the fresh instance
              setTimeout(() => {
                try { (editor as any)?.layout?.(); } catch {}
              }, 50);
            }}
          />
        </div>
      </Suspense>
    </EditorErrorBoundary>
  );
}

export function EditorTabs() {
  const openTabs = useEditor((s) => s.openTabs);
  const activeTab = useEditor((s) => s.activeTab);
  const contents = useEditor((s) => s.contents);
  const loadErrors = useEditor((s) => s.loadErrors);
  const setActiveTab = useEditor((s) => s.setActiveTab);
  const closeTab = useEditor((s) => s.closeTab);
  const dirty = useEditor((s) => s.dirty);
  const stale = useEditor((s) => s.stale);
  const setDirty = useEditor((s) => s.setDirty);
  const saveFile = useEditor((s) => s.saveFile);
  // Live coding: while the agent is writing a file, the editor shows the
  // decoded stream instead of the stale disk copy (see engine/src/livecode.ts).
  const streaming = useEditor((s) => s.streaming);
  const streamingActive = useEditor((s) => s.streamingActive);
  const [runOut, setRunOut] = useState<{ path: string; ok: boolean; cmd: string; output: string } | null>(null);

  const tryClose = (t: string) => {
    if (dirty[t] && !window.confirm(`Discard unsaved changes in ${t.split("/").pop() ?? t}?`)) return;
    if (runOut?.path === t) setRunOut(null);
    closeTab(t);
  };

  const [runBusy, setRunBusy] = useState(false);

  const doSave = useCallback(async () => {
    if (!activeTab) { useUi.getState().toast("no file open", "err"); return; }
    if (loadErrors[activeTab]) {
      useUi.getState().toast("cannot save — file failed to load", "err");
      return;
    }
    try { await saveFile(activeTab); } catch (e) { setRunOut({ path: activeTab, ok: false, cmd: "save", output: String(e) }); }
  }, [activeTab, loadErrors, saveFile]);

  const doRun = async () => {
    if (!activeTab || runBusy) return;
    setRunBusy(true);
    setRunOut({ path: activeTab, ok: true, cmd: `running ${activeTab}…`, output: "" });
    try {
      const r = await api.runFile({ path: activeTab, timeout_s: 120 });
      setRunOut({ path: activeTab, ...r });
      // HTML/CSS → open preview in new tab. web #26: RELATIVE url so it rides
      // the Vite proxy (no hardcoded engine host).
      if ((r as any).previewUrl) {
        window.open(String((r as any).previewUrl), "_blank");
      }
    } catch (e) { setRunOut({ path: activeTab, ok: false, cmd: "run", output: String(e) }); }
    setRunBusy(false);
  };
  // web #26: proper deps array (was re-attaching on every render).
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "s") {
        ev.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doSave]);

  const liveText = activeTab ? streaming[activeTab] : undefined;
  const isStreaming = liveText !== undefined;
  const liveActive = activeTab ? streamingActive[activeTab] === true : false;

  return (
    <div className="editor-tabs">
      <div className="tab-bar">
        {openTabs.map((t) => (
          <button
            type="button"
            key={t}
            className={`etab${activeTab === t ? " active" : ""}`}
            onClick={() => setActiveTab(t)}
            title={t}
          >
            <span className="etab-label">
              {streamingActive[t] ? <span className="livecode-dot" aria-hidden /> : dirty[t] ? "● " : ""}
              {t.split("/").pop()}
            </span>
            <span
              role="button"
              tabIndex={0}
              className="etab-close"
              aria-label={`close ${t}`}
              onClick={(e) => { e.stopPropagation(); tryClose(t); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); tryClose(t); } }}
            >
              ✕
            </span>
          </button>
        ))}
        {openTabs.length === 0 && <span className="dim tiny-text tab-hint">no file open — pick one in the explorer</span>}
      </div>
      <div className="tab-body">
        {!activeTab ? (
          <div className="empty-center">
            <div className="ec-mark" aria-hidden />
            <p className="ec-title">No file open</p>
            <p className="ec-sub">Pick a file from the explorer, or describe a change in the chat and the agent will open what it needs.</p>
            <ul className="ec-keys">
              <li><kbd>Ctrl</kbd><kbd>S</kbd><span>save</span></li>
              <li><kbd>A</kbd><span>approve pending change</span></li>
              <li><kbd>D</kbd><span>deny</span></li>
            </ul>
          </div>
        ) : loadErrors[activeTab] ? (
          <div className="err-strip">{loadErrors[activeTab]}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
            {stale[activeTab] && (
              <div className="stale-strip" title="you have unsaved edits in this buffer; the file on disk may differ">
                ● modified in editor — save to keep your edits or close the tab to discard
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px", borderBottom: "1px solid #21262d" }}>
              <button className="btn tiny" onClick={() => void doSave()}
                      title="Ctrl+S">{dirty[activeTab] ? "● save" : "saved"}</button>
              <button className="btn tiny" onClick={() => void doRun()} disabled={runBusy}>{runBusy ? "…" : "▶ run"}</button>
              <span className="dim tiny-text">{activeTab}</span>
            </div>
            {runOut && runOut.path === activeTab && (
              <div className={`runner-output ${runOut.ok ? "ok" : "err"}`}>
                <div className="runner-output-bar">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span className={`tiny-text ${runOut.ok ? "ok-text" : "err-text"}`} style={{ fontWeight: 600 }}>
                      {runBusy ? "● running…" : runOut.ok ? "✔ run completed" : "✖ run failed"}
                    </span>
                    <span className="dim tiny-text mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {`$ ${runOut.cmd}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {(runOut as any).previewUrl && (
                      <a
                        href={String((runOut as any).previewUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="btn tiny"
                        title="Open preview in new tab"
                      >
                        Open Preview ↗
                      </a>
                    )}
                    <button
                      type="button"
                      className="btn tiny"
                      onClick={() => setRunOut(null)}
                      title="Close run output"
                      aria-label="Close run output"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <pre className="runner-output-pre">
                  {runOut.output || (runBusy ? "" : "(no output)")}
                  {runBusy && <span className="dim tiny-text"> running…</span>}
                </pre>
              </div>
            )}
            {isStreaming && (
              <div className="livecode-strip" title="the agent is writing this file — nothing has been saved to disk yet">
                <span className="livecode-dot" aria-hidden />
                agent is writing {activeTab.split("/").pop()}
                {liveActive ? "…" : " — awaiting your approval"}
              </div>
            )}
            <div style={{ flex: "1 1 0%", minHeight: 0, height: "100%", position: "relative" }}>
              <CodeView
                path={activeTab}
                value={isStreaming ? liveText : contents[activeTab] ?? ""}
                // A streaming preview is not yours to edit yet: it is an
                // unapproved change, and typing into it would be silently
                // overwritten by the next token.
                readOnly={isStreaming}
                onChange={(v) => { setDirty(activeTab, true); useEditor.setState((st) => ({ contents: { ...st.contents, [activeTab]: v } })); }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
