import { RoutingActivity } from "./RoutingActivity";
import { useChat } from "../stores/chat";
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";
import type { RouterStatus, TaskDto } from "../lib/types";

export function OrchestrationModal({ onClose }: { onClose: () => void }) {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const tasks = useUi((s) => s.tasks);

  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null);
  const [activeTab, setActiveTab] = useState<"activity" | "tiers" | "dag" | "harness">("activity");
  // The activity view folds the SAME events the chat renders, so it can never
  // disagree with the trace.
  const activityEvents = useChat((s) => (activeTaskId ? s.events[activeTaskId] : undefined)) ?? [];

  const task = tasks.find(
    (t) => t.id === activeTaskId || (activeTaskId != null && t.sessionId === activeTaskId)
  ) ?? null;

  useEffect(() => {
    void api.routerStatus().then((rs) => setRouterStatus(rs)).catch(() => {});
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content orchestration-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            
            <h3>Orchestration & Advanced Routing Explainer</h3>
          </div>
          <button type="button" className="btn-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab Navigation */}
        <div className="orch-tabs">
          <button
            type="button"
            className={`orch-tab ${activeTab === "activity" ? "active" : ""}`}
            onClick={() => setActiveTab("activity")}
          >
            Model Activity
          </button>
          <button
            type="button"
            className={`orch-tab ${activeTab === "tiers" ? "active" : ""}`}
            onClick={() => setActiveTab("tiers")}
          >
            Model Tiers (≤80B Params)
          </button>
          <button
            type="button"
            className={`orch-tab ${activeTab === "dag" ? "active" : ""}`}
            onClick={() => setActiveTab("dag")}
          >
            DAG & Access Topology
          </button>
          <button
            type="button"
            className={`orch-tab ${activeTab === "harness" ? "active" : ""}`}
            onClick={() => setActiveTab("harness")}
          >
            Small-Model Harness
          </button>
        </div>

        <div className="orch-body">
          {/* TAB 1: MODEL TIERS */}
          {activeTab === "activity" && <RoutingActivity events={activityEvents} />}

          {activeTab === "tiers" && (
            <div className="orch-pane">
              <div className="orch-banner">
                <b>Strict model policy</b>: every routable model is <b>≤80B total parameters</b>, enforced as a router startup invariant — the router refuses to boot on an over-cap entry, and models whose size cannot be verified are excluded rather than admitted. The tiers below are read live from the router catalog.
              </div>

              <div className="tier-cards-grid">
                {/* Tier cards are rendered from the LIVE router catalog.
                    They used to be hardcoded, and had drifted badly: the chips
                    listed deepseek-coder-v2-lite, mistral-small-24b and
                    llama-3.3-70b-versatile — none of which are routable, and
                    llama-3.3-70b now returns 410 Gone (end-of-life). A panel
                    whose whole purpose is to explain routing must not invent
                    the models it claims to route to. */}
                {(["S", "M", "L"] as const).map((tier) => {
                  const models = routerStatus?.tiers?.[tier] ?? [];
                  const meta = tier === "S"
                    ? { label: "Tier S · Fast path", desc: "Greetings, trivial asks, and read-only exploration." }
                    : tier === "M"
                      ? { label: "Tier M · Coder & Explorer", desc: "Implementation, retrieval, and tool use." }
                      : { label: "Tier L · Planner & Reviewer", desc: "Decomposition, dependency graphs, and adversarial review." };
                  return (
                    <div key={tier} className={`tier-card tier-${tier.toLowerCase()}`}>
                      <div className={`tier-badge badge-${tier.toLowerCase()}`}>{meta.label}</div>
                      <div className="tier-desc">{meta.desc}</div>
                      <div className="tier-models-list">
                        {models.length > 0 ? (
                          models.map((m) => (
                            <span key={`${m.provider}:${m.model}`} className="model-chip">
                              {m.model} ({m.param_b}B) · {m.provider}
                            </span>
                          ))
                        ) : (
                          <span className="dim tiny-text">
                            {routerStatus ? "no models catalogued for this tier" : "loading from router…"}
                          </span>
                        )}
                      </div>
                      <div className="tier-meta mono">
                        every entry enforced &le;80B total params at router startup
                      </div>
                    </div>
                  );
                })}
              </div>

              {routerStatus && (
                <div className="provider-health-box">
                  <h4>Upstream Gateway Status</h4>
                  <div className="gateway-row">
                    {Object.entries(routerStatus.providers || {}).map(([pName, active]) => (
                      <span key={pName} className={`gw-pill ${active ? "up" : "down"}`}>
                        <span className="gw-dot" /> {pName}: {active ? "Active" : "Offline / Cooling"}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: DAG & ACCESS TOPOLOGY */}
          {activeTab === "dag" && (
            <div className="orch-pane">
              <h4>Active Task Information Topology</h4>
              {task?.plan && task.plan.length > 0 ? (
                <div className="dag-steps-view">
                  {task.plan.map((step, idx) => (
                    <div key={step.id || idx} className={`dag-step-row ${step.status === "done" ? "is-done" : ""}`}>
                      <div className="dag-step-header">
                        <span className="dag-step-id mono">{step.id}</span>
                        <span className="dag-step-title">{step.title}</span>
                        <span className={`dag-status-tag ${step.status || "pending"}`}>{step.status || "pending"}</span>
                      </div>
                      <div className="dag-step-detail dim">{step.detail}</div>
                      <div className="dag-topology-pills">
                        {step.dependsOn && step.dependsOn.length > 0 && (
                          <span className="topo-pill dep" title="Execution order: cannot run until these finish">
                            ⏱ Depends on: {step.dependsOn.join(", ")}
                          </span>
                        )}
                        {step.accessList && step.accessList.length > 0 && (
                          <span className="topo-pill access" title="Information topology: only reads outputs from these steps">
                            Reads outputs of: {step.accessList.join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dag-empty-box dim">
                  No active multi-step DAG plan running. Start a coding task or run <code>/plan &lt;goal&gt;</code> to view live DAG orchestration.
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SMALL-MODEL HARNESS */}
          {activeTab === "harness" && (
            <div className="orch-pane">
              <h4>Small-Model Harness &amp; Orchestration</h4>
              <div className="harness-steps-list">
                <div className="harness-step">
                  <div className="hstep-num">1</div>
                  <div className="hstep-content">
                    <b>Intent triage &amp; fast path</b>: greetings and trivial asks skip the planner and the tool loop entirely — one small completion with no tools declared. Measured: &quot;Hello&quot; went from 2,557 tokens to 149, one LLM call.
                  </div>
                </div>
                <div className="harness-step">
                  <div className="hstep-num">2</div>
                  <div className="hstep-content">
                    <b>Reasoning separated from answers</b>: <code>reasoning_content</code> streams into its own collapsible box, never into the reply. Reasoning is no longer substituted for an empty answer — that mistake made the coder look like it had replied with prose when it had produced nothing.
                  </div>
                </div>
                <div className="harness-step">
                  <div className="hstep-num">3</div>
                  <div className="hstep-content">
                    <b>Live editor streaming</b>: file content is decoded incrementally from the write call — from either the text protocol or native tool-call arguments — and typed into Monaco as the model produces it, coalesced to ≤25 fps. The preview is read-only until the change is approved.
                  </div>
                </div>
                <div className="harness-step">
                  <div className="hstep-num">4</div>
                  <div className="hstep-content">
                    <b>Truncation gate &amp; independent audit</b>: a reply cut off at the token limit is discarded rather than written, and the model is asked for the work in smaller pieces. Every change is then checked by a zero-token auditor that reads the filesystem, not the coder&rsquo;s own diff.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
