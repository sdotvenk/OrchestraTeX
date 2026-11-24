import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BranchPullRequest,
  OrchestrationThreadSummary,
} from "@/components/agent/orchestration-types";
import type { AgentSettings, AgentStreamEvent } from "./types";
import { buildProviderCustomConfigs } from "./use-agent-settings";

export function useOrchestration(settings: AgentSettings) {
  const [threads, setThreads] = useState<OrchestrationThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<Record<string, BranchPullRequest | null>>({});
  const refreshGeneration = useRef(0);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const customConfigs = useMemo(() => buildProviderCustomConfigs(settings), [settings]);

  const refreshThreads = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const listed = await invoke<OrchestrationThreadSummary[]>("agent_list_all_threads");
      if (generation === refreshGeneration.current) {
        setThreads(listed);
        setError(null);
      }
    } catch (cause) {
      if (generation === refreshGeneration.current) setError(String(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshThreads();
    const unlisten = listen<AgentStreamEvent>("agent-event", ({ payload }) => {
      if (!active) return;
      if (payload.type === "threadUpdated") {
        const thread = payload.thread;
        setThreads((previous) => [thread, ...previous.filter((item) => item.id !== thread.id)]);
      } else if (payload.type === "threadDeleted") {
        setThreads((previous) =>
          previous.filter(
            (thread) =>
              !(thread.id === payload.threadId && thread.projectPath === payload.projectPath),
          ),
        );
      } else if (payload.type === "turnStatus") {
        setThreads((previous) =>
          previous.map((thread) =>
            thread.id === payload.threadId ? { ...thread, status: payload.status } : thread,
          ),
        );
      }
    });
    return () => {
      active = false;
      refreshGeneration.current += 1;
      void unlisten.then((dispose) => dispose());
    };
  }, [refreshThreads]);

  useEffect(() => {
    let running = false;
    let active = true;
    const runDue = async () => {
      if (running) return;
      const now = Date.now();
      const projects = new Set(
        threadsRef.current
          .filter(
            (thread) =>
              typeof thread.schedule?.runAt === "number" &&
              thread.schedule.runAt <= now &&
              !thread.archived,
          )
          .map((thread) => thread.projectPath),
      );
      if (!projects.size) return;
      running = true;
      try {
        await Promise.all(
          [...projects].map((projectPath) =>
            invoke("agent_run_due_schedules", { projectPath, customConfigs }),
          ),
        );
      } catch (cause) {
        if (active) setError(String(cause));
      } finally {
        if (active) void refreshThreads();
        running = false;
      }
    };
    const timer = setInterval(() => void runDue(), 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [customConfigs, refreshThreads]);

  const refreshPullRequest = useCallback(
    async (
      thread: Pick<
        OrchestrationThreadSummary,
        "id" | "projectPath" | "workspacePath" | "workspaceBranch"
      >,
    ) => {
      try {
        const value = await invoke<BranchPullRequest | null>("git_branch_pull_request", {
          dir: thread.workspacePath ?? thread.projectPath,
          branch: thread.workspaceBranch ?? undefined,
        });
        setPullRequests((previous) => ({ ...previous, [thread.id]: value }));
      } catch {
        // A missing remote or unavailable gh session leaves the PR status unknown.
      }
    },
    [],
  );

  return { threads, refreshThreads, pullRequests, refreshPullRequest, customConfigs, error };
}
