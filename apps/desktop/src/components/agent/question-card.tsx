"use client";

import { ArrowLeft, ArrowRight, Check, Question, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { PendingInteraction } from "@/lib/agent/types";

type QuestionInteraction = Extract<PendingInteraction, { kind: "question" }>;

interface QuestionCardProps {
  interaction: QuestionInteraction;
  onSubmit: (answers: Record<string, string[]>) => Promise<void> | void;
  onDismiss: () => Promise<void> | void;
}

export function QuestionCard({ interaction, onSubmit, onDismiss }: QuestionCardProps) {
  const questions = interaction.questions;
  const totalSteps = questions.length;
  const isSingleStep = totalSteps === 1;

  const [step, setStep] = useState(0);
  const [selectedByQ, setSelectedByQ] = useState<Record<string, string[]>>({});
  const [otherTextByQ, setOtherTextByQ] = useState<Record<string, string>>({});
  const [otherActiveByQ, setOtherActiveByQ] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const activeQuestion = questions[step] ?? questions[0];

  const getEffectiveAnswersFor = useCallback(
    (qId: string): string[] => {
      const selected = selectedByQ[qId] ?? [];
      const otherText = (otherTextByQ[qId] ?? "").trim();
      const otherActive = Boolean(otherActiveByQ[qId]);
      if (otherActive && otherText) {
        return [...selected, otherText];
      }
      return selected;
    },
    [otherActiveByQ, otherTextByQ, selectedByQ],
  );

  const buildFinalAnswers = useCallback((): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const q of questions) {
      out[q.id] = getEffectiveAnswersFor(q.id);
    }
    return out;
  }, [getEffectiveAnswersFor, questions]);

  const handleSubmitAll = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(buildFinalAnswers());
    } finally {
      setSubmitting(false);
    }
  }, [buildFinalAnswers, onSubmit, submitting]);

  const toggleOption = useCallback(
    async (label: string) => {
      if (!activeQuestion) return;
      const qId = activeQuestion.id;
      if (activeQuestion.multiSelect) {
        setSelectedByQ((prev) => {
          const cur = prev[qId] ?? [];
          const next = cur.includes(label) ? cur.filter((item) => item !== label) : [...cur, label];
          return { ...prev, [qId]: next };
        });
      } else {
        setOtherActiveByQ((prev) => ({ ...prev, [qId]: false }));
        const nextSelected = { ...selectedByQ, [qId]: [label] };
        setSelectedByQ(nextSelected);
        if (isSingleStep) {
          setSubmitting(true);
          try {
            await onSubmit({ [qId]: [label] });
          } finally {
            setSubmitting(false);
          }
        }
      }
    },
    [activeQuestion, isSingleStep, onSubmit, selectedByQ],
  );

  const activateOther = useCallback(() => {
    if (!activeQuestion) return;
    const qId = activeQuestion.id;
    setOtherActiveByQ((prev) => ({ ...prev, [qId]: true }));
    if (!activeQuestion.multiSelect) {
      setSelectedByQ((prev) => ({ ...prev, [qId]: [] }));
    }
  }, [activeQuestion]);

  useEffect(() => {
    if (!activeQuestion) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      if (e.key === "Escape") {
        e.preventDefault();
        void onDismiss();
        return;
      }

      if (inInput) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (step < totalSteps - 1) {
            setStep((s) => Math.min(totalSteps - 1, s + 1));
          } else {
            void handleSubmitAll();
          }
        }
        return;
      }

      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= 9 && num <= activeQuestion.options.length) {
        e.preventDefault();
        const opt = activeQuestion.options[num - 1];
        if (opt) {
          void toggleOption(opt.label);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (step < totalSteps - 1) {
          setStep((s) => Math.min(totalSteps - 1, s + 1));
        } else {
          void handleSubmitAll();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeQuestion, handleSubmitAll, onDismiss, step, toggleOption, totalSteps]);

  if (!activeQuestion) return null;

  const qId = activeQuestion.id;
  const currentSelected = selectedByQ[qId] ?? [];
  const otherActive = Boolean(otherActiveByQ[qId]);
  const otherText = otherTextByQ[qId] ?? "";
  const canSubmit = questions.every((q) => getEffectiveAnswersFor(q.id).length > 0);
  const currentHasAnswer = getEffectiveAnswersFor(qId).length > 0;

  return (
    <div className="border-2 border-accent bg-surface-secondary p-3 my-2 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Question className="size-4 text-accent shrink-0" weight="fill" aria-hidden="true" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-accent font-semibold">
            {activeQuestion.header || "Question"}
          </span>
          {totalSteps > 1 && (
            <span className="text-[11px] font-mono text-muted">
              [{step + 1}/{totalSteps}]
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onDismiss()}
          disabled={submitting}
          className="text-muted hover:text-foreground p-0.5 transition-colors"
          title="Dismiss question (Esc)"
          aria-label="Dismiss question"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {totalSteps > 1 && (
        <div className="flex items-center gap-1 border-b border-border pb-2 overflow-x-auto">
          {questions.map((q, idx) => {
            const answered = getEffectiveAnswersFor(q.id).length > 0;
            const active = idx === step;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setStep(idx)}
                className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : answered
                      ? "border-success/50 bg-success/10 text-success"
                      : "border-border bg-background text-muted hover:text-foreground"
                }`}
              >
                {idx + 1}. {q.header || `Q${idx + 1}`}
              </button>
            );
          })}
        </div>
      )}

      <div className="text-sm font-medium text-foreground leading-snug">
        {activeQuestion.question}
      </div>

      <div className="space-y-1.5">
        {activeQuestion.options.map((opt, idx) => {
          const isSelected = currentSelected.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              disabled={submitting}
              onClick={() => void toggleOption(opt.label)}
              className={`w-full text-left px-2.5 py-2 border transition-colors flex items-start gap-2.5 ${
                isSelected
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border bg-background hover:border-foreground-secondary text-foreground"
              }`}
            >
              <span className="text-[10px] font-mono text-muted mt-0.5 shrink-0">[{idx + 1}]</span>
              <span
                className={`mt-0.5 size-3.5 border flex items-center justify-center shrink-0 ${
                  isSelected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background"
                }`}
              >
                {isSelected && <Check className="size-2.5" weight="bold" aria-hidden="true" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">{opt.label}</div>
                {opt.description && (
                  <div className="text-[11px] text-muted mt-0.5">{opt.description}</div>
                )}
              </div>
            </button>
          );
        })}

        {(activeQuestion.isOther || activeQuestion.options.length === 0) && (
          <div
            className={`border transition-colors p-2 ${
              otherActive ? "border-accent bg-accent/5" : "border-border bg-background"
            }`}
          >
            <div className="flex items-center gap-2">
              {activeQuestion.options.length > 0 && (
                <button
                  type="button"
                  onClick={activateOther}
                  className="text-[11px] font-mono uppercase tracking-wider text-muted hover:text-foreground shrink-0"
                >
                  Other:
                </button>
              )}
              <input
                type={activeQuestion.isSecret ? "password" : "text"}
                value={otherText}
                onFocus={activateOther}
                onChange={(e) => {
                  const val = e.target.value;
                  setOtherActiveByQ((prev) => ({ ...prev, [qId]: true }));
                  if (!activeQuestion.multiSelect) {
                    setSelectedByQ((prev) => ({ ...prev, [qId]: [] }));
                  }
                  setOtherTextByQ((prev) => ({ ...prev, [qId]: val }));
                }}
                placeholder="Type custom answer..."
                aria-label="Custom answer"
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted focus:outline-none font-mono"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/60">
        <div className="text-[10px] font-mono text-muted">
          Keys: 1-9 select · Enter confirm · Esc dismiss
        </div>
        <div className="flex items-center gap-1.5">
          {totalSteps > 1 && step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="btn btn-outline btn-sm inline-flex items-center gap-1"
            >
              <ArrowLeft className="size-3" aria-hidden="true" />
              <span>Back</span>
            </button>
          )}
          {totalSteps > 1 && step < totalSteps - 1 ? (
            <button
              type="button"
              disabled={!currentHasAnswer}
              onClick={() => setStep((s) => Math.min(totalSteps - 1, s + 1))}
              className="btn btn-primary btn-sm inline-flex items-center gap-1 disabled:opacity-40"
            >
              <span>Next</span>
              <ArrowRight className="size-3" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSubmit || submitting}
              onClick={() => void handleSubmitAll()}
              className="btn btn-primary btn-sm disabled:opacity-40"
            >
              {submitting ? "Submitting..." : "Submit Answer"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
