// Editor area state: open tabs, cached file contents, and the context-pin
// mirror (server is source of truth; store refreshes after each mutation).
import { create } from "zustand";
import type { PinDto } from "../lib/types";
import { ApiError, api } from "../lib/api";
import { useUi } from "./ui";

interface EditorState {
  openTabs: string[];
  activeTab: string | null;
  contents: Record<string, string>;
  loadErrors: Record<string, string>;
  dirty: Record<string, boolean>;
  /** B2#5: buffer holds unsaved edits; disk copy may differ (re-click hint). */
  stale: Record<string, boolean>;
  mtimes: Record<string, number>;
  lastSaved: Record<string, string>;

  pins: PinDto[];
  pinsLoading: boolean;

  /**
   * Live-coding buffers (Cursor/Antigravity feel): decoded write_file content
   * as the model produces it, keyed by path. Rendered in place of the disk
   * copy while a write is streaming, then cleared when the real proposal/diff
   * lands. Never saved to disk — this is a PREVIEW of an unapproved change,
   * and PS 8b requires the write itself to go through the approval gate.
   */
  streaming: Record<string, string>;
  /** Paths whose stream is still open (drives the typing cursor/pulse). */
  streamingActive: Record<string, boolean>;
  /** Append a decoded chunk, opening the tab on first sight of the file. */
  appendStream(path: string, delta: string, done: boolean): void;
  /** Drop a live buffer once the authoritative content has been applied. */
  clearStream(path: string): void;

  openFile(path: string): Promise<void>;
  setDirty(path: string, v: boolean): void;
  saveFile(path: string): Promise<void>;
  closeTab(path: string): void;
  setActiveTab(path: string): void;
  /** Folder isolation: drop every buffer/tab/pin from the PREVIOUS project
   *  (openProject calls this on a root change so old-folder files never show
   *  in the new folder's editor). Unsaved dirty buffers are discarded —
   *  switching folders is a deliberate context change. */
  resetProject(): void;
  /** Wave 26: reconcile open tabs with a task revert — close tabs whose file was
   *  removed, drop stale caches, and refetch restored files still open so the
   *  editor never shows (or re-saves) the rejected content. */
  revertSync(restored: string[], removed: string[]): void;

  refreshPins(): Promise<void>;
  addPin(pin: PinDto): Promise<boolean>;
  pinWholeFile(path: string): Promise<void>;
  removePin(idx: number): Promise<void>;
}

