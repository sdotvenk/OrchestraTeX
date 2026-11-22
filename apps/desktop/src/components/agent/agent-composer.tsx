"use client";

import type { FileNode } from "@lmms-lab/writer-shared";
import {
  ArrowUp,
  CaretDown,
  FileText,
  Paperclip,
  PencilSimple,
  Plus,
  Queue,
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
import { fileToAttachmentInput, flattenFileNodes } from "./utils";

interface LocalAttachment {
  id: string;
  input: AttachmentInput;
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
  draftInjection?: { id: number; text: string } | null;
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
}

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
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [lightboxImage, setLightboxImage] = useState<LocalAttachment | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activePopoverIdx, setActivePopoverIdx] = useState(0);
  const [dismissedPopoverKey, setDismissedPopoverKey] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  // Inject external draft (e.g. "Ask Agent about Selection" from Monaco)
  useEffect(() => {
    if (!draftInjection) return;
    setText((prev) =>
      prev.trim() ? `${prev.trimEnd()}\n\n${draftInjection.text}` : draftInjection.text,
    );
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
      if (!trimmed && attachments.length === 0) return;

      const currentText = text;
      const currentAtts = attachments.map((a) => a.input);
      setText("");
      setAttachments([]);
      setDismissedPopoverKey(null);
      setActivePopoverIdx(0);
      requestAnimationFrame(() => adjustTextareaHeight());

      if (mode === "steer" && activeThread && providerObj?.supportsSteer) {
        await onSteerActiveTurn(activeThread.summary.id, currentText, currentAtts);
        return;
      }

      if (mode === "queue" && activeThread) {
        onQueueMessage(activeThread.summary.id, currentText, currentAtts);
        return;
      }

      await onSendMessage(currentText, currentAtts);
    },
    [
      activeThread,
      adjustTextareaHeight,
      attachments,
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
        void handleSubmit(providerObj?.supportsSteer ? "queue" : "queue");
      } else {
        void handleSubmit("auto");
      }
    }
  };

  return (
    <section
      aria-label="Message composer"
      className={`border-t border-border bg-background relative ${
        dragOver ? "ring-2 ring-inset ring-foreground" : ""
      }`}
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
        <div className="absolute bottom-full left-2 right-2 mb-1 z-40 border border-foreground bg-background shadow-[4px_4px_0_0_var(--foreground)] max-h-56 overflow-y-auto">
          <div className="px-2.5 py-1 border-b border-border bg-surface-secondary text-[10px] font-mono uppercase tracking-wider text-muted flex items-center justify-between">
            <span>
              {popoverState.kind === "slash" ? "Slash Commands" : "Project Files (@mention)"}
            </span>
            <span>Tab / Enter</span>
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
                  className={`w-full px-2.5 py-1.5 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                    idx === activePopoverIdx
                      ? "bg-foreground text-background"
                      : "hover:bg-surface-secondary text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-semibold shrink-0">/{cmd.name}</span>
                    {cmd.argumentHint && (
                      <span
                        className={`font-mono text-[10px] truncate ${
                          idx === activePopoverIdx ? "text-background/70" : "text-muted"
                        }`}
                      >
                        {cmd.argumentHint}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[11px] truncate ${
                      idx === activePopoverIdx ? "text-background/80" : "text-muted"
                    }`}
                  >
                    {cmd.description}
                  </span>
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
                  className={`w-full px-2.5 py-1.5 text-left flex items-center gap-2 text-xs font-mono transition-colors ${
                    idx === activePopoverIdx
                      ? "bg-foreground text-background"
                      : "hover:bg-surface-secondary text-foreground"
                  }`}
                >
                  <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{filePath}</span>
                </button>
              ))}
        </div>
      )}

      {/* Queued Messages Strip */}
      {queuedMessages.length > 0 && activeThread && (
        <div className="px-2.5 pt-2 space-y-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted flex items-center gap-1">
            <Queue className="size-3" aria-hidden="true" />
            <span>Queued ({queuedMessages.length})</span>
          </div>
          {queuedMessages.map((q) => (
            <div
              key={q.id}
              className="flex items-center justify-between gap-2 px-2 py-1 border border-border bg-surface-secondary text-xs"
            >
              <span className="truncate font-mono text-foreground-secondary flex-1">
                {q.content || `${q.attachments.length} image(s)`}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void onSteerQueuedMessage(activeThread.summary.id, q)}
                  className="px-1.5 py-0.5 text-[10px] font-mono uppercase border border-border bg-background hover:bg-surface-tertiary text-foreground"
                  title={
                    providerObj?.supportsSteer
                      ? "Steer active turn immediately"
                      : "Interrupt and run immediately"
                  }
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
                  className="p-0.5 text-muted hover:text-foreground"
                  title="Edit queued message"
                  aria-label="Edit queued message"
                >
                  <PencilSimple className="size-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveQueuedMessage(activeThread.summary.id, q.id)}
                  className="p-0.5 text-muted hover:text-error"
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

      {/* Image Attachment Strip */}
      {attachments.length > 0 && (
        <div className="px-2.5 pt-2 flex flex-wrap gap-1.5">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative group border border-border bg-surface-secondary p-0.5"
            >
              <button
                type="button"
                onClick={() => setLightboxImage(att)}
                className="block size-12 overflow-hidden bg-background"
                title={att.input.filename}
              >
                {att.input.dataUrl && (
                  <Image
                    unoptimized
                    src={att.input.dataUrl}
                    alt={att.input.filename}
                    width={48}
                    height={48}
                    className="w-full h-full object-cover"
                  />
                )}
              </button>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== att.id))}
                className="absolute -top-1.5 -right-1.5 size-4 bg-foreground text-background flex items-center justify-center text-[10px]"
                aria-label={`Remove ${att.input.filename}`}
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main Prompt Input */}
      <div className="p-2.5 pb-1.5">
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
              ? "Open a folder to start..."
              : isRunning
                ? "Type to queue next message or steer..."
                : "Ask about your paper, edit TeX, run commands... (/ for commands, @ for files)"
          }
          aria-label="Agent prompt input"
          className="w-full resize-none bg-transparent text-xs font-mono text-foreground placeholder:text-muted focus:outline-none leading-relaxed max-h-[180px]"
        />
      </div>

      {/* Bottom T3-style Control Bar */}
      <div className="px-2.5 pb-2 pt-1 flex items-center justify-between gap-1.5 flex-wrap border-t border-border/50">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {/* Hidden image input */}
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
            className="p-1 border border-border bg-surface-secondary hover:bg-surface-tertiary text-muted hover:text-foreground disabled:opacity-40"
            title="Attach image (or paste / drop)"
            aria-label="Attach image"
          >
            <Paperclip className="size-3.5" aria-hidden="true" />
          </button>

          {/* Provider selector */}
          <div className="relative inline-flex items-center">
            <select
              aria-label="Agent provider"
              value={currentProviderId}
              onChange={(e) => void onChangeProvider(e.target.value as AgentProviderId)}
              className="appearance-none pl-1.5 pr-5 py-0.5 text-[10px] font-mono uppercase border border-border bg-surface-secondary text-foreground hover:border-foreground focus:outline-none cursor-pointer"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {!p.installed ? " (missing)" : !p.authenticated ? " (auth)" : ""}
                </option>
              ))}
            </select>
            <CaretDown
              className="size-2.5 text-muted pointer-events-none absolute right-1.5"
              aria-hidden="true"
            />
          </div>

          {/* Model selector */}
          {models.length > 0 && (
            <div className="relative inline-flex items-center max-w-[130px]">
              <select
                aria-label="Agent model"
                value={currentModel}
                onChange={(e) => void onChangeModel(e.target.value)}
                className="appearance-none w-full pl-1.5 pr-4 py-0.5 text-[10px] font-mono border border-border bg-surface-secondary text-foreground hover:border-foreground focus:outline-none truncate cursor-pointer"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <CaretDown
                className="size-2.5 text-muted pointer-events-none absolute right-1"
                aria-hidden="true"
              />
            </div>
          )}

          {/* Effort selector */}
          {supportedEfforts.length > 0 && (
            <div className="relative inline-flex items-center">
              <select
                aria-label="Reasoning effort"
                value={currentEffort}
                onChange={(e) => void onChangeEffort(e.target.value)}
                className="appearance-none pl-1.5 pr-4 py-0.5 text-[10px] font-mono uppercase border border-border bg-surface-secondary text-foreground hover:border-foreground focus:outline-none cursor-pointer"
              >
                {supportedEfforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </select>
              <CaretDown
                className="size-2.5 text-muted pointer-events-none absolute right-1"
                aria-hidden="true"
              />
            </div>
          )}

          {/* Interaction Mode toggle */}
          <button
            type="button"
            onClick={() =>
              void onChangeInteractionMode(interactionMode === "plan" ? "default" : "plan")
            }
            className={`px-1.5 py-0.5 text-[10px] font-mono uppercase border transition-colors ${
              interactionMode === "plan"
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-surface-secondary text-muted hover:text-foreground"
            }`}
            title="Toggle Plan vs Default interaction mode"
          >
            {interactionMode === "plan" ? "Plan" : "Edit"}
          </button>

          {/* Runtime Permission Mode selector */}
          <div className="relative inline-flex items-center">
            <select
              aria-label="Permission policy"
              value={runtimeMode}
              onChange={(e) => void onChangeRuntimeMode(e.target.value as RuntimeMode)}
              className="appearance-none pl-1.5 pr-4 py-0.5 text-[10px] font-mono uppercase border border-border bg-surface-secondary text-muted hover:text-foreground hover:border-foreground focus:outline-none cursor-pointer"
            >
              <option value="approval-required">Ask</option>
              <option value="auto-accept-edits">Auto-Edit</option>
              <option value="full-access">Full Access</option>
            </select>
            <CaretDown
              className="size-2.5 text-muted pointer-events-none absolute right-1"
              aria-hidden="true"
            />
          </div>
        </div>

        {/* Send / Steer / Queue / Stop Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {isRunning && activeThread && (
            <>
              {(text.trim().length > 0 || attachments.length > 0) && (
                <>
                  {providerObj?.supportsSteer && (
                    <button
                      type="button"
                      onClick={() => void handleSubmit("steer")}
                      className="btn btn-outline btn-sm py-1 px-2 text-[10px]"
                      title="Steer current turn with this message"
                    >
                      Steer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSubmit("queue")}
                    className="btn btn-outline btn-sm py-1 px-2 text-[10px] inline-flex items-center gap-1"
                    title="Queue message for next turn"
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    <span>Queue</span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void onInterruptTurn(activeThread.summary.id)}
                className="btn btn-sm py-1 px-2 border border-error text-error bg-background hover:bg-error/10 inline-flex items-center gap-1"
                title="Stop generation"
              >
                <Stop className="size-3" weight="fill" aria-hidden="true" />
                <span>Stop</span>
              </button>
            </>
          )}

          {!isRunning && (
            <button
              type="button"
              disabled={!projectPath || (!text.trim() && attachments.length === 0)}
              onClick={() => void handleSubmit("auto")}
              className="btn btn-primary btn-sm py-1 px-2.5 inline-flex items-center gap-1 disabled:opacity-40"
              title="Send message (Enter)"
            >
              <ArrowUp className="size-3" weight="bold" aria-hidden="true" />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>

      {/* Image Lightbox Preview */}
      {lightboxImage?.input.dataUrl && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6">
          <div className="border-2 border-foreground bg-background max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-4">
              <span className="text-xs font-mono truncate">{lightboxImage.input.filename}</span>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                className="text-muted hover:text-foreground"
                aria-label="Close image preview"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="p-2 overflow-auto">
              <Image
                unoptimized
                src={lightboxImage.input.dataUrl}
                alt={lightboxImage.input.filename}
                width={800}
                height={600}
                className="max-w-full max-h-[70vh] w-auto h-auto object-contain mx-auto"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
