import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { pathsEqual } from "@/lib/path";
import {
  type AttributedEdit,
  attributeEdit,
  EDIT_CORRELATION_MS,
  type EditEvidence,
  editToolPaths,
  type FileObservation,
  normalizePath,
  projectRelativePath,
} from "./edit-attribution";
import type { AgentPart, AgentStreamEvent, ThreadSummary } from "./types";

const LIMIT = 100;
const MAX_SNAPSHOT_LENGTH = 500_000;
const SOURCE = /\.(?:tex|bib|sty|cls|bst|ltx)$/i;

export function useAgentEdits(
  projectPath: string | null,
  threads: readonly ThreadSummary[],
  readFile: (path: string) => Promise<string | null>,
  isLocallyModified: (path: string) => boolean,
) {
  const [edits, setEdits] = useState<AttributedEdit[]>([]);
  const cache = useRef(new Map<string, string>());
  const versions = useRef(new Map<string, number>());
  const latest = useRef({ threads, readFile, isLocallyModified });
  latest.current = { threads, readFile, isLocallyModified };
  const project = useRef(projectPath);
  project.current = projectPath;
  const rememberFile = useCallback(
    (path: string, content: string, fromProject?: string | null, seedOnly = false) => {
      const root = project.current;
      if (
        fromProject !== undefined &&
        (!root || !fromProject || !pathsEqual(normalizePath(root), normalizePath(fromProject)))
      )
        return;
      const relative = root && projectRelativePath(root, path);
      if (!relative || !SOURCE.test(relative)) return;
      if (seedOnly && versions.current.has(relative)) return;
      versions.current.set(relative, (versions.current.get(relative) ?? 0) + 1);
      cache.current.delete(relative);
      if (content.length > MAX_SNAPSHOT_LENGTH) return;
      cache.current.set(relative, content);
      if (cache.current.size > LIMIT) {
        const oldest = cache.current.keys().next().value;
        if (oldest) cache.current.delete(oldest);
      }
    },
    [],
  );

  useEffect(() => {
    cache.current.clear();
    versions.current.clear();
    setEdits([]);
    if (!projectPath) return;
    let active = true;
    let evidence: EditEvidence[] = [];
    const toolParts = new Map<string, Extract<AgentPart, { type: "tool" }>>();
    const knownThreads = new Map<string, ThreadSummary>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onPart = (threadId: string, part: AgentPart) => {
      if (part.type !== "tool") return;
      const key = JSON.stringify([threadId, part.callId]);
      const prior = toolParts.get(key);
      if (prior) {
        part = {
          ...prior,
          ...part,
          tool: part.tool === "other" ? prior.tool : part.tool,
          input: { ...prior.input, ...part.input },
          filePath: part.filePath ?? prior.filePath,
        };
      }
      toolParts.set(key, part);
      const thread =
        knownThreads.get(threadId) ?? latest.current.threads.find((item) => item.id === threadId);
      if (!thread || !pathsEqual(normalizePath(thread.projectPath), normalizePath(projectPath)))
        return;
      const paths = editToolPaths(part);
      const candidate =
        part.filePath ?? part.input.file_path ?? part.input.filePath ?? part.input.path;
      if (part.tool.toLowerCase() === "read" && typeof candidate === "string")
        paths.push(candidate);
      for (const path of paths) {
        const relative = projectRelativePath(projectPath, path);
        if (
          !relative ||
          !SOURCE.test(relative) ||
          cache.current.has(relative) ||
          latest.current.isLocallyModified(relative)
        )
          continue;
        const version = versions.current.get(relative) ?? 0;
        void latest.current
          .readFile(relative)
          .then((content) => {
            if (
              active &&
              content !== null &&
              !cache.current.has(relative) &&
              (versions.current.get(relative) ?? 0) === version &&
              !latest.current.isLocallyModified(relative)
            )
              rememberFile(relative, content);
          })
          .catch(() => {});
      }
      if (part.status === "completed" && paths.length) {
        const observedAt = Date.now();
        evidence = evidence.filter(
          (item) => observedAt - item.observedAt <= EDIT_CORRELATION_MS * 4,
        );
        evidence.push({ thread, part, observedAt });
        evidence = evidence.slice(-LIMIT);
      }
    };
    const agent = listen<AgentStreamEvent>("agent-event", ({ payload }) => {
      if (!active) return;
      if (
        payload.type === "threadUpdated" &&
        pathsEqual(normalizePath(payload.thread.projectPath), normalizePath(projectPath))
      ) {
        knownThreads.set(payload.thread.id, payload.thread);
      } else if (payload.type === "partUpdated") {
        onPart(payload.threadId, payload.part);
      } else if (payload.type === "messageAdded") {
        for (const part of payload.message.parts) onPart(payload.threadId, part);
      }
    });
    const files = listen<{ path: string; kind: string }>("file-changed", ({ payload }) => {
      if (!active || payload.kind === "access") return;
      const relative = projectRelativePath(projectPath, payload.path);
      if (!relative || !SOURCE.test(relative)) return;
      const before = cache.current.get(relative);
      const version = (versions.current.get(relative) ?? 0) + 1;
      versions.current.set(relative, version);
      if (latest.current.isLocallyModified(relative)) return;
      const observedAt = Date.now();
      void latest.current
        .readFile(relative)
        .then((after) => {
          if (
            !active ||
            after === null ||
            after.length > MAX_SNAPSHOT_LENGTH ||
            versions.current.get(relative) !== version ||
            latest.current.isLocallyModified(relative)
          )
            return;
          rememberFile(relative, after);
          if (before === undefined && payload.kind !== "create") return;
          const observation: FileObservation = {
            projectPath,
            filePath: relative,
            before: before ?? "",
            after,
            observedAt,
          };
          // Delay attribution so competing evidence within the window remains ambiguous.
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!active) return;
            const edit = attributeEdit(observation, evidence);
            if (edit) {
              setEdits((previous) =>
                previous.some((item) => item.id === edit.id)
                  ? previous
                  : [...previous.slice(-(LIMIT - 1)), edit],
              );
            }
          }, EDIT_CORRELATION_MS);
          timers.add(timer);
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
      void agent.then((unlisten) => unlisten());
      void files.then((unlisten) => unlisten());
    };
  }, [projectPath, rememberFile]);

  const markEdit = useCallback((id: string, status: "accepted" | "rejected") => {
    setEdits((previous) => previous.map((edit) => (edit.id === id ? { ...edit, status } : edit)));
  }, []);
  return {
    edits,
    rememberFile,
    markAccepted: useCallback((id: string) => markEdit(id, "accepted"), [markEdit]),
    markRejected: useCallback((id: string) => markEdit(id, "rejected"), [markEdit]),
  };
}
