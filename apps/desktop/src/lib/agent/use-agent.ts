"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AgentSettings,
  AgentStreamEvent,
  AgentThread,
  AttachmentInput,
  InteractionMode,
  InteractionResponse,
  ProviderCustomConfig,
  ProviderStatus,
  QueuedMessage,
  RateLimitsSnapshot,
  RuntimeMode,
  SlashCommandInfo,
  ThreadSummary,
} from "./types";
import {
  type AgentState,
  applyAgentStreamEvent,
  applyPartDeltas,
  type BufferedDelta,
  createInitialAgentState,
  enqueueThreadMessage,
  removeQueuedThreadMessage,
  updateQueuedThreadMessage,
  upsertThreadSummary,
} from "./use-agent-reducer";
import { buildProviderCustomConfigs } from "./use-agent-settings";

export const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "new", description: "Start a new conversation thread" },
  { name: "clear", description: "Start a fresh thread in this project" },
  { name: "compact", description: "Compact thread context to reduce tokens" },
  {
    name: "plan",
    description: "Switch to Plan mode (architect before editing)",
    argumentHint: "[prompt]",
  },
  {
    name: "default",
    description: "Switch to Default coding/writing mode",
    argumentHint: "[prompt]",
  },
  { name: "fork", description: "Fork current thread into a new copy" },
  { name: "usage", description: "Open session token usage & rate limits" },
];

export interface UseAgentOptions {
  projectPath: string | null;
  settings: AgentSettings;
  onOpenUsage?: () => void;
}

export interface CreateThreadOptions {
  providerId?: AgentProviderId;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: InteractionMode;
  runtimeMode?: RuntimeMode;
  title?: string;
}

export interface UpdateThreadPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  providerId?: AgentProviderId;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: InteractionMode;
  runtimeMode?: RuntimeMode;
}

