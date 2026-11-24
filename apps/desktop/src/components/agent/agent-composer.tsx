"use client";

import type { FileNode } from "@orchestratex/shared";
import { ArrowUp, CaretDown, FileText, Plus, Stop, X } from "@phosphor-icons/react";
import Image from "next/image";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatModelDisplayName } from "@/lib/agent/model-display";
import type {
  AgentProviderId,
  AgentThread,
  AttachmentInput,
  InteractionMode,
  ModelInfo,
  ProviderStatus,
  QueuedMessage,
  RuntimeMode,
  SlashCommandInfo,
} from "@/lib/agent/types";
import { BUILTIN_SLASH_COMMANDS } from "@/lib/agent/use-agent";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
import { ProviderIcon } from "./icons";
import { fileToAttachmentInput, flattenFileNodes } from "./utils";

interface LocalAttachment {
  id: string;
  input: AttachmentInput;
}

export interface AgentDraftInjection {
  id: number;
  text: string;
  contextChip?: {
    label: string;
    snippet: string;
  };
}

interface AgentComposerProps {
  projectPath: string | null;
  files: FileNode[];
  providers: ProviderStatus[];
  activeThread: AgentThread | null;
  activeProviderStatus: ProviderStatus | null;
  slashCommands: SlashCommandInfo[];
  queuedMessages: QueuedMessage[];
  defaultProvider: AgentProviderId;
  defaultModelByProvider: Partial<Record<AgentProviderId, string>>;
  defaultEffortByProvider: Partial<Record<AgentProviderId, string>>;
  defaultInteractionMode: InteractionMode;
  defaultRuntimeMode: RuntimeMode;
  draftInjection?: AgentDraftInjection | null;
  onDraftConsumed?: () => void;
  onSendMessage: (content: string, attachments?: AttachmentInput[]) => Promise<void>;
  onQueueMessage: (threadId: string, content: string, attachments?: AttachmentInput[]) => void;
  onRemoveQueuedMessage: (threadId: string, queueId: string) => void;
  onSteerQueuedMessage: (threadId: string, item: QueuedMessage) => Promise<void>;
  onSteerActiveTurn: (
    threadId: string,
    content: string,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  onInterruptTurn: (threadId: string) => Promise<void>;
  onChangeProvider: (providerId: AgentProviderId) => Promise<void> | void;
  onChangeModel: (modelId: string) => Promise<void> | void;
  onChangeEffort: (effort: string) => Promise<void> | void;
  onChangeInteractionMode: (mode: InteractionMode) => Promise<void> | void;
  onChangeRuntimeMode: (mode: RuntimeMode) => Promise<void> | void;
  selectedLineRange?: { label: string; snippet?: string } | null;
  onRemoveSelectedLineRange?: () => void;
  workspaceLabel?: string;
  onOpenWorkspace?: () => void;
  compactLabel?: string;
  onCompactContext?: () => Promise<void> | void;
  usageTrigger?: React.ReactNode;
  compact?: boolean;
  latestBuildLogExcerpt?: string | null;
}

const RUNTIME_OPTIONS: readonly {
  id: RuntimeMode;
  label: string;
  note: string;
  isAuto: boolean;
}[] = [
  {
    id: "approval-required",
    label: "Approval required",
    note: "Ask before editing files or running commands",
    isAuto: false,
  },
  {
    id: "auto-accept-edits",
    label: "Auto-accept edits",
    note: "Apply file edits automatically; ask for shell",
    isAuto: true,
  },
  {
    id: "full-access",
    label: "Full access",
    note: "Run edits and build commands without prompts",
    isAuto: true,
  },
] as const;

export function AgentComposer({
  projectPath,
  files,
  providers,
  activeThread,
  activeProviderStatus,
  slashCommands,
  queuedMessages,
  defaultProvider,
  defaultModelByProvider,
  defaultEffortByProvider,
  defaultInteractionMode,
  defaultRuntimeMode,
  draftInjection,
  onDraftConsumed,
  onSendMessage,
  onQueueMessage,
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
  onSteerActiveTurn,
  onInterruptTurn,
  onChangeProvider,
  onChangeModel,
  onChangeEffort,
  onChangeInteractionMode,
  onChangeRuntimeMode,
  selectedLineRange,
  onRemoveSelectedLineRange,
  workspaceLabel,
  onOpenWorkspace,
  compactLabel,
  onCompactContext,
  usageTrigger,
  compact = false,
  latestBuildLogExcerpt = null,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [contextChip, setContextChip] = useState<{ label: string; snippet: string } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<LocalAttachment | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activePopoverIdx, setActivePopoverIdx] = useState(0);
  const [dismissedPopoverKey, setDismissedPopoverKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [includeBuildLog, setIncludeBuildLog] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  // Close settings popover on outside click or Escape
  useEffect(() => {
    if (!settingsOpen) return;
    menuRef.current?.querySelector("button")?.focus();
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !settingsButtonRef.current?.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [closeSettings, settingsOpen]);

  // Inject external selection as a connected context chip (or plain draft)
  useEffect(() => {
    if (!draftInjection) return;
    if (draftInjection.contextChip) {
      setContextChip(draftInjection.contextChip);
    } else if (draftInjection.text.trim()) {
      setText((prev) =>
        prev.trim() ? `${prev.trimEnd()}\n\n${draftInjection.text}` : draftInjection.text,
      );
    }
    setActivePopoverIdx(0);
    onDraftConsumed?.();
    requestAnimationFrame(() => {
      adjustTextareaHeight();
      textareaRef.current?.focus();
    });
  }, [adjustTextareaHeight, draftInjection, onDraftConsumed]);

  const currentProviderId =
    activeThread?.summary.providerId ?? activeProviderStatus?.id ?? defaultProvider;
  const providerObj = providers.find((p) => p.id === currentProviderId) ?? activeProviderStatus;

  const models: ModelInfo[] = providerObj?.models ?? [];
  const currentModel =
    activeThread?.summary.model ??
    defaultModelByProvider[currentProviderId] ??
    models.find((m) => m.isDefault)?.id ??
    models[0]?.id ??
    "";
  const selectedModelInfo = models.find((m) => m.id === currentModel);
  const supportedEfforts = selectedModelInfo?.supportedEffortLevels ?? [];
  const currentEffort =
    activeThread?.summary.reasoningEffort ??
    defaultEffortByProvider[currentProviderId] ??
    selectedModelInfo?.defaultEffort ??
    supportedEfforts[0] ??
    "";

  const interactionMode = activeThread?.summary.interactionMode ?? defaultInteractionMode;
  const runtimeMode = activeThread?.summary.runtimeMode ?? defaultRuntimeMode;
  const isRunning = activeThread?.summary.status === "running";

  const projectFilePaths = useMemo(
    () => flattenFileNodes(files, projectPath),
    [files, projectPath],
  );

  // Detect active `/` slash popover or `@` file mention popover
  const popoverState = useMemo(() => {
    const trimmedStart = text.trimStart();
    if (trimmedStart.startsWith("/") && !/\s/.test(trimmedStart)) {
      const q = trimmedStart.slice(1).toLowerCase();
      const cmds = (slashCommands.length > 0 ? slashCommands : BUILTIN_SLASH_COMMANDS).filter(
        (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      );
      if (cmds.length > 0 && dismissedPopoverKey !== `slash:${trimmedStart}`) {
        return { kind: "slash" as const, key: `slash:${trimmedStart}`, items: cmds.slice(0, 10) };
      }
    }

    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const mentionMatch = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (mentionMatch) {
      const query = (mentionMatch[1] ?? "").toLowerCase();
      const matchingFiles = projectFilePaths
        .filter((f) => f.toLowerCase().includes(query))
        .slice(0, 12);
      if (matchingFiles.length > 0 && dismissedPopoverKey !== `mention:${mentionMatch[0]}`) {
        return {
          kind: "mention" as const,
          key: `mention:${mentionMatch[0]}`,
          query,
          items: matchingFiles,
        };
      }
    }

    return null;
  }, [dismissedPopoverKey, projectFilePaths, slashCommands, text]);

  const applySlashCommand = useCallback(
    (cmd: SlashCommandInfo) => {
      const immediateBuiltins = new Set(["new", "clear", "compact", "fork", "usage"]);
      if (immediateBuiltins.has(cmd.name.toLowerCase()) && !cmd.argumentHint) {
        setText("");
        setActivePopoverIdx(0);
        void onSendMessage(`/${cmd.name}`);
      } else {
        setText(`/${cmd.name} `);
        setActivePopoverIdx(0);
        requestAnimationFrame(() => {
          adjustTextareaHeight();
          textareaRef.current?.focus();
        });
      }
    },
    [adjustTextareaHeight, onSendMessage],
  );

  const applyMentionFile = useCallback(
    (filePath: string) => {
      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? text.length;
      const before = text.slice(0, cursorPos);
      const after = text.slice(cursorPos);
      const replacedBefore = before.replace(/@([^\s@]*)$/, `@${filePath} `);
      const next = replacedBefore + after;
      setText(next);
      setActivePopoverIdx(0);
      requestAnimationFrame(() => {
        adjustTextareaHeight();
        if (textareaRef.current) {
          textareaRef.current.focus();
          const pos = replacedBefore.length;
          textareaRef.current.setSelectionRange(pos, pos);
        }
      });
    },
    [adjustTextareaHeight, text],
  );

  const handleAddFiles = useCallback(async (fileList: FileList | File[]) => {
    const imgs = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    const converted = await Promise.all(imgs.map((f) => fileToAttachmentInput(f)));
    setAttachments((prev) => [
      ...prev,
      ...converted.map((input, idx) => ({
        id: `att-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        input,
      })),
    ]);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void handleAddFiles(imageFiles);
      }
    },
    [handleAddFiles],
  );

  const handleSubmit = useCallback(
    async (mode: "auto" | "steer" | "queue" = "auto") => {
      const trimmed = text.trim();
      const activeChip = selectedLineRange ?? contextChip;
      const hasBuildLog = Boolean(includeBuildLog && latestBuildLogExcerpt?.trim());
      if (!trimmed && attachments.length === 0 && !activeChip && !hasBuildLog) return;

      const chipPrefix = activeChip
        ? activeChip.snippet?.trim()
          ? `Regarding \`${activeChip.label}\`:\n\`\`\`latex\n${activeChip.snippet.trim()}\n\`\`\`\n\n`
          : `Regarding \`${activeChip.label}\`: `
        : "";
      const buildLogPrefix =
        hasBuildLog && latestBuildLogExcerpt
          ? `Build log:\n\`\`\`\n${latestBuildLogExcerpt.trim()}\n\`\`\`\n\n`
          : "";
      const composedContent = `${chipPrefix}${buildLogPrefix}${text}`.trim();
      const currentAtts = attachments.map((a) => a.input);

      setText("");
      setAttachments([]);
      setContextChip(null);
      setIncludeBuildLog(false);
      onRemoveSelectedLineRange?.();
      setDismissedPopoverKey(null);
      setActivePopoverIdx(0);
      setSettingsOpen(false);
      requestAnimationFrame(() => adjustTextareaHeight());

      if (mode === "steer" && activeThread && providerObj?.supportsSteer) {
        await onSteerActiveTurn(activeThread.summary.id, composedContent, currentAtts);
        return;
      }

      if (mode === "queue" && activeThread) {
        onQueueMessage(activeThread.summary.id, composedContent, currentAtts);
        return;
      }

      await onSendMessage(composedContent, currentAtts);
    },
    [
      activeThread,
      adjustTextareaHeight,
      attachments,
      contextChip,
      onQueueMessage,
      onRemoveSelectedLineRange,
      onSendMessage,
      onSteerActiveTurn,
      providerObj?.supportsSteer,
      selectedLineRange,
      text,
      latestBuildLogExcerpt?.trim,
      latestBuildLogExcerpt,
      includeBuildLog,
    ],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (popoverState) {
      const maxIdx = popoverState.items.length - 1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActivePopoverIdx((i) => (i >= maxIdx ? 0 : i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActivePopoverIdx((i) => (i <= 0 ? maxIdx : i - 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedPopoverKey(popoverState.key);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (popoverState.kind === "slash") {
          const item = popoverState.items[activePopoverIdx];
          if (item) applySlashCommand(item);
        } else {
          const item = popoverState.items[activePopoverIdx];
          if (item) applyMentionFile(item);
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isRunning && activeThread) {
        void handleSubmit(providerObj?.supportsSteer ? "steer" : "queue");
      } else {
        void handleSubmit("auto");
      }
    }
  };

  const canSend =
    Boolean(projectPath) &&
    (text.trim().length > 0 ||
      attachments.length > 0 ||
      Boolean(contextChip) ||
      Boolean(selectedLineRange));
  const modelLabel = formatModelDisplayName(currentModel, models) || providerObj?.name || "Default";
  const runtimeLabel =
    RUNTIME_OPTIONS.find((r) => r.id === runtimeMode)?.label ?? "Auto-accept edits";

  return (
    <section
      aria-label="Message composer"
      className="relative mx-auto w-full max-w-[720px] shrink-0 bg-panel px-3 pt-1 pb-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          void handleAddFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Popover for `/` slash commands or `@` file mentions */}
      {popoverState && (
        <div
          className="absolute bottom-full left-3 right-3 mb-1.5 z-40 rounded-xl border border-border bg-panel max-h-56 overflow-y-auto p-1"
          style={{ boxShadow: "var(--shadow-2)" }}
        >
          <div className="px-2.5 py-1 text-[11px] font-medium text-muted flex items-center justify-between">
            <span>{popoverState.kind === "slash" ? "Commands" : "Project files"}</span>
            <span className="font-mono text-[10px]">Tab / Enter</span>
          </div>
          {popoverState.kind === "slash"
            ? popoverState.items.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(cmd);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between gap-2 text-[12.5px] transition-colors ${
                    idx === activePopoverIdx
                      ? "bg-accent-soft text-foreground-strong"
                      : "hover:bg-subtle text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-medium text-accent shrink-0">/{cmd.name}</span>
                    {cmd.argumentHint && (
                      <span className="font-mono text-[11px] text-muted truncate">
                        {cmd.argumentHint}
                      </span>
                    )}
                  </div>
                  <span className="text-[11.5px] text-muted truncate">{cmd.description}</span>
                </button>
              ))
            : popoverState.items.map((filePath, idx) => (
                <button
                  key={filePath}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMentionFile(filePath);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center gap-2 text-[12px] font-mono transition-colors ${
                    idx === activePopoverIdx
                      ? "bg-accent-soft text-foreground-strong"
                      : "hover:bg-subtle text-foreground"
                  }`}
                >
                  <FileText className="size-3.5 text-muted shrink-0" aria-hidden="true" />
                  <span className="truncate">{filePath}</span>
                </button>
              ))}
        </div>
      )}

      {/* Consolidated Thread Settings Popover */}
      {settingsOpen && (
        <div
          id={menuId}
          ref={menuRef}
          className="absolute bottom-full left-3 mb-2 w-[330px] max-w-[calc(100%-24px)] max-h-[min(440px,55dvh)] overflow-y-auto z-40 ox-popover p-1.5"
          role="dialog"
          aria-label="Thread settings"
        >
          {/* Harness */}
          <div className="ox-sec px-2.5 pt-1.5 pb-1">Harness</div>
          {providers.map((p) => {
            const isCurrentProvider = p.id === currentProviderId;
            const availability = !p.installed ? "Not found" : !p.authenticated ? "Sign in" : null;
            const voice = VOICE_COLORS[p.id] ?? VOICE_COLORS.claude;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={isCurrentProvider}
                onClick={() => void onChangeProvider(p.id)}
                className={`w-full h-[30px] px-2.5 rounded-[6px] flex items-center gap-2 text-left transition-colors ${
                  isCurrentProvider
                    ? "bg-subtle text-foreground-strong"
                    : "hover:bg-subtle text-foreground"
                }`}
              >
                <span style={{ color: voice.ink }} className="inline-flex shrink-0">
                  <ProviderIcon providerId={p.id} className="size-3.5" />
                </span>
                <span className="text-[12px] font-medium truncate">{p.name}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted shrink-0">
                  {availability && <span>{availability}</span>}
                  {isCurrentProvider && (
                    <span
                      className="font-mono text-[12px] text-foreground-strong"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          <div className="my-1 mx-1.5 h-px bg-border" />

          {/* Model (compact collapsible) */}
          {models.length > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={modelMenuOpen}
                onClick={() => setModelMenuOpen((open) => !open)}
                className="w-full h-[30px] px-2.5 rounded-[6px] flex items-center justify-between gap-2 text-[12px] text-foreground hover:bg-subtle transition-colors"
              >
                <span>Model</span>
                <span className="text-foreground-strong truncate">
                  {modelLabel} {modelMenuOpen ? "▾" : "▸"}
                </span>
              </button>
              {modelMenuOpen && (
                <div className="mt-0.5 mb-1 pl-2 space-y-0.5 max-h-36 overflow-y-auto">
                  {models.map((m) => {
                    const isSelected = m.id === currentModel;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          void onChangeModel(m.id);
                          setModelMenuOpen(false);
                        }}
                        className={`w-full h-[28px] px-2.5 rounded-[6px] text-left flex items-center justify-between gap-2 text-[12px] transition-colors ${
                          isSelected
                            ? "bg-subtle text-foreground-strong font-medium"
                            : "text-foreground hover:bg-subtle"
                        }`}
                      >
                        <span className="truncate">{m.name}</span>
                        {isSelected && <span className="font-mono text-[11px]">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Effort */}
          {supportedEfforts.length > 0 && (
            <div className="h-[30px] px-2.5 flex items-center justify-between gap-2">
              <span className="text-[12px] text-foreground shrink-0">Effort</span>
              <div className="inline-flex p-0.5 rounded-[7px] bg-sunken gap-0.5">
                {supportedEfforts.map((eff) => (
                  <button
                    key={eff}
                    type="button"
                    aria-pressed={currentEffort === eff}
                    onClick={() => void onChangeEffort(eff)}
                    className={`px-2 py-0.5 rounded-[5px] text-[11px] font-medium capitalize transition-colors ${
                      currentEffort === eff
                        ? "bg-panel text-foreground-strong shadow-xs"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {eff === "medium" ? "Med" : eff}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Mode: Build / Plan */}
          <div className="h-[30px] px-2.5 flex items-center justify-between gap-2">
            <span className="text-[12px] text-foreground">Mode</span>
            <div className="inline-flex p-0.5 rounded-[7px] bg-sunken gap-0.5">
              {(["default", "plan"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={interactionMode === m}
                  onClick={() => void onChangeInteractionMode(m)}
                  className={`px-2.5 py-0.5 rounded-[5px] text-[11px] font-medium transition-colors ${
                    interactionMode === m
                      ? "bg-panel text-foreground-strong shadow-xs"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {m === "plan" ? "Plan" : "Build"}
                </button>
              ))}
            </div>
          </div>

          {/* Access (compact collapsible) */}
          <div>
            <button
              type="button"
              aria-expanded={accessMenuOpen}
              onClick={() => setAccessMenuOpen((open) => !open)}
              className="w-full h-[30px] px-2.5 rounded-[6px] flex items-center justify-between gap-2 text-[12px] text-foreground hover:bg-subtle transition-colors"
            >
              <span>Access</span>
              <span className="text-foreground-strong truncate">
                {runtimeLabel} {accessMenuOpen ? "▾" : "▸"}
              </span>
            </button>
            {accessMenuOpen && (
              <div className="mt-0.5 mb-1 pl-2 space-y-0.5">
                {RUNTIME_OPTIONS.map((opt) => {
                  const selected = runtimeMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        void onChangeRuntimeMode(opt.id);
                        setAccessMenuOpen(false);
                      }}
                      className={`w-full h-[28px] px-2.5 rounded-[6px] text-left flex items-center justify-between gap-2 text-[12px] transition-colors ${
                        selected
                          ? "bg-subtle text-foreground-strong font-medium"
                          : "text-foreground hover:bg-subtle"
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                      {selected && <span className="font-mono text-[11px]">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Workspace */}
          {onOpenWorkspace && (
            <button
              type="button"
              onClick={() => {
                onOpenWorkspace();
                closeSettings();
              }}
              className="w-full h-[30px] px-2.5 rounded-[6px] text-left flex items-center justify-between gap-2 text-[12px] text-foreground hover:bg-subtle transition-colors"
            >
              <span>Workspace</span>
              <span className="text-foreground-strong truncate">{workspaceLabel ?? "Local"} ▸</span>
            </button>
          )}

          {/* Compact context */}
          {onCompactContext && (
            <>
              <div className="my-1 mx-1.5 h-px bg-border" />
              <button
                type="button"
                onClick={() => {
                  void onCompactContext();
                  closeSettings();
                }}
                className="w-full h-[30px] px-2.5 rounded-[6px] text-left flex items-center justify-between gap-2 text-[12px] text-foreground hover:bg-subtle transition-colors"
              >
                <span>Compact context</span>
                {compactLabel && (
                  <span className="font-mono text-[11.5px] text-muted">{compactLabel}</span>
                )}
              </button>
            </>
          )}
        </div>
      )}

      {/* Queued Messages Strip */}
      {queuedMessages.length > 0 && activeThread && (
        <div className="space-y-1">
          {queuedMessages.map((q) => (
            <div key={q.id} className="flex items-center gap-2 px-1 pb-2 text-[12px] text-muted">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-foreground-strong shrink-0">
                Queued
              </span>
              <span className="truncate flex-1">
                {q.content || `${q.attachments.length} image(s)`}
              </span>
              <div className="ml-auto flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void onSteerQueuedMessage(activeThread.summary.id, q)}
                  className="hover:text-foreground transition-colors"
                >
                  Steer now
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRemoveQueuedMessage(activeThread.summary.id, q.id);
                    setText(q.content);
                    setActivePopoverIdx(0);
                    if (q.attachments.length > 0) {
                      setAttachments((prev) => [
                        ...prev,
                        ...q.attachments.map((input, idx) => ({
                          id: `requeue-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
                          input,
                        })),
                      ]);
                    }
                    requestAnimationFrame(() => {
                      adjustTextareaHeight();
                      textareaRef.current?.focus();
                    });
                  }}
                  className="hover:text-foreground transition-colors"
                  title="Edit queued message"
                  aria-label="Edit queued message"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveQueuedMessage(activeThread.summary.id, q.id)}
                  className="hover:text-foreground transition-colors"
                  title="Remove from queue"
                  aria-label="Remove from queue"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Raised Rounded Composer Card */}
      <div
        className={`rounded-[12px] border-[1.5px] border-[var(--composer-border)] bg-[var(--composer-bg)] shadow-[var(--composer-shadow)] px-3 pt-2.5 pb-2 transition-colors ${
          dragOver ? "ring-2 ring-accent/30" : ""
        }`}
      >
        {/* Connected Context Chip, Build Log Chip & Image Attachments */}
        {(selectedLineRange || contextChip || latestBuildLogExcerpt || attachments.length > 0) && (
          <div className="pb-2 flex flex-wrap items-center gap-1.5">
            {(selectedLineRange ?? contextChip) && (
              <span
                className="inline-flex items-center gap-1.5 font-mono text-[11.5px] rounded-[6px] px-2 py-0.5"
                style={{
                  backgroundColor: (VOICE_COLORS[currentProviderId] ?? VOICE_COLORS.claude).tint,
                  color: (VOICE_COLORS[currentProviderId] ?? VOICE_COLORS.claude).text,
                }}
              >
                <span className="truncate max-w-[200px]">
                  {(selectedLineRange ?? contextChip)?.label}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedLineRange) {
                      onRemoveSelectedLineRange?.();
                    } else {
                      setContextChip(null);
                    }
                  }}
                  className="p-0.5 rounded hover:bg-panel/40"
                  aria-label="Remove selection context"
                >
                  <X className="size-2.5" aria-hidden="true" />
                </button>
              </span>
            )}

            {latestBuildLogExcerpt && (
              <button
                type="button"
                aria-pressed={includeBuildLog}
                onClick={() => setIncludeBuildLog((prev) => !prev)}
                className={`font-mono text-[11.5px] rounded-[6px] px-2 py-0.5 border transition-colors ${
                  includeBuildLog
                    ? "bg-accent-soft border-accent text-accent font-medium"
                    : "bg-subtle border-border text-muted hover:text-foreground"
                }`}
              >
                build log
              </button>
            )}

            {attachments.map((att) => (
              <div
                key={att.id}
                className="relative group rounded-lg border border-border bg-subtle p-0.5"
              >
                <button
                  type="button"
                  onClick={() => setLightboxImage(att)}
                  className="block size-11 rounded-md overflow-hidden bg-panel"
                  title={att.input.filename}
                >
                  {att.input.dataUrl && (
                    <Image
                      unoptimized
                      src={att.input.dataUrl}
                      alt={att.input.filename}
                      width={44}
                      height={44}
                      className="w-full h-full object-cover"
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((item) => item.id !== att.id))
                  }
                  className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-foreground-strong text-panel flex items-center justify-center"
                  aria-label={`Remove ${att.input.filename}`}
                >
                  <X className="size-2.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div className="pb-1.5">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setDismissedPopoverKey(null);
              setActivePopoverIdx(0);
              setText(e.target.value);
              requestAnimationFrame(() => adjustTextareaHeight());
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={!projectPath}
            placeholder={
              !projectPath
                ? "Open a folder to start"
                : isRunning
                  ? providerObj?.supportsSteer
                    ? "Steer this turn…"
                    : "Queue a message…"
                  : "Ask about your paper…  @ files  / commands"
            }
            aria-label="Agent prompt input"
            className="block w-full min-h-8 resize-none bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none leading-relaxed max-h-[180px]"
          />
        </div>

        {/* Seamless Bottom Control Row */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {/* Left: Compact Model · Effort chip + Attach */}
          <div className="flex items-center gap-1 min-w-0">
            <button
              ref={settingsButtonRef}
              type="button"
              aria-haspopup="dialog"
              aria-controls={settingsOpen ? menuId : undefined}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              className={`h-7 px-2.5 rounded-[7px] bg-subtle inline-flex items-baseline gap-1.5 text-[12px] transition-colors min-w-0 ${
                settingsOpen ? "ring-[1.5px] ring-foreground" : "hover:bg-sunken"
              }`}
              title={`${providerObj?.name ?? currentProviderId} · ${modelLabel}${currentEffort ? ` · ${currentEffort}` : ""} · ${interactionMode === "plan" ? "Plan" : "Build"} · ${runtimeLabel}`}
              aria-label={`Thread settings: ${modelLabel}${currentEffort ? `, ${currentEffort}` : ""}, ${interactionMode === "plan" ? "Plan" : "Build"}, ${runtimeLabel}`}
            >
              <span
                style={{ color: (VOICE_COLORS[currentProviderId] ?? VOICE_COLORS.claude).ink }}
                className="inline-flex shrink-0 self-center"
              >
                <ProviderIcon providerId={currentProviderId} className="size-3.5" />
              </span>
              <span className="min-w-0 truncate max-w-[180px] font-medium text-foreground">
                {modelLabel}
              </span>
              {currentEffort && (
                <>
                  <span className="text-muted shrink-0" aria-hidden="true">
                    ·
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted capitalize">
                    {currentEffort === "medium" ? "Med" : currentEffort}
                  </span>
                </>
              )}
              <CaretDown className="size-2.5 opacity-75 shrink-0 self-center" aria-hidden="true" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleAddFiles(e.target.files);
                }
                e.target.value = "";
              }}
            />

            <button
              type="button"
              disabled={!projectPath}
              onClick={() => fileInputRef.current?.click()}
              className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors shrink-0"
              title="Attach image (or paste / drop)"
              aria-label="Attach image"
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </div>

          {/* Right: Usage + Send/Stop */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {usageTrigger}
            {isRunning && activeThread ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void onInterruptTurn(activeThread.summary.id)}
                  className="size-[30px] rounded-[8px] border border-border-dark bg-panel text-foreground hover:bg-subtle inline-flex items-center justify-center transition-colors"
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  <Stop className="size-3" weight="fill" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => void handleSubmit(providerObj?.supportsSteer ? "steer" : "queue")}
                  className="size-[30px] rounded-[8px] btn-primary inline-flex items-center justify-center disabled:opacity-40 disabled:shadow-none"
                  title={providerObj?.supportsSteer ? "Steer active turn" : "Queue for next turn"}
                  aria-label={providerObj?.supportsSteer ? "Steer active turn" : "Queue message"}
                >
                  <ArrowUp className="size-3.5" weight="bold" aria-hidden="true" />
                </button>
              </div>
            ) : compact ? (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void handleSubmit("auto")}
                className="h-[30px] px-3 rounded-[8px] text-[12.5px] font-semibold btn-primary inline-flex items-center justify-center disabled:opacity-40 disabled:shadow-none shrink-0"
                title="Send message (Enter)"
              >
                Send
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void handleSubmit("auto")}
                className="size-[30px] rounded-[8px] btn-primary inline-flex items-center justify-center disabled:opacity-40 disabled:shadow-none shrink-0"
                title="Send message (Enter)"
                aria-label="Send message"
              >
                <ArrowUp className="size-3.5" weight="bold" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-center gap-3.5 text-[11px] text-muted mt-1.5 select-none">
        <span>@ file</span>
        <span>/ command</span>
        <span>⇧↵ newline</span>
        <span>⌘. stop</span>
      </div>

      {/* Image Lightbox Preview */}
      {lightboxImage?.input.dataUrl && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-6 modal-overlay">
          <button
            type="button"
            aria-label="Close image preview"
            onClick={() => setLightboxImage(null)}
            className="fixed inset-0 cursor-default"
          />
          <div
            className="relative z-10 rounded-2xl border border-border bg-panel max-w-2xl max-h-[85vh] flex flex-col overflow-hidden modal-content"
            style={{ boxShadow: "var(--shadow-3)" }}
          >
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-4">
              <span className="text-xs font-mono text-foreground truncate">
                {lightboxImage.input.filename}
              </span>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle"
                aria-label="Close image preview"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="p-3 overflow-auto">
              <Image
                unoptimized
                src={lightboxImage.input.dataUrl}
                alt={lightboxImage.input.filename}
                width={800}
                height={600}
                className="max-w-full max-h-[70vh] w-auto h-auto rounded-lg object-contain mx-auto"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
