import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LATEX_SETTINGS,
  type LaTeXCompiler,
  type LaTeXSettings,
  type LatexmkEngine,
  type MainFileDetectionResult,
} from "./types";

const STORAGE_KEY = "latex-settings";

function isValidCompiler(val: unknown): val is LaTeXCompiler {
  return (
    val === "auto" ||
    val === "latexmk" ||
    val === "pdflatex" ||
    val === "xelatex" ||
    val === "lualatex" ||
    val === "tectonic"
  );
}

function isValidEngine(val: unknown): val is LatexmkEngine {
  return val === "pdflatex" || val === "xelatex" || val === "lualatex";
}

function parseSavedLatexSettings(raw: string): LaTeXSettings {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    mainFile: typeof parsed.mainFile === "string" ? parsed.mainFile : null,
    compiler: isValidCompiler(parsed.compiler) ? parsed.compiler : DEFAULT_LATEX_SETTINGS.compiler,
    latexmkEngine: isValidEngine(parsed.latexmkEngine)
      ? parsed.latexmkEngine
      : DEFAULT_LATEX_SETTINGS.latexmkEngine,
    autoCompile:
      typeof parsed.autoCompile === "boolean"
        ? parsed.autoCompile
        : DEFAULT_LATEX_SETTINGS.autoCompile,
    autoCompileDelayMs:
      typeof parsed.autoCompileDelayMs === "number" &&
      Number.isFinite(parsed.autoCompileDelayMs) &&
      parsed.autoCompileDelayMs >= 200
        ? parsed.autoCompileDelayMs
        : DEFAULT_LATEX_SETTINGS.autoCompileDelayMs,
    shellEscape:
      typeof parsed.shellEscape === "boolean"
        ? parsed.shellEscape
        : DEFAULT_LATEX_SETTINGS.shellEscape,
    customArgs: Array.isArray(parsed.customArgs)
      ? parsed.customArgs.filter((a): a is string => typeof a === "string")
      : DEFAULT_LATEX_SETTINGS.customArgs,
    customCompilerPath:
      typeof parsed.customCompilerPath === "string" ? parsed.customCompilerPath : null,
    cleanAuxOnClose:
      typeof parsed.cleanAuxOnClose === "boolean"
        ? parsed.cleanAuxOnClose
        : DEFAULT_LATEX_SETTINGS.cleanAuxOnClose,
  };
}

export function useLatexSettings() {
  const [settings, setSettings] = useState<LaTeXSettings>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_LATEX_SETTINGS;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return parseSavedLatexSettings(saved);
      }
    } catch {
      // Ignore parse errors
    }
    return DEFAULT_LATEX_SETTINGS;
  });

  const [detectionResult, setDetectionResult] = useState<MainFileDetectionResult | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  // Persist settings to localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }, [settings]);

  const updateSettings = useCallback((updates: Partial<LaTeXSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const setMainFile = useCallback(
    (mainFile: string | null) => {
      updateSettings({ mainFile });
    },
    [updateSettings],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_LATEX_SETTINGS);
  }, []);

  // Detect main file in the project directory
  const detectMainFile = useCallback(
    async (projectPath: string): Promise<MainFileDetectionResult | null> => {
      if (!projectPath) return null;

      setIsDetecting(true);
      try {
        const result = await invoke<MainFileDetectionResult>("latex_detect_main_file", {
          directory: projectPath,
          configuredMainFile: settings.mainFile,
        });

        setDetectionResult(result);

        if (result.main_file && !result.needs_user_input) {
          setMainFile(result.main_file);
        }

        return result;
      } catch (error) {
        console.error("Failed to detect main file:", error);
        return null;
      } finally {
        setIsDetecting(false);
      }
    },
    [settings.mainFile, setMainFile],
  );

  const getEffectiveMainFile = useCallback(
    async (projectPath: string): Promise<string | null> => {
      if (settings.mainFile) {
        const result = await detectMainFile(projectPath);
        if (result?.main_file) {
          return result.main_file;
        }
      }

      const result = await detectMainFile(projectPath);
      return result?.main_file || null;
    },
    [settings.mainFile, detectMainFile],
  );

  return {
    settings,
    updateSettings,
    setMainFile,
    resetSettings,
    detectionResult,
    isDetecting,
    detectMainFile,
    getEffectiveMainFile,
  };
}
