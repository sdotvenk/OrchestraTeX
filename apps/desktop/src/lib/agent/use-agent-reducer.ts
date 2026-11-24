import type {
  AgentMessage,
  AgentPart,
  AgentProviderId,
  AgentStreamEvent,
  AgentThread,
  AttachmentInput,
  ProviderStatus,
  QueuedMessage,
  ThreadSummary,
} from "./types";

export interface ProviderLogEntry {
  providerId: AgentProviderId;
  threadId?: string | null;
  stream: string;
  message: string;
  timestamp: number;
}

export interface AgentState {
  providers: ProviderStatus[];
  threads: ThreadSummary[];
  activeThread: AgentThread | null;
  queuesByThread: Record<string, QueuedMessage[]>;
  providerLogs: ProviderLogEntry[];
  loadingProviders: boolean;
  loadingThreads: boolean;
  sending: boolean;
  error: string | null;
}

export interface BufferedDelta {
  threadId: string;
  messageId: string;
  partId: string;
  partType: string;
  delta: string;
}

export function createInitialAgentState(): AgentState {
  return {
    providers: [],
    threads: [],
    activeThread: null,
    queuesByThread: {},
    providerLogs: [],
    loadingProviders: false,
    loadingThreads: false,
    sending: false,
    error: null,
  };
}

export function sortThreadSummaries(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.updatedAt - a.updatedAt;
  });
}

export function upsertThreadSummary(
  threads: ThreadSummary[],
  summary: ThreadSummary,
): ThreadSummary[] {
  const existingIdx = threads.findIndex((t) => t.id === summary.id);
  const next = [...threads];
  if (existingIdx >= 0) {
    next[existingIdx] = summary;
  } else {
    next.push(summary);
  }
  return sortThreadSummaries(next);
}

function isFileModifyingTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "filechange" ||
    normalized === "create" ||
    normalized.includes("write_file") ||
    normalized.includes("edit_file")
  );
}

function upsertPartInMessage(message: AgentMessage, incoming: AgentPart): AgentMessage {
  const nextParts = [...message.parts];
  const existingIdx = nextParts.findIndex((p) => {
    if (p.id === incoming.id) return true;
    if (p.type === "tool" && incoming.type === "tool" && p.callId && p.callId === incoming.callId) {
      return true;
    }
    return false;
  });

  if (existingIdx >= 0) {
    nextParts[existingIdx] = incoming;
  } else {
    nextParts.push(incoming);
  }

  let nextChangedFiles = message.changedFiles;
  if (
    incoming.type === "tool" &&
    incoming.filePath &&
    incoming.status === "completed" &&
    isFileModifyingTool(incoming.tool) &&
    !nextChangedFiles.includes(incoming.filePath)
  ) {
    nextChangedFiles = [...nextChangedFiles, incoming.filePath];
  }

  return {
    ...message,
    parts: nextParts,
    changedFiles: nextChangedFiles,
  };
}

function applyDeltaToMessages(messages: AgentMessage[], delta: BufferedDelta): AgentMessage[] {
  let msgIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.id === delta.messageId) {
      msgIdx = i;
      break;
    }
  }

  const nextMessages = [...messages];
  if (msgIdx < 0) {
    const newPart: AgentPart =
      delta.partType === "reasoning"
        ? { type: "reasoning", id: delta.partId, text: delta.delta }
        : { type: "text", id: delta.partId, text: delta.delta };
    nextMessages.push({
      id: delta.messageId,
      role: "assistant",
      createdAt: Date.now(),
      completedAt: null,
      providerId: null,
      model: null,
      parts: [newPart],
      changedFiles: [],
      error: null,
    });
    return nextMessages;
  }

  const targetMsg = nextMessages[msgIdx];
  if (!targetMsg) return nextMessages;

  const nextParts = [...targetMsg.parts];
  if (delta.partType === "text" || delta.partType === "reasoning") {
    const partIdx = nextParts.findIndex((p) => p.id === delta.partId && p.type === delta.partType);
    if (partIdx >= 0) {
      const existing = nextParts[partIdx];
      if (existing && (existing.type === "text" || existing.type === "reasoning")) {
        nextParts[partIdx] = {
          ...existing,
          text: existing.text + delta.delta,
        };
      }
    } else {
      nextParts.push({
        type: delta.partType,
        id: delta.partId,
        text: delta.delta,
      });
    }
  } else if (delta.partType === "tool_output") {
    const partIdx = nextParts.findIndex(
      (p) => p.type === "tool" && (p.id === delta.partId || p.callId === delta.partId),
    );
    if (partIdx >= 0) {
      const existing = nextParts[partIdx];
      if (existing && existing.type === "tool") {
        nextParts[partIdx] = {
          ...existing,
          output: (existing.output ?? "") + delta.delta,
        };
      }
    }
  }

  nextMessages[msgIdx] = {
    ...targetMsg,
    parts: nextParts,
  };
  return nextMessages;
}

