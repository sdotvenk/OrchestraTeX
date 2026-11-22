"use client";

import type { FileNode } from "@orchestratex/shared";
import { Gear, GitFork, ListBullets, Plugs, Plus, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentProviderId,
  AgentSettings,
  AttachmentInput,
  InteractionMode,
  RuntimeMode,
} from "@/lib/agent/types";
import type { useAgent } from "@/lib/agent/use-agent";
import { AgentComposer } from "./agent-composer";
import { ProviderIcon } from "./icons";
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
  draftInjection?: { id: number; text: string } | null;
  onDraftConsumed?: () => void;
  onFileClick?: (path: string) => void;
  onRunTerminalCommand: (command: string) => void;
  onOpenAgentSettings: () => void;
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
  onClose,
}: AgentPanelProps) {
  const [view, setView] = useState<"chat" | "threads" | "providers">("chat");

  const projectFiles = useMemo(() => flattenFileNodes(files, projectPath), [files, projectPath]);

  const activeThread = agent.activeThread;
  const activeProvider = agent.activeProviderStatus;
  const currentProviderId =
    activeThread?.summary.providerId ?? activeProvider?.id ?? agentSettings.defaultProvider;

  // Automatically surface setup onboarding if providers finished loading and active provider isn't ready
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

  return (
    <div className="h-full w-full flex flex-col bg-background min-w-0">
      {/* Header Toolbar */}
      <div className="h-9 px-2.5 border-b border-border flex items-center justify-between gap-1.5 bg-surface-secondary shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={() => setView((v) => (v === "threads" ? "chat" : "threads"))}
            className={`inline-flex items-center gap-1.5 px-1.5 py-1 text-xs font-mono border transition-colors min-w-0 ${
              view === "threads"
                ? "border-foreground bg-foreground text-background"
                : "border-transparent hover:border-border text-foreground"
            }`}
            title="Switch or manage threads"
          >
            <ListBullets className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate max-w-[130px]">
              {activeThread?.summary.title || "New Chat"}
            </span>
          </button>

          <button
            type="button"
            disabled={!projectPath}
            onClick={() => {
              void agent.createThread();
              setView("chat");
            }}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary disabled:opacity-40 shrink-0"
            title="New thread"
            aria-label="New thread"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>

          {activeThread && activeProvider?.supportsFork && (
            <button
              type="button"
              onClick={() => {
                void agent.forkThread(activeThread.summary.id);
                setView("chat");
              }}
              className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary shrink-0"
              title="Fork current thread"
              aria-label="Fork thread"
            >
              <GitFork className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <UsagePopover
            open={usageOpen}
            onOpenChange={onUsageOpenChange}
            provider={activeProvider}
            usage={activeThread?.usage}
            threadStatus={activeThread?.summary.status}
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

          <button
            type="button"
            onClick={() => setView((v) => (v === "providers" ? "chat" : "providers"))}
            className={`p-1 border transition-colors ${
              view === "providers"
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background hover:bg-surface-tertiary text-foreground"
            }`}
            title="Agent providers & auth status"
            aria-label="Agent providers"
          >
            {activeProvider ? (
              <ProviderIcon providerId={activeProvider.id} className="size-3.5" />
            ) : (
              <Plugs className="size-3.5" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenAgentSettings}
            className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary"
            title="Agent & LaTeX settings"
            aria-label="Open agent settings"
          >
            <Gear className="size-3.5" aria-hidden="true" />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-muted hover:text-foreground hover:bg-surface-tertiary"
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
        <div className="px-3 py-1.5 border-b border-error/40 bg-error/10 flex items-center justify-between gap-2 text-xs font-mono text-error">
          <div className="flex items-center gap-1.5 min-w-0">
            <WarningCircle className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" title={agent.error}>
              {agent.error}
            </span>
          </div>
          <button
            type="button"
            onClick={agent.clearError}
            className="p-0.5 hover:opacity-75 shrink-0"
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
          onCreateThread={() => void agent.createThread()}
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
          onClose={() => setView("chat")}
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
          />
        </>
      )}
    </div>
  );
}
