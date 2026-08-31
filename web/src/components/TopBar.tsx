import React, { Fragment } from "react";
// Top bar: project root picker, task selector, new-task, live budget meter
// ($ + steps from spans), dashboard toggle, settings, diff-review badge.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";
import ProjectPickerModal from "./ProjectPickerModal";
import { DiffReviewBadge } from "./diff/DiffReview";
import type { SpanDto, TaskDto } from "../lib/types";

const POLL_MS = 8000;

/** RC2: group task rows by folder (project), most-recent-first within a group,
 *  folders ordered by their newest task. Single map pass — cheap at any size. */
export function groupTasksByFolder(tasks: TaskDto[]): [string, TaskDto[]][] {
  // NOTE: returns plain PAIRS, not a Map — Object.entries() on a Map yields []
  // (it iterates object props, not Map entries), which silently rendered an
  // empty task select (found via live E2E probe).
  const groups = new Map<string, TaskDto[]>();
  for (const t of tasks) {
    const folder = t.projectName || (t.projectRoot ? t.projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? "" : "") || "unknown";
    const rows = groups.get(folder);
    if (rows) rows.push(t);
    else groups.set(folder, [t]);
  }
  return [...groups.entries()];
}

function TaskOption({ t }: { t: TaskDto }) {
  return (
    <option key={t.id} value={t.id} title={`${t.projectRoot ? t.projectRoot + " : " : ""}${t.goal}`}>
      [{t.status}] {t.goal.slice(0, 35)}
    </option>
  );
}

// B33: engine status vocabulary — planning|running|waiting-approval|reviewing|
// done|failed|stopped (no paused/queued).
function statusChip(status: string): string {
  const map: Record<string, string> = {
    planning: "info", running: "ok", "waiting-approval": "warn", reviewing: "info",
    done: "ok", failed: "err", stopped: "dim", idle: "dim",
  };
  return map[status] ?? "dim";
}

export function BudgetMeter() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const tasks = useUi((s) => s.tasks);
  const [usage, setUsage] = useState<{ cost: number; steps: number } | null>(null);

  // B19: match both task UUID and sessionId.
  const task = tasks.find((t) => t.id === activeTaskId || (activeTaskId != null && t.sessionId === activeTaskId)) ?? null;

  useEffect(() => {
    setUsage(null);
    if (!activeTaskId) return;
    let alive = true;
    const load = async () => {
      try {
        const spans: SpanDto[] = await api.spans(activeTaskId);
        if (!alive) return;
        const actionSteps = spans.filter((s: any) => s.kind === "tool.call" || s.kind === "agent.start" || s.kind === "step").length;
        const taskStepCount = (task as any)?.stepCount;
        setUsage({
          cost: spans.reduce((a, s) => a + (s.cost_usd || 0), 0),
          steps: typeof taskStepCount === "number" && taskStepCount > 0 ? taskStepCount : actionSteps,
        });
      } catch {
        /* endpoint may not exist yet */
      }
    };
    void load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [activeTaskId]);

  if (!task) return <span className="dim tiny-text nowrap">no task</span>;

  // The engine's task rows carry `budgetUsdCap` (TaskRecord) — there is no
  // `budget` object on the wire; keep the legacy read as a fallback.
  const budgetUsdCap = (task as TaskDto & { budgetUsdCap?: number }).budgetUsdCap;
  const maxCost = typeof task.budget?.max_cost_usd === "number"
    ? task.budget.max_cost_usd
    : typeof budgetUsdCap === "number" ? budgetUsdCap : 0.50;
  const maxSteps = typeof task.budget?.max_steps === "number" ? task.budget.max_steps : 40;
  const cost = usage?.cost ?? 0;
  const steps = usage?.steps ?? 0;
  const costRatio = maxCost > 0 ? Math.min(1, cost / maxCost) : 0;
  const stepRatio = maxSteps > 0 ? Math.min(1, steps / maxSteps) : 0;
  const heat = (r: number) => (r >= 0.95 ? "err" : r >= 0.7 ? "warn" : "ok");

  return (
    <div className="budget-meter" title="live spend vs. task budgets (polled every 8s)">
      <div className={`meter ${heat(costRatio)}`}>
        <i style={{ width: `${costRatio * 100}%` }} />
      </div>
      <span className="mono">
        ${cost.toFixed(3)}{maxCost > 0 ? ` / $${maxCost}` : ""}
      </span>
      <div className={`meter steps ${heat(stepRatio)}`}>
        <i style={{ width: `${stepRatio * 100}%` }} />
      </div>
      <span className="mono">
        {steps}{maxSteps > 0 ? `/${maxSteps}` : ""} steps
      </span>
      <span className={`chip ${statusChip(task.status)}`}>{task.status}</span>
    </div>
  );
}