export function applyPartDeltas(state: AgentState, deltas: BufferedDelta[]): AgentState {
  if (deltas.length === 0 || !state.activeThread) {
    return state;
  }

  const activeId = state.activeThread.summary.id;
  const relevant = deltas.filter((d) => d.threadId === activeId);
  if (relevant.length === 0) {
    return state;
  }

  let messages = state.activeThread.messages;
  for (const d of relevant) {
    messages = applyDeltaToMessages(messages, d);
  }

  return {
    ...state,
    activeThread: {
      ...state.activeThread,
      messages,
    },
  };
}

export function applyAgentStreamEvent(state: AgentState, event: AgentStreamEvent): AgentState {
  switch (event.type) {
    case "threadUpdated": {
      const threads = upsertThreadSummary(state.threads, event.thread);
      const activeThread =
        state.activeThread?.summary.id === event.thread.id
          ? { ...state.activeThread, summary: event.thread }
          : state.activeThread;
      return {
        ...state,
        threads,
        activeThread,
      };
    }

    case "messageAdded": {
      if (state.activeThread?.summary.id !== event.threadId) {
        return state;
      }
      const existingIdx = state.activeThread.messages.findIndex((m) => m.id === event.message.id);
      const nextMessages = [...state.activeThread.messages];
      if (existingIdx >= 0) {
        nextMessages[existingIdx] = event.message;
      } else {
        nextMessages.push(event.message);
      }
      return {
        ...state,
        activeThread: {
          ...state.activeThread,
          messages: nextMessages,
        },
      };
    }

    case "partUpdated": {
      if (state.activeThread?.summary.id !== event.threadId) {
        return state;
      }
      const existingIdx = state.activeThread.messages.findIndex((m) => m.id === event.messageId);
      const nextMessages = [...state.activeThread.messages];
      if (existingIdx >= 0) {
        const msg = nextMessages[existingIdx];
        if (msg) {
          nextMessages[existingIdx] = upsertPartInMessage(msg, event.part);
        }
      } else {
        nextMessages.push({
          id: event.messageId,
          role: "assistant",
          createdAt: Date.now(),
          completedAt: null,
          providerId: state.activeThread.summary.providerId,
          model: state.activeThread.summary.model ?? null,
          parts: [event.part],
          changedFiles: [],
          error: null,
        });
      }
      return {
        ...state,
        activeThread: {
          ...state.activeThread,
          messages: nextMessages,
        },
      };
    }

    case "partDelta": {
      return applyPartDeltas(state, [
        {
          threadId: event.threadId,
          messageId: event.messageId,
          partId: event.partId,
          partType: event.partType,
          delta: event.delta,
        },
      ]);
    }

    case "turnStatus": {
      const normalizedStatus = event.status === "retry" ? "running" : event.status;
      const nextThreads = state.threads.map((t) =>
        t.id === event.threadId ? { ...t, status: normalizedStatus } : t,
      );
      let nextActive = state.activeThread;
      if (state.activeThread?.summary.id === event.threadId) {
        let nextMessages = state.activeThread.messages;
        if (normalizedStatus === "error" && event.error && nextMessages.length > 0) {
          const lastIdx = nextMessages.length - 1;
          const lastMsg = nextMessages[lastIdx];
          if (lastMsg && lastMsg.role === "assistant" && !lastMsg.error) {
            nextMessages = [...nextMessages];
            nextMessages[lastIdx] = {
              ...lastMsg,
              error: event.error,
              completedAt: Date.now(),
            };
          }
        }
        nextActive = {
          ...state.activeThread,
          summary: {
            ...state.activeThread.summary,
            status: normalizedStatus,
          },
          messages: nextMessages,
        };
      }
      return {
        ...state,
        threads: nextThreads,
        activeThread: nextActive,
        error:
          state.activeThread?.summary.id !== event.threadId
            ? state.error
            : event.status === "error" && event.error
              ? event.error
              : event.status === "running"
                ? null
                : state.error,
      };
    }

    case "tokenUsageUpdated": {
      if (state.activeThread?.summary.id !== event.threadId) {
        return state;
      }
      return {
        ...state,
        activeThread: {
          ...state.activeThread,
          usage: event.usage,
        },
      };
    }

    case "rateLimitsUpdated": {
      return {
        ...state,
        providers: state.providers.map((p) =>
          p.id === event.providerId ? { ...p, rateLimits: event.rateLimits } : p,
        ),
      };
    }

    case "planUpdated": {
      if (state.activeThread?.summary.id !== event.threadId) {
        return state;
      }
      return {
        ...state,
        activeThread: {
          ...state.activeThread,
          tasks: event.tasks,
        },
      };
    }

    case "interactionRequested": {
      const nextThreads = state.threads.map((t) =>
        t.id === event.threadId ? { ...t, status: "waiting_input" } : t,
      );
      if (state.activeThread?.summary.id !== event.threadId) {
        return {
          ...state,
          threads: nextThreads,
        };
      }
      return {
        ...state,
        threads: nextThreads,
        activeThread: {
          ...state.activeThread,
          summary: {
            ...state.activeThread.summary,
            status: "waiting_input",
          },
          pendingInteraction: event.interaction,
        },
      };
    }

    case "interactionResolved": {
      if (
        state.activeThread?.summary.id !== event.threadId ||
        state.activeThread.pendingInteraction?.id !== event.interactionId
      ) {
        return state;
      }
      return {
        ...state,
        activeThread: {
          ...state.activeThread,
          pendingInteraction: null,
        },
      };
    }

    case "commandsUpdated": {
      return {
        ...state,
        providers: state.providers.map((p) =>
          p.id === event.providerId ? { ...p, commands: event.commands } : p,
        ),
      };
    }

    case "providerLog": {
      const entry: ProviderLogEntry = {
        providerId: event.providerId,
        threadId: event.threadId,
        stream: event.stream,
        message: event.message,
        timestamp: Date.now(),
      };
      const logs = [...state.providerLogs, entry];
      const trimmed = logs.length > 200 ? logs.slice(logs.length - 200) : logs;
      return {
        ...state,
        providerLogs: trimmed,
      };
    }

    default:
      return state;
  }
}

export function enqueueThreadMessage(
  state: AgentState,
  threadId: string,
  content: string,
  attachments: AttachmentInput[],
  id: string,
): AgentState {
  const existing = state.queuesByThread[threadId] ?? [];
  const nextItem: QueuedMessage = {
    id,
    threadId,
    content,
    attachments,
    createdAt: Date.now(),
  };
  return {
    ...state,
    queuesByThread: {
      ...state.queuesByThread,
      [threadId]: [...existing, nextItem],
    },
  };
}

export function removeQueuedThreadMessage(
  state: AgentState,
  threadId: string,
  queueId: string,
): AgentState {
  const existing = state.queuesByThread[threadId] ?? [];
  return {
    ...state,
    queuesByThread: {
      ...state.queuesByThread,
      [threadId]: existing.filter((q) => q.id !== queueId),
    },
  };
}

export function updateQueuedThreadMessage(
  state: AgentState,
  threadId: string,
  queueId: string,
  content: string,
): AgentState {
  const existing = state.queuesByThread[threadId] ?? [];
  return {
    ...state,
    queuesByThread: {
      ...state.queuesByThread,
      [threadId]: existing.map((q) => (q.id === queueId ? { ...q, content } : q)),
    },
  };
}
