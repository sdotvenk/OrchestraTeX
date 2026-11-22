"use client";

import { Check, ClipboardText, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { PendingInteraction } from "@/lib/agent/types";
import { MarkdownText } from "./markdown-text";

type PlanApprovalInteraction = Extract<PendingInteraction, { kind: "planApproval" }>;

interface PlanApprovalCardProps {
  interaction: PlanApprovalInteraction;
  onDecide: (approved: boolean, feedback?: string) => Promise<void> | void;
}

export function PlanApprovalCard({ interaction, onDecide }: PlanApprovalCardProps) {
  const [feedback, setFeedback] = useState("");
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (approved: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onDecide(approved, feedback.trim() || undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-2 border-accent bg-surface-secondary p-3 my-2 space-y-2.5">
      <div className="flex items-center gap-2">
        <ClipboardText className="size-4 text-accent shrink-0" weight="fill" aria-hidden="true" />
        <span className="text-[11px] font-mono uppercase tracking-wider text-accent font-semibold">
          Plan Ready for Review
        </span>
      </div>

      {interaction.planText ? (
        <div className="border border-border bg-background p-2.5 max-h-72 overflow-y-auto">
          <MarkdownText text={interaction.planText} />
        </div>
      ) : (
        <div className="text-xs text-muted">
          The agent has prepared its plan and is ready to proceed with implementation.
        </div>
      )}

      {showRevisionInput && (
        <div className="space-y-1.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="Describe what to change in the plan..."
            aria-label="Plan revision feedback"
            className="w-full p-2 border border-border bg-background text-xs font-mono text-foreground focus:outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 pt-1 border-t border-border/60">
        {!showRevisionInput ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() => setShowRevisionInput(true)}
            className="btn btn-outline btn-sm inline-flex items-center gap-1"
          >
            <X className="size-3" aria-hidden="true" />
            <span>Revise Plan</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit(false)}
            className="btn btn-outline btn-sm text-error border-error/40"
          >
            Send Revision Feedback
          </button>
        )}

        <button
          type="button"
          disabled={submitting}
          onClick={() => void submit(true)}
          className="btn btn-primary btn-sm inline-flex items-center gap-1"
        >
          <Check className="size-3" aria-hidden="true" />
          <span>{submitting ? "Approving..." : "Approve & Execute"}</span>
        </button>
      </div>
    </div>
  );
}
