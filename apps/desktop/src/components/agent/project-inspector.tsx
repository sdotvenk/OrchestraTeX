"use client";

import type { GitStatus } from "@orchestratex/shared";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import type { AgentProviderId } from "@/lib/agent/types";
import { ProviderIcon } from "./icons";
import {
  type BranchPullRequest,
  formatShortPath,
  getProviderMeta,
  type OrchestrationThreadSummary,
} from "./orchestration-types";

export type InspectorTab = "project" | "diff" | "pdf" | "terminal";

export interface DelegateTaskInput {
  providerId: AgentProviderId;
  title: string;
  prompt: string;
}

export interface ScheduleThreadInput {
  providerId: AgentProviderId;
  title: string;
  prompt: string;
  runAt: number;
  repeatIntervalMs?: number | null;
}

export interface ProjectInspectorProps {
  projectPath?: string | null;
  workspacePath?: string | null;
  workspaceBranch?: string | null;
  isWritable?: boolean;
  gitStatus?: GitStatus | null;
  branchPr?: BranchPullRequest | null;
  activeThread?: OrchestrationThreadSummary | null;
  threads?: OrchestrationThreadSummary[];
  error?: string | null;
  diffPanel?: ReactNode;
  pdfPanel?: ReactNode;
  terminalPanel?: ReactNode;
  onRevealProject?: () => void;
  onPull?: () => Promise<void> | void;
  onPush?: () => Promise<void> | void;
  onReviewChanges?: () => void;
  onCommitAndPr?: () => Promise<void>;
  onOpenThread?: (thread: OrchestrationThreadSummary) => void;
  onDelegate?: (input: DelegateTaskInput) => Promise<void> | void;
  onSchedule?: (input: ScheduleThreadInput) => Promise<void> | void;
  onCreateWorktree?: () => Promise<void>;
  onCancelSchedule?: () => Promise<void>;
  onMergeWorktree?: () => Promise<void>;
  lastBuild?: {
    mainFile?: string | null;
    durationMs?: number | null;
    builtAt?: number | null;
    status: "idle" | "compiling" | "success" | "error";
    staleAgentEdits?: number;
    errorCount?: number;
    pageCount?: number | null;
  };
  fileVoiceByPath?: Record<string, AgentProviderId>;
  className?: string;
}

const PROVIDER_OPTIONS: { id: AgentProviderId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "custom-acp", label: "Custom ACP" },
];

const REPEAT_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "Once", ms: null },
  { label: "Hourly", ms: 3_600_000 },
  { label: "Daily", ms: 86_400_000 },
  { label: "Weekly", ms: 604_800_000 },
];

