export type LaTeXCompiler = "auto" | "latexmk" | "pdflatex" | "xelatex" | "lualatex" | "tectonic";

export type ConcreteLaTeXCompiler = Exclude<LaTeXCompiler, "auto">;

export type LatexmkEngine = "pdflatex" | "xelatex" | "lualatex";

export interface CompilerInfo {
  name: string;
  path: string | null;
  available: boolean;
  version: string | null;
}

export interface LaTeXCompilersStatus {
  pdflatex: CompilerInfo;
  xelatex: CompilerInfo;
  lualatex: CompilerInfo;
  latexmk: CompilerInfo;
  tectonic: CompilerInfo;
}

export interface LaTeXSettings {
  mainFile: string | null;
  compiler: LaTeXCompiler;
  latexmkEngine: LatexmkEngine;
  autoCompile: boolean;
  autoCompileDelayMs: number;
  shellEscape: boolean;
  customArgs: string[];
  customCompilerPath: string | null;
  cleanAuxOnClose: boolean;
}

export type CompilationStatus = "idle" | "compiling" | "success" | "error";

export interface LatexDiagnostic {
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning" | string;
}

export interface CompilationResult {
  success: boolean;
  cancelled: boolean;
  exit_code: number | null;
  pdf_path: string | null;
  error: string | null;
  duration_ms: number;
  errors: LatexDiagnostic[];
  warnings: LatexDiagnostic[];
}

export interface CompileOutputEvent {
  line: string;
  is_error: boolean;
  is_warning: boolean;
  seq?: number;
}

export const DEFAULT_LATEX_SETTINGS: LaTeXSettings = {
  mainFile: null,
  compiler: "auto",
  latexmkEngine: "pdflatex",
  autoCompile: true,
  autoCompileDelayMs: 900,
  shellEscape: false,
  customArgs: [],
  customCompilerPath: null,
  cleanAuxOnClose: false,
};

export const COMPILE_PROMPT = `Please compile the LaTeX document.

Main file: {mainFile}

Guidelines:
1. First, check compiler availability and .tex/.bib files in the project
2. If the main file does not exist, auto-detect the correct main .tex file (look for \\documentclass)
3. Always pass -synctex=1 so forward and inverse SyncTeX stay accurate
4. If compilation fails, inspect errors and .log output and fix the root cause in the .tex sources`;

export const COMPILER_DISPLAY_NAMES: Record<LaTeXCompiler, string> = {
  auto: "Auto (Recommended)",
  latexmk: "Latexmk",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
  tectonic: "Tectonic",
};

export const COMPILER_DESCRIPTIONS: Record<LaTeXCompiler, string> = {
  auto: "Automatically chooses latexmk or the best installed compiler",
  latexmk: "Automated multi-pass build tool for references & BibTeX/Biber",
  pdflatex: "Standard fast LaTeX compiler",
  xelatex: "Recommended for Unicode, custom system fonts, and CJK documents",
  lualatex: "Modern Lua-based TeX compiler with native Unicode support",
  tectonic: "Standalone Rust TeX engine with on-demand package fetching",
};

// LaTeX Installation Types
export interface LaTeXDistribution {
  name: string;
  id: string;
  description: string;
  install_command: string | null;
  download_url: string | null;
}

export interface InstallProgress {
  stage: "starting" | "checking" | "downloading" | "installing" | "complete" | "error";
  message: string;
  progress: number | null;
}

export interface InstallResult {
  success: boolean;
  message: string;
  needs_restart: boolean;
}

// SyncTeX inverse search result (PDF -> source)
export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

// SyncTeX forward search result (source -> PDF)
export interface SynctexViewResult {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

// Main file detection types
export interface MainFileDetectionResult {
  main_file: string | null;
  tex_files: string[];
  detection_method: "configured" | "documentclass" | "common_name" | "single_file" | "ambiguous";
  needs_user_input: boolean;
  message: string;
}
