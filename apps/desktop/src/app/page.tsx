"use client";

import type { FileNode, GitLogEntry, GitStatus } from "@orchestratex/shared";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, type PanInfo, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentDraftInjection } from "@/components/agent/agent-composer";
import { ProviderIcon } from "@/components/agent/icons";
import { OrchestrationSidebar } from "@/components/agent/orchestration-sidebar";
import {
  type DelegateTaskInput,
  ProjectInspector,
  type ScheduleThreadInput,
} from "@/components/agent/project-inspector";
import { UsageDashboard, type UsageDashboardTopBarState } from "@/components/agent/usage-dashboard";
import { flattenFileNodes } from "@/components/agent/utils";
import { WorkspaceChanges } from "@/components/agent/workspace-changes";
import {
  BuildActivityDrawer,
  type BuildActivityTab,
} from "@/components/editor/build-activity-drawer";
import {
  type DockviewPanelItem,
  DockviewPanelLayout,
} from "@/components/editor/dockview-panel-layout";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { EditorSkeleton } from "@/components/editor/editor-skeleton";
import { GitHubPublishDialog } from "@/components/editor/github-publish-dialog";
import { formatCheckpointTime } from "@/components/editor/history-diff-utils";
import { HistoryWorkspace } from "@/components/editor/history-workspace";
import { HomeWorkspace, type ProjectThreadCounts } from "@/components/editor/home-workspace";
import type { PdfHighlightTarget } from "@/components/editor/pdf-viewer";
import { ProjectSwitcher } from "@/components/editor/project-switcher";
import { ScoreDrawer } from "@/components/editor/score-drawer";
import { FileSidebarPanel } from "@/components/editor/sidebar-file-panel";
import { SidebarOutlinePanel } from "@/components/editor/sidebar-outline-panel";
import { StatusBar } from "@/components/editor/status-bar";
import { TerminalPanel } from "@/components/editor/terminal-panel";
import { VisualEditor } from "@/components/editor/visual-editor";
import {
  LaTeXInstallPrompt,
  LaTeXSettingsDialog,
  MainFileSelectionDialog,
} from "@/components/latex";
import { CommandPalette } from "@/components/ui/command-palette";
import { InputDialog } from "@/components/ui/input-dialog";
import { OrchestraTeXWordmark } from "@/components/ui/orchestratex-wordmark";
import {
  TabBar,
  type TabDragEndPayload,
  type TabDragMovePayload,
  type TabItem,
  type TabReorderPosition,
} from "@/components/ui/tab-bar";
import { ThemePicker } from "@/components/ui/theme-picker";
import { useToast } from "@/components/ui/toast";
import { useAgent, useAgentSettings } from "@/lib/agent";
import { type AttributedEdit, projectRelativePath } from "@/lib/agent/edit-attribution";
import { formatProviderDisplayName } from "@/lib/agent/model-display";
import type { ScoreMark } from "@/lib/agent/score";
import type { AgentProviderId, AgentThread, ThreadSummary } from "@/lib/agent/types";
import { computeDateRange, queryUsageLog } from "@/lib/agent/usage-dashboard";
import { useAgentEdits } from "@/lib/agent/use-agent-edits";
import { useOrchestration } from "@/lib/agent/use-orchestration";
import { useScore } from "@/lib/agent/use-score";
import { useEditorSettings } from "@/lib/editor";
import { mayHaveNewContents } from "@/lib/editor/file-change";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
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
import {
  findMissingFileSuggestion,
  type RecentRenameRecord,
} from "@/lib/latex/missing-file-suggestions";
import { planRenameReferences } from "@/lib/latex/rename-references";
import type { LatexDiagnostic, MainFileDetectionResult, SynctexResult } from "@/lib/latex/types";
import { pathSync, pathsEqual } from "@/lib/path";
import { useRecentProjects } from "@/lib/recent-projects";
import { useTauriDaemon } from "@/lib/tauri";
import type { RenameReferenceUpdate } from "@/lib/tauri/use-tauri-daemon";

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
  GitBranchIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  TerminalIcon,
  XIcon,
} from "@phosphor-icons/react";

