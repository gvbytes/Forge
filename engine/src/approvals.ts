// Approval gate: side-effect tool calls park here until a human decides.
// Every create/decide emits trace events (kind "approval.request" /
// "approval.decision") AND a {type:"approval"} wire event (critique #8 — the
// SSE dock must not depend on polling), and pending callers block on
// awaitDecision() until a decision, timeout, or abort.
//
// Pending approvals are ALSO persisted to DATA_DIR/projects/<sessionId>/
// approvals.json and reloaded on boot: the dock lives in page state, so a
// reload/restart used to orphan a parked gate entirely — nobody ever saw it
// and the 5-minute auto-deny silently killed the task. Now the gate survives
// both (30-minute window, decidable from a fresh page).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApprovalRequest } from "./types.js";
import { DATA_DIR } from "./config.js";
import { trace } from "./trace.js";
import { wire } from "./bus.js";

const store = new Map<string, ApprovalRequest>();

/** How long a human gets to decide. Was 300s — shorter than a coffee break,
 *  and with no persistence a dock lost to a page reload meant EVERY request
 *  auto-denied unseen. 30min matches "human stepped away" instead of
 *  "human blinked"; callers can still pass a shorter value. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

/** Decided records kept per session file / served for reconciliation. */
const PERSISTED_PER_SESSION = 50;
const RECENT_DECIDED = 10;

interface Waiter {
  resolve: (a: ApprovalRequest) => void;
  timer: NodeJS.Timeout | undefined;
}
const waiters = new Map<string, Waiter>();
/** approvalId → owning span (r4-tasks #5): the decision POST comes from an
 *  HTTP route that has no span context, so the gate records its parent at
 *  creation and decisions trace nested under the same coder span. */
const spanByApproval = new Map<string, string>();

const MAX_STORED = 1000;

function safeId(sessionId: string): string {
  return sessionId.replace(/[^\w-]/g, "_");
}

function fileFor(sessionId: string): string {
  return path.join(DATA_DIR, "projects", safeId(sessionId), "approvals.json");
}

/** Best-effort persistence of one session's approval history (newest last). */
function persist(sessionId: string): void {
  try {
    const all = [...store.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-PERSISTED_PER_SESSION);
    fs.mkdirSync(path.dirname(fileFor(sessionId)), { recursive: true });
    fs.writeFileSync(fileFor(sessionId), JSON.stringify(all, null, 2));
  } catch {
    /* persistence is best-effort; the in-memory gate still works */
  }
}

/** Boot reload: pending gates from a previous process become visible and
 *  decidable again instead of being orphaned; decided history rides along so
 *  GET /api/approvals can reconcile a freshly-reloaded page immediately.
 *
 *  Timer reconciliation (r2b-cross F3): awaitDecision timers are memory-only,
 *  so reloaded pendings used to be armed WITHOUT their deny timer — zombie
 *  gates that outlived every restart. At boot no waiter exists, so:
 *    * pending records older than APPROVAL_TIMEOUT_MS → auto-deny
 *      ("policy-auto-deny", "stale across restart");
 *    * fresh pendings stay decidable via POST /decision with a full new
 *      window — the timer only matters for live waiters, which re-arm (or
 *      re-gate) when a task actually resumes. */
function loadPersisted(): void {
  try {
    const root = path.join(DATA_DIR, "projects");
    if (!fs.existsSync(root)) return;
    for (const dir of fs.readdirSync(root)) {
      try {
        const f = path.join(root, dir, "approvals.json");
        if (!fs.existsSync(f)) continue;
        const arr = JSON.parse(fs.readFileSync(f, "utf8")) as ApprovalRequest[];
        for (const r of arr) {
          if (!r || typeof r.id !== "string" || store.has(r.id)) continue;
          if (r.status === "pending" && Date.now() - (r.createdAt ?? 0) >= APPROVAL_TIMEOUT_MS) {
            // forceDeny traces + persists the denial (persist is per-session,
            // and every record in this file shares one sessionId).
            forceDeny(r, "policy-auto-deny", "stale across restart");
          }
          store.set(r.id, r);
        }
      } catch {
        /* unreadable session dir/file — skip */
      }
    }
  } catch {
    /* projects dir missing/unreadable → start empty */
  }
}
loadPersisted();

/** Boot reconcile (user bug: "asks for permission that was pending before,
 *  right after running the server"): a reloaded pending whose waiting tool
 *  call lived in the PREVIOUS process can never be satisfied — after a
 *  restart no waiter exists and the owning task is stopped (reconcileBoot
 *  sessions marks waiting-approval tasks stopped+bootInterrupted). Leaving
 *  it pending made the UI prompt for a decision no one can use. Every
 *  reloaded pending whose session has NO live task is force-denied at boot;
 *  the caller (index.ts boot) re-runs this for every project after sessions
 *  are registered. */
export function reloadApprovalsForBoot(): void {
  loadPersisted(); // pick up any project dirs registered after module load
  for (const r of [...store.values()]) {
    if (r.status !== "pending") continue;
    // A live waiter would be a task that is RUNNING in THIS process — at boot
    // nothing is running yet, so any pending that survived the process
    // boundary is a zombie. (resumeAfterApproval re-arms gates when a task
    // actually resumes, so denying here cannot strand a resumable task.)
    forceDeny(r, "policy-auto-deny", "zombie across restart");
  }
}

