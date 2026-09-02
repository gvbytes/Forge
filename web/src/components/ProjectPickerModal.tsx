// Project picker: browse the filesystem to choose a repo/workspace root.
// Centered modal dialog with backdrop blur, breadcrumbs, recent-project
// quick jumps, subfolder descent, new folder creation, and "Open this folder"
// confirmation.
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

export default function ProjectPickerModal({
  onPick,
  onClose,
  initialPath = "",
}: {
  onPick: (root: string) => void;
  onClose: () => void;
  initialPath?: string;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathBar, setPathBar] = useState(initialPath);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // web #26: quick jumps come from recently opened projects (no hardcoded paths)
  const recentProjects = useUi((s) => s.recentProjects);

  async function load(p: string) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(p)}`);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Listing;
      setListing(data);
      setPathBar(data.path);
    } catch (e: any) {
      setErr(String(e.message || e).slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateFolder() {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".")) {
      setErr("Folder name cannot contain slashes or start with '.'");
      return;
    }
    if (!listing) return;
    setBusy(true);
    setErr("");
    try {
      const res = await api.mkdir({ parentPath: listing.path, name: trimmed });
      setNewFolderName("");
      const sep = listing.path.includes("\\") ? "\\" : "/";
      const target = res.path || (listing.path.endsWith(sep) ? `${listing.path}${trimmed}` : `${listing.path}${sep}${trimmed}`);
      await load(target);
    } catch (e: any) {
      setErr(`Failed to create folder: ${e.message || String(e)}`);
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(initialPath || "");
  }, [initialPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creatingFolder) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, creatingFolder]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal project-picker-modal"
        style={{ width: "min(700px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          
          <b style={{ fontSize: 14 }}>Open Workspace — Choose Folder</b>
          <span className="spacer" />
          <button
            type="button"
            className="btn ghost tiny"
            onClick={onClose}
            aria-label="close"
            style={{ fontSize: 14, padding: "2px 8px" }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "12px 16px 6px" }}>
          {/* Quick jumps: recently opened projects only (web #26) */}
          {recentProjects.length > 0 && (
            <div className="quick-jumps" style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="dim tiny-text">Recent:</span>
              {recentProjects.map((root) => (
                <button
                  key={root}
                  type="button"
                  className="btn tiny"
                  title={root}
                  onClick={() => void load(root)}
                >
                  {root.split(/[/\\]/).filter(Boolean).pop() ?? root}
                </button>
              ))}
            </div>
          )}

          {/* Path bar input + Go + New Folder button */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              className="mono"
              style={{
                flex: 1,
                padding: "6px 10px",
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                fontSize: 12.5,
              }}
              value={pathBar}
              onChange={(e) => setPathBar(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load(pathBar);
              }}
              placeholder="/absolute/path/to/project"
            />
            <button
              type="button"
              className="btn"
              onClick={() => void load(pathBar)}
              disabled={busy}
            >
              {busy ? "…" : "Go"}
            </button>
            <button
              type="button"
              className={`btn${creatingFolder ? " active" : ""}`}
              onClick={() => {
                setCreatingFolder(!creatingFolder);
                setErr("");
              }}
              title="Create a new folder in this directory"
            >
              ＋ New Folder
            </button>
          </div>
        </div>

        {/* Inline Create New Folder bar */}
        {creatingFolder && (
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "8px 12px",
              margin: "0 16px 8px",
              background: "var(--bg2)",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius)",
              alignItems: "center",
            }}
          >
            
            <input
              className="mono"
              style={{
                flex: 1,
                padding: "5px 8px",
                background: "var(--bg0)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                fontSize: 12,
              }}
              autoFocus
              placeholder="New folder name (e.g. project_v2, my-app)..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder();
                if (e.key === "Escape") setCreatingFolder(false);
              }}
            />
            <button
              type="button"
              className="btn primary tiny"
              onClick={() => void handleCreateFolder()}
              disabled={!newFolderName.trim() || busy}
            >
              Create
            </button>
            <button
              type="button"
              className="btn ghost tiny"
              onClick={() => {
                setCreatingFolder(false);
                setNewFolderName("");
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Directory browser list */}
        <div
          className="dir-list"
          style={{
            maxHeight: 300,
            overflowY: "auto",
            margin: "0 16px 10px",
            background: "var(--bg0)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          {listing?.parent && listing.parent !== listing.path && (
            <div
              className="dir-row parent"
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg2)",
                color: "var(--muted)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
              }}
              onClick={() => void load(listing.parent!)}
            >
              <span>↰</span>
              <span className="mono">.. ({listing.parent})</span>
            </div>
          )}

          {busy && <div style={{ padding: "12px 16px", color: "var(--muted)", fontSize: 12 }}>Loading directory…</div>}

          {!busy && listing && listing.dirs.length === 0 && (
            <div style={{ padding: "12px 16px", color: "var(--muted)", fontSize: 12 }}>
              (no subdirectories found in this folder)
            </div>
          )}

          {!busy &&
            listing?.dirs.map((d) => (
              <div
                key={d.path}
                className="dir-row"
                style={{
                  padding: "7px 12px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  borderBottom: "1px solid rgba(255, 255, 255, 0.03)",
                }}
                onClick={() => void load(d.path)}
              >
                
                <span className="mono" style={{ color: "var(--text)" }}>{d.name}</span>
              </div>
            ))}
        </div>

        {err && (
          <div style={{ padding: "0 16px 8px", color: "var(--err)", fontSize: 11 }}>
            {err}
          </div>
        )}

        {/* Modal footer with action buttons */}
        <div
          className="modal-foot"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg2)",
          }}
        >
          <span
            className="dim tiny-text mono"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "50%",
            }}
            title={listing?.path}
          >
            {listing?.path ? `Target: ${listing.path}` : "Select a folder"}
          </span>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!listing || busy}
              onClick={() => {
                if (listing) {
                  onPick(listing.path);
                  onClose();
                }
              }}
            >
              Open This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
