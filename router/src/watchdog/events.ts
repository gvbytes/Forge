/**
 * Watchdog SSE client — tolerant engine event reader, no new deps.
 *
 * Stream choice: subscribes to the engine's event stream (GET /global/event or fallback /event)
 * and scopes by directory client-side.
 */

export interface ToolCallEvent {
  sessionID: string;
  tool: string;
  /** sha1(tool + canonicalJSON(args)) — stable across key order. */
  argsHash: string;
  /** Present when this tool call produced an error/failed output. */
  errorOutput?: string;
}

export interface ErrorEvent {
  sessionID: string;
  message: string;
}

export interface IdleEvent {
  sessionID: string;
}

export interface PermissionEvent {
  sessionID: string;
  kind: string;
  /** Permission gate / tool family from the ask ("bash", "edit", ...) when present. */
  action?: string;
}

export interface PermissionRepliedEvent {
  sessionID: string;
  /** Engine reply literal: "once" | "always" | "reject". */
  reply: string;
  /** Gate / tool family carried by the reply (or matching ask) when present. */
  action?: string;
}

function permissionAction(ev: Rec): string | undefined {
  const props = asRec(ev["properties"]);
  return str(ev["action"]) ?? str(props?.["action"]) ?? str(ev["permission"]) ?? str(props?.["permission"]);
}

/** Any liveness signal from a session (attribution feed). */
export interface SessionActivityEvent {
  sessionID: string;
  type: string;
  /** Owning directory resolved from the frame; null when the frame carries none. */
  directory: string | null;
}

export interface WatchdogCallbacks {
  onToolCall?: (e: ToolCallEvent) => void;
  onError?: (e: ErrorEvent) => void;
  onIdle?: (e: IdleEvent) => void;
  onPermissionAsked?: (e: PermissionEvent) => void;
  /** Fired for permission.replied frames. */
  onPermissionReplied?: (e: PermissionRepliedEvent) => void;
  /**
   * Fired for message / session activity frames so AttributionService can
   * track lastActiveSession per watched directory.
   */
  onSessionActivity?: (e: SessionActivityEvent) => void;
}

