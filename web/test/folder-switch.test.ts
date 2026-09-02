// Folder isolation (user bug: "old chat in new project — everything should be
// associated to the folder"). Opening a DIFFERENT project must clear the task
// selection, chat buffers, and not re-select a task from the OLD folder; the
// dead-id resolution must never jump across projects. Pure store-logic tests
// with a stubbed fetch.
import { describe, expect, test, beforeEach } from "bun:test";

declare global {
  // eslint-disable-next-line no-var
  var localStorage: Storage;
  // eslint-disable-next-line no-var
  var window: unknown;
}
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
(globalThis as any).window = { localStorage: (globalThis as any).localStorage, setTimeout, clearTimeout };

const fetchCalls: { url: string; init?: RequestInit }[] = [];
const responses = new Map<string, unknown>();
function stub(url: string, body: unknown): void {
  const clean = url.split("?")[0];
  responses.set(clean, body);
}
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  const clean = url.split("?")[0];
  const body = responses.has(clean) ? responses.get(clean) : [];
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
};

const { useUi } = await import("../src/stores/ui");
const { useChat } = await import("../src/stores/chat");

function taskRow(id: string, opts: { sessionId?: string; projectRoot?: string; goal?: string } = {}) {
  return {
    id, sessionId: opts.sessionId ?? `sess-${id}`, projectId: "p-old",
    projectRoot: opts.projectRoot ?? "/old/proj", projectName: "oldproj",
    title: opts.goal ?? id, goal: opts.goal ?? id, status: "done",
  };
}

beforeEach(() => {
  mem.clear();
  fetchCalls.length = 0;
  responses.clear();
  // default: opening any project succeeds
  stub("/api/project/open", { project_id: "p-new", root: "/new/proj" });
  useUi.setState({
    tasks: [], activeTaskId: null, activeSessionId: null, projectId: "p-old",
    projectRoot: "/old/proj", taskScope: "folder", openingProject: false,
  });
  useChat.setState({ events: {}, rev: {}, conn: {}, local: {}, routes: {} });
});

describe("folder switch clears old-folder state (bug: old chat in new project)", () => {
  test("opening a DIFFERENT project clears activeTaskId + activeSessionId", async () => {
    useUi.setState({ activeTaskId: "old-task", activeSessionId: "old-sess" });
    await useUi.getState().openProject("/new/proj");
    expect(useUi.getState().projectRoot).toBe("/new/proj");
    expect(useUi.getState().activeTaskId).toBeNull();
    expect(useUi.getState().activeSessionId).toBeNull();
    // and the persisted id is cleared too (fresh reload starts folder-pure)
    expect(mem.get("agent-zero.activeTaskId")).toBeUndefined();
  });

  test("re-opening the SAME project keeps the active task", async () => {
    stub("/api/project/open", { project_id: "p-old", root: "/old/proj" });
    // task list still contains the active task (same project, no rollover)
    stub("/api/tasks", [taskRow("old-task")]);
    useUi.setState({ activeTaskId: "old-task", activeSessionId: "old-sess" });
    await useUi.getState().openProject("/old/proj");
    expect(useUi.getState().activeTaskId).toBe("old-task");
  });

  test("dead-id resolution NEVER re-selects a task from ANOTHER project", async () => {
    // scoped list of the NEW folder (new task only)
    stub("/api/tasks", [{ id: "new-task", sessionId: "new-sess", projectId: "p-new",
      projectRoot: "/new/proj", projectName: "newproj", goal: "fresh", status: "done" }]);
    // the OLD task resolves globally to the OLD project's session
    stub("/api/tasks/old-task", { ok: true, session: { id: "old-sess" }, task: { id: "old-task" } });
    // refreshTasks resolves project info via the task row… the response above
    // lacks it — the resolver must treat "cannot prove same project" as foreign.
    useUi.setState({ activeTaskId: "old-task", activeSessionId: "old-sess", projectId: "p-new", taskScope: "folder" });
    await useUi.getState().refreshTasks();
    // honest clear, not a cross-folder zombie
    expect(useUi.getState().activeTaskId).toBeNull();
  });

  test("dead-id resolution FOLLOWS a same-project rollover (stickiness retained)", async () => {
    stub("/api/tasks", [{ id: "cur-task", sessionId: "sess-1", projectId: "p-new",
      projectRoot: "/new/proj", projectName: "newproj", goal: "fresh", status: "done" }]);
    stub("/api/tasks/dead-id", { ok: true, session: { id: "sess-1" }, task: { id: "cur-task" } });
    useUi.setState({ activeTaskId: "dead-id", activeSessionId: "sess-1", projectId: "p-new", taskScope: "folder" });
    await useUi.getState().refreshTasks();
    expect(useUi.getState().activeTaskId).toBe("cur-task");
  });
});

