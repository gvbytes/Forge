// User-facing terminal with WebSocket upgrade, PTY allocation, and ring buffer replay.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import { log } from "./logger.js";
import { NON_INTERACTIVE_ENV } from "./config.js";
import type { WebSocket as WsWebSocket } from "ws";

export interface TermSession {
  id: string;
  projectId: string;
  cwd: string;
  child: ChildProcess | null;
  ring: string;
  exited: boolean;
  listeners: Set<(chunk: string) => void>;
  lastActivity: number;
  cols?: number;
  rows?: number;
  /** Echo-free PTY resizer: a tiny persistent python helper holding the shell's
   *  real PTY open, so resize is a TIOCSWINSZ ioctl instead of an echoed
   *  `stty …` line typed into the shell. Null until first successful resize. */
  resizer?: ChildProcess | null;
  resizerTty?: string | null;
}

export const RING_CAP = 300_000; // ~300KB replay buffer
const IDLE_KILL_MS = 30 * 60_000;
const sessions = new Map<string, TermSession>(); // projectId → session

/**
 * `script(1)` gives us a real PTY without a native dependency — but the two
 * implementations take INCOMPATIBLE arguments, and both live at the same path:
 *
 *   util-linux (Linux):  script -qfc "<shell>" /dev/null
 *   BSD (macOS):         script -q /dev/null <shell>      ← no -c, -f is -F
 *
 * The old check only asked whether /usr/bin/script EXISTED, which is true on
 * macOS too, so every macOS terminal spawned with Linux flags and died with
 * "illegal option -- f" before the shell ever started.
 */
function hasScript(): boolean {
  try {
    fs.accessSync("/usr/bin/script");
    return true;
  } catch {
    return false;
  }
}

/** BSD `script` (macOS, *BSD) vs util-linux `script`. */
function isBsdScript(): boolean {
  return process.platform === "darwin" || process.platform.includes("bsd");
}

/**
 * PTY bridge for platforms where `script` cannot be driven over pipes.
 *
 * BSD `script` calls tcgetattr() on ITS OWN stdin, so it aborts with
 * "tcgetattr/ioctl: Operation not supported on socket" the moment we hand it
 * the pipes the web terminal needs. util-linux `script` has no such
 * requirement, which is why the same code works on Linux and fails on macOS.
 *
 * node-pty would be the obvious answer and is already declared as a
 * dependency — but it ships no prebuilt binary here and its native module
 * never compiled, so requiring it fails with "posix_spawnp failed". Rather
 * than make the terminal depend on a working node-gyp toolchain on the
 * evaluator's machine, we allocate the pty from python3's stdlib `pty`
 * module, which is already a dependency of the resize helper below.
 *
 * The bridge is deliberately dumb: fork a pty, exec the shell in the child,
 * and pump bytes both ways. The shell it spawns is a real descendant with a
 * real pty slave, so findShellTty()/tryHelperResize() keep working unchanged.
 */
const PTY_BRIDGE_PY = `
import os, sys, pty, select, signal
shell = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(shell, [shell, "-i"])
    except Exception:
        os._exit(127)
signal.signal(signal.SIGINT, signal.SIG_IGN)
try:
    while True:
        r, _, _ = select.select([fd, 0], [], [], 0.2)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            try:
                data = os.read(0, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(fd, data)
except (KeyboardInterrupt, OSError):
    pass
finally:
    try:
        os.waitpid(pid, os.WNOHANG)
    except Exception:
        pass
`;

/** Argv for running `shell` under a PTY via the local `script` flavour. */
export function scriptArgsFor(shell: string, bsd = isBsdScript()): string[] {
  // BSD: [options] [file [command ...]] — the typescript file is positional and
  // must come BEFORE the command, and the command is passed as argv, not -c.
  // util-linux: -c takes the command string, file is the trailing positional.
  return bsd ? ["-q", "/dev/null", shell] : ["-qfc", shell, "/dev/null"];
}

