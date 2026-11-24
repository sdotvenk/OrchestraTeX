"use client";

import { LockKey } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { PendingInteraction } from "@/lib/agent/types";

type ApprovalInteraction = Extract<PendingInteraction, { kind: "approval" }>;

interface ApprovalCardProps {
  interaction: ApprovalInteraction;
  sessionDirectory: string | null;
  providerLabel?: string;
  onDecide: (params: {
    decision: "allow_once" | "allow_session" | "deny";
    optionId?: string;
    reason?: string;
  }) => Promise<void> | void;
}

export function ApprovalCard({
  interaction,
  sessionDirectory,
  providerLabel,
  onDecide,
}: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);

  const handleDecision = useCallback(
    async (decision: "allow_once" | "allow_session" | "deny", optionId?: string) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await onDecide({ decision, optionId });
      } finally {
        setSubmitting(false);
      }
    },
    [onDecide, submitting],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "y") {
        event.preventDefault();
        void handleDecision("allow_once");
      } else if (key === "n") {
        event.preventDefault();
        void handleDecision("deny");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleDecision]);

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

  const shortDir = directory
    ? directory === sessionDirectory
      ? "./"
      : directory.split("/").slice(-2).join("/")
    : null;
  const actionPhrase = interaction.command
    ? "run a command"
    : interaction.filePath
      ? "edit a file"
      : `use ${interaction.toolName}`;

  return (
    <div className="my-2 flex flex-col gap-2 rounded-[10px] border-[1.5px] border-[var(--decision-border)] bg-[var(--decision-bg)] p-3 shadow-[var(--decision-shadow)]">
      <div className="flex items-center gap-2 min-w-0">
        <LockKey className="size-3.5 shrink-0 text-warn" weight="bold" aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-foreground-strong truncate">
          {providerLabel ?? "Agent"} wants to {actionPhrase}
        </span>
        {shortDir && (
          <span className="ml-auto font-mono text-[11.5px] text-[var(--decision-muted)] shrink-0">
            in {shortDir}
          </span>
        )}
      </div>

      {title && <div className="text-xs font-medium text-foreground">{title}</div>}

      {showReason && <div className="text-xs text-foreground">{reason}</div>}

      {interaction.command && (
        <pre className="rounded-[6px] border border-[var(--decision-code-border)] bg-[var(--decision-code-bg)] px-2.5 py-1.5 font-mono text-[12px] text-foreground overflow-x-auto whitespace-pre-wrap break-words">
          {interaction.command}
        </pre>
      )}

      {interaction.filePath && (
        <div className="rounded-[6px] border border-[var(--decision-code-border)] bg-[var(--decision-code-bg)] px-2.5 py-1.5 font-mono text-[12px] text-foreground overflow-x-auto">
          {interaction.filePath}
        </div>
      )}

      {interaction.diff && (
        <pre className="rounded-[6px] border border-[var(--decision-code-border)] bg-[var(--decision-code-bg)] px-2.5 py-1.5 font-mono text-[11.5px] text-foreground overflow-x-auto max-h-40 whitespace-pre-wrap">
          {interaction.diff}
        </pre>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {hasCustomOptions ? (
          interaction.options.map((opt) => {
            const kind = opt.kind ?? "";
            const isReject = kind.includes("reject");
            const decision: "allow_once" | "allow_session" | "deny" = isReject
              ? "deny"
              : kind.includes("always")
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
              onClick={() => void handleDecision("allow_once")}
              className="rounded-[6px] bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-text hover:bg-primary-hover disabled:opacity-50"
            >
              Allow once
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision("allow_session")}
              className="rounded-[6px] border border-[var(--warn-line)] bg-transparent px-2.5 py-1 text-[12px] text-foreground hover:bg-panel/30 disabled:opacity-50"
            >
              Always allow {interaction.toolName}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision("deny")}
              className="rounded-[6px] bg-transparent px-2 py-1 text-[12px] text-foreground hover:bg-error-bg/40 disabled:opacity-50"
            >
              Deny
            </button>
          </>
        )}
        <span className="ml-auto font-mono text-[11px] text-[var(--decision-muted)]">⌘Y · ⌘N</span>
      </div>
    </div>
  );
}
