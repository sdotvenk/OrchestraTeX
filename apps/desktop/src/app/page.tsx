"use client";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, type PanInfo, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginCodeModal } from "@/components/auth";
import {
  type DockviewPanelItem,
  DockviewPanelLayout,
} from "@/components/editor/dockview-panel-layout";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { EditorSkeleton } from "@/components/editor/editor-skeleton";
import { GitHubPublishDialog } from "@/components/editor/github-publish-dialog";
import type { PdfHighlightTarget } from "@/components/editor/pdf-viewer";
import { FileSidebarPanel } from "@/components/editor/sidebar-file-panel";
import { GitSidebarPanel } from "@/components/editor/sidebar-git-panel";
import { SidebarOutlinePanel } from "@/components/editor/sidebar-outline-panel";
import { TerminalPanel } from "@/components/editor/terminal-panel";
import {
  LaTeXInstallPrompt,
  LaTeXSettingsDialog,
  MainFileSelectionDialog,
  SynctexInstallDialog,
} from "@/components/latex";
import { RecentProjects } from "@/components/recent-projects";
import { InputDialog } from "@/components/ui/input-dialog";
import {
  TabBar,
  type TabDragEndPayload,
  type TabDragMovePayload,
  type TabItem,
  type TabReorderPosition,
} from "@/components/ui/tab-bar";
import { useToast } from "@/components/ui/toast";
import { useAgent, useAgentSettings } from "@/lib/agent";
import { useAuth } from "@/lib/auth";
import { useEditorSettings } from "@/lib/editor";
import {
  type BibEntry,
  countLatexWords,
  findMainTexFile,
  findTexFiles,
  type LabelEntry,
  type LatexWordCountResult,
  parseBibTeXEntries,
  parseLatexLabels,
  useLatexCompiler,
  useLatexSettings,
} from "@/lib/latex";
import type { LatexDiagnostic, MainFileDetectionResult, SynctexResult } from "@/lib/latex/types";
import { pathSync } from "@/lib/path";
import { useRecentProjects } from "@/lib/recent-projects";
import { useTauriDaemon } from "@/lib/tauri";

const PdfViewer = dynamic(
  () => import("@/components/editor/pdf-viewer").then((mod) => mod.PdfViewer),
  { ssr: false },
);

const LivePdfPreview = dynamic(
  () => import("@/components/editor/live-pdf-preview").then((mod) => mod.LivePdfPreview),
  { ssr: false },
);

import {
  FilePdfIcon,
  GearIcon,
  PlayCircleIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SpinnerGapIcon,
  TerminalIcon,
} from "@phosphor-icons/react";

function throttle<T extends (...args: Parameters<T>) => void>(fn: T, limit: number): T {
  let lastCall = 0;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  }) as T;
}

type EditorViewMode = "file" | "git-diff";
type GitDiffPreviewState = {
  path: string;
  staged: boolean;
  content: string;
  isLoading: boolean;
  error: string | null;
};

type SplitPaneSide = "left" | "right";
type DragSourcePane = "primary" | "split";

type SplitPaneState = {
  side: SplitPaneSide;
  openTabs: string[];
  selectedFile?: string;
  content: string;
  isLoading: boolean;
  error: string | null;
  binaryPreviewUrl: string | null;
  pdfRefreshKey: number;
};

type ParsedUnifiedDiff = {
  original: string;
  modified: string;
  added: number;
  removed: number;
  hasRenderableHunks: boolean;
  isBinary: boolean;
};

function parseUnifiedDiffContent(content: string): ParsedUnifiedDiff {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;
  let added = 0;
  let removed = 0;
  let isBinary = false;

  for (const line of lines) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true;
    }

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      modifiedLines.push(line.slice(1));
      added += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      originalLines.push(line.slice(1));
      removed += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      const contextLine = line.slice(1);
      originalLines.push(contextLine);
      modifiedLines.push(contextLine);
      continue;
    }

    if (line.length === 0) {
      originalLines.push("");
      modifiedLines.push("");
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
    added,
    removed,
    hasRenderableHunks: originalLines.length > 0 || modifiedLines.length > 0,
    isBinary,
  };
}

type TreeNode = {
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

function buildBasenameIndex(nodes: TreeNode[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.type === "file") {
      const name = pathSync.basename(node.path);
      const existing = index.get(name);
      if (existing) {
        existing.push(node.path);
      } else {
        index.set(name, [node.path]);
      }
    }

    if (node.children && node.children.length > 0) {
      stack.push(...node.children);
    }
  }

  return index;
}

const AI_COMMIT_DIFF_LIMIT = 30000;

