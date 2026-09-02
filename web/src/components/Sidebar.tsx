// Left sidebar: FileTree / ContextPanel tabs.
import { useUi } from "../stores/ui";
import { ContextPanel } from "./ContextPanel";
import { FileTree } from "./FileTree";

export function Sidebar() {
  const leftTab = useUi((s) => s.leftTab);
  const setLeftTab = useUi((s) => s.setLeftTab);

  return (
    <aside className="sidebar">
      <div className="side-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={leftTab === "files"}
          className={`side-tab${leftTab === "files" ? " active" : ""}`}
          onClick={() => setLeftTab("files")}
        >
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={leftTab === "context"}
          className={`side-tab${leftTab === "context" ? " active" : ""}`}
          onClick={() => setLeftTab("context")}
        >
          Context
        </button>
      </div>
      {leftTab === "files" ? <FileTree /> : <ContextPanel />}
    </aside>
  );
}
