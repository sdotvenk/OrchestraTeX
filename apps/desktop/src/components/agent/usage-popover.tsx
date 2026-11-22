"use client";

import { ArrowsClockwise, ArrowsInSimple, Gauge, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ProviderStatus, TokenUsageSnapshot } from "@/lib/agent/types";
import { formatCostUsd, formatResetCountdown, formatTokenCount } from "./utils";

interface UsagePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderStatus | null;
  usage: TokenUsageSnapshot | null | undefined;
  threadStatus?: string;
  onRefreshLimits: () => Promise<unknown>;
  onCompact?: () => Promise<unknown>;
}

export function UsagePopover({
  open,
  onOpenChange,
  provider,
  usage,
  threadStatus,
  onRefreshLimits,
  onCompact,
}: UsagePopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
      if (e.key === "Escape") onOpenChange(false);
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono border border-border bg-surface-secondary hover:bg-surface-tertiary text-foreground transition-colors"
        title="Context usage & provider limits"
      >
        <Gauge className="size-3.5 text-muted shrink-0" aria-hidden="true" />
        <span className="tabular-nums">
          {contextWindow
            ? `${formatTokenCount(contextUsed)}/${formatTokenCount(contextWindow)}`
            : contextUsed > 0
              ? `${formatTokenCount(contextUsed)} tok`
              : "Usage"}
        </span>
        {primaryWindow?.usedPercent != null && (
          <span className="text-[10px] text-muted tabular-nums">
            · {Math.round(primaryWindow.usedPercent)}%
          </span>
        )}
      </button>

      {open && (
        <div className="fixed sm:absolute right-2 sm:right-0 top-10 sm:top-full mt-1 w-[min(340px,calc(100vw-1rem))] z-50 border border-foreground bg-background shadow-[4px_4px_0_0_var(--foreground)] p-3 space-y-3">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <Gauge className="size-3.5 text-foreground" aria-hidden="true" />
              <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                Usage & Rate Limits
              </span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-muted hover:text-foreground p-0.5"
              aria-label="Close usage popover"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Section 1: Session Context & Tokens */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
                Session Context
              </span>
              {usage?.totalCostUsd != null && (
                <span className="text-[11px] font-mono font-medium tabular-nums text-foreground">
                  {formatCostUsd(usage.totalCostUsd)}
                </span>
              )}
            </div>

            {contextWindow != null && contextWindow > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                  <span>
                    {formatTokenCount(contextUsed)} / {formatTokenCount(contextWindow)} tokens
                  </span>
                  <span>{contextPct}%</span>
                </div>
                <div className="w-full h-2 bg-surface-tertiary border border-border overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      (contextPct ?? 0) >= 85 ? "bg-error" : "bg-foreground"
                    }`}
                    style={{ width: `${contextPct ?? 0}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="text-[11px] font-mono text-muted tabular-nums">
                Context used: {formatTokenCount(contextUsed)} tokens
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono">
              <div className="border border-border bg-surface-secondary px-2 py-1 flex justify-between">
                <span className="text-muted">Input</span>
                <span className="tabular-nums">{formatTokenCount(usage?.inputTokens)}</span>
              </div>
              <div className="border border-border bg-surface-secondary px-2 py-1 flex justify-between">
                <span className="text-muted">Output</span>
                <span className="tabular-nums">{formatTokenCount(usage?.outputTokens)}</span>
              </div>
              <div className="border border-border bg-surface-secondary px-2 py-1 flex justify-between">
                <span className="text-muted">Cache R</span>
                <span className="tabular-nums">{formatTokenCount(usage?.cacheReadTokens)}</span>
              </div>
              <div className="border border-border bg-surface-secondary px-2 py-1 flex justify-between">
                <span className="text-muted">Reason</span>
                <span className="tabular-nums">{formatTokenCount(usage?.reasoningTokens)}</span>
              </div>
            </div>

            {usage && usage.modelUsage.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted">
                  Models Used
                </div>
                {usage.modelUsage.map((mu) => (
                  <div
                    key={mu.model}
                    className="flex items-center justify-between text-[11px] font-mono border border-border/60 px-2 py-1"
                  >
                    <span className="truncate max-w-[145px]" title={mu.model}>
                      {mu.model}
                    </span>
                    <span className="tabular-nums text-muted">
                      {formatTokenCount(mu.inputTokens + mu.outputTokens)}
                      {mu.costUsd != null ? ` · ${formatCostUsd(mu.costUsd)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 2: Provider Rate Limits & Quotas */}
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
                {provider?.name ?? "Provider"} Limits
              </span>
              {(rateLimits?.planType ?? provider?.account?.planType) && (
                <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase bg-foreground text-background">
                  {rateLimits?.planType ?? provider?.account?.planType}
                </span>
              )}
            </div>

            {provider?.account?.email && (
              <div className="text-[11px] font-mono text-muted truncate">
                {provider.account.email}
              </div>
            )}

            {rateLimits && rateLimits.windows.length > 0 ? (
              <div className="space-y-2">
                {rateLimits.windows.map((w) => {
                  const pct =
                    w.usedPercent != null ? Math.max(0, Math.min(100, w.usedPercent)) : null;
                  const resetStr = formatResetCountdown(w.resetsAt);
                  return (
                    <div key={w.id} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-mono gap-2">
                        <span className="truncate text-foreground">{w.label}</span>
                        <span className="tabular-nums text-muted shrink-0">
                          {pct != null ? `${Math.round(pct)}% used` : (w.status ?? "active")}
                          {resetStr ? ` · resets ${resetStr}` : ""}
                        </span>
                      </div>
                      {pct != null && (
                        <div className="w-full h-1.5 bg-surface-tertiary border border-border overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              pct >= 90 ? "bg-error" : "bg-foreground"
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
              <div className="text-[11px] text-muted border border-border bg-surface-secondary p-2">
                {rateLimits?.note ??
                  "Run a turn or click Refresh to fetch provider quota windows if exposed by this CLI."}
              </div>
            )}

            {rateLimits?.creditsBalance && (
              <div className="text-[11px] font-mono text-foreground">
                Credits: <span className="font-semibold">{rateLimits.creditsBalance}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
            {provider?.supportsCompact && onCompact ? (
              <button
                type="button"
                disabled={compacting || threadStatus === "running"}
                onClick={() => void handleCompact()}
                className="btn btn-outline btn-sm inline-flex items-center gap-1 disabled:opacity-40"
                title="Compact conversation context"
              >
                <ArrowsInSimple className="size-3" aria-hidden="true" />
                <span>{compacting ? "Compacting..." : "Compact"}</span>
              </button>
            ) : (
              <span />
            )}

            <button
              type="button"
              disabled={refreshing || !provider}
              onClick={() => void handleRefresh()}
              className="btn btn-outline btn-sm inline-flex items-center gap-1 disabled:opacity-40"
            >
              <ArrowsClockwise
                className={`size-3 ${refreshing ? "animate-spin" : ""}`}
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
