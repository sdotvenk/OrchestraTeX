"use client";

import {
  CaretDown,
  CaretRight,
  CheckSquare,
  Circle,
  SpinnerGap,
  XCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { PlanTaskItem } from "@/lib/agent/types";

interface TasksDisplayProps {
  tasks: PlanTaskItem[];
}

export function TasksDisplay({ tasks }: TasksDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  if (tasks.length === 0) {
    return null;
  }

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const activeTask = tasks.find((t) => t.status === "in_progress");

  return (
    <div className="border-b border-border bg-surface-secondary/70">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-surface-tertiary/60 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <CaretDown className="size-3 text-muted shrink-0" aria-hidden="true" />
          ) : (
            <CaretRight className="size-3 text-muted shrink-0" aria-hidden="true" />
          )}
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted shrink-0">
            Tasks {completedCount}/{tasks.length}
          </span>
          {activeTask && (
            <span className="text-xs text-foreground truncate">{activeTask.content}</span>
          )}
        </div>
        <div className="w-16 h-1.5 bg-border overflow-hidden shrink-0">
          <div
            className="h-full bg-accent transition-all"
            style={{
              width: `${Math.round((completedCount / Math.max(1, tasks.length)) * 100)}%`,
            }}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-1 max-h-40 overflow-y-auto border-t border-border/50">
          {tasks.map((task) => {
            const isCompleted = task.status === "completed";
            const isRunning = task.status === "in_progress";
            const isCancelled = task.status === "cancelled";

            return (
              <div key={task.id} className="flex items-start gap-2 text-xs py-0.5">
                {isCompleted ? (
                  <CheckSquare
                    className="size-3.5 text-success shrink-0 mt-0.5"
                    weight="fill"
                    aria-hidden="true"
                  />
                ) : isRunning ? (
                  <SpinnerGap
                    className="size-3.5 text-accent animate-spin shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : isCancelled ? (
                  <XCircle className="size-3.5 text-muted shrink-0 mt-0.5" aria-hidden="true" />
                ) : (
                  <Circle className="size-3.5 text-muted shrink-0 mt-0.5" aria-hidden="true" />
                )}
                <span
                  className={
                    isCompleted || isCancelled
                      ? "text-muted line-through break-words"
                      : isRunning
                        ? "text-foreground font-medium break-words"
                        : "text-foreground-secondary break-words"
                  }
                >
                  {task.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
