"use client";

import type { GitStatus } from "@orchestratex/shared";
import { GitBranchIcon } from "@phosphor-icons/react";
import type { CompilationStatus, LaTeXCompiler } from "@/lib/latex/types";

interface StatusBarProps {
  gitStatus: GitStatus | null;
  compileStatus: CompilationStatus;
  lastCompileDurationMs: number | null;
  compiler: LaTeXCompiler;
  mainFile?: string | null;
  onSelectMainFile?: () => void;
  canSyncTex?: boolean;
  onForwardSync?: () => void;
  errorCount: number;
  warningCount: number;
  selectedFile?: string;
  isTextFile?: boolean;
  cursorPosition: { line: number; column: number };
  wordCount: number;
}

const COMPILER_LABELS: Record<LaTeXCompiler, string> = {
  auto: "Auto",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
  latexmk: "latexmk",
  tectonic: "Tectonic",
};

export function StatusBar({
  gitStatus,
  compileStatus,
  lastCompileDurationMs,
  compiler,
  mainFile,
  onSelectMainFile,
  canSyncTex = false,
  onForwardSync,
  errorCount,
  warningCount,
  selectedFile,
  isTextFile,
  cursorPosition,
  wordCount,
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

  const buildText =
    compileStatus === "compiling"
      ? "Compiling"
      : errorCount > 0
        ? `${errorCount} ${errorCount === 1 ? "error" : "errors"} · ${COMPILER_LABELS[compiler]}`
        : compileStatus === "error"
          ? "Build failed"
          : compileStatus === "success"
            ? `Built${lastCompileDurationMs != null ? ` · ${lastCompileDurationMs} ms` : ""} · ${COMPILER_LABELS[compiler]}`
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

      <span className="inline-flex items-center gap-1.5">
        <span className={`size-2 rounded-full shrink-0 ${statusDotClass}`} aria-hidden="true" />
        <span>{buildText}</span>
      </span>

      {warningCount > 0 && (
        <span className="tabular-nums">
          {warningCount} {warningCount === 1 ? "warning" : "warnings"}
        </span>
      )}

      {onSelectMainFile && (
        <button
          type="button"
          onClick={onSelectMainFile}
          className="font-mono text-[11px] hover:text-foreground transition-colors truncate max-w-[180px]"
          title="Select main .tex file"
        >
          main: {mainFile ?? "unset"}
        </button>
      )}

      {canSyncTex && onForwardSync && (
        <button
          type="button"
          onClick={onForwardSync}
          className="text-accent hover:underline font-medium"
          title="Jump from current line to PDF"
        >
          Sync → PDF
        </button>
      )}

      <div className="ml-auto flex items-center gap-4">
        {isTextFile && (
          <span className="font-mono text-[11px] tabular-nums">
            Ln {cursorPosition.line}, Col {cursorPosition.column}
          </span>
        )}
        {isTextFile && <span>UTF-8</span>}
        {isLatex && <span>LaTeX</span>}
        {isLatex && <span className="tabular-nums">{wordCount.toLocaleString()} words</span>}
      </div>
    </footer>
  );
}
