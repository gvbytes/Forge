// Bottom terminal panel, two tabs:
//   USER   — real interactive PTY terminal (xterm.js ↔ /api/term websocket).
//            The user types; no approval gates (PS 8b gates the AGENT, not you).
//   AGENT  — replay of approved/denied agent bash output from the event log.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTimeline, type ToolItem } from "../stores/chat";
import { useUi } from "../stores/ui";
import { useStickBottom } from "../hooks/useStickBottom";
import { api } from "../lib/api";

function cmdOf(item: ToolItem): string {
  const inp = (item.input ?? {}) as Record<string, any>;
  const c = inp.command ?? inp.cmd ?? inp.argv;
  if (Array.isArray(c)) return c.join(" ");
  return typeof c === "string" ? c : "(no command captured)";
}

function outputOf(item: ToolItem): string {
  const o = item.output;
  if (o === undefined || o === null) return "";
  if (typeof o === "string") return o;
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return String(o);
  }
}

// Structural types for the dynamically-imported xterm pieces (keeps deps light).
interface TermHandle {
  open(el: HTMLElement): void;
  focus(): void;
  onData(cb: (d: string) => void): unknown;
  onResize(cb: (dims: { cols: number; rows: number }) => void): unknown;
  write(d: string | Uint8Array): void;
  dispose(): void;
  attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean): void;
  getSelection(): string;
  cols: number;
  rows: number;
}
interface FitHandle { fit(): void }

function UserTerminal({ visible, projectId }: { visible: boolean; projectId: string | null }) {
  const host = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // B4#1: term/fit live in refs (was a `(host as any).__term` hack) so the
  // resize handler can actually reach them.
  const termRef = useRef<TermHandle | null>(null);
  const fitRef = useRef<FitHandle | null>(null);
  const [status, setStatus] = useState("connecting…");
  // B4#3: bumping epoch re-runs the setup effect → fresh term + ws, no reload.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    setStatus("connecting…");

    // B36: resize rides a JSON control frame: {"resize":{cols,rows}}.
    const sendResize = () => {
      const t = termRef.current;
      const w = wsRef.current;
      if (!t || !w || w.readyState !== WebSocket.OPEN) return;
      w.send(JSON.stringify({ resize: { cols: t.cols, rows: t.rows } }));
    };
    // B4-R2#3: one refit path for every trigger (window resize, host-div
    // ResizeObserver, tab activation, ws open). fit() is a no-op when the
    // cell-size hasn't changed, and onResize only fires on real changes, so
    // there is no refit→resize→refit loop.
    const refit = () => {
      const fit = fitRef.current;
      if (!fit || !host.current || host.current.offsetParent === null) return;
      try { fit.fit(); } catch { return; }
      sendResize();
    };

    (async () => {
      // WAVE-CHI#1: pinned to @xterm/xterm@5.5.0 + @xterm/addon-fit@0.10.0 —
      // xterm 6.0.0's bundled requestMode (DECRQM handler) shipped with a
      // `ReferenceError: i is not defined`, so `printf '\033[?2004$p'`
      // page-errored and froze rendering forever. 5.5.0 is battle-tested and
      // API-identical for what we use (Terminal, FitAddon, onData, onResize,
      // open, write(Uint8Array)).
      const xterm = await import("@xterm/xterm");
      const fitAddon = await import("@xterm/addon-fit");
      if (disposed || !host.current) return;
      const term = new xterm.Terminal({
        fontSize: 12,
        theme: { background: "#0d1117", foreground: "#e6edf3", cursor: "#d19a3e" },
        cursorBlink: true,
        convertEol: true,
      });
      const fit = new fitAddon.FitAddon();
      term.loadAddon(fit);
      // Terminal-native copy/paste. Without this, Ctrl+Shift+C/V fall through to
      // the BROWSER (DevTools / nothing) instead of the terminal. Copy grabs the
      // xterm selection; paste reads the clipboard and feeds it to the PTY.
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;
        const copy =
          ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === "KeyC") ||
          (ev.ctrlKey && !ev.shiftKey && ev.code === "Insert");
        if (copy) {
          const sel = term.getSelection();
          if (sel) {
            ev.preventDefault();
            void navigator.clipboard?.writeText(sel).catch(() => {});
            return false;
          }
          return true; // no selection → let the browser keep its shortcut
        }
        const paste =
          ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === "KeyV") ||
          (ev.shiftKey && !ev.ctrlKey && ev.code === "Insert");
        if (paste) {
          ev.preventDefault();
          navigator.clipboard
            ?.readText()
            .then((t) => {
              if (!t) return;
              const w = wsRef.current;
              if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ input: t }));
            })
            .catch(() => {
              /* clipboard permission denied — right-click → paste still works */
            });
          return false;
        }
        // Protect pipe-connected shells from ANSI arrow key sequences that cause cursor drift across the prompt
        if (ev.code === "ArrowUp" || ev.code === "ArrowDown" || ev.code === "ArrowLeft" || ev.code === "ArrowRight") {
          return false;
        }
        return true;
      });
      term.open(host.current);
      try { fit.fit(); } catch { /* not yet laid out */ }
      termRef.current = term;
      fitRef.current = fit;
      // WAVE-CHI#2 (send): keystrokes/pastes ride text frames AS BEFORE. The
      // server treats a text frame as control ONLY if it parses as
      // {"resize":[c,r]}; anything else falls through to the PTY as raw
      // input. Bracketed-paste wrapping (\x1b[200~…\x1b[201~) protects a
      // paste that literally looks like resize JSON.
      term.onData((d) => {
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify({ input: d }));
        }
      });
      term.onResize(({ cols, rows }) => {
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify({ resize: { cols, rows } }));
        }
      });

      // B36: tell the engine WHICH project's root to spawn the shell in —
      // /api/term?projectId=… (query or body are both accepted).
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = api.termWsUrl(projectId).replace(/^http/, proto);
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus("live");
        term.focus();
        setTimeout(refit, 50);
      };
      ws.onmessage = (m) => {
        if (typeof m.data === "string") {
          const s = m.data;
          if (s.charCodeAt(0) === 0x7b /* '{' */) {
            try {
              const c = JSON.parse(s);
              if (c && typeof c === "object") {
                if (c.resize) return; // resize echo/ack — never terminal output
                if (typeof c.data === "string") {
                  term.write(c.data);
                  return;
                }
              }
            } catch { /* not control — fall through and render */ }
          }
          term.write(s);
          return;
        }
        term.write(new Uint8Array(m.data as ArrayBuffer));
      };
      // B4#3: server-side close surfaces as "exited" (restart button next to it).
      ws.onclose = () => { if (!disposed) setStatus("exited"); };
      ws.onerror = () => { if (!disposed) setStatus("error"); };

      // WAVE-CHI#3: ResizeObserver on the host div is the primary refit
      // trigger — it covers window resizes, panel collapse/expand and tab
      // activation in one mechanism (the div goes to/from size 0).
      ro = new ResizeObserver(() => refit());
      ro.observe(host.current);
    })();

    // Belt-and-braces: window resize (RO covers it too, but the window
    // listener also catches zoom/font-size changes that keep the div size).
    window.addEventListener("resize", refit);
    return () => {
      disposed = true;
      window.removeEventListener("resize", refit);
      ro?.disconnect();
      const t = termRef.current;
      termRef.current = null;
      fitRef.current = null;
      const w = wsRef.current;
      wsRef.current = null;
      w?.close();
      try { t?.dispose(); } catch { /* already gone */ }
    };
    // B36: reconnect when the project changes so the shell cwd follows it.
  }, [epoch, projectId]);

  // B4#1/B4#2: refit + refocus when this tab becomes visible again (the
  // component stays mounted while hidden, so sizes may be stale).
  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;
      try { fit.fit(); } catch { /* not laid out yet */ }
      term.focus();
    }, 30);
    return () => window.clearTimeout(id);
  }, [visible, epoch]);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <span className="dim tiny-text" style={{ position: "absolute", top: 4, right: 10, zIndex: 2, display: "flex", gap: 6, alignItems: "center" }}>
        {status}
        <button
          type="button"
          className="btn tiny ghost"
          title="restart terminal — new session, no page reload"
          onClick={() => setEpoch((e) => e + 1)}
        >↻ restart</button>
      </span>
      <div ref={host} style={{ height: "100%", padding: "2px 8px" }} />
    </div>
  );
}

