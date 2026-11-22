"use client";

import {
  ArrowDown,
  Brain,
  CaretDown,
  CaretRight,
  FileText,
  Sparkle,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import Image from "next/image";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, AgentPart, AgentThread, InteractionResponse } from "@/lib/agent/types";
import { ApprovalCard } from "./approval-card";
import { ProviderIcon } from "./icons";
import { MarkdownText } from "./markdown-text";
import { PlanApprovalCard } from "./plan-approval-card";
import { QuestionCard } from "./question-card";
import { ToolDisplay } from "./tool-display";
import { formatRelativeTime, toRelativeProjectPath } from "./utils";

type ToolPart = Extract<AgentPart, { type: "tool" }>;
const EMPTY_TOOLS: ToolPart[] = [];

interface MessageTimelineProps {
  thread: AgentThread | null;
  projectPath: string | null;
  projectFiles: string[];
  activeFile?: string | null;
  onFileClick?: (path: string) => void;
  onQuickPrompt: (prompt: string) => void;
  onRespondInteraction: (interactionId: string, response: InteractionResponse) => Promise<void>;
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border bg-surface-secondary/40 my-1">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full px-2.5 py-1 flex items-center justify-between gap-2 text-left hover:bg-surface-secondary transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <CaretDown className="size-3 text-muted" aria-hidden="true" />
          ) : (
            <CaretRight className="size-3 text-muted" aria-hidden="true" />
          )}
          <Brain className="size-3.5 text-muted" aria-hidden="true" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted">
            {streaming ? "Thinking..." : "Reasoning"}
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted">{text.length} chars</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-2 text-xs font-mono text-muted whitespace-pre-wrap max-h-60 overflow-y-auto bg-background/40">
          {text}
        </div>
      )}
    </div>
  );
}