export const useEditor = create<EditorState>()((set, get) => ({
  openTabs: [],
  activeTab: null,
  contents: {},
  dirty: {},
  stale: {},
  mtimes: {},
  lastSaved: {},
  loadErrors: {},

  pins: [],
  pinsLoading: false,
  streaming: {},
  streamingActive: {},

  appendStream: (path: string, delta: string, done: boolean) => {
    set((s) => {
      const next = (s.streaming[path] ?? "") + delta;
      return {
        streaming: { ...s.streaming, [path]: next },
        streamingActive: { ...s.streamingActive, [path]: !done },
        // Surface the file being written without stealing focus from a tab
        // the user opened themselves mid-task: only auto-activate when this
        // is the first time we are showing it.
        openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
        activeTab: s.openTabs.includes(path) ? s.activeTab : path,
      };
    });
  },

  clearStream: (path: string) => {
    set((s) => {
      if (s.streaming[path] === undefined) return s;
      const streaming = { ...s.streaming };
      const streamingActive = { ...s.streamingActive };
      delete streaming[path];
      delete streamingActive[path];
      return { streaming, streamingActive };
    });
  },

  setDirty: (path: string, v: boolean) => set((s) => ({ dirty: { ...s.dirty, [path]: v } })),

  resetProject: () => set({
    openTabs: [], activeTab: null, contents: {}, dirty: {}, stale: {},
    mtimes: {}, lastSaved: {}, loadErrors: {}, pins: [], pinsLoading: false,
    // Folder isolation (PS 5b): a live preview from the previous project must
    // never survive into the new one.
    streaming: {}, streamingActive: {},
  }),
  saveFile: async (path: string) => {
    if (get().loadErrors[path]) throw new Error("cannot save — file failed to load");
    const content = get().contents[path] ?? "";
    const expected = get().mtimes[path] || undefined;
    try {
      const res = await api.writeFile(path, content, expected);
      set((s) => ({
        dirty: { ...s.dirty, [path]: false },
        stale: { ...s.stale, [path]: false },
        mtimes: { ...s.mtimes, [path]: (res as any).mtime ?? 0 },
        lastSaved: { ...s.lastSaved, [path]: content },
      }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // B37: the file changed on disk while we were editing (possibly the
        // agent). Engine contract: 409 + { current_mtime, current? }. Offer
        // overwrite (retry with the fresh mtime) or back off + refresh.
        const body = (() => { try { return JSON.parse(err.message); } catch { return {}; } })();
        const currentMtime = typeof body.current_mtime === "number" ? body.current_mtime : undefined;
        const okOverwrite = window.confirm(
          `File changed on disk while you were editing (possibly by the agent).\n\n` +
          (typeof body.current === "string" && body.current
            ? `Current on-disk content:\n${body.current.slice(0, 400)}\n\n`
            : "") +
          `Overwrite with your version?`);
        if (!okOverwrite) {
          // keep the buffer, adopt the new mtime baseline so a later save
          // attempt starts from the current disk state; hint via stale flag.
          set((s) => ({
            stale: { ...s.stale, [path]: true },
            mtimes: currentMtime !== undefined ? { ...s.mtimes, [path]: currentMtime } : s.mtimes,
          }));
          throw err;
        }
        const res = await api.writeFile(path, content, currentMtime);
        set((s) => ({ dirty: { ...s.dirty, [path]: false }, stale: { ...s.stale, [path]: false },
                      mtimes: { ...s.mtimes, [path]: (res as any).mtime ?? currentMtime ?? 0 },
                      lastSaved: { ...s.lastSaved, [path]: content } }));
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        const okGhost = window.confirm("This file was renamed or deleted on disk.\nSave anyway (creates a new file)?");
        if (!okGhost) throw err;
        const res = await api.writeFile(path, content, undefined as unknown as number);
        set((s) => ({ dirty: { ...s.dirty, [path]: false }, mtimes: { ...s.mtimes, [path]: (res as any).mtime ?? 0 },
                      lastSaved: { ...s.lastSaved, [path]: content } }));
        return;
      }
      throw err;
    }
  },
  openFile: async (path) => {
    // B2#5: re-clicking a tab with unsaved edits must NOT refetch/reset the
    // buffer — just focus it and flag it stale so the UI can hint at it.
    if (get().dirty[path]) {
      set((s) => ({
        openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
        activeTab: path,
        stale: { ...s.stale, [path]: true },
      }));
      return;
    }
    // tab first so the UI reacts instantly, content streams in after
    set((s) => ({
      openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
      activeTab: path,
      loadErrors: { ...s.loadErrors, [path]: "" },
      dirty: { ...s.dirty, [path]: false },
      stale: { ...s.stale, [path]: false },
    }));
    try {
      const f = await api.readFile(path);
      set((s) => ({
        contents: { ...s.contents, [path]: f.content },
        // B37: seed the expected_mtime baseline so saveFile can detect
        // concurrent writes (the engine 409s when the file moved on).
        mtimes: { ...s.mtimes, [path]: typeof f.mtime === "number" ? f.mtime : 0 },
      }));
    } catch (e) {
      // B2#8/B2#9: distinct, human messages for binary / oversized files.
      const msg =
        e instanceof ApiError && e.status === 415
          ? "binary file — cannot edit"
          : e instanceof ApiError && e.status === 413
            ? "file too large (limit 2MB)"
            : String(e);
      set((s) => ({ contents: { ...s.contents, [path]: "" }, loadErrors: { ...s.loadErrors, [path]: msg } }));
    }
  },

  closeTab: (path) =>
    set((s) => {
      const tabs = s.openTabs.filter((t) => t !== path);
      const activeTab = s.activeTab === path ? (tabs[tabs.length - 1] ?? null) : s.activeTab;
      // drop the cached buffer so a later reopen refetches from disk
      const contents = { ...s.contents };
      delete contents[path];
      const dirty = { ...s.dirty, [path]: false };
      const stale = { ...s.stale, [path]: false };
      return { openTabs: tabs, activeTab, contents, dirty, stale };
    }),

  setActiveTab: (path) => set({ activeTab: path }),

  revertSync: (restored, removed) => {
    const removedSet = new Set(removed);
    const restoredSet = new Set(restored);
    set((s) => {
      const openTabs = s.openTabs.filter((t) => !removedSet.has(t));
      const activeTab = s.activeTab && removedSet.has(s.activeTab) ? (openTabs[openTabs.length - 1] ?? null) : s.activeTab;
      const contents = { ...s.contents };
      const mtimes = { ...s.mtimes };
      const lastSaved = { ...s.lastSaved };
      const loadErrors = { ...s.loadErrors };
      const dirty = { ...s.dirty };
      const stale = { ...s.stale };
      for (const p of [...removedSet, ...restoredSet]) {
        delete contents[p];
        delete mtimes[p];
        delete lastSaved[p];
        delete loadErrors[p];
        dirty[p] = false;
        stale[p] = false;
      }
      // Drop context pins that point at files the revert deleted.
      const pins = s.pins.filter((pin) => !removedSet.has(pin.path));
      return { openTabs, activeTab, contents, mtimes, lastSaved, loadErrors, dirty, stale, pins };
    });
    // Refetch restored files that are still open so the editor shows the
    // reverted (pre-task) content, not the rejected buffer.
    for (const p of restored) {
      if (get().openTabs.includes(p)) void get().openFile(p);
    }
  },

  refreshPins: async () => {
    set({ pinsLoading: true });
    try {
      const pins = await api.pins();
      set({ pins });
    } catch (e) {
      useUi.getState().toast(`Load pins failed: ${String(e)}`, "err");
    } finally {
      set({ pinsLoading: false });
    }
  },

  addPin: async (pin) => {
    try {
      const pins = await api.addPin(pin);
      set({ pins });
      return true;
    } catch (e) {
      useUi.getState().toast(`Add pin failed: ${String(e)}`, "err");
      return false;
    }
  },

  pinWholeFile: async (path) => {
    if (await get().addPin({ path })) useUi.getState().toast(`Pinned ${path}`, "ok");
  },

  removePin: async (idx) => {
    try {
      const pins = await api.removePin(idx);
      set({ pins });
    } catch (e) {
      useUi.getState().toast(`Remove pin failed: ${String(e)}`, "err");
    }
  },
}));
