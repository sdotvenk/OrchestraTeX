"use client";

import type { GitLogEntry, GitStatus } from "@orchestratex/shared";
import {
  ArrowCounterClockwiseIcon,
  PlusIcon,
  ShieldCheckIcon,
  TagIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { getProviderMeta } from "@/components/agent/orchestration-types";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import type { AgentProviderId } from "@/lib/agent/types";
import {
  type CheckpointAuthorKind,
  type DiffHunk,
  formatCheckpointTime,
  parseCheckpointMessage,
  parseUnifiedDiff,
} from "./history-diff-utils";

export type CheckpointInfo = {
  id: string;
  refName: string;
  commitOid: string;
  treeOid: string;
  message: string;
  createdAt: string;
};

export type CheckpointDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type CheckpointDiffResult = {
  fromId: string;
  toId: string | null;
  diffText: string;
  files: CheckpointDiffFile[];
  workingTree: string;
};

export type RestoreCheckpointResult = {
  restoredId: string;
  safetyCheckpoint: CheckpointInfo;
};

export type LabelInfo = {
  name: string;
  commitOid: string;
  message: string;
  createdAt: string;
};

export type GitChangeItem = {
  path: string;
  status: string;
  staged?: boolean;
};

export type HistoryWorkspaceProps = {
  projectDir: string;
  gitSidebarPanel?: ReactNode;
  commitDiffPanel?: ReactNode;
  gitLogEntries?: GitLogEntry[];
  selectedCommitHash?: string | null;
  onSelectCommit?: (entry: GitLogEntry) => void;
  beforeMutation?: () => void;
  onFilesChanged?: () => void;
  onOpenThread?: (threadId: string) => void;
  gitStatus?: GitStatus | null;
  stagedChanges?: GitChangeItem[];
  unstagedChanges?: GitChangeItem[];
  commitMessage?: string;
  onCommitMessageChange?: (msg: string) => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onCommit?: (message: string) => Promise<void> | void;
  onCommitAndPush?: (message: string) => Promise<void> | void;
  onGenerateCommitMessageAI?: () => Promise<void> | void;
  isGeneratingCommitMessageAI?: boolean;
  onPreviewGitFileDiff?: (path: string, staged: boolean) => void;
  onPublishToGitHub?: () => void;
  isPushing?: boolean;
  fileVoiceByPath?: Record<string, AgentProviderId>;
  className?: string;
};

type SidebarTab = "timeline" | "commits" | "labels";
type DiffMode = "inline" | "split";
type AuthorFilter = "all" | CheckpointAuthorKind;

const AUTHOR_FILTERS: { id: AuthorFilter; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "you", label: "You" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "custom", label: "Custom ACP" },
];

const AUTHOR_DOT_CLASS: Record<CheckpointAuthorKind, string> = {
  you: "bg-foreground",
  claude: "bg-[var(--voice-claude-ink)]",
  codex: "bg-[var(--voice-codex-ink)]",
  antigravity: "bg-[var(--voice-antigravity-ink)]",
  custom: "bg-[var(--voice-custom-ink)]",
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Command failed";
}