function formatInspectorError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw.trim();
  if (/^(TypeError|ReferenceError|SyntaxError):/i.test(firstLine)) {
    return "Orchestration action could not be completed. Please try again.";
  }
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export function ProjectInspector({
  projectPath,
  workspacePath,
  workspaceBranch,
  isWritable = true,
  gitStatus,
  branchPr,
  activeThread,
  threads = [],
  error,
  diffPanel,
  pdfPanel,
  terminalPanel,
  onRevealProject,
  onPull,
  onPush,
  onReviewChanges,
  onCommitAndPr,
  onOpenThread,
  onDelegate,
  onSchedule,
  onCreateWorktree,
  onCancelSchedule,
  onMergeWorktree,
  lastBuild,
  fileVoiceByPath,
  className = "",
}: ProjectInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("project");
  const [activeForm, setActiveForm] = useState<"none" | "delegate" | "schedule">("none");

  const [providerId, setProviderId] = useState<AgentProviderId>(
    activeThread?.providerId ?? "codex",
  );
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dateValue, setDateValue] = useState("");
  const [repeatMs, setRepeatMs] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);

  const runCheckoutAction = async (action: () => Promise<void>) => {
    setCheckoutError(null);
    setCheckoutPending(true);
    try {
      await action();
    } catch (cause) {
      setCheckoutError(String(cause));
    } finally {
      setCheckoutPending(false);
    }
  };

  const lineage = useMemo(() => {
    if (!activeThread) return { ancestors: [], children: [] };
    const byId = new Map(threads.map((t) => [t.id, t]));
    const ancestors: OrchestrationThreadSummary[] = [];
    let cursor = activeThread.parentThreadId ? byId.get(activeThread.parentThreadId) : undefined;
    const seen = new Set<string>([activeThread.id]);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      ancestors.unshift(cursor);
      cursor = cursor.parentThreadId ? byId.get(cursor.parentThreadId) : undefined;
    }
    const children = threads.filter((t) => t.parentThreadId === activeThread.id);
    return { ancestors, children };
  }, [activeThread, threads]);

  const displayPath = workspacePath || projectPath;
  const displayBranch = workspaceBranch || gitStatus?.branch;

  const resetForm = () => {
    setTitle("");
    setPrompt("");
    setDateValue("");
    setRepeatMs(null);
    setFormError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!prompt.trim()) {
      setFormError("Prompt is required.");
      return;
    }
    if (activeForm === "schedule") {
      if (!dateValue) {
        setFormError("Run date & time is required.");
        return;
      }
      const runAt = new Date(dateValue).getTime();
      if (!Number.isFinite(runAt)) {
        setFormError("Invalid date & time.");
        return;
      }
      if (!onSchedule) {
        setFormError("Scheduling is not available.");
        return;
      }
      try {
        setSubmitting(true);
        await onSchedule({
          providerId,
          title: title.trim() || prompt.trim().slice(0, 48),
          prompt: prompt.trim(),
          runAt,
          repeatIntervalMs: repeatMs,
        });
        resetForm();
        setActiveForm("none");
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (activeForm === "delegate") {
      if (!onDelegate) {
        setFormError("Delegation is not available.");
        return;
      }
      try {
        setSubmitting(true);
        await onDelegate({
          providerId,
          title: title.trim() || prompt.trim().slice(0, 48),
          prompt: prompt.trim(),
        });
        resetForm();
        setActiveForm("none");
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    }
  };

  return (
    <aside
      aria-label="Project inspector"
      className={`flex h-full w-[308px] shrink-0 flex-col gap-2 bg-[var(--bg)] p-2 text-[var(--foreground)] ${className}`}
    >
      <div
        role="tablist"
        aria-label="Inspector surface"
        className="flex gap-0.5 rounded-lg bg-[var(--sunken)] p-0.5 text-[12px]"
      >
        {(
          [
            { id: "project", label: "Project" },
            { id: "diff", label: "Diff" },
            { id: "pdf", label: "PDF" },
            { id: "terminal", label: "Terminal" },
          ] as const
        )
          .filter(
            ({ id }) =>
              id === "project" ||
              (id === "diff" && diffPanel != null) ||
              (id === "pdf" && pdfPanel != null) ||
              (id === "terminal" && terminalPanel != null),
          )
          .map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`flex-1 rounded-md py-1 font-medium transition-colors ${
                tab === item.id
                  ? "bg-[var(--panel)] text-[var(--foreground)] shadow-xs"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {item.label}
            </button>
          ))}
      </div>

      {tab === "diff" && <div className="min-h-0 flex-1 overflow-auto">{diffPanel}</div>}
      {tab === "pdf" && <div className="min-h-0 flex-1 overflow-auto">{pdfPanel}</div>}
      {tab === "terminal" && <div className="min-h-0 flex-1 overflow-auto">{terminalPanel}</div>}

      {(tab === "project" ||
        (tab === "diff" && diffPanel == null) ||
        (tab === "pdf" && pdfPanel == null) ||
        (tab === "terminal" && terminalPanel == null)) && (
        <div className="flex-1 space-y-2 overflow-y-auto pr-0.5">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium">Checkout</span>
              {!isWritable && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--warn)] bg-[var(--warn-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--warn)]">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-2.5 w-2.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <rect x="3" y="7" width="10" height="7" rx="1.5" />
                    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                  </svg>
                  Read-only
                </span>
              )}
              {onRevealProject && displayPath && (
                <button
                  type="button"
                  onClick={onRevealProject}
                  className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z" />
                  </svg>
                  Reveal
                </button>
              )}
            </div>
            {displayPath && (
              <div className="mt-1 truncate font-mono text-[11.5px] text-[var(--foreground-secondary)]">
                {formatShortPath(displayPath)}
              </div>
            )}
            {displayBranch && (
              <div className="mt-2 flex items-center gap-1.5 text-[11.5px]">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="5" cy="4" r="1.5" />
                  <circle cx="11" cy="4" r="1.5" />
                  <circle cx="5" cy="12" r="1.5" />
                  <path d="M5 5.5v5M11 5.5c0 2.5-6 2-6 5" />
                </svg>
                <span className="font-mono font-medium">{displayBranch}</span>
                {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                  <span className="font-mono text-[11px] text-[var(--muted-foreground)]">
                    {gitStatus.ahead > 0 ? `↑${gitStatus.ahead}` : ""}
                    {gitStatus.behind > 0 ? `↓${gitStatus.behind}` : ""}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2 text-[11.5px] text-[var(--muted-foreground)]">
                  {onPull && (
                    <button
                      type="button"
                      onClick={() => void onPull()}
                      className="hover:text-[var(--foreground)]"
                    >
                      Pull
                    </button>
                  )}
                  {onPush && (
                    <button
                      type="button"
                      onClick={() => void onPush()}
                      disabled={!isWritable}
                      className="hover:text-[var(--foreground)] disabled:opacity-40"
                    >
                      Push
                    </button>
                  )}
                </div>
              </div>
            )}
            {branchPr && (
              <button
                type="button"
                title={branchPr.title}
                className="mt-2 flex items-center gap-1.5 text-left text-[11.5px]"
                onClick={() =>
                  void runCheckoutAction(async () => {
                    const { open } = await import("@tauri-apps/plugin-shell");
                    await open(branchPr.url);
                  })
                }
              >
                <span className="shrink-0 whitespace-nowrap font-mono text-[var(--ok)]">
                  PR #{branchPr.number}
                </span>
                <span className="truncate text-[var(--foreground-secondary)]">
                  {branchPr.title}
                </span>
              </button>
            )}
            {onCreateWorktree && (
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-2"
                disabled={checkoutPending}
                onClick={() => void runCheckoutAction(onCreateWorktree)}
              >
                Create thread worktree
              </button>
            )}
            {onMergeWorktree && (
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-2"
                disabled={checkoutPending}
                onClick={() => void runCheckoutAction(onMergeWorktree)}
              >
                Merge into project…
              </button>
            )}
            {checkoutError && (
              <p role="alert" className="mt-2 text-xs text-error">
                {checkoutError}
              </p>
            )}
          </section>
          <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            {(() => {
              const uniqueChanges = new Map<string, { path: string; status: string }>();
              for (const change of gitStatus?.changes ?? []) {
                const existing = uniqueChanges.get(change.path);
                if (!existing || change.status === "conflict") {
                  uniqueChanges.set(change.path, { path: change.path, status: change.status });
                }
              }
              const dedupedList = Array.from(uniqueChanges.values());
              return (
                <>
                  <div className="flex items-center">
                    <span className="text-[12.5px] font-medium">Working changes</span>
                    <span className="ml-auto font-mono text-[11px] text-[var(--muted-foreground)]">
                      {dedupedList.length}
                    </span>
                  </div>
                  {dedupedList.length > 0 && (
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                      {dedupedList.slice(0, 8).map((change) => {
                        const voiceProvider = fileVoiceByPath?.[change.path];
                        return (
                          <div
                            key={change.path}
                            className="flex items-center gap-2 font-mono text-[11.5px] text-[var(--foreground-secondary)]"
                          >
                            {voiceProvider && (
                              <span
                                aria-hidden="true"
                                className="h-[7px] w-[7px] shrink-0 rounded-full"
                                style={{
                                  backgroundColor: getProviderMeta(voiceProvider).colorVar,
                                }}
                              />
                            )}
                            <span className="truncate">{change.path}</span>
                            <span className="ml-auto shrink-0 text-[10.5px] text-[var(--muted-foreground)]">
                              {change.status === "conflict" ? "!" : change.status[0]?.toUpperCase()}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
            {(onReviewChanges || onCommitAndPr) && (
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                {onReviewChanges && (
                  <button
                    type="button"
                    onClick={onReviewChanges}
                    className="btn btn-secondary btn-sm whitespace-nowrap"
                  >
                    Review
                  </button>
                )}
                {onCommitAndPr && (
                  <button
                    type="button"
                    onClick={() => void runCheckoutAction(onCommitAndPr)}
                    disabled={!isWritable || checkoutPending}
                    className="btn btn-secondary btn-sm whitespace-nowrap disabled:opacity-40"
                  >
                    Commit &amp; PR…
                  </button>
                )}
              </div>
            )}
          </section>
          {lastBuild && (
            <section className="ox-frame flex gap-3 p-3">
              <div
                aria-hidden="true"
                className="flex h-[68px] w-[52px] shrink-0 flex-col gap-[3px] rounded-[2px] bg-background p-1.5 shadow-xs ring-1 ring-border"
              >
                <span className="h-[4px] w-[70%] bg-foreground/75" />
                <span className="h-[2px] w-full bg-muted/40" />
                <span className="h-[2px] w-full bg-muted/40" />
                <span className="mt-0.5 h-[13px] w-full bg-gradient-to-r from-[var(--voice-claude-ink)]/60 via-subtle to-[var(--voice-codex-ink)]/60" />
                <span className="h-[2px] w-full bg-muted/40" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-medium">Last build</span>
                  {lastBuild.status === "success" && (
                    <span className="ml-auto rounded-full border border-[var(--ok-line)] bg-success-bg px-1.5 text-[11px] text-success">
                      ✓{" "}
                      {lastBuild.builtAt
                        ? new Date(lastBuild.builtAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "OK"}
                    </span>
                  )}
                  {lastBuild.status === "error" && (
                    <span className="ml-auto rounded-full border border-error/40 bg-error-bg px-1.5 text-[11px] text-error">
                      {lastBuild.errorCount != null
                        ? `${lastBuild.errorCount} ${lastBuild.errorCount === 1 ? "error" : "errors"}`
                        : "Failed"}
                    </span>
                  )}
                  {lastBuild.status === "compiling" && (
                    <span className="ml-auto rounded-full border border-border bg-subtle px-1.5 text-[11px] text-muted">
                      Compiling
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate font-mono text-[11.5px] text-muted">
                  {[
                    lastBuild.mainFile?.split("/").pop() || "main.tex",
                    lastBuild.pageCount != null ? `${lastBuild.pageCount} pp` : null,
                    lastBuild.durationMs != null ? `${lastBuild.durationMs} ms` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {lastBuild.staleAgentEdits != null && lastBuild.staleAgentEdits > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--voice-claude-text)]">
                    <span
                      aria-hidden="true"
                      className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--voice-claude-ink)]"
                    />
                    <span>
                      {lastBuild.staleAgentEdits} agent{" "}
                      {lastBuild.staleAgentEdits === 1 ? "edit" : "edits"} since
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="flex items-center">
              <span className="text-[12.5px] font-medium">Orchestration</span>
              {activeThread && (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                  <ProviderIcon providerId={activeThread.providerId} className="size-3 shrink-0" />
                  {getProviderMeta(activeThread.providerId).label}
                </span>
              )}
            </div>

            {activeThread && (
              <div className="mt-2 space-y-1 text-[12px]">
                {lineage.ancestors.map((ancestor, idx) => (
                  <button
                    key={ancestor.id}
                    type="button"
                    onClick={() => onOpenThread?.(ancestor)}
                    style={{ paddingLeft: `${idx * 10}px` }}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[var(--muted-foreground)] hover:bg-[var(--subtle)]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: getProviderMeta(ancestor.providerId).colorVar }}
                    />
                    <span className="truncate">{ancestor.title}</span>
                  </button>
                ))}
                <div
                  style={{ paddingLeft: `${lineage.ancestors.length * 10}px` }}
                  className="flex items-center gap-1.5 px-1 py-0.5 font-medium text-[var(--foreground)]"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: getProviderMeta(activeThread.providerId).colorVar }}
                  />
                  <span className="truncate">{activeThread.title}</span>
                  <span className="ml-auto text-[10.5px] text-[var(--muted-foreground)]">this</span>
                </div>
                {lineage.children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onOpenThread?.(child)}
                    style={{ paddingLeft: `${(lineage.ancestors.length + 1) * 10}px` }}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[var(--foreground-secondary)] hover:bg-[var(--subtle)]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: getProviderMeta(child.providerId).colorVar }}
                    />
                    <span className="truncate">{child.title}</span>
                    <span className="ml-auto shrink-0 whitespace-nowrap text-[10.5px] text-[var(--muted-foreground)]">
                      {child.status === "idle" && child.messageCount > 0 ? "done" : child.status}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {(onDelegate || onSchedule) && (
              <div className="mt-2.5 flex flex-col gap-1.5">
                {onDelegate && (
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setActiveForm((prev) => (prev === "delegate" ? "none" : "delegate"));
                    }}
                    className="w-full rounded-[7px] border border-dashed border-border-dark bg-transparent py-1 text-[12px] text-muted transition-colors hover:bg-subtle hover:text-foreground"
                  >
                    Delegate a task…
                  </button>
                )}
                {onSchedule && (
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setActiveForm((prev) => (prev === "schedule" ? "none" : "schedule"));
                    }}
                    className="btn-secondary inline-flex w-full items-center justify-center gap-1 rounded-[7px] py-1 text-[11.5px] font-medium"
                  >
                    Schedule…
                  </button>
                )}
              </div>
            )}
            {onCancelSchedule && (
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-2"
                disabled={checkoutPending}
                onClick={() => void runCheckoutAction(onCancelSchedule)}
              >
                Cancel schedule
              </button>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-error">
                {formatInspectorError(error)}
              </p>
            )}

            {activeForm !== "none" && (
              <form
                onSubmit={handleSubmit}
                className="mt-2.5 space-y-2 border-t border-[var(--border)] pt-2.5"
              >
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--muted-foreground)]">
                    Provider
                    <select
                      value={providerId}
                      onChange={(e) => setProviderId(e.target.value as AgentProviderId)}
                      className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--foreground)]"
                    >
                      {PROVIDER_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--muted-foreground)]">
                    Title
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Optional"
                      className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                    />
                  </label>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--muted-foreground)]">
                    Prompt
                    <textarea
                      rows={2}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={
                        activeForm === "delegate"
                          ? "Task for child thread"
                          : "Prompt to run on schedule"
                      }
                      className="mt-0.5 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                    />
                  </label>
                </div>

                {activeForm === "schedule" && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="block text-[11px] font-medium text-[var(--muted-foreground)]">
                      Run at
                      <input
                        type="datetime-local"
                        value={dateValue}
                        onChange={(e) => setDateValue(e.target.value)}
                        className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[11px] text-[var(--foreground)]"
                      />
                    </label>
                    <label className="block text-[11px] font-medium text-[var(--muted-foreground)]">
                      Repeat
                      <select
                        value={repeatMs ?? ""}
                        onChange={(e) =>
                          setRepeatMs(e.target.value ? Number(e.target.value) : null)
                        }
                        className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[11px] text-[var(--foreground)]"
                      >
                        {REPEAT_OPTIONS.map((opt) => (
                          <option key={opt.label} value={opt.ms ?? ""}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {formError && (
                  <p role="alert" className="text-[11.5px] text-[var(--danger)]">
                    {formError}
                  </p>
                )}

                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      resetForm();
                      setActiveForm("none");
                    }}
                    className="btn-ghost rounded-md px-2 py-1 text-[11.5px]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="btn-primary rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                  >
                    {submitting ? "Saving..." : activeForm === "delegate" ? "Delegate" : "Schedule"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
