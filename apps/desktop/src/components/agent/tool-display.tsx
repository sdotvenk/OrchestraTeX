"use client";

import {
  CaretDown,
  CaretRight,
  Check,
  Clock,
  FileText,
  Globe,
  MagnifyingGlass,
  PencilSimple,
  SpinnerGap,
  Terminal,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { memo, useState } from "react";
import type { AgentPart } from "@/lib/agent/types";
import { toRelativeProjectPath } from "./utils";

type ToolPart = Extract<AgentPart, { type: "tool" }>;

interface ToolDisplayProps {
  part: ToolPart;
  childrenTools?: ToolPart[];
  projectPath?: string | null;
  onFileClick?: (path: string) => void;
  depth?: number;
}

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "command" || name === "execute" || name === "terminal") {
    return Terminal;
  }
  if (name === "read" || name === "view" || name.includes("read_file")) {
    return FileText;
  }
  if (
    name === "edit" ||
    name === "write" ||
    name === "multiedit" ||
    name === "filechange" ||
    name.includes("write_file") ||
    name.includes("edit_file")
  ) {
    return PencilSimple;
  }
  if (name === "grep" || name === "glob" || name === "search" || name.includes("search")) {
    return MagnifyingGlass;
  }
  if (name.includes("web") || name.includes("fetch")) {
    return Globe;
  }
  return Wrench;
}

function getToolSummaryLabel(part: ToolPart, projectPath?: string | null): string {
  if (part.filePath) {
    return toRelativeProjectPath(part.filePath, projectPath);
  }
  const input = part.input ?? {};
  const cmd = typeof input.command === "string" ? input.command : null;
  if (cmd) {
    return cmd.length > 72 ? `${cmd.slice(0, 72)}...` : cmd;
  }
  const pattern = typeof input.pattern === "string" ? input.pattern : null;
  if (pattern) {
    return pattern;
  }
  const query = typeof input.query === "string" ? input.query : null;
  if (query) {
    return query;
  }
  if (part.title && part.title !== part.tool) {
    return part.title;
  }
  return "";
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="rounded-lg border border-border bg-panel overflow-x-auto text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        const lineKey = `diff-${i}-${line.slice(0, 24)}`;
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        return (
          <div
            key={lineKey}
            className={
              isAdd
                ? "px-2.5 bg-success-bg/70 text-success whitespace-pre"
                : isDel
                  ? "px-2.5 bg-error-bg/70 text-error whitespace-pre"
                  : isHunk
                    ? "px-2.5 bg-subtle text-muted whitespace-pre"
                    : "px-2.5 text-foreground whitespace-pre"
            }
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export const ToolDisplay = memo(function ToolDisplay({
  part,
  childrenTools = [],
  projectPath,
  onFileClick,
  depth = 0,
}: ToolDisplayProps) {
  const [expanded, setExpanded] = useState(
    part.status === "error" || (Boolean(part.diff) && part.status === "running"),
  );
  const [showFullOutput, setShowFullOutput] = useState(false);

  const Icon = getToolIcon(part.tool);
  const summary = getToolSummaryLabel(part, projectPath);
  const isRunning = part.status === "running";
  const isPending = part.status === "pending";
  const isError = part.status === "error" || Boolean(part.error);

  const relFile = part.filePath ? toRelativeProjectPath(part.filePath, projectPath) : null;
  const outputText = part.output ?? "";
  const isLongOutput = outputText.length > 2000;
  const displayedOutput =
    isLongOutput && !showFullOutput ? `${outputText.slice(0, 2000)}\n...` : outputText;

  return (
    <div className={depth > 0 ? "ml-3 border-l border-border pl-2.5" : ""}>
      <div className="rounded-xl border border-border/80 bg-subtle/45 overflow-hidden my-1">
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-2 min-w-0 flex-1 text-left"
          >
            {expanded ? (
              <CaretDown className="size-3 text-muted shrink-0" aria-hidden="true" />
            ) : (
              <CaretRight className="size-3 text-muted shrink-0" aria-hidden="true" />
            )}

            {isRunning ? (
              <SpinnerGap
                className="size-3.5 text-accent animate-spin shrink-0"
                aria-hidden="true"
              />
            ) : isError ? (
              <X className="size-3.5 text-error shrink-0" weight="bold" aria-hidden="true" />
            ) : isPending ? (
              <Clock className="size-3.5 text-muted shrink-0" aria-hidden="true" />
            ) : (
              <Check className="size-3.5 text-success shrink-0" weight="bold" aria-hidden="true" />
            )}

            <Icon className="size-3.5 text-muted shrink-0" aria-hidden="true" />

            <span className="text-[12px] font-mono font-medium text-foreground-strong shrink-0">
              {part.tool}
            </span>

            {summary && !relFile && (
              <span className="text-[11.5px] font-mono text-muted truncate">{summary}</span>
            )}
          </button>

          {relFile && onFileClick ? (
            <button
              type="button"
              onClick={() => onFileClick(relFile)}
              className="px-1.5 py-0.5 rounded-md bg-panel border border-border text-[11px] font-mono text-accent hover:border-accent truncate max-w-[200px] shrink-0 transition-colors"
              title={`Open ${relFile}`}
            >
              {relFile}
            </button>
          ) : relFile ? (
            <span className="text-[11px] font-mono text-muted truncate max-w-[200px] shrink-0">
              {relFile}
            </span>
          ) : null}
        </div>

        {expanded && (
          <div className="border-t border-border/80 px-2.5 py-2 space-y-2 bg-panel/70">
            {part.diff && <DiffBlock diff={part.diff} />}

            {part.input && Object.keys(part.input).length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-muted mb-1">Input</div>
                <pre className="p-2 rounded-lg bg-sunken text-[11px] font-mono overflow-x-auto max-h-40 text-foreground">
                  {JSON.stringify(part.input, null, 2)}
                </pre>
              </div>
            )}

            {outputText && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-medium text-muted">Output</span>
                  {isLongOutput && (
                    <button
                      type="button"
                      onClick={() => setShowFullOutput((p) => !p)}
                      className="text-[11px] text-accent hover:underline"
                    >
                      {showFullOutput ? "Truncate" : `Show all (${outputText.length} chars)`}
                    </button>
                  )}
                </div>
                <pre className="p-2 rounded-lg bg-sunken text-[11px] font-mono overflow-x-auto max-h-60 whitespace-pre-wrap break-all text-foreground">
                  {displayedOutput}
                </pre>
              </div>
            )}

            {part.error && (
              <div className="p-2 rounded-lg bg-error-bg text-[11.5px] font-mono text-error whitespace-pre-wrap">
                {part.error}
              </div>
            )}
          </div>
        )}
      </div>

      {childrenTools.length > 0 && (
        <div className="space-y-1">
          {childrenTools.map((child) => (
            <ToolDisplay
              key={child.id}
              part={child}
              projectPath={projectPath}
              onFileClick={onFileClick}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});
