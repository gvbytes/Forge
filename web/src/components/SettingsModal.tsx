// SettingsModal — MANDATORY (PS req #3): provider CRUD + API key storage +
// connection test, model registry (params_b ≤ 80 enforced), routing thresholds,
// budget defaults and approval mode. Draft is local; save goes to the backend.
import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import type { DiscoveredModel, ModelCfg, ProviderCfg, RouterStatus, SettingsDto } from "../lib/types";
import { useUi } from "../stores/ui";
import { ErrorBoundary } from "./ErrorBoundary";

type Tab = "forge_nim" | "providers" | "models" | "routing" | "budgets";

interface TestResult { ok: boolean; latency_ms: number; detail: string }

const TABS: { id: Tab; label: string }[] = [
  { id: "forge_nim", label: "4-Role NIM Pins" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "routing", label: "Routing" },
  { id: "budgets", label: "Budgets & Approvals" },
];

/** Agent roles the engine routes LLM calls for (engine/src/router.ts RouterRole).
 *  The user can pin a specific model to each role in the Routing tab. */
const ROLES: { key: "router" | "planner" | "coder" | "reviewer" | "explorer" | "summarizer"; label: string; desc: string; defaultPin: string }[] = [
  { key: "planner", label: "Planner", desc: "breaks the goal into steps (google/gemma-4-31b-it)", defaultPin: "google/gemma-4-31b-it" },
  { key: "coder", label: "Coder", desc: "writes and edits code (nvidia/nemotron-3.5-lightning-30b-a3b)", defaultPin: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  { key: "reviewer", label: "Reviewer", desc: "reviews proposed changes (meta/muse-glimmer-30b)", defaultPin: "meta/muse-glimmer-30b" },
  { key: "explorer", label: "Explorer", desc: "explores the codebase (openai/gpt-oss-20b)", defaultPin: "openai/gpt-oss-20b" },
  { key: "summarizer", label: "Summarizer", desc: "compacts context (openai/gpt-oss-20b)", defaultPin: "openai/gpt-oss-20b" },
  { key: "router", label: "Quick chat", desc: "the /bytheway assistant (openai/gpt-oss-20b)", defaultPin: "openai/gpt-oss-20b" },
];

const DEFAULT_SETTINGS_FALLBACK: SettingsDto = {
  providers: [
    { id: "engine-router", name: "Local Router", base_url: "http://127.0.0.1:4098/v1", api_key: "", enabled: true }
  ],
  models: [
    { key: "engine-small", provider_id: "engine-router", id: "openai/gpt-oss-20b", params_b: 20, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "tiny", notes: "Fast S-tier triage / explorer (≤80B)" },
    { key: "engine-coder", provider_id: "engine-router", id: "nvidia/nemotron-3.5-lightning-30b-a3b", params_b: 30, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "mid", notes: "Coder M-tier structured tool use (≤80B)" },
    { key: "engine-reviewer", provider_id: "engine-router", id: "meta/muse-glimmer-30b", params_b: 30, ctx_window: 128000, cost_in: 0, cost_out: 0, tier: "mid", notes: "Reviewer M-tier independent audit (≤80B)" },
    { key: "engine-large", provider_id: "engine-router", id: "google/gemma-4-31b-it", params_b: 31, ctx_window: 262144, cost_in: 0, cost_out: 0, tier: "large", notes: "Planner L-tier deep reasoning (≤80B)" },
  ],
  routing: { ctx_trigger_frac: 0.7, complexity_tiny_max: 0.25, complexity_mid_max: 0.65, min_health: 0.5 },
  budgets: { max_cost_usd: 0.50, max_wall_s: 2700, max_steps: 40, max_llm_calls: 80, max_parallel_subagents: 3 },
  approvals: { mode: "gate" },
  requireApprovalFor: ["write_file", "edit_file", "run_command", "git_commit", "git_branch"],
};

/** Every tool the engine can execute (engine/src/tools.ts) — gate-able list. */
const KNOWN_TOOLS = [
  "read_file", "read_range", "list_dir", "grep", "glob",
  "write_file", "edit_file", "run_command",
  "git_status", "git_diff", "git_commit", "git_branch",
  "web_search", "retrieve_code", "delegate", "finish",
];

/**
 * Active upstream providers: NVIDIA NIM (sole text provider, 3 keys = 120 RPM)
 * and Groq (speech-to-text / Whisper only).
 */
const PROVIDER_PRESETS: { id: string; name: string; base_url: string; note: string }[] = [
  { id: "nvidia-nim", name: "NVIDIA NIM", base_url: "https://integrate.api.nvidia.com/v1", note: "Sole text provider (3 accounts = independent 40 RPM quotas) — key: build.nvidia.com" },
  { id: "groq", name: "Groq (ASR)", base_url: "https://api.groq.com/openai/v1", note: "Transcription only (whisper-large-v3) — key: console.groq.com/keys" },
];

/** Agent roles a key can be pinned to, plus the shared pool. */
const KEY_SLOTS = ["default", "planner", "coder", "reviewer", "explorer", "summarizer"] as const;

/**
 * Multiple API keys per provider, pinned per agent role.
 *
 * Free tiers meter per ACCOUNT, so one key caps the whole agent at a single
 * account's rate limit — a busy planner starves the coder. Holding several
 * keys for the same provider and pinning roles across them multiplies that
 * ceiling: four NVIDIA NIM accounts give four times the credits. Roles with no
 * pin round-robin over the "default" pool rather than always hitting the first
 * key, so spare accounts are actually used instead of idling until the first
 * one rate-limits.
 */
function KeySlotsPanel({ toast }: { toast: (t: string, k?: "ok" | "err" | "info") => void }) {
  const [slots, setSlots] = useState<Record<string, { slot: string; last4: string }[]>>({});
  const [draft, setDraft] = useState<{ provider: string; slot: string; key: string }>({
    provider: "nvidia-nim", slot: "planner", key: "",
  });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.keySlots();
      setSlots(r.slots ?? {});
    } catch {
      /* router down — the panel just shows nothing */
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const add = async () => {
    if (!draft.key.trim()) { toast("paste a key first", "err"); return; }
    setBusy(true);
    try {
      await api.setKeySlot(draft.provider, draft.slot, draft.key.trim());
      setDraft((d) => ({ ...d, key: "" }));
      await refresh();
      toast(`${draft.provider} · ${draft.slot} key saved`, "ok");
    } catch (e) {
      toast(`could not save key: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally { setBusy(false); }
  };

  const remove = async (provider: string, slot: string) => {
    try {
      await api.deleteKeySlot(provider, slot);
      await refresh();
      toast(`${provider} · ${slot} removed`, "ok");
    } catch (e) {
      toast(`could not remove: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  return (
    <div className="ks-panel">
      <h3>API keys per role <span className="dim tiny-text">(several accounts per provider = several rate limits)</span></h3>
      <p className="dim tiny-text ks-note">
        A key pinned to a role is used only by that role. Keys on <code>default</code> are shared —
        unpinned roles rotate across them, so every account gets used instead of one being hammered.
      </p>

      <div className="ks-grid">
        {Object.entries(slots).length === 0 && (
          <div className="dim tiny-text">No keys stored yet.</div>
        )}
        {Object.entries(slots).map(([provider, list]) => (
          <div key={provider} className="ks-provider">
            <div className="ks-provider-head">
              <b>{provider}</b>
              <span className="chip">{list.length} key{list.length === 1 ? "" : "s"}</span>
            </div>
            {list.map((k) => (
              <div key={k.slot} className="ks-row">
                <span className={`ks-slot${k.slot === "default" ? " shared" : ""}`}>{k.slot}</span>
                <span className="ks-last4 mono">…{k.last4}</span>
                <button type="button" className="btn tiny danger" onClick={() => void remove(provider, k.slot)}>remove</button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="ks-add">
        <select value={draft.provider} onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}>
          {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={draft.slot} onChange={(e) => setDraft((d) => ({ ...d, slot: e.target.value }))}>
          {KEY_SLOTS.map((sl) => <option key={sl} value={sl}>{sl === "default" ? "default (shared pool)" : sl}</option>)}
        </select>
        <input
          type="password"
          placeholder="paste API key"
          value={draft.key}
          onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
        />
        <button type="button" className="btn primary" disabled={busy} onClick={() => void add()}>Add key</button>
      </div>
    </div>
  );
}

function ForgeNimPanel({ toast, modelOptions }: { toast: (t: string, k?: "ok" | "err" | "info") => void; modelOptions: { id: string; provider: string }[] }) {
  const [keySlots, setKeySlots] = useState<Record<string, { slot: string; last4: string }[]>>({});
  const [, setRolePins] = useState<Record<string, string>>({});
  const [keysInput, setKeysInput] = useState<{ planner: string; coder: string; critic: string; router: string }>({
    planner: "", coder: "", critic: "", router: ""
  });
  const [modelsInput, setModelsInput] = useState<{ planner: string; coder: string; critic: string; router: string }>({
    planner: "google/gemma-4-31b-it",
    coder: "nvidia/nemotron-3.5-lightning-30b-a3b",
    critic: "meta/muse-glimmer-30b",
    router: "openai/gpt-oss-20b",
  });
  const [probes, setProbes] = useState<Record<string, { ok: boolean; latency: number; msg: string } | null>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [k, p] = await Promise.all([api.keySlots(), api.rolePins()]);
      setKeySlots(k.slots ?? {});
      if (p.pins) {
        setRolePins(p.pins);
        setModelsInput((m) => ({
          planner: p.pins.planner || m.planner,
          coder: p.pins.coder || m.coder,
          critic: p.pins.critic || p.pins.reviewer || m.critic,
          router: p.pins.router || p.pins.triage || m.router,
        }));
      }
    } catch {}
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const nimSlots = keySlots["nvidia-nim"] || [];
  const getSlotLast4 = (slotName: string) => {
    const s = nimSlots.find((x) => x.slot === slotName);
    return s ? s.last4 : null;
  };

  const saveRoleKey = async (slot: "planner" | "coder" | "critic" | "router") => {
    const val = keysInput[slot].trim();
    if (!val) { toast(`Please enter an API key for ${slot}`, "err"); return; }
    try {
      await api.setKeySlot("nvidia-nim", slot, val);
      if (slot === "critic") {
        await api.setKeySlot("nvidia-nim", "reviewer", val).catch(() => {});
      }
      setKeysInput((k) => ({ ...k, [slot]: "" }));
      await refresh();
      toast(`NVIDIA NIM key for ${slot} saved securely`, "ok");
    } catch (e) {
      toast(`Failed to save ${slot} key: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  const saveRoleModel = async (role: "planner" | "coder" | "critic" | "router", model: string) => {
    try {
      await api.setRolePin(role, model);
      if (role === "critic") {
        await api.setRolePin("reviewer", model).catch(() => {});
      }
      await refresh();
      toast(`Pinned ${role} to ${model}`, "ok");
    } catch (e) {
      toast(`Failed to pin ${role}: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  const testRole = async (role: "planner" | "coder" | "critic" | "router") => {
    setProbes((p) => ({ ...p, [role]: { ok: false, latency: 0, msg: "probing..." } }));
    const t0 = Date.now();
    try {
      const targetModel = modelsInput[role] || (
        role === "planner" ? "google/gemma-4-31b-it" :
        role === "coder" ? "nvidia/nemotron-3.5-lightning-30b-a3b" :
        role === "critic" ? "meta/muse-glimmer-30b" : "openai/gpt-oss-20b"
      );
      const res = await fetch("http://127.0.0.1:4098/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-role": role === "critic" ? "reviewer" : role,
          "Origin": "http://localhost:4444",
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      });
      const elapsed = Date.now() - t0;
      if (res.ok) {
        setProbes((p) => ({ ...p, [role]: { ok: true, latency: elapsed, msg: `200 OK (${elapsed}ms)` } }));
      } else {
        const err = await res.text();
        setProbes((p) => ({ ...p, [role]: { ok: false, latency: elapsed, msg: `HTTP ${res.status}: ${err.slice(0, 80)}` } }));
      }
    } catch (e) {
      setProbes((p) => ({ ...p, [role]: { ok: false, latency: Date.now() - t0, msg: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      for (const r of ["planner", "coder", "critic", "router"] as const) {
        if (keysInput[r].trim()) {
          await api.setKeySlot("nvidia-nim", r, keysInput[r].trim());
          if (r === "critic") await api.setKeySlot("nvidia-nim", "reviewer", keysInput[r].trim()).catch(() => {});
        }
        await api.setRolePin(r, modelsInput[r]);
        if (r === "critic") await api.setRolePin("reviewer", modelsInput[r]).catch(() => {});
      }
      setKeysInput({ planner: "", coder: "", critic: "", router: "" });
      await refresh();
      toast("4-Role NIM Architecture applied & pinned successfully!", "ok");
    } catch (e) {
      toast(`Failed to apply settings: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const rolesMeta = [
    { key: "planner" as const, name: "Role 1: Conductor / Planner", desc: "Heavy reasoning (AIME 89.2%, LCB 80.0%). Decomposes goals into DAG steps; runs once per task." },
    { key: "coder" as const, name: "Role 2: Primary Coder", desc: "RL-trained on multi-step tool use, code edits, and live Monaco editor streaming." },
    { key: "critic" as const, name: "Role 3: Reviewer / Verifier", desc: "Independent Meta lineage verifier (MCP-Atlas 75.5%). Eliminates coder self-review blind spots." },
    { key: "router" as const, name: "Role 4: Triage & Fast Scout", desc: "Sub-second triage (~440ms), /bytheway spot answers, context summarization & symbol searches." },
  ];

  const CANONICAL_NIM_MODELS = [
    { id: "google/gemma-4-31b-it", label: "google/gemma-4-31b-it (31B · NVIDIA NIM - Planner default)" },
    { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "nvidia/nemotron-3.5-lightning-30b-a3b (30B · NVIDIA NIM - Coder default)" },
    { id: "meta/muse-glimmer-30b", label: "meta/muse-glimmer-30b (30B · NVIDIA NIM - Reviewer default)" },
    { id: "openai/gpt-oss-20b", label: "openai/gpt-oss-20b (20B · NVIDIA NIM - Triage default)" },
    { id: "meta/llama-3.2-11b-vision-instruct", label: "meta/llama-3.2-11b-vision-instruct (11B · NVIDIA NIM - Vision)" },
  ];

  return (
    <div className="tab-body-col forge-nim-container" style={{ gap: 16 }}>
      <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div>
            <h3 style={{ margin: 0, color: "#d19a3e" }}>4-Role NVIDIA NIM Architecture (≤80B Params)</h3>
            <p className="dim tiny-text" style={{ margin: "4px 0 0" }}>
              Isolates the 4 specialized agent roles across independent model endpoints and rate limits. 3 NIM accounts provide independent 40 RPM quotas (120 RPM total pool). Keys stored locally in <code>router.db</code>.
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {rolesMeta.map((r) => {
          const last4 = getSlotLast4(r.key);
          const probe = probes[r.key];
          return (
            <div key={r.key} style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ color: "#e6edf3", fontSize: 13 }}>{r.name}</strong>
                {last4 ? (
                  <span className="chip ok" style={{ fontSize: 11 }}>✓ Key Stored (…{last4})</span>
                ) : (
                  <span className="chip warn" style={{ fontSize: 11 }}>— No key (reads $env)</span>
                )}
              </div>
              <p className="dim tiny-text" style={{ margin: 0, minHeight: 32 }}>{r.desc}</p>
              
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label className="tiny-text dim">Assigned Model (≤80B):</label>
                <select
                  className="mono"
                  style={{ width: "100%", padding: "4px 8px", background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4 }}
                  value={modelsInput[r.key]}
                  onChange={(e) => {
                    const val = e.target.value;
                    setModelsInput((m) => ({ ...m, [r.key]: val }));
                    void saveRoleModel(r.key, val);
                  }}
                >
                  {CANONICAL_NIM_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                  {modelOptions.filter((o) => !CANONICAL_NIM_MODELS.some((cm) => cm.id === o.id)).map((o) => (
                    <option key={o.id} value={o.id}>{o.id} · {o.provider}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label className="tiny-text dim">Dedicated NVIDIA NIM API Key:</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="password"
                    className="mono"
                    style={{ flex: 1, padding: "4px 8px", background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4 }}
                    placeholder={last4 ? "•••••••••••• (leave blank to keep)" : "nvapi-..."}
                    value={keysInput[r.key]}
                    onChange={(e) => setKeysInput((k) => ({ ...k, [r.key]: e.target.value }))}
                  />
                  <button type="button" className="btn tiny" onClick={() => void saveRoleKey(r.key)}>Save</button>
                  <button type="button" className="btn tiny ghost" onClick={() => void testRole(r.key)} title="Test connection">Test</button>
                </div>
                {probe && (
                  <span className={`tiny-text chip ${probe.ok ? "ok" : "err"}`} style={{ alignSelf: "flex-start", marginTop: 2 }}>
                    {probe.msg}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #30363d", paddingTop: 12 }}>
        <span className="dim tiny-text">
          Multi-key architecture isolates rate limits so high concurrency in code generation never blocks the planner or reviewer.
        </span>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void applyAll()}>
          {busy ? "Applying..." : "✓ Apply & Pin 4-Role Architecture"}
        </button>
      </div>
    </div>
  );
}

/** A discovered model is free when both in/out costs are zero. */
function isFreeModel(m: DiscoveredModel): boolean {
  return (m.costInPerM ?? 0) === 0 && (m.costOutPerM ?? 0) === 0;
}
/** Key-gated = the engine tagged it "needs-key" (its upstream provider has no API
 *  key configured) or it is disabled — it cannot be called until a key is added. */
function isKeyGated(m: DiscoveredModel): boolean {
  return (m.tags || []).includes("needs-key") || m.enabled === false;
}

function DiscoveredTable({ rows, dim }: { rows: DiscoveredModel[]; dim?: boolean }) {
  return (
    <table className="settings-table models" style={{ marginTop: 6 }}>
      <thead>
        <tr><th>id</th><th>provider</th><th>ctx</th><th>tags</th></tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={`disc-${m.id}`} style={{ opacity: dim || m.enabled === false ? 0.55 : 1 }}>
            <td className="mono">{m.id}</td>
            <td>{m.provider}</td>
            <td className="mono">{m.ctxWindow ? `${Math.round(m.ctxWindow / 1000)}k` : "—"}</td>
            <td className="tiny-text">{(m.tags || []).filter((t) => t !== "needs-key").join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsContent() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setOpen]);
  const toast = useUi((s) => s.toast);

  /** Read the router's live free-tier lock state. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.freeTier();
        if (!cancelled) setFreeTierOnly(r.free_tier_only);
      } catch {
        // Router not up yet — keep the safe default (locked) rather than
        // showing the checkbox off and implying paid routing is allowed.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Flip the lock. Applies immediately — no Save needed, it is router state. */
  const setFreeTier = async (on: boolean): Promise<void> => {
    const prev = freeTierOnly;
    setFreeTierOnly(on); // optimistic
    try {
      const r = await api.setFreeTier(on);
      setFreeTierOnly(r.free_tier_only);
      toast(r.free_tier_only ? "free-tier lock ON — priced models excluded" : "free-tier lock OFF — paid models allowed", r.free_tier_only ? "ok" : "info");
    } catch (e) {
      setFreeTierOnly(prev); // roll back so the UI never lies about the policy
      toast(`could not reach router: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  const [draft, setDraft] = useState<SettingsDto>(DEFAULT_SETTINGS_FALLBACK);
  const [saved, setSaved] = useState<SettingsDto>(DEFAULT_SETTINGS_FALLBACK);
  const [tab, setTab] = useState<Tab>("providers");
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [saving, setSaving] = useState(false);
  // F1: Save must stay disabled until GET /api/settings has resolved. Before that
  // the draft is only the fallback doc, and saving it would PUT a bogus provider
  // over the real server settings.
  const [loaded, setLoaded] = useState(false);
  // Free-tier lock lives in the ROUTER (it is a routing policy, not an engine
  // setting), so it is read and written directly against the router rather than
  // riding the settings PUT. Defaults to locked, matching the router's own default.
  const [freeTierOnly, setFreeTierOnly] = useState(true);
  // F7: models the engine discovered from provider /models endpoints (read-only).
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  // Transparency: the local router's live introspection (policy, tiers, provider
  // health/key/rate-limit state) so it is not a black box.
  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab("providers");
    setTests({});
    setLoaded(false);
    api.getSettings()
      .then((s: any) => {
        const normalized: SettingsDto = {
          providers: Array.isArray(s?.providers) ? s.providers : DEFAULT_SETTINGS_FALLBACK.providers,
          models: Array.isArray(s?.models) ? s.models : DEFAULT_SETTINGS_FALLBACK.models,
          routing: s?.routing || DEFAULT_SETTINGS_FALLBACK.routing,
          budgets: s?.budgets || DEFAULT_SETTINGS_FALLBACK.budgets,
          // B7: engine contract is { mode: "gate" | "auto" | "optimistic" }, default
          // "optimistic" (wave 26). Tolerate legacy spellings ("auto_safe"/"paranoid").
          // Engine default is "gate" (PS 8b): only an EXPLICIT optimistic/auto
          // value may relax it, so an absent/unknown mode lands on the safe one.
          approvals: { mode: s?.approvals?.mode === "auto" || s?.approvals?.mode === "auto_safe" ? "auto" : s?.approvals?.mode === "optimistic" ? "optimistic" : "gate" },
          requireApprovalFor: Array.isArray(s?.requireApprovalFor) && s.requireApprovalFor.length
            ? s.requireApprovalFor.filter((x: unknown): x is string => typeof x === "string")
            : DEFAULT_SETTINGS_FALLBACK.requireApprovalFor,
          // Per-role model pins + disabled models. Preserve whatever the engine
          // has so the Routing tab can edit it and save() round-trips it instead
          // of silently wiping it on the next PUT.
          selectedModels: (s?.selectedModels && typeof s.selectedModels === "object") ? s.selectedModels : {},
          disabledModels: Array.isArray(s?.disabledModels) ? s.disabledModels.filter((x: unknown): x is string => typeof x === "string") : [],
        };
        setSaved(structuredClone(normalized));
        setDraft(structuredClone(normalized));
        setLoaded(true);
        // F7: pull the engine's discovered models for the read-only list.
        api.models().then((ms) => setDiscovered(ms)).catch(() => setDiscovered([]));
        // Transparency: pull the local router's live status (de-blackbox).
        api.routerStatus().then((rs) => setRouterStatus(rs)).catch(() => setRouterStatus({ reachable: false }));
      })
      .catch((e) => {
        toast(`Load settings failed: ${String(e)}`, "err");
        // F1: do NOT seed the draft with the fallback doc on failure — saving it
        // would PUT a fake provider/key over the real settings. Leave loaded=false
        // so Save stays disabled until a real GET succeeds.
        setLoaded(false);
      });
  }, [open, toast]);

  if (!open) return null;

  const upd = (patch: Partial<SettingsDto>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const updProvider = (i: number, patch: Partial<ProviderCfg>) =>
    setDraft((d) => ({ ...d, providers: (d.providers || []).map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const updModel = (i: number, patch: Partial<ModelCfg>) =>
    setDraft((d) => ({ ...d, models: (d.models || []).map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  // ---- per-role model control (Routing tab) ------------------------------
  // Options = canonical NIM models ∪ verified registry models (deduped).
  // Excludes random unverified models from raw upstream discovery.
  const modelOptions: { id: string; provider: string }[] = (() => {
    const seen = new Set<string>();
    const opts: { id: string; provider: string }[] = [];
    const CANONICAL_NIM_MODELS = [
      { id: "google/gemma-4-31b-it", provider: "nvidia-nim" },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", provider: "nvidia-nim" },
      { id: "meta/muse-glimmer-30b", provider: "nvidia-nim" },
      { id: "openai/gpt-oss-20b", provider: "nvidia-nim" },
      { id: "meta/llama-3.2-11b-vision-instruct", provider: "nvidia-nim" },
    ];
    for (const m of CANONICAL_NIM_MODELS) {
      if (!seen.has(m.id)) { seen.add(m.id); opts.push(m); }
    }
    for (const m of draft.models || []) {
      if (m.id && !seen.has(m.id) && !m.id.startsWith("engine/")) {
        seen.add(m.id);
        opts.push({ id: m.id, provider: m.provider_id || "registry" });
      }
    }
    return opts;
  })();
  const updRole = (role: string, modelId: string) =>
    setDraft((d) => {
      const sel = { ...(d.selectedModels || {}) };
      if (modelId) sel[role] = modelId; else delete sel[role];
      return { ...d, selectedModels: sel };
    });
  const toggleDisabled = (id: string) =>
    setDraft((d) => {
      const cur = new Set(d.disabledModels || []);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      return { ...d, disabledModels: [...cur] };
    });

  // One-click add a known provider from a preset (pre-fills name + base_url; the
  // engine's discovery auto-lists its models once a key is set and it is saved).
  const addFromPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      providers: [
        ...d.providers,
        { id: `${preset.id}-${crypto.randomUUID().slice(0, 4)}`, name: preset.name, base_url: preset.base_url, api_key: "", enabled: true },
      ],
    }));
  };

  // ---- validation -------------------------------------------------------
  const badParams = new Set<number>();
  (draft.models || []).forEach((m, i) => {
    if (!(m.params_b > 0 && m.params_b <= 80)) badParams.add(i);
  });
  const dupKeys = new Set<string>();
  const seenKeys = new Set<string>();
  (draft.models || []).forEach((m) => {
    if (!m.key?.trim()) return;
    if (seenKeys.has(m.key)) dupKeys.add(m.key);
    seenKeys.add(m.key);
  });
  // F6: providers need a non-empty unique id and, when set, a parseable http(s)
  // base_url. Clearing id/name used to create a phantom the backend rebaptized
  // "engine-router", colliding with the real router and cross-matching keys.
  const seenProvIds = new Set<string>();
  let providersValid = true;
  (draft.providers || []).forEach((p) => {
    const id = (p.id || "").trim();
    if (!id || seenProvIds.has(id)) providersValid = false;
    seenProvIds.add(id);
    if (p.base_url) {
      try {
        const u = new URL(p.base_url);
        if (u.protocol !== "http:" && u.protocol !== "https:") providersValid = false;
      } catch {
        providersValid = false;
      }
    }
  });
  const valid = badParams.size === 0 && providersValid;

  const save = async () => {
    if (!valid || !loaded) return;
    setSaving(true);
    try {
      await api.saveSettings(draft);
      toast("Settings saved", "ok");
      setOpen(false);
    } catch (e) {
      toast(`Save failed: ${String(e)}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const testOne = async (p: ProviderCfg) => {
    setTests((t) => ({ ...t, [p.id]: { ok: false, latency_ms: 0, detail: "testing…" } }));
    try {
      const res = await api.testProvider(p.id, p);
      setTests((t) => ({ ...t, [p.id]: res }));
      if (res.ok) toast(`${p.name || p.id}: ${res.detail}`, "ok");
      else toast(`${p.name || p.id} failed: ${res.detail}`, "err");
    } catch (e) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, latency_ms: 0, detail: String(e).slice(0, 120) } }));
      toast(`Test error: ${String(e)}`, "err");
    }
  };

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Settings</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>✕</button>
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "forge_nim" ? (
          <ForgeNimPanel toast={toast} modelOptions={modelOptions} />
        ) : tab === "providers" ? (
          <div className="tab-body-col">
            <table className="settings-table">
              <thead>
                <tr><th>id</th><th>name</th><th>base url</th><th>api key</th><th>enabled</th><th>test</th><th /></tr>
              </thead>
              <tbody>
                {(draft.providers || []).map((p, i) => (
                  <tr key={p.id || i}>
                    <td><input className="mono" value={p.id} onChange={(e) => updProvider(i, { id: e.target.value })} /></td>
                    <td><input value={p.name} placeholder="e.g. OpenAI" onChange={(e) => updProvider(i, { name: e.target.value })} /></td>
                    <td><input className="mono wide" value={p.base_url} placeholder="https://…" onChange={(e) => updProvider(i, { base_url: e.target.value, ...(p.api_key?.startsWith("••") ? { api_key: "" } : {}) })} /></td>
                    <td>
                      <input
                        type="password"
                        className="mono"
                        value={p.api_key}
                        placeholder="sk-…"
                        onChange={(e) => updProvider(i, { api_key: e.target.value })}
                        autoComplete="new-password"
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={p.enabled !== false}
                        onChange={(e) => updProvider(i, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn tiny"
                        disabled={!p.base_url}
                        onClick={() => void testOne(p)}
                      >
                        test
                      </button>
                      {tests[p.id] && (
                        <span className={`tiny-text chip ${tests[p.id].ok ? "ok" : "err"}`} style={{ marginLeft: 6 }}>
                          {tests[p.id].latency_ms > 0 ? `${tests[p.id].latency_ms}ms` : tests[p.id].ok ? "ok" : "err"}
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn tiny danger"
                        aria-label={`remove provider ${p.id}`}
                        onClick={() => upd({ providers: draft.providers.filter((_, j) => j !== i) })}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-gap" style={{ alignItems: "center" }}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  upd({
                    providers: [
                      ...draft.providers,
                      { id: `provider-${crypto.randomUUID().slice(0, 8)}`, name: "", base_url: "", api_key: "", enabled: true },
                    ],
                  })
                }
              >
                ＋ Add provider
              </button>
              <select
                className="mono"
                value=""
                aria-label="add a known provider from a preset"
                onChange={(e) => { if (e.target.value) addFromPreset(e.target.value); }}
              >
                <option value="">＋ Add known provider…</option>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id} title={p.note}>{p.name} — {p.note}</option>
                ))}
              </select>
            </div>

            {/* De-blackbox: Full transparent live view of Local Router's upstream providers and keys */}
            <div className="local-router-transparency" style={{ marginTop: 20, borderTop: "1px solid #30363d", paddingTop: 14 }}>
              <div className="row-gap" style={{ alignItems: "center", marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>Local Router (127.0.0.1:4098) — Upstream Key & Health Inventory</h3>
                <span className="spacer" />
                <span className={`chip ${routerStatus?.reachable ? "ok" : "err"}`} style={{ fontSize: 11 }}>
                  {routerStatus?.reachable ? "● Online (127.0.0.1:4098)" : "● Offline"}
                </span>
              </div>
              <p className="dim tiny-text" style={{ margin: "4px 0 8px 0" }}>
                When the agent uses <strong>Local Router (Gateway)</strong>, requests are automatically routed across these upstream providers based on tier &amp; live health. Keys are read from local <code>router.db</code> or environment variables. Zero external telemetry.
              </p>
              {routerStatus?.providers && routerStatus.providers.length > 0 ? (
                <table className="settings-table" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>Upstream Provider</th>
                      <th>Target Endpoint</th>
                      <th>Key in Local Vault</th>
                      <th>Health</th>
                      <th>Seeded Models (≤80B)</th>
                      <th>Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routerStatus.providers.map((p) => {
                      const keyMeta = routerStatus.keys?.providers?.[p.id];
                      const isSet = p.key_configured || Boolean(keyMeta?.set);
                      return (
                        <tr key={`router-prov-${p.id}`}>
                          <td><strong className="mono">{p.id}</strong></td>
                          <td className="tiny-text mono dim">{p.baseURL}</td>
                          <td>
                            {isSet ? (
                              <span className="ok-text mono tiny-text">✓ Set {keyMeta?.last4 ? `(…${keyMeta.last4})` : ""}</span>
                            ) : (
                              <span className="dim tiny-text mono">— None (reads $env fallback)</span>
                            )}
                          </td>
                          <td>
                            <span className={`tiny-text chip ${p.healthy ? "ok" : "err"}`}>
                              {p.healthy ? "✓ healthy" : "✕ down"}
                            </span>
                          </td>
                          <td className="tiny-text">{p.models_seeded} models</td>
                          <td className="tiny-text dim mono">{p.rpm_last_minute} rpm · {p.consecutive_429} 429s</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="dim tiny-text">Router status not available</div>
              )}

              {routerStatus?.tiers && (
                <div style={{ marginTop: 10, background: "#161b22", padding: "8px 12px", borderRadius: 6 }}>
                  <strong className="tiny-text">Active Tier Routing (≤80B parameters):</strong>
                  {(["S", "M", "L"] as const).map((tier) => (
                    <div key={`tier-${tier}`} className="tiny-text" style={{ marginTop: 4 }}>
                      <span className="mono" style={{ color: "#d19a3e" }}>Tier {tier}: </span>
                      <span className="dim">
                        {(routerStatus.tiers![tier] || []).map((m) => `${m.model} (${m.param_b}B @ ${m.provider})`).join(", ") || "(none)"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : tab === "models" ? (
          <div className="tab-body-col">
            <table className="settings-table models">
              <thead>
                <tr><th>key</th><th>provider</th><th>remote id</th><th>params_b ≤80</th><th>ctx</th><th>$in/Mtok</th><th>$out/Mtok</th><th>tier</th><th /></tr>
              </thead>
              <tbody>
                {(draft.models || []).map((m, i) => (
                  <tr key={`${m.key}-${i}`} className={badParams.has(i) ? "row-bad" : ""}>
                    <td><input className="mono" value={m.key} title={dupKeys.has(m.key) ? "duplicate key!" : m.notes ?? ""} onChange={(e) => updModel(i, { key: e.target.value })} spellCheck={false} /></td>
                    <td>
                      <select value={m.provider_id} onChange={(e) => updModel(i, { provider_id: e.target.value })}>
                        <option value="">—</option>
                        {(draft.providers || []).map((p) => (
                          <option key={p.id} value={p.id}>{p.id}</option>
                        ))}
                      </select>
                    </td>
                    <td><input className="mono wide" value={m.id} onChange={(e) => updModel(i, { id: e.target.value })} spellCheck={false} /></td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        className={`mono${badParams.has(i) ? " invalid" : ""}`}
                        value={m.params_b}
                        onChange={(e) => updModel(i, { params_b: Number(e.target.value) })}
                      />
                      {badParams.has(i) && <div className="field-err">must be &gt;0 and ≤ 80</div>}
                    </td>
                    <td><input type="number" className="mono" min={0} step={1024} value={m.ctx_window} onChange={(e) => updModel(i, { ctx_window: Number(e.target.value) })} /></td>
                    <td><input type="number" className="mono narrow" min={0} step={0.01} value={m.cost_in} onChange={(e) => updModel(i, { cost_in: Number(e.target.value) })} /></td>
                    <td><input type="number" className="mono narrow" min={0} step={0.01} value={m.cost_out} onChange={(e) => updModel(i, { cost_out: Number(e.target.value) })} /></td>
                    <td>
                      <select value={m.tier} onChange={(e) => updModel(i, { tier: e.target.value as ModelCfg["tier"] })}>
                        <option value="tiny">tiny</option>
                        <option value="mid">mid</option>
                        <option value="large">large</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn tiny danger"
                        aria-label={`remove model ${m.key}`}
                        onClick={() => upd({ models: draft.models.filter((_, j) => j !== i) })}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-gap">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  upd({
                    models: [
                      ...draft.models,
                      { key: "", provider_id: draft.providers[0]?.id ?? "", id: "", params_b: 7, ctx_window: 32768, cost_in: 0, cost_out: 0, tier: "tiny" },
                    ],
                  })
                }
              >
                ＋ Add model
              </button>
              {dupKeys.size > 0 && <span className="warn-text tiny-text">duplicate model keys: {[...dupKeys].join(", ")}</span>}
              {badParams.size > 0 && <span className="err-text tiny-text">all registry models must satisfy params_b ≤ 80 (SPEC §4)</span>}
            </div>

            {/* F7: models the engine discovered from provider /models endpoints. */}
            <div className="discovered-models" style={{ marginTop: 14 }}>
              <div className="row-gap" style={{ alignItems: "center" }}>
                <strong className="tiny-text">Discovered models ({discovered.length})</strong>
                <span className="dim tiny-text">live from provider /models — read-only</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn tiny"
                  disabled={discovering}
                  onClick={() => {
                    setDiscovering(true);
                    api.refreshModels().then((ms) => setDiscovered(ms)).catch(() => {}).finally(() => setDiscovering(false));
                  }}
                >
                  {discovering ? "refreshing…" : "↻ refresh"}
                </button>
              </div>
              {discovered.length === 0 ? (
                <div className="dim tiny-text" style={{ marginTop: 6 }}>none discovered yet — add a provider, then refresh</div>
              ) : (() => {
                const VERIFIED_IDS = new Set([
                  "google/gemma-4-31b-it",
                  "nvidia/nemotron-3.5-lightning-30b-a3b",
                  "meta/muse-glimmer-30b",
                  "openai/gpt-oss-20b",
                  "meta/llama-3.2-11b-vision-instruct",
                  "engine/small",
                  "engine/medium",
                  "engine/large",
                  "whisper-large-v3",
                ]);
                const curated = discovered.filter((m) => VERIFIED_IDS.has(m.id));
                const freeReady = curated.filter((m) => !isKeyGated(m) && isFreeModel(m));
                const paidReady = curated.filter((m) => !isKeyGated(m) && !isFreeModel(m));
                const keyGated = curated.filter(isKeyGated);
                return (
                  <>
                    {freeReady.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <h4 style={{ margin: "4px 0" }}>
                          ✓ Active Models <span className="dim tiny-text">({freeReady.length}) — enabled by default</span>
                        </h4>
                        <DiscoveredTable rows={freeReady} />
                      </div>
                    )}
                    {paidReady.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <h4 style={{ margin: "4px 0" }}>
                          Ready <span className="dim tiny-text">({paidReady.length})</span>
                        </h4>
                        <DiscoveredTable rows={paidReady} />
                      </div>
                    )}
                    {keyGated.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <h4 style={{ margin: "4px 0" }}>
                          Need an API key <span className="dim tiny-text">({keyGated.length}) — add the provider’s key to use these</span>
                        </h4>
                        <DiscoveredTable rows={keyGated} dim />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ) : tab === "routing" ? (
          <div className="tab-body-col">
            <h3>Model per agent role</h3>
            <p className="dim tiny-text">
              Pick which model each agent role uses. “Auto” lets the router choose by
              complexity, cost and health. A pinned model is used directly and falls back
              to Auto only if it errors.
            </p>
            <table className="settings-table">
              <thead>
                <tr><th>role</th><th>what it does</th><th>model</th></tr>
              </thead>
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r.key}>
                    <td><strong>{r.label}</strong></td>
                    <td className="tiny-text dim">{r.desc}</td>
                    <td>
                      <select
                        className="mono"
                        value={(draft.selectedModels || {})[r.key] || ""}
                        onChange={(e) => updRole(r.key, e.target.value)}
                      >
                        <option value="">Auto (default: {r.defaultPin})</option>
                        {modelOptions.map((o) => (
                          <option key={o.id} value={o.id}>{o.id} · {o.provider}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style={{ marginTop: 16 }}>Model availability</h3>
            <p className="dim tiny-text">
              Switch a model OFF to exclude it from routing entirely — it is skipped even
              when its provider reports it healthy.
            </p>
            {modelOptions.length === 0 ? (
              <div className="dim tiny-text">no models yet — add a provider and refresh discovery</div>
            ) : (
              <div className="model-toggles" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {modelOptions.map((o) => {
                  const off = (draft.disabledModels || []).includes(o.id);
                  return (
                    <button
                      key={`tog-${o.id}`}
                      type="button"
                      className={`btn tiny${off ? " danger" : ""}`}
                      title={off ? "disabled — click to enable" : "enabled — click to disable"}
                      onClick={() => toggleDisabled(o.id)}
                    >
                      {off ? "✕ " : "✓ "}{o.id}
                    </button>
                  );
                })}
              </div>
            )}

            <h3 style={{ marginTop: 16 }}>Local Router — what it is</h3>
            <p className="dim tiny-text">
              The “Local Router” is a built-in routing proxy between the agents and every model
              provider. For each LLM call it weighs task complexity, context size, cost and live
              provider health to pick a model, then falls back automatically on errors or rate
              limits. This is its live state:
            </p>
            {routerStatus && !routerStatus.reachable ? (
              <div className="warn-text tiny-text" style={{ marginTop: 6 }}>
                router offline{routerStatus.routerRoot ? ` at ${routerStatus.routerRoot}` : ""}{routerStatus.error ? ` — ${routerStatus.error}` : ""}
              </div>
            ) : routerStatus && routerStatus.reachable ? (
              <div style={{ marginTop: 6 }}>
                <div className="tiny-text dim">routing policy: <span className="mono">{routerStatus.policy ?? "?"}</span></div>
                {(routerStatus.providers || []).length > 0 && (
                  <table className="settings-table" style={{ marginTop: 6 }}>
                    <thead>
                      <tr><th>provider</th><th>healthy</th><th>key</th><th>models</th><th>429s</th><th>5xx</th><th>rpm</th></tr>
                    </thead>
                    <tbody>
                      {(routerStatus.providers || []).map((p) => (
                        <tr key={`rp-${p.id}`}>
                          <td className="mono">{p.id}</td>
                          <td>{p.healthy ? "✓" : "✕"}</td>
                          <td>{p.key_configured ? "set" : "—"}</td>
                          <td className="mono">{p.models_seeded}</td>
                          <td className="mono">{p.consecutive_429}</td>
                          <td className="mono">{p.consecutive_5xx}</td>
                          <td className="mono">{p.rpm_last_minute}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {routerStatus.tiers && (["S", "M", "L"] as const).map((tier) => (
                  <div key={tier} className="tiny-text" style={{ marginTop: 6 }}>
                    <strong>Tier {tier}:</strong>{" "}
                    <span className="dim">
                      {(routerStatus.tiers![tier] || []).map((m) => `${m.provider}/${m.model}`).join(", ") || "(none)"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dim tiny-text" style={{ marginTop: 6 }}>loading router status…</div>
            )}
          </div>
        ) : (
          <div className="tab-body-col budgets-form">
            <h3>Budget defaults (per task)</h3>
            <div className="budget-grid mono">
              {(
                [
                  ["max_cost_usd", "max $ / task"],
                  ["max_wall_s", "max wall seconds"],
                  ["max_steps", "max steps"],
                  ["max_llm_calls", "max LLM calls"],
                  ["max_parallel_subagents", "parallel subagents"],
                ] as const
              ).map(([k, label]) => (
                <label key={k}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    step={k === "max_cost_usd" ? 0.05 : 1}
                    value={draft.budgets?.[k] ?? 0}
                    onChange={(e) => upd({ budgets: { ...draft.budgets, [k]: Number(e.target.value) } })}
                  />
                </label>
              ))}
            </div>

            <KeySlotsPanel toast={toast} />

            <h3>Cost policy</h3>
            <label className="checkbox-row" style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "4px 0 10px" }}>
              <input
                type="checkbox"
                checked={freeTierOnly}
                onChange={(e) => void setFreeTier(e.target.checked)}
              />
              <span>
                <b>Free-tier models only</b> (recommended)
                <div className="dim tiny-text" style={{ marginTop: 2, maxWidth: "56ch" }}>
                  The router will refuse to select any priced model, at every tier. One cent of
                  spend costs as much score as ~163 seconds of wall clock, so waiting out a rate
                  limit is almost always cheaper than paying. Turn this off only to deliberately
                  allow paid fallbacks.
                </div>
              </span>
            </label>

            <h3>Approvals mode</h3>
            <div className="radio-row" role="radiogroup" aria-label="approvals mode">
              <label>
                <input
                  type="radio"
                  name="approval-mode"
                  checked={(draft.approvals?.mode ?? "gate") === "gate"}
                  onChange={() => upd({ approvals: { mode: "gate" } })}
                />
                <b>gate</b> (default) — every side-effecting tool parks for a human approve/deny click. Required by the brief: writes, deletes, shell and git all wait for you.
              </label>
              <label>
                <input
                  type="radio"
                  name="approval-mode"
                  checked={(draft.approvals?.mode ?? "gate") === "auto"}
                  onChange={() => upd({ approvals: { mode: "auto" } })}
                />
                <b>auto</b> — run all tools without approval gates (trust the agent)
              </label>
              <label>
                <input
                  type="radio"
                  name="approval-mode"
                  checked={(draft.approvals?.mode ?? "gate") === "optimistic"}
                  onChange={() => upd({ approvals: { mode: "optimistic" } })}
                />
                <b>optimistic</b> — write files immediately (no blocking); every change is checkpointed so you can reject &amp; revert. Shell/git still gate.
              </label>
            </div>

            <h3>Gated tools <span className="dim tiny-text">(requireApprovalFor — extra tools to gate; write/edit stay ungated in optimistic)</span></h3>
            <div className="tool-gate-grid" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "4px 0 8px" }}>
              {[...new Set([...KNOWN_TOOLS, ...(draft.requireApprovalFor ?? [])])].map((tool) => {
                const gated = (draft.requireApprovalFor ?? []).includes(tool);
                return (
                  <label key={tool} className="mono tiny-text" style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={gated}
                      onChange={(e) => {
                        const cur = draft.requireApprovalFor ?? [];
                        upd({
                          requireApprovalFor: e.target.checked
                            ? [...cur, tool]
                            : cur.filter((t) => t !== tool),
                        });
                      }}
                    />
                    {tool}
                  </label>
                );
              })}
            </div>

            <h3>Routing thresholds</h3>
            <div className="budget-grid mono">
              {(
                [
                  ["ctx_trigger_frac", "compaction trigger (× ctx_window)"],
                  ["complexity_tiny_max", "classifier score → tiny ceiling"],
                  ["complexity_mid_max", "classifier score → mid ceiling"],
                  ["min_health", "min provider health EMA"],
                ] as const
              ).map(([k, label]) => (
                <label key={k}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.routing?.[k] ?? 0}
                    onChange={(e) => upd({ routing: { ...draft.routing, [k]: Number(e.target.value) } })}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="modal-foot">
          <span className="dim tiny-text">models ≤80B total params · free/pay-go/local (SPEC §0)</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={!valid || saving || !loaded} onClick={() => void save()}>
            {saving ? "Saving…" : !loaded ? "Loading…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsModal() {
  return (
    <ErrorBoundary>
      <SettingsContent />
    </ErrorBoundary>
  );
}
