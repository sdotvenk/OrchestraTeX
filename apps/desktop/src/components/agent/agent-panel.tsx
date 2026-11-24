"use client";

import type { FileNode } from "@orchestratex/shared";
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretDown,
  Chats,
  GitFork,
  Plus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AgentSettings,
  AttachmentInput,
  InteractionMode,
  RuntimeMode,
} from "@/lib/agent/types";
import type { useAgent } from "@/lib/agent/use-agent";
import { AgentComposer, type AgentDraftInjection } from "./agent-composer";
import { MessageTimeline } from "./message-timeline";
import { ProviderOnboarding } from "./provider-onboarding";
import { TasksDisplay } from "./tasks-display";
import { ThreadList } from "./thread-list";
import { UsagePopover } from "./usage-popover";
import { flattenFileNodes } from "./utils";

type UseAgentReturn = ReturnType<typeof useAgent>;

interface AgentPanelProps {
  agent: UseAgentReturn;
  agentSettings: AgentSettings;
  onUpdateAgentSettings: (patch: Partial<AgentSettings>) => void;
  onSetDefaultModel: (providerId: AgentProviderId, modelId: string) => void;
  onSetDefaultEffort: (providerId: AgentProviderId, effort: string) => void;
  projectPath: string | null;
  files: FileNode[];
  activeFile?: string | null;
  usageOpen: boolean;
  onUsageOpenChange: (open: boolean) => void;
  draftInjection?: AgentDraftInjection | null;
  onDraftConsumed?: () => void;
  onFileClick?: (path: string) => void;
  onRunTerminalCommand: (command: string) => void;
  onOpenAgentSettings: () => void;
  onOpenWorkspace?: () => void;
  onApproveInteraction?: (threadId: string, interactionId: string) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
}

