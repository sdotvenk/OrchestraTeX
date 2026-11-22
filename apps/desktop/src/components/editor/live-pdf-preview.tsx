"use client";

import {
  ArrowClockwise,
  Broom,
  CheckCircle,
  Crosshair,
  DownloadSimple,
  FilePdf,
  Sparkle,
  SpinnerGap,
  Stop,
  TerminalWindow,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { memo, useEffect, useRef, useState } from "react";
import type {
  CompilationResult,
  CompilationStatus,
  CompileOutputEvent,
  LatexDiagnostic,
} from "@/lib/latex/types";
import { type PdfHighlightTarget, PdfViewer } from "./pdf-viewer";

interface LivePdfPreviewProps {
  projectPath: string | null;
  mainFile: string | null;
  pdfPath: string | null;
  pdfVersion: number;
  compileStatus: CompilationStatus;
  compileLog: CompileOutputEvent[];
  diagnostics: LatexDiagnostic[];
  lastResult: CompilationResult | null;
  lastCompileDurationMs: number | null;
  autoCompile: boolean;
  highlightTarget?: PdfHighlightTarget | null;
  onCompile: () => void;
  onStopCompile: () => void;
  onToggleAutoCompile: () => void;
  onCleanAuxFiles: () => void;
  onForwardSync: () => void;
  onSynctexClick: (page: number, x: number, y: number) => void;
  onJumpToDiagnostic: (diag: LatexDiagnostic) => void;
  onFixDiagnosticsWithAi: (diags: LatexDiagnostic[]) => void;
  onClose: () => void;
}

export const LivePdfPreview = memo(function LivePdfPreview({
  projectPath,
  mainFile,
  pdfPath,
  pdfVersion,
  compileStatus,
  compileLog,
  diagnostics,
  lastResult,
  lastCompileDurationMs,
  autoCompile,
  highlightTarget,
  onCompile,
  onStopCompile,
  onToggleAutoCompile,
  onCleanAuxFiles,
  onForwardSync,
  onSynctexClick,
  onJumpToDiagnostic,
  onFixDiagnosticsWithAi,
  onClose,
}: LivePdfPreviewProps) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"issues" | "log">("issues");
  const logEndRef = useRef<HTMLDivElement>(null);

  const errorDiags = diagnostics.filter((d) => d.severity === "error");
  const warningDiags = diagnostics.filter((d) => d.severity !== "error");

  // Reload compiled PDF bytes immediately on pdfPath/pdfVersion updates (zero cache)
  useEffect(() => {
    if (!pdfPath || pdfVersion < 0) {
      setPdfData(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path: pdfPath });
        if (!cancelled) {
          setPdfData(new Uint8Array(buffer));
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPath, pdfVersion]);

  // Automatically surface Issues drawer when compile fails
  useEffect(() => {
    if (compileStatus === "error" && (errorDiags.length > 0 || lastResult?.error)) {
      setDrawerOpen(true);
      setDrawerTab(errorDiags.length > 0 ? "issues" : "log");
    }
  }, [compileStatus, errorDiags.length, lastResult?.error]);

  useEffect(() => {
    if (drawerOpen && drawerTab === "log" && compileLog.length > 0) {
      logEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [compileLog.length, drawerOpen, drawerTab]);

  const handleDownloadPdf = async () => {
    if (!pdfPath) return;
    const defaultName = pdfPath.split(/[\\/]/).pop() ?? "paper.pdf";
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: defaultName,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (dest) {
      await invoke("copy_file_to_path", { sourcePath: pdfPath, destPath: dest });
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background border-l border-border min-w-0">
      {/* Top OverLeaf-style PDF & Build Toolbar */}
      <div className="h-9 px-2 border-b border-border bg-surface-secondary flex items-center justify-between gap-1.5 shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          {compileStatus === "compiling" ? (
            <button
              type="button"
              onClick={onStopCompile}
              className="px-2 py-1 text-[11px] font-mono uppercase border border-error text-error bg-background hover:bg-error/10 inline-flex items-center gap-1 shrink-0"
              title="Stop compilation"
            >
              <Stop className="size-3" weight="fill" aria-hidden="true" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!projectPath || !mainFile}
              onClick={onCompile}
              className="px-2 py-1 text-[11px] font-mono uppercase bg-foreground text-background hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1 shrink-0"
              title="Recompile PDF (Cmd/Ctrl+Enter)"
            >
              <ArrowClockwise className="size-3" aria-hidden="true" />
              <span>Recompile</span>
            </button>
          )}

          <button
            type="button"
            onClick={onToggleAutoCompile}
            className={`px-1.5 py-1 text-[10px] font-mono uppercase border transition-colors shrink-0 ${
              autoCompile
                ? "border-foreground bg-background text-foreground"
                : "border-border bg-surface-tertiary text-muted"
            }`}
            title="Toggle automatic compilation on save"
          >
            Auto: {autoCompile ? "On" : "Off"}
          </button>

          {/* Status & Issues Pill */}
          <button
            type="button"
            onClick={() => {
              setDrawerOpen((p) => !p);
              setDrawerTab(errorDiags.length > 0 || warningDiags.length > 0 ? "issues" : "log");
            }}
            className="px-1.5 py-1 text-[10px] font-mono border border-border bg-background hover:bg-surface-tertiary inline-flex items-center gap-1 truncate"
            title="Toggle compilation issues and raw logs"
          >
            {compileStatus === "compiling" ? (
              <>
                <SpinnerGap className="size-3 animate-spin" aria-hidden="true" />
                <span>Compiling...</span>
              </>
            ) : compileStatus === "error" || errorDiags.length > 0 ? (
              <>
                <WarningCircle className="size-3 text-error" weight="fill" aria-hidden="true" />
                <span className="text-error">
                  {errorDiags.length} err
                  {warningDiags.length > 0 ? ` · ${warningDiags.length} warn` : ""}
                </span>
              </>
            ) : compileStatus === "success" ? (
              <>
                <CheckCircle className="size-3 text-success" weight="fill" aria-hidden="true" />
                <span>
                  OK
                  {lastCompileDurationMs != null
                    ? ` ${(lastCompileDurationMs / 1000).toFixed(1)}s`
                    : ""}
                  {warningDiags.length > 0 ? ` · ${warningDiags.length} warn` : ""}
                </span>
              </>
            ) : (
              <span className="text-muted">Logs</span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={!pdfPath}
            onClick={onForwardSync}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary disabled:opacity-40"
            title="Sync from cursor position to PDF"
            aria-label="Forward sync to PDF"
          >
            <Crosshair className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled={!pdfPath}
            onClick={() => void handleDownloadPdf()}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary disabled:opacity-40"
            title="Download / Export PDF"
            aria-label="Download PDF"
          >
            <DownloadSimple className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled={!projectPath}
            onClick={onCleanAuxFiles}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary disabled:opacity-40"
            title="Clean auxiliary files (.aux, .log, .fls...)"
            aria-label="Clean auxiliary files"
          >
            <Broom className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => {
              setDrawerTab("log");
              setDrawerOpen((p) => !p);
            }}
            className={`p-1 hover:bg-surface-tertiary ${
              drawerOpen
                ? "text-foreground bg-surface-tertiary"
                : "text-muted hover:text-foreground"
            }`}
            title="Toggle compile log drawer"
            aria-label="Toggle compile logs"
          >
            <TerminalWindow className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary"
            title="Close Live PDF Preview"
            aria-label="Close Live PDF Preview"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Main PDF Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {pdfData ? (
          <PdfViewer
            pdfData={pdfData}
            onSynctexClick={onSynctexClick}
            highlightTarget={highlightTarget}
            compactToolbar={true}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
            <FilePdf className="size-10 text-muted opacity-40" aria-hidden="true" />
            {loadError ? (
              <div className="text-xs font-mono text-error max-w-xs break-words">{loadError}</div>
            ) : compileStatus === "compiling" ? (
              <div className="space-y-1">
                <div className="text-xs font-mono uppercase tracking-wider">
                  Compiling {mainFile}...
                </div>
                <p className="text-xs text-muted">
                  PDF preview will appear automatically once built.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-w-xs">
                <div className="text-xs font-mono uppercase tracking-wider">Live PDF Preview</div>
                <p className="text-xs text-muted">
                  {mainFile
                    ? `Click Recompile to build ${mainFile} and start live preview.`
                    : "Select a main .tex file to compile and preview."}
                </p>
                {mainFile && (
                  <button
                    type="button"
                    onClick={onCompile}
                    className="btn btn-primary btn-sm mx-auto"
                  >
                    Compile {mainFile}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible Bottom Issues & Raw Log Drawer */}
      {drawerOpen && (
        <div className="h-48 border-t border-foreground bg-background flex flex-col shrink-0">
          <div className="px-2.5 py-1 border-b border-border bg-surface-secondary flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDrawerTab("issues")}
                className={`px-2 py-0.5 text-[10px] font-mono uppercase border ${
                  drawerTab === "issues"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted hover:text-foreground"
                }`}
              >
                Issues ({errorDiags.length + warningDiags.length})
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab("log")}
                className={`px-2 py-0.5 text-[10px] font-mono uppercase border ${
                  drawerTab === "log"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted hover:text-foreground"
                }`}
              >
                Raw Log ({compileLog.length})
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {errorDiags.length > 0 && (
                <button
                  type="button"
                  onClick={() => onFixDiagnosticsWithAi(errorDiags)}
                  className="px-2 py-0.5 text-[10px] font-mono uppercase bg-foreground text-background hover:opacity-90 inline-flex items-center gap-1"
                >
                  <Sparkle className="size-3" aria-hidden="true" />
                  <span>Fix All with AI</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-0.5 text-muted hover:text-foreground"
                aria-label="Close drawer"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {drawerTab === "issues" ? (
              diagnostics.length === 0 ? (
                <div className="text-xs font-mono text-muted py-4 text-center">
                  {lastResult?.error ? (
                    <span className="text-error">{lastResult.error}</span>
                  ) : (
                    "No LaTeX errors or warnings."
                  )}
                </div>
              ) : (
                diagnostics.map((d) => (
                  <div
                    key={`${d.severity}-${d.file}-${d.line}-${d.message}`}
                    className={`border px-2 py-1.5 flex items-start justify-between gap-2 text-xs ${
                      d.severity === "error"
                        ? "border-error/40 bg-error/5"
                        : "border-border bg-surface-secondary"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onJumpToDiagnostic(d)}
                      className="text-left min-w-0 flex-1 hover:underline"
                    >
                      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase">
                        <span
                          className={
                            d.severity === "error" ? "text-error font-semibold" : "text-muted"
                          }
                        >
                          {d.severity}
                        </span>
                        <span className="text-foreground">
                          {d.file}
                          {d.line > 0 ? `:${d.line}` : ""}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-foreground break-words mt-0.5">
                        {d.message}
                      </div>
                    </button>

                    {d.severity === "error" && (
                      <button
                        type="button"
                        onClick={() => onFixDiagnosticsWithAi([d])}
                        className="px-1.5 py-0.5 text-[10px] font-mono uppercase border border-border bg-background hover:border-foreground shrink-0 inline-flex items-center gap-1"
                        title="Send error to Agent"
                      >
                        <Sparkle className="size-2.5" aria-hidden="true" />
                        <span>Fix</span>
                      </button>
                    )}
                  </div>
                ))
              )
            ) : (
              <div className="font-mono text-[11px] leading-relaxed space-y-0.5">
                {compileLog.length === 0 ? (
                  <div className="text-muted text-center py-4">No compile output captured yet.</div>
                ) : (
                  compileLog.map((entry) => (
                    <div
                      key={entry.seq ?? entry.line}
                      className={
                        entry.is_error
                          ? "text-error whitespace-pre-wrap break-all"
                          : entry.is_warning
                            ? "text-foreground-secondary font-medium whitespace-pre-wrap break-all"
                            : "text-foreground-secondary whitespace-pre-wrap break-all"
                      }
                    >
                      {entry.line}
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
