import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CompilationResult,
  CompilationStatus,
  CompileOutputEvent,
  ConcreteLaTeXCompiler,
  LaTeXCompilersStatus,
  LaTeXSettings,
  LatexDiagnostic,
  SynctexResult,
  SynctexViewResult,
} from "./types";

export interface UseLatexCompilerOptions {
  settings: LaTeXSettings;
  projectPath: string | null;
}

export interface CompileInvocationOptions {
  directory?: string;
  mainFile: string;
  compilerOverride?: ConcreteLaTeXCompiler;
}

export function resolveEffectiveCompiler(
  preferred: LaTeXSettings["compiler"],
  status: LaTeXCompilersStatus | null,
): ConcreteLaTeXCompiler {
  if (preferred !== "auto") {
    return preferred;
  }
  if (status) {
    const order: ConcreteLaTeXCompiler[] = [
      "latexmk",
      "pdflatex",
      "xelatex",
      "lualatex",
      "tectonic",
    ];
    for (const candidate of order) {
      if (status[candidate]?.available) {
        return candidate;
      }
    }
  }
  return "latexmk";
}

export function useLatexCompiler({ settings, projectPath }: UseLatexCompilerOptions) {
  const [compilersStatus, setCompilersStatus] = useState<LaTeXCompilersStatus | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  const [compileStatus, setCompileStatus] = useState<CompilationStatus>("idle");
  const [compileLog, setCompileLog] = useState<CompileOutputEvent[]>([]);
  const [diagnostics, setDiagnostics] = useState<LatexDiagnostic[]>([]);
  const [lastResult, setLastResult] = useState<CompilationResult | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [lastCompileDurationMs, setLastCompileDurationMs] = useState<number | null>(null);

  const settingsRef = useRef(settings);
  const projectPathRef = useRef(projectPath);
  const compilersStatusRef = useRef(compilersStatus);
  const autoCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLogRef = useRef<CompileOutputEvent[]>([]);
  const logRafRef = useRef<number | null>(null);
  const logSeqRef = useRef(0);

  settingsRef.current = settings;
  projectPathRef.current = projectPath;
  compilersStatusRef.current = compilersStatus;

  const flushCompileLog = useCallback(() => {
    if (logRafRef.current !== null) {
      cancelAnimationFrame(logRafRef.current);
      logRafRef.current = null;
    }
    if (pendingLogRef.current.length === 0) return;
    const batch = pendingLogRef.current;
    pendingLogRef.current = [];
    setCompileLog((prev) => {
      const next = [...prev, ...batch];
      return next.length > 1500 ? next.slice(next.length - 1500) : next;
    });
  }, []);

  // Listen to real-time compiler stdout/stderr lines (batched at display refresh rate)
  useEffect(() => {
    let active = true;
    const unlistenPromise = listen<CompileOutputEvent>("latex-compile-output", (event) => {
      if (!active) return;
      logSeqRef.current += 1;
      pendingLogRef.current.push({ ...event.payload, seq: logSeqRef.current });
      if (logRafRef.current === null) {
        logRafRef.current = requestAnimationFrame(() => {
          flushCompileLog();
        });
      }
    });

    return () => {
      active = false;
      if (logRafRef.current !== null) {
        cancelAnimationFrame(logRafRef.current);
        logRafRef.current = null;
      }
      pendingLogRef.current = [];
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [flushCompileLog]);

  // Reset build state when project changes
  useEffect(() => {
    void projectPath;
    if (autoCompileTimerRef.current) {
      clearTimeout(autoCompileTimerRef.current);
      autoCompileTimerRef.current = null;
    }
    if (logRafRef.current !== null) {
      cancelAnimationFrame(logRafRef.current);
      logRafRef.current = null;
    }
    pendingLogRef.current = [];
    setCompileStatus("idle");
    setCompileLog([]);
    setDiagnostics([]);
    setLastResult(null);
    setPdfPath(null);
    setLastCompileDurationMs(null);
  }, [projectPath]);

  useEffect(() => {
    return () => {
      if (autoCompileTimerRef.current) {
        clearTimeout(autoCompileTimerRef.current);
      }
    };
  }, []);

  const detectCompilers = useCallback(async () => {
    setIsDetecting(true);
    try {
      const result = await invoke<LaTeXCompilersStatus>("latex_detect_compilers");
      setCompilersStatus(result);
      return result;
    } catch (error) {
      console.error("Failed to detect compilers:", error);
      return null;
    } finally {
      setIsDetecting(false);
    }
  }, []);

  useEffect(() => {
    void detectCompilers();
  }, [detectCompilers]);

  const compile = useCallback(
    async ({
      directory,
      mainFile,
      compilerOverride,
    }: CompileInvocationOptions): Promise<CompilationResult | null> => {
      const targetDir = directory ?? projectPathRef.current;
      if (!targetDir || !mainFile) return null;

      if (autoCompileTimerRef.current) {
        clearTimeout(autoCompileTimerRef.current);
        autoCompileTimerRef.current = null;
      }

      const curSettings = settingsRef.current;
      const compiler =
        compilerOverride ??
        resolveEffectiveCompiler(curSettings.compiler, compilersStatusRef.current);
      const args: string[] = [];
      if (curSettings.shellEscape && compiler !== "tectonic") {
        args.push("-shell-escape");
      }
      if (curSettings.customArgs.length > 0) {
        args.push(...curSettings.customArgs);
      }

      if (logRafRef.current !== null) {
        cancelAnimationFrame(logRafRef.current);
        logRafRef.current = null;
      }
      pendingLogRef.current = [];
      setCompileStatus("compiling");
      setCompileLog([]);

      try {
        const result = await invoke<CompilationResult>("latex_compile", {
          directory: targetDir,
          compiler,
          mainFile,
          args,
          customPath: curSettings.customCompilerPath ?? undefined,
          latexmkEngine: compiler === "latexmk" ? curSettings.latexmkEngine : undefined,
        });

        flushCompileLog();
        setLastResult(result);
        if (result.cancelled) {
          setCompileStatus("idle");
          return result;
        }

        const mergedDiags = [...result.errors, ...result.warnings];
        setDiagnostics(mergedDiags);
        setLastCompileDurationMs(result.duration_ms);
        setCompileStatus(result.success ? "success" : "error");

        if (result.pdf_path) {
          setPdfPath(result.pdf_path);
          setPdfVersion((v) => v + 1);
        }
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const failResult: CompilationResult = {
          success: false,
          cancelled: false,
          exit_code: null,
          pdf_path: null,
          error: msg,
          duration_ms: 0,
          errors: [
            {
              file: mainFile,
              line: 0,
              message: msg,
              severity: "error",
            },
          ],
          warnings: [],
        };
        setLastResult(failResult);
        setDiagnostics(failResult.errors);
        setCompileStatus("error");
        return failResult;
      }
    },
    [flushCompileLog],
  );

  const scheduleAutoCompile = useCallback(
    (options: CompileInvocationOptions, delayOverrideMs?: number) => {
      const curSettings = settingsRef.current;
      if (!curSettings.autoCompile) return;
      if (!options.mainFile) return;

      if (autoCompileTimerRef.current) {
        clearTimeout(autoCompileTimerRef.current);
      }
      const delay = delayOverrideMs ?? curSettings.autoCompileDelayMs;
      autoCompileTimerRef.current = setTimeout(() => {
        autoCompileTimerRef.current = null;
        void compile(options);
      }, delay);
    },
    [compile],
  );

  const stopCompilation = useCallback(async () => {
    if (autoCompileTimerRef.current) {
      clearTimeout(autoCompileTimerRef.current);
      autoCompileTimerRef.current = null;
    }
    const stopped = await invoke<boolean>("latex_stop_compilation");
    setCompileStatus("idle");
    return stopped;
  }, []);

  const cleanAuxFiles = useCallback(async (directory?: string) => {
    const targetDir = directory ?? projectPathRef.current;
    if (!targetDir) return [];
    return invoke<string[]>("latex_clean_aux_files", {
      directory: targetDir,
      mainFile: settingsRef.current.mainFile ?? undefined,
    });
  }, []);

  const forwardSync = useCallback(
    async (params: {
      pdfPath: string;
      texPath: string;
      line: number;
      column?: number;
    }): Promise<SynctexViewResult> => {
      return invoke<SynctexViewResult>("latex_synctex_view", {
        pdfPath: params.pdfPath,
        texPath: params.texPath,
        line: Math.max(1, params.line),
        column: Math.max(1, params.column ?? 1),
      });
    },
    [],
  );

  const inverseSync = useCallback(
    async (params: {
      pdfPath: string;
      page: number;
      x: number;
      y: number;
    }): Promise<SynctexResult> => {
      return invoke<SynctexResult>("latex_synctex_edit", {
        pdfPath: params.pdfPath,
        page: params.page,
        x: params.x,
        y: params.y,
      });
    },
    [],
  );

  const clearCompileLog = useCallback(() => {
    setCompileLog([]);
  }, []);

  return {
    compilersStatus,
    isDetecting,
    detectCompilers,
    compileStatus,
    isCompiling: compileStatus === "compiling",
    compileLog,
    diagnostics,
    lastResult,
    pdfPath,
    pdfVersion,
    lastCompileDurationMs,
    compile,
    scheduleAutoCompile,
    stopCompilation,
    cleanAuxFiles,
    forwardSync,
    inverseSync,
    clearCompileLog,
  };
}
