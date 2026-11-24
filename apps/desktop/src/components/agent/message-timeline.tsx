"use client";

import { ArrowDown, CaretDown, CaretRight, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import Image from "next/image";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

/**
 * Live streaming thought trace:
 * - While reasoning is actively streaming, displays a calm muted live feed with elapsed timer.
 * - Once answer text arrives or the turn finishes, folds quietly into a single clickable row
 *   ("Thought for Ns ›") unless the user explicitly toggled it open.
 */
function ReasoningBlock({
  text,
  streaming,
  hasFollowingContent,
}: {
  text: string;
  streaming: boolean;
  hasFollowingContent: boolean;
}) {
  const isActivelyThinking = streaming && !hasFollowingContent;
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const startTimeRef = useRef<number | null>(null);
  const streamRef = useRef<HTMLElement>(null);
  const streamId = useId();
  const followStreamRef = useRef(true);
  const expanded = userExpanded ?? isActivelyThinking;

  useEffect(() => {
    if (isActivelyThinking) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
      const id = window.setInterval(() => {
        if (startTimeRef.current !== null) {
          setElapsedSec(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
        }
      }, 500);
      return () => window.clearInterval(id);
    }
    if (startTimeRef.current !== null) {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
      startTimeRef.current = null;
    }
    return undefined;
  }, [isActivelyThinking]);

  // Keep live thought trace scrolled to the newest line while thinking
  useEffect(() => {
    const stream = streamRef.current;
    if (text && isActivelyThinking && expanded && followStreamRef.current && stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [expanded, isActivelyThinking, text]);

  const label = isActivelyThinking
    ? elapsedSec > 0
      ? `Thinking · ${elapsedSec}s`
      : "Thinking…"
    : elapsedSec > 0
      ? `Thought for ${elapsedSec}s`
      : "Thought process";

  return (
    <div className={expanded ? "my-1 rounded-lg border border-border bg-subtle/40" : "my-0.5"}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={streamId}
        onClick={() => {
          if (!expanded) followStreamRef.current = true;
          setUserExpanded(!expanded);
        }}
        className={
          expanded
            ? "flex min-h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-muted hover:bg-subtle hover:text-foreground transition-colors"
            : "text-[12px] italic text-muted hover:text-foreground inline-flex items-center gap-1.5 py-0.5 transition-colors"
        }
      >
        {expanded ? (
          <CaretDown className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <CaretRight className="size-3 shrink-0" aria-hidden="true" />
        )}
        <span className={expanded ? "font-medium tabular-nums" : "tabular-nums"}>{label}</span>
        {isActivelyThinking && (
          <SpinnerGap
            className="ml-auto size-3.5 shrink-0 motion-safe:animate-spin"
            aria-hidden="true"
          />
        )}
      </button>

      <div id={streamId} hidden={!expanded}>
        <section
          ref={streamRef}
          aria-label="Thought trace"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: WebKit needs a focusable target for keyboard scrolling.
          tabIndex={0}
          onScroll={(event) => {
            const stream = event.currentTarget;
            followStreamRef.current =
              stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 8;
          }}
          className={`border-t border-border px-3 py-2 text-[12px] leading-relaxed text-muted whitespace-pre-wrap wrap-anywhere overflow-y-auto overscroll-contain ${
            isActivelyThinking ? "max-h-36" : "max-h-60"
          }`}
        >
          {text}
        </section>
      </div>
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

  const hasAnyVisibleParts = message.parts.some(
    (p) =>
      p.type === "tool" ||
      p.type === "image" ||
      ((p.type === "text" || p.type === "reasoning") && p.text.trim().length > 0),
  );

  const voice = message.providerId === "custom-acp" ? "custom" : message.providerId;
  const voiceInk = voice ? `var(--voice-${voice}-ink)` : "var(--line)";
  const voiceText = voice ? `var(--voice-${voice}-text)` : "var(--text-muted)";
  const providerDisplayName =
    message.providerId === "claude"
      ? "Claude"
      : message.providerId === "codex"
        ? "Codex"
        : message.providerId === "antigravity"
          ? "Antigravity"
          : message.providerId === "custom-acp"
            ? "Custom ACP"
            : "Assistant";

  const lastVisibleTextIdx = (() => {
    for (let i = message.parts.length - 1; i >= 0; i -= 1) {
      const p = message.parts[i];
      if (p?.type === "text" && p.text.trim().length > 0) return i;
    }
    return -1;
  })();

  return (
    <div className="space-y-2 py-1 border-l-2 pl-3" style={{ borderColor: voiceInk }}>
      <div className="text-[11.5px] font-semibold leading-none" style={{ color: voiceText }}>
        {providerDisplayName}
      </div>
      <div className="space-y-1.5">
        {message.parts.map((part, idx) => {
          if (part.type === "reasoning") {
            const hasFollowing = message.parts
              .slice(idx + 1)
              .some(
                (next) =>
                  next.type === "tool" ||
                  next.type === "image" ||
                  ((next.type === "text" || next.type === "reasoning") &&
                    next.text.trim().length > 0),
              );
            return (
              <ReasoningBlock
                key={part.id}
                text={part.text}
                streaming={isLast && isStreaming}
                hasFollowingContent={hasFollowing}
              />
            );
          }
          if (part.type === "tool") {
            if (idx > 0 && message.parts[idx - 1]?.type === "tool") return null;
            const group: ToolPart[] = [];
            for (const next of message.parts.slice(idx)) {
              if (next.type !== "tool") break;
              if (!next.parentToolCallId || !knownCallIds.has(next.parentToolCallId))
                group.push(next);
            }
            if (group.length === 0) return null;
            return (
              <div key={part.id} className="space-y-0.5 py-0.5">
                {group.map((tool) => (
                  <ToolDisplay
                    key={tool.id}
                    part={tool}
                    childrenTools={childToolsByParent.get(tool.callId) ?? EMPTY_TOOLS}
                    projectPath={projectPath}
                    onFileClick={onFileClick}
                  />
                ))}
              </div>
            );
          }
          if (part.type === "text") {
            if (!part.text.trim()) return null;
            const showStreamingCursor = isLast && isStreaming && idx === lastVisibleTextIdx;
            return (
              <div key={part.id}>
                <MarkdownText
                  text={part.text}
                  projectFiles={projectFiles}
                  onFileClick={onFileClick}
                />
                {showStreamingCursor && (
                  <span
                    className="inline-block w-[7px] h-[14px] rounded-[1px] ml-1 align-[-2px] animate-pulse"
                    style={{ backgroundColor: voiceInk }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          }
          if (part.type === "image") {
            return (
              <div
                key={part.id}
                className="rounded-xl border border-border bg-subtle p-1 inline-block overflow-hidden"
              >
                <Image
                  unoptimized
                  src={part.url}
                  alt={part.filename ?? "Attachment"}
                  width={320}
                  height={240}
                  className="max-h-48 w-auto h-auto rounded-lg object-contain"
                />
              </div>
            );
          }
          return null;
        })}

        {isLast && isStreaming && !hasAnyVisibleParts && (
          <output className="flex items-center gap-2 py-1 text-[12.5px] text-muted">
            <SpinnerGap className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            Working…
          </output>
        )}
      </div>

      {message.error && (
        <div className="p-2.5 rounded-xl border border-error/30 bg-error-bg text-[12px] text-error flex items-start gap-2">
          <WarningCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="break-words">{message.error}</span>
        </div>
      )}

      {!isStreaming && hasAnyVisibleParts && (
        <div className="flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
          {message.providerId && (
            <ProviderIcon providerId={message.providerId} className="size-3 opacity-80" />
          )}
          <span>{message.model || message.providerId || "Assistant"}</span>
          <span>·</span>
          <span>{formatRelativeTime(message.createdAt)}</span>
        </div>
      )}
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

  useEffect(() => {
    void threadId;
    pinnedToBottomRef.current = true;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [threadId, scrollToBottom]);

  useEffect(() => {
    if (!scrollTrigger || !pinnedToBottomRef.current) return;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [scrollTrigger, scrollToBottom]);

  const activeRelFile = activeFile ? toRelativeProjectPath(activeFile, projectPath) : null;

  const quickPrompts = [
    {
      label: activeRelFile ? `Proofread ${activeRelFile}` : "Review paper structure",
      prompt: activeRelFile
        ? `Proofread and tighten the writing in @${activeRelFile} while keeping technical precision.`
        : "Review the paper structure and suggest improvements.",
    },
    {
      label: "Fix LaTeX build errors",
      prompt: "Fix any LaTeX compilation errors or warnings in this project.",
    },
    {
      label: activeRelFile
        ? `Check equations in ${activeRelFile}`
        : "Organize citations & sections",
      prompt: activeRelFile
        ? `Verify equations, notation consistency, and citations in @${activeRelFile}.`
        : "Help organize sections, figures, and bibliography.",
    },
  ];

  const isRunning = thread?.summary.status === "running";

  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-3 py-3 space-y-4">
          {messages.length === 0 ? (
            <div className="py-4 space-y-4">
              <div className="flex flex-wrap items-start gap-1.5">
                {quickPrompts.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => onQuickPrompt(item.prompt)}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-left text-[12px] font-medium text-foreground transition-colors hover:bg-subtle hover:border-border-dark"
                  >
                    <span>{item.label}</span>
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
                  <div key={msg.id} className="space-y-1.5">
                    <div className="text-[11.5px] font-semibold text-foreground-strong">You</div>
                    <div className="space-y-2 text-[13.5px] leading-[1.6] text-foreground">
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
                              className="h-20 w-auto rounded-lg border border-border object-contain bg-panel"
                            />
                          ))}
                        </div>
                      )}

                      {textParts.map((tp) => (
                        <div
                          key={tp.id}
                          className="text-[13px] whitespace-pre-wrap break-words leading-relaxed"
                        >
                          {tp.text}
                        </div>
                      ))}
                    </div>
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
                  sessionDirectory={thread?.summary.workspacePath ?? projectPath}
                  providerLabel={
                    thread?.summary.providerId === "claude"
                      ? "Claude"
                      : thread?.summary.providerId === "codex"
                        ? "Codex"
                        : thread?.summary.providerId === "antigravity"
                          ? "Antigravity"
                          : "Custom ACP"
                  }
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
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full border border-border bg-panel text-foreground text-[12px] font-medium inline-flex items-center gap-1.5 hover:bg-subtle transition-colors"
          style={{ boxShadow: "var(--shadow-2)" }}
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
          <span>Latest</span>
        </button>
      )}
    </div>
  );
});
