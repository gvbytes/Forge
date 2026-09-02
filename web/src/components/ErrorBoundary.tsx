import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ padding: 16, margin: 12, background: "#2a1515", border: "1px solid #f85149", borderRadius: 8, color: "#f85149" }}>
          <b>UI Component Error:</b>
          <p style={{ fontSize: 12, fontFamily: "monospace", margin: "6px 0" }}>{this.state.error?.message || "Unknown error"}</p>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 8 }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            ↺ Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
