"use client";

import type { GitStatus } from "@orchestratex/shared";
import { GitBranchIcon } from "@phosphor-icons/react";
import type { CompilationStatus, LaTeXCompiler } from "@/lib/latex/types";

interface StatusBarProps {
  workspaceView: "write" | "agents" | "history";
  gitStatus: GitStatus | null;
  compileStatus: CompilationStatus;
  lastCompileDurationMs: number | null;
  lastBuildAt?: number | null;
  compiler: LaTeXCompiler;
  errorCount: number;
  warningCount: number;
  selectedFile?: string;
  isTextFile?: boolean;
  cursorPosition: { line: number; column: number };
  wordCount: number;
  activeThreadContext?: { providerLabel: string; percent: number } | null;
  agentSummary?: { total: number; running: number; waiting: number; scheduled: number };
  lastFetchLabel?: string | null;
}

const COMPILER_LABELS: Record<LaTeXCompiler, string> = {
  auto: "Auto",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
  latexmk: "latexmk",
  tectonic: "Tectonic",
};

function formatBuildTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function StatusBar({
  workspaceView,
  gitStatus,
  compileStatus,
  lastCompileDurationMs,
  lastBuildAt,
  compiler,
  errorCount,
  warningCount,
  selectedFile,
  isTextFile,
  cursorPosition,
  wordCount,
  activeThreadContext,
  agentSummary,
  lastFetchLabel,
}: StatusBarProps) {
  const branchLabel = gitStatus?.branch
    ? `${gitStatus.branch}${gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ""}${
        gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ""
      }`
    : null;

  const statusDotClass =
    compileStatus === "compiling"
      ? "bg-warn animate-pulse"
      : compileStatus === "error" || errorCount > 0
        ? "bg-error"
        : compileStatus === "success"
          ? "bg-success"
          : "bg-muted-foreground";

  const buildTimePart = lastBuildAt != null ? ` ${formatBuildTime(lastBuildAt)}` : "";
  const buildText =
    compileStatus === "compiling"
      ? "Compiling…"
      : compileStatus === "error" || errorCount > 0
        ? `Build failed · ${errorCount} ${errorCount === 1 ? "error" : "errors"}, ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`
        : compileStatus === "success"
          ? `Built${buildTimePart}${lastCompileDurationMs != null ? ` · ${lastCompileDurationMs} ms` : ""} · ${COMPILER_LABELS[compiler]}`
          : COMPILER_LABELS[compiler];

  const isLatex = Boolean(selectedFile && /\.tex$/i.test(selectedFile));

  return (
    <footer className="h-6 shrink-0 flex items-center gap-4 px-3.5 text-[11.5px] text-muted border-t border-border bg-bg select-none overflow-hidden whitespace-nowrap">
      {branchLabel && (
        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
          <GitBranchIcon className="size-3" aria-hidden="true" />
          {branchLabel}
        </span>
      )}

      {workspaceView === "write" && (
        <>
          <span className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full shrink-0 ${statusDotClass}`} aria-hidden="true" />
            <span>{buildText}</span>
          </span>

          {compileStatus === "success" && warningCount > 0 && (
            <span className="tabular-nums">
              {warningCount} {warningCount === 1 ? "warning" : "warnings"}
            </span>
          )}

          <div className="ml-auto flex items-center gap-4">
            {isTextFile && (
              <span className="font-mono text-[11px] tabular-nums">
                Ln {cursorPosition.line}, Col {cursorPosition.column}
              </span>
            )}
            {activeThreadContext && (
              <span className="tabular-nums">
                {activeThreadContext.providerLabel} context {activeThreadContext.percent}%
              </span>
            )}
            {isTextFile && <span>UTF-8</span>}
            {isLatex && <span>LaTeX</span>}
            {isLatex && <span className="tabular-nums">{wordCount.toLocaleString()} words</span>}
          </div>
        </>
      )}

      {workspaceView === "agents" && agentSummary && (
        <span className="tabular-nums">
          {agentSummary.total} {agentSummary.total === 1 ? "thread" : "threads"} ·{" "}
          {agentSummary.running} running · {agentSummary.waiting} waiting
          {agentSummary.scheduled > 0 ? ` · ${agentSummary.scheduled} scheduled` : ""}
        </span>
      )}

      {workspaceView === "history" && lastFetchLabel && (
        <div className="ml-auto flex items-center gap-4">
          <span>{lastFetchLabel}</span>
        </div>
      )}
    </footer>
  );
}
