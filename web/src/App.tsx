// App shell: top bar / [ sidebar | editor+diff overlay+terminal | chat ] grid,
// full-height dashboard mode, settings modal, toasts. All live data flows in
// through the single SSE stream mounted here.
import { Suspense, lazy, useEffect } from "react";
import { useProposals } from "./hooks/useProposals";
import { useTaskStream } from "./hooks/useTaskStream";
import { ChatPane } from "./components/ChatPane";
import { EditorTabs } from "./components/EditorTabs";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TopBar } from "./components/TopBar";
import { DiffReview } from "./components/diff/DiffReview";
import { SettingsModal } from "./components/SettingsModal";
import { MemoryPanel } from "./components/MemoryPanel";
import { OrchestrationModal } from "./components/OrchestrationModal";
import ProjectPickerModal from "./components/ProjectPickerModal";
import { ToastStack } from "./components/ToastStack";
import { useUi } from "./stores/ui";
import { api } from "./lib/api";

const DashboardView = lazy(() => import("./components/dashboard/DashboardView"));

function DashboardArea() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const toggleDashboard = useUi((s) => s.toggleDashboard);
  if (!activeTaskId) {
    return (
      <div className="placeholder-view">
        <div className="placeholder-card">
          <h3>Observability Dashboard</h3>
          <p className="dim">
            Select a task in the top bar to inspect its spans, flamegraph, and
            token ledger.
          </p>
          <button type="button" className="btn primary" onClick={toggleDashboard}>
            ← Back to IDE Workspace
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="dashboard-area">
      <div className="dash-top">
        <button type="button" className="btn tiny ghost" onClick={toggleDashboard}>
          ← Back to IDE Workspace
        </button>
      </div>
      <Suspense fallback={<div className="dim p-4">Loading dashboard…</div>}>
        <DashboardView taskId={activeTaskId} />
      </Suspense>
    </div>
  );
}

function CenterArea({ proposals }: { proposals: ReturnType<typeof useProposals> }) {
  const diffOverlayOpen = useUi((s) => s.diffOverlayOpen);
  const setDiffOverlayOpen = useUi((s) => s.setDiffOverlayOpen);

  return (
    <div className="center">
      <EditorTabs />
      {diffOverlayOpen && (
        <div className="diff-overlay">
          <div className="diff-overlay-head">
            <b>DIFF REVIEW</b> <span className="dim tiny-text">per-hunk accept / reject</span>
            <span className="spacer" />
            <button type="button" className="btn tiny" onClick={() => setDiffOverlayOpen(false)}>✕ close</button>
          </div>
          <div className="diff-overlay-body">
            <DiffReview proposals={proposals} onResolved={() => undefined} />
          </div>
        </div>
      )}
      <TerminalPanel />
    </div>
  );
}

export default function App() {
  const viewMode = useUi((s) => s.viewMode);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const chatWidth = useUi((s) => s.chatWidth);
  const projectRoot = useUi((s) => s.projectRoot);
  const openProject = useUi((s) => s.openProject);
  const projectPickerOpen = useUi((s) => s.projectPickerOpen);
  const setProjectPickerOpen = useUi((s) => s.setProjectPickerOpen);
  const memoryOpen = useUi((s) => s.memoryOpen);
  const setMemoryOpen = useUi((s) => s.setMemoryOpen);
  const orchestrationOpen = useUi((s) => s.orchestrationOpen);
  const setOrchestrationOpen = useUi((s) => s.setOrchestrationOpen);
  const refreshTasks = useUi((s) => s.refreshTasks);

  const activeTaskId = useUi((s) => s.activeTaskId);
  useTaskStream(activeTaskId);
  const proposals = useProposals(activeTaskId);

  // boot: pull tasks and open server workspace root, or prompt with folder picker
  useEffect(() => {
    async function init() {
      await refreshTasks();
      let serverRoot = "";
      try {
        const res = await api.indexStatus();
        if (res?.currentProjectRoot) {
          serverRoot = res.currentProjectRoot;
        }
      } catch {
        // ignore
      }
      // Startup opens a project ONLY when the operator named one, via
      // DEFAULT_PROJECT_ROOT / PROJECT_ROOT (which is what serverRoot reflects).
      //
      // It used to fall back to the last task's project, then to the persisted
      // root, so the IDE always reopened something on its own and the user was
      // never asked. Combined with dev.sh defaulting the workspace to $PWD,
      // launching from the source checkout dropped you into AgentZero's own
      // tree — a workspace nobody had chosen, which the engine then created
      // task branches in.
      //
      // Nothing is lost by asking: the picker is seeded with the previous root
      // and lists recent projects, so resuming is one click, and switching is
      // finally a decision rather than something you undo after the fact.
      if (serverRoot) {
        void openProject(serverRoot);
      } else {
        setProjectPickerOpen(true);
      }
    }
    void init();
  }, []);

  // Window resize handler: keeps chatWidth and layout bounded
  useEffect(() => {
    const handleResize = () => {
      const cur = useUi.getState().chatWidth;
      const maxAllowed = Math.max(260, window.innerWidth - 450);
      if (cur > maxAllowed) {
        useUi.getState().setChatWidth(maxAllowed);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // sidebar drag-resize
  const onSidebarGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const newWidth = ev.clientX;
      useUi.getState().setSidebarWidth(Math.min(480, Math.max(160, newWidth)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // chat drag-resize
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useUi.getState().chatWidth;
    const maxAllowed = Math.max(260, window.innerWidth - 450);

    const move = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const target = Math.max(260, Math.min(maxAllowed, startW + delta));
      useUi.getState().setChatWidth(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app">
      <TopBar />
      {viewMode === "dashboard" ? (
        <main className="main dashboard-mode">
          <DashboardArea />
        </main>
      ) : (
        <main
          className="main"
          style={{
            "--sidebar-w": `${sidebarWidth}px`,
            "--chat-w": `${chatWidth}px`,
          } as React.CSSProperties}
        >
          <Sidebar />
          <div
            className="grip sidebar-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="resize sidebar"
            onPointerDown={onSidebarGripDown}
          />
          <CenterArea proposals={proposals} />
          <div
            className="grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="resize chat pane"
            onPointerDown={onGripDown}
          />
          <ChatPane />
        </main>
      )}
      {projectPickerOpen && (
        <ProjectPickerModal
          initialPath={projectRoot}
          onClose={() => setProjectPickerOpen(false)}
          onPick={(root) => {
            void openProject(root);
          }}
        />
      )}
      <SettingsModal />
      {memoryOpen && (
        <div className="modal-backdrop" onClick={() => setMemoryOpen(false)}>
          <div className="modal-card memory-modal-wrapper" onClick={(e) => e.stopPropagation()}>
            <MemoryPanel onClose={() => setMemoryOpen(false)} />
          </div>
        </div>
      )}
      {orchestrationOpen && (
        <OrchestrationModal onClose={() => setOrchestrationOpen(false)} />
      )}
      <ToastStack />
    </div>
  );
}
