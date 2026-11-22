"use client";

import { Check, ShieldWarning, Terminal, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { PendingInteraction } from "@/lib/agent/types";

type ApprovalInteraction = Extract<PendingInteraction, { kind: "approval" }>;

interface ApprovalCardProps {
  interaction: ApprovalInteraction;
  onDecide: (params: {
    decision: "allow_once" | "allow_session" | "deny";
    optionId?: string;
    reason?: string;
  }) => Promise<void> | void;
}

export function ApprovalCard({ interaction, onDecide }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);

  const handleDecision = async (
    decision: "allow_once" | "allow_session" | "deny",
    optionId?: string,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onDecide({ decision, optionId });
    } finally {
      setSubmitting(false);
    }
  };

  const hasCustomAcpOptions = interaction.options && interaction.options.length > 0;

  return (
    <div className="border-2 border-accent bg-surface-secondary p-3 my-2 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldWarning className="size-4 text-accent shrink-0" weight="fill" aria-hidden="true" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-accent font-semibold">
            Permission Required
          </span>
          <span className="text-xs font-mono text-foreground font-medium truncate">
            {interaction.toolName}
          </span>
        </div>
      </div>

      <div className="text-xs text-foreground font-medium">{interaction.title}</div>

      {interaction.reason && <div className="text-xs text-muted">{interaction.reason}</div>}

      {interaction.command && (
        <div className="border border-border bg-background p-2 flex items-start gap-2">
          <Terminal className="size-3.5 text-muted shrink-0 mt-0.5" aria-hidden="true" />
          <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all flex-1">
            {interaction.command}
          </pre>
        </div>
      )}

      {interaction.filePath && (
        <div className="text-[11px] font-mono text-foreground-secondary border border-border bg-background px-2 py-1">
          File: {interaction.filePath}
        </div>
      )}

      {interaction.diff && (
        <pre className="border border-border bg-background p-2 text-[11px] font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-foreground-secondary">
          {interaction.diff}
        </pre>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t border-border/60">
        {hasCustomAcpOptions ? (
          interaction.options.map((opt) => {
            const isReject = opt.kind.includes("reject");
            const decision: "allow_once" | "allow_session" | "deny" = isReject
              ? "deny"
              : opt.kind.includes("always")
                ? "allow_session"
                : "allow_once";
            return (
              <button
                key={opt.id}
                type="button"
                disabled={submitting}
                onClick={() => void handleDecision(decision, opt.id)}
                className={
                  isReject
                    ? "btn btn-outline btn-sm text-error border-error/40 hover:bg-error/10"
                    : decision === "allow_once"
                      ? "btn btn-primary btn-sm"
                      : "btn btn-secondary btn-sm"
                }
              >
                {opt.label}
              </button>
            );
          })
        ) : (
          <>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision("deny")}
              className="btn btn-outline btn-sm inline-flex items-center gap-1 text-error hover:bg-error/10"
            >
              <X className="size-3" aria-hidden="true" />
              <span>Deny</span>
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision("allow_session")}
              className="btn btn-outline btn-sm"
            >
              Allow Session
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision("allow_once")}
              className="btn btn-primary btn-sm inline-flex items-center gap-1"
            >
              <Check className="size-3" aria-hidden="true" />
              <span>Allow Once</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
