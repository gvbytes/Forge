import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";

interface MemoryItem {
  id: string;
  category: "preference" | "convention" | "architecture" | "learned";
  text: string;
  createdAt: number;
  source?: string;
  active?: boolean;
}

interface FileRule {
  file: string;
  content: string;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  preference: { label: "User Preference", color: "#d19a3e" },
  convention: { label: "Coding Convention", color: "#b08968" },
  architecture: { label: "Architecture Fact", color: "#3fb950" },
  learned: { label: "Learned Lesson", color: "#d29922" },
};

export function MemoryPanel({ onClose }: { onClose?: () => void }) {
  const projectRoot = useUi((s) => s.projectRoot);
  const toast = useUi((s) => s.toast);

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [fileRules, setFileRules] = useState<FileRule[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // New item form state
  const [newCategory, setNewCategory] = useState<"preference" | "convention" | "architecture" | "learned">("preference");
  const [newText, setNewText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchMemory = async () => {
    setLoading(true);
    try {
      const res = await api.getMemory(projectRoot || undefined);
      if (res.ok && res.memory) {
        setItems(res.memory.items || []);
        setFileRules(res.fileRules || []);
      }
    } catch (e: any) {
      toast(`Failed to load memory: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchMemory();
  }, [projectRoot]);

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.addMemory(newCategory, newText.trim(), projectRoot || undefined);
      if (res.ok && res.item) {
        setItems((prev) => [res.item, ...prev]);
        setNewText("");
        toast("Memory saved into .agentzero/memory.json", "ok");
      }
    } catch (e: any) {
      toast(`Failed to add memory: ${e.message}`, "err");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    try {
      const updated = !currentActive;
      await api.updateMemory(id, { active: updated }, projectRoot || undefined);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, active: updated } : it)));
    } catch (e: any) {
      toast(`Failed to update memory: ${e.message}`, "err");
    }
  };

  const handleDeleteItem = async (id: string) => {
    if (!window.confirm("Remove this memory item?")) return;
    try {
      await api.deleteMemory(id, projectRoot || undefined);
      setItems((prev) => prev.filter((it) => it.id !== id));
      toast("Memory removed", "ok");
    } catch (e: any) {
      toast(`Failed to delete memory: ${e.message}`, "err");
    }
  };

  const filteredItems = items.filter((it) => {
    const matchesCategory = selectedCategory === "all" || it.category === selectedCategory;
    const matchesSearch =
      !searchQuery ||
      it.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (it.source && it.source.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="memory-panel">
      <div className="memory-panel-header">
        <div className="memory-header-left">
          
          <div>
            <h3>Persistent Project Memory & Rules</h3>
            <span className="tiny-text dim">Stored in <code>.agentzero/memory.json</code> & <code>.cursorrules</code></span>
          </div>
        </div>
        {onClose && (
          <button type="button" className="btn tiny" onClick={onClose}>✕</button>
        )}
      </div>

      <div className="memory-body">
        {/* Top Filter and Search Bar */}
        <div className="memory-filter-bar">
          <div className="memory-category-tabs">
            <button
              type="button"
              className={`pill-tab ${selectedCategory === "all" ? "active" : ""}`}
              onClick={() => setSelectedCategory("all")}
            >
              All ({items.length})
            </button>
            {Object.entries(CATEGORY_LABELS).map(([cat, info]) => {
              const count = items.filter((x) => x.category === cat).length;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`pill-tab ${selectedCategory === cat ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {info.label} ({count})
                </button>
              );
            })}
          </div>

          <input
            type="text"
            className="input memory-search"
            placeholder="Search memories or rules..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Add Memory Form */}
        <form onSubmit={handleAddItem} className="memory-add-card">
          <div className="memory-form-row">
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as any)}
              className="select memory-cat-select"
            >
              <option value="preference">User Preference</option>
              <option value="convention">Project Convention</option>
              <option value="architecture">Architecture Fact</option>
              <option value="learned">Learned Lesson</option>
            </select>
            <input
              type="text"
              className="input memory-text-input"
              placeholder="e.g. Always use TypeScript strict mode, mock database calls in unit tests..."
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || !newText.trim()}
            >
              + Add Memory
            </button>
          </div>
        </form>

        {/* Memory Items List */}
        <div className="memory-list-container">
          {loading ? (
            <div className="memory-empty-state">Loading persistent memories...</div>
          ) : filteredItems.length === 0 ? (
            <div className="memory-empty-state">
              No memories found matching your criteria. Add one above or let Agent IDE learn automatically!
            </div>
          ) : (
            <div className="memory-cards-grid">
              {filteredItems.map((item) => {
                const cat = CATEGORY_LABELS[item.category] || { label: item.category, color: "#8b949e" };
                const isActive = item.active !== false;
                return (
                  <div key={item.id} className={`memory-card ${isActive ? "active" : "inactive"}`}>
                    <div className="memory-card-header">
                      <div className="memory-cat-badge" style={{ borderColor: cat.color, color: cat.color }}>
                        {cat.label}
                      </div>
                      <div className="memory-actions">
                        <label className="memory-switch-label" title={isActive ? "Active (Injected into Prompts)" : "Disabled"}>
                          <input
                            type="checkbox"
                            checked={isActive}
                            onChange={() => handleToggleActive(item.id, isActive)}
                          />
                          <span className="switch-text">{isActive ? "Active" : "Off"}</span>
                        </label>
                        <button
                          type="button"
                          className="btn-icon-danger"
                          title="Delete memory"
                          onClick={() => handleDeleteItem(item.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="memory-card-text">{item.text}</div>
                    <div className="memory-card-footer">
                      <span className="tiny-text dim">Added {new Date(item.createdAt).toLocaleDateString()}</span>
                      {item.source && <span className="memory-source-pill">Source: {item.source}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* In-repo File Rules Section (.cursorrules / AGENTS.md) */}
        {fileRules.length > 0 && (
          <div className="memory-filerules-section">
            <h4>Active Rule Files in Workspace</h4>
            <div className="filerules-grid">
              {fileRules.map((rule) => (
                <details key={rule.file} className="filerule-card">
                  <summary>
                    <strong>{rule.file}</strong> ({rule.content.split("\n").length} lines)
                  </summary>
                  <pre className="filerule-content mono">{rule.content}</pre>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
