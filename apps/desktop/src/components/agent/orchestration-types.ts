import type { AgentProviderId, ThreadSummary } from "@/lib/agent/types";

export interface OrchestrationThreadSchedule {
  runAt: number;
  prompt: string;
  repeatIntervalMs?: number | null;
  lastResult?: string | null;
  lastRunAt?: number | null;
}

export interface OrchestrationThreadSummary extends ThreadSummary {
  workspacePath?: string | null;
  workspaceBranch?: string | null;
  parentThreadId?: string | null;
  schedule?: OrchestrationThreadSchedule | null;
}

export interface BranchPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft?: boolean;
}

export interface ProviderMeta {
  label: string;
  colorVar: string;
}

export const PROVIDER_META: Record<AgentProviderId, ProviderMeta> = {
  claude: { label: "Claude Code", colorVar: "var(--primary-bg)" },
  codex: { label: "Codex", colorVar: "var(--accent)" },
  antigravity: { label: "Antigravity", colorVar: "var(--ok)" },
  "custom-acp": { label: "Custom ACP", colorVar: "var(--warn)" },
};

export function getProviderMeta(providerId: AgentProviderId | string): ProviderMeta {
  if (providerId in PROVIDER_META) {
    return PROVIDER_META[providerId as AgentProviderId];
  }
  return { label: providerId, colorVar: "var(--muted-foreground)" };
}

export function getProjectName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || projectPath;
}

export function formatShortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
