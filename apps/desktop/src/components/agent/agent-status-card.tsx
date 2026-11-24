"use client";

import { ArrowsClockwise, CaretUp, GearSix, Plugs } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

const POPOVER_WIDTH = 310;
const POPOVER_GAP = 8;

function getPopoverPosition(trigger: HTMLButtonElement) {
  const rect = trigger.getBoundingClientRect();
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openAbove = spaceAbove > spaceBelow;

  return {
    left: Math.max(
      POPOVER_GAP,
      Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_GAP),
    ),
    top: openAbove ? undefined : rect.bottom + POPOVER_GAP,
    bottom: openAbove ? window.innerHeight - rect.top + POPOVER_GAP : undefined,
    maxHeight: Math.max(0, Math.max(spaceAbove, spaceBelow) - POPOVER_GAP * 2),
  };
}

function WindowMeter({ window: win }: { window: RateLimitWindow }) {
  const pct =
    win.usedPercent != null ? Math.min(100, Math.max(0, Math.round(win.usedPercent))) : null;
  const isDanger = pct != null && pct >= 90;
  const isWarn = pct != null && pct >= 70 && pct < 90;
  const resetText = win.resetsAt ? formatResetCountdown(win.resetsAt) : "";

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] leading-4">
      <span className="text-muted">{win.label}</span>
      <span className="text-muted-foreground tabular-nums text-[10.5px] text-right">
        {pct != null ? `${pct}%` : "Available"}
        {resetText ? ` · resets ${resetText}` : ""}
      </span>
      {pct != null ? (
        <div
          className="col-span-2 row-start-2 h-1.5 rounded-full bg-sunken overflow-hidden"
          aria-hidden="true"
        >
          <div
            className={`h-full rounded-full transition-all ${
              isDanger ? "bg-error" : isWarn ? "bg-warn" : "bg-success"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
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
  const [checking, setChecking] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof getPopoverPosition> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const open = position !== null;
  const toggleOpen = () => {
    setPosition(!open && triggerRef.current ? getPopoverPosition(triggerRef.current) : null);
  };

  const connectedProviders = providers.filter((p) => p.installed && p.authenticated);
  const installedProviders = providers.filter((p) => p.installed);
  const activeList = connectedProviders.length > 0 ? connectedProviders : installedProviders;

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.querySelector("button")?.focus({ preventScroll: true });
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(event.target) &&
        !popoverRef.current?.contains(event.target)
      ) {
        setPosition(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPosition(null);
        triggerRef.current?.focus();
      }
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      const trigger = triggerRef.current;
      if (trigger) setPosition(getPopoverPosition(trigger));
    };
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("keydown", handleEsc);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("keydown", handleEsc);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
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
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-controls={open ? popoverId : undefined}
          className="relative size-9 rounded-lg inline-flex items-center justify-center hover:bg-subtle transition-colors text-foreground"
          title={`Agents · ${stateLabel}`}
          aria-expanded={open}
          aria-label={`Agent tools, ${stateLabel}`}
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
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-controls={open ? popoverId : undefined}
          className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-border px-2.5 text-left transition-colors hover:bg-subtle hover:border-border-dark"
          aria-expanded={open}
          aria-label={`Agent tools, ${stateLabel}`}
        >
          <Plugs className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate text-[12px] font-medium text-foreground">Agents</span>
          <span
            className={`ml-auto min-w-0 truncate text-[11px] ${
              connectedProviders.length > 0
                ? "text-success"
                : installedProviders.length > 0
                  ? "text-warn"
                  : "text-muted"
            }`}
          >
            {stateLabel}
          </span>
          <CaretUp
            className={`size-3 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}

      {position &&
        createPortal(
          <section
            ref={popoverRef}
            id={popoverId}
            aria-labelledby={`${popoverId}-title`}
            className="fixed max-w-[calc(100vw-16px)] overflow-y-auto z-50 rounded-xl border border-border bg-panel p-3.5 flex flex-col gap-3"
            style={{
              boxShadow: "var(--shadow-2)",
              width: POPOVER_WIDTH,
              ...position,
            }}
          >
            <div className="flex items-center justify-between">
              <h3
                id={`${popoverId}-title`}
                className="text-[13.5px] font-semibold text-foreground-strong"
              >
                Agent tools
              </h3>
              <button
                type="button"
                onClick={() => {
                  setPosition(null);
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

            {installedProviders.length < providers.length && (
              <p className="text-[11px] text-muted leading-relaxed">
                Install a tool&apos;s command line and sign in, then check again.
              </p>
            )}

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
          </section>,
          document.body,
        )}
    </div>
  );
}