describe("critique-found regressions in the isolation wipe", () => {
  test("TopBar typed-path flow: input already changed projectRoot, switch is detected via projectId", async () => {
    // TopBar's input setProjectRoot()s on every keystroke, so projectRoot already
    // equals the NEW path before openProject() runs — the root-string compare
    // computes switched=false and the wipe never runs. Project identity must
    // come from projectId, not the input text.
    useUi.setState({ activeTaskId: "old-task", activeSessionId: "old-sess", projectRoot: "/new/proj" });
    // simulate: store's projectRoot was mutated by the input BEFORE the open
    await useUi.getState().openProject("/new/proj");
    expect(useUi.getState().activeTaskId).toBeNull();
  });

  test("cross-folder task pick survives the openProject it triggers (selectTask path)", async () => {
    // "all folders" scope: user picks a task that lives in another folder →
    // openProject(taskRoot) must NOT wipe the selection the user just made.
    stub("/api/project/open", { project_id: "p-new", root: "/new/proj" });
    const pickRow = taskRow("pick-task", { sessionId: "pick-sess", projectRoot: "/new/proj", goal: "picked" });
    stub("/api/tasks", [pickRow]);
    useUi.setState({ tasks: [pickRow] as any });
    const ui = useUi.getState();
    // selectTask sets the id, then follows the task's folder:
    ui.selectTask("pick-task");
    // selectTask fires openProject asynchronously — wait a tick for it
    await new Promise((r) => setTimeout(r, 10));
    expect(useUi.getState().projectRoot).toBe("/new/proj");
    expect(useUi.getState().activeTaskId).toBe("pick-task");
    expect(useUi.getState().activeSessionId).toBe("pick-sess");
  });

  test("boot restore: openProject(initialTask.projectRoot) keeps the persisted task selection", async () => {
    // App.tsx init(): refreshTasks restores the persisted task, then openProject
    // follows that task's folder. When the folder differs from the last-browsed
    // root, the wipe must NOT null the restored selection (nothing from another
    // project was on screen — this is a boot follow, not a user switch).
    stub("/api/project/open", { project_id: "p-old", root: "/old/proj" });
    stub("/api/tasks", [taskRow("old-task", { sessionId: "old-sess" })]);
    useUi.setState({ projectId: null, projectRoot: "/somewhere/else", activeTaskId: "old-task", activeSessionId: "old-sess" });
    await useUi.getState().openProject("/old/proj");
    expect(useUi.getState().activeTaskId).toBe("old-task");
  });

  test("switch clears the stale task list before the scoped fetch resolves (no flash)", async () => {
    // Make the /api/tasks fetch SLOW so the assertion runs while
    // openProject is between its wipe and the scoped list arriving — the
    // window where the old folder's rows must NOT be in the select.
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<unknown>((r) => { releaseSlow = () => r([]); });
    (globalThis as any).fetch = async (url: string) => {
      if (url.startsWith("/api/tasks")) {
        return { ok: true, status: 200, json: async () => await slow, text: async () => "[]" } as any;
      }
      if (url.startsWith("/api/project/open")) {
        return { ok: true, status: 200, json: async () => ({ project_id: "p-new", root: "/new/proj" }), text: async () => "{}" } as any;
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as any;
    };
    useUi.setState({ tasks: [taskRow("old-task")] as any, activeTaskId: "old-task" });
    const opening = useUi.getState().openProject("/new/proj");
    // give openProject time to reach the wipe (api.openProject + a tick)
    await new Promise((r) => setTimeout(r, 10));
    expect(useUi.getState().tasks).toEqual([]); // mid-flight: wiped already
    releaseSlow!();
    await opening;
    expect(useUi.getState().tasks).toEqual([]); // after: scoped (empty) list
  });
});

describe("refreshTasks race guard (stale in-flight fetch must not apply)", () => {
  test("a fetch started BEFORE a switch resolves AFTER it → payload dropped", async () => {
    // in-flight fetch for OLD project; openProject switches to NEW; then the
    // stale fetch resolves and must NOT clobber the new folder's task list.
    let releaseOld: (() => void) | null = null;
    const oldFetch = new Promise<unknown>((r) => { releaseOld = () => r([{ id: "stale-task", sessionId: "stale-s", projectId: "p-old", projectRoot: "/old/proj", projectName: "old", goal: "stale", status: "done" }]); });
    (globalThis as any).fetch = async (url: string) => {
      if (url.startsWith("/api/tasks?") || url === "/api/tasks") {
        if ((useUi.getState() as any).projectId === "p-old" && releaseOld) {
          return { ok: true, status: 200, json: async () => await oldFetch, text: async () => "[]" } as any;
        }
        return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as any;
      }
      if (url.startsWith("/api/project/open")) {
        return { ok: true, status: 200, json: async () => ({ project_id: "p-new", root: "/new/proj" }), text: async () => "{}" } as any;
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as any;
    };
    // start a refresh scoped to the OLD project
    const inflight = useUi.getState().refreshTasks();
    await new Promise((r) => setTimeout(r, 5)); // let it capture scope
    // switch projects (openProject runs its own refresh)
    await useUi.getState().openProject("/new/proj");
    expect(useUi.getState().projectId).toBe("p-new");
    // now the OLD fetch resolves — must be dropped, not applied
    releaseOld!();
    await inflight;
    expect(useUi.getState().tasks).toEqual([]);
  });
});
