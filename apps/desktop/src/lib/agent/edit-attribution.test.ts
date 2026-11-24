import { describe, expect, it } from "vitest";
import {
  attributeEdit,
  type EditEvidence,
  projectRelativePath,
  undoEdit,
} from "./edit-attribution";

const observation = {
  projectPath: "/paper",
  filePath: "sections/field.tex",
  before: "Intro\nOld\nLast\n",
  after: "Intro\nNew\nExtra\nLast\n",
  observedAt: 1500,
};

const evidence: EditEvidence = {
  thread: {
    id: "claude-1",
    projectPath: observation.projectPath,
    providerId: "claude",
    title: "Edit field",
    pinned: false,
    archived: false,
    interactionMode: "default",
    runtimeMode: "approval-required",
    status: "running",
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 1,
  },
  part: {
    type: "tool",
    tool: "Edit",
    status: "completed",
    id: "edit-1",
    callId: "call-1",
    input: { old_string: "Old", new_string: "New\nExtra" },
    filePath: "/paper/sections/field.tex",
  },
  observedAt: 1600,
};

describe("edit attribution", () => {
  it("finds the modified source range when watch and tool notifications arrive in either order", () => {
    const expected = {
      filePath: "sections/field.tex",
      startLine: 2,
      endLine: 3,
      additions: 2,
      deletions: 1,
      status: "pending",
    };
    expect(attributeEdit(observation, [evidence])).toMatchObject(expected);
    expect(attributeEdit(observation, [{ ...evidence, observedAt: 1400 }])).toMatchObject(expected);
  });

  it("handles changes to secondary files in a Codex patch and anchors deleted lines", () => {
    const codex: EditEvidence = {
      ...evidence,
      thread: { ...evidence.thread, providerId: "codex" },
      part: {
        ...evidence.part,
        filePath: "main.tex",
        input: { changes: [{ path: "main.tex" }, { path: "./sections/field.tex" }] },
      },
    };
    expect(attributeEdit({ ...observation, after: "Intro\nLast\n" }, [codex])).toMatchObject({
      startLine: 2,
      endLine: 2,
      additions: 0,
      deletions: 1,
    });
  });

  it("ignores failed tools, conflicting agents and changes that contradict the declared edit", () => {
    const failed = { ...evidence, part: { ...evidence.part, status: "error" } };
    const concurrent = { ...evidence, thread: { ...evidence.thread, id: "claude-2" } };
    expect(attributeEdit(observation, [failed])).toBeNull();
    expect(attributeEdit(observation, [evidence, concurrent])).toBeNull();
    expect(attributeEdit(observation, [evidence, evidence])).not.toBeNull();
    expect(attributeEdit({ ...observation, after: "Other content" }, [evidence])).toBeNull();
    expect(attributeEdit({ ...observation, observedAt: 10000 }, [evidence])).toBeNull();
    expect(attributeEdit({ ...observation, projectPath: "/other" }, [evidence])).toBeNull();
  });

  it("undoes the exact watched revision and protects subsequent edits", () => {
    const edit = attributeEdit(observation, [evidence]);
    if (!edit) throw new Error("Expected an attributed edit");
    expect(undoEdit(edit, observation.after)).toBe(observation.before);
    expect(undoEdit(edit, `${observation.after}Different revision`)).toBeNull();
    expect(undoEdit({ ...edit, status: "accepted" }, observation.after)).toBeNull();
  });

  it("keeps project boundaries and supports Windows watch paths", () => {
    expect(projectRelativePath("/paper", "/papers/main.tex")).toBeNull();
    expect(projectRelativePath("/paper", "../other/main.tex")).toBeNull();
    expect(projectRelativePath("C:\\Paper", "c:/paper/./Sections/Main.tex")).toBe(
      "Sections/Main.tex",
    );
  });
});
