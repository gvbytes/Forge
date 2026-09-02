// Bottom-right toast stack (settings saves, pin ops, task control feedback).
import { useUi } from "../stores/ui";

export function ToastStack() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast ${t.kind}`}
          onClick={() => dismiss(t.id)}
          title="click to dismiss"
        >
          {t.kind === "ok" ? "✓ " : t.kind === "err" ? "✗ " : "ℹ "}
          {t.text}
        </button>
      ))}
    </div>
  );
}
