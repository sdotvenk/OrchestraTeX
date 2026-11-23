"use client";

import {
  Check,
  GitFork,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  PushPin,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { AgentProviderId, ProviderStatus, ThreadSummary } from "@/lib/agent/types";
import { ProviderIcon } from "./icons";
import { formatRelativeTime } from "./utils";

interface ThreadListProps {
  threads: ThreadSummary[];
  activeThreadId?: string;
  providers: ProviderStatus[];
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onTogglePin: (threadId: string, pinned: boolean) => Promise<void> | void;
  onForkThread: (threadId: string) => Promise<void> | void;
  onDeleteThread: (threadId: string) => Promise<void> | void;
  onClose: () => void;
}

export function ThreadList({
  threads,
  activeThreadId,
  providers,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onTogglePin,
  onForkThread,
  onDeleteThread,
  onClose,
}: ThreadListProps) {
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | AgentProviderId>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const providerSupportMap = useMemo(() => {
    const map = new Map<AgentProviderId, ProviderStatus>();
    for (const p of providers) map.set(p.id, p);
    return map;
  }, [providers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) => {
      if (t.archived) return false;
      if (providerFilter !== "all" && t.providerId !== providerFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.lastPreview ?? "").toLowerCase().includes(q) ||
        t.providerId.toLowerCase().includes(q)
      );
    });
  }, [threads, providerFilter, search]);

  const pinnedThreads = filtered.filter((t) => t.pinned);
  const recentThreads = filtered.filter((t) => !t.pinned);

  const commitRename = async (threadId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      await onRenameThread(threadId, trimmed);
    }
    setEditingId(null);
  };

  const renderThreadRow = (thread: ThreadSummary) => {
    const isActive = thread.id === activeThreadId;
    const isEditing = editingId === thread.id;
    const canFork = providerSupportMap.get(thread.providerId)?.supportsFork ?? false;

    return (
      <div
        key={thread.id}
        className={`group rounded-xl border transition-all ${
          isActive
            ? "border-border-dark bg-panel shadow-xs"
            : "border-transparent bg-subtle/50 hover:bg-subtle"
        }`}
      >
        <div className="p-2.5 flex items-start gap-2.5">
          <div className="mt-0.5 shrink-0 flex flex-col items-center gap-1.5">
            <ProviderIcon providerId={thread.providerId} className="size-3.5" />
            {thread.status === "running" && (
              <span className="size-1.5 rounded-full bg-accent animate-pulse" title="Running" />
            )}
            {thread.status === "waiting_input" && (
              <span className="size-1.5 rounded-full bg-warn animate-pulse" title="Needs input" />
            )}
            {thread.status === "error" && (
              <span className="size-1.5 rounded-full bg-error" title="Error" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename(thread.id);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  aria-label="Edit thread title"
                  className="flex-1 px-2 py-1 rounded-md text-xs border border-accent bg-panel text-foreground focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void commitRename(thread.id)}
                  className="size-6 rounded-md inline-flex items-center justify-center text-accent hover:bg-accent-soft"
                  title="Save title"
                  aria-label="Save title"
                >
                  <Check className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onSelectThread(thread.id);
                  onClose();
                }}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-foreground-strong truncate">
                    {thread.title}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground shrink-0">
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                </div>
                {thread.lastPreview && (
                  <div className="text-[11.5px] text-muted truncate mt-0.5">
                    {thread.lastPreview}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1 text-[10.5px] text-muted-foreground">
                  <span className="font-mono">{thread.model || thread.providerId}</span>
                  <span>·</span>
                  <span>{thread.messageCount} msgs</span>
                </div>
              </button>
            )}
          </div>
        </div>

        {!isEditing && (
          <div className="px-2 pb-1.5 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => void onTogglePin(thread.id, !thread.pinned)}
              className={`size-6 rounded-md inline-flex items-center justify-center hover:bg-panel ${
                thread.pinned ? "text-accent" : "text-muted hover:text-foreground"
              }`}
              title={thread.pinned ? "Unpin thread" : "Pin thread"}
              aria-label={thread.pinned ? "Unpin thread" : "Pin thread"}
            >
              <PushPin
                className="size-3"
                weight={thread.pinned ? "fill" : "regular"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(thread.id);
                setEditingTitle(thread.title);
              }}
              className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-panel"
              title="Rename thread"
              aria-label="Rename thread"
            >
              <PencilSimple className="size-3" aria-hidden="true" />
            </button>
            {canFork && (
              <button
                type="button"
                onClick={() => void onForkThread(thread.id)}
                className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-panel"
                title="Fork thread"
                aria-label="Fork thread"
              >
                <GitFork className="size-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void onDeleteThread(thread.id)}
              className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-error hover:bg-panel"
              title="Delete thread"
              aria-label="Delete thread"
            >
              <Trash className="size-3" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-panel">
      <div className="p-3 border-b border-border space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-foreground-strong">
            Chats ({filtered.length})
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                onCreateThread();
                onClose();
              }}
              className="btn btn-primary btn-sm"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>New chat</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle"
              aria-label="Close thread list"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="relative">
          <MagnifyingGlass
            className="size-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats..."
            aria-label="Filter threads"
            className="w-full h-8 pl-8 pr-3 rounded-full bg-subtle text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          {(
            [
              { id: "all", label: "All" },
              { id: "claude", label: "Claude" },
              { id: "codex", label: "Codex" },
              { id: "antigravity", label: "Antigravity" },
              { id: "custom-acp", label: "ACP" },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setProviderFilter(f.id)}
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                providerFilter === f.id
                  ? "bg-accent-soft text-accent"
                  : "bg-subtle text-muted hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted text-center py-10">
            No matching chats yet. Start a new conversation.
          </div>
        ) : (
          <>
            {pinnedThreads.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted px-1">Pinned</div>
                <div className="space-y-1">{pinnedThreads.map(renderThreadRow)}</div>
              </div>
            )}
            {recentThreads.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted px-1">Recent</div>
                <div className="space-y-1">{recentThreads.map(renderThreadRow)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