/** Stable-key JSON so identical argument objects hash identically. */
export function canonicalJSON(value: unknown): string {
  const enc = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(enc);
    if (v !== null && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      return Object.keys(rec)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = enc(rec[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(enc(value));
}

/** sha1(tool + canonicalJSON(args)) via Bun.CryptoHasher. */
export function argsHash(tool: string, args: unknown): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(tool + canonicalJSON(args ?? {}));
  return h.digest("hex");
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Unwrap `{"payload":{...}}` / `{"properties":{...}}` wrappers defensively. */
function unwrapEvent(frame: Rec): Rec {
  const payload = asRec(frame["payload"]);
  if (payload) {
    return { ...frame, ...payload };
  }
  const props = asRec(frame["properties"]);
  if (props) return { ...frame, ...props };
  return frame;
}

function extractSessionID(ev: Rec): string | undefined {
  const props = asRec(ev["properties"]);
  return (
    str(ev["taskId"]) ??
    str(ev["task_id"]) ??
    str(ev["sessionID"]) ??
    str(ev["sessionId"]) ??
    str(asRec(ev["info"])?.["taskId"]) ??
    str(asRec(ev["info"])?.["sessionID"]) ??
    str(asRec(ev["part"])?.["taskId"]) ??
    str(asRec(ev["part"])?.["sessionID"]) ??
    str(props?.["taskId"]) ??
    str(props?.["sessionID"]) ??
    str(asRec(props?.["info"])?.["taskId"]) ??
    str(asRec(props?.["info"])?.["sessionID"]) ??
    str(asRec(props?.["part"])?.["taskId"]) ??
    str(asRec(props?.["part"])?.["sessionID"])
  );
}

function frameDirectory(ev: Rec): string | undefined {
  const ws = asRec(ev["workspace"]);
  const props = asRec(ev["properties"]);
  return str(ev["directory"]) ?? str(ws?.["directory"]) ?? str(props?.["directory"]);
}

interface RawToolCall {
  tool: string;
  args: unknown;
  errorOutput?: string;
}

function extractTool(ev: Rec): RawToolCall | null {
  const props = asRec(ev["properties"]);
  const direct = str(ev["tool"]) ?? str(props?.["tool"]);
  if (direct) {
    // B42: only treat the output as an ERROR when the frame marks failure —
    // mirror the message.part branch's status check below. Successful tool output
    // must not populate errorOutput (six identical successes would otherwise fire a
    // bogus error-spam intervention). Failure markers: an explicit status of
    // error/failed, an error field, or a dotted type segment like "...tool.failed".
    const status = str(ev["status"]) ?? str(props?.["status"]);
    const typeSegs = (str(ev["type"]) ?? "").split(".");
    const failed = status === "error" || status === "failed"
      || ev["error"] !== undefined || props?.["error"] !== undefined
      || typeSegs.includes("failed") || typeSegs.includes("error");
    return {
      tool: direct,
      args: ev["args"] ?? props?.["args"] ?? ev["input"] ?? {},
      errorOutput: failed
        ? str(ev["error"]) ?? str(props?.["error"]) ?? str(ev["output"]) ?? str(props?.["output"])
        : undefined,
    };
  }
  const part = asRec(ev["part"]);
  if (part && part["type"] === "tool") {
    const state = asRec(part["state"]);
    const status = str(state?.["status"]) ?? str(part["status"]);
    return {
      tool: String(part["tool"] ?? "unknown"),
      args: state?.["input"] ?? part["input"] ?? {},
      errorOutput:
        status === "error" || status === "failed"
          ? str(state?.["output"]) ??
            str(part["output"]) ??
            (state?.["output"] !== undefined || part["output"] !== undefined
              ? safeStringify(state?.["output"] ?? part["output"])
              : undefined)
          : undefined,
    };
  }
  return null;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export class WatchdogClient {
  private ac: AbortController | null = null;
  /** True only while an SSE stream is actively connected (B22: honest status). */
  private liveFlag = false;
  /** B8: correlate native tool.call → tool.result by spanId so each invocation is
   * observed ONCE (at result time) with the call's args — mirroring the legacy
   * single success/failed event that carried both args and outcome. */
  private readonly pendingToolArgs = new Map<string, { tool: string; args: unknown }>();

  constructor(
    private readonly callbacks: WatchdogCallbacks,
    private readonly opts: { directory?: string } = {},
  ) {}

  async connect(url: string, fallbackUrl?: string): Promise<void> {
    this.ac = new AbortController();
    void this.run(url, fallbackUrl);
  }

  close(): void {
    this.ac?.abort();
    this.ac = null;
    this.liveFlag = false;
  }

  get connected(): boolean {
    return this.ac !== null;
  }

  /** Actively streaming right now (false during reconnect backoff). */
  get live(): boolean {
    return this.liveFlag;
  }

  /** B22: keep reconnecting (with capped exponential backoff) until close(). A
   * single engine restart or transient network blip must not permanently silence
   * the watchdog. */
  private async run(url: string, fallbackUrl?: string): Promise<void> {
    const ac = this.ac;
    if (!ac) return;
    let attempt = 0;
    let useFallback = false;
    while (!ac.signal.aborted) {
      const target = useFallback && fallbackUrl ? fallbackUrl : url;
      let connected = false;
      try {
        connected = await this.streamOnce(target, ac);
      } catch (e) {
        if (ac.signal.aborted) return;
        console.warn("[watchdog] SSE connection error:", e instanceof Error ? e.message : String(e));
      }
      if (ac.signal.aborted) return;
      if (connected) {
        // Streamed until the server closed it (engine restart) — retry primary
        // immediately, no backoff penalty for a healthy-then-closed stream.
        attempt = 0;
        useFallback = false;
        continue;
      }
      // Connection itself failed — try the fallback once before backing off.
      if (fallbackUrl && !useFallback) {
        useFallback = true;
        continue;
      }
      attempt += 1;
      // Both primary and fallback failed — after the backoff, retry the PRIMARY
      // first again. Without this reset useFallback stays true forever and every
      // later attempt targets only the fallback URL, even once the primary has
      // recovered (the fallback is meant as a one-shot per retry cycle).
      useFallback = false;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      console.log(`[watchdog] engine unreachable — reconnect attempt ${attempt} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Open one SSE stream and drain it until it ends. Returns true if the
   * connection was established (regardless of how it later ended). */
  private async streamOnce(url: string, ac: AbortController): Promise<boolean> {
    let buffer = "";
    const decoder = new TextDecoder();
    const res = await fetch(url, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return false;
    this.liveFlag = true;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        buffer = this.drain(buffer);
      }
      buffer += decoder.decode();
      this.drain(buffer);
    } finally {
      this.liveFlag = false;
    }
    return true;
  }

  private drain(buffer: string): string {
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx < 0) return buffer;
      this.consumeFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }

  private consumeFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const rec = asRec(parsed);
    if (rec) this.route(rec);
  }

  /** B8: top-level wire types of the engine's pinned native envelope. Legacy
   * frames use dotted types (e.g. "session.next.tool.success"), so an exact
   * match here cleanly separates the two dialects. */
  private static readonly NATIVE_TYPES = new Set([
    "trace",
    "message",
    "token",
    "task",
    "status",
    "proposal",
    "approval",
    "route",
  ]);

  /** B8: dispatch a parsed frame — native envelope first, legacy fallback. */
  private route(rec: Rec): void {
    const type = str(rec["type"]);
    if (type && WatchdogClient.NATIVE_TYPES.has(type)) {
      this.dispatchNative(rec, type);
      return;
    }
    this.dispatch(unwrapEvent(rec));
  }

  /** B8: parse the engine's native envelope
   * `{ id, taskId, sessionId, ts, type, payload }`. Attribution is keyed by
   * sessionId; intervention-driving callbacks (tool/error/idle/permission) are
   * keyed by taskId because the engine's nudge/stop endpoints are task-scoped
   * (`/api/tasks/:id/message|stop`). */
  private dispatchNative(rec: Rec, type: string): void {
    const payload = asRec(rec["payload"]) ?? {};
    const sessionId = str(rec["sessionId"]) ?? str(rec["taskId"]);
    if (!sessionId) return;

    const dir = str(rec["directory"]) ?? str(payload["directory"]);
    if (dir && this.opts.directory && dir !== this.opts.directory) return;

    // Intervention key: prefer taskId (engine endpoints are task-scoped).
    const intvId = str(rec["taskId"]) ?? sessionId;

    // Every native frame with a session is a liveness signal for attribution.
    this.callbacks.onSessionActivity?.({ sessionID: sessionId, type, directory: dir ?? null });

    if (type === "trace") {
      // Trace events may sit at payload.event (bridge) or be flattened into payload.
      const ev = asRec(payload["event"]) ?? payload;
      const kind = str(ev["kind"]) ?? "";
      const label = str(ev["label"]);

      if (kind === "tool.call") {
        const tool = this.toolFromLabel(label) ?? str(ev["tool"]) ?? "unknown";
        const args = ev["input"] ?? ev["args"] ?? {};
        const spanId = str(ev["spanId"]);
        if (spanId) {
          // Stash args; observe once when the matching tool.result arrives.
          this.pendingToolArgs.set(spanId, { tool, args });
          if (this.pendingToolArgs.size > 500) {
            const oldest = this.pendingToolArgs.keys().next().value;
            if (oldest !== undefined) this.pendingToolArgs.delete(oldest);
          }
        } else {
          // No span to correlate — observe now for repeat detection (degraded path).
          this.callbacks.onToolCall?.({ sessionID: intvId, tool, argsHash: argsHash(tool, args) });
        }
        return;
      }
      if (kind === "tool.result") {
        const tool = this.toolFromLabel(label) ?? str(ev["tool"]) ?? "unknown";
        const spanId = str(ev["spanId"]);
        const pending = spanId ? this.pendingToolArgs.get(spanId) : undefined;
        if (spanId) this.pendingToolArgs.delete(spanId);
        const args = pending?.args ?? ev["input"] ?? ev["args"] ?? {};
        // B42 parity: only a FAILED result (ok:false / error) populates errorOutput.
        const output = asRec(ev["output"]);
        const failed = output ? output["ok"] === false || output["error"] !== undefined : ev["error"] !== undefined;
        const errorOutput = failed
          ? str(output?.["error"]) ?? str(output?.["result"]) ?? safeStringify(output?.["error"] ?? output?.["result"] ?? "tool failed")
          : undefined;
        this.callbacks.onToolCall?.({
          sessionID: intvId,
          tool: pending?.tool ?? tool,
          argsHash: argsHash(pending?.tool ?? tool, args),
          ...(errorOutput !== undefined && errorOutput !== "" ? { errorOutput } : {}),
        });
        return;
      }
      if (kind === "error") {
        const message =
          str(ev["message"]) ?? str(asRec(ev["output"])?.["message"]) ?? str(ev["label"]) ?? safeStringify(ev["output"] ?? "engine error");
        this.callbacks.onError?.({ sessionID: intvId, message });
        return;
      }
      if (kind === "approval.request") {
        this.callbacks.onPermissionAsked?.({
          sessionID: intvId,
          kind,
          action: str(asRec(ev["input"])?.["toolName"]) ?? str(ev["tool"]) ?? this.toolFromLabel(label),
        });
        return;
      }
      if (kind === "approval.decision") {
        const reply = str(asRec(ev["output"])?.["status"]) ?? str(ev["decision"]) ?? str(ev["reply"]) ?? "";
        if (reply) {
          this.callbacks.onPermissionReplied?.({
            sessionID: intvId,
            reply: reply === "approved" ? "once" : reply === "rejected" ? "reject" : reply,
            action: str(asRec(ev["input"])?.["toolName"]) ?? str(ev["tool"]) ?? this.toolFromLabel(label),
          });
        }
        return;
      }
      if (kind === "task.end" || kind === "agent.end") {
        this.callbacks.onIdle?.({ sessionID: intvId });
        return;
      }
      return;
    }

    if (type === "approval") {
      const approval = asRec(payload["approval"]) ?? payload;
      const status = str(approval["status"]) ?? str(approval["state"]);
      const action = str(approval["toolName"]) ?? str(approval["tool"]);
      if (status === "pending" || status === "requested" || status === "open") {
        this.callbacks.onPermissionAsked?.({ sessionID: intvId, kind: type, action });
      } else if (status === "approved" || status === "rejected" || status === "decided") {
        this.callbacks.onPermissionReplied?.({
          sessionID: intvId,
          reply: status === "rejected" ? "reject" : "once",
          action,
        });
      }
      return;
    }

    if (type === "status" || type === "task") {
      const st = str(payload["status"]) ?? str(payload["state"]) ?? str(asRec(payload["task"])?.["status"]);
      if (st === "idle" || st === "done" || st === "failed" || st === "stopped" || st === "complete") {
        this.callbacks.onIdle?.({ sessionID: intvId });
      }
      return;
    }
    // message / token / proposal / route: attribution already fired above.
  }

  /** Engine labels tool spans as `tool: <name>`. */
  private toolFromLabel(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const m = /^tool:\s*(.+)$/.exec(label);
    return m ? m[1]!.trim() : undefined;
  }

  private dispatch(ev: Rec): void {
    const type = str(ev["type"]);
    if (!type) return;

    const dir = frameDirectory(ev);
    if (dir && this.opts.directory && dir !== this.opts.directory) return;

    const sessionID = extractSessionID(ev);

    if (
      sessionID &&
      (type.startsWith("message.part.") || type.startsWith("session.updated") || type.startsWith("session.idle") || type.startsWith("task."))
    ) {
      this.callbacks.onSessionActivity?.({ sessionID, type, directory: dir ?? null });
    }

    if (type.includes("permission") && type.includes("ask")) {
      if (sessionID) this.callbacks.onPermissionAsked?.({ sessionID, kind: type, action: permissionAction(ev) });
      return;
    }
    if (type.includes("permission") && type.includes("repl")) {
      const props = asRec(ev["properties"]);
      const reply = str(ev["reply"]) ?? str(props?.["reply"]) ?? str(ev["response"]) ?? str(props?.["response"]);
      if (sessionID && reply) {
        this.callbacks.onPermissionReplied?.({ sessionID, reply, action: permissionAction(ev) });
      }
      return;
    }
    if (type.endsWith(".error") || type === "session.error" || type === "message.error" || type === "task.error") {
      const errRec = asRec(ev["error"] ?? asRec(ev["properties"])?.["error"]);
      const message =
        str(ev["message"]) ??
        str(errRec?.["message"]) ??
        (ev["error"] !== undefined ? safeStringify(ev["error"]) : "unknown engine error");
      if (sessionID) this.callbacks.onError?.({ sessionID, message });
      return;
    }
    if (type.includes("tool")) {
      const raw = extractTool(ev);
      if (raw && sessionID) {
        this.callbacks.onToolCall?.({
          sessionID,
          tool: raw.tool,
          argsHash: argsHash(raw.tool, raw.args),
          ...(raw.errorOutput !== undefined && raw.errorOutput !== "" ? { errorOutput: raw.errorOutput } : {}),
        });
      }
      return;
    }
    if (type.includes("idle")) {
      if (sessionID) this.callbacks.onIdle?.({ sessionID });
      return;
    }
  }
}
