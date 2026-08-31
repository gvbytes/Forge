// Global UI shell state: project picker, task list/selection, view mode,
// modals, layout toggles, toasts.
import { create } from "zustand";
import type { TaskDto } from "../lib/types";
import { api } from "../lib/api";
// Folder isolation on project switch (uses are function-scope only — the
// module cycle ui↔chat/editor is safe because neither touches the other at
// import time, matching the existing chat.ts→ui.ts direction).
import { useChat } from "./chat";
import { useEditor } from "./editor";

export type ViewMode = "ide" | "dashboard";
export type LeftTab = "files" | "context";
export type ToastKind = "ok" | "err" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface UiState {
  projectRoot: string;
  projectId: string | null;
  openingProject: boolean;
  projectPickerOpen: boolean;
  /** recently opened project roots (picker quick-jumps; most recent first). */
  recentProjects: string[];

  tasks: TaskDto[];
  activeTaskId: string | null;
  /** B19: session id of the active task (task UUID and session id are kept
   *  together; lookups match `t.id === id || t.sessionId === id`). */
  activeSessionId: string | null;
  /** RC2: "folder" = list only the current project's tasks (default);
   *  "all" = every project, grouped by folder in the select. Persisted. */
  taskScope: TaskScope;

  viewMode: ViewMode;
  settingsOpen: boolean;
  memoryOpen: boolean;
  orchestrationOpen: boolean;
  diffOverlayOpen: boolean;
  pendingHunks: number;

  leftTab: LeftTab;
  terminalOpen: boolean;
  sidebarWidth: number;
  chatWidth: number;

  composerSeed: string | null;
  toasts: ToastItem[];

  setProjectRoot(root: string): void;
  openProject(root?: string): Promise<void>;
  setProjectPickerOpen(open: boolean): void;
  refreshTasks(): Promise<void>;
  patchTaskStatus(tid: string, status: string): void;
  selectTask(id: string | null): void;
  setTaskScope(scope: TaskScope): void;
  newTask(goal: string, engine?: string): Promise<TaskDto | null>;

  setViewMode(m: ViewMode): void;
  toggleDashboard(): void;
  setSettingsOpen(open: boolean): void;
  setMemoryOpen(open: boolean): void;
  setOrchestrationOpen(open: boolean): void;
  setDiffOverlayOpen(open: boolean): void;
  setPendingHunks(n: number): void;

  setLeftTab(t: LeftTab): void;
  toggleTerminal(): void;
  setSidebarWidth(px: number): void;
  setChatWidth(px: number): void;

  seedComposer(text: string): void;
  toast(text: string, kind?: ToastKind): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

const ACTIVE_TASK_KEY = "agent-zero.activeTaskId";
const PROJECT_ROOT_KEY = "agent-ide.projectRoot";
const RECENT_PROJECTS_KEY = "agent-ide.recentProjects";
const RECENT_PROJECTS_CAP = 5;

function readRecentProjects(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function persistRecentProjects(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list));
  } catch {}
}

function readPersistedProjectRoot(): string {
  try {
    return window.localStorage.getItem(PROJECT_ROOT_KEY) || "";
  } catch {
    return "";
  }
}

function persistProjectRoot(root: string): void {
  try {
    if (!root) window.localStorage.removeItem(PROJECT_ROOT_KEY);
    else window.localStorage.setItem(PROJECT_ROOT_KEY, root);
  } catch {}
}

function readPersistedTask(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_TASK_KEY);
  } catch {
    return null;
  }
}
function persistTask(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_TASK_KEY);
    else window.localStorage.setItem(ACTIVE_TASK_KEY, id);
  } catch {
    /* private mode etc. — selection just won't survive reloads */
  }
}

const TASK_SCOPE_KEY = "agent-ide.taskScope";
type TaskScope = "folder" | "all";
function readPersistedScope(): TaskScope {
  try {
    const v = window.localStorage.getItem(TASK_SCOPE_KEY);
    return v === "all" ? "all" : "folder";
  } catch {
    return "folder";
  }
}

/** RC1: a task id missing from the fresh list may still name a real
 *  conversation — the server rolls a terminal task over to a NEW UUID in the
 *  SAME session. Ask the engine which session owns the id and what its
 *  CURRENT task is; null = the id (and its session) is truly gone. */
async function resolveDeadTaskId(id: string): Promise<{ taskId: string; sessionId: string } | null> {
  try {
    const info = await api.taskInfo(id);
    const sessionId = info?.session?.id;
    const taskId = info?.task?.id;
    if (typeof sessionId === "string" && typeof taskId === "string") {
      return { taskId, sessionId };
    }
  } catch {
    /* 404 → genuinely gone */
  }
  return null;
}

/** Folder isolation: true when the task/session belongs to the given project.
 *  The taskInfo response carries the session; a foreign-project session means
 *  the rollover belongs to ANOTHER folder and must not be followed here. */