function ChangedFilesStrip({
  files,
  projectPath,
  onFileClick,
}: {
  files: string[];
  projectPath: string | null;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  return (
    <div className="mt-2 pt-1.5 border-t border-border/60">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted hover:text-foreground"
      >
        {expanded ? (
          <CaretDown className="size-2.5" aria-hidden="true" />
        ) : (
          <CaretRight className="size-2.5" aria-hidden="true" />
        )}
        <span>Changed Files ({files.length})</span>
      </button>
      {expanded && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {files.map((fp) => {
            const rel = toRelativeProjectPath(fp, projectPath);
            return (
              <button
                key={fp}
                type="button"
                onClick={() => onFileClick?.(rel)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono border border-border bg-surface-secondary hover:border-foreground text-foreground"
              >
                <FileText className="size-3 text-muted" aria-hidden="true" />
                <span>{rel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  isLast,
  isStreaming,
  projectPath,
  projectFiles,
  onFileClick,
}: {
  message: AgentMessage;
  isLast: boolean;
  isStreaming: boolean;
  projectPath: string | null;
  projectFiles: string[];
  onFileClick?: (path: string) => void;
}) {
  // Build parent -> child tool call hierarchy
  const { childToolsByParent, knownCallIds } = useMemo(() => {
    const tools = message.parts.filter((p): p is ToolPart => p.type === "tool");
    const callIdSet = new Set(tools.map((t) => t.callId));
    const childMap = new Map<string, ToolPart[]>();
    for (const t of tools) {
      if (t.parentToolCallId && callIdSet.has(t.parentToolCallId)) {
        const list = childMap.get(t.parentToolCallId) ?? [];
        list.push(t);
        childMap.set(t.parentToolCallId, list);
      }
    }
    return { childToolsByParent: childMap, knownCallIds: callIdSet };
  }, [message.parts]);

  return (
    <div className="space-y-1.5 py-2 border-b border-border/50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-muted">
        <div className="flex items-center gap-1.5">
          {message.providerId && (
            <ProviderIcon providerId={message.providerId} className="size-3 text-foreground" />
          )}
          <span className="uppercase tracking-wider text-foreground-secondary font-medium">
            {message.model || message.providerId || "Assistant"}
          </span>
          {isLast && isStreaming && (
            <span className="inline-flex items-center gap-1 text-foreground">
              <SpinnerGap className="size-3 animate-spin" aria-hidden="true" />
              <span>streaming</span>
            </span>
          )}
        </div>
        <span>{formatRelativeTime(message.createdAt)}</span>
      </div>

      <div className="space-y-1">
        {message.parts.map((part) => {
          if (part.type === "reasoning") {
            return (
              <ReasoningBlock key={part.id} text={part.text} streaming={isLast && isStreaming} />
            );
          }
          if (part.type === "tool") {
            // Skip child tools that are already nested under their parent
            if (part.parentToolCallId && knownCallIds.has(part.parentToolCallId)) {
              return null;
            }
            return (
              <ToolDisplay
                key={part.id}
                part={part}
                childrenTools={childToolsByParent.get(part.callId) ?? EMPTY_TOOLS}
                projectPath={projectPath}
                onFileClick={onFileClick}
              />
            );
          }
          if (part.type === "text") {
            if (!part.text.trim()) return null;
            return (
              <MarkdownText
                key={part.id}
                text={part.text}
                projectFiles={projectFiles}
                onFileClick={onFileClick}
              />
            );
          }
          if (part.type === "image") {
            return (
              <div
                key={part.id}
                className="border border-border bg-surface-secondary p-1 inline-block"
              >
                <Image
                  unoptimized
                  src={part.url}
                  alt={part.filename ?? "Attachment"}
                  width={320}
                  height={240}
                  className="max-h-48 w-auto h-auto object-contain"
                />
              </div>
            );
          }
          return null;
        })}
      </div>

      {message.error && (
        <div className="p-2 border border-error/50 bg-error/10 text-xs font-mono text-error flex items-start gap-2">
          <WarningCircle className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="break-words">{message.error}</span>
        </div>
      )}

      <ChangedFilesStrip
        files={message.changedFiles}
        projectPath={projectPath}
        onFileClick={onFileClick}
      />
    </div>
  );
});

export const MessageTimeline = memo(function MessageTimeline({
  thread,
  projectPath,
  projectFiles,
  activeFile,
  onFileClick,
  onQuickPrompt,
  onRespondInteraction,
}: MessageTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom < 64;
    pinnedToBottomRef.current = pinned;
    setShowJumpToLatest(!pinned && el.scrollHeight > el.clientHeight + 120);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  const messages = thread?.messages ?? [];
  const lastMsg = messages[messages.length - 1];
  const lastContentSig = lastMsg
    ? `${lastMsg.id}:${lastMsg.parts.length}:${lastMsg.parts
        .map((p) => (p.type === "text" || p.type === "reasoning" ? p.text.length : p.id))
        .join(",")}`
    : "";

  const threadId = thread?.summary.id;
  const pendingInteraction = thread?.pendingInteraction ?? null;
  const scrollTrigger = `${messages.length}:${lastContentSig}:${pendingInteraction?.id ?? ""}`;

  // Reset scroll pin when switching threads
  useEffect(() => {
    void threadId;
    pinnedToBottomRef.current = true;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [threadId, scrollToBottom]);

  // Auto-follow while pinned to bottom during streaming
  useEffect(() => {
    if (!scrollTrigger || !pinnedToBottomRef.current) return;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [scrollTrigger, scrollToBottom]);

  const activeRelFile = activeFile ? toRelativeProjectPath(activeFile, projectPath) : null;

  const quickPrompts = [
    activeRelFile
      ? `Proofread and tighten the writing in @${activeRelFile} while keeping technical precision.`
      : "Review the paper structure and suggest improvements.",
    "Fix any LaTeX compilation errors or warnings in this project.",
    activeRelFile
      ? `Add clear equations and citations where helpful in @${activeRelFile}.`
      : "Help organize sections, figures, and bibliography.",
    "Summarize the main contributions and check consistency across sections.",
  ];

  const isRunning = thread?.summary.status === "running";

  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {messages.length === 0 ? (
          <div className="py-6 space-y-4">
            <div className="border border-border bg-surface-secondary p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider font-semibold">
                <Sparkle className="size-3.5" aria-hidden="true" />
                <span>LaTeX Research Assistant</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                Ask the agent to draft sections, verify proofs, manage bibliography citations, or
                resolve LaTeX build errors. Type <code className="font-mono">/</code> for commands
                or <code className="font-mono">@</code> to reference project files.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted">
                Quick Starters
              </div>
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onQuickPrompt(prompt)}
                  className="w-full text-left px-2.5 py-2 border border-border bg-background hover:border-foreground hover:bg-surface-secondary text-xs text-foreground transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => {
            if (msg.role === "user") {
              const images = msg.parts.filter(
                (p): p is Extract<AgentPart, { type: "image" }> => p.type === "image",
              );
              const textParts = msg.parts.filter(
                (p): p is Extract<AgentPart, { type: "text" }> => p.type === "text",
              );

              return (
                <div
                  key={msg.id}
                  className="border border-border bg-surface-secondary p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-muted">
                    <span>You</span>
                    <span>{formatRelativeTime(msg.createdAt)}</span>
                  </div>

                  {images.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {images.map((img) => (
                        <Image
                          unoptimized
                          key={img.id}
                          src={img.url}
                          alt={img.filename ?? "Attachment"}
                          width={160}
                          height={80}
                          className="h-20 w-auto border border-border object-contain bg-background"
                        />
                      ))}
                    </div>
                  )}

                  {textParts.map((tp) => (
                    <div
                      key={tp.id}
                      className="text-xs font-mono text-foreground whitespace-pre-wrap break-words leading-relaxed"
                    >
                      {tp.text}
                    </div>
                  ))}
                </div>
              );
            }

            const isLastMsg = idx === messages.length - 1;
            return (
              <AssistantMessageItem
                key={msg.id}
                message={msg}
                isLast={isLastMsg}
                isStreaming={isLastMsg && Boolean(isRunning)}
                projectPath={projectPath}
                projectFiles={projectFiles}
                onFileClick={onFileClick}
              />
            );
          })
        )}

        {/* Interactive cards when agent requests input/approval/plan confirmation */}
        {pendingInteraction && (
          <div>
            {pendingInteraction.kind === "question" && (
              <QuestionCard
                key={pendingInteraction.id}
                interaction={pendingInteraction}
                onSubmit={(answers) =>
                  onRespondInteraction(pendingInteraction.id, {
                    kind: "questionAnswer",
                    answers,
                    dismissed: false,
                  })
                }
                onDismiss={() =>
                  onRespondInteraction(pendingInteraction.id, {
                    kind: "questionAnswer",
                    answers: {},
                    dismissed: true,
                  })
                }
              />
            )}
            {pendingInteraction.kind === "approval" && (
              <ApprovalCard
                key={pendingInteraction.id}
                interaction={pendingInteraction}
                onDecide={(decision) =>
                  onRespondInteraction(pendingInteraction.id, {
                    kind: "approvalDecision",
                    decision: decision.decision,
                    optionId: decision.optionId,
                    reason: decision.reason,
                  })
                }
              />
            )}
            {pendingInteraction.kind === "planApproval" && (
              <PlanApprovalCard
                key={pendingInteraction.id}
                interaction={pendingInteraction}
                onDecide={(approved, feedback) =>
                  onRespondInteraction(pendingInteraction.id, {
                    kind: "planDecision",
                    approved,
                    feedback,
                  })
                }
              />
            )}
          </div>
        )}
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-3 right-3 z-20 px-2.5 py-1 border border-foreground bg-background text-foreground shadow-[2px_2px_0_0_var(--foreground)] text-[10px] font-mono uppercase tracking-wider inline-flex items-center gap-1 hover:bg-surface-secondary"
        >
          <ArrowDown className="size-3" aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
});
