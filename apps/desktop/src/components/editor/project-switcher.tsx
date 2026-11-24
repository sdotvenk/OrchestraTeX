"use client";

import { CaretDownIcon, CheckIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { pathSync } from "@/lib/path";
import type { RecentProject } from "@/lib/recent-projects";

interface ProjectSwitcherProps {
  projectPath: string;
  recentProjects: RecentProject[];
  onSelectProject: (path: string) => void;
  onOpenFolder: () => void;
}

export function ProjectSwitcher({
  projectPath,
  recentProjects,
  onSelectProject,
  onOpenFolder,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const optionsId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && containerRef.current?.contains(document.activeElement)) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const currentName = pathSync.basename(projectPath) || projectPath;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={open ? optionsId : undefined}
        title={projectPath}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[13px] font-medium text-foreground-strong hover:bg-subtle transition-colors max-w-[200px]"
      >
        <span className="truncate">{currentName}</span>
        <CaretDownIcon className="size-3 text-muted shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={optionsId}
          className="absolute left-0 top-full mt-1 w-64 rounded-lg border border-border bg-panel shadow-md py-1 z-50"
        >
          {recentProjects.length > 0 && (
            <div className="max-h-60 overflow-y-auto py-0.5">
              {recentProjects.map((proj) => {
                const isCurrent = proj.path === projectPath;
                return (
                  <button
                    key={proj.path}
                    type="button"
                    aria-current={isCurrent}
                    onClick={() => {
                      setOpen(false);
                      buttonRef.current?.focus();
                      if (!isCurrent) {
                        onSelectProject(proj.path);
                      }
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2 text-[12.5px] transition-colors ${
                      isCurrent
                        ? "bg-accent-soft text-accent font-medium"
                        : "text-foreground hover:bg-subtle"
                    }`}
                  >
                    <span className="truncate flex-1">
                      {proj.name || pathSync.basename(proj.path)}
                    </span>
                    {isCurrent && <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}

          {recentProjects.length > 0 && <div className="my-1 border-t border-border" />}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-[12.5px] text-foreground hover:bg-subtle transition-colors"
          >
            <FolderOpenIcon className="size-3.5 text-muted shrink-0" aria-hidden="true" />
            <span>Open folder...</span>
          </button>
        </div>
      )}
    </div>
  );
}
