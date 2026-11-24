import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pathsEqual } from "@/lib/path";
import { projectRelativePath } from "./edit-attribution";
import { buildScoreLanes, createScoreCollector, SCORE_WINDOW_MS, type ScoreMark } from "./score";
import type { AgentStreamEvent, ThreadSummary } from "./types";

export function useScore(projectPath: string | null, threads: readonly ThreadSummary[]) {
  const [marks, setMarks] = useState<ScoreMark[]>([]);
  const [end, setEnd] = useState(Date.now);
  const collector = useMemo(() => createScoreCollector(), []);
  const threadList = useRef(threads);
  threadList.current = threads;

  const refresh = useCallback(() => {
    const now = Date.now();
    setEnd(now);
    setMarks(collector.snapshot(now));
  }, [collector]);

  useEffect(() => {
    if (!projectPath) return;
    refresh();
    let active = true;
    const eventThreads = new Map<string, ThreadSummary>();
    const unlisten = listen<AgentStreamEvent>("agent-event", ({ payload }) => {
      if (!active) return;
      if (payload.type === "threadUpdated") {
        if (pathsEqual(payload.thread.projectPath, projectPath)) {
          eventThreads.set(payload.thread.id, payload.thread);
        }
        return;
      }
      if (
        payload.type !== "partUpdated" &&
        payload.type !== "messageAdded" &&
        payload.type !== "interactionRequested" &&
        payload.type !== "interactionResolved"
      ) {
        return;
      }
      const thread =
        eventThreads.get(payload.threadId) ??
        threadList.current.find((item) => item.id === payload.threadId);
      if (!thread || !pathsEqual(thread.projectPath, projectPath)) return;
      if (collector.ingest(projectPath, payload, Date.now())) refresh();
    });
    const clock = setInterval(refresh, 15_000);
    return () => {
      active = false;
      clearInterval(clock);
      void unlisten.then((dispose) => dispose());
    };
  }, [collector, projectPath, refresh]);

  const recordUser = useCallback(
    (kind: "edit" | "compile", path?: string) => {
      if (!projectPath) return;
      const filePath = path ? projectRelativePath(projectPath, path) : null;
      const at = Date.now();
      collector.recordUser({
        id: JSON.stringify([projectPath, "you", kind, filePath, at]),
        projectPath,
        kind,
        at,
        filePath: filePath ?? undefined,
      });
      refresh();
    },
    [collector, projectPath, refresh],
  );

  const approveWait = useCallback(
    (threadId: string, interactionId: string) => {
      if (!projectPath) return;
      collector.approve(projectPath, threadId, interactionId);
      refresh();
    },
    [collector, projectPath, refresh],
  );

  const start = end - SCORE_WINDOW_MS;
  const lanes = useMemo(
    () => (projectPath ? buildScoreLanes(projectPath, threads, marks, start, end) : []),
    [end, marks, projectPath, start, threads],
  );
  return { lanes, start, end, recordUser, approveWait };
}
