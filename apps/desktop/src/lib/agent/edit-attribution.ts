import { lineEndings, pathsEqual } from "@/lib/path";
import type { AgentPart, PendingEdit, ThreadSummary } from "./types";

type ToolPart = Extract<AgentPart, { type: "tool" }>;

export interface EditEvidence {
  thread: ThreadSummary;
  part: ToolPart;
  observedAt: number;
}

export interface FileObservation {
  projectPath: string;
  filePath: string;
  before: string;
  after: string;
  observedAt: number;
}

export interface AttributedEdit extends PendingEdit {
  callId: string;
  thread: ThreadSummary;
  observedAt: number;
  startLine: number;
  endLine: number;
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "delete"]);
export const EDIT_CORRELATION_MS = 1_500;

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
}

export function projectRelativePath(projectPath: string, filePath: string): string | null {
  const root = normalizePath(projectPath).replace(/\/+$/, "");
  const normalized = normalizePath(filePath);
  if (!normalized || normalized.split("/").includes("..")) return null;
  if (!/^(?:\/|[a-z]:)/i.test(normalized)) return normalized;
  if (normalized[root.length] !== "/" || !pathsEqual(root, normalized.slice(0, root.length))) {
    return null;
  }
  return normalized.slice(root.length + 1) || null;
}

export function editToolPaths(part: ToolPart): string[] {
  if (part.status === "error" || !EDIT_TOOLS.has(part.tool.toLowerCase())) return [];
  const paths = Array.isArray(part.input.changes)
    ? part.input.changes.flatMap((change) => {
        if (typeof change !== "object" || change === null || !("path" in change)) return [];
        return typeof change.path === "string" ? [change.path] : [];
      })
    : [];
  const primary = part.filePath ?? part.input.file_path ?? part.input.filePath ?? part.input.path;
  if (typeof primary === "string" && !paths.includes(primary)) paths.push(primary);
  return paths;
}

function corroboratesChange(part: ToolPart, { before, after }: FileObservation): boolean {
  const tool = part.tool.toLowerCase();
  if (tool === "write" && typeof part.input.content === "string") {
    return part.input.content === after;
  }
  const oldText = part.input.old_string;
  const newText = part.input.new_string;
  if (tool === "edit" && typeof oldText === "string" && typeof newText === "string" && oldText) {
    return part.input.replace_all === true
      ? before.replaceAll(oldText, () => newText) === after
      : before.replace(oldText, () => newText) === after;
  }
  return true;
}

function splitEditableLines(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function changedLines(before: string, after: string) {
  const oldLines = splitEditableLines(before);
  const newLines = splitEditableLines(after);
  let first = 0;
  const common = Math.min(oldLines.length, newLines.length);
  while (first < common && oldLines[first] === newLines[first]) first++;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > first && newEnd > first && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const startLine = Math.min(first + 1, lineEndings.count(after));
  return {
    startLine,
    endLine: Math.max(startLine, newEnd),
    additions: newEnd - first,
    deletions: oldEnd - first,
  };
}

export function attributeEdit(
  observation: FileObservation,
  evidence: readonly EditEvidence[],
): AttributedEdit | null {
  if (observation.before === observation.after) return null;
  const filePath = projectRelativePath(observation.projectPath, observation.filePath);
  if (!filePath) return null;

  const candidates = new Map<string, EditEvidence>();
  for (const event of evidence) {
    if (
      event.part.status !== "completed" ||
      !pathsEqual(
        normalizePath(event.thread.projectPath),
        normalizePath(observation.projectPath),
      ) ||
      ("workspacePath" in event.thread &&
        typeof event.thread.workspacePath === "string" &&
        !pathsEqual(
          normalizePath(event.thread.workspacePath),
          normalizePath(observation.projectPath),
        )) ||
      Math.abs(observation.observedAt - event.observedAt) > EDIT_CORRELATION_MS ||
      !corroboratesChange(event.part, observation)
    ) {
      continue;
    }
    if (
      editToolPaths(event.part).some((path) => {
        const relative = projectRelativePath(observation.projectPath, path);
        if (relative === null) return false;
        const root = normalizePath(observation.projectPath);
        return pathsEqual(`${root}/${relative}`, `${root}/${filePath}`);
      })
    ) {
      candidates.set(JSON.stringify([event.thread.id, event.part.callId]), event);
    }
  }
  if (candidates.size !== 1) return null;
  const match = candidates.values().next().value;
  if (!match) return null;

  return {
    id: JSON.stringify([match.thread.id, match.part.callId, filePath]),
    callId: match.part.callId,
    thread: match.thread,
    filePath,
    before: observation.before,
    after: observation.after,
    observedAt: observation.observedAt,
    status: "pending",
    ...changedLines(observation.before, observation.after),
  };
}

export function undoEdit(edit: AttributedEdit, current: string): string | null {
  return edit.status === "pending" && edit.after === current ? edit.before : null;
}