function HunkDiffView({
  hunk,
  hunkIndex,
  mode,
  canRevert,
  reverting,
  providerLabel,
  onRevert,
  onAskToRedo,
}: {
  hunk: DiffHunk;
  hunkIndex: number;
  mode: DiffMode;
  canRevert: boolean;
  reverting: boolean;
  providerLabel?: string;
  onRevert: () => void;
  onAskToRedo?: () => void;
}) {
  return (
    <div className="py-1">
      <div className="flex h-5 items-center font-mono text-[12px] text-muted">
        <span className="w-[40px] shrink-0 pr-3 text-right select-none" />
        <span className="truncate">{hunk.header}</span>
      </div>

      {mode === "inline" ? (
        <div className="font-mono text-[12px] leading-5">
          {hunk.lines.map((line) => {
            const rowBg =
              line.type === "add"
                ? "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]"
                : line.type === "del"
                  ? "bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]"
                  : "text-foreground-secondary";
            const prefix = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
            const lineNum =
              line.type === "del" ? line.oldLineNumber : (line.newLineNumber ?? line.oldLineNumber);
            return (
              <div
                key={`${hunk.id}-inline-${line.type}-${line.oldLineNumber ?? "n"}-${line.newLineNumber ?? "n"}`}
                className={`flex min-h-5 leading-5 whitespace-pre-wrap break-words ${rowBg}`}
              >
                <span className="w-[40px] shrink-0 pr-3 text-right select-none opacity-75">
                  {lineNum ?? ""}
                </span>
                <span className="w-4 shrink-0 select-none">{prefix}</span>
                <span className="flex-1 min-w-0 pr-4">{line.content}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 divide-x divide-border font-mono text-[12px] leading-5">
          <div className="min-w-0">
            {hunk.lines
              .filter((l) => l.type !== "add")
              .map((line) => (
                <div
                  key={`${hunk.id}-old-${line.type}-${line.oldLineNumber ?? "n"}`}
                  className={`flex min-h-5 leading-5 whitespace-pre-wrap break-words ${
                    line.type === "del"
                      ? "bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]"
                      : "text-foreground-secondary"
                  }`}
                >
                  <span className="w-[40px] shrink-0 pr-3 text-right select-none opacity-75">
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span className="flex-1 min-w-0 pr-2">{line.content}</span>
                </div>
              ))}
          </div>
          <div className="min-w-0">
            {hunk.lines
              .filter((l) => l.type !== "del")
              .map((line) => (
                <div
                  key={`${hunk.id}-new-${line.type}-${line.newLineNumber ?? "n"}`}
                  className={`flex min-h-5 leading-5 whitespace-pre-wrap break-words ${
                    line.type === "add"
                      ? "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]"
                      : "text-foreground-secondary"
                  }`}
                >
                  <span className="w-[40px] shrink-0 pr-3 text-right select-none opacity-75">
                    {line.newLineNumber ?? ""}
                  </span>
                  <span className="flex-1 min-w-0 pr-2">{line.content}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {(canRevert || onAskToRedo) && (
        <div className="mx-[18px] mt-3 mb-2">
          <div className="h-px bg-border/70" />
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
            {canRevert && (
              <button
                type="button"
                disabled={reverting}
                onClick={onRevert}
                className="btn btn-secondary btn-sm inline-flex items-center gap-1 disabled:opacity-50"
              >
                <ArrowCounterClockwiseIcon className="w-3 h-3" aria-hidden="true" />
                <span>{reverting ? "Reverting…" : `Revert hunk ${hunkIndex + 1}`}</span>
              </button>
            )}
            {onAskToRedo && (
              <button
                type="button"
                onClick={onAskToRedo}
                className="btn btn-secondary btn-sm inline-flex items-center gap-1"
              >
                <span>Ask {providerLabel || "Agent"} to redo…</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function HistoryWorkspace({
  projectDir,
  gitSidebarPanel: _gitSidebarPanel,
  commitDiffPanel,
  gitLogEntries = [],
  selectedCommitHash,
  onSelectCommit,
  beforeMutation,
  onFilesChanged,
  onOpenThread,
  gitStatus,
  stagedChanges = [],
  unstagedChanges = [],
  commitMessage = "",
  onCommitMessageChange,
  onStageFile,
  onUnstageFile,
  onCommit,
  onCommitAndPush,
  onGenerateCommitMessageAI,
  isGeneratingCommitMessageAI = false,
  onPreviewGitFileDiff,
  onPublishToGitHub,
  isPushing = false,
  fileVoiceByPath,
  className = "",
}: HistoryWorkspaceProps) {
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("timeline");
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>("all");
  const [diffMode, setDiffMode] = useState<DiffMode>("inline");

  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [labels, setLabels] = useState<LabelInfo[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);

  const [diffResult, setDiffResult] = useState<CheckpointDiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [revertingHunkId, setRevertingHunkId] = useState<string | null>(null);

  const [savingLabel, setSavingLabel] = useState(false);
  const [creatingCheckpoint, setCreatingCheckpoint] = useState(false);
  const [addAgentTrailers, setAddAgentTrailers] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [quickLabelName, setQuickLabelName] = useState("");

  const loadHistory = useCallback(async () => {
    if (!projectDir) return;
    setLoadingList(true);
    setErrorMsg(null);
    try {
      const [cpList, labelList] = await Promise.all([
        invoke<CheckpointInfo[]>("checkpoint_list", { dir: projectDir }),
        invoke<LabelInfo[]>("checkpoint_list_labels", { dir: projectDir }),
      ]);
      setCheckpoints(cpList);
      setLabels(labelList);
      setSelectedCheckpointId((prev) => {
        if (prev && cpList.some((c) => c.id === prev)) return prev;
        return cpList[0]?.id ?? null;
      });
    } catch (err) {
      setErrorMsg(getErrorMessage(err));
    } finally {
      setLoadingList(false);
    }
  }, [projectDir]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const loadDiff = useCallback(
    async (checkpointId: string) => {
      if (!projectDir) return;
      setLoadingDiff(true);
      setErrorMsg(null);
      try {
        const res = await invoke<CheckpointDiffResult>("checkpoint_diff", {
          dir: projectDir,
          fromId: checkpointId,
          toId: null,
        });
        setDiffResult(res);
        setSelectedFilePath((prev) => {
          if (prev && res.files.some((f) => f.path === prev)) return prev;
          return res.files[0]?.path ?? null;
        });
      } catch (err) {
        setErrorMsg(getErrorMessage(err));
        setDiffResult(null);
      } finally {
        setLoadingDiff(false);
      }
    },
    [projectDir],
  );

  useEffect(() => {
    if (selectedCheckpointId) {
      void loadDiff(selectedCheckpointId);
    } else {
      setDiffResult(null);
      setSelectedFilePath(null);
    }
  }, [selectedCheckpointId, loadDiff]);

  const parsedCheckpoints = useMemo(() => {
    return checkpoints.map((cp) => ({
      checkpoint: cp,
      parsed: parseCheckpointMessage(cp.id, cp.message),
    }));
  }, [checkpoints]);

  const hasCustomCheckpoints = useMemo(
    () => parsedCheckpoints.some((item) => item.parsed.author === "custom"),
    [parsedCheckpoints],
  );

  const visibleAuthorFilters = useMemo(
    () => AUTHOR_FILTERS.filter((f) => f.id !== "custom" || hasCustomCheckpoints),
    [hasCustomCheckpoints],
  );

  const filteredCheckpoints = useMemo(() => {
    if (authorFilter === "all") return parsedCheckpoints;
    return parsedCheckpoints.filter((item) => item.parsed.author === authorFilter);
  }, [parsedCheckpoints, authorFilter]);

  const selectedEntry = useMemo(() => {
    if (!selectedCheckpointId) return null;
    return parsedCheckpoints.find((item) => item.checkpoint.id === selectedCheckpointId) ?? null;
  }, [parsedCheckpoints, selectedCheckpointId]);

  const parsedFiles = useMemo(() => {
    if (!diffResult) return [];
    return parseUnifiedDiff(diffResult.diffText);
  }, [diffResult]);

  const activeParsedFile = useMemo(() => {
    if (!selectedFilePath) return parsedFiles[0] ?? null;
    return parsedFiles.find((f) => f.path === selectedFilePath) ?? parsedFiles[0] ?? null;
  }, [parsedFiles, selectedFilePath]);

  const handleCreateManualCheckpoint = useCallback(async () => {
    if (!projectDir) return;
    setCreatingCheckpoint(true);
    setErrorMsg(null);
    setStatusNotice(null);
    try {
      const created = await invoke<CheckpointInfo>("checkpoint_create", {
        dir: projectDir,
        id: null,
        message: "Manual checkpoint",
      });
      await loadHistory();
      setSelectedCheckpointId(created.id);
      setStatusNotice(`Saved checkpoint ${created.id}`);
    } catch (err) {
      setErrorMsg(getErrorMessage(err));
    } finally {
      setCreatingCheckpoint(false);
    }
  }, [projectDir, loadHistory]);

  const handleConfirmRestore = useCallback(async () => {
    if (!projectDir || !selectedCheckpointId || !diffResult) return;
    setRestoring(true);
    setErrorMsg(null);
    setStatusNotice(null);
    try {
      beforeMutation?.();
      const result = await invoke<RestoreCheckpointResult>("checkpoint_restore", {
        dir: projectDir,
        id: selectedCheckpointId,
        expectedWorkingTree: diffResult.workingTree,
      });
      onFilesChanged?.();
      setRestoreConfirmOpen(false);
      await loadHistory();
      await loadDiff(selectedCheckpointId);
      setStatusNotice(
        `Restored ${result.restoredId}. Safety checkpoint: ${result.safetyCheckpoint.id}`,
      );
    } catch (err) {
      setRestoreConfirmOpen(false);
      setErrorMsg(getErrorMessage(err));
    } finally {
      setRestoring(false);
    }
  }, [
    projectDir,
    selectedCheckpointId,
    diffResult,
    loadHistory,
    loadDiff,
    beforeMutation,
    onFilesChanged,
  ]);

  const handleRevertHunk = useCallback(
    async (hunk: DiffHunk) => {
      if (!projectDir || !selectedCheckpointId || !diffResult || diffResult.toId !== null) {
        return;
      }
      setRevertingHunkId(hunk.id);
      setErrorMsg(null);
      setStatusNotice(null);
      try {
        beforeMutation?.();
        await invoke("checkpoint_reverse_hunk", {
          dir: projectDir,
          patch: hunk.rawPatch,
        });
        onFilesChanged?.();
        await loadDiff(selectedCheckpointId);
        setStatusNotice("Reverted hunk in working tree");
      } catch (err) {
        setErrorMsg(getErrorMessage(err));
      } finally {
        setRevertingHunkId(null);
      }
    },
    [projectDir, selectedCheckpointId, diffResult, loadDiff, beforeMutation, onFilesChanged],
  );

  const handleDeleteLabel = useCallback(
    async (name: string) => {
      if (!projectDir) return;
      setErrorMsg(null);
      setStatusNotice(null);
      try {
        await invoke("checkpoint_delete_label", { dir: projectDir, name });
        await loadHistory();
        setStatusNotice(`Deleted label ${name}`);
      } catch (err) {
        setErrorMsg(getErrorMessage(err));
      }
    },
    [projectDir, loadHistory],
  );

  const handleQuickLabelSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const targetId = selectedCheckpointId ?? checkpoints[0]?.id;
      if (!projectDir || !targetId || !quickLabelName.trim()) return;
      setSavingLabel(true);
      setErrorMsg(null);
      setStatusNotice(null);
      try {
        const created = await invoke<LabelInfo>("checkpoint_create_label", {
          dir: projectDir,
          name: quickLabelName.trim(),
          checkpointId: targetId,
          message: null,
        });
        setQuickLabelName("");
        await loadHistory();
        setStatusNotice(`Created label ${created.name}`);
      } catch (err) {
        setErrorMsg(getErrorMessage(err));
      } finally {
        setSavingLabel(false);
      }
    },
    [projectDir, selectedCheckpointId, checkpoints, quickLabelName, loadHistory],
  );

  const buildFinalCommitMessage = useCallback(() => {
    const trimmed = commitMessage.trim();
    if (!addAgentTrailers || stagedChanges.length === 0 || !fileVoiceByPath) {
      return trimmed;
    }
    const providers = new Set<AgentProviderId>();
    for (const file of stagedChanges) {
      const p = fileVoiceByPath[file.path];
      if (p) providers.add(p);
    }
    if (providers.size === 0) return trimmed;
    const labels = Array.from(providers).map((p) => getProviderMeta(p).label);
    const trailer = `Co-authored with ${labels.join(" and ")} threads.`;
    if (trimmed.includes(trailer)) return trimmed;
    return trimmed ? `${trimmed}\n\n${trailer}` : trailer;
  }, [commitMessage, addAgentTrailers, stagedChanges, fileVoiceByPath]);

  const handleCommitAction = useCallback(
    async (andPush: boolean) => {
      const finalMsg = buildFinalCommitMessage();
      if (!finalMsg || stagedChanges.length === 0) return;
      setCommitting(true);
      try {
        if (andPush && onCommitAndPush) {
          await onCommitAndPush(finalMsg);
        } else if (onCommit) {
          await onCommit(finalMsg);
        }
      } finally {
        setCommitting(false);
      }
    },
    [buildFinalCommitMessage, stagedChanges.length, onCommit, onCommitAndPush],
  );

  const [localSelectedCommitHash, setLocalSelectedCommitHash] = useState<string | null>(null);
  const activeCommitHash =
    selectedCommitHash !== undefined ? selectedCommitHash : localSelectedCommitHash;

  const totalGitChanges = useMemo(() => {
    const unique = new Set<string>();
    for (const c of stagedChanges) unique.add(c.path);
    for (const c of unstagedChanges) unique.add(c.path);
    return unique.size;
  }, [stagedChanges, unstagedChanges]);
  const rawRemote = gitStatus?.remote?.trim() ?? "";
  const isRemoteUrl =
    rawRemote.includes("://") || rawRemote.includes("@") || rawRemote.includes("/");
  const shortRemote = isRemoteUrl
    ? rawRemote
        .replace(/^https?:\/\//, "")
        .replace(/^git@([^:]+):/, "$1/")
        .replace(/\.git$/, "")
    : rawRemote;
  const remoteDisplay = !shortRemote ? null : isRemoteUrl ? `origin · ${shortRemote}` : shortRemote;

  return (
    <div className={`flex h-full min-h-0 gap-2 bg-bg p-2 text-foreground ${className}`}>
      {/* Left column: Timeline / Commits / Labels directly on bg-bg */}
      <aside
        aria-label="Project history"
        className="w-[300px] shrink-0 flex flex-col gap-1.5 min-h-0"
      >
        <div className="flex bg-sunken rounded-[9px] p-[3px] gap-0.5 text-[12.5px]">
          {(["timeline", "commits", "labels"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setSidebarTab(tab)}
              className={`flex-1 py-1 rounded-[7px] capitalize transition-colors ${
                sidebarTab === tab
                  ? "bg-panel text-foreground font-medium shadow-xs ring-1 ring-border"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {sidebarTab === "timeline" && (
          <>
            <div className="flex flex-wrap items-center gap-1 px-0.5 py-0.5 text-[11.5px]">
              {visibleAuthorFilters.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setAuthorFilter(filter.id)}
                  className={`px-2 py-0.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                    authorFilter === filter.id
                      ? "bg-foreground text-background border-foreground"
                      : "bg-transparent text-foreground-secondary border-border-dark hover:bg-subtle"
                  }`}
                >
                  {filter.id !== "all" && (
                    <span
                      className={`w-[7px] h-[7px] rounded-full ${AUTHOR_DOT_CLASS[filter.id]}`}
                      aria-hidden="true"
                    />
                  )}
                  <span>{filter.label}</span>
                </button>
              ))}
              <button
                type="button"
                disabled={creatingCheckpoint}
                onClick={() => void handleCreateManualCheckpoint()}
                className="ml-auto btn btn-secondary btn-sm px-2 py-0.5 text-[11px] flex items-center gap-1 disabled:opacity-50"
                title="Create manual checkpoint"
              >
                <PlusIcon className="w-3 h-3" aria-hidden="true" />
                <span>Checkpoint</span>
              </button>
            </div>

            <ScrollArea className="flex-1 min-h-0">
              {loadingList ? (
                <div className="flex items-center justify-center py-8 text-muted">
                  <Spinner className="w-4 h-4" />
                </div>
              ) : filteredCheckpoints.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted">
                  No checkpoints found.
                </div>
              ) : (
                <div className="space-y-0.5 pr-1">
                  <div className="ox-sec px-2.5 py-1.5">Checkpoints</div>
                  {filteredCheckpoints.map(({ checkpoint, parsed }) => {
                    const isSelected = checkpoint.id === selectedCheckpointId;
                    return (
                      <button
                        key={checkpoint.id}
                        type="button"
                        onClick={() => setSelectedCheckpointId(checkpoint.id)}
                        className={`w-full text-left px-2.5 py-2 rounded-[8px] transition-colors flex items-start gap-2.5 ${
                          isSelected
                            ? "bg-panel ring-1 ring-border shadow-xs"
                            : "bg-transparent hover:bg-subtle"
                        }`}
                      >
                        <span className="w-[38px] shrink-0 whitespace-nowrap text-[11px] font-mono text-muted pt-0.5 tabular-nums">
                          {formatCheckpointTime(checkpoint.createdAt)}
                        </span>
                        {parsed.kind === "safety" ? (
                          <ShieldCheckIcon
                            className="w-3.5 h-3.5 text-warn shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <span
                            className={`w-[7px] h-[7px] rounded-full shrink-0 mt-1.5 ${AUTHOR_DOT_CLASS[parsed.author]}`}
                            aria-hidden="true"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-medium text-foreground truncate">
                            {parsed.authorLabel} · {parsed.title}
                          </div>
                          <div className="text-[11.5px] font-mono text-muted truncate mt-0.5">
                            {checkpoint.commitOid.slice(0, 7)}
                            {parsed.phase ? ` · ${parsed.phase}` : ""}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </>
        )}

        {sidebarTab === "commits" && (
          <ScrollArea className="flex-1 min-h-0">
            {gitLogEntries.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted">No commits yet.</div>
            ) : (
              <div className="space-y-0.5 pr-1">
                <div className="ox-sec px-2.5 py-1.5">Committed</div>
                {gitLogEntries.map((entry) => {
                  const isSelected = entry.hash === activeCommitHash;
                  return (
                    <button
                      key={entry.hash}
                      type="button"
                      onClick={() => {
                        setLocalSelectedCommitHash(entry.hash);
                        onSelectCommit?.(entry);
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-[8px] transition-colors flex items-start gap-2.5 ${
                        isSelected
                          ? "bg-panel ring-1 ring-border shadow-xs"
                          : "bg-transparent hover:bg-subtle"
                      }`}
                    >
                      <span className="w-[38px] shrink-0 whitespace-nowrap text-[11px] font-mono text-muted pt-0.5 tabular-nums">
                        {formatCheckpointTime(entry.date)}
                      </span>
                      <span
                        className="w-[7px] h-[7px] rounded-full shrink-0 mt-1.5 bg-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium text-foreground truncate">
                          {entry.message}
                        </div>
                        <div className="text-[11.5px] font-mono text-muted truncate mt-0.5">
                          {entry.shortHash} · {entry.author}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        )}

        {sidebarTab === "labels" && (
          <ScrollArea className="flex-1 min-h-0">
            {labels.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted">No labels yet.</div>
            ) : (
              <div className="space-y-1 pr-1">
                {labels.map((label) => (
                  <div
                    key={label.name}
                    className="flex items-start justify-between gap-2 px-2.5 py-2 rounded-[8px] bg-panel ring-1 ring-border shadow-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <TagIcon className="w-3.5 h-3.5 text-warn shrink-0" aria-hidden="true" />
                        <span className="truncate">{label.name}</span>
                      </div>
                      <div className="text-[11px] font-mono text-muted truncate mt-0.5">
                        {label.commitOid.slice(0, 7)} · {label.message}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteLabel(label.name)}
                      className="btn-ghost p-1 rounded text-muted hover:text-error"
                      aria-label={`Delete label ${label.name}`}
                    >
                      <TrashIcon className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </aside>

      {/* Center Diff Sheet */}
      {sidebarTab === "commits" && commitDiffPanel ? (
        commitDiffPanel
      ) : (
        <section
          aria-label="Change detail"
          className="flex-1 min-w-0 ox-frame flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="px-[18px] py-3 border-b border-border flex flex-wrap items-center gap-2.5 bg-panel">
            <div className="flex items-center gap-2.5 min-w-0">
              {selectedEntry ? (
                <>
                  <span
                    className={`w-[9px] h-[9px] rounded-full shrink-0 ${AUTHOR_DOT_CLASS[selectedEntry.parsed.author]}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-foreground truncate">
                      {selectedEntry.parsed.authorLabel} · {selectedEntry.parsed.title}
                    </div>
                    <div className="text-[12px] text-muted font-mono truncate">
                      {formatCheckpointTime(selectedEntry.checkpoint.createdAt)} ·{" "}
                      {selectedEntry.checkpoint.commitOid.slice(0, 7)}
                    </div>
                  </div>
                </>
              ) : (
                <span className="text-sm text-muted">Select a checkpoint</span>
              )}
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              {selectedEntry?.parsed.threadId && onOpenThread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(selectedEntry.parsed.threadId ?? "")}
                  className="btn btn-secondary btn-sm"
                >
                  Open thread
                </button>
              )}

              {selectedCheckpointId && (
                <button
                  type="button"
                  disabled={!diffResult || restoring}
                  onClick={() => setRestoreConfirmOpen(true)}
                  className="btn btn-secondary btn-sm disabled:opacity-50"
                >
                  Restore before this
                </button>
              )}

              <div className="flex bg-sunken rounded-[7px] p-0.5">
                <button
                  type="button"
                  onClick={() => setDiffMode("split")}
                  className={`px-2.5 py-0.5 text-[12px] rounded-[5px] transition-colors ${
                    diffMode === "split"
                      ? "bg-panel text-foreground font-medium shadow-xs ring-1 ring-border"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => setDiffMode("inline")}
                  className={`px-2.5 py-0.5 text-[12px] rounded-[5px] transition-colors ${
                    diffMode === "inline"
                      ? "bg-panel text-foreground font-medium shadow-xs ring-1 ring-border"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  Inline
                </button>
              </div>
            </div>
          </div>

          {/* Inline anomaly / status banners */}
          {errorMsg && (
            <div className="px-[18px] py-2 border-b border-error/30 bg-error-bg text-error text-xs flex items-center gap-2">
              <WarningCircleIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{errorMsg}</span>
              <button type="button" onClick={() => setErrorMsg(null)} className="text-xs underline">
                Dismiss
              </button>
            </div>
          )}

          {statusNotice && !errorMsg && (
            <div className="px-[18px] py-1.5 border-b border-border bg-subtle text-foreground-secondary text-xs flex items-center justify-between gap-2">
              <span>{statusNotice}</span>
              <button
                type="button"
                onClick={() => setStatusNotice(null)}
                className="text-xs text-muted hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* File header strip + Full-bleed diff body */}
          {loadingDiff ? (
            <div className="flex-1 flex items-center justify-center text-muted">
              <Spinner className="w-5 h-5" />
            </div>
          ) : !diffResult || diffResult.files.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-muted">
              No differences between this checkpoint and the working tree.
            </div>
          ) : (
            <>
              <div className="h-[34px] px-[18px] bg-[var(--tab-strip-bg)] border-b border-border flex items-center gap-2 text-[12px] shrink-0 overflow-x-auto">
                {diffResult.files.length === 1 ? (
                  <>
                    <span className="font-mono font-medium text-foreground">
                      {activeParsedFile?.path ?? diffResult.files[0]?.path}
                    </span>
                    <span className="font-mono text-muted">
                      <span className="text-success">+{diffResult.files[0]?.additions ?? 0}</span>{" "}
                      <span className="text-error">−{diffResult.files[0]?.deletions ?? 0}</span>
                    </span>
                  </>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {diffResult.files.map((file) => {
                      const active = activeParsedFile?.path === file.path;
                      return (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => setSelectedFilePath(file.path)}
                          className={`px-2 py-0.5 rounded-[5px] font-mono text-[11.5px] flex items-center gap-1.5 transition-colors ${
                            active
                              ? "bg-panel text-foreground font-medium ring-1 ring-border shadow-xs"
                              : "text-muted hover:text-foreground hover:bg-subtle"
                          }`}
                        >
                          <span>{file.path}</span>
                          <span className="text-[10.5px]">
                            <span className="text-success">+{file.additions}</span>{" "}
                            <span className="text-error">−{file.deletions}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <span className="ml-auto shrink-0 text-muted">
                  {(() => {
                    const count = activeParsedFile ? activeParsedFile.hunks.length : 0;
                    return `${count} ${count === 1 ? "hunk" : "hunks"}`;
                  })()}
                </span>
              </div>

              <ScrollArea className="flex-1 min-w-0">
                <div className="py-2">
                  {activeParsedFile && activeParsedFile.hunks.length > 0 ? (
                    activeParsedFile.hunks.map((hunk, idx) => (
                      <HunkDiffView
                        key={hunk.id}
                        hunk={hunk}
                        hunkIndex={idx}
                        mode={diffMode}
                        canRevert={diffResult.toId === null}
                        reverting={revertingHunkId === hunk.id}
                        providerLabel={selectedEntry?.parsed.authorLabel}
                        onRevert={() => void handleRevertHunk(hunk)}
                        onAskToRedo={
                          selectedEntry?.parsed.threadId && onOpenThread
                            ? () => onOpenThread(selectedEntry.parsed.threadId ?? "")
                            : undefined
                        }
                      />
                    ))
                  ) : (
                    <div className="px-[18px] py-6 text-xs text-muted">
                      No textual hunks available for this file.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </section>
      )}

      {/* Right Column: Changes, Commit message, Label this version, Remote strip */}
      <aside aria-label="Commit" className="w-[320px] shrink-0 flex flex-col gap-2 min-h-0">
        {/* Card 1: Changes */}
        <div className="ox-frame p-3 flex flex-col gap-1.5 max-h-[240px] overflow-y-auto">
          <div className="flex items-center">
            <span className="font-semibold text-[13px]">Changes</span>
            <span className="ml-auto font-mono text-[11.5px] text-muted">
              {totalGitChanges} {totalGitChanges === 1 ? "file" : "files"}
            </span>
          </div>

          {totalGitChanges === 0 ? (
            <div className="py-2 text-[12px] text-muted">Working tree clean</div>
          ) : (
            <>
              {stagedChanges.length > 0 && (
                <>
                  <div className="ox-sec mt-1">Staged</div>
                  {stagedChanges.map((file) => {
                    const voiceProvider = fileVoiceByPath?.[file.path];
                    return (
                      <div
                        key={`staged-${file.path}`}
                        className="flex items-center gap-2 h-[26px] px-2 rounded-[6px] font-mono text-[12px] hover:bg-subtle"
                      >
                        <input
                          type="checkbox"
                          checked
                          aria-label={`Unstage ${file.path}`}
                          onChange={() => onUnstageFile?.(file.path)}
                          className="m-0 accent-foreground shrink-0"
                        />
                        {voiceProvider && (
                          <span
                            aria-hidden="true"
                            className="w-[7px] h-[7px] rounded-full shrink-0"
                            style={{ backgroundColor: getProviderMeta(voiceProvider).colorVar }}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setLocalSelectedCommitHash(null);
                            setSidebarTab("commits");
                            onPreviewGitFileDiff?.(file.path, true);
                          }}
                          className="truncate text-left flex-1 hover:underline"
                          title={file.path}
                        >
                          {file.path}
                        </button>
                        <span className="ml-auto shrink-0 text-[11px] text-muted">
                          {file.status === "conflict"
                            ? "!"
                            : (file.status[0]?.toUpperCase() ?? "M")}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}

              {unstagedChanges.length > 0 && (
                <>
                  <div className="ox-sec mt-1">Unstaged</div>
                  {unstagedChanges.map((file) => {
                    const voiceProvider = fileVoiceByPath?.[file.path];
                    return (
                      <div
                        key={`unstaged-${file.path}`}
                        className="flex items-center gap-2 h-[26px] px-2 rounded-[6px] font-mono text-[12px] hover:bg-subtle"
                      >
                        <input
                          type="checkbox"
                          checked={false}
                          aria-label={`Stage ${file.path}`}
                          onChange={() => onStageFile?.(file.path)}
                          className="m-0 accent-foreground shrink-0"
                        />
                        {voiceProvider && (
                          <span
                            aria-hidden="true"
                            className="w-[7px] h-[7px] rounded-full shrink-0"
                            style={{ backgroundColor: getProviderMeta(voiceProvider).colorVar }}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setLocalSelectedCommitHash(null);
                            setSidebarTab("commits");
                            onPreviewGitFileDiff?.(file.path, false);
                          }}
                          className="truncate text-left flex-1 hover:underline"
                          title={file.path}
                        >
                          {file.path}
                        </button>
                        <span className="ml-auto shrink-0 text-[11px] text-muted">
                          {file.status === "conflict"
                            ? "!"
                            : (file.status[0]?.toUpperCase() ?? "M")}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>

        {/* Card 2: Commit message */}
        <div className="ox-frame p-3 flex flex-col gap-2">
          <div className="flex items-center">
            <label htmlFor="history-commit-msg" className="font-semibold text-[13px]">
              Commit message
            </label>
            {onGenerateCommitMessageAI && (
              <button
                type="button"
                disabled={isGeneratingCommitMessageAI || totalGitChanges === 0}
                onClick={() => void onGenerateCommitMessageAI()}
                className="ml-auto btn btn-secondary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="w-[7px] h-[7px] rounded-full bg-[var(--voice-claude-ink)]"
                />
                <span>{isGeneratingCommitMessageAI ? "Generating…" : "Generate"}</span>
              </button>
            )}
          </div>
          <textarea
            id="history-commit-msg"
            value={commitMessage}
            onChange={(e) => onCommitMessageChange?.(e.target.value)}
            placeholder="Describe your changes…"
            className="h-[84px] rounded-[8px] border border-border-dark bg-background p-2 text-[12.5px] leading-relaxed resize-none text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addAgentTrailers}
              onChange={(e) => setAddAgentTrailers(e.target.checked)}
              className="m-0 accent-foreground"
            />
            <span>Add agent trailers for staged threads</span>
          </label>
          <div className="flex gap-1.5 mt-0.5">
            <button
              type="button"
              disabled={
                committing || stagedChanges.length === 0 || !commitMessage.trim() || !onCommit
              }
              onClick={() => void handleCommitAction(false)}
              className="btn btn-primary flex-1 disabled:opacity-50"
            >
              {committing
                ? "Committing…"
                : `Commit ${stagedChanges.length} ${stagedChanges.length === 1 ? "file" : "files"}`}
            </button>
            <button
              type="button"
              disabled={
                committing ||
                isPushing ||
                !gitStatus?.remote ||
                stagedChanges.length === 0 ||
                !commitMessage.trim() ||
                !onCommitAndPush
              }
              onClick={() => void handleCommitAction(true)}
              className="btn btn-secondary disabled:opacity-50"
            >
              {isPushing ? "Pushing…" : "& Push"}
            </button>
          </div>
        </div>

        {/* Card 3: Label this version */}
        <form
          onSubmit={(e) => void handleQuickLabelSubmit(e)}
          className="ox-frame p-3 flex flex-col gap-2"
        >
          <div className="font-semibold text-[13px]">Label this version</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={quickLabelName}
              onChange={(e) => setQuickLabelName(e.target.value)}
              placeholder='e.g. "Submitted to PRL"'
              className="flex-1 min-w-0 rounded-[8px] border border-border-dark bg-background px-2.5 py-1 text-[12.5px] text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={savingLabel || !quickLabelName.trim() || checkpoints.length === 0}
              className="btn btn-secondary btn-sm disabled:opacity-50"
            >
              {savingLabel ? "…" : "Add"}
            </button>
          </div>
        </form>

        {/* Bottom Dashed Remote Strip */}
        {remoteDisplay ? (
          <div className="mt-auto flex items-center gap-2 px-2.5 py-2 rounded-[10px] border border-dashed border-border-dark text-[12px] text-muted">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
              <path
                d="M8 1.5a6.5 6.5 0 0 0-2 12.7c.3 0 .4-.2.4-.4v-1.3c-1.8.4-2.2-.8-2.2-.8-.3-.8-.7-1-.7-1-.6-.4 0-.4 0-.4.7 0 1 .7 1 .7.6 1 1.5.7 1.9.5 0-.4.2-.7.4-.9-1.4-.2-3-.7-3-3.2 0-.7.3-1.3.7-1.7-.1-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 0 1 3.2 0c1.2-.9 1.8-.7 1.8-.7.4.9.1 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-3 3.2.2.2.5.6.5 1.2v1.8c0 .2.1.4.4.4A6.5 6.5 0 0 0 8 1.5z"
                fill="currentColor"
              />
            </svg>
            <span className="truncate">{remoteDisplay}</span>
            <span className="ml-auto font-mono shrink-0">
              ↑{gitStatus?.ahead ?? 0} ↓{gitStatus?.behind ?? 0}
            </span>
          </div>
        ) : (
          onPublishToGitHub && (
            <button
              type="button"
              onClick={onPublishToGitHub}
              className="mt-auto flex items-center justify-center gap-2 px-2.5 py-2 rounded-[10px] border border-dashed border-border-dark text-[12px] text-muted hover:text-foreground hover:bg-subtle transition-colors"
            >
              Publish to GitHub…
            </button>
          )
        )}
      </aside>

      {restoreConfirmOpen && (
        <ConfirmDialog
          title="Restore checkpoint"
          message={`Restore working tree to ${selectedCheckpointId ?? "checkpoint"}? A safety checkpoint of your current state will be created first.`}
          confirmLabel={restoring ? "Restoring..." : "Restore"}
          onConfirm={() => void handleConfirmRestore()}
          onCancel={() => setRestoreConfirmOpen(false)}
        />
      )}
    </div>
  );
}
