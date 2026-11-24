"use client";

import { ArrowsClockwise, ArrowsInSimple, Gauge, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { ProviderStatus, TokenUsageSnapshot } from "@/lib/agent/types";
import { formatCostUsd, formatResetCountdown, formatTokenCount } from "./utils";

interface UsagePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderStatus | null;
  usage: TokenUsageSnapshot | null | undefined;
  threadStatus?: string;
  compactRing?: boolean;
  showPercent?: boolean;
  voiceColor?: string;
  onRefreshLimits: () => Promise<unknown>;
  onCompact?: () => Promise<unknown>;
}

export function UsagePopover({
  open,
  onOpenChange,
  provider,
  usage,
  threadStatus,
  compactRing = false,
  showPercent = false,
  voiceColor,
  onRefreshLimits,
  onCompact,
}: UsagePopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const [refreshing, setRefreshing] = useState(false);
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [open, onOpenChange]);

  const contextUsed = usage?.contextUsedTokens ?? 0;
  const contextWindow = usage?.contextWindowTokens ?? null;
  const contextPct =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 100))
      : null;

  const rateLimits = provider?.rateLimits ?? null;
  const primaryWindow = rateLimits?.windows?.[0] ?? null;

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshLimits();
    } finally {
      setRefreshing(false);
    }
  };

  const handleCompact = async () => {
    if (compacting || !onCompact) return;
    setCompacting(true);
    try {
      await onCompact();
    } finally {
      setCompacting(false);
    }
  };

  const ringRadius = 6;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset =
    contextPct != null ? ringCircumference * (1 - contextPct / 100) : ringCircumference;

  return (
    <div ref={containerRef} className={compactRing ? undefined : "relative"}>
      {compactRing ? (
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          onClick={() => onOpenChange(!open)}
          className={`${showPercent ? "h-7 px-1.5 gap-1.5" : "size-7"} rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle aria-expanded:bg-accent-soft aria-expanded:text-accent transition-colors`}
          title={
            contextWindow
              ? `Context: ${formatTokenCount(contextUsed)} / ${formatTokenCount(contextWindow)} (${contextPct}%)`
              : "Context usage & provider limits"
          }
          aria-label="Context usage and rate limits"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r={ringRadius}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.22"
              strokeWidth="2"
            />
            {contextPct != null && contextPct > 0 && (
              <circle
                cx="8"
                cy="8"
                r={ringRadius}
                fill="none"
                stroke={contextPct >= 85 ? "var(--danger)" : (voiceColor ?? "var(--accent)")}
                strokeWidth="2"
                strokeDasharray={ringCircumference}
                strokeDashoffset={ringOffset}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          {showPercent && (
            <span className="hidden @[320px]:inline font-mono text-[11.5px] text-muted">
              {contextPct != null ? `${contextPct}%` : "0%"}
            </span>
          )}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          onClick={() => onOpenChange(!open)}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[11.5px] font-mono text-muted hover:text-foreground hover:bg-subtle transition-colors"
          title="Context usage & provider limits"
        >
          <Gauge className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {contextWindow
              ? `${formatTokenCount(contextUsed)}/${formatTokenCount(contextWindow)}`
              : contextUsed > 0
                ? `${formatTokenCount(contextUsed)}`
                : "Usage"}
          </span>
          {primaryWindow?.usedPercent != null && (
            <span className="text-[10.5px] text-muted-foreground tabular-nums">
              · {Math.round(primaryWindow.usedPercent)}%
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          id={popoverId}
          className={`absolute ${
            compactRing
              ? "left-3 bottom-full mb-2 w-[calc(100%-24px)] max-w-[320px]"
              : "right-0 top-full mt-1.5 w-[min(320px,calc(100vw-1rem))]"
          } max-h-[min(420px,60dvh)] overflow-y-auto z-50 rounded-xl border border-border bg-panel p-3.5 space-y-3`}
          style={{ boxShadow: "var(--shadow-2)" }}
        >
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
            <span className="text-[13px] font-semibold text-foreground-strong">
              Context & limits
            </span>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                triggerRef.current?.focus();
              }}
              className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle"
              aria-label="Close usage popover"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-muted">Session context</span>
              {usage?.totalCostUsd != null && (
                <span className="font-mono font-medium tabular-nums text-foreground-strong">
                  {formatCostUsd(usage.totalCostUsd)}
                </span>
              )}
            </div>

            {contextWindow != null && contextWindow > 0 ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px] font-mono tabular-nums text-foreground">
                  <span>
                    {formatTokenCount(contextUsed)} / {formatTokenCount(contextWindow)}
                  </span>
                  <span className="text-muted">{contextPct}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-sunken overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (contextPct ?? 0) >= 85 ? "bg-error" : "bg-accent"
                    }`}
                    style={{ width: `${contextPct ?? 0}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="text-[11.5px] font-mono text-muted tabular-nums">
                Context used: {formatTokenCount(contextUsed)} tokens
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono">
              <div className="rounded-lg bg-subtle px-2.5 py-1.5 flex justify-between">
                <span className="text-muted">In</span>
                <span className="tabular-nums text-foreground-strong">
                  {formatTokenCount(usage?.inputTokens)}
                </span>
              </div>
              <div className="rounded-lg bg-subtle px-2.5 py-1.5 flex justify-between">
                <span className="text-muted">Out</span>
                <span className="tabular-nums text-foreground-strong">
                  {formatTokenCount(usage?.outputTokens)}
                </span>
              </div>
              <div className="rounded-lg bg-subtle px-2.5 py-1.5 flex justify-between">
                <span className="text-muted">Cache</span>
                <span className="tabular-nums text-foreground-strong">
                  {formatTokenCount(usage?.cacheReadTokens)}
                </span>
              </div>
              <div className="rounded-lg bg-subtle px-2.5 py-1.5 flex justify-between">
                <span className="text-muted">Reason</span>
                <span className="tabular-nums text-foreground-strong">
                  {formatTokenCount(usage?.reasoningTokens)}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium text-muted">
                {provider?.name ?? "Provider"} limits
              </span>
              {(rateLimits?.planType ?? provider?.account?.planType) && (
                <span className="px-1.5 py-0.5 rounded-md border border-border bg-subtle text-[10.5px] font-medium text-foreground">
                  {rateLimits?.planType ?? provider?.account?.planType}
                </span>
              )}
            </div>

            {rateLimits && rateLimits.windows.length > 0 ? (
              <div className="space-y-2">
                {rateLimits.windows.map((w) => {
                  const pct =
                    w.usedPercent != null ? Math.max(0, Math.min(100, w.usedPercent)) : null;
                  const resetStr = formatResetCountdown(w.resetsAt);
                  return (
                    <div key={w.id} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] gap-2">
                        <span className="truncate text-foreground">{w.label}</span>
                        <span className="tabular-nums text-muted font-mono shrink-0">
                          {pct != null ? `${Math.round(pct)}%` : (w.status ?? "active")}
                          {resetStr ? ` · ${resetStr}` : ""}
                        </span>
                      </div>
                      {pct != null && (
                        <div className="w-full h-1.5 rounded-full bg-sunken overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              pct >= 90 ? "bg-error" : pct >= 70 ? "bg-warn" : "bg-success"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-[11px] text-muted rounded-lg bg-subtle p-2.5 leading-snug">
                {rateLimits?.note ?? "Click Refresh to check quota windows exposed by this CLI."}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
            {provider?.supportsCompact && onCompact ? (
              <button
                type="button"
                disabled={compacting || threadStatus === "running"}
                onClick={() => void handleCompact()}
                className="btn btn-secondary btn-sm"
                title="Compact conversation context"
              >
                <ArrowsInSimple className="size-3.5" aria-hidden="true" />
                <span>{compacting ? "Compacting..." : "Compact"}</span>
              </button>
            ) : (
              <span />
            )}

            <button
              type="button"
              disabled={refreshing || !provider}
              onClick={() => void handleRefresh()}
              className="btn btn-secondary btn-sm"
            >
              <ArrowsClockwise
                className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