function AgentReplay() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const timeline = useTimeline(activeTaskId);
  const stick = useStickBottom(timeline.length);
  const runs = useMemo(
    () =>
      timeline.filter(
        // web #25: the engine's shell tool is `run_command` (accept "bash" too);
        // tool rows now arrive live via the trace bridge, including running ones.
        (it): it is ToolItem => it.kind === "tool" && (it.tool === "run_command" || it.tool === "bash"),
      ),
    [timeline],
  );

  return (
    <div ref={stick.ref} style={{ height: "100%", overflow: "auto", padding: "4px 10px" }}>
      {runs.length === 0 && <span className="dim tiny-text">agent bash output will replay here…</span>}
      {runs.map((r) => (
        <div key={r.id} style={{ marginBottom: 8 }}>
          <div className="mono tiny-text" style={{ color: r.ok === false ? "#f85149" : "#7ee787" }}>
            $ {cmdOf(r)}
          </div>
          <pre style={{ margin: "2px 0 0", whiteSpace: "pre-wrap", fontSize: 11, color: "#9aa4b2" }}>
            {outputOf(r)}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function TerminalPanel() {
  const terminalOpen = useUi((s) => s.terminalOpen);
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const projectId = useUi((s) => s.projectId);
  const [tab, setTab] = useState<"user" | "agent">("user");

  // B4#2: one stable tree for collapsed AND expanded states — the body is
  // hidden, never unmounted, so the PTY session survives both tab switches
  // and collapse/expand cycles.
  return (
    // B2#3: fixed-height panel (was height:100%, which crushed the editor).
    <div
      className={`terminal-panel${terminalOpen ? "" : " collapsed"}`}
      style={terminalOpen
        ? { display: "flex", flexDirection: "column", height: 320, maxHeight: "40%", flex: "none" }
        : { flex: "none" }}
    >
      <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ cursor: "pointer" }} onClick={toggleTerminal}
              title={terminalOpen ? "collapse" : "open terminal"}>
          {terminalOpen ? "▾ TERMINAL" : "▸ TERMINAL"}
        </span>
        {terminalOpen && (
          <>
            {(["user", "agent"] as const).map((t) => (
              <button key={t} type="button" className={`btn tiny${tab === t ? " active" : ""}`}
                      onClick={() => setTab(t)} style={{ opacity: tab === t ? 1 : 0.6 }}>
                {t === "user" ? "user" : "agent replay"}
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="btn tiny ghost" onClick={toggleTerminal}>✕</button>
          </>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: terminalOpen ? undefined : "none" }}>
        {/* B4#2: BOTH tabs stay mounted; the inactive one is hidden, not
            unmounted, so switching tabs no longer kills the PTY session. */}
        <div style={{ height: "100%", display: tab === "user" ? "block" : "none" }}>
          <UserTerminal visible={tab === "user" && terminalOpen} projectId={projectId} />
        </div>
        <div style={{ height: "100%", display: tab === "agent" ? "block" : "none" }}>
          <AgentReplay />
        </div>
      </div>
    </div>
  );
}
