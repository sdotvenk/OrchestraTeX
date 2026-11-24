"use client";

import {
  ArrowClockwise,
  Broom,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Crosshair,
  DownloadSimple,
  FilePdf,
  GearSix,
  Sparkle,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { memo, useEffect, useId, useRef, useState } from "react";
import type {
  CompilationResult,
  CompilationStatus,
  CompileOutputEvent,
  LaTeXCompiler,
  LaTeXCompilersStatus,
  LatexDiagnostic,
} from "@/lib/latex/types";
import { type PdfHighlightTarget, PdfViewer, type PdfViewerControls } from "./pdf-viewer";

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
  staleAgentEdits?: number;
  compiler?: LaTeXCompiler;
  compilersStatus?: LaTeXCompilersStatus | null;
  shellEscape?: boolean;
  highlightTarget?: PdfHighlightTarget | null;
  onCompile: () => void;
  onStopCompile: () => void;
  onToggleAutoCompile: () => void;
  onChangeCompiler?: (compiler: LaTeXCompiler) => void;
  onToggleShellEscape?: () => void;
  onSelectMainFile?: () => void;
  onOpenBuildSettings?: () => void;
  onCleanAuxFiles: () => void;
  onForwardSync: () => void;
  onSynctexClick: (page: number, x: number, y: number) => void;
  onJumpToDiagnostic: (diag: LatexDiagnostic) => void;
  onFixDiagnosticsWithAi: (diags: LatexDiagnostic[]) => void;
  onOpenBuildActivity?: (tab: "problems" | "build-log") => void;
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
  lastCompileDurationMs: _lastCompileDurationMs,
  autoCompile,
  staleAgentEdits = 0,
  compiler = "pdflatex",
  compilersStatus = null,
  shellEscape = false,
  highlightTarget,
  onCompile,
  onStopCompile,
  onToggleAutoCompile,
  onChangeCompiler,
  onToggleShellEscape,
  onSelectMainFile,
  onOpenBuildSettings,
  onCleanAuxFiles,
  onForwardSync,
  onSynctexClick,
  onJumpToDiagnostic,
  onFixDiagnosticsWithAi,
  onOpenBuildActivity,
  onClose: _onClose,
}: LivePdfPreviewProps) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"issues" | "log">("issues");
  const [compileMenuOpen, setCompileMenuOpen] = useState(false);
  const [fitMenuOpen, setFitMenuOpen] = useState(false);
  const [pdfState, setPdfState] = useState<{
    currentPage: number;
    numPages: number;
    fitMode: "custom" | "width" | "page";
    scale: number;
  }>({ currentPage: 1, numPages: 0, fitMode: "width", scale: 1 });
  const pdfControlRef = useRef<PdfViewerControls | null>(null);
  const fitMenuRef = useRef<HTMLDivElement>(null);
  const compileMenuId = useId();
  const compileMenuRef = useRef<HTMLDivElement>(null);
  const compileMenuButton = useRef<HTMLButtonElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!compileMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (compileMenuRef.current && !compileMenuRef.current.contains(event.target as Node)) {
        setCompileMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && compileMenuRef.current?.contains(document.activeElement)) {
        setCompileMenuOpen(false);
        compileMenuButton.current?.focus();
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [compileMenuOpen]);

  const errorDiags = diagnostics.filter((d) => d.severity === "error");
  const warningDiags = diagnostics.filter((d) => d.severity !== "error");

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

  useEffect(() => {
    if (compileStatus === "error" && (errorDiags.length > 0 || lastResult?.error)) {
      if (onOpenBuildActivity) {
        onOpenBuildActivity(errorDiags.length > 0 ? "problems" : "build-log");
      } else {
        setDrawerOpen(true);
        setDrawerTab(errorDiags.length > 0 ? "issues" : "log");
      }
    }
  }, [compileStatus, errorDiags.length, lastResult?.error, onOpenBuildActivity]);

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

  const mainFileName = mainFile ? (mainFile.split("/").pop() ?? mainFile) : "Select…";

  useEffect(() => {
    if (!fitMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        fitMenuRef.current &&
        e.target instanceof Node &&
        !fitMenuRef.current.contains(e.target)
      ) {
        setFitMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [fitMenuOpen]);

  return (
    <div className="h-full w-full flex flex-col bg-stage min-w-0">
      {/* Unified 44px PDF Header Strip */}
      <div className="h-11 px-2.5 border-b border-border bg-bg flex items-center gap-1.5 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {compileStatus === "compiling" ? (
            <button
              type="button"
              onClick={onStopCompile}
              className="h-7 px-2.5 rounded-lg bg-error-bg text-error hover:brightness-95 text-[12px] font-medium inline-flex items-center gap-1.5 shrink-0 transition-all"
              title="Stop compilation (⌘.)"
            >
              <Stop className="size-3.5" weight="fill" aria-hidden="true" />
              <span>Stop</span>
            </button>
          ) : (
            <div
              ref={compileMenuRef}
              className="relative inline-flex items-center shrink-0 rounded-lg shadow-[2px_2px_0_var(--primary-offset)]"
            >
              <button
                type="button"
                disabled={!projectPath}
                onClick={onCompile}
                className="h-7 pl-2.5 pr-2 rounded-l-lg border-[1.5px] border-primary bg-primary text-primary-text hover:bg-primary-hover disabled:opacity-40 text-[12.5px] font-semibold inline-flex items-center gap-1.5 transition-colors"
                title="Recompile PDF (Cmd/Ctrl+Shift+B)"
                aria-label="Recompile PDF"
              >
                <ArrowClockwise className="size-3.5" aria-hidden="true" />
                <span>Recompile</span>
              </button>
              <button
                type="button"
                ref={compileMenuButton}
                disabled={!projectPath}
                onClick={() => setCompileMenuOpen((prev) => !prev)}
                aria-expanded={compileMenuOpen}
                aria-controls={compileMenuOpen ? compileMenuId : undefined}
                aria-label="Compile options"
                className="h-7 px-1.5 rounded-r-lg border-[1.5px] border-l-0 border-primary bg-primary text-primary-text hover:bg-primary-hover disabled:opacity-40 inline-flex items-center justify-center transition-colors"
              >
                <CaretDown className="size-3" aria-hidden="true" />
              </button>

              {compileMenuOpen && (
                <div
                  id={compileMenuId}
                  role="menu"
                  aria-label="Compile options"
                  className="ox-popover absolute left-0 top-full mt-1.5 w-[264px] p-1.5 z-50 text-[12.5px]"
                >
                  <div className="ox-sec px-2.5 pt-1.5 pb-1">Engine</div>
                  {(
                    [
                      { id: "pdflatex", label: "pdfLaTeX" },
                      { id: "xelatex", label: "XeLaTeX" },
                      { id: "lualatex", label: "LuaLaTeX" },
                      { id: "latexmk", label: "latexmk", hint: "auto" },
                      { id: "tectonic", label: "Tectonic" },
                    ] as const
                  ).map((eng) => {
                    const isAvailable = compilersStatus?.[eng.id]?.available !== false;
                    const isSelected = compiler === eng.id;
                    return (
                      <button
                        key={eng.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        disabled={!isAvailable}
                        onClick={() => {
                          if (!isAvailable) return;
                          onChangeCompiler?.(eng.id);
                          setCompileMenuOpen(false);
                          compileMenuButton.current?.focus();
                        }}
                        className={`w-full px-2.5 py-1.5 rounded-md text-left flex items-center justify-between transition-colors ${
                          !isAvailable
                            ? "opacity-45 cursor-not-allowed text-muted"
                            : isSelected
                              ? "bg-sunken text-foreground-strong font-medium"
                              : "text-foreground hover:bg-subtle"
                        }`}
                      >
                        <span>{eng.label}</span>
                        {!isAvailable ? (
                          <span className="text-[10.5px] text-muted">not found</span>
                        ) : isSelected ? (
                          <CheckCircle
                            className="size-3.5 shrink-0 text-foreground-strong"
                            weight="fill"
                            aria-hidden="true"
                          />
                        ) : "hint" in eng && eng.hint ? (
                          <span className="text-[11px] text-muted">{eng.hint}</span>
                        ) : null}
                      </button>
                    );
                  })}
                  <div className="my-1 border-t border-border" />
                  {onSelectMainFile && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCompileMenuOpen(false);
                        onSelectMainFile();
                      }}
                      className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center justify-between text-foreground hover:bg-subtle transition-colors"
                    >
                      <span>Main document</span>
                      <span className="font-mono text-[11.5px] text-foreground-strong truncate max-w-[120px]">
                        {mainFileName} ▸
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onToggleAutoCompile();
                      setCompileMenuOpen(false);
                      compileMenuButton.current?.focus();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center justify-between text-foreground hover:bg-subtle transition-colors"
                  >
                    <span>Auto-compile</span>
                    <span className="text-[11.5px] text-foreground-strong">
                      {autoCompile ? "On" : "Off"}
                    </span>
                  </button>
                  {onToggleShellEscape && compiler !== "tectonic" && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={shellEscape}
                      onClick={() => {
                        onToggleShellEscape();
                        setCompileMenuOpen(false);
                        compileMenuButton.current?.focus();
                      }}
                      className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center justify-between text-foreground hover:bg-subtle transition-colors"
                    >
                      <span>Shell escape</span>
                      <span className="text-[11.5px] text-foreground-strong">
                        {shellEscape ? "On" : "Off"}
                      </span>
                    </button>
                  )}
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCompileMenuOpen(false);
                      compileMenuButton.current?.focus();
                      onCleanAuxFiles();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center gap-2 text-foreground hover:bg-subtle transition-colors"
                  >
                    <Broom className="size-3.5 text-muted" aria-hidden="true" />
                    <span>Clean auxiliary files</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    onClick={() => {
                      setCompileMenuOpen(false);
                      onStopCompile();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center justify-between text-foreground hover:bg-subtle disabled:opacity-45 transition-colors"
                  >
                    <span>Stop compilation</span>
                    <span className="font-mono text-[11px] text-muted">⌘.</span>
                  </button>
                  {onOpenBuildSettings && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCompileMenuOpen(false);
                        onOpenBuildSettings();
                      }}
                      className="w-full px-2.5 py-1.5 rounded-md text-left flex items-center gap-2 text-foreground hover:bg-subtle transition-colors"
                    >
                      <GearSix className="size-3.5 text-muted" aria-hidden="true" />
                      <span>Build settings…</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {compileStatus === "compiling" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2 py-0.5 text-[11.5px] text-muted">
              <SpinnerGap className="size-3 animate-spin shrink-0" aria-hidden="true" />
              <span>Compiling…</span>
            </span>
          ) : compileStatus === "error" || errorDiags.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                if (onOpenBuildActivity) {
                  onOpenBuildActivity("problems");
                  return;
                }
                setDrawerOpen((p) => !p);
                setDrawerTab("issues");
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-error-bg border border-[var(--danger-line)] px-2 py-0.5 text-[11.5px] text-error font-medium truncate transition-colors"
              title="Open Problems"
            >
              <WarningCircle className="size-3.5 shrink-0" weight="fill" aria-hidden="true" />
              <span className="tabular-nums">
                Build failed · {errorDiags.length} {errorDiags.length === 1 ? "error" : "errors"}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleAutoCompile}
              className="ml-1 inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-foreground transition-colors shrink-0"
              title="Toggle automatic compilation on save"
              aria-pressed={autoCompile}
            >
              <span
                className={`relative inline-block w-[22px] h-[12px] rounded-full transition-colors ${
                  autoCompile ? "bg-primary" : "bg-border-dark"
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute top-[2px] w-[8px] h-[8px] rounded-full bg-panel transition-transform ${
                    autoCompile ? "right-[2px]" : "left-[2px]"
                  }`}
                />
              </span>
              <span>Auto</span>
            </button>
          )}

          {pdfState.numPages > 0 && compileStatus !== "error" && errorDiags.length === 0 && (
            <>
              <span className="w-px h-4 bg-border mx-0.5 shrink-0" aria-hidden="true" />
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => pdfControlRef.current?.prevPage()}
                  disabled={pdfState.currentPage <= 1}
                  className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
                  aria-label="Previous page"
                >
                  <CaretLeft className="size-3.5" aria-hidden="true" />
                </button>
                <span className="font-mono text-[12px] text-foreground tabular-nums px-1">
                  {pdfState.currentPage} / {pdfState.numPages}
                </span>
                <button
                  type="button"
                  onClick={() => pdfControlRef.current?.nextPage()}
                  disabled={pdfState.currentPage >= pdfState.numPages}
                  className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
                  aria-label="Next page"
                >
                  <CaretRight className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1 shrink-0">
          {pdfData && (
            <div ref={fitMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setFitMenuOpen((p) => !p)}
                className="h-7 px-2 rounded-md text-[12px] text-foreground hover:bg-subtle transition-colors"
                aria-expanded={fitMenuOpen}
              >
                {pdfState.fitMode === "width"
                  ? "Fit width"
                  : pdfState.fitMode === "page"
                    ? "Fit page"
                    : `${Math.round(pdfState.scale * 100)}%`}
              </button>
              {fitMenuOpen && (
                <div className="ox-popover absolute right-0 top-full mt-1 w-32 p-1 z-50 text-[12px] flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      pdfControlRef.current?.setFitWidth();
                      setFitMenuOpen(false);
                    }}
                    className="w-full px-2 py-1 rounded text-left hover:bg-subtle text-foreground"
                  >
                    Fit width
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pdfControlRef.current?.setFitPage();
                      setFitMenuOpen(false);
                    }}
                    className="w-full px-2 py-1 rounded text-left hover:bg-subtle text-foreground"
                  >
                    Fit page
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pdfControlRef.current?.zoomIn();
                      setFitMenuOpen(false);
                    }}
                    className="w-full px-2 py-1 rounded text-left hover:bg-subtle text-foreground"
                  >
                    Zoom in
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pdfControlRef.current?.zoomOut();
                      setFitMenuOpen(false);
                    }}
                    className="w-full px-2 py-1 rounded text-left hover:bg-subtle text-foreground"
                  >
                    Zoom out
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={!pdfPath}
            onClick={onForwardSync}
            className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
            title="Sync from cursor position to PDF"
            aria-label="Forward sync to PDF"
          >
            <Crosshair className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled={!pdfPath}
            onClick={() => void handleDownloadPdf()}
            className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
            title="Export PDF"
            aria-label="Download PDF"
          >
            <DownloadSimple className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Main PDF Body on Calm Drafting Mat */}
      <div className="relative flex-1 min-h-0 flex flex-col bg-stage">
        {pdfData && staleAgentEdits > 0 && compileStatus !== "error" && (
          <button
            type="button"
            onClick={onCompile}
            className="absolute left-1/2 top-3 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-[var(--voice-claude-line)] bg-panel px-2.5 py-1 text-[11.5px] text-muted shadow-sm whitespace-nowrap hover:text-foreground transition-colors"
          >
            <span
              className="inline-block w-[7px] h-[7px] rounded-full bg-[var(--voice-claude-ink)]"
              aria-hidden="true"
            />
            <span>
              {staleAgentEdits} {staleAgentEdits === 1 ? "edit" : "edits"} since this build ·{" "}
              <span className="font-medium text-foreground-strong">⌘↵ to refresh</span>
            </span>
          </button>
        )}

        {pdfData && compileStatus === "error" && (
          <div className="absolute inset-x-4 top-3 z-10 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-[12px] text-muted shadow-sm">
            Showing last good PDF. It updates after the next successful build.
          </div>
        )}

        {pdfData ? (
          <div
            className={`flex-1 min-h-0 ${
              compileStatus === "error" ? "opacity-55 grayscale-[40%]" : ""
            }`}
          >
            <PdfViewer
              pdfData={pdfData}
              onSynctexClick={onSynctexClick}
              highlightTarget={highlightTarget}
              hideToolbar
              onStateChange={setPdfState}
              controlRef={pdfControlRef}
            />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
            <FilePdf className="size-10 text-muted-foreground opacity-60" aria-hidden="true" />
            {loadError ? (
              <div className="text-xs font-mono text-error max-w-xs break-words">{loadError}</div>
            ) : compileStatus === "compiling" ? (
              <div className="space-y-1">
                <div className="text-[13px] font-medium text-foreground-strong">
                  Compiling <span className="font-mono">{mainFile}</span>...
                </div>
                <p className="text-xs text-muted">
                  Preview will appear as soon as the build finishes.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-w-xs">
                <div className="text-[13.5px] font-semibold text-foreground-strong">
                  Live PDF preview
                </div>
                <p className="text-xs text-muted">
                  {mainFile
                    ? `Compile ${mainFile} to start live preview and SyncTeX.`
                    : "Select a main .tex file to compile and preview."}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible Bottom Issues & Raw Log Sheet */}
      {drawerOpen && !onOpenBuildActivity && (
        <div className="h-52 border-t border-border bg-panel flex flex-col shrink-0">
          <div className="px-3 py-1.5 border-b border-border bg-panel flex items-center justify-between gap-2">
            <div className="inline-flex p-0.5 rounded-lg bg-sunken gap-0.5">
              <button
                type="button"
                onClick={() => setDrawerTab("issues")}
                className={`px-2.5 py-0.5 rounded-md text-[11.5px] font-medium transition-colors ${
                  drawerTab === "issues"
                    ? "bg-panel text-foreground-strong shadow-xs"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Issues ({errorDiags.length + warningDiags.length})
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab("log")}
                className={`px-2.5 py-0.5 rounded-md text-[11.5px] font-medium transition-colors ${
                  drawerTab === "log"
                    ? "bg-panel text-foreground-strong shadow-xs"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Build log ({compileLog.length})
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {errorDiags.length > 0 && (
                <button
                  type="button"
                  onClick={() => onFixDiagnosticsWithAi(errorDiags)}
                  className="btn btn-primary btn-sm h-6 px-2.5 text-[11px]"
                >
                  <Sparkle className="size-3" aria-hidden="true" />
                  <span>Fix with Agent</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle"
                aria-label="Close drawer"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
            {drawerTab === "issues" ? (
              diagnostics.length === 0 ? (
                <div className="text-xs text-muted py-6 text-center">
                  {lastResult?.error ? (
                    <span className="text-error font-mono">{lastResult.error}</span>
                  ) : (
                    "No LaTeX errors or warnings."
                  )}
                </div>
              ) : (
                diagnostics.map((d) => (
                  <div
                    key={`${d.severity}-${d.file}-${d.line}-${d.message}`}
                    className={`rounded-xl border px-3 py-2 flex items-start justify-between gap-2 text-xs ${
                      d.severity === "error"
                        ? "border-error/25 bg-error-bg/50"
                        : "border-border bg-subtle/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onJumpToDiagnostic(d)}
                      className="text-left min-w-0 flex-1 group"
                    >
                      <div className="flex items-center gap-2 text-[11px]">
                        <span
                          className={`px-1.5 py-0.2 rounded-full font-medium capitalize ${
                            d.severity === "error"
                              ? "bg-error-bg text-error"
                              : "bg-warn-bg text-warn"
                          }`}
                        >
                          {d.severity}
                        </span>
                        <span className="font-mono text-accent group-hover:underline">
                          {d.file}
                          {d.line > 0 ? `:${d.line}` : ""}
                        </span>
                      </div>
                      <div className="text-[12px] text-foreground break-words mt-1 leading-snug">
                        {d.message}
                      </div>
                    </button>

                    {d.severity === "error" && (
                      <button
                        type="button"
                        onClick={() => onFixDiagnosticsWithAi([d])}
                        className="btn btn-secondary btn-sm h-6 px-2 text-[11px] shrink-0"
                        title="Send error to Agent"
                      >
                        <Sparkle className="size-3 text-accent" aria-hidden="true" />
                        <span>Fix</span>
                      </button>
                    )}
                  </div>
                ))
              )
            ) : (
              <div className="font-mono text-[11px] leading-relaxed space-y-0.5">
                {compileLog.length === 0 ? (
                  <div className="text-muted text-center py-6 font-sans text-xs">
                    No compile output captured yet.
                  </div>
                ) : (
                  compileLog.map((entry) => (
                    <div
                      key={entry.seq ?? entry.line}
                      className={
                        entry.is_error
                          ? "text-error whitespace-pre-wrap break-all"
                          : entry.is_warning
                            ? "text-warn whitespace-pre-wrap break-all"
                            : "text-muted whitespace-pre-wrap break-all"
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
