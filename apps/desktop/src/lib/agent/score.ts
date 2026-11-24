import { pathsEqual } from "@/lib/path";
import type { AgentPart, AgentProviderId, AgentStreamEvent, ThreadSummary } from "./types";

export const SCORE_WINDOW_MS = 15 * 60 * 1000;

export type ScoreKind = "read" | "edit" | "compile" | "wait";
export interface ScoreMark {
  id: string;
  projectPath: string;
  threadId: string | null;
  kind: ScoreKind;
  at: number;
  filePath?: string;
  callId?: string;
  waitState?: "waiting" | "approved" | "resolved";
}
export interface ScoreLane {
  id: string;
  title: string;
  provider: AgentProviderId | "you";
  marks: ScoreMark[];
}

/** Only classify explicit tool names and commands; unknown activity stays out of the Score. */
export function classifyScoreTool(
  part: Extract<AgentPart, { type: "tool" }>,
): Exclude<ScoreKind, "wait"> | undefined {
  const name = part.tool.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^(read|readfile|view|cat)$/.test(name)) return "read";
  if (/^(edit|editfile|write|writefile|applypatch|multiedit)$/.test(name)) return "edit";
  const command = typeof part.input.command === "string" ? part.input.command : "";
  if (
    /^(compile|latexcompile)$/.test(name) ||
    (/^(bash|shell|terminal|exec|execute|command)$/.test(name) &&
      /(?:^|[\s;&|])(latexmk|pdflatex|xelatex|lualatex|tectonic)(?:\s|$)/.test(command))
  )
    return "compile";
  return undefined;
}

/** Feed events at the IPC listener, before reducing them into thread state. */
export function createScoreCollector() {
  const marks = new Map<string, ScoreMark>();
  return {
    ingest(projectPath: string, event: AgentStreamEvent, at = Date.now()) {
      let changed = false;
      const addPart = (threadId: string, part: AgentPart) => {
        if (part.type !== "tool" || !["running", "completed"].includes(part.status)) return;
        const kind = classifyScoreTool(part);
        if (!kind) return;
        const id = JSON.stringify([projectPath, threadId, part.callId, kind]);
        const previous = marks.get(id);
        const inputPath = part.input.file_path ?? part.input.filePath ?? part.input.path;
        const filePath =
          part.filePath ?? (typeof inputPath === "string" ? inputPath : previous?.filePath);
        if (previous && previous.filePath === filePath) return;
        marks.set(id, {
          id,
          projectPath,
          threadId,
          kind,
          at: previous?.at ?? at,
          callId: part.callId,
          filePath,
        });
        changed = true;
      };
      if (event.type === "partUpdated") addPart(event.threadId, event.part);
      if (event.type === "messageAdded")
        for (const part of event.message.parts) addPart(event.threadId, part);
      if (event.type === "interactionRequested") {
        const id = JSON.stringify([projectPath, event.threadId, "wait", event.interaction.id]);
        if (!marks.has(id)) {
          marks.set(id, {
            id,
            projectPath,
            threadId: event.threadId,
            kind: "wait",
            at,
            waitState: "waiting",
          });
          changed = true;
        }
      }
      if (event.type === "interactionResolved") {
        const id = JSON.stringify([projectPath, event.threadId, "wait", event.interactionId]);
        const mark = marks.get(id);
        if (mark?.waitState === "waiting") {
          marks.set(id, { ...mark, waitState: "resolved" });
          changed = true;
        }
      }
      return changed;
    },
    recordUser(mark: Omit<ScoreMark, "threadId">) {
      marks.set(mark.id, { ...mark, threadId: null });
    },
    approve(projectPath: string, threadId: string, interactionId: string) {
      const id = JSON.stringify([projectPath, threadId, "wait", interactionId]);
      const mark = marks.get(id);
      if (mark) marks.set(id, { ...mark, waitState: "approved" });
    },
    prune(at = Date.now()) {
      for (const [id, mark] of marks) {
        if (mark.at < at - SCORE_WINDOW_MS && mark.waitState !== "waiting") marks.delete(id);
      }
    },
    snapshot(at = Date.now()) {
      for (const [id, mark] of marks) {
        if (mark.at < at - SCORE_WINDOW_MS && mark.waitState !== "waiting") marks.delete(id);
      }
      return [...marks.values()];
    },
  };
}

export function buildScoreLanes(
  projectPath: string,
  threads: readonly ThreadSummary[],
  marks: readonly ScoreMark[],
  start: number,
  end: number,
): ScoreLane[] {
  const visible = marks.filter(
    (mark) =>
      pathsEqual(mark.projectPath, projectPath) &&
      mark.at <= end &&
      (mark.at >= start || mark.waitState === "waiting"),
  );
  const marksByThread = new Map<string | null, ScoreMark[]>();
  for (const mark of visible.sort((a, b) => a.at - b.at)) {
    const laneMarks = marksByThread.get(mark.threadId);
    if (laneMarks) {
      laneMarks.push(mark);
    } else {
      marksByThread.set(mark.threadId, [mark]);
    }
  }
  const lanes: ScoreLane[] = threads
    .filter(
      (thread) =>
        pathsEqual(thread.projectPath, projectPath) &&
        !thread.archived &&
        (thread.status === "running" ||
          thread.status === "waiting_input" ||
          marksByThread.has(thread.id)),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      provider: t.providerId,
      marks: marksByThread.get(t.id) ?? [],
    }));
  lanes.push({
    id: "you",
    title: "You",
    provider: "you",
    marks: marksByThread.get(null) ?? [],
  });
  return lanes;
}
