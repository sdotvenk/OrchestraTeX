"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentProviderId } from "@/lib/agent/types";
import { ProviderIcon } from "./icons";
import {
  type BranchPullRequest,
  getProjectName,
  getProviderMeta,
  type OrchestrationThreadSummary,
} from "./orchestration-types";

export type ThreadFilterMode = "all" | "running" | "needs_you";

export interface OrchestrationSidebarProps {
  threads: OrchestrationThreadSummary[];
  activeThreadId?: string | null;
  activeProjectPath?: string | null;
  prByThreadId?: Record<string, BranchPullRequest | null | undefined>;
  prByBranch?: Record<string, BranchPullRequest | null | undefined>;
  onOpenThread: (thread: OrchestrationThreadSummary) => void;
  onNewThread?: () => void;
  onOpenUsage?: () => void;
  todayUsageByProvider?: Array<{ providerId: AgentProviderId; tokens: number }>;
  className?: string;
}

function getStatusBadge(
  status: string,
  messageCount = 0,
): {
  label: string;
  tone: "running" | "warn" | "error" | "idle";
} {
  switch (status) {
    case "running":
      return { label: "running", tone: "running" };
    case "waiting_input":
      return { label: "Approve", tone: "warn" };
    case "error":
      return { label: "error", tone: "error" };
    default:
      return { label: messageCount > 0 ? "done" : "idle", tone: "idle" };
  }
}

