import { describe, expect, it } from "vitest";
import { buildScoreLanes, createScoreCollector, SCORE_WINDOW_MS } from "./score";
import type { AgentPart, ThreadSummary } from "./types";

const baseThread: ThreadSummary = {
  id: "codex",
  projectPath: "/paper",
  title: "Review sections",
  providerId: "codex",
  interactionMode: "default",
  runtimeMode: "approval-required",
  pinned: false,
  archived: false,
  createdAt: 10,
  updatedAt: 100,
  messageCount: 1,
  status: "idle",
};

const readPart: Extract<AgentPart, { type: "tool" }> = {
  type: "tool",
  id: "read-part",
  callId: "call",
  tool: "read",
  status: "running",
  input: { path: "main.tex" },
};

describe("Score lanes", () => {
  it("holds the first receipt time, backfills path and isolates concurrent projects", () => {
    const score = createScoreCollector();
    const readUpdate = {
      type: "partUpdated" as const,
      threadId: baseThread.id,
      messageId: "msg",
      part: readPart,
    };
    score.ingest("/paper", readUpdate, 100);
    score.ingest("/other", readUpdate, 120);
    score.ingest(
      "/paper",
      { ...readUpdate, part: { ...readPart, filePath: "main.tex", status: "completed" } },
      130,
    );
    score.recordUser({ id: "build", projectPath: "/paper", kind: "compile", at: 200 });

    const threads = [
      baseThread,
      { ...baseThread, id: "claude", providerId: "claude" as const, status: "running" },
      { ...baseThread, id: "other", projectPath: "/other", status: "running" },
      { ...baseThread, id: "old" },
    ];
    const end = 250;
    const lanes = buildScoreLanes("/paper", threads, score.snapshot(end), 1, end);
    expect(lanes.map((lane) => [lane.id, lane.marks.length])).toEqual([
      ["codex", 1],
      ["claude", 0],
      ["you", 1],
    ]);
    expect(lanes[0]?.marks[0]).toMatchObject({ kind: "read", filePath: "main.tex", at: 100 });
    expect(lanes[2]?.marks[0]).toMatchObject({ kind: "compile", at: 200, threadId: null });
  });

  it("keeps a long-running wait visible and preserves explicit approval after resolution", () => {
    const score = createScoreCollector();
    score.ingest(
      "/paper",
      {
        type: "interactionRequested",
        threadId: baseThread.id,
        interaction: { kind: "question", id: "wait", threadId: baseThread.id, questions: [] },
      },
      50,
    );
    const end = SCORE_WINDOW_MS + 100;
    expect(
      buildScoreLanes("/paper", [baseThread], score.snapshot(end), 100, end)[0]?.marks[0],
    ).toMatchObject({ waitState: "waiting", at: 50 });
    score.approve("/paper", baseThread.id, "wait");
    score.ingest(
      "/paper",
      { type: "interactionResolved", threadId: baseThread.id, interactionId: "wait" },
      75,
    );
    expect(score.snapshot(80)[0]?.waitState).toBe("approved");
    expect(score.snapshot(end)).toEqual([]);
  });

  it("skips unsupported, pending and failed tool activity", () => {
    const score = createScoreCollector();
    for (const part of [
      { ...readPart, tool: "mcp" },
      { ...readPart, status: "pending" },
      { ...readPart, status: "error" },
    ]) {
      score.ingest(
        "/paper",
        { type: "partUpdated", threadId: baseThread.id, messageId: "prompt", part },
        100,
      );
    }
    expect(score.snapshot(101)).toEqual([]);
  });
});