async function taskInProject(taskId: string, sessionId: string, projectId: string): Promise<boolean> {
  try {
    // Cheap path: the scoped list we JUST fetched contains the session's task.
    const tasks = useUi.getState().tasks;
    if (tasks.some((t) => t.id === taskId || t.sessionId === sessionId)) return true;
    // Authoritative path: ask the engine for the task's project.
    const info = await api.taskInfo(taskId);
    const pid = (info as any)?.projectId ?? (info as any)?.projectRoot;
    if (typeof pid === "string") return pid === projectId;
  } catch {
    /* cannot prove ownership → treat as foreign (safe clear) */
  }
  return false;
}

const initialProjectRoot = readPersistedProjectRoot();

export const useUi = create<UiState>()((set, get) => ({
  projectRoot: initialProjectRoot,
  projectId: null,
  openingProject: false,
  projectPickerOpen: !initialProjectRoot,
  recentProjects: readRecentProjects(),

  tasks: [],
  activeTaskId: readPersistedTask(),
  activeSessionId: null,
  taskScope: readPersistedScope(),

  viewMode: "ide",
  settingsOpen: false,
  memoryOpen: false,
  orchestrationOpen: false,
  diffOverlayOpen: false,
  pendingHunks: 0,

  leftTab: "files",
  terminalOpen: true,
  sidebarWidth: 260,
  chatWidth: 420,

  composerSeed: null,
  toasts: [],

  setProjectRoot: (root) => set({ projectRoot: root }),
  setProjectPickerOpen: (open) => set({ projectPickerOpen: open }),

  openProject: async (rootArg?: string) => {
    const root = (rootArg ?? get().projectRoot).trim();
    if (!root) {
      set({ projectPickerOpen: true });
      return;
    }
    set({ openingProject: true });
    try {
      const res = await api.openProject(root);
      persistProjectRoot(res.root);
      const recent = [res.root, ...get().recentProjects.filter((r) => r !== res.root)].slice(0, RECENT_PROJECTS_CAP);
      persistRecentProjects(recent);
      // Folder isolation: switching to a DIFFERENT project must drop every
      // trace of the old folder's view — task selection, chat buffers, editor
      // tabs. Without this the old chat/files rendered inside the new folder
      // (user bug: "old chat and old codes in new folder").
      // Project identity comes from projectId, NOT the root string: TopBar's
      // input setProjectRoot()s on every keystroke, so projectRoot already
      // equals the typed path before openProject() runs — a root compare would
      // call every typed-path open a "same project" and skip the wipe.
      const prevProjectId = get().projectId;
      const switched = !!res.project_id && res.project_id !== prevProjectId;
      set({ projectId: res.project_id, projectRoot: res.root, projectPickerOpen: false, recentProjects: recent });
      // The wipe must not destroy a selection that BELONGS to the incoming
      // folder: (a) the boot follow (App init restores a persisted task, then
      // opens its folder — prevProjectId is null), (b) a cross-folder task
      // pick (selectTask sets the id, then opens the task's folder).
      const activeTask = get().tasks.find(
        (t) => t.id === get().activeTaskId || t.sessionId === get().activeTaskId,
      );
      const selectionBelongsToIncoming =
        !!get().activeTaskId &&
        (prevProjectId === null ||
          (activeTask?.projectRoot ?? "").replace(/\/+$/, "") === res.root.replace(/\/+$/, ""));
      if (switched) {
        if (!selectionBelongsToIncoming) {
          persistTask(null);
          set({ activeTaskId: null, activeSessionId: null, diffOverlayOpen: false, pendingHunks: 0 });
          useChat.getState().resetAll();
        }
        // Editor tabs/contents are ALWAYS from the previous folder after a
        // switch (even when the selection follows, the old folder's files
        // must not render in the new one) — and the stale task list must
        // not flash in the select while the scoped fetch is in flight.
        useEditor.getState().resetProject();
        set({ tasks: [] });
      }
      get().toast(
        switched && !selectionBelongsToIncoming
          ? `Switched to ${res.root} — chat & editor cleared`
          : `Project opened: ${res.root}`,
        "ok",
      );
      await get().refreshTasks();
    } catch (e) {
      get().toast(`Open project failed: ${String(e)}`, "err");
    } finally {
      set({ openingProject: false });
    }
  },

  // B19/B34: match BOTH task UUID and sessionId; return the SAME state (no
  // re-render) when nothing matches or nothing changed.
  patchTaskStatus: (tid, status) => {
    if (!tid || !status) return;
    set((s) => {
      let changed = false;
      const tasks = s.tasks.map((t) => {
        if ((t.id === tid || (t.sessionId != null && t.sessionId === tid)) && t.status !== status) {
          changed = true;
          return { ...t, status };
        }
        return t;
      });
      return changed ? { tasks } : s;
    });
  },

  refreshTasks: async () => {
    try {
      // Folder scoping (RC2): default to the CURRENT project's tasks only;
      // "all" mode fetches every project (the select groups them by folder).
      const { taskScope, projectId } = get();
      const tasks = taskScope === "folder" && projectId
        ? await api.listTasks(projectId)
        : await api.listTasks();
      // Race guard: a project switch (or scope flip) while this fetch was in
      // flight makes the payload stale — the openProject-side refresh (or the
      // scope-change refresh) re-runs with the right scope. Applying it here
      // would flash the OLD folder's tasks in the NEW folder's select.
      const nowScope = get().taskScope;
      const nowPid = get().projectId;
      const stale = nowScope !== taskScope || nowPid !== projectId;
      if (stale) return;
      set({ tasks });
      const persisted = readPersistedTask();
      if (persisted && !get().activeTaskId && readPersistedTask() === persisted) {
        // Re-read the key: a folder switch may have cleared it while this
        // fetch was in flight — adopting the stale id would resurrect the
        // old folder's task in the new folder.
        const found = tasks.find((t) => t.id === persisted || t.sessionId === persisted);
        if (found) set({ activeTaskId: persisted });
      }
      // keep activeSessionId in sync with the current selection (B19)
      let active = get().activeTaskId;
      if (active) {
        const t = tasks.find((x) => x.id === active || (x.sessionId != null && x.sessionId === active));
        if (t) {
          // Normalize a sessionId-valued selection to the task UUID (B19 keeps
          // both, but the select/lookups key on the task row id).
          if (t.id !== active) { persistTask(t.id); set({ activeTaskId: t.id }); active = t.id; }
          set({ activeSessionId: t.sessionId ?? t.id });
        } else {
          // RC1: the active id no longer exists in the list — a followup to a
          // terminal task ARCHIVED it server-side and minted a new UUID in the
          // same session (rollover). Resolve the owning session and follow its
          // CURRENT task so a refresh sticks to the SAME conversation instead
          // of dropping to "no task selected" with a zombie timeline.
          // Folder isolation: in folder scope, only follow the rollover when
          // the resolved session belongs to the CURRENT project — otherwise
          // the old folder's task would re-appear inside the new folder.
          const resolved = await resolveDeadTaskId(active);
          const resolvedForeign = resolved && taskScope === "folder" && projectId
            && !(await taskInProject(resolved.taskId, resolved.sessionId, projectId));
          if (resolved && !resolvedForeign) {
            persistTask(resolved.taskId);
            set({ activeTaskId: resolved.taskId, activeSessionId: resolved.sessionId });
            active = resolved.taskId;
          } else {
            // Truly gone (or belongs to another folder): honest clear, not a
            // zombie view.
            persistTask(null);
            set({ activeTaskId: null, activeSessionId: null });
          }
        }
      }
      void active;
    } catch {
      /* backend not up yet; selectors keep last snapshot */
    }
  },

  selectTask: (id) => {
    persistTask(id);
    set({ activeTaskId: id, diffOverlayOpen: false });
    if (id) {
      const task = get().tasks.find((t) => t.id === id || t.sessionId === id);
      set({ activeSessionId: task?.sessionId ?? id });
      if (task?.projectRoot && task.projectRoot.replace(/\/+$/, "") !== get().projectRoot.replace(/\/+$/, "")) {
        void get().openProject(task.projectRoot);
      }
    } else {
      set({ activeSessionId: null });
    }
  },

  setTaskScope: (scope) => {
    try {
      window.localStorage.setItem(TASK_SCOPE_KEY, scope);
    } catch {}
    set({ taskScope: scope });
    void get().refreshTasks();
  },

  // B19: keep BOTH the real task UUID (id/taskId) and the sessionId returned
  // by POST /api/tasks; every lookup elsewhere matches either identity.
  newTask: async (goal, engine = "engine") => {
    try {
      // Use the OPENED project identity (set only by openProject), not the
      // topbar input text — a typed-but-not-opened path must not hijack task
      // creation into an unregistered folder.
      const t = await api.createTask(goal, undefined, engine, undefined, get().projectId ?? undefined);
      const tid = t.id || (t as any).taskId || (t as any).sessionId;
      const sid = t.sessionId || (t as any).sessionId || tid;
      // Set the selection BEFORE refreshTasks: the refresh's dead-id honest
      // clear path calls persistTask(null), which would otherwise delete the
      // fresh task's key (reload would lose the selection).
      persistTask(tid);
      set({ activeTaskId: tid, activeSessionId: sid });
      await get().refreshTasks();
      return t;
    } catch (e) {
      get().toast(`Create task failed: ${String(e)}`, "err");
      return null;
    }
  },

  setViewMode: (m) => set({ viewMode: m }),
  toggleDashboard: () => set((s) => ({ viewMode: s.viewMode === "ide" ? "dashboard" : "ide" })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setMemoryOpen: (open) => set({ memoryOpen: open }),
  setOrchestrationOpen: (open) => set({ orchestrationOpen: open }),
  setDiffOverlayOpen: (open) => set({ diffOverlayOpen: open }),
  setPendingHunks: (n) => set({ pendingHunks: n }),

  setLeftTab: (t) => set({ leftTab: t }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(500, Math.max(160, px)) }),
  setChatWidth: (px) => set({ chatWidth: Math.min(760, Math.max(260, px)) }),

  seedComposer: (text) => set({ composerSeed: text }),
  toast: (text, kind = "info") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
