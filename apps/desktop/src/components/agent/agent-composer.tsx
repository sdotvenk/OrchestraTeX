"use client";

import type { FileNode } from "@orchestratex/shared";
import {
  ArrowUp,
  CaretDown,
  Check,
  FileText,
  Gauge,
  Lightning,
  Paperclip,
  PencilSimple,
  Plus,
  Queue,
  ShieldCheck,
  Stop,
  Trash,
  X,
} from "@phosphor-icons/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  usageTrigger?: React.ReactNode;
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
  usageTrigger,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [contextChip, setContextChip] = useState<{ label: string; snippet: string } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<LocalAttachment | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activePopoverIdx, setActivePopoverIdx] = useState(0);
  const [dismissedPopoverKey, setDismissedPopoverKey] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<"modes" | "model" | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  // Close mode/model popovers on outside click or Escape
  useEffect(() => {
    if (!openMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [openMenu]);

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
  const isAutoRuntime = runtimeMode !== "approval-required";

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
      if (!trimmed && attachments.length === 0 && !contextChip) return;

      const chipPrefix = contextChip
        ? contextChip.snippet.trim()
          ? `Regarding \`${contextChip.label}\`:\n\`\`\`latex\n${contextChip.snippet.trim()}\n\`\`\`\n\n`
          : `Regarding \`${contextChip.label}\`: `
        : "";
      const composedContent = `${chipPrefix}${text}`.trim();
      const currentAtts = attachments.map((a) => a.input);

      setText("");
      setAttachments([]);
      setContextChip(null);
      setDismissedPopoverKey(null);
      setActivePopoverIdx(0);
      setOpenMenu(null);
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
      onSendMessage,
      onSteerActiveTurn,
      providerObj?.supportsSteer,
      text,
    ],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    (text.trim().length > 0 || attachments.length > 0 || Boolean(contextChip));
  const modelLabel = selectedModelInfo?.name ?? currentModel ?? providerObj?.name ?? "Default";
  const folderShort = projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : null;
  const runtimeLabel =
    RUNTIME_OPTIONS.find((r) => r.id === runtimeMode)?.label ?? "Auto-accept edits";

  return (
    <section
      ref={menuContainerRef}
      aria-label="Message composer"
      className="px-3 pb-2.5 pt-1 bg-panel relative shrink-0"
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

      {/* Silkscreen-style Consolidated Chat Modes Popover */}
      {openMenu === "modes" && (
        <div
          className="absolute bottom-full left-3 mb-2 w-[290px] max-w-[calc(100%-24px)] z-40 rounded-xl border border-border bg-panel p-2.5 space-y-2.5"
          style={{ boxShadow: "var(--shadow-2)" }}
          role="dialog"
          aria-label="Chat settings"
        >
          <div className="space-y-1">
            {RUNTIME_OPTIONS.map((opt) => {
              const selected = runtimeMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => void onChangeRuntimeMode(opt.id)}
                  className={`w-full px-2.5 py-2 rounded-lg text-left flex items-start gap-2.5 transition-colors ${
                    selected ? "bg-accent-soft" : "hover:bg-subtle"
                  }`}
                >
                  {opt.isAuto ? (
                    <Lightning className="size-4 text-accent mt-0.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="size-4 text-muted mt-0.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] font-medium text-foreground-strong">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-muted leading-snug">{opt.note}</span>
                  </span>
                  {selected && (
                    <Check className="size-3.5 text-accent mt-1 shrink-0" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted">Mode</span>
            <div className="inline-flex p-0.5 rounded-lg bg-sunken gap-0.5">
              {(["default", "plan"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => void onChangeInteractionMode(m)}
                  className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
                    interactionMode === m
                      ? "bg-panel text-foreground-strong shadow-xs"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {m === "plan" ? "Plan" : "Edit"}
                </button>
              ))}
            </div>
          </div>

          {supportedEfforts.length > 0 && (
            <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted shrink-0">
                <Gauge className="size-3.5" aria-hidden="true" />
                <span>Effort</span>
              </span>
              <div className="inline-flex p-0.5 rounded-lg bg-sunken gap-0.5 flex-wrap justify-end">
                {supportedEfforts.map((eff) => (
                  <button
                    key={eff}
                    type="button"
                    onClick={() => void onChangeEffort(eff)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
                      currentEffort === eff
                        ? "bg-panel text-foreground-strong shadow-xs"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {eff}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Silkscreen-style Grouped Provider & Model Popover */}
      {openMenu === "model" && (
        <div
          className="absolute bottom-full right-3 mb-2 w-[270px] max-w-[calc(100%-24px)] max-h-[320px] overflow-y-auto z-40 rounded-xl border border-border bg-panel p-1.5 space-y-2"
          style={{ boxShadow: "var(--shadow-2)" }}
          role="dialog"
          aria-label="Choose provider and model"
        >
          {providers.map((p) => {
            const isCurrentProvider = p.id === currentProviderId;
            return (
              <div key={p.id} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    void onChangeProvider(p.id);
                    if (p.models.length === 0) setOpenMenu(null);
                  }}
                  className="w-full px-2 py-1 rounded-md flex items-center gap-2 text-left hover:bg-subtle transition-colors"
                >
                  <ProviderIcon providerId={p.id} className="size-3.5 shrink-0" />
                  <span className="text-[11.5px] font-semibold text-foreground-strong truncate">
                    {p.name}
                  </span>
                  <span className="ml-auto text-[10.5px] text-muted">
                    {!p.installed ? "Not found" : !p.authenticated ? "Sign in" : ""}
                  </span>
                </button>
                {p.models.length > 0 && (
                  <div className="pl-2 space-y-0.5">
                    {p.models.map((m) => {
                      const isSelected = isCurrentProvider && m.id === currentModel;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={async () => {
                            if (!isCurrentProvider) {
                              await onChangeProvider(p.id);
                            }
                            await onChangeModel(m.id);
                            setOpenMenu(null);
                          }}
                          className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between gap-2 text-[12px] transition-colors ${
                            isSelected
                              ? "bg-accent-soft text-accent font-medium"
                              : "text-foreground hover:bg-subtle"
                          }`}
                        >
                          <span className="truncate">{m.name}</span>
                          {isSelected && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Queued Messages Strip */}
      {queuedMessages.length > 0 && activeThread && (
        <div className="mb-2 space-y-1">
          <div className="text-[11px] font-medium text-muted flex items-center gap-1 px-1">
            <Queue className="size-3" aria-hidden="true" />
            <span>Queued ({queuedMessages.length})</span>
          </div>
          {queuedMessages.map((q) => (
            <div
              key={q.id}
              className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-border bg-subtle text-[12px]"
            >
              <span className="truncate text-foreground flex-1">
                {q.content || `${q.attachments.length} image(s)`}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void onSteerQueuedMessage(activeThread.summary.id, q)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium border border-border bg-panel hover:bg-accent-soft hover:text-accent transition-colors"
                >
                  Steer
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
                  className="p-1 rounded-md text-muted hover:text-foreground hover:bg-panel"
                  title="Edit queued message"
                  aria-label="Edit queued message"
                >
                  <PencilSimple className="size-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveQueuedMessage(activeThread.summary.id, q.id)}
                  className="p-1 rounded-md text-muted hover:text-error hover:bg-panel"
                  title="Remove from queue"
                  aria-label="Remove from queue"
                >
                  <Trash className="size-3" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Raised Rounded Composer Card */}
      <div
        className={`rounded-[14px] border bg-panel transition-all ${
          dragOver
            ? "border-accent ring-2 ring-accent/20"
            : "border-border-dark focus-within:border-accent"
        }`}
        style={{ boxShadow: "var(--shadow-1)" }}
      >
        {/* Connected Context Chip & Image Attachments */}
        {(contextChip || attachments.length > 0) && (
          <div className="px-3 pt-2.5 flex flex-wrap items-center gap-1.5">
            {contextChip && (
              <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md bg-accent-soft text-accent text-[11.5px] font-mono">
                <FileText className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[200px]">{contextChip.label}</span>
                <button
                  type="button"
                  onClick={() => setContextChip(null)}
                  className="p-0.5 rounded hover:bg-panel/60"
                  aria-label="Remove selection context"
                >
                  <X className="size-2.5" aria-hidden="true" />
                </button>
              </span>
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
        <div className="px-3 pt-2.5 pb-1">
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
            rows={2}
            disabled={!projectPath}
            placeholder={
              !projectPath
                ? "Open a paper folder to start..."
                : isRunning
                  ? providerObj?.supportsSteer
                    ? "Type to steer this turn..."
                    : "Type to queue next message..."
                  : "Ask anything, @ a file, / for commands..."
            }
            aria-label="Agent prompt input"
            className="w-full resize-none bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none leading-relaxed max-h-[180px]"
          />
        </div>

        {/* Bottom Control Row (Silkscreen v1.3.1 compact layout) */}
        <div className="px-2 pb-2 pt-1 flex items-center justify-between gap-1.5">
          {/* Left: Attach + Consolidated ChatModes button */}
          <div className="flex items-center gap-1 shrink-0">
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
              className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
              title="Attach image (or paste / drop)"
              aria-label="Attach image"
            >
              <Paperclip className="size-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => setOpenMenu((m) => (m === "modes" ? null : "modes"))}
              className={`h-7 px-2 rounded-lg inline-flex items-center gap-1 text-[11.5px] transition-colors ${
                openMenu === "modes" || interactionMode === "plan"
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:text-foreground hover:bg-subtle"
              }`}
              title={`${runtimeLabel}${interactionMode === "plan" ? " · Plan mode" : ""}${currentEffort ? ` · ${currentEffort} effort` : ""}`}
              aria-label="Chat settings"
              aria-expanded={openMenu === "modes"}
            >
              {isAutoRuntime ? (
                <Lightning className="size-3.5" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              )}
              {interactionMode === "plan" && <span className="font-medium">Plan</span>}
              <CaretDown className="size-2.5 opacity-75" aria-hidden="true" />
            </button>

            {usageTrigger}
          </div>

          {/* Right: ModelChip + Send/Stop */}
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              type="button"
              onClick={() => setOpenMenu((m) => (m === "model" ? null : "model"))}
              className="h-7 px-2 rounded-lg inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground hover:bg-subtle transition-colors min-w-0 max-w-[175px]"
              title={`${providerObj?.name ?? currentProviderId} · ${modelLabel}`}
              aria-label="Choose agent and model"
              aria-expanded={openMenu === "model"}
            >
              <ProviderIcon providerId={currentProviderId} className="size-3.5 shrink-0" />
              <span className="truncate font-medium text-foreground">{modelLabel}</span>
              {currentEffort && (
                <span className="text-[11px] text-muted-foreground shrink-0 capitalize">
                  {currentEffort}
                </span>
              )}
              <CaretDown className="size-2.5 opacity-75 shrink-0" aria-hidden="true" />
            </button>

            {isRunning && activeThread ? (
              <div className="flex items-center gap-1 shrink-0">
                {canSend && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleSubmit(providerObj?.supportsSteer ? "steer" : "queue")
                    }
                    className="h-7 px-2 rounded-full border border-border bg-subtle hover:bg-accent-soft hover:text-accent text-[11px] font-medium inline-flex items-center gap-1 transition-colors"
                    title={providerObj?.supportsSteer ? "Steer active turn" : "Queue for next turn"}
                  >
                    {providerObj?.supportsSteer ? (
                      <span>Steer</span>
                    ) : (
                      <>
                        <Plus className="size-3" aria-hidden="true" />
                        <span>Queue</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onInterruptTurn(activeThread.summary.id)}
                  className="size-7 rounded-full bg-error-bg text-error hover:brightness-95 inline-flex items-center justify-center transition-all"
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  <Stop className="size-3.5" weight="fill" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void handleSubmit("auto")}
                className={`size-7 rounded-full inline-flex items-center justify-center transition-all shrink-0 ${
                  canSend
                    ? "bg-primary text-primary-text hover:bg-primary-hover"
                    : "bg-sunken text-muted-foreground cursor-default"
                }`}
                title="Send message (Enter)"
                aria-label="Send message"
              >
                <ArrowUp className="size-3.5" weight="bold" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Quiet Context Strip below composer */}
      <div className="px-1 pt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate font-mono text-[10.5px]">{folderShort ?? "No folder open"}</span>
        <span className="shrink-0">{runtimeLabel}</span>
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