function collectRelativeFilesByExt(
  nodes: import("@lmms-lab/writer-shared").FileNode[],
  projectRoot: string,
  extRegex: RegExp,
): string[] {
  const normRoot = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const visit = (items: import("@lmms-lab/writer-shared").FileNode[]) => {
    for (const n of items) {
      if (n.type === "file") {
        const norm = n.path.replace(/\\/g, "/");
        const rel = norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : norm;
        if (extRegex.test(rel)) out.push(rel);
      }
      if (n.children?.length) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

function sanitizeAiCommitMessage(raw: string): string {
  let text = raw.trim();

  text = text.replace(/^```[a-zA-Z]*\s*/m, "");
  text = text.replace(/\s*```$/, "");
  text = text.replace(/^commit message\s*[:：]\s*/i, "");

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.trim();
}

function buildAiCommitPrompt(diff: string, scope: "staged" | "unstaged"): string {
  return [
    `Generate a git commit message from the following ${scope} changes.`,
    "Do not call tools. Only output the final commit message.",
    "Output rules:",
    "1. Return only the commit message text, no markdown and no code block.",
    "2. First line is a concise subject in imperative mood, <= 72 chars.",
    "3. Add a short body only when necessary.",
    "",
    "Diff:",
    diff,
  ].join("\n");
}

const MonacoEditor = dynamic(
  () => import("@/components/editor/monaco-editor").then((mod) => mod.MonacoEditor),
  { ssr: false },
);

const GitMonacoDiffEditor = dynamic(
  () => import("@/components/editor/monaco-diff-editor").then((mod) => mod.MonacoDiffEditor),
  {
    ssr: false,
    loading: () => <EditorSkeleton className="h-full" />,
  },
);

const AgentPanel = dynamic(
  () => import("@/components/agent/agent-panel").then((mod) => mod.AgentPanel),
  {
    ssr: false,
    loading: () => <AgentPanelSkeleton />,
  },
);

const AgentErrorBoundary = dynamic(
  () => import("@/components/agent/agent-error-boundary").then((mod) => mod.AgentErrorBoundary),
  { ssr: false },
);

const PANEL_SPRING = {
  type: "spring",
  stiffness: 400,
  damping: 35,
  mass: 0.8,
} as const;

const INSTANT_TRANSITION = { duration: 0 } as const;

const _WEB_URL = process.env.NEXT_PUBLIC_WEB_URL || "https://writer.lmms-lab.com";

const MIN_PANEL_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export default function EditorPage() {
  const editorSettings = useEditorSettings();
  const daemon = useTauriDaemon({
    gitAutoFetchEnabled: editorSettings.settings.gitAutoFetchEnabled,
    gitAutoFetchIntervalMs: editorSettings.settings.gitAutoFetchIntervalSeconds * 1000,
  });
  const prefersReducedMotion = useReducedMotion();
  const auth = useAuth();
  const { toast } = useToast();
  const recentProjects = useRecentProjects();

  const [selectedFile, setSelectedFile] = useState<string>();
  const [fileContent, setFileContent] = useState<string>("");
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("file");
  const [gitDiffPreview, setGitDiffPreview] = useState<GitDiffPreviewState | null>(null);
  const [splitPane, setSplitPane] = useState<SplitPaneState | null>(null);
  const [splitDropHint, setSplitDropHint] = useState<SplitPaneSide | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [pdfRefreshKey, _setPdfRefreshKey] = useState(0);
  const [pendingGoToLine, setPendingGoToLine] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("sidebarWidth");
      return saved ? parseInt(saved, 10) : 280;
    }
    return 280;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("rightPanelWidth");
      return saved ? parseInt(saved, 10) : 280;
    }
    return 280;
  });
  const [resizing, setResizing] = useState<"sidebar" | "right" | "preview" | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"files" | "outline" | "git">("files");
  const [highlightedFile, _setHighlightedFile] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [isGeneratingCommitMessageAI, setIsGeneratingCommitMessageAI] = useState(false);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [createDialog, setCreateDialog] = useState<{
    type: "file" | "directory";
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showLatexSettings, setShowLatexSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "build" | "editor" | "agents" | "account"
  >("build");
  const [showLoginCodeModal, setShowLoginCodeModal] = useState(false);

  const [showLivePreview, setShowLivePreview] = useState(false);
  const [livePreviewWidth, setLivePreviewWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("livePreviewWidth");
      return saved ? parseInt(saved, 10) : 440;
    }
    return 440;
  });
  const [pdfHighlightTarget, setPdfHighlightTarget] = useState<PdfHighlightTarget | null>(null);
  const [cursorPosition, setCursorPosition] = useState<{ line: number; column: number }>({
    line: 1,
    column: 1,
  });
  const [wordCount, setWordCount] = useState<LatexWordCountResult>({
    words: 0,
    characters: 0,
    lines: 0,
  });
  const [outlineContent, setOutlineContent] = useState<string>("");
  const [bibEntries, setBibEntries] = useState<BibEntry[]>([]);
  const [texLabels, setTexLabels] = useState<LabelEntry[]>([]);

  const agentSettings = useAgentSettings();
  const [agentUsageOpen, setAgentUsageOpen] = useState(false);
  const handleOpenUsagePopover = useCallback(() => setAgentUsageOpen(true), []);
  const agent = useAgent({
    projectPath: daemon.projectPath,
    settings: agentSettings.settings,
    onOpenUsage: handleOpenUsagePopover,
  });
  const [agentDraftInjection, setAgentDraftInjection] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<{
    id: number;
    command: string;
  } | null>(null);

  const [showMainFileDialog, setShowMainFileDialog] = useState(false);
  const [mainFileDetectionResult, setMainFileDetectionResult] =
    useState<MainFileDetectionResult | null>(null);
  const [showGitHubPublishDialog, setShowGitHubPublishDialog] = useState(false);
  const [ghPublishError, setGhPublishError] = useState<string | null>(null);
  const [showSynctexInstallDialog, setShowSynctexInstallDialog] = useState(false);
  const pendingSynctexRetryRef = useRef<{
    page: number;
    x: number;
    y: number;
    context: "main" | "split" | "preview";
  } | null>(null);

  const contentSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const splitContentSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const savingVisualTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<{ path: string; time: number } | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const gitDiffRequestIdRef = useRef(0);
  const splitLoadRequestIdRef = useRef(0);
  const editorWorkspaceRef = useRef<HTMLDivElement | null>(null);

  // RAF-based resize refs for 60fps performance
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const livePreviewWidthRef = useRef(livePreviewWidth);
  const rafIdRef = useRef<number | null>(null);

  const gitStatus = daemon.gitStatus;
  const stagedChanges = useMemo(
    () => (gitStatus?.changes ?? []).filter((c: { staged: boolean; path: string }) => c.staged),
    [gitStatus?.changes],
  );
  const unstagedChanges = useMemo(
    () => (gitStatus?.changes ?? []).filter((c: { staged: boolean; path: string }) => !c.staged),
    [gitStatus?.changes],
  );

  // LaTeX settings and editor settings
  const latexSettings = useLatexSettings();
  const texFiles = useMemo(() => findTexFiles(daemon.files), [daemon.files]);

  // Auto-detect main file when project opens
  useEffect(() => {
    if (daemon.files.length > 0 && !latexSettings.settings.mainFile) {
      const mainFile = findMainTexFile(daemon.files);
      if (mainFile) {
        latexSettings.setMainFile(mainFile);
      }
    }
  }, [daemon.files, latexSettings.settings.mainFile, latexSettings]);

  const latexCompiler = useLatexCompiler({
    settings: latexSettings.settings,
    projectPath: daemon.projectPath,
  });

  // Check if any LaTeX compiler is available
  const hasAnyCompiler =
    latexCompiler.compilersStatus &&
    (latexCompiler.compilersStatus.pdflatex.available ||
      latexCompiler.compilersStatus.xelatex.available ||
      latexCompiler.compilersStatus.lualatex.available ||
      latexCompiler.compilersStatus.latexmk.available ||
      latexCompiler.compilersStatus.tectonic.available);

  const executeLocalCompile = useCallback(
    async (mainFile: string) => {
      if (!daemon.projectPath) return;
      if (!hasAnyCompiler && latexCompiler.compilersStatus) {
        toast("No LaTeX compiler detected. Install TinyTeX, Tectonic, or TeX Live below.", "error");
        return;
      }
      setShowLivePreview(true);
      const res = await latexCompiler.compile({
        directory: daemon.projectPath,
        mainFile,
      });
      if (res && !res.cancelled) {
        if (res.success) {
          toast(`Compiled ${mainFile} in ${(res.duration_ms / 1000).toFixed(1)}s`, "success");
        } else if (res.errors.length > 0) {
          toast(`Compilation failed with ${res.errors.length} error(s)`, "error");
        } else if (res.error) {
          toast(res.error, "error");
        }
      }
    },
    [daemon.projectPath, hasAnyCompiler, latexCompiler, toast],
  );

  // Handle compile with main file detection
  const handleCompileWithDetection = useCallback(async () => {
    if (!daemon.projectPath) return;

    if (latexSettings.settings.mainFile) {
      await executeLocalCompile(latexSettings.settings.mainFile);
      return;
    }

    const result = await latexSettings.detectMainFile(daemon.projectPath);
    if (!result) {
      toast("Failed to detect main file", "error");
      return;
    }

    if (result.main_file && !result.needs_user_input) {
      await executeLocalCompile(result.main_file);
      return;
    }

    if (result.needs_user_input && result.tex_files.length > 0) {
      setMainFileDetectionResult(result);
      setShowMainFileDialog(true);
      return;
    }

    toast("No .tex files found in the project", "error");
  }, [daemon.projectPath, executeLocalCompile, latexSettings, toast]);

  // Handle main file selection from dialog
  const handleMainFileSelect = useCallback(
    (mainFile: string) => {
      latexSettings.setMainFile(mainFile);
      setShowMainFileDialog(false);
      setMainFileDetectionResult(null);
      void executeLocalCompile(mainFile);
    },
    [executeLocalCompile, latexSettings],
  );

  const handleMainFileDialogCancel = useCallback(() => {
    setShowMainFileDialog(false);
    setMainFileDetectionResult(null);
  }, []);

  const handleToggleRightPanel = useCallback(() => {
    setShowRightPanel((prev) => !prev);
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("rightPanelWidth", String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    localStorage.setItem("livePreviewWidth", String(livePreviewWidth));
  }, [livePreviewWidth]);

  useEffect(() => {
    if (pendingGoToLine > 0) {
      const timer = setTimeout(() => setPendingGoToLine(0), 3000);
      return () => clearTimeout(timer);
    }
  }, [pendingGoToLine]);

  useEffect(() => {
    if (!daemon.projectPath) {
      if (splitContentSaveTimeoutRef.current) {
        clearTimeout(splitContentSaveTimeoutRef.current);
        splitContentSaveTimeoutRef.current = null;
      }
      setSplitPane(null);
      setShowLivePreview(false);
      setBibEntries([]);
      setTexLabels([]);
    }
  }, [daemon.projectPath]);

  useEffect(() => {
    setShowTerminal(Boolean(daemon.projectPath));
  }, [daemon.projectPath]);

  useEffect(() => {
    return () => {
      if (splitContentSaveTimeoutRef.current) {
        clearTimeout(splitContentSaveTimeoutRef.current);
        splitContentSaveTimeoutRef.current = null;
      }
    };
  }, []);

  // Index BibTeX keys and TeX labels across the project for Monaco autocomplete
  const daemonReadFile = daemon.readFile;
  useEffect(() => {
    if (!daemon.projectPath || daemon.files.length === 0) return;
    let cancelled = false;
    const projectRoot = daemon.projectPath;
    const bibPaths = collectRelativeFilesByExt(daemon.files, projectRoot, /\.bib$/i).slice(0, 10);
    const texPaths = collectRelativeFilesByExt(daemon.files, projectRoot, /\.tex$/i).slice(0, 25);

    (async () => {
      const [bibContents, texContents] = await Promise.all([
        Promise.all(
          bibPaths.map(async (p) => ({
            file: p,
            content: (await daemonReadFile(p).catch(() => null)) ?? "",
          })),
        ),
        Promise.all(
          texPaths.map(async (p) => ({
            file: p,
            content: (await daemonReadFile(p).catch(() => null)) ?? "",
          })),
        ),
      ]);
      if (cancelled) return;

      const parsedBibs: BibEntry[] = [];
      for (const item of bibContents) {
        parsedBibs.push(...parseBibTeXEntries(item.content, item.file));
      }
      const parsedLabels: LabelEntry[] = [];
      for (const item of texContents) {
        parsedLabels.push(...parseLatexLabels(item.content, item.file));
      }
      setBibEntries(parsedBibs);
      setTexLabels(parsedLabels);
    })();

    return () => {
      cancelled = true;
    };
  }, [daemon.projectPath, daemon.files, daemonReadFile]);

  // Debounced body word count & outline source for active TeX file
  useEffect(() => {
    if (!selectedFile || !/\.tex$/i.test(selectedFile)) {
      setWordCount({ words: 0, characters: 0, lines: 0 });
      setOutlineContent("");
      return;
    }
    const timer = setTimeout(() => {
      setWordCount(countLatexWords(fileContent));
      setOutlineContent(fileContent);
    }, 250);
    return () => clearTimeout(timer);
  }, [fileContent, selectedFile]);

  const startResize = useCallback(
    (panel: "sidebar" | "right" | "preview") => {
      setResizing(panel);
      sidebarWidthRef.current = sidebarWidth;
      rightPanelWidthRef.current = rightPanelWidth;
      livePreviewWidthRef.current = livePreviewWidth;
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
      document.documentElement.style.setProperty("--right-panel-width", `${rightPanelWidth}px`);
      document.documentElement.style.setProperty("--preview-panel-width", `${livePreviewWidth}px`);
    },
    [sidebarWidth, rightPanelWidth, livePreviewWidth],
  );

  const handleResizeDrag = useCallback((panel: "sidebar" | "right" | "preview", info: PanInfo) => {
    if (rafIdRef.current !== null) return;

    rafIdRef.current = requestAnimationFrame(() => {
      if (panel === "sidebar") {
        const newWidth = Math.min(Math.max(info.point.x, MIN_PANEL_WIDTH), MAX_SIDEBAR_WIDTH);
        sidebarWidthRef.current = newWidth;
        document.documentElement.style.setProperty("--sidebar-width", `${newWidth}px`);
      } else if (panel === "right") {
        const maxRightWidth = Math.floor(window.innerWidth / 2);
        const newWidth = Math.min(
          Math.max(window.innerWidth - info.point.x, MIN_PANEL_WIDTH),
          maxRightWidth,
        );
        rightPanelWidthRef.current = newWidth;
        document.documentElement.style.setProperty("--right-panel-width", `${newWidth}px`);
      } else if (panel === "preview") {
        const maxPreviewWidth = Math.floor(window.innerWidth * 0.6);
        const nextWidth = Math.min(
          Math.max(livePreviewWidthRef.current - info.delta.x, 280),
          maxPreviewWidth,
        );
        livePreviewWidthRef.current = nextWidth;
        document.documentElement.style.setProperty("--preview-panel-width", `${nextWidth}px`);
      }
      rafIdRef.current = null;
    });
  }, []);

  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setSidebarWidth(sidebarWidthRef.current);
    setRightPanelWidth(rightPanelWidthRef.current);
    setLivePreviewWidth(livePreviewWidthRef.current);
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.style.removeProperty("--right-panel-width");
    document.documentElement.style.removeProperty("--preview-panel-width");
    setResizing(null);
  }, []);

  useEffect(() => {
    const COMPACT_THRESHOLD = 1100;

    const handleResize = throttle(() => {
      if (window.innerWidth < COMPACT_THRESHOLD) {
        setShowRightPanel(false);
      }
    }, 100);

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const getFileType = useCallback((path: string): "text" | "image" | "pdf" => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
      return "image";
    }
    if (ext === "pdf") {
      return "pdf";
    }
    return "text";
  }, []);

  const getFileLanguage = useCallback((path: string): string => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const languageMap: Record<string, string> = {
      tex: "latex",
      sty: "latex",
      cls: "latex",
      bib: "bibtex",
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      md: "markdown",
      json: "json",
      css: "css",
      scss: "scss",
      less: "less",
      html: "html",
      htm: "html",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      java: "java",
      rs: "rust",
      go: "go",
      rb: "ruby",
      php: "php",
      sql: "sql",
      r: "r",
      lua: "lua",
      swift: "swift",
      kt: "kotlin",
      scala: "scala",
      toml: "toml",
      ini: "ini",
      conf: "ini",
      dockerfile: "dockerfile",
      makefile: "makefile",
    };
    return languageMap[ext] || "plaintext";
  }, []);

  const filesByBasename = useMemo(
    () => buildBasenameIndex(daemon.files as TreeNode[]),
    [daemon.files],
  );

  const resolveSelectablePath = useCallback(
    (candidatePath: string): string => {
      const normalized = candidatePath.replace(/\\/g, "/");
      if (normalized.includes("/")) {
        return normalized;
      }

      const matches = filesByBasename.get(normalized) ?? [];
      if (matches.length === 0) {
        return normalized;
      }

      if (matches.length > 1) {
        const preferred = matches[0];
        if (preferred) {
          toast(`Multiple files named "${normalized}" found. Opening "${preferred}".`, "error");
          return preferred;
        }
      }

      return matches[0] ?? normalized;
    },
    [filesByBasename, toast],
  );

  const handleFileSelect = useCallback(
    async (path: string) => {
      const resolvedPath = resolveSelectablePath(path);
      setEditorViewMode("file");
      setGitDiffPreview(null);
      const fileType = getFileType(resolvedPath);

      setOpenTabs((prev) => {
        if (prev.includes(resolvedPath)) return prev;
        return [...prev, resolvedPath];
      });
      setSelectedFile(resolvedPath);
      setBinaryPreviewUrl(null);

      if (fileType === "text") {
        setIsLoadingFile(true);
        try {
          const content = await daemon.readFile(resolvedPath);
          setFileContent(content ?? "");
        } catch (err) {
          const errorStr = String(err);

          // Handle file not found - remove from tabs and notify user
          if (errorStr.includes("FILE_NOT_FOUND")) {
            const fileName = pathSync.basename(resolvedPath);
            toast(`File "${fileName}" no longer exists and has been removed from tabs`, "error");

            // Remove the file from open tabs
            setOpenTabs((prev) => {
              const newTabs = prev.filter((p) => p !== resolvedPath);

              // Switch to another tab if available
              if (newTabs.length > 0) {
                const nextFile = newTabs[0];
                if (nextFile) {
                  // Recursively try to open the next file
                  setTimeout(() => handleFileSelect(nextFile), 0);
                }
              } else {
                // No more tabs, clear selection
                setSelectedFile(undefined);
                setFileContent("");
              }

              return newTabs;
            });
          } else {
            console.error("Failed to read file:", err);
            toast(`Failed to read file: ${err}`, "error");
            setFileContent("");
          }
        } finally {
          setIsLoadingFile(false);
        }
      } else {
        const fullPath = daemon.projectPath
          ? pathSync.join(daemon.projectPath, resolvedPath)
          : resolvedPath;
        setBinaryPreviewUrl(convertFileSrc(fullPath));
        setFileContent("");
      }
    },
    [daemon, getFileType, resolveSelectablePath, toast],
  );

  const runInverseSynctex = useCallback(
    async (
      pdfPath: string,
      page: number,
      x: number,
      y: number,
      context: "main" | "split" | "preview",
    ) => {
      if (!daemon.projectPath) return;
      try {
        const result = await invoke<SynctexResult>("latex_synctex_edit", {
          pdfPath,
          page,
          x,
          y,
        });

        const normalize = (p: string) =>
          p
            .replace(/\\/g, "/")
            .replace(/\/\.\//g, "/")
            .replace(/\/+/g, "/");

        const normalFile = normalize(result.file);
        const normalProject = normalize(daemon.projectPath);

        let resolvedFile = normalFile;
        if (resolvedFile.startsWith(normalProject)) {
          resolvedFile = resolvedFile.slice(normalProject.length).replace(/^\/+/, "");
        }

        await handleFileSelect(resolvedFile);
        setPendingGoToLine(result.line);
      } catch (err) {
        const errorStr = String(err);
        if (errorStr.includes("SYNCTEX_NOT_INSTALLED")) {
          pendingSynctexRetryRef.current = { page, x, y, context };
          setShowSynctexInstallDialog(true);
        } else {
          console.error("SyncTeX lookup failed:", err);
          toast("SyncTeX lookup failed. Check that your PDF has a .synctex.gz file.", "error");
        }
      }
    },
    [daemon.projectPath, handleFileSelect, toast],
  );

  const handleSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !selectedFile) return;
      const pdfPath = pathSync.join(daemon.projectPath, selectedFile);
      void runInverseSynctex(pdfPath, page, x, y, "main");
    },
    [daemon.projectPath, runInverseSynctex, selectedFile],
  );

  const handleSplitSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !splitPane?.selectedFile) return;
      const pdfPath = pathSync.join(daemon.projectPath, splitPane.selectedFile);
      void runInverseSynctex(pdfPath, page, x, y, "split");
    },
    [daemon.projectPath, runInverseSynctex, splitPane?.selectedFile],
  );

  const handleLivePreviewSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!latexCompiler.pdfPath) return;
      void runInverseSynctex(latexCompiler.pdfPath, page, x, y, "preview");
    },
    [latexCompiler.pdfPath, runInverseSynctex],
  );

  const handleForwardSync = useCallback(
    async (line?: number, column?: number) => {
      if (!daemon.projectPath || !latexCompiler.pdfPath) {
        toast("Compile a PDF first to sync cursor position.", "error");
        return;
      }
      const targetTex =
        selectedFile && /\.tex$/i.test(selectedFile)
          ? selectedFile
          : latexSettings.settings.mainFile;
      if (!targetTex) {
        toast("Open a .tex file to sync to PDF.", "error");
        return;
      }
      const fullTexPath = pathSync.join(daemon.projectPath, targetTex);
      try {
        const res = await latexCompiler.forwardSync({
          pdfPath: latexCompiler.pdfPath,
          texPath: fullTexPath,
          line: line ?? cursorPosition.line,
          column: column ?? cursorPosition.column,
        });
        setShowLivePreview(true);
        setPdfHighlightTarget({
          page: res.page,
          x: res.h,
          y: res.v,
          width: res.width,
          height: res.height,
          nonce: Date.now(),
        });
      } catch (err) {
        const errorStr = String(err);
        if (errorStr.includes("SYNCTEX_NOT_INSTALLED")) {
          setShowSynctexInstallDialog(true);
        } else {
          toast("Could not resolve PDF location for this source line.", "error");
        }
      }
    },
    [
      cursorPosition.column,
      cursorPosition.line,
      daemon.projectPath,
      latexCompiler,
      latexSettings.settings.mainFile,
      selectedFile,
      toast,
    ],
  );

  const handleSynctexInstallComplete = useCallback(() => {
    setShowSynctexInstallDialog(false);
    const pending = pendingSynctexRetryRef.current;
    if (pending) {
      pendingSynctexRetryRef.current = null;
      setTimeout(() => {
        if (pending.context === "main") {
          handleSynctexClick(pending.page, pending.x, pending.y);
        } else if (pending.context === "preview") {
          handleLivePreviewSynctexClick(pending.page, pending.x, pending.y);
        } else {
          handleSplitSynctexClick(pending.page, pending.x, pending.y);
        }
      }, 500);
    }
  }, [handleLivePreviewSynctexClick, handleSplitSynctexClick, handleSynctexClick]);

  const loadGitDiffPreview = useCallback(
    async (path: string, staged: boolean) => {
      const requestId = gitDiffRequestIdRef.current + 1;
      gitDiffRequestIdRef.current = requestId;

      setGitDiffPreview({
        path,
        staged,
        content: "",
        isLoading: true,
        error: null,
      });

      try {
        const content = await daemon.gitDiff(path, staged);
        if (gitDiffRequestIdRef.current !== requestId) return;
        setGitDiffPreview({
          path,
          staged,
          content,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        if (gitDiffRequestIdRef.current !== requestId) return;
        setGitDiffPreview({
          path,
          staged,
          content: "",
          isLoading: false,
          error: String(error),
        });
      }
    },
    [daemon],
  );

  const handlePreviewGitDiff = useCallback(
    async (path: string, staged: boolean) => {
      setOpenTabs((prev) => {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      });
      setSelectedFile(path);
      setBinaryPreviewUrl(null);
      setEditorViewMode("git-diff");
      await loadGitDiffPreview(path, staged);
    },
    [loadGitDiffPreview],
  );

  useEffect(() => {
    if (selectedFile && !openTabs.includes(selectedFile)) {
      setOpenTabs((prev) => [...prev, selectedFile]);
    }
  }, [selectedFile, openTabs]);

  // Handle file changes - deletion and external modifications
  useEffect(() => {
    if (!daemon.lastFileChange) return;

    const { path, kind } = daemon.lastFileChange;

    if (kind === "remove") {
      if (splitPane?.openTabs.includes(path)) {
        setSplitPane(null);
      }
      // Check if the deleted file is in open tabs
      setOpenTabs((prev) => {
        if (!prev.includes(path)) return prev;

        const newTabs = prev.filter((p) => p !== path);

        // If the deleted file was selected, switch to another tab
        if (selectedFile === path) {
          if (newTabs.length > 0) {
            const nextFile = newTabs[0];
            if (nextFile) {
              handleFileSelect(nextFile);
            }
          } else {
            setSelectedFile(undefined);
            setFileContent("");
            setBinaryPreviewUrl(null);
            setGitDiffPreview(null);
            setEditorViewMode("file");
          }
        }

        return newTabs;
      });
    } else if (kind === "modify") {
      // Reload file content if the currently selected file was modified externally
      // Skip if this was our own save (within 2 seconds)
      const lastSave = lastSaveTimeRef.current;
      const isOurSave = lastSave && lastSave.path === path && Date.now() - lastSave.time < 2000;

      if (path === selectedFile && !isOurSave) {
        daemon
          .readFile(path)
          .then((content) => {
            if (content !== null) {
              setFileContent(content);
            }
          })
          .catch((err) => {
            console.error("Failed to reload modified file:", err);
          });
      }

      if (
        splitPane &&
        path === splitPane.selectedFile &&
        !splitPane.binaryPreviewUrl &&
        !isOurSave
      ) {
        daemon
          .readFile(path)
          .then((content) => {
            if (content !== null) {
              setSplitPane((prev) => {
                if (!prev || prev.selectedFile !== path) return prev;
                return {
                  ...prev,
                  content,
                  error: null,
                };
              });
            }
          })
          .catch((err) => {
            console.error("Failed to reload modified split file:", err);
          });
      }
      // Trigger OverLeaf auto-compile on external TeX/Bib edits (e.g. by AI agent or git)
      if (
        daemon.projectPath &&
        latexSettings.settings.mainFile &&
        hasAnyCompiler &&
        !isOurSave &&
        /\.(tex|bib|sty|cls)$/i.test(path)
      ) {
        latexCompiler.scheduleAutoCompile({
          directory: daemon.projectPath,
          mainFile: latexSettings.settings.mainFile,
        });
      }
    }
  }, [
    daemon.lastFileChange,
    daemon.projectPath,
    hasAnyCompiler,
    latexCompiler,
    latexSettings.settings.mainFile,
    selectedFile,
    handleFileSelect,
    daemon,
    splitPane,
  ]);

  const handleCloseTab = useCallback(
    (path: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setOpenTabs((prev) => {
        const newTabs = prev.filter((p) => p !== path);
        if (selectedFile === path) {
          const idx = prev.indexOf(path);
          const newSelected = newTabs[Math.min(idx, newTabs.length - 1)];
          if (newSelected) {
            handleFileSelect(newSelected);
          } else {
            setSelectedFile(undefined);
            setFileContent("");
            setBinaryPreviewUrl(null);
            setGitDiffPreview(null);
            setEditorViewMode("file");
          }
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect],
  );

  const handleCloseOtherTabs = useCallback(
    (keepPath: string) => {
      setOpenTabs([keepPath]);
      if (selectedFile !== keepPath) {
        handleFileSelect(keepPath);
      }
    },
    [selectedFile, handleFileSelect],
  );

  const handleCloseTabsToLeft = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx <= 0) return prev;
        const newTabs = prev.slice(idx);
        if (selectedFile && !newTabs.includes(selectedFile)) {
          handleFileSelect(path);
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect],
  );

  const handleCloseTabsToRight = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx === prev.length - 1) return prev;
        const newTabs = prev.slice(0, idx + 1);
        if (selectedFile && !newTabs.includes(selectedFile)) {
          handleFileSelect(path);
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect],
  );

  const handleCloseAllTabs = useCallback(() => {
    setOpenTabs([]);
    setSelectedFile(undefined);
    setFileContent("");
    setGitDiffPreview(null);
    setEditorViewMode("file");
    setSplitPane(null);
  }, []);

  const handleReorderTabs = useCallback(
    (draggedPath: string, targetPath: string, position: TabReorderPosition) => {
      if (draggedPath === targetPath) return;

      setOpenTabs((prev) => {
        const fromIndex = prev.indexOf(draggedPath);
        const targetIndex = prev.indexOf(targetPath);
        if (fromIndex < 0 || targetIndex < 0) return prev;

        const reordered = [...prev];
        const [movedTab] = reordered.splice(fromIndex, 1);
        if (!movedTab) return prev;

        const targetAfterRemoval = reordered.indexOf(targetPath);
        if (targetAfterRemoval < 0) return prev;

        const insertIndex = position === "before" ? targetAfterRemoval : targetAfterRemoval + 1;
        reordered.splice(insertIndex, 0, movedTab);
        return reordered;
      });
    },
    [],
  );

  const closeSplitPane = useCallback(() => {
    if (splitContentSaveTimeoutRef.current) {
      clearTimeout(splitContentSaveTimeoutRef.current);
      splitContentSaveTimeoutRef.current = null;
    }
    setSplitPane(null);
  }, []);

  const openFileInSplitPane = useCallback(
    async (path: string, side: SplitPaneSide, options?: { moveFromPrimary?: boolean }) => {
      const resolvedPath = resolveSelectablePath(path);
      const fileType = getFileType(resolvedPath);
      const requestId = splitLoadRequestIdRef.current + 1;
      splitLoadRequestIdRef.current = requestId;

      if (splitContentSaveTimeoutRef.current) {
        clearTimeout(splitContentSaveTimeoutRef.current);
        splitContentSaveTimeoutRef.current = null;
      }

      if (options?.moveFromPrimary) {
        setOpenTabs((prev) => {
          if (!prev.includes(resolvedPath)) return prev;

          const idx = prev.indexOf(resolvedPath);
          const newTabs = prev.filter((p) => p !== resolvedPath);
          if (selectedFile === resolvedPath) {
            const nextFile = newTabs[Math.min(idx, newTabs.length - 1)];
            if (nextFile) {
              void handleFileSelect(nextFile);
            } else {
              setSelectedFile(undefined);
              setFileContent("");
              setBinaryPreviewUrl(null);
              setGitDiffPreview(null);
              setEditorViewMode("file");
            }
          }
          return newTabs;
        });
      }

      if (fileType === "text") {
        setSplitPane((prev) => {
          const base: SplitPaneState = prev ?? {
            side,
            openTabs: [],
            selectedFile: undefined,
            content: "",
            isLoading: false,
            error: null,
            binaryPreviewUrl: null,
            pdfRefreshKey: 0,
          };
          return {
            ...base,
            side,
            openTabs: base.openTabs.includes(resolvedPath)
              ? base.openTabs
              : [...base.openTabs, resolvedPath],
            selectedFile: resolvedPath,
            content: "",
            isLoading: true,
            error: null,
            binaryPreviewUrl: null,
          };
        });

        try {
          const content = await daemon.readFile(resolvedPath);
          if (splitLoadRequestIdRef.current !== requestId) return;
          setSplitPane((prev) => {
            if (!prev || prev.selectedFile !== resolvedPath) return prev;
            return {
              ...prev,
              side,
              content: content ?? "",
              isLoading: false,
              error: null,
              binaryPreviewUrl: null,
            };
          });
        } catch (err) {
          if (splitLoadRequestIdRef.current !== requestId) return;
          const errorStr = String(err);
          if (errorStr.includes("FILE_NOT_FOUND")) {
            toast(`File "${pathSync.basename(resolvedPath)}" no longer exists`, "error");
            setSplitPane(null);
            return;
          }
          setSplitPane((prev) => {
            if (!prev || prev.selectedFile !== resolvedPath) return prev;
            return {
              ...prev,
              isLoading: false,
              error: errorStr,
            };
          });
        }
        return;
      }

      const fullPath = daemon.projectPath
        ? pathSync.join(daemon.projectPath, resolvedPath)
        : resolvedPath;
      setSplitPane((prev) => {
        const base: SplitPaneState = prev ?? {
          side,
          openTabs: [],
          selectedFile: undefined,
          content: "",
          isLoading: false,
          error: null,
          binaryPreviewUrl: null,
          pdfRefreshKey: 0,
        };
        return {
          ...base,
          side,
          openTabs: base.openTabs.includes(resolvedPath)
            ? base.openTabs
            : [...base.openTabs, resolvedPath],
          selectedFile: resolvedPath,
          content: "",
          isLoading: false,
          error: null,
          binaryPreviewUrl: convertFileSrc(fullPath),
          pdfRefreshKey: 0,
        };
      });
    },
    [daemon, getFileType, resolveSelectablePath, toast, selectedFile, handleFileSelect],
  );

  const handleSplitContentChange = useCallback(
    (content: string) => {
      setSplitPane((prev) => {
        if (!prev || prev.binaryPreviewUrl) return prev;
        return {
          ...prev,
          content,
        };
      });

      if (splitContentSaveTimeoutRef.current) {
        clearTimeout(splitContentSaveTimeoutRef.current);
      }

      const fileToSave = splitPane?.selectedFile;
      if (!fileToSave) return;

      splitContentSaveTimeoutRef.current = setTimeout(async () => {
        try {
          await daemon.writeFile(fileToSave, content);
          lastSaveTimeRef.current = { path: fileToSave, time: Date.now() };
          if (
            daemon.projectPath &&
            latexSettings.settings.mainFile &&
            hasAnyCompiler &&
            /\.(tex|bib|sty|cls)$/i.test(fileToSave)
          ) {
            latexCompiler.scheduleAutoCompile({
              directory: daemon.projectPath,
              mainFile: latexSettings.settings.mainFile,
            });
          }
        } catch (error) {
          console.error("Failed to save split pane file:", error);
        }
      }, 500);
    },
    [
      daemon,
      hasAnyCompiler,
      latexCompiler,
      latexSettings.settings.mainFile,
      splitPane?.selectedFile,
    ],
  );

  const handleSplitTabSelect = useCallback(
    (path: string) => {
      if (!splitPane) return;
      void openFileInSplitPane(path, splitPane.side);
    },
    [splitPane, openFileInSplitPane],
  );

  const handleSplitCloseTab = useCallback(
    (path: string) => {
      if (!splitPane) return;

      const idx = splitPane.openTabs.indexOf(path);
      if (idx < 0) return;
      const newTabs = splitPane.openTabs.filter((p) => p !== path);
      if (newTabs.length === 0) {
        closeSplitPane();
        return;
      }

      const nextSelected =
        splitPane.selectedFile === path
          ? newTabs[Math.min(idx, newTabs.length - 1)]
          : (splitPane.selectedFile ?? newTabs[0]);

      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile: nextSelected,
        };
      });

      if (splitPane.selectedFile === path && nextSelected) {
        void openFileInSplitPane(nextSelected, splitPane.side);
      }
    },
    [splitPane, closeSplitPane, openFileInSplitPane],
  );

  const handleSplitCloseOtherTabs = useCallback(
    (keepPath: string) => {
      if (!splitPane) return;
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: [keepPath],
          selectedFile: keepPath,
        };
      });
      if (splitPane.selectedFile !== keepPath) {
        void openFileInSplitPane(keepPath, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane],
  );

  const handleSplitCloseTabsToLeft = useCallback(
    (path: string) => {
      if (!splitPane) return;
      const idx = splitPane.openTabs.indexOf(path);
      if (idx <= 0) return;
      const newTabs = splitPane.openTabs.slice(idx);
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile:
            prev.selectedFile && newTabs.includes(prev.selectedFile) ? prev.selectedFile : path,
        };
      });
      if (splitPane.selectedFile && !newTabs.includes(splitPane.selectedFile)) {
        void openFileInSplitPane(path, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane],
  );

  const handleSplitCloseTabsToRight = useCallback(
    (path: string) => {
      if (!splitPane) return;
      const idx = splitPane.openTabs.indexOf(path);
      if (idx === splitPane.openTabs.length - 1) return;
      const newTabs = splitPane.openTabs.slice(0, idx + 1);
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile:
            prev.selectedFile && newTabs.includes(prev.selectedFile) ? prev.selectedFile : path,
        };
      });
      if (splitPane.selectedFile && !newTabs.includes(splitPane.selectedFile)) {
        void openFileInSplitPane(path, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane],
  );

  const handleSplitReorderTabs = useCallback(
    (draggedPath: string, targetPath: string, position: TabReorderPosition) => {
      if (draggedPath === targetPath) return;
      setSplitPane((prev) => {
        if (!prev) return prev;
        const fromIndex = prev.openTabs.indexOf(draggedPath);
        const targetIndex = prev.openTabs.indexOf(targetPath);
        if (fromIndex < 0 || targetIndex < 0) return prev;

        const reordered = [...prev.openTabs];
        const [movedTab] = reordered.splice(fromIndex, 1);
        if (!movedTab) return prev;

        const targetAfterRemoval = reordered.indexOf(targetPath);
        if (targetAfterRemoval < 0) return prev;

        const insertIndex = position === "before" ? targetAfterRemoval : targetAfterRemoval + 1;
        reordered.splice(insertIndex, 0, movedTab);
        return {
          ...prev,
          openTabs: reordered,
        };
      });
    },
    [],
  );

  const resolveSplitDropSide = useCallback(
    (clientX: number, clientY: number, source: DragSourcePane): SplitPaneSide | null => {
      const container = editorWorkspaceRef.current;
      if (!container) return null;

      const rect = container.getBoundingClientRect();
      const isInsideEditorWorkspace =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;

      if (!isInsideEditorWorkspace) return null;

      const hoveredSide: SplitPaneSide = clientX < rect.left + rect.width / 2 ? "left" : "right";

      if (!splitPane) return source === "primary" ? hoveredSide : null;

      const splitSide: SplitPaneSide = splitPane.side;
      const primarySide: SplitPaneSide = splitSide === "left" ? "right" : "left";

      if (source === "primary") {
        return hoveredSide === splitSide ? splitSide : null;
      }

      return hoveredSide === primarySide ? primarySide : null;
    },
    [splitPane],
  );

  const handleEditorTabDragMove = useCallback(
    (payload: TabDragMovePayload | null) => {
      if (!payload) {
        setSplitDropHint(null);
        return;
      }

      setSplitDropHint(resolveSplitDropSide(payload.clientX, payload.clientY, "primary"));
    },
    [resolveSplitDropSide],
  );

  const moveTabFromSplitToPrimary = useCallback(
    (path: string) => {
      if (!splitPane) return;
      const resolvedPath = resolveSelectablePath(path);
      const currentIndex = splitPane.openTabs.indexOf(resolvedPath);
      if (currentIndex < 0) return;

      const nextTabs = splitPane.openTabs.filter((p) => p !== resolvedPath);
      if (nextTabs.length === 0) {
        closeSplitPane();
      } else {
        const nextSelected =
          splitPane.selectedFile === resolvedPath
            ? nextTabs[Math.min(currentIndex, nextTabs.length - 1)]
            : (splitPane.selectedFile ?? nextTabs[0]);

        setSplitPane((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            openTabs: nextTabs,
            selectedFile: nextSelected,
          };
        });

        if (splitPane.selectedFile === resolvedPath && nextSelected) {
          void openFileInSplitPane(nextSelected, splitPane.side);
        }
      }

      void handleFileSelect(resolvedPath);
    },
    [splitPane, resolveSelectablePath, closeSplitPane, openFileInSplitPane, handleFileSelect],
  );

  const handleSplitTabDragMove = useCallback(
    (payload: TabDragMovePayload | null) => {
      if (!payload) {
        setSplitDropHint(null);
        return;
      }

      setSplitDropHint(resolveSplitDropSide(payload.clientX, payload.clientY, "split"));
    },
    [resolveSplitDropSide],
  );

  const handleEditorTabDragEnd = useCallback(
    (payload: TabDragEndPayload) => {
      setSplitDropHint(null);
      if (payload.dropTarget.type !== "outside") return;

      const side = resolveSplitDropSide(payload.clientX, payload.clientY, "primary");
      if (!side) return;

      void openFileInSplitPane(payload.tabId, side, { moveFromPrimary: true });
    },
    [openFileInSplitPane, resolveSplitDropSide],
  );

  const handleSplitTabDragEnd = useCallback(
    (payload: TabDragEndPayload) => {
      setSplitDropHint(null);
      if (payload.dropTarget.type !== "outside") return;

      const side = resolveSplitDropSide(payload.clientX, payload.clientY, "split");
      if (!side || !splitPane) return;

      const primarySide: SplitPaneSide = splitPane.side === "left" ? "right" : "left";
      if (side !== primarySide) return;

      moveTabFromSplitToPrimary(payload.tabId);
    },
    [resolveSplitDropSide, splitPane, moveTabFromSplitToPrimary],
  );

  const splitPaneTabs = useMemo(
    (): TabItem[] =>
      splitPane?.openTabs.map((path) => ({
        id: path,
        label: pathSync.basename(path),
        title: path,
      })) ?? [],
    [splitPane?.openTabs],
  );

  const renderSplitPane = useCallback(
    (side: SplitPaneSide) => {
      if (!splitPane || splitPane.side !== side) return null;
      const splitSelectedFile = splitPane.selectedFile;
      const splitFileType = splitSelectedFile ? getFileType(splitSelectedFile) : "text";

      return (
        <div className="h-full min-h-0 flex flex-col overflow-hidden">
          {splitSelectedFile && (
            <div>
              <TabBar
                tabs={splitPaneTabs}
                activeTab={splitSelectedFile}
                onTabSelect={handleSplitTabSelect}
                onTabClose={handleSplitCloseTab}
                onTabReorder={handleSplitReorderTabs}
                onTabDragMove={handleSplitTabDragMove}
                onTabDragEnd={handleSplitTabDragEnd}
                onCloseOthers={handleSplitCloseOtherTabs}
                onCloseToLeft={handleSplitCloseTabsToLeft}
                onCloseToRight={handleSplitCloseTabsToRight}
                onCloseAll={closeSplitPane}
                variant="editor"
              />
            </div>
          )}

          <div className="flex-1 min-h-0">
            {!splitSelectedFile ? (
              <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                Drag a tab here to open a second editor group.
              </div>
            ) : splitPane.isLoading ? (
              <EditorSkeleton className="h-full" />
            ) : splitPane.error ? (
              <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                Failed to load file: {splitPane.error}
              </div>
            ) : splitPane.binaryPreviewUrl ? (
              <div className="h-full flex items-center justify-center overflow-auto p-4 bg-accent-hover">
                {splitFileType === "image" ? (
                  <Image
                    unoptimized
                    src={splitPane.binaryPreviewUrl}
                    alt={splitSelectedFile}
                    width={1200}
                    height={900}
                    className="max-w-full max-h-full object-contain"
                  />
                ) : splitFileType === "pdf" ? (
                  <PdfViewer
                    src={splitPane.binaryPreviewUrl}
                    refreshKey={splitPane.pdfRefreshKey}
                    onSynctexClick={handleSplitSynctexClick}
                  />
                ) : (
                  <iframe
                    key={splitPane.pdfRefreshKey}
                    src={splitPane.binaryPreviewUrl}
                    className="w-full h-full border-0"
                    title={`PDF: ${splitSelectedFile}`}
                  />
                )}
              </div>
            ) : (
              <EditorErrorBoundary>
                <MonacoEditor
                  content={splitPane.content}
                  readOnly={false}
                  onContentChange={handleSplitContentChange}
                  language={getFileLanguage(splitSelectedFile)}
                  filePath={splitSelectedFile}
                  bibEntries={bibEntries}
                  texLabels={texLabels}
                  onCompileShortcut={() => {
                    void handleCompileWithDetection();
                  }}
                  editorSettings={editorSettings.settings}
                  editorTheme={editorSettings.editorTheme}
                  className="h-full"
                />
              </EditorErrorBoundary>
            )}
          </div>
        </div>
      );
    },
    [
      splitPane,
      getFileType,
      closeSplitPane,
      splitPaneTabs,
      handleSplitTabSelect,
      handleSplitCloseTab,
      handleSplitReorderTabs,
      handleSplitTabDragMove,
      handleSplitTabDragEnd,
      handleSplitCloseOtherTabs,
      handleSplitCloseTabsToLeft,
      handleSplitCloseTabsToRight,
      handleSplitSynctexClick,
      handleSplitContentChange,
      handleCompileWithDetection,
      bibEntries,
      texLabels,
      getFileLanguage,
      editorSettings.settings,
      editorSettings.editorTheme,
    ],
  );

  // Convert openTabs to TabItem format for TabBar
  const editorTabs = useMemo(
    (): TabItem[] =>
      openTabs.map((path) => ({
        id: path,
        label: pathSync.basename(path),
        title: path,
      })),
    [openTabs],
  );

  // Sidebar tabs configuration
  const sidebarTabs = useMemo(
    (): TabItem[] => [
      { id: "files", label: "Files" },
      { id: "outline", label: "Outline" },
      {
        id: "git",
        label: "Git",
        badge: gitStatus && gitStatus.changes.length > 0 ? gitStatus.changes.length : undefined,
      },
    ],
    [gitStatus],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      setFileContent(content);

      if (savingVisualTimeoutRef.current) {
        clearTimeout(savingVisualTimeoutRef.current);
      }

      savingVisualTimeoutRef.current = setTimeout(() => {
        setIsSaving(true);
      }, 300);

      if (contentSaveTimeoutRef.current) {
        clearTimeout(contentSaveTimeoutRef.current);
      }

      const fileToSave = selectedFile;
      contentSaveTimeoutRef.current = setTimeout(async () => {
        if (fileToSave) {
          try {
            await daemon.writeFile(fileToSave, content);
            lastSaveTimeRef.current = { path: fileToSave, time: Date.now() };
            if (
              daemon.projectPath &&
              latexSettings.settings.mainFile &&
              hasAnyCompiler &&
              /\.(tex|bib|sty|cls)$/i.test(fileToSave)
            ) {
              latexCompiler.scheduleAutoCompile({
                directory: daemon.projectPath,
                mainFile: latexSettings.settings.mainFile,
              });
            }
          } catch (error) {
            console.error("Failed to save file:", error);
          }
        }
        if (savingVisualTimeoutRef.current) {
          clearTimeout(savingVisualTimeoutRef.current);
          savingVisualTimeoutRef.current = null;
        }
        setIsSaving(false);
      }, 500);
    },
    [selectedFile, daemon, hasAnyCompiler, latexCompiler, latexSettings.settings.mainFile],
  );

  const handleOpenFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select LaTeX Project",
      });

      if (selected && typeof selected === "string") {
        await daemon.setProject(selected);
        await recentProjects.addProject(selected);
        setShowSidebar(true);
        setShowRightPanel(true);
      }
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  }, [daemon, recentProjects]);

  const handleOpenRecentProject = useCallback(
    async (path: string) => {
      try {
        await daemon.setProject(path);
        await recentProjects.addProject(path);
        setShowSidebar(true);
        setShowRightPanel(true);
      } catch (err) {
        console.error("Failed to open project:", err);
        toast("Failed to open project", "error");
        recentProjects.removeProject(path);
      }
    },
    [daemon, recentProjects, toast],
  );

  const handleStageAll = useCallback(() => {
    if (!gitStatus) return;
    const unstaged = gitStatus.changes
      .filter((c: { staged: boolean }) => !c.staged)
      .map((c: { path: string }) => c.path);
    if (unstaged.length > 0) {
      daemon.gitAdd(unstaged);
    }
  }, [gitStatus, daemon]);

  const handleStageFile = useCallback(
    (path: string) => {
      daemon.gitAdd([path]);
    },
    [daemon],
  );

  const handleUnstageAll = useCallback(() => {
    const stagedPaths = (daemon.gitStatus?.changes ?? [])
      .filter((c: { staged: boolean }) => c.staged)
      .map((c: { path: string }) => c.path);
    if (stagedPaths.length > 0) {
      daemon.gitUnstage(stagedPaths);
    }
  }, [daemon]);

  const handleUnstageFile = useCallback(
    (path: string) => {
      daemon.gitUnstage([path]);
    },
    [daemon],
  );

  const handleRemoteSubmit = useCallback(() => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;
    daemon.gitAddRemote(trimmed);
    setRemoteUrl("");
    setShowRemoteInput(false);
  }, [daemon, remoteUrl]);

  const handleGitPush = useCallback(async () => {
    const result = await daemon.gitPush();
    if (result.success) {
      toast("Changes pushed successfully", "success");
    } else {
      toast(result.error || "Failed to push changes", "error");
    }
  }, [daemon, toast]);

  const handleGitPull = useCallback(async () => {
    const result = await daemon.gitPull();
    if (result.success) {
      toast("Changes pulled successfully", "success");
    } else {
      toast(result.error || "Failed to pull changes", "error");
    }
  }, [daemon, toast]);

  const handleRefreshGitStatus = useCallback(() => {
    void daemon.refreshGitStatus(true);
  }, [daemon]);

  const handleDiscardAll = useCallback(async () => {
    const result = await daemon.gitDiscardAll();
    if (result.success) {
      toast("All changes discarded", "success");
    } else {
      toast(result.error || "Failed to discard changes", "error");
    }
  }, [daemon, toast]);

  const handleDiscardFile = useCallback(
    async (path: string) => {
      const result = await daemon.gitDiscardFile(path);
      if (result.success) {
        toast(`Discarded changes: ${path}`, "success");
      } else {
        toast(result.error || "Failed to discard file", "error");
      }
    },
    [daemon, toast],
  );

  const handlePublishToGitHub = useCallback(async () => {
    setGhPublishError(null);

    const status = await daemon.ghCheck();
    if (!status.installed) {
      toast("GitHub CLI (gh) is not installed. Install it from https://cli.github.com", "error");
      return;
    }

    if (!status.authenticated) {
      if (daemon.isAuthenticatingGh) {
        toast("GitHub authentication is already in progress in the terminal window.", "info");
        return;
      }

      toast(
        "Terminal opened for GitHub login. Complete prompts there (type Y when asked), then continue in browser.",
        "info",
      );
      const loginResult = await daemon.ghAuthLogin();
      if (!loginResult.success || !loginResult.authenticated) {
        toast(loginResult.error || "GitHub authentication failed", "error");
        return;
      }
      toast("Authenticated with GitHub", "success");
    }

    setShowGitHubPublishDialog(true);
  }, [daemon, toast]);

  const handleGitHubPublish = useCallback(
    async (name: string, isPrivate: boolean, description: string) => {
      setGhPublishError(null);
      const result = await daemon.ghCreateRepo(name, isPrivate, description || undefined);
      if (result.success) {
        setShowGitHubPublishDialog(false);
        toast(`Repository published: ${result.url}`, "success");
      } else {
        setGhPublishError(result.error || "Failed to create repository");
      }
    },
    [daemon, toast],
  );

  const handleAskAgentSelection = useCallback(
    (selectionText: string, filePath: string, startLine: number, endLine: number) => {
      setShowRightPanel(true);
      const loc =
        filePath && startLine > 0
          ? `${filePath}:${startLine}${endLine > startLine ? `-${endLine}` : ""}`
          : filePath || "current file";
      const snippet = selectionText.trim();
      const draft = snippet
        ? `Regarding \`${loc}\`:\n\`\`\`latex\n${snippet}\n\`\`\`\n`
        : `Regarding \`${loc}\`: `;
      setAgentDraftInjection({ id: Date.now(), text: draft });
    },
    [],
  );

  const handleFixDiagnosticsWithAi = useCallback(
    (diags: LatexDiagnostic[]) => {
      if (diags.length === 0) return;
      setShowRightPanel(true);
      const list = diags
        .slice(0, 12)
        .map(
          (d, i) =>
            `${i + 1}. [${d.severity}] ${d.file}${d.line > 0 ? `:${d.line}` : ""}: ${d.message}`,
        )
        .join("\n");
      const mainHint = latexSettings.settings.mainFile
        ? `Main file: ${latexSettings.settings.mainFile}\n\n`
        : "";
      const prompt = `Please fix these LaTeX compilation issues:\n\n${mainHint}${list}`;
      void agent.sendMessage(prompt);
    },
    [agent, latexSettings.settings.mainFile],
  );

  const handleGenerateCommitMessageAI = useCallback(async () => {
    if (!daemon.projectPath) {
      toast("Please open a project first.", "error");
      return;
    }

    if (stagedChanges.length === 0) {
      toast("Stage files before generating commit message.", "error");
      return;
    }

    setShowCommitInput(true);
    setIsGeneratingCommitMessageAI(true);

    try {
      const diffChunks: string[] = await Promise.all(
        stagedChanges.map((change: { path: string }) => daemon.gitDiff(change.path, true)),
      );
      const mergedDiff = diffChunks
        .filter((chunk: string) => chunk.trim().length > 0)
        .join("\n\n")
        .slice(0, AI_COMMIT_DIFF_LIMIT)
        .trim();

      if (!mergedDiff) {
        toast("No textual staged diff available.", "error");
        return;
      }

      const prompt = buildAiCommitPrompt(mergedDiff, "staged");
      const aiRaw = await agent.runOneShotPrompt(prompt);
      const aiMessage = sanitizeAiCommitMessage(aiRaw);

      if (!aiMessage) {
        toast("AI returned an empty commit message.", "error");
        return;
      }

      setCommitMessage(aiMessage);
      toast("AI commit draft generated.", "success");
    } catch (error) {
      console.error("Failed to generate AI commit message:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast(`AI draft failed: ${errorMessage}`, "error");
    } finally {
      setIsGeneratingCommitMessageAI(false);
    }
  }, [agent, daemon, stagedChanges, toast]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    const result = await daemon.gitCommit(commitMessage.trim());
    if (result.success) {
      toast("Changes committed", "success");
      setCommitMessage("");
      setShowCommitInput(false);
    } else {
      toast(result.error || "Failed to commit", "error");
    }
  }, [commitMessage, daemon, toast]);

  const validateFileName = useCallback((name: string): string | null => {
    if (!name.trim()) {
      return "Name cannot be empty";
    }
    if (name.includes("/") || name.includes("\\")) {
      return "Name cannot contain / or \\";
    }
    if (name.startsWith(".")) {
      return "Name cannot start with .";
    }
    return null;
  }, []);

  const handleCreateConfirm = useCallback(
    async (value: string) => {
      if (!createDialog) return;
      try {
        if (createDialog.type === "file") {
          await daemon.createFile(value);
        } else {
          await daemon.createDirectory(value);
        }
        setCreateDialog(null);
      } catch (error) {
        toast(`Failed to create: ${error}`, "error");
      }
    },
    [createDialog, daemon, toast],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (isMod && key === "o" && !e.shiftKey) {
        e.preventDefault();
        handleOpenFolder();
        return;
      }

      if (isMod && key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (selectedFile) {
          handleCloseTab(selectedFile);
        }
        return;
      }

      // Compile LaTeX: Cmd/Ctrl+Shift+B
      if (isMod && e.shiftKey && key === "b") {
        e.preventDefault();
        if (daemon.projectPath) {
          void handleCompileWithDetection();
        }
        return;
      }

      // Toggle Agent panel: Cmd/Ctrl+L
      if (isMod && !e.shiftKey && key === "l") {
        e.preventDefault();
        setShowRightPanel((prev) => !prev);
        return;
      }

      // Toggle Live PDF Preview: Cmd/Ctrl+P
      if (isMod && !e.shiftKey && key === "p") {
        e.preventDefault();
        if (daemon.projectPath) {
          setShowLivePreview((prev) => !prev);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [daemon, handleOpenFolder, selectedFile, handleCloseTab, handleCompileWithDetection]);

  const handleCompileShortcut = useCallback(() => {
    void handleCompileWithDetection();
  }, [handleCompileWithDetection]);

  const handleEditorForwardSync = useCallback(
    (line: number, col: number) => {
      void handleForwardSync(line, col);
    },
    [handleForwardSync],
  );

  const handleStopCompile = useCallback(() => {
    void latexCompiler.stopCompilation();
  }, [latexCompiler]);

  const handleToggleAutoCompile = useCallback(() => {
    latexSettings.updateSettings({
      autoCompile: !latexSettings.settings.autoCompile,
    });
  }, [latexSettings]);

  const handleCleanAuxFiles = useCallback(async () => {
    const removed = await latexCompiler.cleanAuxFiles();
    toast(
      removed.length > 0
        ? `Removed ${removed.length} auxiliary file(s)`
        : "No auxiliary files to clean",
      "success",
    );
  }, [latexCompiler, toast]);

  const handleLivePreviewForwardSync = useCallback(() => {
    void handleForwardSync();
  }, [handleForwardSync]);

  const handleJumpToDiagnostic = useCallback(
    (diag: LatexDiagnostic) => {
      const target = diag.file.replace(/^\.\//, "");
      void handleFileSelect(target).then(() => {
        if (diag.line > 0) setPendingGoToLine(diag.line);
      });
    },
    [handleFileSelect],
  );

  const handleCloseLivePreview = useCallback(() => setShowLivePreview(false), []);
  const handleOutlineJumpToLine = useCallback((line: number) => setPendingGoToLine(line), []);
  const handleOutlineOpenInputFile = useCallback(
    (relPath: string) => {
      void handleFileSelect(relPath);
    },
    [handleFileSelect],
  );
  const handleAgentDraftConsumed = useCallback(() => setAgentDraftInjection(null), []);
  const handleAgentFileClick = useCallback(
    (path: string) => {
      void handleFileSelect(path);
    },
    [handleFileSelect],
  );
  const handleAgentRunTerminalCommand = useCallback((cmd: string) => {
    setShowTerminal(true);
    setPendingTerminalCommand({ id: Date.now(), command: cmd });
  }, []);
  const handleOpenAgentSettings = useCallback(() => {
    setSettingsInitialTab("agents");
    setShowLatexSettings(true);
  }, []);
  const handleCloseRightPanel = useCallback(() => setShowRightPanel(false), []);
  const handleResetAgentBoundary = useCallback(() => {
    void agent.refreshProviders();
  }, [agent]);

  const activeFileDiagnostics = useMemo(() => {
    if (!selectedFile || latexCompiler.diagnostics.length === 0) return [];
    const normSelected = selectedFile.replace(/\\/g, "/");
    const baseSelected = pathSync.basename(normSelected);
    return latexCompiler.diagnostics.filter((d) => {
      const df = d.file.replace(/\\/g, "/").replace(/^\.\//, "");
      return df === normSelected || df === baseSelected || normSelected.endsWith(`/${df}`);
    });
  }, [latexCompiler.diagnostics, selectedFile]);

  const isShowingGitDiff =
    editorViewMode === "git-diff" && !!gitDiffPreview && selectedFile === gitDiffPreview.path;

  const gitDiffContent = gitDiffPreview?.content;
  const parsedGitDiff = useMemo(() => {
    if (!gitDiffContent) return null;
    return parseUnifiedDiffContent(gitDiffContent);
  }, [gitDiffContent]);

  const primaryEditorPaneContent = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {selectedFile && (
        <TabBar
          tabs={editorTabs}
          activeTab={selectedFile}
          onTabSelect={handleFileSelect}
          onTabClose={handleCloseTab}
          onTabReorder={handleReorderTabs}
          onTabDragMove={handleEditorTabDragMove}
          onTabDragEnd={handleEditorTabDragEnd}
          onCloseOthers={handleCloseOtherTabs}
          onCloseToLeft={handleCloseTabsToLeft}
          onCloseToRight={handleCloseTabsToRight}
          onCloseAll={handleCloseAllTabs}
          variant="editor"
        />
      )}

      {selectedFile ? (
        isShowingGitDiff ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="border-b border-border bg-accent-hover px-3 py-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{gitDiffPreview.path}</div>
                <div className="text-xs text-muted flex items-center gap-2">
                  <span>{gitDiffPreview.staged ? "Staged changes" : "Working tree changes"}</span>
                  {parsedGitDiff?.hasRenderableHunks && (
                    <span>
                      +{parsedGitDiff.added} / -{parsedGitDiff.removed}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void loadGitDiffPreview(gitDiffPreview.path, gitDiffPreview.staged)
                  }
                  className="btn btn-sm btn-secondary"
                >
                  Refresh Diff
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleFileSelect(gitDiffPreview.path);
                  }}
                  className="btn btn-sm btn-secondary"
                >
                  Open File
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              {gitDiffPreview.isLoading ? (
                <EditorSkeleton className="h-full" />
              ) : gitDiffPreview.error ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  Failed to load diff: {gitDiffPreview.error}
                </div>
              ) : parsedGitDiff?.isBinary ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  Binary file diff is not previewable in editor.
                </div>
              ) : !gitDiffPreview.content.trim() ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  No textual diff available for this file.
                </div>
              ) : parsedGitDiff?.hasRenderableHunks ? (
                <GitMonacoDiffEditor
                  original={parsedGitDiff.original}
                  modified={parsedGitDiff.modified}
                  filePath={gitDiffPreview.path}
                  editorSettings={editorSettings.settings}
                  className="h-full"
                />
              ) : (
                <MonacoEditor
                  content={gitDiffPreview.content}
                  readOnly
                  onContentChange={() => {}}
                  language="diff"
                  editorSettings={editorSettings.settings}
                  editorTheme={editorSettings.editorTheme}
                  className="h-full"
                />
              )}
            </div>
          </div>
        ) : binaryPreviewUrl ? (
          <div className="flex-1 flex flex-col bg-accent-hover overflow-hidden">
            {getFileType(selectedFile) === "image" ? (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <Image
                  unoptimized
                  src={binaryPreviewUrl}
                  alt={selectedFile}
                  width={1200}
                  height={900}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            ) : getFileType(selectedFile) === "pdf" ? (
              <PdfViewer
                src={binaryPreviewUrl}
                refreshKey={pdfRefreshKey}
                onSynctexClick={handleSynctexClick}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <iframe
                  key={pdfRefreshKey}
                  src={binaryPreviewUrl}
                  className="w-full h-full border-0"
                  title={`File: ${selectedFile}`}
                />
              </div>
            )}
          </div>
        ) : isLoadingFile ? (
          <EditorSkeleton className="flex-1 min-h-0" />
        ) : (
          <motion.div
            key={selectedFile}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="flex-1 min-h-0"
          >
            <EditorErrorBoundary>
              <MonacoEditor
                content={fileContent}
                readOnly={false}
                onContentChange={handleContentChange}
                language={getFileLanguage(selectedFile)}
                filePath={selectedFile}
                diagnostics={activeFileDiagnostics}
                bibEntries={bibEntries}
                texLabels={texLabels}
                onCompileShortcut={handleCompileShortcut}
                onForwardSync={handleEditorForwardSync}
                onAskAgent={handleAskAgentSelection}
                onCursorChange={setCursorPosition}
                editorSettings={editorSettings.settings}
                editorTheme={editorSettings.editorTheme}
                goToLine={pendingGoToLine}
                className="h-full"
              />
            </EditorErrorBoundary>
          </motion.div>
        )
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center px-6 text-sm text-muted bg-accent-hover">
          Drop a tab here to open this panel.
        </div>
      )}
    </div>
  );

  const editorPanelItems: DockviewPanelItem[] = [];
  if (selectedFile || openTabs.length > 0) {
    editorPanelItems.push({
      id: "editor-primary",
      title: selectedFile ? pathSync.basename(selectedFile) : "Editor",
      content: primaryEditorPaneContent,
      inactive: false,
    });
  }
  if (splitPane) {
    editorPanelItems.push({
      id: `editor-split-${splitPane.side}`,
      title: splitPane.selectedFile ? pathSync.basename(splitPane.selectedFile) : "Split",
      content: renderSplitPane(splitPane.side),
      inactive: false,
      position: {
        referencePanel: "editor-primary",
        direction: splitPane.side,
      },
    });
  }

  return (
    <div className="h-dvh flex flex-col">
      <div className="flex-shrink-0 flex flex-col">
        <header className="h-12 border-b border-border flex items-center">
          <div className="w-full px-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => {
                  import("@tauri-apps/plugin-shell").then(({ open }) => {
                    open("https://writer.lmms-lab.com");
                  });
                }}
                className="hover:opacity-70 transition-opacity flex items-center"
                title="Visit writer.lmms-lab.com"
                aria-label="Open LMMs-Lab website"
              >
                <Image
                  src="/logo-small-light.svg"
                  alt="LMMs-Lab Writer"
                  width={140}
                  height={28}
                  className="h-7 w-auto dark:hidden"
                />
                <Image
                  src="/logo-small-dark.svg"
                  alt="LMMs-Lab Writer"
                  width={140}
                  height={28}
                  className="h-7 w-auto hidden dark:block"
                />
              </button>
              <span className="text-border">/</span>
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-sm font-medium px-2 py-1 -ml-2 truncate">
                  {daemon.projectPath ? pathSync.basename(daemon.projectPath) : "LMMs-Lab Writer"}
                </div>
                {isSaving && <span className="text-xs text-muted shrink-0">Saving...</span>}
              </div>
            </div>

            <div className="flex items-center gap-3 h-8">
              {daemon.projectPath && (
                <button
                  type="button"
                  onClick={() => setShowSidebar((prev) => !prev)}
                  className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                    showSidebar
                      ? "border-foreground"
                      : "hover:bg-accent-hover hover:border-border-dark"
                  }`}
                  title="Toggle Sidebar"
                >
                  <SidebarSimpleIcon className="size-4" weight="bold" />
                </button>
              )}

              {daemon.projectPath && (
                <button
                  type="button"
                  onClick={() => setShowTerminal((prev) => !prev)}
                  className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                    showTerminal
                      ? "border-foreground"
                      : "hover:bg-accent-hover hover:border-border-dark"
                  }`}
                  title="Toggle Terminal"
                >
                  <TerminalIcon className="size-4" weight="bold" />
                </button>
              )}

              <button
                type="button"
                onClick={handleToggleRightPanel}
                className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                  showRightPanel
                    ? "border-foreground"
                    : "hover:bg-accent-hover hover:border-border-dark"
                }`}
                title="Toggle Agent Mode"
              >
                <RobotIcon className="size-4" weight="bold" />
              </button>

              {daemon.projectPath && (
                <>
                  <span className="text-border text-lg select-none">/</span>
                  <div className="flex items-center gap-2 h-8">
                    <button
                      type="button"
                      onClick={() => {
                        void handleCompileWithDetection();
                      }}
                      disabled={latexSettings.isDetecting || latexCompiler.isCompiling}
                      className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                        latexSettings.isDetecting || latexCompiler.isCompiling
                          ? "opacity-70 cursor-wait"
                          : "hover:bg-accent-hover hover:border-border-dark"
                      }`}
                      title="Compile LaTeX (Cmd/Ctrl+Shift+B)"
                      aria-label="Compile LaTeX"
                    >
                      {latexCompiler.isCompiling ? (
                        <SpinnerGapIcon className="size-4 animate-spin" />
                      ) : (
                        <PlayCircleIcon className="size-4" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowLivePreview((prev) => !prev)}
                      className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                        showLivePreview
                          ? "border-foreground"
                          : "hover:bg-accent-hover hover:border-border-dark"
                      }`}
                      title="Toggle Live PDF Preview (Cmd/Ctrl+P)"
                      aria-label="Toggle Live PDF Preview"
                    >
                      <FilePdfIcon className="size-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setSettingsInitialTab("build");
                        setShowLatexSettings(true);
                      }}
                      className="h-8 w-8 border border-border bg-background text-foreground hover:bg-accent-hover hover:border-border-dark transition-colors flex items-center justify-center"
                      title="Settings"
                      aria-label="Settings"
                    >
                      <GearIcon className="size-4" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
      </div>

      <main className="flex-1 min-h-0 flex relative overflow-hidden">
        <AnimatePresence mode="wait">
          {showSidebar && (
            <motion.div
              key="sidebar-container"
              initial={prefersReducedMotion ? { opacity: 1 } : { x: -280, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { x: -280, opacity: 0 }}
              transition={prefersReducedMotion ? INSTANT_TRANSITION : PANEL_SPRING}
              className="flex flex-shrink-0"
              style={{
                willChange: prefersReducedMotion ? undefined : "transform, opacity",
              }}
            >
              <aside
                style={{
                  width: resizing === "sidebar" ? "var(--sidebar-width)" : sidebarWidth,
                  willChange: resizing === "sidebar" ? "width" : undefined,
                }}
                className="border-r border-border flex flex-col flex-shrink-0 overflow-hidden"
              >
                <TabBar
                  tabs={sidebarTabs}
                  activeTab={sidebarTab}
                  onTabSelect={(id) => setSidebarTab(id as "files" | "outline" | "git")}
                  variant="sidebar"
                />

                {sidebarTab === "files" && (
                  <FileSidebarPanel
                    projectPath={daemon.projectPath}
                    files={daemon.files}
                    selectedFile={selectedFile}
                    highlightedFile={highlightedFile}
                    onFileSelect={handleFileSelect}
                    onCreateFile={() => setCreateDialog({ type: "file" })}
                    onCreateDirectory={() => setCreateDialog({ type: "directory" })}
                    onRefreshFiles={daemon.refreshFiles}
                    fileOperations={{
                      createFile: daemon.createFile,
                      createDirectory: daemon.createDirectory,
                      renamePath: daemon.renamePath,
                      deletePath: daemon.deletePath,
                    }}
                  />
                )}

                {sidebarTab === "outline" && (
                  <SidebarOutlinePanel
                    activeFile={selectedFile ?? null}
                    content={outlineContent}
                    onJumpToLine={handleOutlineJumpToLine}
                    onOpenInputFile={handleOutlineOpenInputFile}
                  />
                )}

                {sidebarTab === "git" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <GitSidebarPanel
                      projectPath={daemon.projectPath}
                      gitStatus={gitStatus}
                      gitGraph={daemon.gitGraph}
                      gitLogEntries={daemon.gitLogEntries}
                      stagedChanges={stagedChanges}
                      unstagedChanges={unstagedChanges}
                      showRemoteInput={showRemoteInput}
                      remoteUrl={remoteUrl}
                      onRemoteUrlChange={(value) => setRemoteUrl(value)}
                      onShowRemoteInput={() => setShowRemoteInput(true)}
                      onHideRemoteInput={() => setShowRemoteInput(false)}
                      onSubmitRemote={handleRemoteSubmit}
                      onInitGit={daemon.gitInit}
                      isInitializingGit={daemon.isInitializingGit}
                      onRefreshStatus={handleRefreshGitStatus}
                      onStageAll={handleStageAll}
                      onDiscardAll={handleDiscardAll}
                      onDiscardFile={handleDiscardFile}
                      onStageFile={handleStageFile}
                      onUnstageFile={handleUnstageFile}
                      onUnstageAll={handleUnstageAll}
                      showCommitInput={showCommitInput}
                      commitMessage={commitMessage}
                      onCommitMessageChange={(value) => setCommitMessage(value)}
                      onShowCommitInput={() => setShowCommitInput(true)}
                      onHideCommitInput={() => setShowCommitInput(false)}
                      onCommit={handleCommit}
                      onPush={handleGitPush}
                      onPull={handleGitPull}
                      onPreviewDiff={handlePreviewGitDiff}
                      onGenerateCommitMessageAI={handleGenerateCommitMessageAI}
                      onOpenFile={(path) => {
                        void handleFileSelect(path);
                      }}
                      onPublishToGitHub={handlePublishToGitHub}
                      isGeneratingCommitMessageAI={isGeneratingCommitMessageAI}
                      isPushing={daemon.isPushing}
                      isPulling={daemon.isPulling}
                      isAuthenticatingGh={daemon.isAuthenticatingGh}
                    />
                  </div>
                )}
              </aside>
              <div className="relative group w-1 flex-shrink-0">
                <motion.div
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0}
                  dragMomentum={false}
                  onDragStart={() => startResize("sidebar")}
                  onDrag={(_event, info) => handleResizeDrag("sidebar", info)}
                  onDragEnd={endResize}
                  className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize z-10"
                  style={{ x: 0 }}
                />
                <div
                  className={`w-full h-full transition-colors ${resizing === "sidebar" ? "bg-foreground/20" : "group-hover:bg-foreground/20"}`}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 min-w-0 w-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              {daemon.projectPath && editorPanelItems.length > 0 ? (
                <div ref={editorWorkspaceRef} className="relative flex-1 min-h-0">
                  {splitDropHint && (
                    <div className="pointer-events-none absolute inset-0 z-10">
                      <div
                        className={`absolute inset-y-0 w-1/2 transition-opacity duration-100 ${
                          splitDropHint === "left"
                            ? "left-0 border-r border-accent/40 bg-gradient-to-r from-foreground/15 to-transparent shadow-[inset_-20px_0_24px_-20px_rgba(0,0,0,0.45)]"
                            : "right-0 border-l border-accent/40 bg-gradient-to-l from-foreground/15 to-transparent shadow-[inset_20px_0_24px_-20px_rgba(0,0,0,0.45)]"
                        }`}
                      />
                    </div>
                  )}

                  <DockviewPanelLayout
                    panels={editorPanelItems}
                    className="dockview-editor-layout"
                  />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  {daemon.projectPath ? (
                    <div className="text-center space-y-2 px-6">
                      <div className="text-xs font-mono uppercase tracking-wider text-muted">
                        No File Open
                      </div>
                      <p className="text-xs text-muted">
                        Select a .tex file from the sidebar or ask the Agent to create one.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center text-center px-6">
                      <Image
                        src="/logo-light.svg"
                        alt="LMMs-Lab Writer"
                        width={320}
                        height={96}
                        className="h-24 w-auto mb-10 dark:hidden"
                      />
                      <Image
                        src="/logo-dark.svg"
                        alt="LMMs-Lab Writer"
                        width={320}
                        height={96}
                        className="h-24 w-auto mb-10 hidden dark:block"
                      />
                      <button type="button" onClick={handleOpenFolder} className="btn btn-primary">
                        Open Folder
                      </button>
                      <RecentProjects
                        projects={recentProjects.projects}
                        onSelect={handleOpenRecentProject}
                        onRemove={recentProjects.removeProject}
                        onClearAll={recentProjects.clearAll}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {daemon.projectPath && showLivePreview && (
              <>
                <div className="relative group w-1 flex-shrink-0">
                  <motion.div
                    drag="x"
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={0}
                    dragMomentum={false}
                    onDragStart={() => startResize("preview")}
                    onDrag={(_event, info) => handleResizeDrag("preview", info)}
                    onDragEnd={endResize}
                    className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize z-10"
                    style={{ x: 0 }}
                  />
                  <div
                    className={`w-full h-full transition-colors ${resizing === "preview" ? "bg-foreground/20" : "group-hover:bg-foreground/20"}`}
                  />
                </div>
                <div
                  style={{
                    width: resizing === "preview" ? "var(--preview-panel-width)" : livePreviewWidth,
                  }}
                  className="flex-shrink-0 min-w-0 h-full overflow-hidden"
                >
                  <LivePdfPreview
                    projectPath={daemon.projectPath}
                    mainFile={latexSettings.settings.mainFile}
                    pdfPath={latexCompiler.pdfPath}
                    pdfVersion={latexCompiler.pdfVersion}
                    compileStatus={latexCompiler.compileStatus}
                    compileLog={latexCompiler.compileLog}
                    diagnostics={latexCompiler.diagnostics}
                    lastResult={latexCompiler.lastResult}
                    lastCompileDurationMs={latexCompiler.lastCompileDurationMs}
                    autoCompile={latexSettings.settings.autoCompile}
                    highlightTarget={pdfHighlightTarget}
                    onCompile={handleCompileShortcut}
                    onStopCompile={handleStopCompile}
                    onToggleAutoCompile={handleToggleAutoCompile}
                    onCleanAuxFiles={handleCleanAuxFiles}
                    onForwardSync={handleLivePreviewForwardSync}
                    onSynctexClick={handleLivePreviewSynctexClick}
                    onJumpToDiagnostic={handleJumpToDiagnostic}
                    onFixDiagnosticsWithAi={handleFixDiagnosticsWithAi}
                    onClose={handleCloseLivePreview}
                  />
                </div>
              </>
            )}
          </div>

          {/* OverLeaf-style Editor Bottom Status Bar */}
          {daemon.projectPath && (
            <div className="h-6 px-3 border-t border-border bg-surface-secondary flex items-center justify-between gap-3 text-[11px] font-mono text-muted shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={async () => {
                    if (!daemon.projectPath) return;
                    const res = await latexSettings.detectMainFile(daemon.projectPath);
                    if (res && res.tex_files.length > 0) {
                      setMainFileDetectionResult(res);
                      setShowMainFileDialog(true);
                    }
                  }}
                  className="hover:text-foreground truncate"
                  title="Select main .tex file"
                >
                  Main: {latexSettings.settings.mainFile ?? "unset"}
                </button>
                {selectedFile && /\.tex$/i.test(selectedFile) && (
                  <>
                    <span className="tabular-nums">Words: {wordCount.words}</span>
                    <span className="tabular-nums">
                      Ln {cursorPosition.line}, Col {cursorPosition.column}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {selectedFile && /\.tex$/i.test(selectedFile) && latexCompiler.pdfPath && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleForwardSync();
                    }}
                    className="hover:text-foreground"
                    title="Jump from current line to PDF"
                  >
                    Sync -&gt; PDF
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowLivePreview((p) => !p)}
                  className="hover:text-foreground"
                >
                  {latexCompiler.isCompiling
                    ? "Compiling..."
                    : latexCompiler.compileStatus === "success"
                      ? `PDF Ready${latexCompiler.lastCompileDurationMs != null ? ` (${(latexCompiler.lastCompileDurationMs / 1000).toFixed(1)}s)` : ""}`
                      : latexCompiler.compileStatus === "error"
                        ? "Build Error"
                        : "PDF Preview"}
                </button>
              </div>
            </div>
          )}

          {/* LaTeX Install Prompt - shown when no compiler is detected */}
          {daemon.projectPath &&
            latexCompiler.compilersStatus &&
            !hasAnyCompiler &&
            !latexCompiler.isDetecting && (
              <div className="border-t border-border">
                <LaTeXInstallPrompt onRefreshCompilers={latexCompiler.detectCompilers} />
              </div>
            )}

          <TerminalPanel
            projectPath={daemon.projectPath}
            open={showTerminal}
            shellMode={editorSettings.settings.terminalShellMode}
            customShell={editorSettings.settings.terminalShellPath}
            fontFamily={editorSettings.settings.terminalFontFamily}
            fontSize={editorSettings.settings.terminalFontSize}
            lineHeight={editorSettings.settings.terminalLineHeight}
            prefersReducedMotion={Boolean(prefersReducedMotion)}
            onClose={() => setShowTerminal(false)}
            pendingCommand={pendingTerminalCommand}
            onPendingCommandSent={() => setPendingTerminalCommand(null)}
          />
        </div>

        <AnimatePresence>
          {showRightPanel && (
            <motion.div
              key="right-panel-container"
              initial={prefersReducedMotion ? { opacity: 1, width: 0 } : { opacity: 0, width: 0 }}
              animate={{
                opacity: 1,
                width:
                  resizing === "right"
                    ? `calc(var(--right-panel-width) + 4px)`
                    : rightPanelWidth + 4,
              }}
              exit={prefersReducedMotion ? { opacity: 0, width: 0 } : { opacity: 0, width: 0 }}
              transition={prefersReducedMotion ? INSTANT_TRANSITION : PANEL_SPRING}
              className="flex flex-shrink-0 bg-background overflow-hidden"
              style={{
                willChange: prefersReducedMotion ? undefined : "width, opacity",
              }}
            >
              <div className="relative group w-1 flex-shrink-0">
                <motion.div
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0}
                  dragMomentum={false}
                  onDragStart={() => startResize("right")}
                  onDrag={(_event, info) => handleResizeDrag("right", info)}
                  onDragEnd={endResize}
                  className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize z-10"
                  style={{ x: 0 }}
                />
                <div
                  className={`w-full h-full transition-colors ${resizing === "right" ? "bg-foreground/20" : "group-hover:bg-foreground/20"}`}
                />
              </div>
              <aside
                style={{
                  width: resizing === "right" ? "var(--right-panel-width)" : rightPanelWidth,
                  willChange: resizing === "right" ? "width" : undefined,
                }}
                className="border-l border-border flex flex-col flex-shrink-0 overflow-hidden"
              >
                <AgentErrorBoundary onReset={handleResetAgentBoundary}>
                  <AgentPanel
                    agent={agent}
                    agentSettings={agentSettings.settings}
                    onUpdateAgentSettings={agentSettings.updateSettings}
                    onSetDefaultModel={agentSettings.setDefaultModel}
                    onSetDefaultEffort={agentSettings.setDefaultEffort}
                    projectPath={daemon.projectPath}
                    files={daemon.files}
                    activeFile={selectedFile ?? null}
                    usageOpen={agentUsageOpen}
                    onUsageOpenChange={setAgentUsageOpen}
                    draftInjection={agentDraftInjection}
                    onDraftConsumed={handleAgentDraftConsumed}
                    onFileClick={handleAgentFileClick}
                    onRunTerminalCommand={handleAgentRunTerminalCommand}
                    onOpenAgentSettings={handleOpenAgentSettings}
                    onClose={handleCloseRightPanel}
                  />
                </AgentErrorBoundary>
              </aside>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {createDialog && (
        <InputDialog
          title={createDialog.type === "file" ? "New File" : "New Folder"}
          placeholder={createDialog.type === "file" ? "file.tex" : "folder"}
          onConfirm={handleCreateConfirm}
          onCancel={() => setCreateDialog(null)}
          validator={validateFileName}
        />
      )}

      <LaTeXSettingsDialog
        open={showLatexSettings}
        onClose={() => setShowLatexSettings(false)}
        settings={latexSettings.settings}
        onUpdateSettings={latexSettings.updateSettings}
        compilersStatus={latexCompiler.compilersStatus}
        onCleanAuxFiles={async () => {
          const removed = await latexCompiler.cleanAuxFiles();
          toast(
            removed.length > 0
              ? `Removed ${removed.length} auxiliary file(s)`
              : "No auxiliary files to clean",
            "success",
          );
        }}
        editorSettings={editorSettings.settings}
        onUpdateEditorSettings={editorSettings.updateSettings}
        texFiles={texFiles}
        agentSettings={agentSettings.settings}
        onUpdateAgentSettings={agentSettings.updateSettings}
        onUpdateCustomProvider={agentSettings.updateCustomProvider}
        agentProviders={agent.providers}
        onRefreshAgentProviders={agent.refreshProviders}
        initialTab={settingsInitialTab}
        authLoading={auth.loading}
        authConfigured={auth.isConfigured}
        authProfile={auth.profile}
        authError={auth.error}
        onOpenLogin={() => {
          setShowLatexSettings(false);
          setShowLoginCodeModal(true);
        }}
        onSignOut={auth.signOut}
      />

      {mainFileDetectionResult && (
        <MainFileSelectionDialog
          open={showMainFileDialog}
          detectionResult={mainFileDetectionResult}
          onSelect={handleMainFileSelect}
          onCancel={handleMainFileDialogCancel}
        />
      )}

      <SynctexInstallDialog
        open={showSynctexInstallDialog}
        onClose={() => {
          setShowSynctexInstallDialog(false);
          pendingSynctexRetryRef.current = null;
        }}
        onInstallComplete={handleSynctexInstallComplete}
      />

      {showGitHubPublishDialog && (
        <GitHubPublishDialog
          defaultRepoName={
            daemon.projectPath ? pathSync.basename(daemon.projectPath) : "my-project"
          }
          onPublish={handleGitHubPublish}
          onCancel={() => {
            setShowGitHubPublishDialog(false);
            setGhPublishError(null);
          }}
          isCreating={daemon.isCreatingRepo}
          error={ghPublishError}
        />
      )}

      <LoginCodeModal
        isOpen={showLoginCodeModal}
        onClose={() => setShowLoginCodeModal(false)}
        onSuccess={async (accessToken) => {
          if (accessToken) {
            // Session storage failed, use access token directly
            await auth.setAuthWithToken(accessToken);
          } else {
            // Session was stored properly, refresh normally
            await auth.refreshAuth();
          }
        }}
      />
    </div>
  );
}

function AgentPanelSkeleton() {
  return (
    <div className="flex flex-col bg-background h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="size-2 bg-surface-tertiary animate-pulse" />
          <div className="h-4 w-24 bg-surface-tertiary animate-pulse" />
        </div>
        <div className="h-6 w-12 bg-surface-tertiary animate-pulse" />
      </div>
      <div className="flex-1 p-3 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div
              className="h-4 bg-surface-secondary animate-pulse"
              style={{ width: `${60 + i * 10}%` }}
            />
            <div
              className="h-4 bg-surface-secondary animate-pulse"
              style={{ width: `${40 + i * 10}%` }}
            />
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <div className="h-16 bg-accent-hover border border-border animate-pulse" />
      </div>
    </div>
  );
}
