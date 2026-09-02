// Live event stream for the active task: initial REST backfill, then SSE with
// exponential-backoff reconnect. On every reconnect the gap is healed by
// re-running the backfill since the last seen event id (server replays from
// `since` — honored server-side now, single monotonic id space), and duplicate
// ids are dropped by the store.
//
// B20: frames are filtered against the active task's id AND sessionId —
// concurrent sessions must not contaminate each other.
// B34: task-status patching happens HERE (event handler), never during render.
import { useEffect } from "react";
import { api } from "../lib/api";
import type { EventDto } from "../lib/types";
import { useChat } from "../stores/chat";
import { useUi } from "../stores/ui";
import { useEditor } from "../stores/editor";

/** Engine status vocabulary (TaskRecord.status). */
const TASK_STATUSES = new Set([
  "planning", "running", "waiting-approval", "reviewing", "done", "failed", "stopped",
]);

export function useTaskStream(taskId: string | null): void {
  useEffect(() => {
    if (!taskId) return;
    const chat = useChat.getState();
    chat.resetTask(taskId);

    let es: EventSource | null = null;
    let disposed = false;
    let timer: number | undefined;
    let attempt = 0;
    // B4: only fall back to a LOCALLY TRACKED max+1 for frames without a
    // numeric id — never Date.now(), which can break monotonicity.
    let maxSeenId = 0;

    const lastId = (): number => {
      const evs = useChat.getState().events[taskId] ?? [];
      return evs.length > 0 ? evs[evs.length - 1].id : 0;
    };

    /** Both identities of the active task (B19: task UUID + sessionId). */
    const ids = (): { tid: string; sid: string } => {
      const ui = useUi.getState();
      const t = ui.tasks.find((x) => x.id === taskId || (x.sessionId != null && x.sessionId === taskId));
      // RC1: a rollover'd id may not be in ui.tasks yet (list refresh lags
      // the SSE frames already carrying the NEW task UUID). activeSessionId
      // still names the conversation — any frame with that sessionId's task
      // identity passes, so the fresh frames aren't dropped during the gap.
      const sid = t?.sessionId ?? ui.activeSessionId ?? taskId;
      return { tid: t?.id ?? taskId, sid };
    };

    /** B20: true when the frame belongs to the active task/session. RC1: a
     *  frame whose taskId matches the session's CURRENT task but not our
     *  (possibly stale) tid still belongs to this conversation — key on the
     *  session when the task row isn't known yet. */
    const forThisTask = (ev: Record<string, any>): boolean => {
      const { tid, sid } = ids();
      if (ev.taskId && ev.taskId !== tid && ev.taskId !== sid) {
        // unknown task id: accept ONLY if the frame's sessionId is ours —
        // it's the session's rolled-over current task.
        if (!ev.sessionId || ev.sessionId !== sid) return false;
      }
      if (ev.sessionId && ev.sessionId !== sid && ev.sessionId !== tid) return false;
      return true;
    };

    /** B34: patch task status from the event handler, keyed by BOTH ids. */
    const patchStatus = (id: unknown, status: unknown) => {
      if (typeof id !== "string" || typeof status !== "string" || !TASK_STATUSES.has(status)) return;
      const ui = useUi.getState();
      ui.patchTaskStatus(id, status);
      const { tid, sid } = ids();
      if (id === tid && sid !== tid) ui.patchTaskStatus(sid, status);
      if (id === sid && tid !== sid) ui.patchTaskStatus(tid, status);
    };

    /**
     * Live coding: decoded write_file/edit_file content arriving token by token
     * (engine emits `file_stream`; see engine/src/livecode.ts). Handled here in
     * the event handler rather than in the chat reducer because it mutates the
     * EDITOR, and the chat store is a pure function of the event buffer.
     *
     * Backfill replays these frames too, so a mid-write reload rebuilds the
     * preview instead of showing a blank editor.
     */
    const handleFileStream = (ev: Record<string, any>) => {
      if (ev.type !== "file_stream") return;
      const p = ev.payload && typeof ev.payload === "object" ? ev.payload : ev;
      const path = typeof p.path === "string" ? p.path : "";
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!path) return;
      useEditor.getState().appendStream(path, delta, p.done === true);
    };

    /**
     * Retire a live preview once the authoritative change exists.
     *
     * A proposal frame means the write has been captured as a reviewable diff,
     * so the editor should go back to showing real file state (and the user
     * should be able to type again). Leaving the preview up would strand the
     * tab in a read-only buffer that no longer corresponds to anything.
     */
    const handleProposalClearsStream = (ev: Record<string, any>) => {
      if (ev.type !== "proposal") return;
      const p = ev.payload && typeof ev.payload === "object" ? ev.payload : ev;
      const files = p.proposal?.files;
      if (!Array.isArray(files)) return;
      const ed = useEditor.getState();
      for (const f of files) {
        if (f && typeof f.path === "string") ed.clearStream(f.path);
      }
    };

    const handleStatusFrame = (ev: Record<string, any>) => {
      const p = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
      if (ev.type === "status") {
        patchStatus(ev.taskId, p.status);
        patchStatus(ev.sessionId, p.status);
      } else if (ev.type === "task") {
        const t = p.task && typeof p.task === "object" ? p.task : {};
        patchStatus(t.id, t.status);
        patchStatus(t.sessionId ?? ev.sessionId, t.status);
      } else if (ev.type === "trace") {
        const tr = p.event && typeof p.event === "object" ? p.event : {};
        if (tr.kind === "task.end" && typeof tr.label === "string") {
          const m = /^task ([a-z-]+):/.exec(tr.label);
          if (m) {
            patchStatus(ev.taskId, m[1]);
            patchStatus(ev.sessionId, m[1]);
          }
        }
      }
    };

    async function heal(): Promise<void> {
      try {
        const evs: EventDto[] = await api.events(taskId as string, lastId());
        if (evs.length > 0) {
          useChat.getState().backfill(taskId as string, evs);
          for (const e of evs) {
            maxSeenId = Math.max(maxSeenId, e.id);
            handleFileStream(e as unknown as Record<string, any>);
          }
        }
      } catch {
        /* backend down — SSE retries keep us honest */
      }
    }

    function connect(): void {
      if (disposed) return;
      useChat.getState().setConn(taskId as string, "connecting");
      es = new EventSource(api.sseUrl(taskId as string));
      es.onopen = () => {
        attempt = 0;
        useChat.getState().setConn(taskId as string, "live");
        void heal(); // fill anything missed while disconnected
      };
      es.onmessage = (m: MessageEvent<string>) => {
        try {
          const ev = JSON.parse(m.data) as any;
          if (!ev || typeof ev !== "object") return;
          if (!forThisTask(ev)) return; // B20: another session's frame
          handleStatusFrame(ev); // B34: status patch outside render phase
          handleFileStream(ev);  // live-coding preview into the editor
          handleProposalClearsStream(ev);
          let numId: number;
          if (typeof ev.id === "number" && Number.isFinite(ev.id)) numId = ev.id;
          else {
            const n = Number(ev.id);
            numId = Number.isFinite(n) && n > 0 ? n : Math.max(maxSeenId, lastId()) + 1;
          }
          maxSeenId = Math.max(maxSeenId, numId);
          useChat.getState().append(taskId as string, { ...ev, id: numId });
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        useChat.getState().setConn(taskId as string, "offline");
        const delay = Math.min(15000, 1200 * 2 ** Math.min(attempt, 4));
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
    }

    void heal(); // initial backfill (restores full conversation + traces)
    connect();

    return () => {
      disposed = true;
      es?.close();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [taskId]);
}
