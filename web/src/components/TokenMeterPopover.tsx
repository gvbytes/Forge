import React, { useEffect, useState, useRef } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";
import type { RouterStatus } from "../lib/types";

interface ContextStats {
  activeTokens: number;
  maxTokens: number;
  percent: number;
  breakdown: {
    inputTokens: number;
    memoryTokens: number;
    historyTokens: number;
    outputTokens: number;
  };
}

interface BudgetStats {
  costUsd: number;
  maxCostUsd: number;
  costPercent: number;
  stepsDone: number;
  maxSteps: number;
  stepsPercent: number;
  totalTokens: number;
}

export function TokenMeterPopover() {
  const activeTaskId = useUi((s) => s.activeTaskId);
  const toggleDashboard = useUi((s) => s.toggleDashboard);

  const [open, setOpen] = useState(false);
  const [ctxData, setCtxData] = useState<ContextStats | null>(null);
  const [budgetData, setBudgetData] = useState<BudgetStats | null>(null);
  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeTaskId) return;
    let alive = true;

    const fetchLiveAccounting = async () => {
      try {
        const [ctxRes, rs] = await Promise.all([
          api.taskContext(activeTaskId).catch(() => null),
          api.routerStatus().catch(() => null),
        ]);
        if (!alive) return;
        if (ctxRes && ctxRes.ok) {
          setCtxData(ctxRes.contextWindow);
          setBudgetData(ctxRes.budget);
        }
        setRouterStatus(rs);
      } catch {
        /* ignore fetch errors */
      }
    };

    void fetchLiveAccounting();
    const interval = setInterval(fetchLiveAccounting, 3000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [activeTaskId, open]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Actual live values from the backend
  const activeTokens = ctxData?.activeTokens || 0;
  const maxTokens = ctxData?.maxTokens || 128000;
  const ctxPercent = ctxData?.percent || 0;

  const costUsd = budgetData?.costUsd || 0;
  const maxCostUsd = budgetData?.maxCostUsd || 0.50;
  const costPercent = budgetData?.costPercent || 0;

  const stepsDone = budgetData?.stepsDone || 0;
  const maxSteps = budgetData?.maxSteps || 40;
  const stepsPercent = budgetData?.stepsPercent || 0;

  const breakdown = ctxData?.breakdown || {
    inputTokens: 0,
    memoryTokens: 0,
    historyTokens: 0,
    outputTokens: 0,
  };

  // Determine indicator ring color
  const ringColor =
    ctxPercent >= 85 || costPercent >= 85
      ? "#f85149" // red
      : ctxPercent >= 60 || costPercent >= 60
      ? "#d29922" // yellow/orange
      : "#3fb950"; // green

  const formatTok = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className="token-meter-container" ref={popoverRef}>
      {/* Interactive Trigger Button matching Claude Code */}
      <button
        type="button"
        className={`token-meter-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen(!open)}
        title="Live Context Window & Token Accounting (Real backend calculation)"
      >
        <span className="token-trigger-label">
          {formatTok(activeTokens)} tok
        </span>
        <svg className="token-ring-icon" width="16" height="16" viewBox="0 0 36 36">
          <path
            className="token-ring-bg"
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="#30363d"
            strokeWidth="3.5"
          />
          <path
            className="token-ring-fill"
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke={ringColor}
            strokeWidth="3.8"
            strokeDasharray={`${Math.max(1, ctxPercent)}, 100`}
          />
        </svg>
      </button>

      {/* Claude Code Style Flyout Popover */}
      {open && (
        <div className="claude-token-popover">
          {/* 1. Context Window Section */}
          <div className="popover-section">
            <div className="popover-row-head">
              <span className="popover-title">Context window</span>
              <span className="popover-stat-text mono">
                {formatTok(activeTokens)} / {formatTok(maxTokens)} ({ctxPercent}%)
              </span>
            </div>
            <div className="segmented-progress-bar">
              <div
                className="progress-segment input-segment"
                style={{ width: `${Math.min(100, (breakdown.inputTokens / maxTokens) * 100)}%` }}
                title={`Input/Prompt Tokens: ${breakdown.inputTokens}`}
              />
              <div
                className="progress-segment memory-segment"
                style={{ width: `${Math.min(100, (breakdown.memoryTokens / maxTokens) * 100)}%` }}
                title={`Memory & Rules Tokens: ${breakdown.memoryTokens}`}
              />
              <div
                className="progress-segment output-segment"
                style={{ width: `${Math.min(100, (breakdown.outputTokens / maxTokens) * 100)}%` }}
                title={`Output Tokens: ${breakdown.outputTokens}`}
              />
            </div>
          </div>

          <div className="popover-divider" />

          {/* 2. Usage & Budget Limits Section */}
          <div className="popover-section">
            <div className="popover-subtitle">Task budget & usage limits</div>

            {/* Spend limit */}
            <div className="limit-item">
              <div className="limit-item-header">
                <span className="limit-label">Task spend</span>
                <span className="limit-detail mono">
                  ${costUsd.toFixed(4)} / ${maxCostUsd.toFixed(2)} ({costPercent}%)
                </span>
              </div>
              <div className="simple-progress-bar">
                <div
                  className={`progress-fill ${costPercent >= 90 ? "fill-danger" : costPercent >= 60 ? "fill-warn" : "fill-primary"}`}
                  style={{ width: `${costPercent}%` }}
                />
              </div>
            </div>

            {/* Step limit */}
            <div className="limit-item">
              <div className="limit-item-header">
                <span className="limit-label">Step budget</span>
                <span className="limit-detail mono">
                  {stepsDone} / {maxSteps} steps ({stepsPercent}%)
                </span>
              </div>
              <div className="simple-progress-bar">
                <div
                  className={`progress-fill ${stepsPercent >= 90 ? "fill-danger" : stepsPercent >= 60 ? "fill-warn" : "fill-accent"}`}
                  style={{ width: `${stepsPercent}%` }}
                />
              </div>
            </div>
          </div>

          <div className="popover-divider" />

          {/* 3. Upstream Provider Status */}
          {routerStatus && (
            <div className="popover-section provider-status-section">
              <div className="popover-subtitle">Upstream providers</div>
              <div className="provider-pills-row">
                {Object.entries(routerStatus.providers || {}).map(([pName, active]) => (
                  <span
                    key={pName}
                    className={`provider-status-pill ${active ? "is-active" : "is-inactive"}`}
                  >
                    <span className="status-dot" />
                    {pName}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 4. Footer Link */}
          <div className="popover-footer">
            <button
              type="button"
              className="popover-link-btn"
              onClick={() => {
                setOpen(false);
                toggleDashboard();
              }}
            >
              See detailed breakdown →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
