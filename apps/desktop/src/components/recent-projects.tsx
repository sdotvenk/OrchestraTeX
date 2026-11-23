"use client";

import { FolderIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { formatRelativeTime } from "@/components/agent/utils";
import type { RecentProject } from "@/lib/recent-projects";

export function RecentProjects({
  projects,
  onSelect,
  onRemove,
  onClearAll,
}: {
  projects: RecentProject[];
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  onClearAll: () => void;
}) {
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  if (projects.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-[760px] mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[12px] font-medium text-muted">Recent papers</h3>
        <button
          type="button"
          onClick={() => setShowClearConfirm(true)}
          className="text-[12px] text-muted hover:text-foreground transition-colors"
        >
          Clear all
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {projects.map((project) => {
          const timeStr = formatRelativeTime(new Date(project.lastOpened).getTime());
          return (
            <div
              key={project.path}
              className="group relative rounded-xl border border-border bg-panel hover:border-border-dark transition-all overflow-hidden flex flex-col"
              style={{ boxShadow: "var(--shadow-1)" }}
            >
              <button
                type="button"
                onClick={() => onSelect(project.path)}
                className="flex-1 text-left flex flex-col min-w-0"
              >
                {/* Clean miniature paper-sheet thumbnail */}
                <div className="h-24 w-full bg-stage px-5 pt-3 flex justify-center overflow-hidden border-b border-border/60">
                  <div className="w-full max-w-[140px] bg-white rounded-t-[3px] shadow-xs px-3 py-2.5 flex flex-col gap-1.5 border border-black/5">
                    <div className="h-1.5 w-3/4 mx-auto rounded-full bg-neutral-800/75" />
                    <div className="h-1 w-1/2 mx-auto rounded-full bg-neutral-400/60 mb-1" />
                    <div className="grid grid-cols-2 gap-1.5">
                      <div className="space-y-1">
                        <div className="h-1 w-full rounded-full bg-neutral-300/80" />
                        <div className="h-1 w-5/6 rounded-full bg-neutral-300/80" />
                        <div className="h-4 w-full rounded-[2px] bg-accent-soft/80 border border-border/60" />
                      </div>
                      <div className="space-y-1">
                        <div className="h-1 w-full rounded-full bg-neutral-300/80" />
                        <div className="h-1 w-full rounded-full bg-neutral-300/80" />
                        <div className="h-1 w-4/5 rounded-full bg-neutral-300/80" />
                        <div className="h-1 w-5/6 rounded-full bg-neutral-300/80" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-3 space-y-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FolderIcon className="size-3.5 text-muted shrink-0" />
                    <p className="text-[13px] font-semibold text-foreground-strong truncate">
                      {project.name}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                    <span className="truncate font-mono text-[10.5px] opacity-80">
                      {project.path}
                    </span>
                    <span className="shrink-0 tabular-nums">{timeStr}</span>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirmPath(project.path);
                }}
                className="absolute top-2 right-2 size-7 rounded-lg bg-panel/90 border border-border text-muted hover:text-error opacity-0 group-hover:opacity-100 inline-flex items-center justify-center transition-all"
                title="Remove from history"
                aria-label={`Remove ${project.name} from recent projects`}
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {deleteConfirmPath && (
        <ConfirmDialog
          message="Remove this paper from recent history?"
          onConfirm={() => {
            onRemove(deleteConfirmPath);
            setDeleteConfirmPath(null);
          }}
          onCancel={() => setDeleteConfirmPath(null)}
        />
      )}

      {showClearConfirm && (
        <ConfirmDialog
          message="Clear all recent papers from history?"
          onConfirm={() => {
            onClearAll();
            setShowClearConfirm(false);
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[2px] modal-overlay">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="fixed inset-0 cursor-default"
      />
      <div
        className="relative z-10 bg-panel border border-border rounded-2xl p-5 max-w-xs w-full mx-4 modal-content"
        style={{ boxShadow: "var(--shadow-3)" }}
      >
        <p className="text-[13.5px] text-foreground-strong mb-4 leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="btn btn-primary btn-sm">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
