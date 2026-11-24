"use client";

import { normalize } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import { Command } from "@tauri-apps/plugin-shell";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NodeApi, NodeRendererProps, TreeApi } from "react-arborist";
import { Tree } from "react-arborist";
import { createPortal } from "react-dom";
import { pathSync } from "@/lib/path";

async function runCommand(cmd: string, args: string[]): Promise<boolean> {
  try {
    const result = await Command.create(cmd, args).execute();
    return result.code === 0;
  } catch {
    return false;
  }
}

// Reveal file/folder in system file manager
async function revealInFileManager(path: string): Promise<void> {
  const os = platform();
  const normalizedPath = await normalize(path);

  if (os === "macos") {
    // macOS: open -R reveals the item in Finder
    const ok = await runCommand("open", ["-R", normalizedPath]);
    if (!ok) {
      await runCommand("open", [normalizedPath]);
    }
  } else if (os === "windows") {
    // Windows: explorer /select, requires the path as part of the argument
    // Pass /select,<path> as a single argument (Tauri will handle quoting)
    await runCommand("explorer", [`/select,${normalizedPath}`]);
  } else {
    // Linux: xdg-open opens the containing folder
    const parentPath = pathSync.dirname(normalizedPath) || normalizedPath;
    const ok = await runCommand("xdg-open", [parentPath]);
    if (!ok) {
      await runCommand("gio", ["open", parentPath]);
    }
  }
}

// Open folder in system terminal
async function openInTerminal(folderPath: string): Promise<void> {
  const os = platform();
  const normalizedPath = await normalize(folderPath);

  if (os === "macos") {
    // macOS: open Terminal.app at the folder
    await runCommand("open", ["-a", "Terminal", normalizedPath]);
  } else if (os === "windows") {
    // Windows: open cmd or Windows Terminal at the folder
    // Try Windows Terminal first, fall back to cmd
    const wtOk = await runCommand("wt", ["-d", normalizedPath]);
    if (!wtOk) {
      await runCommand("cmd", ["/c", "start", "cmd", "/k", `cd /d "${normalizedPath}"`]);
    }
  } else {
    // Linux: try common terminal emulators
    const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
    for (const term of terminals) {
      const ok = await runCommand(term, ["--working-directory", normalizedPath]);
      if (ok) break;
    }
  }
}

// Copy text to clipboard
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

async function copyNormalizedAbsolutePath(path: string): Promise<void> {
  const normalizedPath = await normalize(path);
  await copyToClipboard(normalizedPath);
}

import type { FileNode } from "@orchestratex/shared";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  BookOpenTextIcon,
  BracketsCurlyIcon,
  ClipboardTextIcon,
  CopyIcon,
  CubeIcon,
  FileCodeIcon,
  FileIcon as FileIconSymbol,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GearIcon,
  ImageIcon,
  MusicNoteIcon,
  PencilLineIcon,
  TableIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TrashIcon,
  VideoCameraIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { AgentProviderId } from "@/lib/agent/types";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { ContextMenu, type ContextMenuItem } from "../ui/context-menu";
import { InputDialog } from "../ui/input-dialog";