export function createApproval(input: {
  sessionId: string;
  toolName: string;
  summary: string;
  payload: Record<string, unknown>;
}, parentSpan?: string): ApprovalRequest {
  const req: ApprovalRequest = {
    ...input,
    id: randomUUID(),
    createdAt: Date.now(),
    status: "pending",
  };
  store.set(req.id, req);
  prune();
  persist(req.sessionId);
  if (parentSpan) spanByApproval.set(req.id, parentSpan);
  trace.emit({
    sessionId: req.sessionId,
    spanId: randomUUID().slice(0, 8),
    parentId: parentSpan,
    kind: "approval.request",
    label: `approval.request: ${req.toolName}`,
    input: req.payload,
  });
  wire.emit({ type: "approval", approval: req }); // live dock without polling
  return req;
}

export function decideApproval(id: string, approved: boolean, parentSpan?: string): ApprovalRequest | undefined {
  const req = store.get(id);
  if (!req) return undefined;
  const span = parentSpan ?? spanByApproval.get(id);
  if (req.status === "pending") {
    req.status = approved ? "approved" : "denied";
    req.decidedBy = "user";
    trace.emit({
      sessionId: req.sessionId,
      spanId: randomUUID().slice(0, 8),
      parentId: span,
      kind: "approval.decision",
      label: `approval.decision: ${req.toolName}`,
      input: { approvalId: id },
      output: { approved, decidedBy: "user" },
    });
    wire.emit({ type: "approval", approval: req });
    persist(req.sessionId);
    const w = waiters.get(id);
    if (w) {
      waiters.delete(id);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(req);
    }
  }
  return req; // already decided → idempotent
}

export function getApproval(id: string): ApprovalRequest | undefined {
  return store.get(id);
}

export function listPending(sessionId: string): ApprovalRequest[] {
  return [...store.values()].filter((r) => r.sessionId === sessionId && r.status === "pending");
}

export function listAllPending(): ApprovalRequest[] {
  return [...store.values()].filter((r) => r.status === "pending");
}

/**
 * Reconciliation feed for GET /api/approvals?sessionId=: every pending gate
 * PLUS the most recently decided records, so a page (re)load can rebuild the
 * dock state it missed while disconnected. Shape stays a flat list; the
 * per-record `status` field tells pending and decided apart.
 */
export function listRecent(sessionId: string): ApprovalRequest[] {
  const all = [...store.values()].filter((r) => r.sessionId === sessionId);
  const pending = all
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt); // oldest gate first — decide in order received
  const decided = all
    .filter((r) => r.status !== "pending")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_DECIDED);
  return [...pending, ...decided];
}

/** Mark a pending request denied by something other than the user and mirror
 *  the state change on trace + wire. Returns the stored record. */
function forceDeny(req: ApprovalRequest, decidedBy: "policy-auto-deny" | "aborted", reason?: string, parentSpan?: string): ApprovalRequest {
  req.status = "denied";
  req.decidedBy = decidedBy;
  trace.emit({
    sessionId: req.sessionId,
    spanId: randomUUID().slice(0, 8),
    parentId: parentSpan ?? spanByApproval.get(req.id),
    kind: "approval.decision",
    label: `approval.decision: ${req.toolName}`,
    input: { approvalId: req.id },
    output: { approved: false, decidedBy, ...(reason ? { reason } : {}) },
  });
  wire.emit({ type: "approval", approval: req });
  persist(req.sessionId);
  return req;
}

/**
 * Block until the approval is decided. On timeout the request is marked
 * denied ("policy-auto-deny") and resolves with that state; when `signal`
 * aborts first it is marked denied ("aborted") so the caller can unwind the
 * task immediately instead of parking up to the full timeout (critique #8).
 * Callers treat any non-"approved" status as refusal.
 */
export async function awaitDecision(id: string, timeoutMs: number = APPROVAL_TIMEOUT_MS, signal?: AbortSignal, parentSpan?: string): Promise<ApprovalRequest> {
  const req = store.get(id);
  if (!req) throw new Error(`unknown approval: ${id}`);
  if (req.status !== "pending") return req;
  if (signal?.aborted) return forceDeny(req, "aborted", undefined, parentSpan);
  return new Promise<ApprovalRequest>((resolve) => {
    let settled = false;
    const finish = (a: ApprovalRequest): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(a);
    };
    const onAbort = (): void => {
      waiters.delete(id);
      finish(forceDeny(store.get(id) ?? req, "aborted", undefined, parentSpan));
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            waiters.delete(id);
            const cur = store.get(id);
            finish(cur && cur.status === "pending" ? forceDeny(cur, "policy-auto-deny", "timeout", parentSpan) : (cur ?? req));
          }, timeoutMs)
        : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    // decideApproval() resolves through this waiter; `finish` keeps the
    // settle-once guarantee whichever path wins the race.
    waiters.set(id, { resolve: finish, timer });
  });
}

/** Keep memory bounded: drop oldest already-decided entries first. */
function prune(): void {
  if (store.size <= MAX_STORED) return;
  for (const [k, v] of store) {
    if (store.size <= MAX_STORED) break;
    if (v.status !== "pending") store.delete(k);
  }
}
