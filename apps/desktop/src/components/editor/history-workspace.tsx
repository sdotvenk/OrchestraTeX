"use client";

import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  ColumnsIcon,
  GitCommitIcon,
  PlusIcon,
  RowsIcon,
  ShieldCheckIcon,
  TagIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
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

export type HistoryWorkspaceProps = {
  projectDir: string;
  gitSidebarPanel?: ReactNode;
  commitDiffPanel?: ReactNode;
  beforeMutation?: () => void;
  onFilesChanged?: () => void;
  onOpenThread?: (threadId: string) => void;
  className?: string;
};

type SidebarTab = "timeline" | "commits" | "labels";
type DiffMode = "inline" | "split";
type AuthorFilter = "all" | CheckpointAuthorKind;

const AUTHOR_FILTERS: { id: AuthorFilter; label: string }[] = [
  { id: "all", label: "All" },
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
  mode,
  canRevert,
  reverting,
  onRevert,
}: {
  hunk: DiffHunk;
  mode: DiffMode;
  canRevert: boolean;
  reverting: boolean;
  onRevert: () => void;
}) {
  return (
    <div className="border border-border rounded-md overflow-hidden bg-background">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-tertiary border-b border-border">
        <span className="text-[11px] font-mono text-muted truncate">{hunk.header}</span>
        {canRevert && (
          <button
            type="button"
            disabled={reverting}
            onClick={onRevert}
            className="btn-secondary px-2 py-0.5 text-[11px] rounded flex items-center gap-1 flex-shrink-0 disabled:opacity-50"
          >
            <ArrowCounterClockwiseIcon className="w-3 h-3" aria-hidden="true" />
            <span>{reverting ? "Reverting..." : "Revert hunk"}</span>
          </button>
        )}
      </div>

      {mode === "inline" ? (
        <div className="font-mono text-xs leading-5 overflow-x-auto">
          {hunk.lines.map((line) => {
            const rowBg =
              line.type === "add"
                ? "bg-success/10 text-foreground"
                : line.type === "del"
                  ? "bg-destructive/10 text-foreground"
                  : "text-foreground-secondary";
            const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
            return (
              <div
                key={`${hunk.id}-inline-${line.type}-${line.oldLineNumber ?? "n"}-${line.newLineNumber ?? "n"}`}
                className={`flex px-2 ${rowBg}`}
              >
                <span className="w-9 flex-shrink-0 text-right pr-2 text-muted select-none text-[11px]">
                  {line.oldLineNumber ?? ""}
                </span>
                <span className="w-9 flex-shrink-0 text-right pr-2 text-muted select-none text-[11px]">
                  {line.newLineNumber ?? ""}
                </span>
                <span className="w-4 flex-shrink-0 select-none text-muted">{prefix}</span>
                <span className="whitespace-pre flex-1">{line.content}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 divide-x divide-border font-mono text-xs leading-5 overflow-x-auto">
          <div>
            {hunk.lines
              .filter((l) => l.type !== "add")
              .map((line) => (
                <div
                  key={`${hunk.id}-old-${line.type}-${line.oldLineNumber ?? "n"}`}
                  className={`flex px-2 ${
                    line.type === "del"
                      ? "bg-destructive/10 text-foreground"
                      : "text-foreground-secondary"
                  }`}
                >
                  <span className="w-8 flex-shrink-0 text-right pr-2 text-muted select-none text-[11px]">
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span className="whitespace-pre flex-1">{line.content}</span>
                </div>
              ))}
          </div>
          <div>
            {hunk.lines
              .filter((l) => l.type !== "del")
              .map((line) => (
                <div
                  key={`${hunk.id}-new-${line.type}-${line.newLineNumber ?? "n"}`}
                  className={`flex px-2 ${
                    line.type === "add"
                      ? "bg-success/10 text-foreground"
                      : "text-foreground-secondary"
                  }`}
                >
                  <span className="w-8 flex-shrink-0 text-right pr-2 text-muted select-none text-[11px]">
                    {line.newLineNumber ?? ""}
                  </span>
                  <span className="whitespace-pre flex-1">{line.content}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function HistoryWorkspace({
  projectDir,
  gitSidebarPanel,
  commitDiffPanel,
  beforeMutation,
  onFilesChanged,
  onOpenThread,
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

  const [showLabelForm, setShowLabelForm] = useState(false);
  const [labelName, setLabelName] = useState("");
  const [labelMessage, setLabelMessage] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [creatingCheckpoint, setCreatingCheckpoint] = useState(false);

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

  const handleCreateLabel = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!projectDir || !selectedCheckpointId || !labelName.trim()) return;
      setSavingLabel(true);
      setErrorMsg(null);
      setStatusNotice(null);
      try {
        const created = await invoke<LabelInfo>("checkpoint_create_label", {
          dir: projectDir,
          name: labelName.trim(),
          checkpointId: selectedCheckpointId,
          message: labelMessage.trim() || null,
        });
        setLabelName("");
        setLabelMessage("");
        setShowLabelForm(false);
        await loadHistory();
        setStatusNotice(`Created label ${created.name}`);
      } catch (err) {
        setErrorMsg(getErrorMessage(err));
      } finally {
        setSavingLabel(false);
      }
    },
    [projectDir, selectedCheckpointId, labelName, labelMessage, loadHistory],
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

  return (
    <div className={`flex h-full min-h-0 gap-3 bg-background text-foreground ${className}`}>
      {/* Left sidebar: Timeline / Commits / Labels */}
      <aside
        aria-label="Project history"
        className="w-80 flex-shrink-0 flex flex-col min-h-0 border border-border rounded-lg bg-panel overflow-hidden"
      >
        <div className="p-2 border-b border-border flex items-center gap-1 bg-surface-tertiary">
          {(["timeline", "commits", "labels"] as const)
            .filter((tab) => tab !== "commits" || gitSidebarPanel != null)
            .map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setSidebarTab(tab)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                  sidebarTab === tab
                    ? "bg-background text-foreground shadow-sm border border-border"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {tab}
              </button>
            ))}
        </div>

        {sidebarTab === "timeline" && (
          <>
            <div className="px-2.5 py-2 border-b border-border flex flex-wrap items-center gap-1">
              {AUTHOR_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setAuthorFilter(filter.id)}
                  className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors flex items-center gap-1.5 ${
                    authorFilter === filter.id
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-foreground-secondary border-border hover:bg-accent-hover"
                  }`}
                >
                  {filter.id !== "all" && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${AUTHOR_DOT_CLASS[filter.id]}`}
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
                className="ml-auto btn-secondary px-2 py-0.5 text-[11px] rounded flex items-center gap-1 disabled:opacity-50"
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
                <div className="p-2 space-y-1">
                  {filteredCheckpoints.map(({ checkpoint, parsed }) => {
                    const isSelected = checkpoint.id === selectedCheckpointId;
                    return (
                      <button
                        key={checkpoint.id}
                        type="button"
                        onClick={() => setSelectedCheckpointId(checkpoint.id)}
                        className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors flex items-start gap-2 ${
                          isSelected
                            ? "bg-background border-border shadow-sm"
                            : "bg-transparent border-transparent hover:bg-accent-hover"
                        }`}
                      >
                        <span className="text-[11px] font-mono text-muted w-11 flex-shrink-0 pt-0.5">
                          {formatCheckpointTime(checkpoint.createdAt)}
                        </span>
                        {parsed.kind === "safety" ? (
                          <ShieldCheckIcon
                            className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${AUTHOR_DOT_CLASS[parsed.author]}`}
                            aria-hidden="true"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-foreground truncate">
                            {parsed.authorLabel} · {parsed.title}
                          </div>
                          <div className="text-[11px] font-mono text-muted truncate mt-0.5">
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
          <div className="flex-1 min-h-0 flex flex-col">
            {gitSidebarPanel ?? (
              <div className="p-4 text-xs text-muted flex items-center gap-2">
                <GitCommitIcon className="w-4 h-4" aria-hidden="true" />
                <span>Git commit panel not connected.</span>
              </div>
            )}
          </div>
        )}

        {sidebarTab === "labels" && (
          <ScrollArea className="flex-1 min-h-0">
            {labels.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted">No labels yet.</div>
            ) : (
              <div className="p-2 space-y-1">
                {labels.map((label) => (
                  <div
                    key={label.name}
                    className="flex items-start justify-between gap-2 px-2.5 py-2 rounded-md border border-border bg-background"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <TagIcon
                          className="w-3.5 h-3.5 text-warning flex-shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">{label.name}</span>
                      </div>
                      <div className="text-[11px] font-mono text-muted truncate mt-0.5">
                        {label.commitOid.slice(0, 7)} · {label.message}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteLabel(label.name)}
                      className="btn-ghost p-1 rounded text-muted hover:text-destructive"
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

      {/* Main diff & action detail */}
      {sidebarTab === "commits" && commitDiffPanel ? (
        commitDiffPanel
      ) : (
        <section
          aria-label="Change detail"
          className="flex-1 min-w-0 flex flex-col min-h-0 border border-border rounded-lg bg-panel overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center justify-between gap-2 bg-background">
            <div className="flex items-center gap-2 min-w-0">
              {selectedEntry ? (
                <>
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${AUTHOR_DOT_CLASS[selectedEntry.parsed.author]}`}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {selectedEntry.parsed.authorLabel} · {selectedEntry.parsed.title}
                  </span>
                  <span className="text-xs font-mono text-muted flex-shrink-0">
                    {selectedEntry.checkpoint.commitOid.slice(0, 7)}
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted">Select a checkpoint</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {selectedEntry?.parsed.threadId && onOpenThread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(selectedEntry.parsed.threadId ?? "")}
                  className="btn-secondary px-2.5 py-1 text-xs rounded-md"
                >
                  Open thread
                </button>
              )}

              <div className="flex items-center border border-border rounded-md overflow-hidden bg-surface-tertiary">
                <button
                  type="button"
                  onClick={() => setDiffMode("inline")}
                  className={`px-2 py-1 text-xs flex items-center gap-1 ${
                    diffMode === "inline" ? "bg-background text-foreground" : "text-muted"
                  }`}
                >
                  <RowsIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Inline</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDiffMode("split")}
                  className={`px-2 py-1 text-xs flex items-center gap-1 ${
                    diffMode === "split" ? "bg-background text-foreground" : "text-muted"
                  }`}
                >
                  <ColumnsIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Split</span>
                </button>
              </div>

              {selectedCheckpointId && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowLabelForm((prev) => !prev)}
                    className="btn-secondary px-2.5 py-1 text-xs rounded-md flex items-center gap-1"
                  >
                    <BookmarkSimpleIcon className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Label</span>
                  </button>
                  <button
                    type="button"
                    disabled={!diffResult || restoring}
                    onClick={() => setRestoreConfirmOpen(true)}
                    className="btn-primary px-3 py-1 text-xs rounded-md disabled:opacity-50"
                  >
                    Restore
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Inline label creation form */}
          {showLabelForm && selectedCheckpointId && (
            <form
              onSubmit={(e) => void handleCreateLabel(e)}
              className="px-4 py-2 border-b border-border bg-surface-tertiary flex flex-wrap items-center gap-2"
            >
              <input
                type="text"
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                placeholder="Label name (e.g. draft-v3)"
                className="px-2.5 py-1 text-xs rounded border border-border bg-background text-foreground w-48"
                required
              />
              <input
                type="text"
                value={labelMessage}
                onChange={(e) => setLabelMessage(e.target.value)}
                placeholder="Optional note"
                className="px-2.5 py-1 text-xs rounded border border-border bg-background text-foreground flex-1 min-w-40"
              />
              <button
                type="submit"
                disabled={savingLabel || !labelName.trim()}
                className="btn-primary px-3 py-1 text-xs rounded disabled:opacity-50"
              >
                {savingLabel ? "Saving..." : "Save label"}
              </button>
              <button
                type="button"
                onClick={() => setShowLabelForm(false)}
                className="btn-ghost px-2 py-1 text-xs rounded"
              >
                Cancel
              </button>
            </form>
          )}

          {/* Inline anomaly / status banners */}
          {errorMsg && (
            <div className="px-4 py-2 border-b border-destructive/30 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
              <WarningCircleIcon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1">{errorMsg}</span>
              <button type="button" onClick={() => setErrorMsg(null)} className="text-xs underline">
                Dismiss
              </button>
            </div>
          )}

          {statusNotice && !errorMsg && (
            <div className="px-4 py-1.5 border-b border-border bg-surface-tertiary text-foreground-secondary text-xs flex items-center justify-between gap-2">
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

          {/* File list + Diff body */}
          <div className="flex-1 min-h-0 flex">
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
                {/* Changed files list */}
                <div className="w-60 flex-shrink-0 border-r border-border bg-background overflow-y-auto p-2 space-y-1">
                  {diffResult.files.map((file) => {
                    const active = activeParsedFile?.path === file.path;
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelectedFilePath(file.path)}
                        className={`w-full text-left px-2.5 py-1.5 rounded text-xs font-mono flex items-center justify-between gap-2 ${
                          active
                            ? "bg-surface-tertiary text-foreground font-medium"
                            : "text-foreground-secondary hover:bg-accent-hover"
                        }`}
                      >
                        <span className="truncate">{file.path}</span>
                        <span className="flex-shrink-0 text-[11px] text-muted">
                          <span className="text-success">+{file.additions}</span>{" "}
                          <span className="text-destructive">-{file.deletions}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Hunk diff view */}
                <ScrollArea className="flex-1 min-w-0">
                  <div className="p-4 space-y-3">
                    {activeParsedFile && activeParsedFile.hunks.length > 0 ? (
                      activeParsedFile.hunks.map((hunk) => (
                        <HunkDiffView
                          key={hunk.id}
                          hunk={hunk}
                          mode={diffMode}
                          canRevert={diffResult.toId === null}
                          reverting={revertingHunkId === hunk.id}
                          onRevert={() => void handleRevertHunk(hunk)}
                        />
                      ))
                    ) : (
                      <div className="text-xs text-muted">
                        No textual hunks available for this file.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
        </section>
      )}

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
