// Project file tree: recursive, collapsible, click-to-open, per-row file
// management (new / rename / delete) via the action buttons.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useEditor } from "../stores/editor";
import { useUi } from "../stores/ui";
import ProjectPickerModal from "./ProjectPickerModal";

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  children: FileNode[];
}

interface FileActions {
  create(parentDir: string): void;
  createFolder(parentDir: string): void;
  rename(path: string): void;
  del(path: string, dir: boolean): void;
}

function rec(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

function toNode(v: unknown, prefix: string): FileNode | null {
  const r = rec(v);
  const rawPath = typeof r.path === "string" ? r.path : undefined;
  const name = typeof r.name === "string" ? r.name : rawPath ? rawPath.split("/").pop() ?? rawPath : undefined;
  if (!name) return null;
  const path = rawPath ?? (prefix ? `${prefix}/${name}` : name);
  const dir =
    r.type === "dir" || r.type === "directory" || r.is_dir === true || r.kind === "directory" ||
    (Array.isArray(r.children) && r.children.length > 0) ||
    (r.children === undefined && r.type === undefined && r.is_dir === undefined ? false : Array.isArray(r.children));
  const children = Array.isArray(r.children)
    ? r.children.map((c: unknown) => toNode(c, dir ? path : "")).filter((n: FileNode | null): n is FileNode => n !== null)
    : [];
  return { name, path, dir, children };
}

const HIDDEN = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist"]);

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes]
    .filter((n) => !HIDDEN.has(n.name) && !n.name.startsWith("."))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)))
    .map((n) => (n.dir ? { ...n, children: sortNodes(n.children) } : n));
}

/** Accepts the common backend shapes: bare array | {tree:[…]} | {root:{children}} */
function normalizeTree(raw: unknown): FileNode[] {
  const r = rec(raw);
  let list: unknown[];
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(r.tree)) list = r.tree;
  else if (Array.isArray(r.entries)) list = r.entries;
  else if (r.root !== undefined && typeof r.root === "object") {
    const one = toNode(r.root, "");
    return one ? [one] : [];
  } else if (Array.isArray(r.children)) list = r.children;
  else return [];
  return sortNodes(
    list.map((n) => toNode(n, "")).filter((n): n is FileNode => n !== null),
  );
}

function iconFor(name: string, dir: boolean): string {
  if (dir) return "▸";
  return "▪";
}