export function TopBar() {
  const projectRoot = useUi((s) => s.projectRoot);
  const setProjectRoot = useUi((s) => s.setProjectRoot);
  const openProject = useUi((s) => s.openProject);
  const openingProject = useUi((s) => s.openingProject);
  const setProjectPickerOpen = useUi((s) => s.setProjectPickerOpen);

  const tasks = useUi((s) => s.tasks);
  const activeTaskId = useUi((s) => s.activeTaskId);
  const selectTask = useUi((s) => s.selectTask);
  const refreshTasks = useUi((s) => s.refreshTasks);
  const seedComposer = useUi((s) => s.seedComposer);
  const taskScope = useUi((s) => s.taskScope);
  const setTaskScope = useUi((s) => s.setTaskScope);

  const viewMode = useUi((s) => s.viewMode);
  const toggleDashboard = useUi((s) => s.toggleDashboard);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const setMemoryOpen = useUi((s) => s.setMemoryOpen);
  const setOrchestrationOpen = useUi((s) => s.setOrchestrationOpen);
  const setDiffOverlayOpen = useUi((s) => s.setDiffOverlayOpen);
  const pendingHunks = useUi((s) => s.pendingHunks);

  const doOpen = () => {
    if (!projectRoot.trim()) { setProjectPickerOpen(true); return; }
    void openProject();
  };

  return (
    <header className="topbar">
      <span className="logo" title="Agent IDE — agentic coding IDE">Agent IDE</span>

      <input
        className="project-root mono"
        placeholder="/path/to/project root…"
        value={projectRoot}
        onChange={(e) => setProjectRoot(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") doOpen(); }}
        spellCheck={false}
      />
      <button type="button" className="btn ghost" title="Browse folders…"
              onClick={() => setProjectPickerOpen(true)}>Browse…</button>
      <button type="button" className="btn" onClick={doOpen} disabled={openingProject}>
        {openingProject ? "opening…" : "Open"}
      </button>

      <span className="vsep" />

      <select
        className="task-select"
        // B19: activeTaskId may be a sessionId — resolve to the row's real id
        value={tasks.find((t) => t.id === activeTaskId || (activeTaskId != null && t.sessionId === activeTaskId))?.id ?? ""}
        onChange={(e) => selectTask(e.target.value || null)}
        aria-label="select task"
      >
        <option value="">no task selected</option>
        {/* RC2: tasks grouped by folder. In "all" scope every folder becomes an
            <optgroup>; in "folder" scope the rows stay flat for fast scanning
            (single implicit group = the current project). */}
        {groupTasksByFolder(tasks).map(([folder, rows]) =>
          taskScope === "all" && rows.length > 0 ? (
            <optgroup key={folder} label={`${folder} (${rows.length})`}>
              {rows.map((t) => <TaskOption key={t.id} t={t} />)}
            </optgroup>
          ) : (
            <Fragment key={folder}>{rows.map((t) => <TaskOption key={t.id} t={t} />)}</Fragment>
          ),
        )}
      </select>
      <button
        type="button"
        className={`btn tiny${taskScope === "all" ? " primary" : ""}`}
        aria-pressed={taskScope === "all"}
        title={taskScope === "folder"
          ? "showing tasks for THIS folder only — click to show ALL folders"
          : "showing tasks from ALL folders — click to scope to this folder"}
        onClick={() => setTaskScope(taskScope === "folder" ? "all" : "folder")}
      >
        {taskScope === "folder" ? " this folder" : " all folders"}
      </button>
      <button
        type="button"
        className="btn"
        title="start a new task: seeds the composer with /plan"
        onClick={() => seedComposer("/plan ")}
      >
        ＋ New Task
      </button>
      <button type="button" className="btn tiny" title="refresh task list" onClick={() => void refreshTasks()}>
        ⟳
      </button>

      <span className="spacer" />

      <BudgetMeter />

      <span className="vsep" />

      <button
        type="button"
        className={`btn${viewMode === "dashboard" ? " primary" : ""}`}
        onClick={toggleDashboard}
        title="toggle full-height observability dashboard"
      >
        ▦ Dashboard
      </button>

      <button
        type="button"
        className="btn diff-btn"
        onClick={() => setDiffOverlayOpen(true)}
        title={`${pendingHunks} pending hunk(s) awaiting review`}
      >
        ⇄ Review <DiffReviewBadge count={pendingHunks} />
      </button>

      <button
        type="button"
        className="btn orch-btn"
        onClick={() => setOrchestrationOpen(true)}
        title="Multi-agent DAG orchestration & model routing rationale (≤80B params)"
      >
        Routing
      </button>

      <button
        type="button"
        className="btn memory-btn"
        onClick={() => setMemoryOpen(true)}
        title="persistent memory & project rules (.agentzero/memory.json, .cursorrules)"
      >
        Memory
      </button>

      <button
        type="button"
        className="btn gear"
        onClick={() => setSettingsOpen(true)}
        title="settings — providers, models, budgets & approvals (required)"
        aria-label="open settings"
      >
        Settings
      </button>
    </header>
  );
}
