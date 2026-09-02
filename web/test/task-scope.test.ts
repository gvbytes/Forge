// Web store contracts for folder-scoped task lists (RC2) + refresh
// stickiness across rollover (RC1). Pure store-logic tests: fetch is
// stubbed so no engine is needed.
import { describe, expect, test, beforeEach } from "bun:test";

// jsdom-free environment: polyfill the globals ui.ts touches at import time.
declare global {
  // eslint-disable-next-line no-var
  var localStorage: Storage;
  // eslint-disable-next-line no-var
  var window: { localStorage: Storage; setTimeout: typeof setTimeout; innerWidth: number; addEventListener(): void; removeEventListener(): void };
}
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => void store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
(globalThis as any).window = {
  localStorage: (globalThis as any).localStorage,
  setTimeout: setTimeout,
  innerWidth: 1500,
  addEventListener: () => {},
  removeEventListener: () => {},
};

// fetch stub — exact-path responses (query strings tolerated), set per-test.
let fetchCalls: { url: string; init?: RequestInit }[] = [];
const fetchResponses = new Map<string, unknown>();
function stubBody(url: string): unknown {
  // exact path match, ignoring query string
  const clean = url.split("?")[0];
  if (fetchResponses.has(clean)) return fetchResponses.get(clean);
  return [];
}
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  const body = stubBody(url);
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
};

const { useUi } = await import("../src/stores/ui");

function taskRow(id: string, opts: { sessionId?: string; projectId?: string; projectRoot?: string; goal?: string; status?: string } = {}) {
  return {
    id,
    sessionId: opts.sessionId ?? `sess-${id}`,
    projectId: opts.projectId ?? "p1",
    projectRoot: opts.projectRoot ?? "/proj/one",
    projectName: opts.projectName ?? "one",
    title: opts.goal ?? id,
    goal: opts.goal ?? id,
    status: opts.status ?? "done",
  };
}

beforeEach(() => {
  store.clear();
  fetchCalls = [];
  fetchResponses.clear();
  fetchResponses.set("/api/tasks", [taskRow("t1"), taskRow("t2"), taskRow("t3")]);
  fetchResponses.set("/api/project/open", { project_id: "p1", root: "/proj/one" });
  useUi.setState({
    tasks: [], activeTaskId: null, activeSessionId: null, projectId: null,
    projectRoot: "", taskScope: "folder",
  });
});

describe("folder-scoped task list (RC2)", () => {
  test("refreshTasks with scope=folder passes ?projectId= when known", async () => {
    useUi.setState({ projectId: "p1", taskScope: "folder" });
    await useUi.getState().refreshTasks();
    const call = fetchCalls.find((c) => c.url.includes("/api/tasks"));
    expect(call!.url).toContain("projectId=p1");
  });

  test("refreshTasks with scope=all fetches unscoped", async () => {
    useUi.setState({ projectId: "p1", taskScope: "all" });
    await useUi.getState().refreshTasks();
    const call = fetchCalls.find((c) => c.url.includes("/api/tasks"));
    expect(call!.url).not.toContain("projectId=");
  });

  test("scope=folder without a known projectId fetches unscoped (nothing to filter)", async () => {
    useUi.setState({ projectId: null, taskScope: "folder" });
    await useUi.getState().refreshTasks();
    const call = fetchCalls.find((c) => c.url.includes("/api/tasks"));
    expect(call!.url).not.toContain("projectId=");
  });

  test("setTaskScope persists the choice across reloads", async () => {
    useUi.getState().setTaskScope("all");
    expect(store.get("agent-ide.taskScope")).toBe("all");
    expect(useUi.getState().taskScope).toBe("all");
    useUi.getState().setTaskScope("folder");
    expect(store.get("agent-ide.taskScope")).toBe("folder");
  });
});

describe("refresh stickiness across rollover (RC1)", () => {
  test("a dead activeTaskId that exists as a session's CURRENT task is re-selected", async () => {
    // Server rolled the task over: the old UUID is gone from the list, but the
    // same session now has a NEW task id. refreshTasks must follow it.
    fetchResponses.clear();
    fetchResponses.set("/api/tasks", [
      taskRow("new-task", { sessionId: "sess-old", projectRoot: "/proj/one" }),
    ]);
    fetchResponses.set("/api/tasks/dead-task", { ok: true, session: { id: "sess-old" }, task: { id: "new-task", status: "done" } });
    useUi.setState({ activeTaskId: "dead-task", taskScope: "all" });
    await useUi.getState().refreshTasks();
    // dead-task not in the list → resolve via the session's current task
    expect(useUi.getState().activeTaskId).toBe("new-task");
    expect(useUi.getState().activeSessionId).toBe("sess-old");
  });

  test("a dead activeTaskId resolvable as sessionId keeps the session's current task", async () => {
    fetchResponses.clear();
    fetchResponses.set("/api/tasks", [
      taskRow("current-1", { sessionId: "S1", projectRoot: "/proj/one" }),
    ]);
    fetchResponses.set("/api/tasks/S1", { ok: true, session: { id: "S1" }, task: { id: "current-1", status: "done" } });
    useUi.setState({ activeTaskId: "S1", taskScope: "all" });
    await useUi.getState().refreshTasks();
    expect(useUi.getState().activeTaskId).toBe("current-1");
  });

  test("an id that resolves to NOTHING clears the selection honestly", async () => {
    fetchResponses.clear();
    fetchResponses.set("/api/tasks", [taskRow("t1")]);
    fetchResponses.set("/api/tasks/gone-task", { error: "not found" });
    useUi.setState({ activeTaskId: "gone-task", taskScope: "all" });
    await useUi.getState().refreshTasks();
    expect(useUi.getState().activeTaskId).toBeNull();
  });

  test("a still-live activeTaskId survives the refresh untouched", async () => {
    fetchResponses.set("/api/tasks", [taskRow("t1"), taskRow("t2")]);
    useUi.setState({ activeTaskId: "t2", taskScope: "all" });
    await useUi.getState().refreshTasks();
    expect(useUi.getState().activeTaskId).toBe("t2");
  });
});