export function AgentPanel({
  agent,
  agentSettings,
  onUpdateAgentSettings,
  onSetDefaultModel,
  onSetDefaultEffort,
  projectPath,
  files,
  activeFile,
  usageOpen,
  onUsageOpenChange,
  draftInjection,
  onDraftConsumed,
  onFileClick,
  onRunTerminalCommand,
  onOpenAgentSettings,
  onOpenWorkspace,
  onApproveInteraction,
  isExpanded = false,
  onToggleExpand,
  onClose,
}: AgentPanelProps) {
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"chat" | "threads" | "providers">("chat");

  const projectFiles = useMemo(() => flattenFileNodes(files, projectPath), [files, projectPath]);

  const activeThread = agent.activeThread;
  const activeProvider = agent.activeProviderStatus;
  const currentProviderId =
    activeThread?.summary.providerId ?? activeProvider?.id ?? agentSettings.defaultProvider;

  const [userBypassedOnboarding, setUserBypassedOnboarding] = useState(false);
  const anyReadyProvider = useMemo(
    () => agent.providers.some((p) => p.installed && p.authenticated),
    [agent.providers],
  );
  const needsOnboarding =
    !userBypassedOnboarding &&
    agent.providers.length > 0 &&
    !agent.loadingProviders &&
    (!activeProvider?.installed || !activeProvider.authenticated) &&
    !activeThread?.messages.length;

  useEffect(() => {
    if (anyReadyProvider) {
      setUserBypassedOnboarding(false);
    }
  }, [anyReadyProvider]);

  const handleSelectProvider = async (providerId: AgentProviderId) => {
    onUpdateAgentSettings({ defaultProvider: providerId });
    const targetProvider = agent.providers.find((p) => p.id === providerId);
    const savedModel = agentSettings.defaultModelByProvider[providerId];
    const defaultModel =
      savedModel ??
      targetProvider?.models.find((m) => m.isDefault)?.id ??
      targetProvider?.models[0]?.id;
    const modelInfo = targetProvider?.models.find((m) => m.id === defaultModel);
    const savedEffort = agentSettings.defaultEffortByProvider[providerId];
    const defaultEffort = modelInfo?.supportsEffort
      ? (savedEffort ?? modelInfo.defaultEffort ?? undefined)
      : undefined;

    if (activeThread) {
      await agent.updateThread(activeThread.summary.id, {
        providerId,
        model: defaultModel ?? "",
        reasoningEffort: defaultEffort ?? "",
      });
    }
  };

  const handleChangeModel = async (modelId: string) => {
    onSetDefaultModel(currentProviderId, modelId);
    const modelInfo = activeProvider?.models.find((m) => m.id === modelId);
    const effort = modelInfo?.supportsEffort
      ? (agentSettings.defaultEffortByProvider[currentProviderId] ??
        modelInfo.defaultEffort ??
        modelInfo.supportedEffortLevels[0] ??
        "")
      : "";
    if (activeThread) {
      await agent.updateThread(activeThread.summary.id, {
        model: modelId,
        reasoningEffort: effort,
      });
    }
  };

  const handleChangeEffort = async (effort: string) => {
    onSetDefaultEffort(currentProviderId, effort);
    if (activeThread) {
      await agent.updateThread(activeThread.summary.id, {
        reasoningEffort: effort,
      });
    }
  };

  const handleChangeInteractionMode = async (mode: InteractionMode) => {
    onUpdateAgentSettings({ defaultInteractionMode: mode });
    if (activeThread) {
      await agent.updateThread(activeThread.summary.id, {
        interactionMode: mode,
      });
    }
  };

  const handleChangeRuntimeMode = async (mode: RuntimeMode) => {
    onUpdateAgentSettings({ defaultRuntimeMode: mode });
    if (activeThread) {
      await agent.updateThread(activeThread.summary.id, {
        runtimeMode: mode,
      });
    }
  };

  const handleSend = async (content: string, attachments?: AttachmentInput[]) => {
    setUserBypassedOnboarding(true);
    setView("chat");
    await agent.sendMessage(content, attachments);
  };

  const queuedForActive = activeThread ? (agent.queuesByThread[activeThread.summary.id] ?? []) : [];
  const closeThreads = () => {
    setView("chat");
    chatToggleRef.current?.focus();
  };

  return (
    <div className="h-full w-full flex flex-col bg-panel min-w-0">
      {/* Calm Silkscreen-style Agent Header */}
      <div className="h-10 px-3 border-b border-border flex items-center justify-between gap-2 bg-panel shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            ref={chatToggleRef}
            type="button"
            aria-expanded={view === "threads"}
            onClick={() => setView((v) => (v === "threads" ? "chat" : "threads"))}
            className={`inline-flex items-center gap-1.5 h-7 px-2 -ml-1 rounded-lg text-[13px] font-semibold transition-colors min-w-0 ${
              view === "threads"
                ? "bg-accent-soft text-accent"
                : "text-foreground-strong hover:bg-subtle"
            }`}
            title="Switch or manage chats"
          >
            <Chats className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">
              {view === "threads" ? "Chats" : activeThread?.summary.title || "New chat"}
            </span>
            <CaretDown className="size-3 text-muted shrink-0" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            disabled={!projectPath}
            onClick={() => {
              void agent.createThread();
              setView("chat");
            }}
            className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle disabled:opacity-40 transition-colors"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>

          {activeThread && activeProvider?.supportsFork && (
            <button
              type="button"
              onClick={() => {
                void agent.forkThread(activeThread.summary.id);
                setView("chat");
              }}
              className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
              title="Fork current chat"
              aria-label="Fork chat"
            >
              <GitFork className="size-3.5" aria-hidden="true" />
            </button>
          )}

          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
              title={isExpanded ? "Restore pane width" : "Expand agent pane"}
              aria-label={isExpanded ? "Restore pane width" : "Expand agent pane"}
            >
              {isExpanded ? (
                <ArrowsInSimple className="size-3.5" aria-hidden="true" />
              ) : (
                <ArrowsOutSimple className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="size-7 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
              title="Hide Agent Panel (Cmd+L)"
              aria-label="Close agent panel"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Tasks Progress Bar */}
      {view === "chat" && activeThread && activeThread.tasks.length > 0 && (
        <TasksDisplay tasks={activeThread.tasks} />
      )}

      {/* Global / Turn Error Banner */}
      {agent.error && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-xl border border-error/30 bg-error-bg flex items-center justify-between gap-2 text-[12px] text-error">
          <div className="flex items-center gap-2 min-w-0">
            <WarningCircle className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate" title={agent.error}>
              {agent.error}
            </span>
          </div>
          <button
            type="button"
            onClick={agent.clearError}
            className="size-5 rounded-md inline-flex items-center justify-center hover:bg-panel/50 shrink-0"
            aria-label="Dismiss error"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Body View */}
      {view === "threads" ? (
        <ThreadList
          threads={agent.threads}
          activeThreadId={activeThread?.summary.id}
          providers={agent.providers}
          onSelectThread={(id) => void agent.loadThread(id)}
          onRenameThread={async (id, title) => {
            await agent.updateThread(id, { title });
          }}
          onTogglePin={async (id, pinned) => {
            await agent.updateThread(id, { pinned });
          }}
          onForkThread={async (id) => {
            await agent.forkThread(id);
          }}
          onDeleteThread={agent.deleteThread}
          onClose={closeThreads}
        />
      ) : view === "providers" || needsOnboarding ? (
        <ProviderOnboarding
          providers={agent.providers}
          activeProviderId={currentProviderId}
          loading={agent.loadingProviders}
          onSelectProvider={(pid) => {
            void handleSelectProvider(pid);
          }}
          onRunTerminalCommand={onRunTerminalCommand}
          onRefreshProviders={agent.refreshProviders}
          onOpenSettings={onOpenAgentSettings}
          onDismiss={() => {
            setUserBypassedOnboarding(true);
            setView("chat");
          }}
        />
      ) : (
        <>
          <MessageTimeline
            thread={activeThread}
            projectPath={projectPath}
            projectFiles={projectFiles}
            activeFile={activeFile}
            onFileClick={onFileClick}
            onQuickPrompt={(prompt) => void handleSend(prompt)}
            onRespondInteraction={async (interactionId, response) => {
              if (!activeThread) return;
              await agent.respondInteraction(activeThread.summary.id, interactionId, response);
              if (
                (response.kind === "approvalDecision" && response.decision !== "deny") ||
                (response.kind === "planDecision" && response.approved)
              ) {
                onApproveInteraction?.(activeThread.summary.id, interactionId);
              }
            }}
          />

          <AgentComposer
            projectPath={projectPath}
            files={files}
            providers={agent.providers}
            activeThread={activeThread}
            activeProviderStatus={activeProvider}
            slashCommands={agent.availableSlashCommands}
            queuedMessages={queuedForActive}
            defaultProvider={agentSettings.defaultProvider}
            defaultModelByProvider={agentSettings.defaultModelByProvider}
            defaultEffortByProvider={agentSettings.defaultEffortByProvider}
            defaultInteractionMode={agentSettings.defaultInteractionMode}
            defaultRuntimeMode={agentSettings.defaultRuntimeMode}
            draftInjection={draftInjection}
            onDraftConsumed={onDraftConsumed}
            onSendMessage={handleSend}
            onQueueMessage={agent.queueMessage}
            onRemoveQueuedMessage={agent.removeQueuedMessage}
            onSteerQueuedMessage={agent.steerQueuedMessage}
            onSteerActiveTurn={agent.steerTurn}
            onInterruptTurn={agent.interruptTurn}
            onChangeProvider={handleSelectProvider}
            onChangeModel={handleChangeModel}
            onChangeEffort={handleChangeEffort}
            onChangeInteractionMode={handleChangeInteractionMode}
            onChangeRuntimeMode={handleChangeRuntimeMode}
            onOpenWorkspace={onOpenWorkspace}
            workspaceLabel={activeThread?.summary.workspaceBranch ?? "Local"}
            onCompactContext={
              activeThread && activeProvider?.supportsCompact
                ? () => agent.compactThread(activeThread.summary.id)
                : undefined
            }
            usageTrigger={
              <UsagePopover
                open={usageOpen}
                onOpenChange={onUsageOpenChange}
                provider={activeProvider}
                usage={activeThread?.usage}
                threadStatus={activeThread?.summary.status}
                compactRing={true}
                onRefreshLimits={async () => {
                  if (activeProvider) {
                    await agent.refreshRateLimits(activeProvider.id);
                  } else {
                    await agent.refreshProviders();
                  }
                }}
                onCompact={
                  activeThread && activeProvider?.supportsCompact
                    ? () => agent.compactThread(activeThread.summary.id)
                    : undefined
                }
              />
            }
          />
        </>
      )}
    </div>
  );
}
