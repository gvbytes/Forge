/**
 * Live role → model activity.
 *
 * PS 3b says the routing decision can never be hidden. Until now the only way
 * to learn which model handled which piece of work was to read route decisions
 * out of the trace after the task finished — accurate, but not an answer to the
 * question people actually ask, which is "what is running right now".
 *
 * Two halves, from two deliberately different sources:
 *
 *   CONFIGURED  what each role is pinned to, fetched from the router. Static
 *               until an operator changes it.
 *   LIVE        which role is mid-call and on which model, derived from the
 *               `route` and `agent.*` events already streaming into the chat
 *               timeline. Derived rather than fetched, so it cannot disagree
 *               with the trace the way a second endpoint could.
 *
 * With one provider and three keys, "which key" matters as much as "which
 * model" — a fallback between keys is otherwise invisible, since every attempt
 * reads the same provider/model pair and looks like a pointless retry.
 */
import { useEffect, useMemo, useState } from "react";
import type { EventDto } from "../lib/types";

interface Activity {
  pins: Record<string, string>;
  tiers: Record<string, { provider: string; model: string; param_b?: number }[]> | null;
}

/** What each role is doing, newest observation wins. */
export interface RoleState {
  role: string;
  model?: string;
  provider?: string;
  /** "2/3" when a fallback key served the call. */
  key?: string;
  status: "running" | "done" | "idle";
  since?: number;
  reason?: string;
}

const ROLE_ORDER = ["planner", "explorer", "coder", "reviewer", "critic", "summarizer", "triage"];

/** Why each role exists, in one line — the panel doubles as the explanation. */
const ROLE_PURPOSE: Record<string, string> = {
  planner: "breaks the goal into steps",
  explorer: "finds the relevant code",
  coder: "writes and edits files",
  reviewer: "checks the diff",
  critic: "checks the diff",
  summarizer: "compacts context, answers greetings",
  triage: "decides how much work a prompt needs",
};

export function useRoutingActivity(): Activity | null {
  const [act, setAct] = useState<Activity | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/router/activity")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (alive && j && !j.error) setAct(j as Activity); })
        .catch(() => { /* panel hides itself */ });
    void load();
    // Pins change only by operator action, so this is a slow poll, not a tick.
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return act;
}

/**
 * Fold the event stream into per-role state.
 *
 * `route` carries the decision (model, provider, why); `agent.start` /
 * `agent.end` bracket the work. A role is "running" when it has started and not
 * yet ended.
 */
export function foldRoleStates(events: EventDto[], pins: Record<string, string>): RoleState[] {
  const byRole = new Map<string, RoleState>();
  const get = (role: string): RoleState => {
    const cur = byRole.get(role) ?? { role, status: "idle" as const };
    byRole.set(role, cur);
    return cur;
  };

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, any>;
    const role = typeof p.agentRole === "string" ? p.agentRole : undefined;
    if (!role) continue;
    const st = get(role);

    if (ev.type === "route") {
      const d = (p.input ?? p.decision ?? p) as Record<string, any>;
      if (typeof d.modelId === "string") st.model = d.modelId;
      if (typeof d.provider === "string") st.provider = d.provider;
      if (typeof d.reason === "string") st.reason = d.reason;
    }
    if (ev.type === "agent.start") { st.status = "running"; st.since = ev.ts; }
    if (ev.type === "agent.end" || ev.type === "error") st.status = "done";
    // The proxy stamps "2/3" when a fallback key served the attempt.
    const attempts = Array.isArray(p.attempts) ? p.attempts : undefined;
    const withKey = attempts?.find((a: any) => typeof a?.key === "string");
    if (withKey) st.key = withKey.key;
  }

  // Pinned roles that have not run yet still belong in the list: "configured
  // but idle" is information, and an empty panel would read as "not wired up".
  for (const role of Object.keys(pins)) get(role);

  return [...byRole.values()].sort(
    (a, b) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(b.role) + 1 || 99),
  );
}

function shortModel(id: string): string {
  // "nvidia/nemotron-3.5-lightning-30b-a3b" -> "nemotron-3.5-lightning-30b-a3b"
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

export function RoutingActivity({ events }: { events: EventDto[] }) {
  const act = useRoutingActivity();
  const rows = useMemo(() => foldRoleStates(events, act?.pins ?? {}), [events, act]);
  if (!act) return null;

  return (
    <div className="ra" role="region" aria-label="model activity">
      <div className="ra-head">
        <span className="ra-title">Model activity</span>
        <span className="ra-sub">role → model</span>
      </div>
      <table className="ra-table">
        <tbody>
          {rows.map((r) => {
            const configured = act.pins[r.role];
            const shown = r.model ?? configured;
            return (
              <tr key={r.role} className={r.status === "running" ? "is-running" : undefined}>
                <td className="ra-role">
                  <span className={`ra-dot ra-${r.status}`} aria-hidden />
                  {r.role}
                  <span className="ra-purpose">{ROLE_PURPOSE[r.role] ?? ""}</span>
                </td>
                <td className="ra-model" title={r.reason ?? shown ?? ""}>
                  {shown ? shortModel(shown) : <span className="dim">unassigned</span>}
                  {/* Only shown when a NON-first key served the call, which is
                      exactly when it is worth knowing. */}
                  {r.key && r.key !== "1/1" && <span className="ra-key">key {r.key}</span>}
                </td>
                <td className="ra-state">
                  {r.status === "running" ? "running" : r.status === "done" ? "done" : "idle"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