type EditorViewMode = "file" | "git-diff";
const WORKSPACE_VIEWS = ["write", "agents", "history"] as const;
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
  nodes: import("@orchestratex/shared").FileNode[],
  projectRoot: string,
  extRegex: RegExp,
): string[] {
  const normRoot = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const visit = (items: import("@orchestratex/shared").FileNode[]) => {
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

const MIN_PANEL_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export default function EditorPage() {
  const editorSettings = useEditorSettings();
  const daemon = useTauriDaemon({
    gitAutoFetchEnabled: editorSettings.settings.gitAutoFetchEnabled,
    gitAutoFetchIntervalMs: editorSettings.settings.gitAutoFetchIntervalSeconds * 1000,
  });
  const prefersReducedMotion = useReducedMotion();
  const { toast } = useToast();
  const recentProjects = useRecentProjects();

  const [selectedFile, setSelectedFile] = useState<string>();
  const [failedSourceWrites, setFailedSourceWrites] = useState<Record<string, string>>({});
  const [recentRenames, setRecentRenames] = useState<RecentRenameRecord[]>([]);
  const [fileContent, setFileContent] = useState<string>("");
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("file");
  const [gitDiffPreview, setGitDiffPreview] = useState<GitDiffPreviewState | null>(null);
  const [historyDiffPreview, setHistoryDiffPreview] = useState<GitDiffPreviewState | null>(null);
  const [selectedHistoryCommit, setSelectedHistoryCommit] = useState<GitLogEntry | null>(null);
  const [historyCommitDiff, setHistoryCommitDiff] = useState<{
    entry: GitLogEntry;
    content: string;
    isLoading: boolean;
    error: string | null;
  } | null>(null);
  const [worktreeGitLog, setWorktreeGitLog] = useState<GitLogEntry[]>([]);
  const [splitPane, setSplitPane] = useState<SplitPaneState | null>(null);
  const [splitDropHint, setSplitDropHint] = useState<SplitPaneSide | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [pdfRefreshKey, _setPdfRefreshKey] = useState(0);
  const [pendingGoToLine, setPendingGoToLine] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [buildActivityTab, setBuildActivityTab] = useState<BuildActivityTab>("score");
  const [buildActivityCollapsed, setBuildActivityCollapsed] = useState(true);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const showTerminal = !buildActivityCollapsed && buildActivityTab === "terminal";
  const openBuildActivity = useCallback((tab: BuildActivityTab) => {
    setBuildActivityTab(tab);
    setBuildActivityCollapsed(false);
    if (tab === "terminal") setTerminalMounted(true);
  }, []);
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
      return saved ? parseInt(saved, 10) : 560;
    }
    return 560;
  });
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [resizing, setResizing] = useState<"sidebar" | "right" | "preview" | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"write" | "agents" | "history">("write");
  const [showUsageDashboard, setShowUsageDashboard] = useState(false);
  const [usageTopBarState, setUsageTopBarState] = useState<UsageDashboardTopBarState | null>(null);
  const [showHomeWorkspace, setShowHomeWorkspace] = useState(false);
  const [showThreadHistory, setShowThreadHistory] = useState(false);
  const [checkoutMenuOpen, setCheckoutMenuOpen] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [openingThread, setOpeningThread] = useState<ThreadSummary | null>(null);
  const [worktreeGitStatus, setWorktreeGitStatus] = useState<GitStatus | null>(null);
  const [pullRequestDraft, setPullRequestDraft] = useState<ThreadSummary | null>(null);
  const toggleTerminal = useCallback(() => {
    setWorkspaceView("write");
    if (showTerminal && workspaceView === "write") setBuildActivityCollapsed(true);
    else openBuildActivity("terminal");
  }, [openBuildActivity, showTerminal, workspaceView]);
  const [showSettledThreads, setShowSettledThreads] = useState(false);
  const [todayUsageByProvider, setTodayUsageByProvider] = useState<
    Array<{ providerId: AgentProviderId; tokens: number }>
  >([]);
  const [todayCachePercent, setTodayCachePercent] = useState<number | null>(null);
  const [highlightedFile, _setHighlightedFile] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [isGeneratingCommitMessageAI, setIsGeneratingCommitMessageAI] = useState(false);
  const [createDialog, setCreateDialog] = useState<{
    type: "file" | "directory";
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showLatexSettings, setShowLatexSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"build" | "editor" | "agents">(
    "build",
  );

  const [showLivePreview, setShowLivePreview] = useState(false);
  const [visualMode, setVisualMode] = useState(false);
  const [pendingSnippet, setPendingSnippet] = useState<{
    id: number;
    before: string;
    after: string;
    placeholder?: string;
  } | null>(null);
  const snippetCounterRef = useRef(0);
  const triggerLatexSnippet = useCallback(
    (before: string, after: string, placeholder?: string) => {
      if (visualMode) setVisualMode(false);
      snippetCounterRef.current += 1;
      setPendingSnippet({ id: snippetCounterRef.current, before, after, placeholder });
    },
    [visualMode],
  );
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
  const orchestration = useOrchestration(agentSettings.settings);
  const mergedOrchestrationThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    for (const thread of orchestration.threads) {
      byId.set(thread.id, thread);
    }
    for (const thread of agent.threads) {
      byId.set(thread.id, thread);
    }
    return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [agent.threads, orchestration.threads]);
  const threadCountsByProject = useMemo(() => {
    const counts: Record<string, ProjectThreadCounts> = {};
    for (const thread of mergedOrchestrationThreads) {
      if (thread.archived) continue;
      const project = counts[thread.projectPath] ?? {
        total: 0,
        running: 0,
        waiting: 0,
        providerIds: [],
      };
      project.total++;
      if (thread.status === "running") project.running++;
      if (thread.status === "waiting_input") project.waiting++;
      if (!project.providerIds.includes(thread.providerId)) {
        project.providerIds.push(thread.providerId);
      }
      counts[thread.projectPath] = project;
    }
    return counts;
  }, [mergedOrchestrationThreads]);
  const activeWorkspaceThread =
    agent.activeThread?.summary.projectPath === daemon.projectPath
      ? agent.activeThread.summary
      : null;
  const activeWorktreePath = activeWorkspaceThread?.workspacePath;
  const activeThreadBranch = activeWorkspaceThread?.workspaceBranch;
  const activeWorkspaceThreadId = activeWorkspaceThread?.id;
  const { loadThread } = agent;
  const { refreshPullRequest } = orchestration;
  const activeWorktreePathRef = useRef(activeWorktreePath);
  activeWorktreePathRef.current = activeWorktreePath;
  const worktreeStatusRequestIdRef = useRef(0);
  const refreshWorktreeStatus = useCallback(async () => {
    const targetDir = activeWorktreePath;
    if (!targetDir) return;
    const requestId = ++worktreeStatusRequestIdRef.current;
    const [status, log] = await Promise.all([
      invoke<GitStatus>("git_status", { dir: targetDir }),
      invoke<GitLogEntry[]>("git_log", { dir: targetDir, limit: 30 }).catch(() => []),
    ]);
    if (
      worktreeStatusRequestIdRef.current !== requestId ||
      activeWorktreePathRef.current !== targetDir
    ) {
      return;
    }
    setWorktreeGitStatus(status);
    setWorktreeGitLog(log);
  }, [activeWorktreePath]);

  useEffect(() => {
    if (
      !openingThread ||
      daemon.isOpeningProject ||
      openingThread.projectPath !== daemon.projectPath
    ) {
      return;
    }
    setOpeningThread(null);
    void loadThread(openingThread.id, openingThread.projectPath).catch((error: unknown) =>
      toast(String(error), "error"),
    );
  }, [daemon.isOpeningProject, daemon.projectPath, loadThread, openingThread, toast]);

  useEffect(() => {
    if (workspaceView !== "agents" && !(workspaceView === "history" && showThreadHistory)) return;
    let active = true;
    const updateStatus = async () => {
      if (!activeWorktreePath) return;
      try {
        const [status, log] = await Promise.all([
          invoke<GitStatus>("git_status", { dir: activeWorktreePath }),
          invoke<GitLogEntry[]>("git_log", { dir: activeWorktreePath, limit: 30 }).catch(() => []),
        ]);
        if (active) {
          setWorktreeGitStatus(status);
          setWorktreeGitLog(log);
        }
      } catch {
        if (active) {
          setWorktreeGitStatus(null);
          setWorktreeGitLog([]);
        }
      }
    };
    setWorktreeGitStatus(null);
    setWorktreeGitLog([]);
    void updateStatus();
    const timer = setInterval(() => void updateStatus(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeWorktreePath, showThreadHistory, workspaceView]);

  useEffect(() => {
    if (workspaceView !== "agents" || !activeWorkspaceThreadId || !daemon.projectPath) return;
    void refreshPullRequest({
      id: activeWorkspaceThreadId,
      projectPath: daemon.projectPath,
      workspaceBranch: activeThreadBranch,
      workspacePath: activeWorktreePath,
    });
  }, [
    activeThreadBranch,
    activeWorktreePath,
    activeWorkspaceThreadId,
    daemon.projectPath,
    refreshPullRequest,
    workspaceView,
  ]);

  const projectThreads = useMemo(
    () => agent.threads.filter((thread) => !thread.archived),
    [agent.threads],
  );
  const waitingThreads = projectThreads.filter(
    (thread) => thread.status === "waiting_input",
  ).length;
  const runningThreads = projectThreads.filter((thread) => thread.status === "running").length;
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [agentDraftInjection, setAgentDraftInjection] = useState<AgentDraftInjection | null>(null);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<{
    id: number;
    command: string;
  } | null>(null);

  const [showMainFileDialog, setShowMainFileDialog] = useState(false);
  const [mainFileDetectionResult, setMainFileDetectionResult] =
    useState<MainFileDetectionResult | null>(null);
  const [showGitHubPublishDialog, setShowGitHubPublishDialog] = useState(false);
  const [ghPublishError, setGhPublishError] = useState<string | null>(null);
  const contentSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const splitContentSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const savingVisualTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimesRef = useRef(new Map<string, number>());
  const pendingSourceWritesRef = useRef<{ primary?: string; split?: string }>({});
  const shouldIgnoreRenameChangeRef = useRef<((path: string) => boolean) | null>(null);
  const processedFileChangeRef = useRef(daemon.lastFileChange);
  const renamePlanRef = useRef<{
    projectPath: string;
    oldPath: string;
    newPath: string;
    updates: RenameReferenceUpdate[];
  } | null>(null);
  const currentProjectRef = useRef(daemon.projectPath);
  const selectedFileRef = useRef(selectedFile);
  currentProjectRef.current = daemon.projectPath;
  selectedFileRef.current = selectedFile;
  const sourceIsDirty = useCallback(
    (path: string) => {
      const pending = pendingSourceWritesRef.current;
      return pending.primary === path || pending.split === path || path in failedSourceWrites;
    },
    [failedSourceWrites],
  );
  const rememberSaveResult = useCallback((path: string, content: string, saved: boolean) => {
    setFailedSourceWrites((previous) => {
      if (!saved) return { ...previous, [path]: content };
      if (!(path in previous)) return previous;
      const next = { ...previous };
      delete next[path];
      return next;
    });
  }, []);
  const isLocallyModified = useCallback(
    (path: string) =>
      sourceIsDirty(path) || Date.now() - (lastSaveTimesRef.current.get(path) ?? 0) < 750,
    [sourceIsDirty],
  );
  const {
    edits: attributedEdits,
    rememberFile: rememberAgentEditFile,
    markAccepted,
    markRejected,
  } = useAgentEdits(daemon.projectPath, projectThreads, daemon.readFile, isLocallyModified);
  const fileVoiceDots = useMemo(() => {
    const dots: NonNullable<React.ComponentProps<typeof FileSidebarPanel>["fileVoiceDots"]> = {};
    for (const edit of attributedEdits) {
      if (
        edit.status === "rejected" ||
        !daemon.projectPath ||
        !pathsEqual(edit.thread.projectPath, daemon.projectPath)
      )
        continue;
      const thread = projectThreads.find((item) => item.id === edit.thread.id) ?? edit.thread;
      const entries = dots[edit.filePath] ?? [];
      const label =
        agent.providers.find((provider) => provider.id === thread.providerId)?.name ?? thread.title;
      if (!entries.some((entry) => entry.provider === thread.providerId)) {
        entries.push({ provider: thread.providerId, label, pulse: thread.status === "running" });
      }
      dots[edit.filePath] = entries;
    }
    return dots;
  }, [agent.providers, attributedEdits, daemon.projectPath, projectThreads]);
  const fileVoiceByPath = useMemo(() => {
    const map: Record<string, AgentProviderId> = {};
    for (const [path, entries] of Object.entries(fileVoiceDots)) {
      const first = entries.find((entry) => entry.provider !== "you");
      if (!first || first.provider === "you") continue;
      map[path] = first.provider;
      if (daemon.projectPath) {
        const rel = projectRelativePath(daemon.projectPath, path);
        if (rel) map[rel] = first.provider;
      }
    }
    return map;
  }, [daemon.projectPath, fileVoiceDots]);
  const keepAttributedEdit = useCallback(
    (edit: AttributedEdit) => markAccepted(edit.id),
    [markAccepted],
  );
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

  // LaTeX settings and editor settings
  const latexSettings = useLatexSettings();
  const texFiles = useMemo(() => findTexFiles(daemon.files), [daemon.files]);

  // Auto-detect main file when project opens
  useEffect(() => {
    if (
      daemon.files.length > 0 &&
      !texFiles.some(
        (path) =>
          latexSettings.settings.mainFile && pathsEqual(path, latexSettings.settings.mainFile),
      )
    ) {
      const mainFile = findMainTexFile(daemon.files);
      if (mainFile !== latexSettings.settings.mainFile) {
        latexSettings.setMainFile(mainFile);
      }
    }
  }, [daemon.files, latexSettings.settings.mainFile, latexSettings, texFiles]);

  const score = useScore(
    daemon.projectPath,
    agent.threads,
    workspaceView === "write" &&
      !buildActivityCollapsed &&
      buildActivityTab === "score" &&
      !showHomeWorkspace &&
      !showUsageDashboard,
  );

  const latexCompiler = useLatexCompiler({
    settings: latexSettings.settings,
    projectPath: daemon.projectPath,
    onCompileStart: (mainFile) => score.recordUser("compile", mainFile),
  });
  const staleAgentEdits = latexCompiler.pdfPath
    ? attributedEdits.filter(
        (edit) =>
          daemon.projectPath &&
          pathsEqual(edit.thread.projectPath, daemon.projectPath) &&
          edit.status !== "rejected" &&
          edit.observedAt > (latexCompiler.lastPdfBuildStartedAt ?? 0),
      ).length
    : 0;

  // Check if any LaTeX compiler is available
  const hasAnyCompiler =
    latexCompiler.compilersStatus &&
    (latexCompiler.compilersStatus.pdflatex.available ||
      latexCompiler.compilersStatus.xelatex.available ||
      latexCompiler.compilersStatus.lualatex.available ||
      latexCompiler.compilersStatus.latexmk.available ||
      latexCompiler.compilersStatus.tectonic.available);

  const undoAttributedEdit = useCallback(
    async (edit: AttributedEdit) => {
      const projectPath = daemon.projectPath;
      if (
        edit.status !== "pending" ||
        !projectPath ||
        !pathsEqual(edit.thread.projectPath, projectPath)
      )
        return;
      if (sourceIsDirty(edit.filePath)) {
        toast("Save your current changes before undoing this edit.", "error");
        return;
      }
      try {
        await daemon.writeFileIfUnchanged(edit.filePath, edit.after, edit.before);
        if (currentProjectRef.current !== projectPath) return;
        lastSaveTimesRef.current.set(edit.filePath, Date.now());
        markRejected(edit.id);
        rememberAgentEditFile(edit.filePath, edit.before, projectPath);
        if (selectedFileRef.current === edit.filePath) {
          setFileContent((current) => (current === edit.after ? edit.before : current));
        }
        setSplitPane((current) =>
          current?.selectedFile === edit.filePath && current.content === edit.after
            ? { ...current, content: edit.before }
            : current,
        );
        if (hasAnyCompiler && latexSettings.settings.mainFile) {
          latexCompiler.scheduleAutoCompile({
            directory: projectPath,
            mainFile: latexSettings.settings.mainFile,
          });
        }
      } catch (error) {
        toast(String(error), "error");
      }
    },
    [
      daemon.projectPath,
      daemon.writeFileIfUnchanged,
      hasAnyCompiler,
      latexCompiler,
      latexSettings.settings.mainFile,
      markRejected,
      rememberAgentEditFile,
      sourceIsDirty,
      toast,
    ],
  );

  const threePaneAgentWidth = Math.min(Math.max(rightPanelWidth, 330), 360);
  const threePanePdfWidth = Math.min(livePreviewWidth, 420);
  const threePaneChromeBudget = (showSidebar ? sidebarWidth + 14 : 0) + 48;
  const canFitThreePanes =
    windowWidth >= threePaneChromeBudget + 360 + threePaneAgentWidth + threePanePdfWidth;
  const showLivePreviewEffective = showLivePreview && (!showRightPanel || canFitThreePanes);
  const openPdfPreview = useCallback(() => {
    if (showRightPanel && !canFitThreePanes) {
      setShowRightPanel(false);
    }
    setShowLivePreview(true);
  }, [canFitThreePanes, showRightPanel]);
  const togglePdfPreview = useCallback(() => {
    if (showLivePreviewEffective) {
      setShowLivePreview(false);
    } else {
      openPdfPreview();
    }
  }, [openPdfPreview, showLivePreviewEffective]);
  const openDockedAgentPanel = useCallback(() => {
    setShowRightPanel(true);
    if (windowWidth < 1600) {
      setShowLivePreview(false);
    }
  }, [windowWidth]);

  const executeLocalCompile = useCallback(
    async (mainFile: string) => {
      if (!daemon.projectPath) return;
      if (!hasAnyCompiler && latexCompiler.compilersStatus) {
        toast("No LaTeX compiler detected. Install TinyTeX, Tectonic, or TeX Live below.", "error");
        return;
      }
      openPdfPreview();
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
    [daemon.projectPath, hasAnyCompiler, latexCompiler, openPdfPreview, toast],
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
    if (showRightPanel) {
      setShowRightPanel(false);
    } else {
      openDockedAgentPanel();
    }
  }, [openDockedAgentPanel, showRightPanel]);

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
    setOpenTabs([]);
    setSelectedFile(undefined);
    setFileContent("");
    setBinaryPreviewUrl(null);
    setSplitPane(null);
    setEditorViewMode("file");
    setShowThreadHistory(false);
    setFailedSourceWrites({});
    setRecentRenames([]);
    const timers = [contentSaveTimeoutRef, splitContentSaveTimeoutRef, savingVisualTimeoutRef];
    for (const timer of timers) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    pendingSourceWritesRef.current = {};
    lastSaveTimesRef.current.clear();
    setIsSaving(false);
    if (!daemon.projectPath) {
      setShowLivePreview(false);
      setBibEntries([]);
      setTexLabels([]);
    }
  }, [daemon.projectPath]);

  useEffect(() => {
    void daemon.projectPath;
    setTerminalMounted(false);
    setBuildActivityTab("score");
    setBuildActivityCollapsed(true);
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
            content: await daemonReadFile(p).catch(() => null),
          })),
        ),
        Promise.all(
          texPaths.map(async (p) => ({
            file: p,
            content: await daemonReadFile(p).catch(() => null),
          })),
        ),
      ]);
      if (cancelled) return;

      const parsedBibs: BibEntry[] = [];
      for (const item of bibContents) {
        if (item.content === null) continue;
        rememberAgentEditFile(item.file, item.content, projectRoot, true);
        parsedBibs.push(...parseBibTeXEntries(item.content, item.file));
      }
      const parsedLabels: LabelEntry[] = [];
      for (const item of texContents) {
        if (item.content === null) continue;
        rememberAgentEditFile(item.file, item.content, projectRoot, true);
        parsedLabels.push(...parseLatexLabels(item.content, item.file));
      }
      setBibEntries(parsedBibs);
      setTexLabels(parsedLabels);
    })();

    return () => {
      cancelled = true;
    };
  }, [daemon.projectPath, daemon.files, daemonReadFile, rememberAgentEditFile]);

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
      selectedFileRef.current = resolvedPath;
      setSelectedFile(resolvedPath);
      setBinaryPreviewUrl(null);

      if (fileType === "text") {
        setIsLoadingFile(true);
        try {
          const content = await daemon.readFile(resolvedPath);
          if (
            currentProjectRef.current !== daemon.projectPath ||
            selectedFileRef.current !== resolvedPath
          )
            return;
          if (content !== null) rememberAgentEditFile(resolvedPath, content, daemon.projectPath);
          setFileContent(failedSourceWrites[resolvedPath] ?? content ?? "");
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
    [daemon, failedSourceWrites, getFileType, rememberAgentEditFile, resolveSelectablePath, toast],
  );

  const runInverseSynctex = useCallback(
    async (pdfPath: string, page: number, x: number, y: number) => {
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
        const projectPrefix = `${normalize(daemon.projectPath).replace(/\/$/, "")}/`;
        const resolvedFile = normalFile.startsWith(projectPrefix)
          ? normalFile.slice(projectPrefix.length)
          : normalFile;

        await handleFileSelect(resolvedFile);
        setPendingGoToLine(result.line);
      } catch (err) {
        console.error("SyncTeX lookup failed:", err);
        toast("Could not find a source location for this PDF position.", "error");
      }
    },
    [daemon.projectPath, handleFileSelect, toast],
  );

  const handleSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !selectedFile) return;
      const pdfPath = pathSync.join(daemon.projectPath, selectedFile);
      void runInverseSynctex(pdfPath, page, x, y);
    },
    [daemon.projectPath, runInverseSynctex, selectedFile],
  );

  const handleSplitSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !splitPane?.selectedFile) return;
      const pdfPath = pathSync.join(daemon.projectPath, splitPane.selectedFile);
      void runInverseSynctex(pdfPath, page, x, y);
    },
    [daemon.projectPath, runInverseSynctex, splitPane?.selectedFile],
  );

  const handleLivePreviewSynctexClick = useCallback(
    (page: number, x: number, y: number) => {
      if (!latexCompiler.pdfPath) return;
      void runInverseSynctex(latexCompiler.pdfPath, page, x, y);
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
        openPdfPreview();
        setPdfHighlightTarget({
          page: res.page,
          x: res.h,
          y: res.v,
          width: res.width,
          height: res.height,
          nonce: Date.now(),
        });
      } catch (err) {
        console.error("SyncTeX lookup failed:", err);
        toast("Could not resolve PDF location for this source line.", "error");
      }
    },
    [
      cursorPosition.column,
      cursorPosition.line,
      daemon.projectPath,
      latexCompiler,
      latexSettings.settings.mainFile,
      openPdfPreview,
      selectedFile,
      toast,
    ],
  );

  const historyDiffRequestIdRef = useRef(0);
  const historyCommitRequestIdRef = useRef(0);

  const isViewingWorktreeHistory = Boolean(showThreadHistory && activeWorktreePath);
  const activeHistoryDir = isViewingWorktreeHistory ? activeWorktreePath : daemon.projectPath;
  const activeHistoryGitStatus = isViewingWorktreeHistory ? worktreeGitStatus : gitStatus;
  const activeHistoryStagedChanges = useMemo(
    () => (activeHistoryGitStatus?.changes ?? []).filter((c) => c.staged),
    [activeHistoryGitStatus?.changes],
  );
  const activeHistoryUnstagedChanges = useMemo(
    () => (activeHistoryGitStatus?.changes ?? []).filter((c) => !c.staged),
    [activeHistoryGitStatus?.changes],
  );
  const uniqueHistoryChangeCount = useMemo(
    () => new Set((activeHistoryGitStatus?.changes ?? []).map((c) => c.path)).size,
    [activeHistoryGitStatus?.changes],
  );

  useEffect(() => {
    void activeHistoryDir;
    gitDiffRequestIdRef.current += 1;
    historyDiffRequestIdRef.current += 1;
    historyCommitRequestIdRef.current += 1;
    setGitDiffPreview(null);
    setHistoryDiffPreview(null);
    setSelectedHistoryCommit(null);
    setHistoryCommitDiff(null);
    setEditorViewMode("file");
  }, [activeHistoryDir]);

  const handlePreviewHistoryFileDiff = useCallback(
    async (path: string, staged: boolean) => {
      if (!activeHistoryDir) return;
      const requestId = historyDiffRequestIdRef.current + 1;
      historyDiffRequestIdRef.current = requestId;
      historyCommitRequestIdRef.current += 1;
      setSelectedHistoryCommit(null);
      setHistoryCommitDiff(null);
      setHistoryDiffPreview({
        path,
        staged,
        content: "",
        isLoading: true,
        error: null,
      });
      try {
        const content = isViewingWorktreeHistory
          ? await invoke<string>("git_diff", { dir: activeHistoryDir, file: path, staged })
          : await daemon.gitDiff(path, staged);
        if (historyDiffRequestIdRef.current !== requestId) return;
        setHistoryDiffPreview({
          path,
          staged,
          content,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        if (historyDiffRequestIdRef.current !== requestId) return;
        setHistoryDiffPreview({
          path,
          staged,
          content: "",
          isLoading: false,
          error: String(error),
        });
      }
    },
    [activeHistoryDir, daemon, isViewingWorktreeHistory],
  );

  const handleSelectHistoryCommit = useCallback(
    async (entry: GitLogEntry) => {
      if (!activeHistoryDir) return;
      const requestId = historyCommitRequestIdRef.current + 1;
      historyCommitRequestIdRef.current = requestId;
      historyDiffRequestIdRef.current += 1;
      setHistoryDiffPreview(null);
      setSelectedHistoryCommit(entry);
      setHistoryCommitDiff({
        entry,
        content: "",
        isLoading: true,
        error: null,
      });
      try {
        const content = await invoke<string>("git_commit_diff", {
          dir: activeHistoryDir,
          hash: entry.hash,
        });
        if (historyCommitRequestIdRef.current !== requestId) return;
        setHistoryCommitDiff({
          entry,
          content,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        if (historyCommitRequestIdRef.current !== requestId) return;
        setHistoryCommitDiff({
          entry,
          content: "",
          isLoading: false,
          error: String(error),
        });
      }
    },
    [activeHistoryDir],
  );

  const loadDiffPreview = useCallback(
    async (
      path: string,
      staged: boolean,
      requestIdRef: React.MutableRefObject<number>,
      setPreview: React.Dispatch<React.SetStateAction<GitDiffPreviewState | null>>,
    ) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setPreview({
        path,
        staged,
        content: "",
        isLoading: true,
        error: null,
      });

      try {
        const content = await daemon.gitDiff(path, staged);
        if (requestIdRef.current !== requestId) return;
        setPreview({
          path,
          staged,
          content,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setPreview({
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

  const loadGitDiffPreview = useCallback(
    (path: string, staged: boolean) =>
      loadDiffPreview(path, staged, gitDiffRequestIdRef, setGitDiffPreview),
    [loadDiffPreview],
  );

  const _handlePreviewGitDiff = useCallback(
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
    if (!daemon.lastFileChange || processedFileChangeRef.current === daemon.lastFileChange) return;
    processedFileChangeRef.current = daemon.lastFileChange;

    const { path, kind } = daemon.lastFileChange;
    if (shouldIgnoreRenameChangeRef.current?.(path)) return;

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
    } else if (mayHaveNewContents(kind) && !isLocallyModified(path)) {
      const projectPath = daemon.projectPath;
      const reloadPrimary = path === selectedFile && getFileType(path) === "text";
      const reloadSplit = path === splitPane?.selectedFile && !splitPane.binaryPreviewUrl;
      if (reloadPrimary || reloadSplit) {
        daemon
          .readFile(path)
          .then((content) => {
            if (
              content === null ||
              currentProjectRef.current !== projectPath ||
              isLocallyModified(path)
            ) {
              return;
            }
            if (reloadPrimary && selectedFileRef.current === path) {
              setFileContent(content);
            }
            if (reloadSplit) {
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
            console.error("Failed to reload changed file:", err);
          });
      }
      // Trigger OverLeaf auto-compile on external TeX/Bib edits (e.g. by AI agent or git)
      if (
        daemon.projectPath &&
        latexSettings.settings.mainFile &&
        hasAnyCompiler &&
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
    getFileType,
    handleFileSelect,
    isLocallyModified,
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
    pendingSourceWritesRef.current.split = undefined;
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
          if (content !== null) rememberAgentEditFile(resolvedPath, content, daemon.projectPath);
          setSplitPane((prev) => {
            if (!prev || prev.selectedFile !== resolvedPath) return prev;
            return {
              ...prev,
              side,
              content: failedSourceWrites[resolvedPath] ?? content ?? "",
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
    [
      daemon,
      failedSourceWrites,
      getFileType,
      resolveSelectablePath,
      toast,
      selectedFile,
      handleFileSelect,
      rememberAgentEditFile,
    ],
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
      pendingSourceWritesRef.current.split = fileToSave;

      const timer = setTimeout(async () => {
        let saved = false;
        try {
          saved = await daemon.writeFile(fileToSave, content);
          if (!saved || currentProjectRef.current !== daemon.projectPath) return;
          lastSaveTimesRef.current.set(fileToSave, Date.now());
          rememberAgentEditFile(fileToSave, content, daemon.projectPath);
          score.recordUser("edit", fileToSave);
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
        } finally {
          if (splitContentSaveTimeoutRef.current === timer) {
            splitContentSaveTimeoutRef.current = null;
            pendingSourceWritesRef.current.split = undefined;
            if (currentProjectRef.current === daemon.projectPath) {
              rememberSaveResult(fileToSave, content, saved);
            }
          }
        }
      }, 500);
      splitContentSaveTimeoutRef.current = timer;
    },
    [
      daemon,
      hasAnyCompiler,
      latexCompiler,
      latexSettings.settings.mainFile,
      rememberAgentEditFile,
      rememberSaveResult,
      score.recordUser,
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
        voiceDot: fileVoiceDots[path]?.[0],
      })) ?? [],
    [fileVoiceDots, splitPane?.openTabs],
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
                  attributedEdits={attributedEdits.filter(
                    (edit) =>
                      edit.status !== "rejected" &&
                      edit.filePath === splitSelectedFile &&
                      edit.after === splitPane.content,
                  )}
                  onKeepEdit={keepAttributedEdit}
                  onUndoEdit={undoAttributedEdit}
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
      attributedEdits,
      keepAttributedEdit,
      undoAttributedEdit,
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
        voiceDot: fileVoiceDots[path]?.[0],
      })),
    [fileVoiceDots, openTabs],
  );

  useEffect(() => {
    let cancelled = false;
    const { startMs, endMs } = computeDateRange("today");
    void queryUsageLog({
      startMs,
      endMs,
      projectPath: daemon.projectPath ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setTodayUsageByProvider(
          res.byProvider
            .filter((entry) => (entry.summary.inputTokens ?? 0) > 0)
            .map((entry) => ({
              providerId: entry.provider,
              tokens: entry.summary.inputTokens ?? 0,
            })),
        );
        setTodayCachePercent(
          res.total.cacheShare != null ? Math.round(res.total.cacheShare * 100) : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setTodayUsageByProvider([]);
          setTodayCachePercent(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [daemon.projectPath]);

  const gitStatusByPath = useMemo(() => {
    const map: Record<string, string> = {};
    if (!gitStatus?.changes) return map;
    for (const change of gitStatus.changes) {
      const normalized = change.path.replace(/\\/g, "/").replace(/^\.\//, "");
      const code =
        change.status === "conflict"
          ? "!"
          : change.status === "modified"
            ? "M"
            : change.status === "added"
              ? "A"
              : change.status === "deleted"
                ? "D"
                : change.status === "renamed"
                  ? "R"
                  : "?";
      map[normalized] = code;
    }
    return map;
  }, [gitStatus]);

  const errorCountByPath = useMemo(() => {
    const map: Record<string, number> = {};
    for (const diag of latexCompiler.diagnostics) {
      if (diag.severity === "error" && diag.file) {
        const normalized = diag.file.replace(/\\/g, "/").replace(/^\.\//, "");
        map[normalized] = (map[normalized] ?? 0) + 1;
      }
    }
    return map;
  }, [latexCompiler.diagnostics]);

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
      pendingSourceWritesRef.current.primary = fileToSave;
      const timer = setTimeout(async () => {
        let saved = false;
        if (fileToSave) {
          try {
            saved = await daemon.writeFile(fileToSave, content);
            if (saved && currentProjectRef.current === daemon.projectPath) {
              lastSaveTimesRef.current.set(fileToSave, Date.now());
              rememberAgentEditFile(fileToSave, content, daemon.projectPath);
              score.recordUser("edit", fileToSave);
            }
            if (
              saved &&
              currentProjectRef.current === daemon.projectPath &&
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
        if (contentSaveTimeoutRef.current !== timer) return;
        contentSaveTimeoutRef.current = null;
        pendingSourceWritesRef.current.primary = undefined;
        if (fileToSave && currentProjectRef.current === daemon.projectPath) {
          rememberSaveResult(fileToSave, content, saved);
        }
        if (savingVisualTimeoutRef.current) {
          clearTimeout(savingVisualTimeoutRef.current);
          savingVisualTimeoutRef.current = null;
        }
        setIsSaving(false);
      }, 500);
      contentSaveTimeoutRef.current = timer;
    },
    [
      selectedFile,
      daemon,
      hasAnyCompiler,
      latexCompiler,
      latexSettings.settings.mainFile,
      rememberAgentEditFile,
      rememberSaveResult,
      score.recordUser,
    ],
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
        if (
          selected !== daemon.projectPath &&
          (Object.values(pendingSourceWritesRef.current).some(Boolean) ||
            Object.keys(failedSourceWrites).length)
        ) {
          throw new Error("Wait for the editor to finish saving");
        }
        await daemon.setProject(selected);
        await recentProjects.addProject(selected);
        setShowHomeWorkspace(false);
        setShowSidebar(true);
        setShowRightPanel(true);
      }
    } catch (err) {
      console.error("Failed to open project:", err);
      toast(String(err), "error");
    }
  }, [daemon, failedSourceWrites, recentProjects, toast]);

  const retrySourceSave = async (path: string, content: string) => {
    if (Object.values(pendingSourceWritesRef.current).includes(path)) return;
    const projectPath = daemon.projectPath;
    try {
      if (!(await daemon.writeFile(path, content))) return;
      if (currentProjectRef.current !== projectPath) return;
      lastSaveTimesRef.current.set(path, Date.now());
      rememberAgentEditFile(path, content, projectPath);
      rememberSaveResult(path, content, true);
      score.recordUser("edit", path);
      if (
        projectPath &&
        hasAnyCompiler &&
        latexSettings.settings.mainFile &&
        /\.(tex|bib|sty|cls)$/i.test(path)
      ) {
        latexCompiler.scheduleAutoCompile({
          directory: projectPath,
          mainFile: latexSettings.settings.mainFile,
        });
      }
    } catch (error) {
      toast(String(error), "error");
    }
  };

  const handleOpenRecentProject = useCallback(
    async (path: string) => {
      if (
        path !== daemon.projectPath &&
        (Object.values(pendingSourceWritesRef.current).some(Boolean) ||
          Object.keys(failedSourceWrites).length)
      ) {
        toast("Wait for the editor to finish saving", "error");
        return false;
      }
      try {
        if (path !== daemon.projectPath) await daemon.setProject(path);
        await recentProjects.addProject(path);
        setShowHomeWorkspace(false);
        setShowSidebar(true);
        setShowRightPanel(true);
        return true;
      } catch (err) {
        console.error("Failed to open project:", err);
        toast(String(err), "error");
        return false;
      }
    },
    [daemon, failedSourceWrites, recentProjects, toast],
  );

  const handleNewLatexProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const directory = await open({ directory: true, title: "Choose a folder for the project" });
      if (typeof directory !== "string") return;
      await invoke("create_latex_project", { directory });
      setWorkspaceView("write");
      await handleOpenRecentProject(directory);
    } catch (error) {
      toast(String(error), "error");
    }
  };

  const handleCloneProject = async (url: string) => {
    setShowCloneDialog(false);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const directory = await save({ title: "Choose a location for the cloned project" });
      if (!directory) return;
      const path = await invoke<string>("git_clone", { url: url.trim(), directory });
      setWorkspaceView("write");
      await handleOpenRecentProject(path);
    } catch (error) {
      toast(String(error), "error");
    }
  };

  const handlePlanRename = useCallback(
    async (node: FileNode, newPath: string) => {
      renamePlanRef.current = null;
      const projectPath = daemon.projectPath;
      if (!projectPath || (node.type === "file" && !/\.tex$/i.test(node.path))) return 0;

      const files = await Promise.all(
        texFiles.map(async (path) => ({ path, content: await daemon.readFile(path) })),
      );
      if (currentProjectRef.current !== projectPath) throw new Error("The active project changed");
      const sourceFiles = files.flatMap(({ path, content }) =>
        content === null ? [] : [{ path, content }],
      );
      const edits = planRenameReferences({
        oldPath: node.path,
        newPath,
        isDirectory: node.type === "directory",
        projectRoot: projectPath,
        mainFile: latexSettings.settings.mainFile,
        files: sourceFiles,
      });
      const originalByPath = new Map(sourceFiles.map((file) => [file.path, file.content]));
      const updatesByPath = new Map<string, RenameReferenceUpdate>();
      for (const edit of edits.reverse()) {
        const before = originalByPath.get(edit.filePath);
        if (before === undefined) continue;
        const previous = updatesByPath.get(edit.filePath)?.after ?? before;
        updatesByPath.set(edit.filePath, {
          path: edit.filePath,
          before,
          after: previous.slice(0, edit.startOffset) + edit.after + previous.slice(edit.endOffset),
        });
      }
      renamePlanRef.current = {
        projectPath,
        oldPath: node.path,
        newPath,
        updates: [...updatesByPath.values()],
      };
      return edits.length;
    },
    [daemon.projectPath, daemon.readFile, latexSettings.settings.mainFile, texFiles],
  );

  const handleOpenOrchestrationThread = useCallback(
    async (thread: ThreadSummary) => {
      setWorkspaceView("agents");
      if (thread.projectPath === daemon.projectPath) {
        await loadThread(thread.id, thread.projectPath);
      } else {
        if (await handleOpenRecentProject(thread.projectPath)) setOpeningThread(thread);
      }
    },
    [daemon.projectPath, handleOpenRecentProject, loadThread],
  );

  const handleDelegateTask = async ({ providerId, title, prompt }: DelegateTaskInput) => {
    if (!activeWorkspaceThread) throw new Error("Open a parent thread");
    const settings = agentSettings.settings;
    await invoke<AgentThread>("agent_delegate_thread", {
      projectPath: activeWorkspaceThread.projectPath,
      parentThreadId: activeWorkspaceThread.id,
      providerId,
      brief: prompt,
      title,
      model: settings.defaultModelByProvider[providerId],
      reasoningEffort: settings.defaultEffortByProvider[providerId],
      customConfigs: orchestration.customConfigs,
    });
    await orchestration.refreshThreads();
  };

  const handleScheduleThread = async ({
    providerId,
    title,
    prompt,
    runAt,
    repeatIntervalMs,
  }: ScheduleThreadInput) => {
    if (!daemon.projectPath) throw new Error("Open a project");
    const settings = agentSettings.settings;
    const thread = await invoke<AgentThread>("agent_create_thread", {
      projectPath: daemon.projectPath,
      providerId,
      title,
      model: settings.defaultModelByProvider[providerId],
      reasoningEffort: settings.defaultEffortByProvider[providerId],
      interactionMode: settings.defaultInteractionMode,
      runtimeMode: settings.defaultRuntimeMode,
    });
    await invoke("agent_set_thread_schedule", {
      projectPath: daemon.projectPath,
      threadId: thread.summary.id,
      schedule: { prompt, runAt, repeatIntervalMs },
    });
    await orchestration.refreshThreads();
  };

  const handleCreateThreadWorktree = async () => {
    if (!activeWorkspaceThread) return;
    await invoke("agent_create_worktree", {
      projectPath: activeWorkspaceThread.projectPath,
      threadId: activeWorkspaceThread.id,
    });
    await orchestration.refreshThreads();
  };

  const handleMergeThreadWorktree = async () => {
    const projectPath = daemon.projectPath;
    const targetBranch = gitStatus?.branch;
    if (!projectPath || !activeWorktreePath || !activeThreadBranch || !targetBranch) return;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    if (
      !(await ask(`Merge ${activeThreadBranch} into ${targetBranch}?`, {
        title: "Merge thread worktree",
        kind: "warning",
      }))
    )
      return;
    if (
      currentProjectRef.current !== projectPath ||
      Object.values(pendingSourceWritesRef.current).some(Boolean) ||
      Object.keys(failedSourceWrites).length > 0 ||
      projectThreads.some(
        (thread) => thread.status === "running" || thread.status === "waiting_input",
      )
    ) {
      throw new Error("Wait for project saves and active agent turns to finish before merging");
    }
    try {
      await invoke("git_merge_thread_worktree", {
        dir: projectPath,
        workspace: activeWorktreePath,
        targetBranch,
      });
    } finally {
      void daemon.refreshGitStatus();
      void daemon.refreshFiles();
    }
  };

  const handlePublishBranch = async (thread: ThreadSummary, commitMessage?: string) => {
    const dir = thread.workspacePath ?? thread.projectPath;
    if (commitMessage) await invoke("git_commit", { dir, message: commitMessage });
    const url = await invoke<string>("git_open_branch_pull_request", { dir });
    await refreshPullRequest(thread);
    if (thread.workspacePath) await refreshWorktreeStatus();
    else void daemon.refreshGitStatus();
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  };

  const handleRequestPullRequest = async (thread: ThreadSummary, status: GitStatus) => {
    if (status.changes.some((change) => change.staged)) {
      setPullRequestDraft(thread);
      return;
    }
    if (status.changes.length) throw new Error("Stage changes from the Diff tab before committing");
    const { ask } = await import("@tauri-apps/plugin-dialog");
    if (
      await ask(`Push ${status.branch} and open a pull request?`, { title: "Open pull request" })
    ) {
      await handlePublishBranch(thread);
    }
  };

  const handleApplyRename = useCallback(
    async (
      node: FileNode,
      newPath: string,
      { updateReferences }: { updateReferences: boolean },
    ) => {
      const plan = renamePlanRef.current;
      const projectPath = daemon.projectPath;
      if (
        !projectPath ||
        (updateReferences &&
          (!plan ||
            plan.projectPath !== projectPath ||
            plan.oldPath !== node.path ||
            plan.newPath !== newPath))
      ) {
        throw new Error("Enter the name again to review updated references");
      }
      const updates = updateReferences ? plan?.updates : undefined;
      const movedPath = (path: string) => {
        if (pathsEqual(path, node.path)) return newPath;
        if (
          node.type === "directory" &&
          path.length > node.path.length &&
          pathsEqual(path.slice(0, node.path.length), node.path) &&
          /[/\\]/.test(path[node.path.length] ?? "")
        ) {
          return pathSync.join(newPath, path.slice(node.path.length + 1));
        }
        return path;
      };
      const affected = (path: string) =>
        movedPath(path) !== path ||
        (updates?.some((update) => pathsEqual(update.path, path)) ?? false);
      if (
        [...Object.keys(failedSourceWrites), ...Object.values(pendingSourceWritesRef.current)].some(
          (path) => path && affected(path),
        )
      ) {
        throw new Error("Wait for the affected files to finish saving and try again");
      }
      shouldIgnoreRenameChangeRef.current = affected;
      try {
        await daemon.renamePath(node.path, newPath, updates);
      } finally {
        shouldIgnoreRenameChangeRef.current = null;
      }
      if (currentProjectRef.current !== projectPath) return;
      renamePlanRef.current = null;
      const records = texFiles.flatMap((oldPath) => {
        const target = movedPath(oldPath);
        return target === oldPath ? [] : [{ oldPath, newPath: target }];
      });
      setRecentRenames((previous) => [...records, ...previous].slice(0, 200));
      const mainFile = latexSettings.settings.mainFile;
      const nextMainFile = mainFile && movedPath(mainFile);
      if (mainFile && movedPath(mainFile) !== mainFile) {
        latexSettings.setMainFile(movedPath(mainFile));
      }
      setOpenTabs((tabs) => tabs.map(movedPath));
      setSplitPane((pane) => {
        if (!pane) return pane;
        const current = pane.selectedFile;
        const after = current && updates?.find((update) => pathsEqual(update.path, current))?.after;
        const target = current && movedPath(current);
        return {
          ...pane,
          openTabs: pane.openTabs.map(movedPath),
          selectedFile: target,
          content: after ?? pane.content,
          binaryPreviewUrl:
            target && target !== current && pane.binaryPreviewUrl
              ? convertFileSrc(pathSync.join(projectPath, target))
              : pane.binaryPreviewUrl,
        };
      });
      const currentFile = selectedFileRef.current;
      if (currentFile && affected(currentFile)) {
        selectedFileRef.current = movedPath(currentFile);
        await handleFileSelect(selectedFileRef.current);
      }
      if (nextMainFile && records.length && hasAnyCompiler) {
        latexCompiler.scheduleAutoCompile({ directory: projectPath, mainFile: nextMainFile });
      }
    },
    [
      daemon.projectPath,
      daemon.renamePath,
      failedSourceWrites,
      handleFileSelect,
      hasAnyCompiler,
      latexCompiler,
      latexSettings,
      texFiles,
    ],
  );

  const handleStageFile = useCallback(
    (path: string) => {
      if (isViewingWorktreeHistory && activeHistoryDir) {
        void invoke("git_add", { dir: activeHistoryDir, files: [path] })
          .then(() => refreshWorktreeStatus())
          .catch((error: unknown) => toast(String(error), "error"));
        return;
      }
      daemon.gitAdd([path]);
    },
    [activeHistoryDir, daemon, isViewingWorktreeHistory, refreshWorktreeStatus, toast],
  );

  const handleUnstageFile = useCallback(
    (path: string) => {
      const originalPath = activeHistoryStagedChanges.find(
        (change) => change.path === path,
      )?.originalPath;
      const files = originalPath ? [path, originalPath] : [path];
      if (isViewingWorktreeHistory && activeHistoryDir) {
        void invoke("git_unstage", { dir: activeHistoryDir, files })
          .then(() => refreshWorktreeStatus())
          .catch((error: unknown) => toast(String(error), "error"));
        return;
      }
      daemon.gitUnstage(files);
    },
    [
      activeHistoryDir,
      activeHistoryStagedChanges,
      daemon,
      isViewingWorktreeHistory,
      refreshWorktreeStatus,
      toast,
    ],
  );

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
      openDockedAgentPanel();
      const loc =
        filePath && startLine > 0
          ? `${filePath}:${startLine}${endLine > startLine ? `-${endLine}` : ""}`
          : filePath || "current file";
      const snippet = selectionText.trim();
      setAgentDraftInjection({
        id: Date.now(),
        text: "",
        contextChip: { label: loc, snippet },
      });
    },
    [openDockedAgentPanel],
  );

  const handleNewThreadFromSelection = useCallback(
    (selectionText: string, filePath: string, startLine: number, endLine: number) => {
      void agent.createThread().catch((error: unknown) => toast(String(error), "error"));
      openDockedAgentPanel();
      const loc =
        filePath && startLine > 0
          ? `${filePath}:${startLine}${endLine > startLine ? `-${endLine}` : ""}`
          : filePath || "current file";
      const snippet = selectionText.trim();
      setAgentDraftInjection({
        id: Date.now(),
        text: "",
        contextChip: { label: loc, snippet },
      });
    },
    [agent, openDockedAgentPanel, toast],
  );

  const handleExplainSelection = useCallback(
    (selectionText: string, filePath: string, startLine: number, endLine: number) => {
      openDockedAgentPanel();
      const loc =
        filePath && startLine > 0
          ? `${filePath}:${startLine}${endLine > startLine ? `-${endLine}` : ""}`
          : filePath || "current file";
      const snippet = selectionText.trim();
      setAgentDraftInjection({
        id: Date.now(),
        text: "Explain this selection.",
        contextChip: { label: loc, snippet },
      });
    },
    [openDockedAgentPanel],
  );

  const handleFixDiagnosticsWithAi = useCallback(
    (diags: LatexDiagnostic[]) => {
      if (diags.length === 0) return;
      openDockedAgentPanel();
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
    [agent, latexSettings.settings.mainFile, openDockedAgentPanel],
  );

  const handleGenerateCommitMessageAI = useCallback(async () => {
    if (!activeHistoryDir) {
      toast("Please open a project first.", "error");
      return;
    }

    if (activeHistoryStagedChanges.length === 0) {
      toast("Stage files before generating commit message.", "error");
      return;
    }

    setIsGeneratingCommitMessageAI(true);

    try {
      const diffChunks: string[] = await Promise.all(
        activeHistoryStagedChanges.map((change: { path: string }) =>
          isViewingWorktreeHistory
            ? invoke<string>("git_diff", {
                dir: activeHistoryDir,
                file: change.path,
                staged: true,
              })
            : daemon.gitDiff(change.path, true),
        ),
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
  }, [
    activeHistoryDir,
    activeHistoryStagedChanges,
    agent,
    daemon,
    isViewingWorktreeHistory,
    toast,
  ]);

  const handleCommit = useCallback(
    async (overrideMessage?: string): Promise<boolean> => {
      const finalMessage = (overrideMessage ?? commitMessage).trim();
      if (!finalMessage) return false;
      if (isViewingWorktreeHistory && activeHistoryDir) {
        try {
          await invoke("git_commit", { dir: activeHistoryDir, message: finalMessage });
          toast("Changes committed", "success");
          setCommitMessage("");
          await refreshWorktreeStatus();
          return true;
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), "error");
          return false;
        }
      }
      const result = await daemon.gitCommit(finalMessage);
      if (result.success) {
        toast("Changes committed", "success");
        setCommitMessage("");
        return true;
      }
      toast(result.error || "Failed to commit", "error");
      return false;
    },
    [
      activeHistoryDir,
      commitMessage,
      daemon,
      isViewingWorktreeHistory,
      refreshWorktreeStatus,
      toast,
    ],
  );

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
        handleToggleRightPanel();
        return;
      }

      // Command Palette: Cmd/Ctrl+K
      if (isMod && !e.shiftKey && key === "k") {
        if (workspaceView === "agents" && !showHomeWorkspace && !showUsageDashboard) return;
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      // Toggle Sidebar: Cmd/Ctrl+\
      if (isMod && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        if (daemon.projectPath) {
          setShowSidebar((prev) => !prev);
        }
        return;
      }

      // Toggle Live PDF Preview: Cmd/Ctrl+P
      if (isMod && !e.shiftKey && key === "p") {
        e.preventDefault();
        if (daemon.projectPath) {
          togglePdfPreview();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    daemon,
    handleOpenFolder,
    selectedFile,
    handleCloseTab,
    handleCompileWithDetection,
    handleToggleRightPanel,
    togglePdfPreview,
    workspaceView,
    showHomeWorkspace,
    showUsageDashboard,
  ]);

  // Escape leaves Usage & limits, returning to Home or the workspace it was opened from.
  useEffect(() => {
    if (!showUsageDashboard) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      setShowUsageDashboard(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showUsageDashboard]);

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
  const handleAgentRunTerminalCommand = useCallback(
    (cmd: string) => {
      setWorkspaceView("write");
      openBuildActivity("terminal");
      setPendingTerminalCommand({ id: Date.now(), command: cmd });
    },
    [openBuildActivity],
  );
  const handleOpenAgentSettings = useCallback(() => {
    setSettingsInitialTab("agents");
    setShowLatexSettings(true);
  }, []);
  const handleCloseRightPanel = useCallback(() => setShowRightPanel(false), []);
  const handleCloseAgentsView = useCallback(() => setWorkspaceView("write"), []);
  const handleAgentsWorkspaceFileClick = useCallback(
    (path: string) => {
      setWorkspaceView("write");
      handleAgentFileClick(path);
    },
    [handleAgentFileClick],
  );
  const handleSwitchDockedToPdf = useCallback(() => {
    setShowRightPanel(false);
    setShowLivePreview(true);
  }, []);
  const handleDockAgentInWrite = useCallback(() => {
    setWorkspaceView("write");
    openDockedAgentPanel();
  }, [openDockedAgentPanel]);
  const handleOpenAgentsWorkspace = useCallback(() => {
    setShowHomeWorkspace(false);
    setShowUsageDashboard(false);
    setWorkspaceView("agents");
  }, []);
  const latestBuildLogExcerpt = useMemo(
    () =>
      latexCompiler.compileLog.length > 0
        ? latexCompiler.compileLog
            .slice(-5)
            .map((entry) => entry.line)
            .join("\n")
        : null,
    [latexCompiler.compileLog],
  );
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

  const historyDiffContent = historyDiffPreview?.content;
  const parsedHistoryDiff = useMemo(() => {
    if (!historyDiffContent) return null;
    return parseUnifiedDiffContent(historyDiffContent);
  }, [historyDiffContent]);

  const renderGitDiffContent = (
    preview: GitDiffPreviewState,
    parsed: ReturnType<typeof parseUnifiedDiffContent> | null,
  ) => {
    if (preview.isLoading) {
      return <EditorSkeleton className="h-full" />;
    }
    if (preview.error) {
      return (
        <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
          Failed to load diff: {preview.error}
        </div>
      );
    }
    if (parsed?.isBinary) {
      return (
        <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
          Binary file diff is not previewable in editor.
        </div>
      );
    }
    if (!preview.content.trim()) {
      return (
        <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
          No textual diff available for this file.
        </div>
      );
    }
    if (parsed?.hasRenderableHunks) {
      return (
        <GitMonacoDiffEditor
          original={parsed.original}
          modified={parsed.modified}
          filePath={preview.path}
          editorSettings={editorSettings.settings}
          className="h-full"
        />
      );
    }
    return (
      <MonacoEditor
        content={preview.content}
        readOnly
        onContentChange={() => {}}
        language="diff"
        editorSettings={editorSettings.settings}
        editorTheme={editorSettings.editorTheme}
        className="h-full"
      />
    );
  };

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

      {selectedFile && /\.tex$/i.test(selectedFile) && !isShowingGitDiff && !binaryPreviewUrl && (
        <div className="h-[34px] px-2 border-b border-border/70 flex items-center gap-1 bg-panel shrink-0">
          <fieldset
            aria-label="Editing mode"
            className="inline-flex bg-sunken rounded-[7px] p-0.5 border-0"
          >
            <button
              type="button"
              className={`px-2.5 py-0.5 rounded-[5px] text-[12px] transition-colors ${
                !visualMode
                  ? "bg-panel text-foreground-strong font-medium ring-1 ring-border"
                  : "text-muted hover:text-foreground"
              }`}
              aria-pressed={!visualMode}
              onClick={() => setVisualMode(false)}
            >
              Code
            </button>
            <button
              type="button"
              className={`px-2.5 py-0.5 rounded-[5px] text-[12px] transition-colors ${
                visualMode
                  ? "bg-panel text-foreground-strong font-medium ring-1 ring-border"
                  : "text-muted hover:text-foreground"
              }`}
              aria-pressed={visualMode}
              onClick={() => setVisualMode(true)}
            >
              Visual
            </button>
          </fieldset>
          <span className="w-px h-4 bg-border mx-1 shrink-0" aria-hidden="true" />
          <button
            type="button"
            aria-label="Bold"
            onClick={() => triggerLatexSnippet("\\textbf{", "}", "text")}
            className="h-6 min-w-6 px-1.5 rounded-[5px] text-[13px] font-bold text-foreground hover:bg-subtle transition-colors"
          >
            B
          </button>
          <button
            type="button"
            aria-label="Italic"
            onClick={() => triggerLatexSnippet("\\textit{", "}", "text")}
            className="h-6 min-w-6 px-1.5 rounded-[5px] text-[14px] italic font-serif text-foreground hover:bg-subtle transition-colors"
          >
            I
          </button>
          <button
            type="button"
            aria-label="Insert reference"
            onClick={() => triggerLatexSnippet("\\ref{", "}", "label")}
            className="h-6 px-1.5 rounded-[5px] text-[12px] font-sans text-foreground hover:bg-subtle transition-colors"
          >
            \ref
          </button>
          <button
            type="button"
            aria-label="Insert citation"
            onClick={() => triggerLatexSnippet("\\cite{", "}", "key")}
            className="h-6 px-1.5 rounded-[5px] text-[12px] font-sans text-foreground hover:bg-subtle transition-colors"
          >
            \cite
          </button>
          <button
            type="button"
            aria-label="Insert math"
            onClick={() => triggerLatexSnippet("$", "$", "x")}
            className="h-6 px-1.5 rounded-[5px] text-[13px] italic font-serif text-foreground hover:bg-subtle transition-colors"
          >
            Σ
          </button>
          <button
            type="button"
            aria-label="Insert figure"
            onClick={() =>
              triggerLatexSnippet(
                "\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{",
                "}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}",
                "figure.pdf",
              )
            }
            className="h-6 px-1.5 rounded-[5px] text-[12px] text-foreground hover:bg-subtle transition-colors"
          >
            Figure
          </button>
          <button
            type="button"
            aria-label="Insert table"
            onClick={() =>
              triggerLatexSnippet(
                "\\begin{table}[t]\n  \\centering\n  \\begin{tabular}{cc}\n    ",
                "\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}",
                "a & b \\\\",
              )
            }
            className="h-6 px-1.5 rounded-[5px] text-[12px] text-foreground hover:bg-subtle transition-colors"
          >
            Table
          </button>
          <span className="ml-auto font-mono text-[11.5px] text-muted truncate">
            {(
              (daemon.projectPath ? projectRelativePath(daemon.projectPath, selectedFile) : null) ??
              selectedFile
            )
              .split("/")
              .join(" / ")}
          </span>
        </div>
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
              {renderGitDiffContent(gitDiffPreview, parsedGitDiff)}
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
              {visualMode && /\.tex$/i.test(selectedFile) ? (
                <VisualEditor
                  value={fileContent}
                  onChange={handleContentChange}
                  filePath={selectedFile}
                  className="h-full"
                />
              ) : (
                <MonacoEditor
                  content={fileContent}
                  readOnly={false}
                  onContentChange={handleContentChange}
                  language={getFileLanguage(selectedFile)}
                  filePath={selectedFile}
                  attributedEdits={attributedEdits.filter(
                    (edit) =>
                      edit.status !== "rejected" &&
                      edit.filePath === selectedFile &&
                      edit.after === fileContent,
                  )}
                  onKeepEdit={keepAttributedEdit}
                  onUndoEdit={undoAttributedEdit}
                  diagnostics={activeFileDiagnostics}
                  bibEntries={bibEntries}
                  texLabels={texLabels}
                  onCompileShortcut={handleCompileShortcut}
                  onForwardSync={handleEditorForwardSync}
                  onAskAgent={handleAskAgentSelection}
                  onNewThreadFromSelection={handleNewThreadFromSelection}
                  onExplainSelection={handleExplainSelection}
                  activeProviderId={
                    agent.activeProviderStatus?.id ?? agentSettings.settings.defaultProvider
                  }
                  activeProviderName={
                    (agent.activeProviderStatus?.id ?? agentSettings.settings.defaultProvider) ===
                    "claude"
                      ? "Claude"
                      : (agent.activeProviderStatus?.id ??
                            agentSettings.settings.defaultProvider) === "codex"
                        ? "Codex"
                        : (agent.activeProviderStatus?.id ??
                              agentSettings.settings.defaultProvider) === "antigravity"
                          ? "Antigravity"
                          : "Custom ACP"
                  }
                  onCursorChange={setCursorPosition}
                  editorSettings={editorSettings.settings}
                  editorTheme={editorSettings.editorTheme}
                  goToLine={pendingGoToLine}
                  pendingSnippet={pendingSnippet}
                  className="h-full"
                />
              )}
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

  const allRelativeFiles = useMemo(
    () => flattenFileNodes(daemon.files, daemon.projectPath),
    [daemon.files, daemon.projectPath],
  );

  const maxDockedWidth = Math.max(380, windowWidth - (showSidebar ? sidebarWidth : 0) - 420);
  const effectiveRightPanelWidth = showLivePreviewEffective
    ? threePaneAgentWidth
    : Math.min(Math.max(rightPanelWidth, 560), maxDockedWidth);
  const isHomeVisible = !showUsageDashboard && (!daemon.projectPath || showHomeWorkspace);
  const isWorkspaceVisible = !showHomeWorkspace && !showUsageDashboard;
  const activateWorkspaceTab = (view: (typeof WORKSPACE_VIEWS)[number]) => {
    setShowHomeWorkspace(false);
    setShowUsageDashboard(false);
    setWorkspaceView(view);
  };

  return (
    <div className="h-dvh flex flex-col bg-bg text-foreground">
      <header className="h-10 shrink-0 px-3.5 flex items-center justify-between gap-3 border-b border-border bg-bg select-none">
        {/* Left: Brand + Project Switcher + Branch */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {!isHomeVisible && (
            <button
              type="button"
              onClick={() => {
                setShowUsageDashboard(false);
                setShowHomeWorkspace(true);
              }}
              className="inline-flex shrink-0 items-center rounded-lg px-1.5 py-1 transition-colors hover:bg-subtle focus:bg-subtle focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Home"
            >
              <OrchestraTeXWordmark />
            </button>
          )}

          {showUsageDashboard ? (
            <>
              {!isHomeVisible && (
                <span className="h-[18px] w-px bg-border-dark shrink-0" aria-hidden="true" />
              )}
              <span className="font-medium text-[13px] text-foreground truncate">
                Usage &amp; limits
              </span>
            </>
          ) : (
            daemon.projectPath && (
              <>
                {!isHomeVisible && (
                  <span className="h-[18px] w-px bg-border-dark shrink-0" aria-hidden="true" />
                )}
                <ProjectSwitcher
                  projectPath={daemon.projectPath}
                  recentProjects={recentProjects.projects}
                  onSelectProject={(path) => {
                    void handleOpenRecentProject(path);
                  }}
                  onOpenFolder={handleOpenFolder}
                />
                {gitStatus?.branch && (
                  <span
                    className="hidden sm:inline-flex items-center gap-1 font-mono text-[11.5px] text-muted border border-border rounded-full px-2 py-0.5 min-w-0 max-w-[250px]"
                    title={`Branch: ${gitStatus.branch}`}
                  >
                    <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{gitStatus.branch}</span>
                    {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                      <span className="shrink-0 tabular-nums">
                        {gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ""}
                        {gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ""}
                      </span>
                    )}
                  </span>
                )}
                {isSaving && (
                  <span className="text-[11px] text-muted-foreground ml-1 shrink-0">Saving...</span>
                )}
              </>
            )
          )}
        </div>

        {/* Center: Write / Agents / History Navigation */}
        {daemon.projectPath || showUsageDashboard ? (
          <div
            aria-label="Workspace"
            role="tablist"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              const index = WORKSPACE_VIEWS.indexOf(workspaceView);
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? WORKSPACE_VIEWS.length - 1
                    : (index + (event.key === "ArrowLeft" ? -1 : 1) + WORKSPACE_VIEWS.length) %
                      WORKSPACE_VIEWS.length;
              const nextView = WORKSPACE_VIEWS[nextIndex];
              if (!nextView) return;
              event.preventDefault();
              activateWorkspaceTab(nextView);
              document.getElementById(`workspace-tab-${nextView}`)?.focus();
            }}
            className="inline-flex items-center bg-sunken rounded-[9px] p-[3px] gap-0.5 shrink-0"
          >
            <button
              type="button"
              role="tab"
              id="workspace-tab-write"
              aria-controls="workspace-panel-write"
              tabIndex={workspaceView === "write" && !showUsageDashboard ? 0 : -1}
              aria-selected={isWorkspaceVisible && workspaceView === "write"}
              onClick={() => activateWorkspaceTab("write")}
              className={`px-3.5 py-1 rounded-[7px] text-[12.5px] transition-colors whitespace-nowrap ${
                isWorkspaceVisible && workspaceView === "write"
                  ? "bg-panel text-foreground-strong font-medium shadow-xs ring-1 ring-border/60"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              id="workspace-tab-agents"
              aria-controls={workspaceView === "agents" ? "workspace-panel-agents" : undefined}
              tabIndex={workspaceView === "agents" || showUsageDashboard ? 0 : -1}
              aria-selected={
                (isWorkspaceVisible && workspaceView === "agents") || showUsageDashboard
              }
              onClick={() => activateWorkspaceTab("agents")}
              className={`px-3.5 py-1 rounded-[7px] text-[12.5px] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                (isWorkspaceVisible && workspaceView === "agents") || showUsageDashboard
                  ? "bg-panel text-foreground-strong font-medium shadow-xs ring-1 ring-border/60"
                  : "text-muted hover:text-foreground"
              }`}
            >
              <span>Agents</span>
              {waitingThreads > 0 && (
                <span className="text-[10.5px] font-semibold bg-[var(--warn-badge-bg)] text-[var(--warn-badge-text)] rounded-full px-1.5 leading-4 tabular-nums">
                  {waitingThreads}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              id="workspace-tab-history"
              aria-controls={workspaceView === "history" ? "workspace-panel-history" : undefined}
              tabIndex={workspaceView === "history" && !showUsageDashboard ? 0 : -1}
              aria-selected={isWorkspaceVisible && workspaceView === "history"}
              onClick={() => activateWorkspaceTab("history")}
              className={`px-3.5 py-1 rounded-[7px] text-[12.5px] transition-colors whitespace-nowrap ${
                isWorkspaceVisible && workspaceView === "history"
                  ? "bg-panel text-foreground-strong font-medium shadow-xs ring-1 ring-border/60"
                  : "text-muted hover:text-foreground"
              }`}
            >
              History
            </button>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Right: Live Voice/Status + Panel Toggles */}
        <div className="flex items-center justify-end gap-2 flex-1 shrink-0">
          {isHomeVisible && !showUsageDashboard && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowUsageDashboard(true)}
            >
              Usage
            </button>
          )}

          {daemon.projectPath &&
            !isHomeVisible &&
            !showUsageDashboard &&
            workspaceView === "write" && (
              <>
                {projectThreads.length > 0 && (
                  <div className="hidden lg:flex items-center -space-x-1.5">
                    {Array.from(
                      projectThreads
                        .reduce(
                          (map, thread) => {
                            const existing = map.get(thread.providerId);
                            const isActive = thread.status === "running";
                            const isWaiting = thread.status === "waiting_input";
                            if (!existing) {
                              map.set(thread.providerId, {
                                provider: thread.providerId,
                                count: 1,
                                active: isActive,
                                waiting: isWaiting,
                                threadId: thread.id,
                              });
                            } else {
                              existing.count += 1;
                              existing.active = existing.active || isActive;
                              existing.waiting = existing.waiting || isWaiting;
                              if (isWaiting) existing.threadId = thread.id;
                            }
                            return map;
                          },
                          new Map<
                            (typeof agent.threads)[number]["providerId"],
                            {
                              provider: (typeof agent.threads)[number]["providerId"];
                              count: number;
                              active: boolean;
                              waiting: boolean;
                              threadId: string;
                            }
                          >(),
                        )
                        .values(),
                    )
                      .sort((a, b) => {
                        const order: Record<string, number> = {
                          claude: 0,
                          codex: 1,
                          antigravity: 2,
                          "custom-acp": 3,
                        };
                        return (order[a.provider] ?? 9) - (order[b.provider] ?? 9);
                      })
                      .map((entry) => {
                        const voice = VOICE_COLORS[entry.provider] ?? VOICE_COLORS["custom-acp"];
                        const statusLabel = entry.waiting
                          ? "waiting"
                          : entry.active
                            ? "running"
                            : "idle";
                        const name =
                          agent.providers.find((provider) => provider.id === entry.provider)
                            ?.name ??
                          {
                            claude: "Claude Code",
                            codex: "Codex",
                            antigravity: "Antigravity",
                            "custom-acp": "Custom ACP",
                          }[entry.provider];
                        return (
                          <button
                            key={entry.provider}
                            type="button"
                            onClick={() => {
                              void agent.loadThread(entry.threadId);
                              activateWorkspaceTab("agents");
                            }}
                            title={`${name} (${entry.count} ${entry.count === 1 ? "thread" : "threads"}) · ${statusLabel}`}
                            aria-label={`${name} ${statusLabel}`}
                            style={{
                              backgroundColor: voice.tint,
                              color: voice.ink,
                              borderColor: entry.active || entry.waiting ? voice.ink : "var(--bg)",
                              borderStyle: entry.waiting ? "dashed" : "solid",
                            }}
                            className="size-[22px] rounded-full border-[1.5px] inline-flex items-center justify-center transition-transform hover:scale-105 hover:z-10"
                          >
                            <ProviderIcon providerId={entry.provider} className="size-3 shrink-0" />
                          </button>
                        );
                      })}
                  </div>
                )}

                <span className="hidden xl:inline text-[12px] text-muted tabular-nums">
                  {runningThreads === 0 && waitingThreads === 0
                    ? "No agents running"
                    : [
                        runningThreads > 0 ? `${runningThreads} editing` : null,
                        waitingThreads > 0 ? `${waitingThreads} waiting` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>

                <span className="h-[18px] w-px bg-border-dark shrink-0" aria-hidden="true" />

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setShowSidebar((prev) => !prev)}
                    className={`size-7 rounded-[7px] inline-flex items-center justify-center transition-colors ${
                      showSidebar
                        ? "text-foreground bg-subtle/80"
                        : "text-muted hover:text-foreground hover:bg-subtle"
                    }`}
                    title="Toggle Sidebar (Cmd+\)"
                    aria-label="Toggle Sidebar"
                    aria-pressed={showSidebar}
                  >
                    <SidebarSimpleIcon className="size-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setBuildActivityCollapsed((prev) => !prev)}
                    className={`size-7 rounded-[7px] inline-flex items-center justify-center transition-colors ${
                      !buildActivityCollapsed
                        ? "text-foreground bg-subtle/80"
                        : "text-muted hover:text-foreground hover:bg-subtle"
                    }`}
                    title="Toggle Bottom Drawer"
                    aria-label="Toggle Bottom Drawer"
                    aria-pressed={!buildActivityCollapsed}
                  >
                    <TerminalIcon className="size-4" />
                  </button>

                  <button
                    type="button"
                    onClick={togglePdfPreview}
                    className={`size-7 rounded-[7px] inline-flex items-center justify-center transition-colors ${
                      showLivePreviewEffective
                        ? "text-foreground bg-subtle/80"
                        : "text-muted hover:text-foreground hover:bg-subtle"
                    }`}
                    title="Toggle Preview Pane (Cmd+P)"
                    aria-label="Toggle Preview Pane"
                    aria-pressed={showLivePreviewEffective}
                  >
                    <FilePdfIcon className="size-4" />
                  </button>
                </div>
              </>
            )}

          {daemon.projectPath &&
            !isHomeVisible &&
            !showUsageDashboard &&
            workspaceView === "agents" && (
              <span className="hidden md:inline text-[12px] text-muted tabular-nums">
                {runningThreads === 0 && waitingThreads === 0
                  ? "No agents running"
                  : `${runningThreads} running · ${waitingThreads} waiting`}
              </span>
            )}

          {daemon.projectPath &&
            !isHomeVisible &&
            !showUsageDashboard &&
            workspaceView === "history" && (
              <span className="hidden md:inline text-[12px] text-muted tabular-nums">
                {uniqueHistoryChangeCount > 0
                  ? `${uniqueHistoryChangeCount} ${uniqueHistoryChangeCount === 1 ? "file" : "files"} changed`
                  : "Working tree clean"}
              </span>
            )}

          <ThemePicker open={showThemePicker} onOpenChange={setShowThemePicker} />

          <button
            type="button"
            onClick={() => {
              setSettingsInitialTab("editor");
              setShowLatexSettings(true);
            }}
            className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="Settings"
            aria-label="Settings"
          >
            <GearIcon className="size-4" />
          </button>

          {showUsageDashboard && usageTopBarState ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={usageTopBarState.onRefresh}
                disabled={usageTopBarState.loading}
                className="text-[12px] text-muted hover:text-foreground tabular-nums transition-colors disabled:opacity-50"
                title="Click to refresh usage"
              >
                {usageTopBarState.loading
                  ? "Refreshing…"
                  : usageTopBarState.refreshedAt
                    ? `Refreshed ${usageTopBarState.refreshedAt}`
                    : "Refresh"}
              </button>
              <button
                type="button"
                onClick={usageTopBarState.onExportCsv}
                disabled={!usageTopBarState.canExport}
                className="btn btn-secondary btn-sm disabled:opacity-50"
              >
                {usageTopBarState.exportStatus ?? "Export CSV"}
              </button>
              <button
                type="button"
                onClick={() => setShowUsageDashboard(false)}
                className="inline-flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
                aria-label="Close usage and limits"
                title="Close (Esc)"
              >
                <XIcon className="size-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            daemon.projectPath &&
            !isHomeVisible &&
            !showUsageDashboard && (
              <button
                type="button"
                onClick={() => {
                  if (!latexCompiler.pdfPath) {
                    toast("Compile the document before exporting PDF", "info");
                    return;
                  }
                  void (async () => {
                    const { save } = await import("@tauri-apps/plugin-dialog");
                    const dest = await save({
                      title: "Export PDF",
                      defaultPath: latexCompiler.pdfPath?.split("/").pop() ?? "document.pdf",
                      filters: [{ name: "PDF", extensions: ["pdf"] }],
                    });
                    if (!dest || !latexCompiler.pdfPath) return;
                    try {
                      const bytes = await invoke<number[]>("read_file_bytes", {
                        path: latexCompiler.pdfPath,
                      });
                      await invoke("write_file_bytes", { path: dest, bytes });
                      toast("Exported PDF", "success");
                    } catch {
                      toast("Failed to export PDF", "error");
                    }
                  })();
                }}
                className="btn btn-secondary btn-sm"
              >
                Export
              </button>
            )
          )}
        </div>
      </header>

      {/* Main Workspace Area: Rail on Warm Paper + White Inset Frames */}
      <main
        className={
          isHomeVisible
            ? "flex-1 min-h-0 flex relative overflow-hidden"
            : "flex-1 min-h-0 flex relative overflow-hidden px-2 pt-2 pb-2 gap-2"
        }
      >
        {showUsageDashboard ? (
          <div className="min-w-0 flex-1 overflow-auto">
            <UsageDashboard
              providers={agent.providers}
              currentProjectPath={daemon.projectPath}
              recentProjects={recentProjects.projects}
              threadTitles={Object.fromEntries(
                mergedOrchestrationThreads.map((thread) => [thread.id, thread.title]),
              )}
              onTopBarStateChange={setUsageTopBarState}
            />
          </div>
        ) : isHomeVisible ? (
          <div className="min-w-0 flex-1">
            <HomeWorkspace
              recentProjects={recentProjects.projects}
              threadCounts={threadCountsByProject}
              compilersStatus={latexCompiler.compilersStatus}
              providers={agent.providers}
              providersLoading={agent.loadingProviders}
              onOpenProject={handleOpenRecentProject}
              onRemoveProject={recentProjects.removeProject}
              onClearProjects={recentProjects.clearAll}
              onOpenFolder={handleOpenFolder}
              onNewProject={() => void handleNewLatexProject()}
              onCloneFromGit={() => setShowCloneDialog(true)}
              onRefreshCompilers={latexCompiler.detectCompilers}
              onRefreshProviders={agent.refreshProviders}
              onRefreshRateLimits={agent.refreshRateLimits}
              onOpenAgentSettings={handleOpenAgentSettings}
            />
          </div>
        ) : null}
        {(() => {
          const isWriteView = Boolean(
            daemon.projectPath &&
              workspaceView === "write" &&
              !showUsageDashboard &&
              !showHomeWorkspace,
          );
          const isAgentsView = Boolean(
            daemon.projectPath &&
              workspaceView === "agents" &&
              !showUsageDashboard &&
              !showHomeWorkspace,
          );
          const isDockedVisible = isWriteView && showRightPanel;
          const isAgentVisible = isAgentsView || isDockedVisible;
          const isMainWorkspaceVisible = isWriteView || isAgentsView;
          const inspectorGitStatus = activeWorktreePath ? worktreeGitStatus : gitStatus;
          const checkoutPath = activeWorktreePath ?? daemon.projectPath;

          return (
            <div
              id={isAgentsView ? "workspace-panel-agents" : "workspace-panel-write"}
              {...(daemon.projectPath &&
                isMainWorkspaceVisible && {
                  role: "tabpanel",
                  "aria-labelledby": isAgentsView ? "workspace-tab-agents" : "workspace-tab-write",
                })}
              className={
                isMainWorkspaceVisible
                  ? "flex-1 min-w-0 min-h-0 flex relative overflow-hidden gap-2"
                  : "hidden"
              }
            >
              {isWriteView && daemon.projectPath && (
                <AnimatePresence mode="wait">
                  {showSidebar && (
                    <motion.div
                      key="sidebar-container"
                      initial={prefersReducedMotion ? { opacity: 1 } : { x: -24, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={prefersReducedMotion ? { opacity: 0 } : { x: -24, opacity: 0 }}
                      transition={prefersReducedMotion ? INSTANT_TRANSITION : PANEL_SPRING}
                      className="flex flex-shrink-0"
                    >
                      <aside
                        style={{
                          width: resizing === "sidebar" ? "var(--sidebar-width)" : sidebarWidth,
                          willChange: resizing === "sidebar" ? "width" : undefined,
                        }}
                        className="flex flex-col flex-shrink-0 overflow-hidden bg-bg px-2 pt-2.5 pb-2 gap-1"
                      >
                        {/* 1. FILES */}
                        <div className="flex-1 min-h-[120px] flex flex-col overflow-hidden">
                          <FileSidebarPanel
                            projectPath={daemon.projectPath}
                            files={daemon.files}
                            selectedFile={selectedFile}
                            highlightedFile={highlightedFile}
                            onFileSelect={handleFileSelect}
                            onCreateFile={() => setCreateDialog({ type: "file" })}
                            onCreateDirectory={() => setCreateDialog({ type: "directory" })}
                            onRefreshFiles={daemon.refreshFiles}
                            fileVoiceDots={fileVoiceDots}
                            mainFile={latexSettings.settings.mainFile}
                            gitStatusByPath={gitStatusByPath}
                            errorCountByPath={errorCountByPath}
                            activeProviderId={agent.activeProviderStatus?.id}
                            onPlanRename={handlePlanRename}
                            onApplyRename={handleApplyRename}
                            onSetMainFile={(node) => void latexSettings.setMainFile(node.path)}
                            onAskAgentOpening={(node) => {
                              openDockedAgentPanel();
                              setAgentDraftInjection({ id: Date.now(), text: `@${node.path} ` });
                            }}
                            fileOperations={{
                              createFile: daemon.createFile,
                              createDirectory: daemon.createDirectory,
                              renamePath: daemon.renamePath,
                              deletePath: daemon.deletePath,
                              duplicateFile: daemon.duplicateFile,
                            }}
                          />
                        </div>

                        {/* 2. OUTLINE */}
                        {selectedFile && /\.tex$/i.test(selectedFile) && (
                          <>
                            <div className="h-px bg-border mx-1.5 my-1.5 shrink-0" />
                            <div className="max-h-[160px] flex flex-col min-h-0 overflow-hidden">
                              <SidebarOutlinePanel
                                compact
                                cursorLine={cursorPosition.line}
                                activeFile={selectedFile}
                                content={outlineContent}
                                onJumpToLine={handleOutlineJumpToLine}
                                onOpenInputFile={handleOutlineOpenInputFile}
                              />
                            </div>
                          </>
                        )}

                        {/* 3. THREADS */}
                        <div className="h-px bg-border mx-1.5 my-1.5 shrink-0" />
                        <div className="flex flex-col min-h-0 shrink-0">
                          <div className="h-7 px-1 pl-2 flex items-center">
                            <span className="ox-sec">Threads</span>
                            <button
                              type="button"
                              onClick={() => {
                                agent.createThread();
                                openDockedAgentPanel();
                              }}
                              className="ml-auto text-[12px] text-foreground hover:bg-subtle px-1.5 py-0.5 rounded-md transition-colors"
                            >
                              + New
                            </button>
                          </div>
                          <div className="max-h-[210px] overflow-y-auto space-y-0.5">
                            {projectThreads.length === 0 ? (
                              <div className="text-[12px] text-muted px-2 py-2 text-center">
                                No threads yet
                              </div>
                            ) : (
                              projectThreads.map((thread) => {
                                const isActive = thread.id === agent.activeThread?.summary.id;
                                const voice =
                                  VOICE_COLORS[thread.providerId] ?? VOICE_COLORS["custom-acp"];
                                const ageMin = Math.max(
                                  1,
                                  Math.round((Date.now() - thread.updatedAt) / 60000),
                                );
                                const ageLabel =
                                  ageMin < 60
                                    ? `${ageMin}m`
                                    : ageMin < 1440
                                      ? `${Math.floor(ageMin / 60)}h`
                                      : `${Math.floor(ageMin / 1440)}d`;
                                const stateLabel =
                                  thread.status === "running"
                                    ? "editing"
                                    : thread.status === "waiting_input"
                                      ? "waiting"
                                      : isActive && showRightPanel
                                        ? "docked →"
                                        : "done";

                                return (
                                  <button
                                    key={thread.id}
                                    type="button"
                                    onClick={() => {
                                      void agent.loadThread(thread.id);
                                      openDockedAgentPanel();
                                    }}
                                    className={`w-full text-left px-2 py-1.5 rounded-[8px] flex gap-2.5 transition-colors ${
                                      isActive
                                        ? "bg-panel ring-1 ring-border shadow-xs"
                                        : "hover:bg-subtle"
                                    }`}
                                  >
                                    <span
                                      className="w-[3px] rounded-[2px] shrink-0"
                                      style={{
                                        backgroundColor: voice.ink,
                                        opacity: thread.status === "idle" && !isActive ? 0.45 : 1,
                                      }}
                                      aria-hidden="true"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="font-medium text-[12.5px] text-foreground truncate">
                                          {thread.title || "Untitled thread"}
                                        </span>
                                        {thread.status === "running" ? (
                                          <span
                                            className="ml-auto flex items-center gap-1 text-[11px] shrink-0"
                                            style={{ color: voice.text }}
                                          >
                                            <span
                                              className="size-1.5 rounded-full"
                                              style={{ backgroundColor: voice.ink }}
                                              aria-hidden="true"
                                            />
                                            live
                                          </span>
                                        ) : thread.status === "waiting_input" ? (
                                          <span className="ml-auto bg-warn-bg border border-[var(--warn-line)] text-warn rounded-full px-1.5 text-[10.5px] font-semibold leading-4 shrink-0">
                                            Approve
                                          </span>
                                        ) : (
                                          <span className="ml-auto text-[11px] text-muted shrink-0">
                                            {ageLabel}
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[11.5px] text-muted mt-0.5 flex items-center gap-1 truncate">
                                        <ProviderIcon
                                          providerId={thread.providerId}
                                          className="size-3 shrink-0"
                                        />
                                        <span className="truncate">
                                          {formatProviderDisplayName(thread.providerId)} ·{" "}
                                          {stateLabel}
                                        </span>
                                      </div>
                                    </div>
                                  </button>
                                );
                              })
                            )}

                            {(() => {
                              const archivedThreads = agent.threads.filter((t) => t.archived);
                              if (archivedThreads.length === 0) return null;
                              return (
                                <div className="pt-0.5">
                                  <button
                                    type="button"
                                    onClick={() => setShowSettledThreads((prev) => !prev)}
                                    className="w-full h-[26px] px-2 rounded-[6px] flex items-center text-[12px] text-muted hover:bg-subtle transition-colors"
                                  >
                                    <span className="mr-1.5 text-[10px]" aria-hidden="true">
                                      {showSettledThreads ? "▾" : "▸"}
                                    </span>
                                    <span>Settled</span>
                                    <span className="ml-auto font-mono text-[11px]">
                                      {archivedThreads.length}
                                    </span>
                                  </button>
                                  {showSettledThreads && (
                                    <div className="space-y-0.5 mt-0.5 pl-2">
                                      {archivedThreads.map((t) => (
                                        <button
                                          key={t.id}
                                          type="button"
                                          onClick={() => {
                                            void agent.loadThread(t.id);
                                            openDockedAgentPanel();
                                          }}
                                          className="w-full text-left px-2 py-1 rounded-[6px] text-[12px] text-muted hover:text-foreground hover:bg-subtle truncate"
                                        >
                                          {t.title || "Untitled thread"}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        {/* 4. Sidebar Footer */}
                        <div className="mt-auto pt-1.5 flex items-center gap-2 px-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => setShowLatexSettings(true)}
                            className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors shrink-0"
                            title="Settings"
                            aria-label="Settings"
                          >
                            <GearIcon className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowUsageDashboard(true)}
                            className="flex-1 min-w-0 text-left rounded-[8px] px-2 py-1 hover:bg-subtle transition-colors"
                          >
                            <div className="flex items-center text-[11.5px] text-muted">
                              <span>Usage today</span>
                              {todayUsageByProvider.length > 0 && (
                                <span className="font-mono text-[11px] text-muted ml-auto">
                                  {(() => {
                                    const total = todayUsageByProvider.reduce(
                                      (sum, p) => sum + p.tokens,
                                      0,
                                    );
                                    return total >= 1000
                                      ? `${(total / 1000).toFixed(1)}k`
                                      : `${total}`;
                                  })()}
                                </span>
                              )}
                            </div>
                            <div className="flex gap-0.5 mt-1 h-[5px]" aria-hidden="true">
                              {todayUsageByProvider.length === 0 ? (
                                <span className="flex-1 rounded-[2px] bg-border" />
                              ) : (
                                todayUsageByProvider.map((entry) => {
                                  const voice =
                                    VOICE_COLORS[entry.providerId] ?? VOICE_COLORS["custom-acp"];
                                  return (
                                    <span
                                      key={entry.providerId}
                                      className="rounded-[2px]"
                                      style={{
                                        flex: entry.tokens,
                                        backgroundColor: voice.ink,
                                      }}
                                    />
                                  );
                                })
                              )}
                            </div>
                          </button>
                        </div>
                      </aside>

                      <div className="relative group w-1.5 flex-shrink-0 -mx-0.5">
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
                          className={`w-[2px] mx-auto h-full rounded-full transition-colors ${
                            resizing === "sidebar" ? "bg-accent" : "group-hover:bg-border-dark"
                          }`}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              )}

              {isAgentsView && (
                <div className="w-[284px] max-xl:w-[248px] shrink-0 overflow-hidden">
                  <OrchestrationSidebar
                    threads={mergedOrchestrationThreads}
                    activeThreadId={activeWorkspaceThread?.id}
                    activeProjectPath={daemon.projectPath}
                    prByThreadId={orchestration.pullRequests}
                    onOpenThread={(thread) =>
                      void handleOpenOrchestrationThread(thread).catch((error: unknown) =>
                        toast(String(error), "error"),
                      )
                    }
                    onNewThread={() =>
                      void agent
                        .createThread()
                        .catch((error: unknown) => toast(String(error), "error"))
                    }
                    onOpenUsage={() => setShowUsageDashboard(true)}
                    todayUsageByProvider={todayUsageByProvider}
                  />
                </div>
              )}

              {/* Primary Content Column: Top Row (Source | Docked Agent | PDF or Agents | Inspector) + Full-Width BuildActivityDrawer */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2 overflow-hidden">
                <div className="flex-1 min-h-0 min-w-0 flex gap-2 relative overflow-hidden">
                  <div
                    className={
                      isWriteView
                        ? "flex-1 min-w-[360px] w-0 flex flex-col overflow-hidden ox-frame"
                        : "hidden"
                    }
                  >
                    {daemon.projectPath && editorPanelItems.length > 0 ? (
                      <div ref={editorWorkspaceRef} className="relative flex-1 min-h-0">
                        {splitDropHint && (
                          <div className="pointer-events-none absolute inset-0 z-10">
                            <div
                              className={`absolute inset-y-0 w-1/2 transition-opacity duration-100 ${
                                splitDropHint === "left"
                                  ? "left-0 border-r border-accent/40 bg-accent-soft/40"
                                  : "right-0 border-l border-accent/40 bg-accent-soft/40"
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
                      <div className="flex-1 min-h-0 overflow-y-auto relative ox-home-grid">
                        <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-2 relative z-10">
                          <div className="text-[15px] font-semibold text-foreground-strong">
                            No file open
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setShowCommandPalette(true)}
                          >
                            <MagnifyingGlassIcon className="size-4" />
                            Find a file
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Single persistent AgentPanel across Write (docked), Agents (full), and History (hidden) */}
                  <div
                    aria-hidden={!isAgentVisible}
                    className={
                      isAgentsView
                        ? "flex-1 min-w-0 min-h-0 flex overflow-hidden"
                        : isDockedVisible
                          ? "flex flex-shrink-0 overflow-hidden max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20"
                          : "hidden"
                    }
                    style={
                      isDockedVisible
                        ? {
                            width:
                              resizing === "right"
                                ? `calc(var(--right-panel-width) + 6px)`
                                : effectiveRightPanelWidth + 6,
                          }
                        : undefined
                    }
                  >
                    {isDockedVisible && (
                      <div className="relative group w-1.5 flex-shrink-0 mr-0.5">
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
                          className={`w-[2px] mx-auto h-full rounded-full transition-colors ${
                            resizing === "right" ? "bg-accent" : "group-hover:bg-border-dark"
                          }`}
                        />
                      </div>
                    )}
                    <aside
                      style={
                        isDockedVisible
                          ? {
                              width:
                                resizing === "right"
                                  ? "var(--right-panel-width)"
                                  : effectiveRightPanelWidth,
                              willChange: resizing === "right" ? "width" : undefined,
                            }
                          : undefined
                      }
                      className={
                        isAgentsView
                          ? "ox-frame flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
                          : "ox-frame flex flex-col flex-shrink-0 max-[1100px]:shadow-md"
                      }
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
                          onFileClick={
                            isAgentsView ? handleAgentsWorkspaceFileClick : handleAgentFileClick
                          }
                          onRunTerminalCommand={handleAgentRunTerminalCommand}
                          onApproveInteraction={score.approveWait}
                          onOpenAgentSettings={handleOpenAgentSettings}
                          onOpenWorkspace={
                            daemon.projectPath ? handleOpenAgentsWorkspace : undefined
                          }
                          mode={isAgentsView ? "workspace" : "docked"}
                          threePane={
                            workspaceView === "write" &&
                            showRightPanel &&
                            Boolean(daemon.projectPath && showLivePreviewEffective)
                          }
                          onSwitchToPdf={handleSwitchDockedToPdf}
                          onDockInWrite={handleDockAgentInWrite}
                          latestBuildLogExcerpt={latestBuildLogExcerpt}
                          onClose={isAgentsView ? handleCloseAgentsView : handleCloseRightPanel}
                        />
                      </AgentErrorBoundary>
                    </aside>
                  </div>

                  {isWriteView && daemon.projectPath && showLivePreviewEffective && (
                    <>
                      <div className="relative group w-1 flex-shrink-0 -mx-1">
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
                          className={`w-[2px] mx-auto h-full rounded-full transition-colors ${
                            resizing === "preview" ? "bg-accent" : "group-hover:bg-border-dark"
                          }`}
                        />
                      </div>
                      <div
                        style={{
                          width:
                            resizing === "preview"
                              ? "var(--preview-panel-width)"
                              : showRightPanel
                                ? threePanePdfWidth
                                : livePreviewWidth,
                        }}
                        className="flex-shrink-0 min-w-0 max-w-[55%] h-full rounded-[10px] border border-border bg-stage overflow-hidden shadow-[var(--frame-shadow)]"
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
                          staleAgentEdits={staleAgentEdits}
                          compiler={latexSettings.settings.compiler}
                          compilersStatus={latexCompiler.compilersStatus}
                          shellEscape={latexSettings.settings.shellEscape}
                          highlightTarget={pdfHighlightTarget}
                          onCompile={handleCompileShortcut}
                          onStopCompile={handleStopCompile}
                          onToggleAutoCompile={handleToggleAutoCompile}
                          onChangeCompiler={(nextCompiler) => {
                            void latexSettings.updateSettings({ compiler: nextCompiler });
                          }}
                          onToggleShellEscape={() => {
                            void latexSettings.updateSettings({
                              shellEscape: !latexSettings.settings.shellEscape,
                            });
                          }}
                          onOpenBuildSettings={() => {
                            setSettingsInitialTab("build");
                            setShowLatexSettings(true);
                          }}
                          onSelectMainFile={() => setShowMainFileDialog(true)}
                          onCleanAuxFiles={handleCleanAuxFiles}
                          onForwardSync={handleLivePreviewForwardSync}
                          onSynctexClick={handleLivePreviewSynctexClick}
                          onJumpToDiagnostic={handleJumpToDiagnostic}
                          onFixDiagnosticsWithAi={handleFixDiagnosticsWithAi}
                          onOpenBuildActivity={openBuildActivity}
                          onClose={handleCloseLivePreview}
                        />
                      </div>
                    </>
                  )}

                  {isAgentsView && (
                    <div className="w-[308px] max-xl:w-[264px] shrink-0 overflow-hidden">
                      <ProjectInspector
                        key={activeWorkspaceThread?.id ?? daemon.projectPath}
                        projectPath={daemon.projectPath}
                        workspacePath={activeWorktreePath}
                        workspaceBranch={activeThreadBranch}
                        gitStatus={inspectorGitStatus?.isRepo ? inspectorGitStatus : null}
                        branchPr={
                          activeWorkspaceThread
                            ? orchestration.pullRequests[activeWorkspaceThread.id]
                            : null
                        }
                        activeThread={activeWorkspaceThread}
                        threads={mergedOrchestrationThreads}
                        error={orchestration.error}
                        onOpenThread={(thread) =>
                          void handleOpenOrchestrationThread(thread).catch((error: unknown) =>
                            toast(String(error), "error"),
                          )
                        }
                        onDelegate={activeWorkspaceThread ? handleDelegateTask : undefined}
                        onSchedule={handleScheduleThread}
                        onCancelSchedule={
                          activeWorkspaceThread?.schedule
                            ? async () => {
                                await invoke("agent_set_thread_schedule", {
                                  projectPath: activeWorkspaceThread.projectPath,
                                  threadId: activeWorkspaceThread.id,
                                  schedule: null,
                                });
                              }
                            : undefined
                        }
                        onCreateWorktree={
                          gitStatus?.hasCommits &&
                          activeWorkspaceThread &&
                          !activeWorktreePath &&
                          !activeWorkspaceThread.providerSessionId &&
                          activeWorkspaceThread.messageCount === 0
                            ? handleCreateThreadWorktree
                            : undefined
                        }
                        onMergeWorktree={
                          activeWorktreePath && gitStatus?.branch
                            ? handleMergeThreadWorktree
                            : undefined
                        }
                        onCommitAndPr={
                          inspectorGitStatus?.remote && activeWorkspaceThread
                            ? () =>
                                handleRequestPullRequest(activeWorkspaceThread, inspectorGitStatus)
                            : undefined
                        }
                        onReviewChanges={
                          !activeWorktreePath && gitStatus?.isRepo
                            ? () => setWorkspaceView("history")
                            : undefined
                        }
                        onPull={
                          !activeWorktreePath && gitStatus?.remote ? handleGitPull : undefined
                        }
                        onPush={
                          !activeWorktreePath && gitStatus?.remote ? handleGitPush : undefined
                        }
                        lastBuild={{
                          mainFile: latexSettings.settings.mainFile,
                          durationMs: latexCompiler.lastCompileDurationMs,
                          builtAt: latexCompiler.lastPdfBuildStartedAt,
                          status: latexCompiler.compileStatus,
                          staleAgentEdits,
                          errorCount: latexCompiler.diagnostics.filter(
                            (d) => d.severity === "error",
                          ).length,
                        }}
                        fileVoiceByPath={fileVoiceByPath}
                        diffPanel={
                          checkoutPath && inspectorGitStatus?.isRepo ? (
                            <WorkspaceChanges
                              key={checkoutPath}
                              directory={checkoutPath}
                              status={inspectorGitStatus}
                              onChanged={
                                activeWorktreePath ? refreshWorktreeStatus : daemon.refreshGitStatus
                              }
                            />
                          ) : undefined
                        }
                        pdfPanel={
                          !activeWorktreePath && latexCompiler.pdfPath ? (
                            <PdfViewer
                              src={convertFileSrc(latexCompiler.pdfPath)}
                              refreshKey={latexCompiler.pdfVersion}
                            />
                          ) : undefined
                        }
                        terminalPanel={
                          <TerminalPanel
                            embedded
                            open
                            projectPath={activeWorktreePath ?? daemon.projectPath}
                            shellMode={editorSettings.settings.terminalShellMode}
                            customShell={editorSettings.settings.terminalShellPath}
                            fontFamily={editorSettings.settings.terminalFontFamily}
                            fontSize={editorSettings.settings.terminalFontSize}
                            lineHeight={editorSettings.settings.terminalLineHeight}
                            prefersReducedMotion={Boolean(prefersReducedMotion)}
                            onClose={() => setWorkspaceView("write")}
                          />
                        }
                      />
                    </div>
                  )}
                </div>

                {/* LaTeX Install Prompt */}
                {isWriteView &&
                  daemon.projectPath &&
                  latexCompiler.compilersStatus &&
                  !hasAnyCompiler &&
                  !latexCompiler.isDetecting && (
                    <div className="border-t border-border">
                      <LaTeXInstallPrompt onRefreshCompilers={latexCompiler.detectCompilers} />
                    </div>
                  )}

                {isWriteView &&
                  Object.entries(failedSourceWrites).map(([path, content]) => (
                    <div
                      key={path}
                      className="flex items-center justify-between gap-2 rounded border border-error bg-error-bg px-3 py-1 text-xs text-error"
                    >
                      <span role="status">
                        Could not save <span className="font-mono">{path}</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void retrySourceSave(path, content)}
                      >
                        Retry save
                      </button>
                    </div>
                  ))}
                {isWriteView && daemon.projectPath && (
                  <BuildActivityDrawer
                    activeTab={buildActivityTab}
                    onChange={openBuildActivity}
                    collapsed={buildActivityCollapsed}
                    onToggle={() => setBuildActivityCollapsed((p) => !p)}
                    scorePanel={
                      <ScoreDrawer
                        lanes={score.lanes}
                        start={score.start}
                        end={score.end}
                        onMark={(mark: ScoreMark) => {
                          if (mark.kind === "compile") {
                            openBuildActivity("build-log");
                            return;
                          }
                          const path = mark.filePath
                            ? projectRelativePath(mark.projectPath, mark.filePath)
                            : null;
                          if (path) {
                            handleAgentFileClick(path);
                          }
                          if (mark.threadId) {
                            void agent.loadThread(mark.threadId);
                            openDockedAgentPanel();
                          }
                        }}
                      />
                    }
                    terminalPanel={
                      <TerminalPanel
                        embedded
                        projectPath={daemon.projectPath}
                        open={terminalMounted}
                        shellMode={editorSettings.settings.terminalShellMode}
                        customShell={editorSettings.settings.terminalShellPath}
                        fontFamily={editorSettings.settings.terminalFontFamily}
                        fontSize={editorSettings.settings.terminalFontSize}
                        lineHeight={editorSettings.settings.terminalLineHeight}
                        prefersReducedMotion={Boolean(prefersReducedMotion)}
                        onClose={() => setBuildActivityCollapsed(true)}
                        pendingCommand={pendingTerminalCommand}
                        onPendingCommandSent={() => setPendingTerminalCommand(null)}
                      />
                    }
                    diagnostics={latexCompiler.diagnostics}
                    threadStatuses={agent.threads
                      .filter((t) => !t.archived)
                      .slice(0, 3)
                      .map((t) => {
                        const name =
                          t.providerId === "claude"
                            ? "Claude"
                            : t.providerId === "codex"
                              ? "Codex"
                              : t.providerId === "antigravity"
                                ? "Antigravity"
                                : "Custom ACP";
                        const state =
                          t.status === "running"
                            ? "editing"
                            : t.status === "waiting_input"
                              ? "waiting"
                              : t.status === "error"
                                ? "error"
                                : t.messageCount > 0
                                  ? "done"
                                  : "idle";
                        return {
                          id: t.id,
                          providerId: t.providerId,
                          label: `${name} ${state}`,
                        };
                      })}
                    buildSummary={
                      latexCompiler.lastCompileDurationMs != null
                        ? `${latexCompiler.lastResult?.compiler ?? latexSettings.settings.compiler} · ${latexCompiler.compileStatus === "error" ? "failed after " : ""}${latexCompiler.lastCompileDurationMs} ms`
                        : undefined
                    }
                    mainFileLogName={
                      latexSettings.settings.mainFile
                        ? `${
                            latexSettings.settings.mainFile
                              .split("/")
                              .pop()
                              ?.replace(/\.tex$/i, "") ?? "main"
                          }.log`
                        : "main.log"
                    }
                    log={latexCompiler.compileLog}
                    onJumpToDiagnostic={handleJumpToDiagnostic}
                    onFixDiagnostics={handleFixDiagnosticsWithAi}
                    fixLabel={
                      agent.activeProviderStatus
                        ? `Fix with ${
                            agent.activeProviderStatus.id === "claude"
                              ? "Claude"
                              : agent.activeProviderStatus.id === "codex"
                                ? "Codex"
                                : agent.activeProviderStatus.id === "antigravity"
                                  ? "Antigravity"
                                  : "Custom ACP"
                          }`
                        : undefined
                    }
                    fixProviders={agent.providers
                      .filter((p) => p.installed)
                      .map((p) => ({
                        id: p.id,
                        label:
                          p.id === "claude"
                            ? "Claude"
                            : p.id === "codex"
                              ? "Codex"
                              : p.id === "antigravity"
                                ? "Antigravity"
                                : "Custom ACP",
                      }))}
                    onSelectFixProvider={(providerId, diags) => {
                      agentSettings.updateSettings({ defaultProvider: providerId });
                      handleFixDiagnosticsWithAi(diags);
                    }}
                    diagnosticSuggestion={(diagnostic) => {
                      const file = projectRelativePath(daemon.projectPath ?? "", diagnostic.file);
                      const isCurrentFile = file === selectedFile;
                      const suggestion = findMissingFileSuggestion({
                        diagnostic,
                        projectFiles: texFiles,
                        projectRoot: daemon.projectPath ?? undefined,
                        sourceContent: isCurrentFile ? fileContent : undefined,
                        recentRenames,
                      });
                      if (!suggestion) return null;
                      const { startOffset, endOffset, before, after } = suggestion;
                      const action =
                        isCurrentFile &&
                        startOffset !== undefined &&
                        endOffset !== undefined &&
                        before !== undefined &&
                        after !== undefined &&
                        fileContent.slice(startOffset, endOffset) === before
                          ? () =>
                              handleContentChange(
                                fileContent.slice(0, startOffset) +
                                  after +
                                  fileContent.slice(endOffset),
                              )
                          : () => handleJumpToDiagnostic(diagnostic);
                      return (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm mt-1"
                          onClick={action}
                        >
                          <span>
                            Did you mean{" "}
                            <code className="font-mono">{suggestion.suggestedArg}</code>?
                          </span>
                        </button>
                      );
                    }}
                  />
                )}
              </div>
            </div>
          );
        })()}

        {daemon.projectPath &&
          workspaceView === "history" &&
          !showUsageDashboard &&
          !showHomeWorkspace && (
            <div
              id="workspace-panel-history"
              aria-labelledby="workspace-tab-history"
              role="tabpanel"
              className="flex-1 min-w-0 min-h-0 flex flex-col gap-2 overflow-hidden"
            >
              {activeWorktreePath && (
                <div className="relative flex items-center gap-2 px-1 shrink-0">
                  <span className="text-[11.5px] text-muted">Checkout</span>
                  <button
                    type="button"
                    onClick={() => setCheckoutMenuOpen((prev) => !prev)}
                    className="btn btn-secondary btn-sm h-7 px-2.5 text-[12px] inline-flex items-center gap-1.5"
                    aria-expanded={checkoutMenuOpen}
                  >
                    <span className="truncate max-w-[180px]">
                      {showThreadHistory ? (activeThreadBranch ?? "Thread worktree") : "Project"}
                    </span>
                    <span className="text-[10px] text-muted" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {checkoutMenuOpen && (
                    <div className="absolute left-14 top-8 z-40 min-w-[190px] ox-popover p-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowThreadHistory(false);
                          setCheckoutMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-[6px] text-[12px] text-left transition-colors ${
                          !showThreadHistory
                            ? "bg-subtle text-foreground-strong font-medium"
                            : "text-foreground hover:bg-subtle"
                        }`}
                      >
                        <span>Project</span>
                        {!showThreadHistory && <span aria-hidden="true">✓</span>}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowThreadHistory(true);
                          setCheckoutMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-[6px] text-[12px] text-left transition-colors ${
                          showThreadHistory
                            ? "bg-subtle text-foreground-strong font-medium"
                            : "text-foreground hover:bg-subtle"
                        }`}
                      >
                        <span className="truncate">{activeThreadBranch ?? "Thread worktree"}</span>
                        {showThreadHistory && <span aria-hidden="true">✓</span>}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <HistoryWorkspace
                key={activeHistoryDir ?? daemon.projectPath}
                className="flex-1"
                projectDir={activeHistoryDir ?? daemon.projectPath}
                gitStatus={activeHistoryGitStatus}
                gitLogEntries={isViewingWorktreeHistory ? worktreeGitLog : daemon.gitLogEntries}
                selectedCommitHash={selectedHistoryCommit?.hash ?? null}
                onSelectCommit={(entry) => void handleSelectHistoryCommit(entry)}
                stagedChanges={activeHistoryStagedChanges}
                unstagedChanges={activeHistoryUnstagedChanges}
                fileVoiceByPath={isViewingWorktreeHistory ? undefined : fileVoiceByPath}
                commitMessage={commitMessage}
                onCommitMessageChange={setCommitMessage}
                onStageFile={handleStageFile}
                onUnstageFile={handleUnstageFile}
                onCommit={async (message) => {
                  await handleCommit(message);
                }}
                onCommitAndPush={
                  !isViewingWorktreeHistory && activeHistoryGitStatus?.remote
                    ? async (message) => {
                        if (await handleCommit(message)) {
                          await handleGitPush();
                        }
                      }
                    : undefined
                }
                onGenerateCommitMessageAI={handleGenerateCommitMessageAI}
                isGeneratingCommitMessageAI={isGeneratingCommitMessageAI}
                onPreviewGitFileDiff={(path, staged) =>
                  void handlePreviewHistoryFileDiff(path, staged)
                }
                onPublishToGitHub={
                  !isViewingWorktreeHistory ? () => void handlePublishToGitHub() : undefined
                }
                onOpenThread={(id) => {
                  const thread = orchestration.threads.find((item) => item.id === id);
                  if (thread)
                    void handleOpenOrchestrationThread(thread).catch((error: unknown) =>
                      toast(String(error), "error"),
                    );
                }}
                beforeMutation={() => {
                  const checkout = activeHistoryDir ?? daemon.projectPath;
                  if (
                    checkout === daemon.projectPath &&
                    (Object.values(pendingSourceWritesRef.current).some(Boolean) ||
                      Object.keys(failedSourceWrites).length)
                  ) {
                    throw new Error("Wait for the editor to finish saving");
                  }
                  if (
                    projectThreads.some(
                      (thread) =>
                        (thread.workspacePath ?? thread.projectPath) === checkout &&
                        (thread.status === "running" || thread.status === "waiting_input"),
                    )
                  ) {
                    throw new Error("Wait for active agent turns in this checkout to finish");
                  }
                }}
                onFilesChanged={() => {
                  if (!isViewingWorktreeHistory) {
                    void daemon.refreshFiles();
                    void daemon.refreshGitStatus();
                  } else {
                    void refreshWorktreeStatus().catch((error: unknown) =>
                      toast(String(error), "error"),
                    );
                  }
                }}
                commitDiffPanel={
                  <div className="flex-1 min-w-0 min-h-0 flex flex-col ox-frame overflow-hidden bg-panel">
                    {historyDiffPreview ? (
                      <>
                        <div className="h-10 px-4 border-b border-border flex items-center justify-between gap-2 shrink-0">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="text-[12.5px] font-mono font-medium truncate">
                              {historyDiffPreview.path}
                            </span>
                            <span className="text-[11px] text-muted shrink-0">
                              {historyDiffPreview.staged ? "Staged" : "Working tree"}
                            </span>
                          </div>
                          {!isViewingWorktreeHistory && (
                            <button
                              type="button"
                              onClick={() => {
                                setWorkspaceView("write");
                                void handleFileSelect(historyDiffPreview.path);
                              }}
                              className="btn btn-secondary btn-sm h-7 px-2.5 text-[11.5px] shrink-0"
                            >
                              Open in Write
                            </button>
                          )}
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden">
                          {renderGitDiffContent(historyDiffPreview, parsedHistoryDiff)}
                        </div>
                      </>
                    ) : historyCommitDiff ? (
                      <>
                        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-3 shrink-0">
                          <div className="min-w-0">
                            <div className="text-[14px] font-semibold text-foreground truncate">
                              {historyCommitDiff.entry.message}
                            </div>
                            <div className="text-[11.5px] font-mono text-muted truncate mt-0.5">
                              {historyCommitDiff.entry.shortHash} · {historyCommitDiff.entry.author}{" "}
                              · {formatCheckpointTime(historyCommitDiff.entry.date)}
                            </div>
                          </div>
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden">
                          {historyCommitDiff.isLoading ? (
                            <EditorSkeleton className="h-full" />
                          ) : historyCommitDiff.error ? (
                            <div className="h-full flex items-center justify-center px-6 text-xs text-muted">
                              Failed to load commit diff: {historyCommitDiff.error}
                            </div>
                          ) : !historyCommitDiff.content.trim() ? (
                            <div className="h-full flex items-center justify-center px-6 text-xs text-muted">
                              No textual diff available for this commit.
                            </div>
                          ) : (
                            <MonacoEditor
                              content={historyCommitDiff.content}
                              readOnly
                              onContentChange={() => {}}
                              language="diff"
                              editorSettings={editorSettings.settings}
                              editorTheme={editorSettings.editorTheme}
                              className="h-full"
                            />
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="h-full flex items-center justify-center text-xs text-muted">
                        Select a commit or changed file to inspect its diff.
                      </div>
                    )}
                  </div>
                }
              />
            </div>
          )}
      </main>

      {daemon.projectPath && !showUsageDashboard && !showHomeWorkspace && (
        <StatusBar
          workspaceView={workspaceView}
          gitStatus={gitStatus}
          compileStatus={latexCompiler.compileStatus}
          lastCompileDurationMs={latexCompiler.lastCompileDurationMs}
          compiler={
            latexCompiler.compileStatus === "idle"
              ? latexSettings.settings.compiler
              : (latexCompiler.lastResult?.compiler ?? latexSettings.settings.compiler)
          }
          errorCount={latexCompiler.diagnostics.filter((d) => d.severity === "error").length}
          warningCount={latexCompiler.diagnostics.filter((d) => d.severity !== "error").length}
          selectedFile={selectedFile}
          isTextFile={workspaceView === "write" && Boolean(selectedFile) && !binaryPreviewUrl}
          cursorPosition={cursorPosition}
          wordCount={wordCount.words}
          agentSummary={{
            total: projectThreads.length,
            running: runningThreads,
            waiting: waitingThreads,
            scheduled: 0,
          }}
          cacheSummaryLabel={
            todayCachePercent != null ? `Cache ${todayCachePercent}% of input today` : null
          }
        />
      )}

      <CommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        files={allRelativeFiles}
        labels={texLabels}
        bibEntries={bibEntries}
        diagnostics={latexCompiler.diagnostics}
        onOpenFile={(filePath, line) => {
          activateWorkspaceTab("write");
          void handleFileSelect(filePath).then(() => {
            if (line && line > 0) setPendingGoToLine(line);
          });
        }}
        onCompile={handleCompileShortcut}
        onToggleSidebar={() => setShowSidebar((p) => !p)}
        onTogglePdf={togglePdfPreview}
        onToggleAgent={handleToggleRightPanel}
        onToggleTerminal={toggleTerminal}
        onOpenSettings={() => {
          setSettingsInitialTab("editor");
          setShowLatexSettings(true);
        }}
        onOpenThemePicker={() => setShowThemePicker(true)}
      />

      {showCloneDialog && (
        <InputDialog
          title="Clone from Git"
          placeholder="Repository URL"
          onConfirm={(url) => void handleCloneProject(url)}
          onCancel={() => setShowCloneDialog(false)}
          validator={(url) => (url.trim() ? null : "Enter a repository URL")}
        />
      )}

      {pullRequestDraft && (
        <InputDialog
          title="Commit staged changes and open a pull request"
          placeholder="Commit message"
          onConfirm={(message) => {
            setPullRequestDraft(null);
            void handlePublishBranch(pullRequestDraft, message.trim()).catch((error: unknown) =>
              toast(String(error), "error"),
            );
          }}
          onCancel={() => setPullRequestDraft(null)}
          validator={(message) => (message.trim() ? null : "Enter a commit message")}
        />
      )}

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
      />

      {mainFileDetectionResult && (
        <MainFileSelectionDialog
          open={showMainFileDialog}
          detectionResult={mainFileDetectionResult}
          onSelect={handleMainFileSelect}
          onCancel={handleMainFileDialogCancel}
        />
      )}

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
    </div>
  );
}

function AgentPanelSkeleton() {
  return (
    <div className="flex flex-col bg-panel h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-full bg-sunken animate-pulse" />
          <div className="h-4 w-24 rounded-md bg-sunken animate-pulse" />
        </div>
        <div className="h-6 w-12 rounded-md bg-sunken animate-pulse" />
      </div>
      <div className="flex-1 p-4 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div
              className="h-3.5 rounded-md bg-subtle animate-pulse"
              style={{ width: `${60 + i * 10}%` }}
            />
            <div
              className="h-3.5 rounded-md bg-subtle animate-pulse"
              style={{ width: `${40 + i * 10}%` }}
            />
          </div>
        ))}
      </div>
      <div className="p-3">
        <div className="h-20 rounded-[14px] bg-subtle border border-border animate-pulse" />
      </div>
    </div>
  );
}