export function useAgent({ projectPath, settings, onOpenUsage }: UseAgentOptions) {
  const [state, setState] = useState<AgentState>(createInitialAgentState);

  const customProviders = settings.customProviders;
  const customConfigs = useMemo(
    () => buildProviderCustomConfigs({ customProviders }),
    [customProviders],
  );
  const customConfigsKey = useMemo(() => JSON.stringify(customConfigs), [customConfigs]);

  const projectPathRef = useRef(projectPath);
  const settingsRef = useRef(settings);
  const customConfigsRef = useRef(customConfigs);
  const stateRef = useRef(state);
  const onOpenUsageRef = useRef(onOpenUsage);

  projectPathRef.current = projectPath;
  settingsRef.current = settings;
  customConfigsRef.current = customConfigs;
  stateRef.current = state;
  onOpenUsageRef.current = onOpenUsage;

  const pendingDeltasRef = useRef<Map<string, BufferedDelta>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const dispatchingQueueIdsRef = useRef<Set<string>>(new Set());

  const drainPendingDeltas = useCallback((): BufferedDelta[] => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingDeltasRef.current.size === 0) {
      return [];
    }
    const items = Array.from(pendingDeltasRef.current.values());
    pendingDeltasRef.current.clear();
    return items;
  }, []);

  const scheduleDeltaFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (pendingDeltasRef.current.size === 0) return;
      const batch = Array.from(pendingDeltasRef.current.values());
      pendingDeltasRef.current.clear();
      setState((prev) => applyPartDeltas(prev, batch));
    });
  }, []);

  // Subscribe once to Rust `agent-event` stream
  useEffect(() => {
    let active = true;
    const unlistenPromise = listen<AgentStreamEvent>("agent-event", (event) => {
      if (!active) return;
      const payload = event.payload;
      if (payload.type === "partDelta") {
        const key = `${payload.threadId}::${payload.messageId}::${payload.partId}::${payload.partType}`;
        const existing = pendingDeltasRef.current.get(key);
        if (existing) {
          existing.delta += payload.delta;
        } else {
          pendingDeltasRef.current.set(key, {
            threadId: payload.threadId,
            messageId: payload.messageId,
            partId: payload.partId,
            partType: payload.partType,
            delta: payload.delta,
          });
        }
        scheduleDeltaFlush();
        return;
      }

      const buffered = drainPendingDeltas();
      setState((prev) => {
        const next = buffered.length > 0 ? applyPartDeltas(prev, buffered) : prev;
        return applyAgentStreamEvent(next, payload);
      });
    });

    return () => {
      active = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [drainPendingDeltas, scheduleDeltaFlush]);

  const refreshProviders = useCallback(async (overrideConfigs?: ProviderCustomConfig[]) => {
    setState((prev) => ({ ...prev, loadingProviders: true }));
    try {
      const providers = await invoke<ProviderStatus[]>("agent_list_providers", {
        customConfigs: overrideConfigs ?? customConfigsRef.current,
      });
      setState((prev) => ({
        ...prev,
        providers,
        loadingProviders: false,
      }));
      return providers;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        ...prev,
        loadingProviders: false,
        error: message,
      }));
      return [];
    }
  }, []);

  const refreshRateLimits = useCallback(async (providerId: AgentProviderId) => {
    const cfg = customConfigsRef.current.find((c) => c.providerId === providerId);
    const snap = await invoke<RateLimitsSnapshot | null>("agent_refresh_rate_limits", {
      providerId,
      customBinaryPath: cfg?.binaryPath,
    });
    if (snap) {
      setState((prev) => ({
        ...prev,
        providers: prev.providers.map((p) =>
          p.id === providerId ? { ...p, rateLimits: snap } : p,
        ),
      }));
    }
    return snap;
  }, []);

  const loadThread = useCallback(
    async (threadId: string, overrideProjectPath?: string): Promise<AgentThread | null> => {
      const targetProject = overrideProjectPath ?? projectPathRef.current;
      if (!targetProject) return null;
      const buffered = drainPendingDeltas();
      const loaded = await invoke<AgentThread>("agent_load_thread", {
        projectPath: targetProject,
        threadId,
      });
      setState((prev) => {
        const flushed = buffered.length > 0 ? applyPartDeltas(prev, buffered) : prev;
        return {
          ...flushed,
          activeThread: loaded,
          threads: upsertThreadSummary(flushed.threads, loaded.summary),
          error: null,
        };
      });
      return loaded;
    },
    [drainPendingDeltas],
  );

  const refreshThreads = useCallback(
    async (overrideProjectPath?: string) => {
      const targetProject = overrideProjectPath ?? projectPathRef.current;
      if (!targetProject) {
        setState((prev) => ({ ...prev, threads: [], activeThread: null }));
        return [];
      }
      setState((prev) => ({ ...prev, loadingThreads: true }));
      try {
        const threads = await invoke<ThreadSummary[]>("agent_list_threads", {
          projectPath: targetProject,
        });
        setState((prev) => ({
          ...prev,
          threads,
          loadingThreads: false,
        }));
        const currentActive = stateRef.current.activeThread;
        const activeMatchesProject = currentActive?.summary.projectPath === targetProject;
        if (!activeMatchesProject) {
          const first = threads.find((t) => !t.archived) ?? threads[0];
          if (first) {
            await loadThread(first.id, targetProject);
          } else {
            setState((prev) => ({ ...prev, activeThread: null }));
          }
        }
        return threads;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          loadingThreads: false,
          error: message,
        }));
        return [];
      }
    },
    [loadThread],
  );

  const hasProbedOnceRef = useRef(false);

  // Initial provider probe (immediate) & debounced re-probe only when custom CLI/ACP paths change
  useEffect(() => {
    void customConfigsKey;
    if (!hasProbedOnceRef.current) {
      hasProbedOnceRef.current = true;
      void refreshProviders(customConfigsRef.current);
      return;
    }
    const timer = setTimeout(() => {
      void refreshProviders(customConfigsRef.current);
    }, 500);
    return () => clearTimeout(timer);
  }, [refreshProviders, customConfigsKey]);

  // Reload project threads when workspace changes
  useEffect(() => {
    void refreshThreads(projectPath ?? undefined);
  }, [projectPath, refreshThreads]);

  const resolveDefaultProvider = useCallback((): AgentProviderId => {
    const preferred = settingsRef.current.defaultProvider;
    const providers = stateRef.current.providers;
    const preferredStatus = providers.find((p) => p.id === preferred);
    if (preferredStatus?.installed && preferredStatus.authenticated) {
      return preferred;
    }
    const ready = providers.find((p) => p.installed && p.authenticated);
    if (ready) return ready.id;
    const installed = providers.find((p) => p.installed);
    if (installed) return installed.id;
    return preferred;
  }, []);

  const resolveDefaultModelAndEffort = useCallback(
    (providerId: AgentProviderId, requestedModel?: string, requestedEffort?: string) => {
      const provider = stateRef.current.providers.find((p) => p.id === providerId);
      const savedModel = settingsRef.current.defaultModelByProvider[providerId];
      const fallbackModel =
        provider?.models.find((m) => m.isDefault)?.id ?? provider?.models[0]?.id;
      const model = requestedModel ?? savedModel ?? fallbackModel;
      const modelInfo = provider?.models.find((m) => m.id === model);
      const savedEffort = settingsRef.current.defaultEffortByProvider[providerId];
      const reasoningEffort =
        requestedEffort ??
        (modelInfo?.supportsEffort
          ? (savedEffort ?? modelInfo.defaultEffort ?? undefined)
          : undefined);
      return { model, reasoningEffort };
    },
    [],
  );

  const createThread = useCallback(
    async (opts?: CreateThreadOptions): Promise<AgentThread | null> => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return null;
      const providerId = opts?.providerId ?? resolveDefaultProvider();
      const { model, reasoningEffort } = resolveDefaultModelAndEffort(
        providerId,
        opts?.model,
        opts?.reasoningEffort,
      );
      const thread = await invoke<AgentThread>("agent_create_thread", {
        projectPath: targetProject,
        providerId,
        model,
        reasoningEffort,
        interactionMode: opts?.interactionMode ?? settingsRef.current.defaultInteractionMode,
        runtimeMode: opts?.runtimeMode ?? settingsRef.current.defaultRuntimeMode,
        title: opts?.title,
      });
      setState((prev) => ({
        ...prev,
        activeThread: thread,
        threads: upsertThreadSummary(prev.threads, thread.summary),
        error: null,
      }));
      return thread;
    },
    [resolveDefaultModelAndEffort, resolveDefaultProvider],
  );

  const updateThread = useCallback(
    async (threadId: string, patch: UpdateThreadPatch): Promise<ThreadSummary | null> => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return null;
      const updated = await invoke<ThreadSummary>("agent_update_thread", {
        projectPath: targetProject,
        threadId,
        ...patch,
      });
      setState((prev) => ({
        ...prev,
        threads: upsertThreadSummary(prev.threads, updated),
        activeThread:
          prev.activeThread?.summary.id === updated.id
            ? { ...prev.activeThread, summary: updated }
            : prev.activeThread,
      }));
      return updated;
    },
    [],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return;
      await invoke("agent_delete_thread", {
        projectPath: targetProject,
        threadId,
      });
      const remaining = stateRef.current.threads.filter((t) => t.id !== threadId);
      const wasActive = stateRef.current.activeThread?.summary.id === threadId;
      setState((prev) => {
        const nextQueues = { ...prev.queuesByThread };
        delete nextQueues[threadId];
        return {
          ...prev,
          threads: prev.threads.filter((t) => t.id !== threadId),
          activeThread: wasActive ? null : prev.activeThread,
          queuesByThread: nextQueues,
        };
      });
      if (wasActive) {
        const nextThread = remaining.find((t) => !t.archived) ?? remaining[0];
        if (nextThread) {
          await loadThread(nextThread.id, targetProject);
        }
      }
    },
    [loadThread],
  );

  const forkThread = useCallback(async (threadId: string): Promise<AgentThread | null> => {
    const targetProject = projectPathRef.current;
    if (!targetProject) return null;
    const summary = stateRef.current.threads.find((t) => t.id === threadId);
    const cfg = summary
      ? customConfigsRef.current.find((c) => c.providerId === summary.providerId)
      : undefined;
    const forked = await invoke<AgentThread>("agent_fork_thread", {
      projectPath: targetProject,
      threadId,
      customBinaryPath: cfg?.binaryPath,
    });
    setState((prev) => ({
      ...prev,
      activeThread: forked,
      threads: upsertThreadSummary(prev.threads, forked.summary),
      error: null,
    }));
    return forked;
  }, []);

  const compactThread = useCallback(async (threadId: string) => {
    const targetProject = projectPathRef.current;
    if (!targetProject) return;
    await invoke("agent_compact_thread", {
      projectPath: targetProject,
      threadId,
      customConfigs: customConfigsRef.current,
    });
  }, []);

  const interruptTurn = useCallback(async (threadId: string) => {
    const targetProject = projectPathRef.current;
    if (!targetProject) return;
    await invoke("agent_interrupt_turn", {
      projectPath: targetProject,
      threadId,
    });
  }, []);

  const respondInteraction = useCallback(
    async (threadId: string, interactionId: string, response: InteractionResponse) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return;
      await invoke("agent_respond_interaction", {
        projectPath: targetProject,
        threadId,
        interactionId,
        response,
      });
    },
    [],
  );

  const queueMessage = useCallback(
    (threadId: string, content: string, attachments: AttachmentInput[] = []) => {
      const trimmed = content.trim();
      if (!trimmed && attachments.length === 0) return;
      const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setState((prev) => enqueueThreadMessage(prev, threadId, content, attachments, id));
    },
    [],
  );

  const removeQueuedMessage = useCallback((threadId: string, queueId: string) => {
    setState((prev) => removeQueuedThreadMessage(prev, threadId, queueId));
  }, []);

  const updateQueuedMessage = useCallback((threadId: string, queueId: string, content: string) => {
    setState((prev) => updateQueuedThreadMessage(prev, threadId, queueId, content));
  }, []);

  const steerTurn = useCallback(
    async (threadId: string, content: string, attachments: AttachmentInput[] = []) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return;
      await invoke("agent_steer_turn", {
        projectPath: targetProject,
        threadId,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        customConfigs: customConfigsRef.current,
      });
    },
    [],
  );

  const dispatchMessageToThread = useCallback(
    async (threadId: string, content: string, attachments: AttachmentInput[] = []) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return;
      setState((prev) => ({ ...prev, sending: true, error: null }));
      try {
        await invoke("agent_send_message", {
          projectPath: targetProject,
          threadId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          customConfigs: customConfigsRef.current,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, error: message }));
        throw err;
      } finally {
        setState((prev) => ({ ...prev, sending: false }));
      }
    },
    [],
  );

  const steerQueuedMessage = useCallback(
    async (threadId: string, item: QueuedMessage) => {
      setState((prev) => removeQueuedThreadMessage(prev, threadId, item.id));
      const threadSummary =
        stateRef.current.activeThread?.summary.id === threadId
          ? stateRef.current.activeThread.summary
          : stateRef.current.threads.find((t) => t.id === threadId);
      const provider = threadSummary
        ? stateRef.current.providers.find((p) => p.id === threadSummary.providerId)
        : undefined;
      if (provider?.supportsSteer) {
        await steerTurn(threadId, item.content, item.attachments);
      } else {
        await interruptTurn(threadId);
        await dispatchMessageToThread(threadId, item.content, item.attachments);
      }
    },
    [dispatchMessageToThread, interruptTurn, steerTurn],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      attachments: AttachmentInput[] = [],
      opts?: { targetThreadId?: string; forceNewThread?: boolean },
    ) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) return;

      const trimmed = content.trim();
      if (!trimmed && attachments.length === 0) return;

      // Handle built-in client slash commands when no attachments override
      const spaceIdx = trimmed.indexOf(" ");
      const cmdToken = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
      const cmdRest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

      let thread: AgentThread | null = null;
      if (cmdToken === "/new" || cmdToken === "/clear") {
        const current = stateRef.current.activeThread?.summary;
        thread = await createThread(
          current
            ? {
                providerId: current.providerId,
                model: current.model ?? undefined,
                reasoningEffort: current.reasoningEffort ?? undefined,
                interactionMode: current.interactionMode,
                runtimeMode: current.runtimeMode,
              }
            : undefined,
        );
        if (!cmdRest) return;
      }

      if (cmdToken === "/usage" && !cmdRest) {
        onOpenUsageRef.current?.();
        return;
      }

      if (!thread) {
        const targetThreadId = opts?.targetThreadId;
        thread = opts?.forceNewThread
          ? null
          : targetThreadId
            ? stateRef.current.activeThread?.summary.id === targetThreadId
              ? stateRef.current.activeThread
              : await loadThread(targetThreadId)
            : stateRef.current.activeThread;
      }

      if (!thread || thread.summary.projectPath !== targetProject) {
        thread = await createThread();
      }
      if (!thread) return;

      if (cmdToken === "/fork" && !cmdRest) {
        await forkThread(thread.summary.id);
        return;
      }

      if (cmdToken === "/compact" && !cmdRest) {
        await compactThread(thread.summary.id);
        return;
      }

      if (cmdToken === "/plan" || cmdToken === "/default") {
        const targetMode: InteractionMode = cmdToken === "/plan" ? "plan" : "default";
        await updateThread(thread.summary.id, { interactionMode: targetMode });
        if (!cmdRest) return;
      }

      const finalText =
        (cmdToken === "/plan" ||
          cmdToken === "/default" ||
          cmdToken === "/new" ||
          cmdToken === "/clear") &&
        cmdRest
          ? cmdRest
          : content;

      // If this thread is currently mid-turn, queue rather than failing
      if (thread.summary.status === "running" || thread.summary.status === "waiting_input") {
        queueMessage(thread.summary.id, finalText, attachments);
        return;
      }

      await dispatchMessageToThread(thread.summary.id, finalText, attachments);
    },
    [
      compactThread,
      createThread,
      dispatchMessageToThread,
      forkThread,
      loadThread,
      queueMessage,
      updateThread,
    ],
  );

  // Auto-dispatch next queued message when active thread returns to idle
  const activeId = state.activeThread?.summary.id;
  const activeStatus = state.activeThread?.summary.status;
  const hasPendingInteraction = Boolean(state.activeThread?.pendingInteraction);
  const activeQueue = activeId ? (state.queuesByThread[activeId] ?? []) : [];

  useEffect(() => {
    if (!activeId || activeStatus !== "idle" || hasPendingInteraction) return;
    const nextItem = activeQueue[0];
    if (!nextItem) return;
    if (dispatchingQueueIdsRef.current.has(nextItem.id)) return;

    dispatchingQueueIdsRef.current.add(nextItem.id);
    setState((prev) => removeQueuedThreadMessage(prev, activeId, nextItem.id));
    void dispatchMessageToThread(activeId, nextItem.content, nextItem.attachments).finally(() => {
      dispatchingQueueIdsRef.current.delete(nextItem.id);
    });
  }, [activeId, activeQueue, activeStatus, dispatchMessageToThread, hasPendingInteraction]);

  const runOneShotPrompt = useCallback(
    async (prompt: string, opts?: { providerId?: AgentProviderId; model?: string }) => {
      const targetProject = projectPathRef.current;
      if (!targetProject) {
        throw new Error("No project open");
      }
      const providerId =
        opts?.providerId ??
        stateRef.current.activeThread?.summary.providerId ??
        resolveDefaultProvider();
      const model =
        opts?.model ??
        stateRef.current.activeThread?.summary.model ??
        settingsRef.current.defaultModelByProvider[providerId];
      const cfg = customConfigsRef.current.find((c) => c.providerId === providerId);
      return invoke<string>("agent_one_shot_prompt", {
        projectPath: targetProject,
        providerId,
        model: model ?? undefined,
        prompt,
        customBinaryPath: cfg?.binaryPath,
      });
    },
    [resolveDefaultProvider],
  );

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const activeProviderStatus = useMemo(() => {
    const pid = state.activeThread?.summary.providerId ?? resolveDefaultProvider();
    return state.providers.find((p) => p.id === pid) ?? null;
  }, [resolveDefaultProvider, state.activeThread?.summary.providerId, state.providers]);

  const availableSlashCommands = useMemo(() => {
    const providerCommands = activeProviderStatus?.commands ?? [];
    const merged = [...BUILTIN_SLASH_COMMANDS];
    const seen = new Set(merged.map((c) => c.name.toLowerCase()));
    for (const cmd of providerCommands) {
      const normalized = cmd.name.replace(/^\//, "").toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        merged.push({ ...cmd, name: cmd.name.replace(/^\//, "") });
      }
    }
    return merged;
  }, [activeProviderStatus]);

  return {
    providers: state.providers,
    threads: state.threads,
    activeThread: state.activeThread,
    activeProviderStatus,
    availableSlashCommands,
    queuesByThread: state.queuesByThread,
    providerLogs: state.providerLogs,
    loadingProviders: state.loadingProviders,
    loadingThreads: state.loadingThreads,
    sending: state.sending,
    error: state.error,
    clearError,
    refreshProviders,
    refreshRateLimits,
    refreshThreads,
    loadThread,
    createThread,
    updateThread,
    deleteThread,
    forkThread,
    compactThread,
    sendMessage,
    steerTurn,
    interruptTurn,
    respondInteraction,
    queueMessage,
    removeQueuedMessage,
    updateQueuedMessage,
    steerQueuedMessage,
    runOneShotPrompt,
  };
}