export interface FileOperations {
  createFile: (path: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  renamePath: (
    oldPath: string,
    newPath: string,
    referenceUpdates?: Array<{ path: string; before: string; after: string }>,
  ) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  duplicateFile: (path: string) => Promise<string | null>;
}

export interface FileVoiceDot {
  provider: AgentProviderId | "you";
  label?: string;
  pulse?: boolean;
}

type Props = {
  files: FileNode[];
  onFileSelect?: (path: string) => void;
  selectedFile?: string;
  highlightedFile?: string | null;
  className?: string;
  fileOperations?: FileOperations;
  projectPath?: string;
  onRefresh?: () => void;
  fileVoiceDots?: Record<string, FileVoiceDot[]>;
  onPlanRename?: (node: FileNode, newPath: string) => Promise<number>;
  onApplyRename?: (
    node: FileNode,
    newPath: string,
    options: { updateReferences: boolean },
  ) => Promise<void>;
  onSetMainFile?: (node: FileNode) => void;
  onAskAgentOpening?: (node: FileNode) => void;
  mainFile?: string | null;
  gitStatusByPath?: Record<string, string>;
  errorCountByPath?: Record<string, number>;
  searchQuery?: string;
  activeProviderId?: AgentProviderId;
};

interface InlineRenameState {
  node: FileNode;
  draftName: string;
  status: "editing" | "planning" | "confirm-refs" | "applying";
  referenceCount: number;
  pendingNewPath: string | null;
  error: string | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
  parentPath: string;
}

interface DialogState {
  type: "create-file" | "create-directory" | "rename";
  parentPath?: string;
  node?: FileNode;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.substring(lastDot).toLowerCase() : "";
}

// Map file extensions to icons
type IconType = React.ComponentType<{ className?: string; size?: number }>;

const FILE_ICON_MAP: Record<string, IconType> = {
  // LaTeX source files
  ".tex": FileTextIcon,
  ".ltx": FileTextIcon,
  // LaTeX bibliography
  ".bib": BookOpenTextIcon,
  // LaTeX document class (template)
  ".cls": CubeIcon,
  // LaTeX style packages
  ".sty": CubeIcon,
  // LaTeX package source
  ".dtx": CubeIcon,
  ".ins": CubeIcon,
  // LaTeX output
  ".pdf": FileIconSymbol,
  ".dvi": FileIconSymbol,
  ".ps": FileIconSymbol,
  // LaTeX config
  ".latexmkrc": GearIcon,
  // Documents
  ".doc": FileTextIcon,
  ".docx": FileTextIcon,
  ".txt": FileTextIcon,
  ".rtf": FileTextIcon,
  ".md": FileTextIcon,
  ".mdx": FileTextIcon,
  ".rst": FileTextIcon,
  // Code
  ".js": FileCodeIcon,
  ".jsx": FileCodeIcon,
  ".ts": FileCodeIcon,
  ".tsx": FileCodeIcon,
  ".mjs": FileCodeIcon,
  ".cjs": FileCodeIcon,
  ".py": FileCodeIcon,
  ".rb": FileCodeIcon,
  ".go": FileCodeIcon,
  ".rs": FileCodeIcon,
  ".c": FileCodeIcon,
  ".cpp": FileCodeIcon,
  ".h": FileCodeIcon,
  ".hpp": FileCodeIcon,
  ".java": FileCodeIcon,
  ".kt": FileCodeIcon,
  ".swift": FileCodeIcon,
  ".lua": FileCodeIcon,
  ".r": FileCodeIcon,
  ".m": FileCodeIcon,
  ".html": FileCodeIcon,
  ".htm": FileCodeIcon,
  ".css": FileCodeIcon,
  ".scss": FileCodeIcon,
  ".sass": FileCodeIcon,
  ".less": FileCodeIcon,
  ".vue": FileCodeIcon,
  ".svelte": FileCodeIcon,
  // Shell/Scripts
  ".sh": TerminalIcon,
  ".bash": TerminalIcon,
  ".zsh": TerminalIcon,
  ".fish": TerminalIcon,
  ".ps1": TerminalIcon,
  ".bat": TerminalIcon,
  ".cmd": TerminalIcon,
  // Config/Data
  ".json": BracketsCurlyIcon,
  ".yaml": BracketsCurlyIcon,
  ".yml": BracketsCurlyIcon,
  ".toml": BracketsCurlyIcon,
  ".xml": BracketsCurlyIcon,
  ".ini": GearIcon,
  ".cfg": GearIcon,
  ".conf": GearIcon,
  ".env": GearIcon,
  ".gitignore": GearIcon,
  ".editorconfig": GearIcon,
  ".prettierrc": GearIcon,
  ".eslintrc": GearIcon,
  // Images
  ".png": ImageIcon,
  ".jpg": ImageIcon,
  ".jpeg": ImageIcon,
  ".gif": ImageIcon,
  ".svg": ImageIcon,
  ".webp": ImageIcon,
  ".ico": ImageIcon,
  ".bmp": ImageIcon,
  ".tiff": ImageIcon,
  ".tif": ImageIcon,
  ".eps": ImageIcon,
  ".pgf": ImageIcon,
  ".tikz": ImageIcon,
  // Archives
  ".zip": ArchiveIcon,
  ".tar": ArchiveIcon,
  ".gz": ArchiveIcon,
  ".rar": ArchiveIcon,
  ".7z": ArchiveIcon,
  // Video
  ".mp4": VideoCameraIcon,
  ".mkv": VideoCameraIcon,
  ".avi": VideoCameraIcon,
  ".mov": VideoCameraIcon,
  ".webm": VideoCameraIcon,
  // Audio
  ".mp3": MusicNoteIcon,
  ".wav": MusicNoteIcon,
  ".flac": MusicNoteIcon,
  ".ogg": MusicNoteIcon,
  ".m4a": MusicNoteIcon,
  // Spreadsheet/Data
  ".csv": TableIcon,
  ".xls": TableIcon,
  ".xlsx": TableIcon,
  ".tsv": TableIcon,
};

function FileIcon({
  type,
  expanded,
  filename,
}: {
  type: "file" | "directory";
  expanded?: boolean;
  filename?: string;
}) {
  const iconClass = "w-4 h-4 flex-shrink-0";

  if (type === "directory") {
    return expanded ? (
      <FolderOpenIcon className={iconClass} size={16} />
    ) : (
      <FolderIcon className={iconClass} size={16} />
    );
  }

  const ext = filename ? getFileExtension(filename) : "";
  const IconComponent = FILE_ICON_MAP[ext] || FileIconSymbol;

  return <IconComponent className={iconClass} size={16} />;
}

// --- react-arborist data types ---

interface ArboristFileNode {
  id: string;
  name: string;
  type: "file" | "directory";
  path: string;
  children?: ArboristFileNode[];
}

function convertToArboristData(nodes: FileNode[]): ArboristFileNode[] {
  return nodes.map((node) => {
    const result: ArboristFileNode = {
      id: node.path,
      name: node.name,
      type: node.type,
      path: node.path,
    };
    if (node.type === "directory") {
      result.children = node.children ? convertToArboristData(node.children) : [];
    }
    return result;
  });
}

// --- Context for passing data to node renderer ---

interface DragState {
  isDragging: boolean;
  draggedPath: string | null;
  draggedName: string | null;
  draggedType: "file" | "directory" | null;
  dragOverPath: string | null;
  mouseX: number;
  mouseY: number;
}

const initialDragState: DragState = {
  isDragging: false,
  draggedPath: null,
  draggedName: null,
  draggedType: null,
  dragOverPath: null,
  mouseX: 0,
  mouseY: 0,
};

interface FileTreeContextValue {
  selectedFile?: string;
  highlightedFile?: string | null;
  fileVoiceDots?: Record<string, FileVoiceDot[]>;
  mainFile?: string | null;
  gitStatusByPath?: Record<string, string>;
  errorCountByPath?: Record<string, number>;
  onContextMenu?: (e: React.MouseEvent, node: FileNode, parentPath: string) => void;
  onFileSelect?: (path: string) => void;
  dragState: DragState;
  onDragMouseDown?: (
    e: React.MouseEvent,
    path: string,
    name: string,
    type: "file" | "directory",
  ) => void;
  inlineRename?: InlineRenameState | null;
  onInlineRenameChange?: (draftName: string) => void;
  onInlineRenameSubmit?: () => void;
  onInlineRenameCancel?: () => void;
  onInlineRenameResolveRefs?: (updateReferences: boolean) => void;
}

const FileTreeContext = createContext<FileTreeContextValue>({
  dragState: initialDragState,
});

// --- Node renderer ---

function NodeRenderer({ node, style }: NodeRendererProps<ArboristFileNode>) {
  const {
    selectedFile,
    highlightedFile,
    fileVoiceDots,
    mainFile,
    gitStatusByPath,
    errorCountByPath,
    onContextMenu,
    onFileSelect,
    dragState,
    onDragMouseDown,
    inlineRename,
    onInlineRenameChange,
    onInlineRenameSubmit,
    onInlineRenameCancel,
    onInlineRenameResolveRefs,
  } = useContext(FileTreeContext);

  const voiceDots = fileVoiceDots?.[node.data.path];
  const isRenaming = inlineRename?.node.path === node.data.path;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const updateReferencesRef = useRef<HTMLButtonElement>(null);
  const renamePromptId = useId();
  const showRefsPrompt = isRenaming && inlineRename?.status === "confirm-refs";

  useEffect(() => {
    if (!isRenaming) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    const value = input.value;
    const dotIndex = value.lastIndexOf(".");
    if (dotIndex > 0) {
      input.setSelectionRange(0, dotIndex);
    } else {
      input.setSelectionRange(0, value.length);
    }
  }, [isRenaming]);

  useEffect(() => {
    if (showRefsPrompt) updateReferencesRef.current?.focus();
  }, [showRefsPrompt]);

  const isDirectory = node.data.type === "directory";
  const isSelected = selectedFile === node.data.path;
  const isHighlighted = highlightedFile === node.data.path;
  const isFocused = node.isFocused && !isSelected;
  const isDragging = dragState.draggedPath === node.data.path;
  const isDragOver = dragState.dragOverPath === node.data.path && isDirectory;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't handle click if we just finished dragging
      if (dragState.isDragging) return;
      node.handleClick(e);
      if (isDirectory) {
        node.toggle();
      } else {
        onFileSelect?.(node.data.path);
      }
    },
    [isDirectory, node, onFileSelect, dragState.isDragging],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (isDirectory) {
        node.toggle();
      } else {
        onFileSelect?.(node.data.path);
      }
    },
    [isDirectory, node, onFileSelect],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parentPath = pathSync.dirname(node.data.path);
      onContextMenu?.(
        e,
        {
          name: node.data.name,
          path: node.data.path,
          type: node.data.type,
        },
        parentPath,
      );
    },
    [onContextMenu, node.data],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only left mouse button, and only if drag is enabled
      if (e.button !== 0 || !onDragMouseDown) return;
      onDragMouseDown(e, node.data.path, node.data.name, node.data.type);
    },
    [onDragMouseDown, node.data.path, node.data.name, node.data.type],
  );

  if (isRenaming && inlineRename) {
    const isBusy = inlineRename.status === "planning" || inlineRename.status === "applying";
    return (
      <div
        style={style}
        role="treeitem"
        aria-selected={isSelected}
        tabIndex={-1}
        data-path={node.data.path}
        data-type={node.data.type}
        className="w-full px-2 py-1 flex flex-col justify-center bg-panel ring-1 ring-border-dark ring-inset"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onInlineRenameCancel?.();
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-3 h-3 flex-shrink-0"
            style={{
              marginLeft: `${node.level * 12}px`,
            }}
          />
          <input
            ref={renameInputRef}
            type="text"
            value={inlineRename.draftName}
            disabled={isBusy || showRefsPrompt}
            aria-label={`Rename ${node.data.name}`}
            onChange={(e) => onInlineRenameChange?.(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                if (!isBusy && !showRefsPrompt) {
                  onInlineRenameSubmit?.();
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                onInlineRenameCancel?.();
              }
            }}
            onBlur={() => {
              if (inlineRename.status === "editing") {
                onInlineRenameCancel?.();
              }
            }}
            className="flex-1 min-w-0 border-[1.5px] border-[var(--popover-border)] rounded-[5px] bg-background px-1.5 py-0.5 text-[12px] font-mono text-foreground-strong focus:outline-none disabled:opacity-60"
          />
        </div>
        {showRefsPrompt && (
          <div
            className="mt-1 bg-panel border border-border rounded-[6px] px-2 py-1 flex items-center gap-1.5 font-sans text-[11.5px] text-foreground"
            style={{ marginLeft: `${node.level * 12 + 20}px` }}
          >
            <span id={renamePromptId} className="truncate">
              {inlineRename.referenceCount} <span className="font-mono">\input</span> to update
            </span>
            <div className="ml-auto flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                ref={updateReferencesRef}
                aria-describedby={renamePromptId}
                disabled={isBusy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInlineRenameResolveRefs?.(true)}
                className="bg-primary text-primary-text rounded-[5px] px-2 py-0.5 font-semibold text-[11px] hover:opacity-90 disabled:opacity-50"
              >
                Update
              </button>
              <button
                type="button"
                disabled={isBusy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInlineRenameResolveRefs?.(false)}
                className="text-muted hover:text-foreground px-1 py-0.5 text-[11px] disabled:opacity-50"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={isBusy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInlineRenameCancel?.()}
                className="text-muted hover:text-foreground px-1 py-0.5 text-[11px] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {inlineRename.error && (
          <div
            role="alert"
            className="mt-0.5 text-[11px] text-error break-words whitespace-normal leading-tight"
            style={{ paddingLeft: `${node.level * 12 + 20}px` }}
            title={inlineRename.error}
          >
            {inlineRename.error}
          </div>
        )}
      </div>
    );
  }

  const normalizedNodePath = node.data.path.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedMainFile = mainFile?.replace(/\\/g, "/").replace(/^\.\//, "");
  const isMainFile =
    !isDirectory && Boolean(normalizedMainFile && normalizedMainFile === normalizedNodePath);
  const errorCount = !isDirectory
    ? (errorCountByPath?.[normalizedNodePath] ?? errorCountByPath?.[node.data.path] ?? 0)
    : 0;
  const gitStatus = !isDirectory
    ? (gitStatusByPath?.[normalizedNodePath] ?? gitStatusByPath?.[node.data.path])
    : undefined;
  const gitStatusColor =
    gitStatus === "M"
      ? "text-warn"
      : gitStatus === "A" || gitStatus === "R"
        ? "text-success"
        : gitStatus === "D"
          ? "text-error"
          : "text-muted";

  return (
    <div
      style={style}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
      role="treeitem"
      aria-expanded={isDirectory ? node.isOpen : undefined}
      aria-selected={isSelected}
      tabIndex={-1}
      data-path={node.data.path}
      data-type={node.data.type}
      className={`w-full h-[26px] flex items-center gap-1.5 px-2 rounded-[6px] text-left font-mono text-[12px] transition-colors select-none ${
        isDragging ? "opacity-50" : ""
      } ${
        isDragOver
          ? "border-[1.5px] border-dashed border-muted bg-panel/40"
          : isSelected
            ? "bg-panel ring-1 ring-border text-foreground-strong font-medium"
            : isFocused
              ? "bg-subtle text-foreground-strong"
              : isDirectory
                ? "text-muted hover:bg-subtle"
                : "text-foreground hover:bg-subtle"
      } ${isHighlighted && !isSelected ? "animate-highlight" : ""}`}
    >
      <div
        className="flex-shrink-0 flex items-center justify-center w-3 text-[10px] text-muted"
        style={{
          marginLeft: `${node.level * 12}px`,
        }}
        aria-hidden="true"
      >
        {isDirectory ? (node.isOpen ? "▾" : "▸") : null}
      </div>
      <span className="truncate">{node.data.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        {voiceDots?.map((dot) => (
          <span
            key={dot.provider}
            className="inline-block size-[7px] shrink-0 rounded-full"
            style={{
              backgroundColor: VOICE_COLORS[dot.provider].ink,
              boxShadow: dot.pulse ? `0 0 0 3px ${VOICE_COLORS[dot.provider].tint}` : undefined,
            }}
            title={dot.label ?? dot.provider}
            aria-label={dot.label ?? dot.provider}
            role="img"
          />
        ))}
        {isMainFile && (
          <span className="font-sans text-[10px] font-semibold text-muted border border-border-dark rounded px-1 leading-[15px]">
            MAIN
          </span>
        )}
        {errorCount > 0 && (
          <span className="font-sans text-[10px] font-semibold bg-error-bg text-error rounded px-1 leading-[15px]">
            {errorCount} ERR
          </span>
        )}
        {gitStatus && <span className={`font-semibold ${gitStatusColor}`}>{gitStatus}</span>}
      </span>
    </div>
  );
}

// --- Helpers ---

function getParentPath(path: string): string | null {
  const parent = pathSync.dirname(path);
  return parent || null;
}

function collectAllAncestorPaths(path: string): string[] {
  return pathSync.ancestors(path);
}

// Build a flat lookup from path -> FileNode for keyboard shortcuts
function buildNodeMap(nodes: FileNode[]): Map<string, FileNode> {
  const map = new Map<string, FileNode>();
  function walk(list: FileNode[]) {
    for (const n of list) {
      map.set(n.path, n);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return map;
}

// --- Inner component ---

function FileTreeInner({
  files,
  onFileSelect,
  selectedFile,
  highlightedFile,
  className = "",
  fileOperations,
  projectPath,
  onRefresh,
  fileVoiceDots,
  onPlanRename,
  onApplyRename,
  onSetMainFile,
  onAskAgentOpening,
  mainFile,
  gitStatusByPath,
  errorCountByPath,
  searchQuery,
  activeProviderId,
}: Props) {
  const treeRef = useRef<TreeApi<ArboristFileNode>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const planRequestIdRef = useRef(0);

  const startInlineRename = useCallback((node: FileNode) => {
    planRequestIdRef.current += 1;
    setInlineRename({
      node,
      draftName: node.name,
      status: "editing",
      referenceCount: 0,
      pendingNewPath: null,
      error: null,
    });
  }, []);

  const requestConfirm = useCallback((payload: ConfirmDialogState) => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false);
    }
    setConfirmDialog(payload);
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
    });
  }, []);

  const closeConfirm = useCallback((result: boolean) => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(result);
      confirmResolverRef.current = null;
    }
    setConfirmDialog(null);
  }, []);

  // Mouse-based drag-and-drop state
  const [dragState, setDragState] = useState<DragState>(initialDragState);
  const draggedNodeRef = useRef<{ path: string; type: "file" | "directory" } | null>(null);

  const filteredFiles = useMemo(() => {
    const q = searchQuery?.trim().toLowerCase();
    if (!q) return files;
    function filterNodes(nodes: FileNode[], query: string): FileNode[] {
      const result: FileNode[] = [];
      for (const node of nodes) {
        const nameMatches = node.name.toLowerCase().includes(query);
        if (node.type === "directory" && node.children) {
          const matchingChildren = filterNodes(node.children, query);
          if (nameMatches || matchingChildren.length > 0) {
            result.push({
              ...node,
              children: nameMatches ? node.children : matchingChildren,
            });
          }
        } else if (nameMatches) {
          result.push(node);
        }
      }
      return result;
    }
    return filterNodes(files, q);
  }, [files, searchQuery]);

  const arboristData = useMemo(() => convertToArboristData(filteredFiles), [filteredFiles]);
  const nodeMap = useMemo(() => buildNodeMap(files), [files]);

  // Measure container for react-arborist width/height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Highlight effect: open ancestors and scroll into view
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !highlightedFile) return;

    // Open all ancestor directories
    const ancestors = collectAllAncestorPaths(highlightedFile);
    for (const ancestorPath of ancestors) {
      tree.open(ancestorPath);
    }

    // Scroll to the highlighted node after a short delay to let opens settle
    requestAnimationFrame(() => {
      tree.scrollTo(highlightedFile, "center");
    });
  }, [highlightedFile]);

  // --- Mouse-based drag-and-drop ---

  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const DRAG_THRESHOLD = 5; // pixels before drag starts

  // Store handler refs to avoid stale closure issues with event listeners
  const handleMouseMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const handleMouseUpRef = useRef<((e: MouseEvent) => void) | null>(null);

  // Find drop target from mouse position
  const findDropTarget = useCallback(
    (x: number, y: number): { path: string; type: "file" | "directory" } | null => {
      const elements = document.elementsFromPoint(x, y);
      for (const el of elements) {
        const treeItem = el.closest("[data-path]") as HTMLElement | null;
        if (treeItem && containerRef.current?.contains(treeItem)) {
          const path = treeItem.dataset.path;
          const type = treeItem.dataset.type as "file" | "directory";
          if (path && type) {
            return { path, type };
          }
        }
      }

      // If we're inside the tree container but not over a node, treat as root drop target
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { path: "", type: "directory" };
        }
      }
      return null;
    },
    [],
  );

  // Check if drop target is valid
  const isValidDropTarget = useCallback((targetPath: string, targetType: string): boolean => {
    const dragged = draggedNodeRef.current;
    if (!dragged) {
      return false;
    }

    // Can only drop into directories
    if (targetType !== "directory") {
      return false;
    }

    // Normalize paths for cross-platform comparison (handles both / and \)
    const normalizedTarget = pathSync.normalizeForCompare(targetPath);
    const normalizedDragged = pathSync.normalizeForCompare(dragged.path);

    // Cannot drop into itself or its descendants
    if (
      normalizedTarget === normalizedDragged ||
      normalizedTarget.startsWith(`${normalizedDragged}/`)
    ) {
      return false;
    }

    // Cannot drop into current parent (no-op)
    const currentParent = pathSync.dirname(dragged.path);
    const normalizedParent = pathSync.normalizeForCompare(currentParent);
    if (normalizedTarget === normalizedParent) {
      return false;
    }
    return true;
  }, []);

  // Perform the move operation
  const performMove = useCallback(
    async (dragged: { path: string; type: "file" | "directory" }, targetPath: string) => {
      if (!fileOperations) return;

      const fileName = pathSync.basename(dragged.path);
      const newPath = targetPath ? pathSync.join(targetPath, fileName) : fileName;

      // Check if target already exists
      const targetExists = nodeMap.has(newPath);
      if (targetExists) {
        const confirmed = await requestConfirm({
          title: "Confirm Replace",
          message: `A file or folder named "${fileName}" already exists in this location.\nDo you want to replace it?`,
          confirmLabel: "Replace",
          cancelLabel: "Cancel",
        });
        if (!confirmed) return;
      }

      try {
        const draggedNode = nodeMap.get(dragged.path);
        if (draggedNode && onPlanRename) {
          const requestId = ++planRequestIdRef.current;
          setInlineRename({
            node: draggedNode,
            draftName: fileName,
            status: "planning",
            error: null,
            referenceCount: 0,
            pendingNewPath: null,
          });
          const refCount = await onPlanRename(draggedNode, newPath);
          if (planRequestIdRef.current !== requestId) return;
          if (refCount > 0) {
            setInlineRename({
              node: draggedNode,
              draftName: fileName,
              status: "confirm-refs",
              referenceCount: refCount,
              pendingNewPath: newPath,
              error: null,
            });
            return;
          }
          setInlineRename(null);
        }

        if (draggedNode && onApplyRename) {
          await onApplyRename(draggedNode, newPath, { updateReferences: false });
        } else {
          await fileOperations.renamePath(dragged.path, newPath);
        }
      } catch (error) {
        setInlineRename(null);
        console.error("Failed to move:", error);
        alert(`Failed to move "${fileName}": ${error}`);
      }
    },
    [fileOperations, nodeMap, onApplyRename, onPlanRename, requestConfirm],
  );

  // Mouse move handler (attached to document during drag)
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggedNodeRef.current) return;

      const startPos = dragStartPos.current;
      if (startPos && !isDraggingRef.current) {
        // Check if we've moved past threshold to start dragging
        const dx = e.clientX - startPos.x;
        const dy = e.clientY - startPos.y;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        isDraggingRef.current = true;
      }

      // Find what we're hovering over (only log occasionally to avoid spam)
      const target = findDropTarget(e.clientX, e.clientY);
      let dragOverPath: string | null = null;

      if (target && isValidDropTarget(target.path, target.type)) {
        dragOverPath = target.path;
      }

      setDragState((prev) => ({
        ...prev,
        isDragging: true,
        dragOverPath,
        mouseX: e.clientX,
        mouseY: e.clientY,
      }));
    },
    [findDropTarget, isValidDropTarget],
  );

  // Mouse up handler (attached to document during drag)
  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      const dragged = draggedNodeRef.current;
      const wasDragging = isDraggingRef.current;

      // Clean up using refs to avoid stale closure issues
      if (handleMouseMoveRef.current) {
        document.removeEventListener("mousemove", handleMouseMoveRef.current);
        handleMouseMoveRef.current = null;
      }
      if (handleMouseUpRef.current) {
        document.removeEventListener("mouseup", handleMouseUpRef.current);
        handleMouseUpRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      if (!dragged || !wasDragging) {
        draggedNodeRef.current = null;
        dragStartPos.current = null;
        isDraggingRef.current = false;
        setDragState(initialDragState);
        return;
      }

      // Find drop target
      const target = findDropTarget(e.clientX, e.clientY);
      const canDrop = !!(target && isValidDropTarget(target.path, target.type));

      // Snapshot dragged info before clearing refs
      const draggedSnapshot = draggedNodeRef.current;

      // Reset state
      draggedNodeRef.current = null;
      dragStartPos.current = null;
      isDraggingRef.current = false;
      setDragState(initialDragState);

      // Perform move if valid target
      if (target && canDrop && draggedSnapshot) {
        performMove(draggedSnapshot, target.path);
      }
    },
    [findDropTarget, isValidDropTarget, performMove],
  );

  // Mouse down handler (called from NodeRenderer)
  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent, path: string, name: string, type: "file" | "directory") => {
      if (!fileOperations) {
        return;
      }

      // Store drag info
      draggedNodeRef.current = { path, type };
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      isDraggingRef.current = false;

      setDragState({
        isDragging: false,
        draggedPath: path,
        draggedName: name,
        draggedType: type,
        dragOverPath: null,
        mouseX: e.clientX,
        mouseY: e.clientY,
      });

      // Set cursor and prevent text selection
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      // Store current handlers in refs to ensure we remove the exact same functions later
      handleMouseMoveRef.current = handleMouseMove;
      handleMouseUpRef.current = handleMouseUp;

      // Attach document-level listeners
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [fileOperations, handleMouseMove, handleMouseUp],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: FileNode, parentPath: string) => {
      if (!fileOperations) return;

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        node,
        parentPath,
      });
    },
    [fileOperations],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
  }, []);

  // Handle right-click on empty area
  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    // Only show if clicking on the container itself, not on a tree node
    if ((e.target as HTMLElement).closest("[data-path]")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      node: { name: "", path: "", type: "directory" } as FileNode,
      parentPath: "",
    });
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      const tree = treeRef.current;
      if (!tree) return;

      const focusedNode = tree.focusedNode;
      const currentNode = focusedNode ? (nodeMap.get(focusedNode.data.path) ?? null) : null;

      switch (e.key) {
        // F2 - Rename
        case "F2": {
          e.preventDefault();
          if (currentNode && (fileOperations || onApplyRename)) {
            startInlineRename(currentNode);
          }
          break;
        }

        // Delete or Backspace - Delete file/folder
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          if (currentNode && fileOperations) {
            const isDirectory = currentNode.type === "directory";
            const nodePath = currentNode.path;
            const nodeName = currentNode.name;
            const confirmed = await requestConfirm({
              title: "Confirm Delete",
              message: `Are you sure you want to delete "${nodeName}"?${isDirectory ? "\nThis will delete all files inside." : ""}`,
              confirmLabel: "Delete",
              cancelLabel: "Cancel",
            });
            if (confirmed) {
              try {
                await fileOperations.deletePath(nodePath);
              } catch (error) {
                alert(`Failed to delete: ${error}`);
              }
            }
          }
          break;
        }

        // N - New file (Shift+N for new folder)
        case "n":
        case "N": {
          if (!fileOperations) break;
          e.preventDefault();
          const parentPath = currentNode
            ? currentNode.type === "directory"
              ? currentNode.path
              : getParentPath(currentNode.path) || ""
            : "";

          if (e.shiftKey) {
            setDialog({ type: "create-directory", parentPath });
          } else {
            setDialog({ type: "create-file", parentPath });
          }
          break;
        }

        // F5 - Refresh file list
        case "F5": {
          e.preventDefault();
          onRefresh?.();
          break;
        }

        // R - Reveal in Explorer/Finder
        case "r":
        case "R": {
          if (!currentNode || !projectPath) break;
          e.preventDefault();
          const fullPath = pathSync.join(projectPath, currentNode.path);
          revealInFileManager(fullPath).catch(console.error);
          break;
        }
      }
    },
    [
      nodeMap,
      fileOperations,
      onRefresh,
      projectPath,
      requestConfirm,
      onApplyRename,
      startInlineRename,
    ],
  );

  const getContextMenuItems = useCallback(
    (node: FileNode, _parentPath: string): ContextMenuItem[] => {
      const isDirectory = node.type === "directory";
      const items: ContextMenuItem[] = [];

      // --- Create actions (for directories) ---
      if (isDirectory) {
        items.push({
          label: "New file here",
          shortcut: "⌘N",
          onClick: () => setDialog({ type: "create-file", parentPath: node.path }),
        });
        items.push({
          label: "New folder here",
          onClick: () => setDialog({ type: "create-directory", parentPath: node.path }),
        });
      }

      // --- Edit actions ---
      if (fileOperations || onApplyRename) {
        items.push({
          label: "Rename",
          shortcut: "↵",
          dividerBefore: isDirectory,
          onClick: () => startInlineRename(node),
        });
      }

      if (!isDirectory && fileOperations) {
        items.push({
          label: "Duplicate",
          onClick: async () => {
            setDuplicateError(null);
            try {
              const duplicate = await fileOperations.duplicateFile(node.path);
              if (duplicate) onFileSelect?.(duplicate);
            } catch (error) {
              setDuplicateError(error instanceof Error ? error.message : String(error));
            }
          },
        });
      }

      if (projectPath) {
        items.push({
          label: "Copy absolute path",
          onClick: () => copyNormalizedAbsolutePath(pathSync.join(projectPath, node.path)),
        });
      }

      if (!isDirectory && onSetMainFile && node.name.toLowerCase().endsWith(".tex")) {
        items.push({
          label: "Set as main document",
          onClick: () => onSetMainFile(node),
        });
      }

      // --- Path & external actions ---
      items.push({
        label: "Copy path",
        shortcut: "⌥⌘C",
        dividerBefore: true,
        onClick: () => copyToClipboard(node.path),
      });

      if (projectPath) {
        const os = platform();
        const revealLabel =
          os === "macos"
            ? "Reveal in Finder"
            : os === "windows"
              ? "Reveal in Explorer"
              : "Reveal in File Manager";
        items.push({
          label: revealLabel,
          onClick: async () => {
            const fullPath = pathSync.join(projectPath, node.path);
            try {
              await revealInFileManager(fullPath);
            } catch (error) {
              console.error("Failed to reveal in file manager:", error);
            }
          },
        });

        // Open in Terminal (for directories)
        if (isDirectory) {
          items.push({
            label: "Open terminal here",
            onClick: async () => {
              const fullPath = pathSync.join(projectPath, node.path);
              try {
                await openInTerminal(fullPath);
              } catch (error) {
                console.error("Failed to open in terminal:", error);
              }
            },
          });
        }
      }

      if (onAskAgentOpening) {
        items.push({
          label: "Ask an agent about this file",
          voiceColor: VOICE_COLORS[activeProviderId ?? "claude"].ink,
          onClick: () => onAskAgentOpening(node),
        });
      }

      if (onRefresh) {
        items.push({
          label: "Refresh",
          onClick: onRefresh,
        });
      }

      items.push({
        label: "Move to Trash",
        shortcut: "⌘⌫",
        dividerBefore: true,
        onClick: async () => {
          const confirmed = await requestConfirm({
            title: "Confirm Delete",
            message: `Are you sure you want to delete "${node.name}"?${isDirectory ? "\nThis will delete all files inside." : ""}`,
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
          });
          if (confirmed) {
            try {
              await fileOperations?.deletePath(node.path);
            } catch (error) {
              alert(`Failed to delete: ${error}`);
            }
          }
        },
        danger: true,
      });

      return items;
    },
    [
      fileOperations,
      projectPath,
      onRefresh,
      requestConfirm,
      onApplyRename,
      onSetMainFile,
      onAskAgentOpening,
      startInlineRename,
      onFileSelect,
      activeProviderId,
    ],
  );

  // Context menu items for empty area (root level)
  const getRootContextMenuItems = useCallback((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (fileOperations) {
      items.push({
        label: "New File",
        onClick: () => setDialog({ type: "create-file", parentPath: "" }),
        icon: <FilePlusIcon size={16} />,
      });
      items.push({
        label: "New Folder",
        onClick: () => setDialog({ type: "create-directory", parentPath: "" }),
        icon: <FolderPlusIcon size={16} />,
      });
    }

    if (projectPath) {
      items.push({
        label: "Copy Project Path",
        onClick: () => copyNormalizedAbsolutePath(projectPath),
        icon: <ClipboardTextIcon size={16} />,
      });

      const os = platform();
      const revealLabel =
        os === "macos"
          ? "Reveal in Finder"
          : os === "windows"
            ? "Reveal in Explorer"
            : "Reveal in File Manager";
      items.push({
        label: revealLabel,
        onClick: async () => {
          try {
            await revealInFileManager(projectPath);
          } catch (error) {
            console.error("Failed to reveal in file manager:", error);
          }
        },
        icon: <ArrowSquareOutIcon size={16} />,
      });

      items.push({
        label: "Open in Terminal",
        onClick: async () => {
          try {
            await openInTerminal(projectPath);
          } catch (error) {
            console.error("Failed to open in terminal:", error);
          }
        },
        icon: <TerminalWindowIcon size={16} />,
      });
    }

    if (onRefresh) {
      items.push({
        label: "Refresh",
        onClick: onRefresh,
        icon: <ArrowClockwiseIcon size={16} />,
      });
    }

    return items;
  }, [fileOperations, projectPath, onRefresh]);

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

  const handleDialogConfirm = useCallback(
    async (value: string) => {
      if (!dialog || !fileOperations) return;

      try {
        if (dialog.type === "create-file") {
          const newPath = dialog.parentPath ? pathSync.join(dialog.parentPath, value) : value;
          await fileOperations.createFile(newPath);
        } else if (dialog.type === "create-directory") {
          const newPath = dialog.parentPath ? pathSync.join(dialog.parentPath, value) : value;
          await fileOperations.createDirectory(newPath);
        } else if (dialog.type === "rename" && dialog.node) {
          const parentPath = pathSync.dirname(dialog.node.path);
          const newPath = parentPath ? pathSync.join(parentPath, value) : value;
          await fileOperations.renamePath(dialog.node.path, newPath);
        }
        closeDialog();
      } catch (error) {
        alert(`Operation failed: ${error}`);
      }
    },
    [dialog, fileOperations, closeDialog],
  );

  const cancelInlineRename = useCallback(() => {
    planRequestIdRef.current += 1;
    setInlineRename(null);
  }, []);

  const handleInlineRenameChange = useCallback((draftName: string) => {
    setInlineRename((prev) => (prev ? { ...prev, draftName, error: null } : null));
  }, []);

  const applyRename = useCallback(
    async (node: FileNode, newPath: string, updateReferences: boolean) => {
      if (onApplyRename) {
        await onApplyRename(node, newPath, { updateReferences });
      } else if (fileOperations) {
        await fileOperations.renamePath(node.path, newPath);
      }
    },
    [onApplyRename, fileOperations],
  );

  const submitInlineRename = useCallback(async () => {
    if (!inlineRename) return;
    const trimmed = inlineRename.draftName.trim();
    const validationError = validateFileName(trimmed);
    if (validationError) {
      setInlineRename((prev) => (prev ? { ...prev, error: validationError } : null));
      return;
    }

    const parentPath = pathSync.dirname(inlineRename.node.path);
    const newPath = parentPath ? pathSync.join(parentPath, trimmed) : trimmed;
    if (newPath === inlineRename.node.path) {
      cancelInlineRename();
      return;
    }

    const requestId = ++planRequestIdRef.current;
    const targetNode = inlineRename.node;

    if (onPlanRename) {
      setInlineRename((prev) => (prev ? { ...prev, status: "planning", error: null } : null));
      try {
        const refCount = await onPlanRename(targetNode, newPath);
        if (planRequestIdRef.current !== requestId) return;
        if (refCount > 0) {
          setInlineRename((prev) =>
            prev
              ? {
                  ...prev,
                  status: "confirm-refs",
                  referenceCount: refCount,
                  pendingNewPath: newPath,
                  error: null,
                }
              : null,
          );
          return;
        }
      } catch (error) {
        if (planRequestIdRef.current !== requestId) return;
        setInlineRename((prev) =>
          prev
            ? {
                ...prev,
                status: "editing",
                error: error instanceof Error ? error.message : String(error),
              }
            : null,
        );
        return;
      }
    }

    setInlineRename((prev) => (prev ? { ...prev, status: "applying", error: null } : null));
    try {
      await applyRename(targetNode, newPath, false);
      if (planRequestIdRef.current !== requestId) return;
      setInlineRename(null);
    } catch (error) {
      if (planRequestIdRef.current !== requestId) return;
      setInlineRename((prev) =>
        prev
          ? {
              ...prev,
              status: "editing",
              error: error instanceof Error ? error.message : String(error),
            }
          : null,
      );
    }
  }, [inlineRename, validateFileName, cancelInlineRename, onPlanRename, applyRename]);

  const resolveInlineRenameRefs = useCallback(
    async (updateReferences: boolean) => {
      if (!inlineRename?.pendingNewPath) return;
      const targetNode = inlineRename.node;
      const newPath = inlineRename.pendingNewPath;
      const requestId = ++planRequestIdRef.current;
      setInlineRename((prev) => (prev ? { ...prev, status: "applying", error: null } : null));
      try {
        await applyRename(targetNode, newPath, updateReferences);
        if (planRequestIdRef.current !== requestId) return;
        setInlineRename(null);
      } catch (error) {
        if (planRequestIdRef.current !== requestId) return;
        setInlineRename((prev) =>
          prev
            ? {
                ...prev,
                status: "editing",
                pendingNewPath: null,
                referenceCount: 0,
                error: error instanceof Error ? error.message : String(error),
              }
            : null,
        );
      }
    },
    [inlineRename, applyRename],
  );

  useEffect(() => {
    if (inlineRename?.status !== "confirm-refs") return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelInlineRename();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [inlineRename?.status, cancelInlineRename]);

  const getRowHeight = useCallback(
    (node: NodeApi<ArboristFileNode>) => {
      if (inlineRename && node.data.path === inlineRename.node.path) {
        if (inlineRename.error) {
          return 72;
        }
        if (inlineRename.status === "confirm-refs") {
          return 58;
        }
      }
      return 28;
    },
    [inlineRename],
  );

  useEffect(() => {
    void inlineRename;
    const list = (
      treeRef.current as unknown as {
        list?: { current?: { resetAfterIndex?: (index: number) => void } };
      } | null
    )?.list?.current;
    list?.resetAfterIndex?.(0);
  }, [inlineRename]);

  const ctxValue = useMemo<FileTreeContextValue>(
    () => ({
      selectedFile,
      highlightedFile,
      fileVoiceDots,
      mainFile,
      gitStatusByPath,
      errorCountByPath,
      onContextMenu: handleContextMenu,
      onFileSelect,
      dragState,
      onDragMouseDown: fileOperations ? handleDragMouseDown : undefined,
      inlineRename,
      onInlineRenameChange: handleInlineRenameChange,
      onInlineRenameSubmit: submitInlineRename,
      onInlineRenameCancel: cancelInlineRename,
      onInlineRenameResolveRefs: resolveInlineRenameRefs,
    }),
    [
      selectedFile,
      highlightedFile,
      fileVoiceDots,
      mainFile,
      gitStatusByPath,
      errorCountByPath,
      handleContextMenu,
      onFileSelect,
      dragState,
      fileOperations,
      handleDragMouseDown,
      inlineRename,
      handleInlineRenameChange,
      submitInlineRename,
      cancelInlineRename,
      resolveInlineRenameRefs,
    ],
  );

  if (files.length === 0) {
    return <div className={`p-4 text-sm text-muted ${className}`}>No files</div>;
  }

  return (
    <>
      <div
        ref={containerRef}
        className={className}
        role="tree"
        aria-label="File explorer"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={handleRootContextMenu}
      >
        <FileTreeContext.Provider value={ctxValue}>
          {containerSize.width > 0 && containerSize.height > 0 && (
            <Tree<ArboristFileNode>
              ref={treeRef}
              data={arboristData}
              width={containerSize.width}
              height={containerSize.height}
              rowHeight={getRowHeight}
              indent={12}
              openByDefault={true}
              disableDrag={true}
              disableDrop={true}
              disableEdit={true}
              disableMultiSelection={true}
            >
              {NodeRenderer}
            </Tree>
          )}
        </FileTreeContext.Provider>
      </div>

      {duplicateError && (
        <div className="flex shrink-0 items-start gap-1 rounded-md bg-error-bg p-2 text-xs text-error">
          <p className="min-w-0 flex-1 wrap-break-word" role="alert">
            {duplicateError}
          </p>
          <button
            type="button"
            aria-label="Dismiss duplicate error"
            className="rounded p-0.5 hover:bg-subtle"
            onClick={() => setDuplicateError(null)}
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={
            contextMenu.node.path === ""
              ? getRootContextMenuItems()
              : getContextMenuItems(contextMenu.node, contextMenu.parentPath)
          }
          onClose={closeContextMenu}
        />
      )}

      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={() => closeConfirm(true)}
          onCancel={() => closeConfirm(false)}
        />
      )}

      {dialog && (
        <InputDialog
          title={
            dialog.type === "create-file"
              ? "New File"
              : dialog.type === "create-directory"
                ? "New Folder"
                : "Rename"
          }
          placeholder={
            dialog.type === "rename"
              ? dialog.node?.name
              : dialog.type === "create-file"
                ? "file.tex"
                : "folder"
          }
          defaultValue={dialog.type === "rename" ? dialog.node?.name : ""}
          onConfirm={handleDialogConfirm}
          onCancel={closeDialog}
          validator={validateFileName}
        />
      )}

      {/* Drag preview - rendered via portal to avoid stacking context issues */}
      {dragState.isDragging &&
        dragState.draggedName &&
        createPortal(
          <div
            className="fixed pointer-events-none z-[9999] flex items-center gap-2 px-3 py-1.5 bg-background border border-border rounded-md shadow-lg text-sm"
            style={{
              left: dragState.mouseX + 16,
              top: dragState.mouseY + 16,
            }}
          >
            {dragState.draggedType === "directory" ? (
              <FolderIcon className="w-4 h-4 text-gray-600" size={16} />
            ) : (
              <FileIconSymbol className="w-4 h-4 text-gray-600" size={16} />
            )}
            <span className="truncate max-w-[200px]">{dragState.draggedName}</span>
            {dragState.dragOverPath && (
              <span className="text-blue-600 text-xs ml-1">
                → {pathSync.basename(dragState.dragOverPath)}
              </span>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// --- Main component ---

export const FileTree = memo(FileTreeInner);
