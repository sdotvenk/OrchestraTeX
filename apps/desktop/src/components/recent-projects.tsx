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

      <ul className="space-y-0.5">
        {projects.map((project) => (
          <li
            key={project.path}
            className="group flex items-center rounded-lg hover:bg-subtle focus-within:bg-subtle"
          >
            <button
              type="button"
              title={project.path}
              onClick={() => onSelect(project.path)}
              className="flex flex-1 min-w-0 items-center gap-2 px-2 py-2 text-left"
            >
              <FolderIcon className="size-4 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{project.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {formatRelativeTime(new Date(project.lastOpened).getTime())}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirmPath(project.path)}
              aria-label={`Remove ${project.name} from recent projects`}
              className="size-7 shrink-0 inline-flex items-center justify-center rounded-md text-muted hover:text-error opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <TrashIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>

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
