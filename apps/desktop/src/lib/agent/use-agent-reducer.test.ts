import { describe, expect, it } from "vitest";
import type { AgentThread, ThreadSummary } from "./types";
import {
  applyAgentStreamEvent,
  applyPartDeltas,
  createInitialAgentState,
  enqueueThreadMessage,
  removeQueuedThreadMessage,
  updateQueuedThreadMessage,
} from "./use-agent-reducer";

function makeSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    projectPath: "/tmp/paper",
    title: "Test Thread",
    providerId: "claude",
    providerSessionId: null,
    model: "sonnet",
    reasoningEffort: "high",
    interactionMode: "default",
    runtimeMode: "auto-accept-edits",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    lastPreview: null,
    status: "idle",
    ...overrides,
  };
}

function makeThread(summary = makeSummary()): AgentThread {
  return {
    summary,
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        createdAt: 1000,
        completedAt: null,
        providerId: "claude",
        model: "sonnet",
        parts: [{ type: "text", id: "part-1", text: "Hello" }],
        changedFiles: [],
        error: null,
      },
    ],
    usage: null,
    tasks: [],
    pendingInteraction: null,
  };
}

describe("use-agent-reducer", () => {
  it("batches part deltas onto the active thread message parts", () => {
    let state = createInitialAgentState();
    state = {
      ...state,
      threads: [makeSummary()],
      activeThread: makeThread(),
    };

    state = applyPartDeltas(state, [
      {
        threadId: "thread-1",
        messageId: "msg-1",
        partId: "part-1",
        partType: "text",
        delta: " world",
      },
      {
        threadId: "thread-1",
        messageId: "msg-1",
        partId: "part-1",
        partType: "text",
        delta: "!",
      },
      {
        threadId: "thread-1",
        messageId: "msg-1",
        partId: "reason-1",
        partType: "reasoning",
        delta: "Thinking...",
      },
    ]);

    const msg = state.activeThread?.messages[0];
    expect(msg?.parts).toEqual([
      { type: "text", id: "part-1", text: "Hello world!" },
      { type: "reasoning", id: "reason-1", text: "Thinking..." },
    ]);
  });

  it("tracks completed file-modifying tools in message changedFiles", () => {
    let state = createInitialAgentState();
    state = {
      ...state,
      threads: [makeSummary()],
      activeThread: makeThread(),
    };

    state = applyAgentStreamEvent(state, {
      type: "partUpdated",
      threadId: "thread-1",
      messageId: "msg-1",
      part: {
        type: "tool",
        id: "tool-1",
        callId: "call-1",
        tool: "Edit",
        title: "sections/intro.tex",
        status: "completed",
        input: { file_path: "sections/intro.tex" },
        output: "Updated",
        filePath: "sections/intro.tex",
      },
    });

    expect(state.activeThread?.messages[0]?.changedFiles).toEqual(["sections/intro.tex"]);
  });

  it("sets and clears pending interactions cleanly", () => {
    let state = createInitialAgentState();
    state = {
      ...state,
      threads: [makeSummary()],
      activeThread: makeThread(),
    };

    state = applyAgentStreamEvent(state, {
      type: "interactionRequested",
      threadId: "thread-1",
      interaction: {
        kind: "question",
        id: "q-1",
        threadId: "thread-1",
        questions: [
          {
            id: "Select engine",
            header: "Compiler",
            question: "Select engine",
            options: [{ label: "latexmk", description: "Default" }],
            multiSelect: false,
            isOther: true,
            isSecret: false,
          },
        ],
      },
    });

    expect(state.activeThread?.summary.status).toBe("waiting_input");
    expect(state.activeThread?.pendingInteraction?.id).toBe("q-1");

    state = applyAgentStreamEvent(state, {
      type: "interactionResolved",
      threadId: "thread-1",
      interactionId: "q-1",
    });
    expect(state.activeThread?.pendingInteraction).toBeNull();
  });

  it("manages per-thread queued messages", () => {
    let state = createInitialAgentState();
    state = enqueueThreadMessage(state, "thread-1", "First", [], "q-1");
    state = enqueueThreadMessage(state, "thread-1", "Second", [], "q-2");
    expect(state.queuesByThread["thread-1"]).toHaveLength(2);

    state = updateQueuedThreadMessage(state, "thread-1", "q-2", "Second edited");
    expect(state.queuesByThread["thread-1"]?.[1]?.content).toBe("Second edited");

    state = removeQueuedThreadMessage(state, "thread-1", "q-1");
    expect(state.queuesByThread["thread-1"]?.map((q) => q.id)).toEqual(["q-2"]);
  });
});
