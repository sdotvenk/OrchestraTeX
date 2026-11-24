"use client";

import { Check, LockKey, Terminal, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { PendingInteraction } from "@/lib/agent/types";

type ApprovalInteraction = Extract<PendingInteraction, { kind: "approval" }>;

interface ApprovalCardProps {
  interaction: ApprovalInteraction;
  sessionDirectory: string | null;
  onDecide: (params: {
    decision: "allow_once" | "allow_session" | "deny";
    optionId?: string;
    reason?: string;
  }) => Promise<void> | void;
}

export function ApprovalCard({ interaction, sessionDirectory, onDecide }: ApprovalCardProps) {
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

  const cwd =
    interaction.input &&
    typeof interaction.input === "object" &&
    "cwd" in interaction.input &&
    typeof interaction.input.cwd === "string" &&
    interaction.input.cwd.trim()
      ? interaction.input.cwd
      : null;

  const directory = cwd ?? (interaction.command ? sessionDirectory : null);
  const title =
    interaction.title === `Allow ${interaction.toolName}` ||
    interaction.title === interaction.command
      ? null
      : interaction.title;
  const reason = interaction.reason?.trim();
  const showReason = reason && !/^this command requires approval\.?$/i.test(reason);
  const hasCustomOptions = interaction.options && interaction.options.length > 0;

  return (
    <div className="my-2 space-y-2 rounded-lg border border-warn/30 bg-warn-bg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <LockKey className="size-4 shrink-0 text-warn" weight="fill" aria-hidden="true" />
          <span className="text-xs font-semibold text-warn">Permission required</span>
          <span className="text-xs font-mono text-foreground font-medium truncate">
            {interaction.toolName}
          </span>
        </div>
      </div>

      {title && <div className="text-xs font-medium text-foreground">{title}</div>}

      {showReason && <div className="text-xs text-foreground">{reason}</div>}

      {interaction.command && (
        <div className="border border-border bg-background p-2 flex items-start gap-2">
          <Terminal className="size-3.5 text-muted shrink-0 mt-0.5" aria-hidden="true" />
          <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all flex-1">
            {interaction.command}
          </pre>
        </div>
      )}

      {directory && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-warn">
          <span>{cwd ? "Working directory" : "Session directory"}</span>
          <code className="min-w-0 wrap-anywhere">{directory}</code>
        </div>
      )}

      {interaction.filePath && (
        <div className="flex flex-wrap items-baseline gap-x-2 border border-border bg-background px-2 py-1 text-[11px] text-foreground-secondary">
          <span>File</span>
          <code className="min-w-0 wrap-anywhere">{interaction.filePath}</code>
        </div>
      )}

      {interaction.diff && (
        <pre className="border border-border bg-background p-2 text-[11px] font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-foreground-secondary">
          {interaction.diff}
        </pre>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t border-border/60">
        {hasCustomOptions ? (
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
                      ? "btn btn-solid btn-sm"
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
              className="btn btn-solid btn-sm inline-flex items-center gap-1"
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