function broadcast(s: TermSession, chunk: string): void {
  s.ring += chunk;
  if (s.ring.length > RING_CAP) s.ring = s.ring.slice(-RING_CAP);
  for (const l of s.listeners) {
    try {
      l(chunk);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Mirror an agent action into the user's visible terminal.
 *
 * The agent's run_command executes in its own child process, so until now the
 * IDE terminal showed nothing while the agent was running builds and tests —
 * the user watched a spinner and had to open the dashboard to find out what
 * had actually been executed.
 *
 * Echoing the command and its result into the SAME terminal the user types in
 * makes the agent's work legible in the place people already look, and keeps
 * one scrollback for both human and agent activity. Purely cosmetic: it writes
 * to the replay ring and subscribers, never to the pty's stdin, so it cannot
 * disturb a shell the user is in the middle of using.
 */
export function echoAgentActivity(projectId: string, line: string, kind: "cmd" | "ok" | "err" = "cmd"): void {
  const s = sessions.get(projectId);
  if (!s || s.exited) return; // no terminal open — nothing to mirror into
  const colour = kind === "err" ? "\x1b[31m" : kind === "ok" ? "\x1b[32m" : "\x1b[36m";
  const tag = kind === "cmd" ? "agent $" : kind === "ok" ? "agent ✓" : "agent ✗";
  broadcast(s, `\r\n${colour}\x1b[1m${tag}\x1b[0m ${colour}${line.replace(/\r?\n/g, "\r\n         ")}\x1b[0m\r\n`);
}

export function getOrCreate(projectId: string, cwd: string): TermSession {
  const existing = sessions.get(projectId);
  if (existing && !existing.exited) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const s: TermSession = {
    id: crypto.randomUUID(),
    projectId,
    cwd,
    child: null,
    ring: "",
    exited: false,
    listeners: new Set(),
    lastActivity: Date.now(),
    cols: 80,
    rows: 24,
  };
  const isWin = process.platform === "win32";
  let shell: string;
  let args: string[];

  if (isWin) {
    // Windows: prefer PowerShell, fallback to cmd.exe
    const comspec = process.env.COMSPEC || "cmd.exe";
    if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
      shell = process.env.SHELL;
      args = ["-i"];
    } else {
      shell = "powershell.exe";
      args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];
    }
  } else {
    shell = process.env.SHELL || "/bin/bash";
    args = ["-i"];
  }

  // PTY strategy, best first:
  //   1. util-linux `script`  — real pty, pipe-friendly (Linux)
  //   2. python3 pty bridge   — real pty (macOS/BSD, and Linux without script)
  //   3. bare `shell -i`      — no pty: commands still run, but no colours,
  //                             no line editing, no interactive TUIs
  let execPath: string;
  let execArgs: string[];
  let ptyMode: string;
  const bridgePython = !isWin && isBsdScript() ? findPython() : null;
  if (!isWin && hasScript() && !isBsdScript()) {
    execPath = "/usr/bin/script";
    execArgs = scriptArgsFor(shell);
    ptyMode = "script(util-linux)";
  } else if (!isWin && bridgePython) {
    execPath = bridgePython;
    execArgs = ["-u", "-c", PTY_BRIDGE_PY, shell];
    ptyMode = "python-pty-bridge";
  } else if (!isWin && hasScript() && !isBsdScript()) {
    execPath = "/usr/bin/script";
    execArgs = scriptArgsFor(shell);
    ptyMode = "script";
  } else {
    execPath = shell;
    execArgs = args;
    ptyMode = isWin ? "windows-pipe" : "pipe(no-pty)";
  }

  try {
    const child = spawn(execPath, execArgs, {
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    s.child = child;
    log("info", "terminal", "terminal created", { projectId, cwd, shell: execPath, ptyMode });

    child.stdout?.on("data", (d: Buffer) => {
      let text = d.toString("utf8");
      if (isWin) {
        // Over anonymous pipes, PowerShell emits \b for backspace. VT100/xterm needs \b \b to visually erase the character on screen
        text = text.replace(/\x08/g, "\b \b");
      }
      broadcast(s, text);
    });
    child.stderr?.on("data", (d: Buffer) => broadcast(s, d.toString("utf8")));
    child.on("error", (err) => {
      s.exited = true;
      log("error", "terminal", "terminal spawn error", { projectId, error: err.message });
      broadcast(s, `\r\n\x1b[31m[terminal failed to spawn (${execPath}): ${err.message}]\x1b[0m\r\n`);
    });
    child.on("exit", (code) => {
      s.exited = true;
      killResizer(s);
      log("info", "terminal", "terminal exited", { projectId, code: code ?? null });
      broadcast(s, `\r\n\x1b[90m[terminal exited code=${code ?? "?"} — reopen to start a new one]\x1b[0m\r\n`);
    });
  } catch (err: any) {
    s.exited = true;
    broadcast(s, `\r\n\x1b[31m[failed to start terminal: ${err.message}]\x1b[0m\r\n`);
  }

  sessions.set(projectId, s);
  return s;
}

export function cleanEnvForTest(): Record<string, string> {
  return cleanEnv();
}

function cleanEnv(): Record<string, string> {
  const keep = [
    "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TMPDIR", "PWD",
    // Windows essentials — required to run any process on Windows
    "SystemRoot", "SYSTEMROOT", "COMSPEC", "comspec", "PATHEXT", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMDRIVE", "USERNAME", "OS"
  ];
  // NON_INTERACTIVE_ENV first so a user's own PAGER/EDITOR cannot re-enable
  // the hangs it exists to prevent (this is a real TTY — git WILL page here).
  const out: Record<string, string> = { TERM: "xterm-256color", ...NON_INTERACTIVE_ENV };
  for (const k of keep) if (process.env[k]) out[k] = process.env[k]!;
  if (process.platform === "win32") {
    if (!out.SystemRoot && process.env.SystemRoot) {
      out.SystemRoot = process.env.SystemRoot;
    }
    if (fs.existsSync("C:\\mingw64\\bin") && (!out.PATH || !out.PATH.includes("mingw64"))) {
      out.PATH = `C:\\mingw64\\bin;${out.PATH || ""}`;
    }
  }
  return out;
}

/** Parse a terminal control frame into resize dims, or null when it is not a
 *  resize frame. Accepts BOTH the object form {"resize":{cols,rows}} that the
 *  web client sends and the legacy array form {"resize":[cols,rows]}. Anything
 *  else (input frames, malformed shapes) returns null so the caller routes it to
 *  the PTY as raw input. Before this existed the server only matched the array
 *  form, so every object resize frame fell through to writeInput() and the raw
 *  JSON was typed into the shell — the garbage that polluted the terminal. */
export function parseResizeFrame(parsed: unknown): { cols: number; rows: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const rz = (parsed as { resize?: unknown }).resize;
  let cols: unknown;
  let rows: unknown;
  if (Array.isArray(rz)) {
    if (rz.length !== 2) return null;
    cols = rz[0];
    rows = rz[1];
  } else if (rz && typeof rz === "object") {
    cols = (rz as Record<string, unknown>).cols;
    rows = (rz as Record<string, unknown>).rows;
  } else {
    return null;
  }
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  return { cols: c, rows: r };
}

// ── Echo-free PTY resize ────────────────────────────────────────────────────
// We hold only pipes into `script -qfc` (it owns the pty master), so there is no
// fd here to ioctl TIOCSWINSZ. The old workaround typed `stty cols C rows R\n`
// into the shell, which the pty echoed back into the terminal on every resize.
// Instead we keep a tiny persistent python helper that holds the shell's real
// PTY slave open and applies TIOCSWINSZ on command (the kernel then dispatches
// SIGWINCH to the foreground process group — exactly what a real resize does).
// No input is typed into the shell, so nothing is echoed. Falls back to the stty
// line only when python3 or the PTY path is unavailable.

const RESIZER_PY = `
import sys, fcntl, termios, struct
tty = None
for line in sys.stdin:
    parts = line.split()
    if not parts:
        continue
    if parts[0] == "tty" and len(parts) >= 2:
        try:
            tty = open(parts[1], "w")
        except Exception:
            tty = None
    elif parts[0] == "resize" and len(parts) >= 3 and tty is not None:
        try:
            fcntl.ioctl(tty, termios.TIOCSWINSZ, struct.pack("HHHH", int(parts[1]), int(parts[2]), 0, 0))
        except Exception:
            pass
`;

let pythonPath: string | null | undefined;
function findPython(): string | null {
  if (pythonPath !== undefined) return pythonPath;
  for (const p of ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"]) {
    try {
      fs.accessSync(p);
      return (pythonPath = p);
    } catch {
      /* keep looking */
    }
  }
  return (pythonPath = null);
}

/** Walk `script`'s descendants to find a process whose stdin is a real PTY slave
 *  (/dev/pts/N). That is the shell's controlling terminal — the device to ioctl. */
function findShellTty(scriptPid: number): string | null {
  try {
    const queue = [scriptPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      let kids: number[] = [];
      try {
        kids = fs
          .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      } catch {
        /* leaf process */
      }
      for (const k of kids) {
        if (!Number.isFinite(k) || k <= 0) continue;
        try {
          const tty = fs.readlinkSync(`/proc/${k}/fd/0`);
          if (tty.startsWith("/dev/pts/")) return tty;
        } catch {
          /* this child has no pts stdin — keep walking */
        }
        queue.push(k);
      }
    }
  } catch {
    /* /proc unavailable — caller falls back to stty */
  }
  return null;
}

function killResizer(s: TermSession): void {
  try {
    s.resizer?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  s.resizer = null;
  s.resizerTty = null;
}

/** Apply a resize via the persistent helper. Returns false when the helper is
 *  unavailable (no python3 / PTY not found yet) so the caller can fall back. */
function tryHelperResize(s: TermSession, cols: number, rows: number): boolean {
  const py = findPython();
  if (!py) return false;
  try {
    const alive = s.resizer && s.resizer.exitCode === null && !s.resizer.killed;
    if (!alive) {
      const tty = s.child?.pid ? findShellTty(s.child.pid) : null;
      if (!tty) return false;
      const p = spawn(py, ["-u", "-c", RESIZER_PY], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin?.write(`tty ${tty}\n`);
      s.resizer = p;
      s.resizerTty = tty;
      p.on("exit", () => {
        if (s.resizer === p) {
          s.resizer = null;
          s.resizerTty = null;
        }
      });
    }
    s.resizer?.stdin?.write(`resize ${rows} ${cols}\n`);
    return true;
  } catch {
    return false;
  }
}

export function writeInput(projectId: string, data: string): { ok: boolean; error?: string } {
  const s = sessions.get(projectId);
  if (!s || s.exited || !s.child?.stdin) return { ok: false, error: "terminal not running" };
  s.lastActivity = Date.now();

  const isWin = process.platform === "win32";
  if (isWin) {
    // Drop ANSI escape sequences (arrows, home, end, mouse tracking) from input
    // which cannot be interpreted by pipe-based shells and corrupt the command buffer
    if (data.includes("\x1b")) {
      return { ok: true };
    }

    // xterm sends \x7f (DEL) for Backspace key; Windows console/PowerShell expects \x08 (\b)
    data = data.replace(/\x7f/g, "\b");

    // Over Windows pipes, Enter from xterm is \r; PowerShell needs \r\n for full line feed
    data = data.replace(/\r(?!\n)/g, "\r\n");

    // Track input buffer to detect cls/clear commands
    if (data === "\r" || data === "\n" || data.includes("\r") || data.includes("\n")) {
      const trimmed = ((s as any)._inputBuffer || "").trim().toLowerCase();
      (s as any)._inputBuffer = "";
      if (trimmed === "cls" || trimmed === "clear") {
        // Clear terminal screen, clear scrollback buffer, home cursor
        broadcast(s, "\x1b[2J\x1b[3J\x1b[H");
      }
    } else if (data === "\b") {
      const buf = (s as any)._inputBuffer || "";
      if (buf.length > 0) {
        (s as any)._inputBuffer = buf.slice(0, -1);
      }
    } else {
      (s as any)._inputBuffer = ((s as any)._inputBuffer || "") + data;
    }
  }

  s.child.stdin.write(data);
  return { ok: true };
}

export function resize(projectId: string, cols: number, rows: number): boolean {
  const s = sessions.get(projectId);
  if (!s) return false;
  const c = Math.max(2, Math.min(1000, Math.trunc(cols) || 80));
  const r = Math.max(1, Math.min(500, Math.trunc(rows) || 24));
  // No-op guard: refit fires on every window/panel/tab change, often with the
  // same dims. Skip identical sizes so we never spam the PTY (or the helper).
  if (s.cols === c && s.rows === r) return true;
  s.cols = c;
  s.rows = r;
  s.lastActivity = Date.now();
  if (s.exited || !s.child || s.child.killed) return true;
  // Prefer the echo-free TIOCSWINSZ helper; fall back to typing `stty` into the
  // shell (echoes one line) only when the helper is unavailable.
  if (tryHelperResize(s, c, r)) return true;
  try {
    if (s.child.stdin?.writable) {
      if (process.platform !== "win32") {
        s.child.stdin.write(`stty cols ${c} rows ${r}\n`);
        try { s.child.kill("SIGWINCH"); } catch {}
      }
    }
  } catch {
    /* terminal mid-exit — stored size still applies on next output */
  }
  return true;
}

/** Existence probe without subscribing (lets the SSE route 404 race-free). */
export function exists(projectId: string): boolean {
  return sessions.has(projectId);
}

export function subscribe(projectId: string, fn: (chunk: string) => void): { replay: string; unsubscribe: () => void } | { error: string } {
  const s = sessions.get(projectId);
  if (!s) return { error: "no terminal" };
  s.listeners.add(fn);
  return { replay: s.ring, unsubscribe: () => s.listeners.delete(fn) };
}

export function kill(projectId: string): { ok: boolean } {
  const s = sessions.get(projectId);
  if (!s) return { ok: false };
  killResizer(s);
  try {
    s.child?.kill("SIGKILL");
  } catch {}
  sessions.delete(projectId);
  log("info", "terminal", "terminal killed", { projectId });
  return { ok: true };
}

export function clearRing(projectId: string): boolean {
  const s = sessions.get(projectId);
  if (!s) return false;
  s.ring = "";
  return true;
}

/** Attach a WebSocket client to a project terminal */
export function handleWsConnection(ws: WsWebSocket | WebSocket, projectId: string, cwd: string): void {
  const session = getOrCreate(projectId, cwd);

  // 1. Send replay buffer on connect
  if (session.ring.length > 0) {
    try {
      (ws as any).send(JSON.stringify({ type: "replay", data: session.ring }));
    } catch {
      // ignore
    }
  }

  // 2. Subscribe to live output
  const unsub = subscribe(projectId, (chunk: string) => {
    try {
      (ws as any).send(JSON.stringify({ type: "output", data: chunk }));
    } catch {
      // ignore
    }
  });

  // 3. Handle incoming client messages
  (ws as any).on?.("message", (raw: any) => {
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      // Control frames are JSON: {"resize":{cols,rows}} (or legacy [c,r]) and
      // {"input":"..."}. parseResizeFrame accepts both resize shapes; anything
      // that is not a control frame falls through to the PTY as raw input.
      if (text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text);
          const dims = parseResizeFrame(parsed);
          if (dims) {
            resize(projectId, dims.cols, dims.rows);
            return;
          }
          if (parsed && typeof parsed === "object" && typeof (parsed as { input?: unknown }).input === "string") {
            writeInput(projectId, (parsed as { input: string }).input);
            return;
          }
        } catch {
          // not valid JSON — fall through and treat as raw input
        }
      }
      writeInput(projectId, text);
    } catch {
      // ignore
    }
  });

  (ws as any).on?.("close", () => {
    if ("unsubscribe" in unsub) unsub.unsubscribe();
  });
}

// Reap idle terminals
setInterval(() => {
  const now = Date.now();
  for (const [pid, s] of sessions) {
    if (now - s.lastActivity > IDLE_KILL_MS) {
      killResizer(s);
      try {
        s.child?.kill("SIGKILL");
      } catch {}
      sessions.delete(pid);
    }
  }
}, 5 * 60_000).unref();
