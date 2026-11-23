"use client";

import { ArrowsClockwise, GearSix, Plugs } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ProviderStatus, RateLimitWindow } from "@/lib/agent/types";
import { ProviderIcon } from "./icons";
import { formatResetCountdown } from "./utils";

interface AgentStatusCardProps {
  providers: ProviderStatus[];
  loading?: boolean;
  collapsed?: boolean;
  onRefreshProviders: () => Promise<unknown>;
  onRefreshRateLimits: (providerId: ProviderStatus["id"]) => Promise<unknown>;
  onOpenSettings: () => void;
}

function WindowMeter({ window: win }: { window: RateLimitWindow }) {
  const pct =
    win.usedPercent != null ? Math.min(100, Math.max(0, Math.round(win.usedPercent))) : null;
  const isDanger = pct != null && pct >= 90;
  const isWarn = pct != null && pct >= 70 && pct < 90;
  const resetText = win.resetsAt ? formatResetCountdown(win.resetsAt) : "";

  return (
    <div className="flex items-center gap-2 text-[11px] leading-4">
      <span className="text-muted w-14 shrink-0 truncate">{win.label}</span>
      {pct != null ? (
        <div className="flex-1 h-1.5 rounded-full bg-sunken overflow-hidden" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-all ${
              isDanger ? "bg-error" : isWarn ? "bg-warn" : "bg-success"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : (
        <span className="flex-1 text-muted">Available</span>
      )}
      <span className="text-muted-foreground tabular-nums shrink-0 text-[10.5px]">
        {pct != null ? `${pct}%` : ""}
        {pct != null && resetText ? " · " : ""}
        {resetText ? `resets ${resetText}` : ""}
      </span>
    </div>
  );
}

/**
 * Silkscreen-inspired rail footer card for multi-provider agent visibility and management.
 * Clicking opens a floating "Agent tools" popover with per-provider status, plan/auth badge,
 * thin rate-limit meters, refresh, and settings jump.
 */
export function AgentStatusCard({
  providers,
  loading = false,
  collapsed = false,
  onRefreshProviders,
  onRefreshRateLimits,
  onOpenSettings,
}: AgentStatusCardProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const connectedProviders = providers.filter((p) => p.installed && p.authenticated);
  const installedProviders = providers.filter((p) => p.installed);
  const activeList = connectedProviders.length > 0 ? connectedProviders : installedProviders;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [open]);

  const handleCheckAgain = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await onRefreshProviders();
      await Promise.allSettled(
        providers
          .filter((p) => p.installed && p.authenticated)
          .map((p) => onRefreshRateLimits(p.id)),
      );
    } finally {
      setChecking(false);
    }
  };

  const stateLabel = loading
    ? "Checking"
    : connectedProviders.length > 0
      ? "Connected"
      : installedProviders.length > 0
        ? "Sign in"
        : "Not found";

  return (
    <div ref={containerRef} className="relative">
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative size-9 rounded-lg inline-flex items-center justify-center hover:bg-subtle transition-colors text-foreground"
          title={`Agents · ${stateLabel}`}
          aria-label="Agent tools"
        >
          {activeList.length > 0 ? (
            <span className="inline-flex items-center -space-x-1">
              {activeList.slice(0, 2).map((p) => (
                <ProviderIcon key={p.id} providerId={p.id} className="size-3.5" />
              ))}
            </span>
          ) : (
            <Plugs className="size-4 text-muted" aria-hidden="true" />
          )}
          <span
            className={`absolute top-1.5 right-1.5 size-1.5 rounded-full ${
              connectedProviders.length > 0
                ? "bg-success"
                : installedProviders.length > 0
                  ? "bg-warn"
                  : "bg-muted-foreground"
            }`}
          />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full p-2.5 rounded-[10px] border border-border bg-panel hover:border-border-dark transition-colors text-left flex flex-col gap-2"
          style={{ boxShadow: "var(--shadow-1)" }}
          aria-expanded={open}
          aria-label="Agent tools status"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-medium text-muted">Agents</span>
            <span
              className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium ${
                connectedProviders.length > 0
                  ? "bg-success-bg text-success"
                  : installedProviders.length > 0
                    ? "bg-warn-bg text-warn"
                    : "bg-subtle text-muted"
              }`}
            >
              {stateLabel}
            </span>
          </div>

          {activeList.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {activeList.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1.5 pl-1.5 pr-2 py-0.5 rounded-full bg-subtle text-[11px] font-medium text-foreground-strong"
                >
                  <ProviderIcon providerId={p.id} className="size-3 shrink-0" />
                  <span>{p.name}</span>
                </span>
              ))}
            </div>
          )}
        </button>
      )}

      {open && (
        <div
          className="fixed sm:absolute left-2 sm:left-0 bottom-14 sm:bottom-full sm:mb-2 w-[310px] max-w-[calc(100vw-16px)] z-50 rounded-xl border border-border bg-panel p-3.5 flex flex-col gap-3"
          style={{ boxShadow: "var(--shadow-2)" }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-foreground-strong">Agent tools</h3>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-muted hover:text-foreground hover:bg-subtle transition-colors"
            >
              <GearSix className="size-3.5" aria-hidden="true" />
              <span>Configure</span>
            </button>
          </div>

          <ul className="divide-y divide-border">
            {providers.map((p) => {
              const isConnected = p.installed && p.authenticated;
              const needsAuth = p.installed && !p.authenticated;
              const windows = p.rateLimits?.windows ?? [];
              return (
                <li key={p.id} className="py-2.5 first:pt-0 last:pb-0 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <ProviderIcon providerId={p.id} className="size-4 shrink-0" />
                    <span className="text-[12.5px] font-medium text-foreground-strong truncate">
                      {p.name}
                    </span>
                    <span
                      className={`ml-auto text-[11px] font-medium ${
                        isConnected
                          ? "text-success"
                          : needsAuth
                            ? "text-warn"
                            : "text-muted-foreground"
                      }`}
                    >
                      {isConnected ? "Connected" : needsAuth ? "Sign in" : "Not found"}
                    </span>
                  </div>

                  {isConnected && (
                    <div className="pl-6 flex flex-col gap-1.5">
                      {(p.rateLimits?.planType ||
                        p.account?.planType ||
                        p.account?.subscriptionType) && (
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded-md border border-border bg-subtle text-[10.5px] text-muted font-medium">
                            {p.rateLimits?.planType ||
                              p.account?.planType ||
                              p.account?.subscriptionType}
                          </span>
                          {p.version && (
                            <span className="text-[10.5px] font-mono text-muted-foreground">
                              v{p.version}
                            </span>
                          )}
                        </div>
                      )}

                      {windows.length > 0 && (
                        <div className="flex flex-col gap-1">
                          {windows.map((w) => (
                            <WindowMeter key={w.id} window={w} />
                          ))}
                        </div>
                      )}

                      {p.rateLimits?.creditsBalance && (
                        <span className="text-[11px] text-muted tabular-nums">
                          Credits: {p.rateLimits.creditsBalance}
                        </span>
                      )}
                    </div>
                  )}

                  {needsAuth && (
                    <p className="pl-6 text-[11px] text-muted leading-snug">
                      CLI found{p.version ? ` (v${p.version})` : ""}. Sign in via terminal or
                      configure in Settings.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="text-[11px] text-muted leading-relaxed">
            Install a tool&apos;s command line and sign in, then check again.
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={checking}
              onClick={() => void handleCheckAgain()}
              className="btn btn-secondary btn-sm flex-1"
            >
              <ArrowsClockwise
                className={`size-3.5 ${checking ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>{checking ? "Checking..." : "Check again"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
