"use client";

import {
  ArrowsClockwise,
  CheckCircle,
  Gear,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { AgentProviderId, ProviderStatus } from "@/lib/agent/types";
import { ProviderIcon } from "./icons";

interface ProviderOnboardingProps {
  providers: ProviderStatus[];
  activeProviderId: AgentProviderId;
  loading: boolean;
  onSelectProvider: (providerId: AgentProviderId) => void;
  onRunTerminalCommand: (command: string) => void;
  onRefreshProviders: () => Promise<unknown>;
  onOpenSettings: () => void;
  onDismiss?: () => void;
}

export function ProviderOnboarding({
  providers,
  activeProviderId,
  loading,
  onSelectProvider,
  onRunTerminalCommand,
  onRefreshProviders,
  onOpenSettings,
  onDismiss,
}: ProviderOnboardingProps) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshProviders();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-background">
      <div className="border border-border bg-surface-secondary p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-mono uppercase tracking-wider font-semibold text-foreground">
            Agent Providers
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={refreshing || loading}
              onClick={() => void handleRefresh()}
              className="btn btn-outline btn-sm inline-flex items-center gap-1"
            >
              <ArrowsClockwise
                className={`size-3 ${refreshing || loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>Re-check</span>
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="btn btn-outline btn-sm inline-flex items-center gap-1"
              title="Configure custom CLI / ACP paths"
            >
              <Gear className="size-3" aria-hidden="true" />
              <span>Paths</span>
            </button>
          </div>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          Connect directly to your local agent CLIs (Claude Code, Codex, or Antigravity over ACP).
          No API proxy required — existing logins and quota limits apply natively.
        </p>
      </div>

      <div className="space-y-2">
        {providers.map((p) => {
          const isSelected = p.id === activeProviderId;
          const isReady = p.installed && p.authenticated;

          return (
            <div
              key={p.id}
              className={`border p-3 space-y-2 transition-colors ${
                isSelected
                  ? "border-foreground bg-surface-secondary"
                  : "border-border bg-background"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderIcon providerId={p.id} className="size-4 text-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-foreground">{p.name}</span>
                      <span className="text-[10px] font-mono uppercase px-1 py-0.2 border border-border text-muted">
                        {p.transport}
                      </span>
                      {p.version && (
                        <span className="text-[10px] font-mono text-muted truncate max-w-[140px]">
                          {p.version}
                        </span>
                      )}
                    </div>
                    {p.account?.email && (
                      <div className="text-[11px] font-mono text-muted truncate">
                        {p.account.email}
                        {p.account.planType ? ` (${p.account.planType})` : ""}
                      </div>
                    )}
                  </div>
                </div>

                {isReady ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-success shrink-0">
                    <CheckCircle className="size-3.5" weight="fill" aria-hidden="true" />
                    <span>Ready</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-error shrink-0">
                    <WarningCircle className="size-3.5" weight="fill" aria-hidden="true" />
                    <span>{p.installed ? "Needs Auth" : "Not Installed"}</span>
                  </span>
                )}
              </div>

              {p.authError && (
                <div className="text-[11px] font-mono text-error border border-error/40 bg-error/5 px-2 py-1">
                  {p.authError}
                </div>
              )}

              {!p.installed && (
                <div className="text-[11px] text-muted font-mono">
                  {p.id === "claude" && "Install: npm i -g @anthropic-ai/claude-code"}
                  {p.id === "codex" && "Install: npm i -g @openai/codex"}
                  {p.id === "antigravity" && "Install: Antigravity CLI (agy) on PATH"}
                  {p.id === "custom-acp" && "Configure custom ACP command in Settings -> Agents"}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {p.binaryPath ? (
                  <span
                    className="text-[10px] font-mono text-muted truncate max-w-[180px]"
                    title={p.binaryPath}
                  >
                    {p.binaryPath}
                  </span>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-1.5">
                  {p.installed && !p.authenticated && p.loginCommand && (
                    <button
                      type="button"
                      onClick={() => onRunTerminalCommand(p.loginCommand)}
                      className="btn btn-outline btn-sm inline-flex items-center gap-1"
                    >
                      <TerminalWindow className="size-3" aria-hidden="true" />
                      <span>Sign in in Terminal</span>
                    </button>
                  )}

                  {p.installed && (
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProvider(p.id);
                        if (isReady && onDismiss) onDismiss();
                      }}
                      className={isReady ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm"}
                    >
                      {isSelected ? "Selected" : "Use Provider"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {onDismiss && (
        <div className="flex justify-end">
          <button type="button" onClick={onDismiss} className="btn btn-outline btn-sm">
            Back to Chat
          </button>
        </div>
      )}
    </div>
  );
}