function formatScheduleTime(runAt?: number | null): string | null {
  if (runAt == null || !Number.isFinite(runAt)) return null;
  const date = new Date(runAt);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function OrchestrationSidebar({
  threads,
  activeThreadId,
  activeProjectPath,
  prByThreadId,
  prByBranch,
  onOpenThread,
  onNewThread,
  onOpenUsage,
  todayUsageByProvider,
  className = "",
}: OrchestrationSidebarProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThreadFilterMode>("all");
  const [showArchivedByProject, setShowArchivedByProject] = useState<Record<string, boolean>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const counts = useMemo(() => {
    let running = 0;
    let needsYou = 0;
    for (const thread of threads) {
      if (thread.archived) continue;
      if (thread.status === "running") running += 1;
      if (thread.status === "waiting_input" || thread.status === "error") needsYou += 1;
    }
    return { running, needsYou };
  }, [threads]);

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads.filter((thread) => {
      if (filter === "running" && thread.status !== "running") return false;
      if (
        filter === "needs_you" &&
        thread.status !== "waiting_input" &&
        thread.status !== "error"
      ) {
        return false;
      }
      if (!q) return true;
      const projectName = getProjectName(thread.projectPath).toLowerCase();
      const branch = thread.workspaceBranch?.toLowerCase() ?? "";
      return (
        thread.title.toLowerCase().includes(q) ||
        projectName.includes(q) ||
        branch.includes(q) ||
        thread.providerId.toLowerCase().includes(q)
      );
    });
  }, [threads, filter, query]);

  const pinnedThreads = useMemo(
    () => filteredThreads.filter((t) => t.pinned && !t.archived),
    [filteredThreads],
  );

  const scheduledThreads = useMemo(
    () => filteredThreads.filter((t) => t.schedule != null && !t.archived),
    [filteredThreads],
  );

  const projectGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        projectPath: string;
        projectName: string;
        active: OrchestrationThreadSummary[];
        archived: OrchestrationThreadSummary[];
      }
    >();

    for (const thread of filteredThreads) {
      if (thread.schedule != null && !thread.archived) continue;
      let group = map.get(thread.projectPath);
      if (!group) {
        group = {
          projectPath: thread.projectPath,
          projectName: getProjectName(thread.projectPath),
          active: [],
          archived: [],
        };
        map.set(thread.projectPath, group);
      }
      if (thread.archived) {
        group.archived.push(thread);
      } else {
        group.active.push(thread);
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (activeProjectPath && a.projectPath === activeProjectPath) return -1;
      if (activeProjectPath && b.projectPath === activeProjectPath) return 1;
      return a.projectName.localeCompare(b.projectName);
    });
  }, [filteredThreads, activeProjectPath]);

  const renderThreadRow = (thread: OrchestrationThreadSummary, isChild = false) => {
    const isActive = thread.id === activeThreadId;
    const provider = getProviderMeta(thread.providerId);
    const status = getStatusBadge(thread.status, thread.messageCount);
    const pr =
      prByThreadId?.[thread.id] ??
      (thread.workspaceBranch ? prByBranch?.[thread.workspaceBranch] : undefined);
    const scheduleTime = thread.schedule ? formatScheduleTime(thread.schedule.runAt) : null;

    return (
      <button
        key={thread.id}
        type="button"
        onClick={() => onOpenThread(thread)}
        aria-current={isActive ? "true" : undefined}
        className={`group relative flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
          isChild ? "ml-4 w-[calc(100%-1rem)]" : "w-full"
        } ${
          isActive
            ? "bg-[var(--panel)] ring-1 ring-[var(--border)] shadow-xs"
            : "hover:bg-[var(--subtle)]"
        }`}
      >
        {isChild && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-2.5 top-0 h-4 w-2.5 rounded-bl-md border-b border-l border-[var(--border)]"
          />
        )}
        <span
          aria-hidden="true"
          className="mt-0.5 h-4 w-[3px] shrink-0 rounded-full"
          style={{
            backgroundColor: provider.colorVar,
            opacity: thread.status === "idle" && !isActive ? 0.45 : 1,
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-[var(--foreground)]">
              {thread.title || "Untitled thread"}
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-[10.5px] font-medium">
              {status.tone === "warn" ? (
                <span className="rounded-full border border-[var(--warn-line)] bg-warn-bg px-1.5 text-[10.5px] font-semibold leading-4 text-warn whitespace-nowrap">
                  {status.label}
                </span>
              ) : status.tone === "error" ? (
                <span className="rounded-full border border-[var(--danger)] bg-[var(--danger-bg)] px-1.5 py-0.5 text-[var(--danger)] whitespace-nowrap">
                  {status.label}
                </span>
              ) : status.tone === "running" ? (
                <span style={{ color: provider.colorVar }}>{status.label}</span>
              ) : (
                <span className="text-[var(--muted-foreground)]">
                  {scheduleTime ?? status.label}
                </span>
              )}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-[11px] text-[var(--muted-foreground)]">
            <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
              <span style={{ color: provider.colorVar }} className="inline-flex shrink-0">
                <ProviderIcon providerId={thread.providerId} className="size-3 shrink-0" />
              </span>
              {provider.label}
            </span>
            {thread.parentThreadId && (
              <span className="shrink-0 whitespace-nowrap">· delegated</span>
            )}
            {thread.workspaceBranch && (
              <span className="max-w-[120px] truncate rounded border border-[var(--border)] px-1 font-mono text-[10px] text-[var(--foreground-secondary)]">
                {thread.workspaceBranch}
              </span>
            )}
            {pr && (
              <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-[var(--ok)]">
                PR #{pr.number}
                {pr.isDraft ? " (draft)" : ""}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <aside
      aria-label="Orchestration threads"
      className={`flex h-full w-[284px] shrink-0 flex-col gap-1.5 bg-[var(--bg)] p-2 text-[var(--foreground)] ${className}`}
    >
      <div className="flex items-center gap-1.5">
        <div className="relative flex flex-1 min-w-0 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                searchInputRef.current?.blur();
              }
            }}
            placeholder="Search threads"
            aria-label="Search threads"
            className="w-full min-w-0 overflow-hidden text-ellipsis bg-transparent text-[12.5px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="ml-1 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <kbd className="ml-1 shrink-0 font-mono text-[10px] text-[var(--muted-foreground)]">
              ⌘K
            </kbd>
          )}
        </div>
        {onNewThread && (
          <button
            type="button"
            onClick={onNewThread}
            className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-border-dark bg-panel px-2.5 py-1 text-[12.5px] font-medium text-foreground-strong hover:bg-subtle transition-colors"
          >
            + New
          </button>
        )}
      </div>

      <div
        className="flex items-center gap-1 py-0.5 text-[11.5px]"
        role="tablist"
        aria-label="Filter threads"
      >
        <button
          type="button"
          role="tab"
          aria-selected={filter === "all"}
          onClick={() => setFilter("all")}
          className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
            filter === "all"
              ? "bg-[var(--foreground)] text-[var(--panel)]"
              : "border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          All
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === "running"}
          onClick={() => setFilter("running")}
          className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
            filter === "running"
              ? "bg-[var(--foreground)] text-[var(--panel)]"
              : "border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          Running {counts.running}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === "needs_you"}
          onClick={() => setFilter("needs_you")}
          className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
            filter === "needs_you"
              ? "bg-[var(--warn)] text-[var(--panel)]"
              : "border border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]"
          }`}
        >
          Needs you {counts.needsYou}
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto pr-0.5">
        {pinnedThreads.length > 0 && (
          <section aria-label="Pinned threads">
            <div className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Pinned
            </div>
            <div className="space-y-0.5">{pinnedThreads.map((t) => renderThreadRow(t))}</div>
          </section>
        )}

        {projectGroups.map((group) => {
          const activeIds = new Set(group.active.map((t) => t.id));
          const topLevel = group.active.filter(
            (t) => !t.parentThreadId || !activeIds.has(t.parentThreadId),
          );
          const childrenByParent = new Map<string, OrchestrationThreadSummary[]>();
          for (const t of group.active) {
            if (t.parentThreadId && activeIds.has(t.parentThreadId)) {
              const list = childrenByParent.get(t.parentThreadId) ?? [];
              list.push(t);
              childrenByParent.set(t.parentThreadId, list);
            }
          }
          const isArchivedOpen = Boolean(showArchivedByProject[group.projectPath]);

          return (
            <section key={group.projectPath} aria-label={group.projectName}>
              <div className="flex items-center px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                <span className="truncate">{group.projectName}</span>
                <span className="ml-auto font-mono text-[10.5px]">{group.active.length}</span>
              </div>
              <div className="space-y-0.5">
                {topLevel.map((thread) => {
                  const children = childrenByParent.get(thread.id) ?? [];
                  return (
                    <div key={thread.id} className="space-y-0.5">
                      {renderThreadRow(thread)}
                      {children.map((child) => renderThreadRow(child, true))}
                    </div>
                  );
                })}
                {group.archived.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setShowArchivedByProject((prev) => ({
                          ...prev,
                          [group.projectPath]: !prev[group.projectPath],
                        }))
                      }
                      aria-expanded={isArchivedOpen}
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-[var(--muted-foreground)] hover:bg-[var(--subtle)]"
                    >
                      {isArchivedOpen ? (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 16 16"
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 16 16"
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      <span>Settled</span>
                      <span className="ml-auto font-mono text-[10.5px]">
                        {group.archived.length}
                      </span>
                    </button>
                    {isArchivedOpen && (
                      <div className="mt-0.5 space-y-0.5 opacity-80">
                        {group.archived.map((t) => renderThreadRow(t))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })}

        {scheduledThreads.length > 0 && (
          <section aria-label="Scheduled threads">
            <div className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Scheduled
            </div>
            <div className="space-y-0.5">{scheduledThreads.map((t) => renderThreadRow(t))}</div>
          </section>
        )}

        {filteredThreads.length === 0 && (
          <div className="px-2 py-4 text-center text-[12px] text-[var(--muted-foreground)]">
            No matching threads
          </div>
        )}
      </div>

      {onOpenUsage && (
        <button
          type="button"
          onClick={onOpenUsage}
          className="mt-auto flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--foreground-secondary)] hover:bg-[var(--subtle)]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M3 13V8M7 13V4M11 13V7M15 13H1" strokeLinecap="round" />
          </svg>
          <span>Usage &amp; limits</span>
          <span
            aria-hidden="true"
            className="ml-auto flex h-[4px] w-[70px] gap-0.5 overflow-hidden rounded-[2px]"
          >
            {todayUsageByProvider?.some((item) => item.tokens > 0) ? (
              todayUsageByProvider
                .filter((item) => item.tokens > 0)
                .map((item) => (
                  <span
                    key={item.providerId}
                    className="h-full rounded-[2px]"
                    style={{
                      flexGrow: item.tokens,
                      backgroundColor: getProviderMeta(item.providerId).colorVar,
                    }}
                  />
                ))
            ) : (
              <span className="h-full w-full rounded-[2px] bg-border" />
            )}
          </span>
        </button>
      )}
    </aside>
  );
}