function TreeNode({ node, depth, actions }: { node: FileNode; depth: number; actions: FileActions }) {
  const [open, setOpen] = useState(false);
  const openFile = useEditor((s) => s.openFile);
  const pinFile = useEditor((s) => s.pinWholeFile);
  const activeTab = useEditor((s) => s.activeTab);

  if (!node.dir) {
    return (
      <div
        className={`ft-row${activeTab === node.path ? " active" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => void openFile(node.path)}
      >
        <div className="ft-name" title={node.path}>
          <span aria-hidden style={{ width: 14, display: "inline-block", textAlign: "center", fontSize: 11 }}>
            {iconFor(node.name, false)}
          </span>
          <span>{node.name}</span>
        </div>
        <div className="ft-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="ft-btn" title="rename / move" onClick={() => actions.rename(node.path)}>✎</button>
          <button type="button" className="ft-btn" title="delete file" onClick={() => actions.del(node.path, false)}>del</button>
          <button type="button" className="ft-btn" title={`pin whole file: ${node.path}`} onClick={() => void pinFile(node.path)}>＋</button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div
        className="ft-row ft-dir"
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => setOpen(!open)}
      >
        <div className="ft-name" title={node.path}>
          <span aria-hidden className="ft-caret">{open ? "▾" : "▸"}</span>
          <span>{node.name}</span>
        </div>
        <div className="ft-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="ft-btn" title="new file inside" onClick={() => actions.create(node.path)}>＋file</button>
          <button type="button" className="ft-btn" title="new folder inside" onClick={() => actions.createFolder(node.path)}>＋dir</button>
          <button type="button" className="ft-btn" title="rename / move" onClick={() => actions.rename(node.path)}>✎</button>
          <button type="button" className="ft-btn" title="delete folder" onClick={() => actions.del(node.path, true)}>del</button>
        </div>
      </div>
      {open && node.children.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} actions={actions} />)}
    </div>
  );
}

export function FileTree() {
  const projectId = useUi((s) => s.projectId);
  const projectRoot = useUi((s) => s.projectRoot);
  const setProjectPickerOpen = useUi((s) => s.setProjectPickerOpen);
  const toast = useUi((s) => s.toast);
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRaw(await api.fileTree());
    } catch (e) {
      toast(`File tree unavailable: ${String(e)}`, "err");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const activeTaskId = useUi((s) => s.activeTaskId);

  useEffect(() => {
    void load();
  }, [load, projectId, projectRoot, activeTaskId]);

  // Periodic refresh while task is running to show new files in real time
  useEffect(() => {
    if (!activeTaskId) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [load, activeTaskId]);

  const tree = useMemo(() => normalizeTree(raw), [raw]);

  const actions: FileActions = useMemo(() => ({
    create(parentDir: string) {
      const rel = window.prompt(`New file inside ${parentDir === "." ? "root" : parentDir}/ :`, `${parentDir === "." ? "" : parentDir + "/"}new-file.ts`);
      if (!rel) return;
      void api.fileCreate(rel, "file").then(
        () => { void load(); toast(`created ${rel}`, "ok"); },
        (e) => toast(`create failed: ${String(e).slice(0, 120)}`, "err"),
      );
    },
    createFolder(parentDir: string) {
      const rel = window.prompt(
        `New folder name inside ${parentDir === "." ? "root" : parentDir}/ :`,
        `${parentDir === "." ? "" : parentDir + "/"}new_folder`
      );
      if (!rel) return;
      const cleanRel = rel.trim();
      void api.mkdir({ projectId: useUi.getState().projectId || undefined, path: cleanRel }).then(
        () => { void load(); toast(`created folder ${cleanRel}`, "ok"); },
        (e) => toast(`create folder failed: ${String(e).slice(0, 120)}`, "err"),
      );
    },
    rename(path: string) {
      const to = window.prompt(`Rename/move:\n  ${path}\nto (project-relative path):`, path);
      if (!to || to === path) return;
      void api.fileRename(path, to).then(
        () => { void load(); toast(`renamed → ${to}`, "ok"); },
        (e) => toast(`rename failed: ${String(e).slice(0, 120)}`, "err"),
      );
    },
    del(path: string, dir: boolean) {
      if (!window.confirm(`Delete ${dir ? "FOLDER" : "file"} ${path}${dir ? " and everything inside" : ""}?`)) return;
      void api.fileDelete(path).then(
        () => { void load(); toast(`deleted ${path}`, "ok"); },
        (e) => toast(`delete failed: ${String(e).slice(0, 120)}`, "err"),
      );
    },
  }), [load, toast]);

  const folderName = useMemo(() => {
    if (!projectRoot) return "";
    return projectRoot.split("/").filter(Boolean).pop() || "";
  }, [projectRoot]);

  return (
    <div className="filetree" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div className="panel-head">
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={projectRoot || "Workspace"}>
          EXPLORER{folderName ? ` · ${folderName}` : ""}
        </span>
        <span className="spacer" />
        <button type="button" className="btn tiny ghost" title="Open / change workspace folder"
                onClick={() => setProjectPickerOpen(true)}>Folder…</button>
        <button type="button" className="btn tiny" title="new file at root"
                onClick={() => actions.create(".")}>＋file</button>
        <button type="button" className="btn tiny" title="new folder at root"
                onClick={() => actions.createFolder(".")}>＋dir</button>
        <button type="button" className="btn tiny" title="refresh tree" onClick={() => void load()}>
          ⟳{loading ? "…" : ""}
        </button>
      </div>
      <div className="tree-body" style={{ flex: 1, overflowY: "auto" }}>
        {tree.length === 0 ? (
          <div style={{ padding: 16, textAlign: "center" }}>
            <p className="dim empty-hint" style={{ marginBottom: 12 }}>
              No project loaded or directory is empty.
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ fontSize: 12 }}
              onClick={() => setProjectPickerOpen(true)}
            >
              Browse & Open Folder
            </button>
          </div>
        ) : (
          tree.map((n) => <TreeNode key={n.path} node={n} depth={0} actions={actions} />)
        )}
      </div>
    </div>
  );
}
