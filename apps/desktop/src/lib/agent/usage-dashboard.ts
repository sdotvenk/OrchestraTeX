import { invoke } from "@tauri-apps/api/core";
import type { AgentProviderId } from "./types";

export interface UsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  cacheShare: number | null;
  hitRate: number | null;
  threadsCount: number;
}

export interface UsageBreakdownRow {
  provider: AgentProviderId;
  model: string | null;
  summary: UsageSummary;
}

export interface UsageDailyRow {
  date: string;
  provider: AgentProviderId;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface UsageLogQueryResult {
  total: UsageSummary;
  byProvider: { provider: AgentProviderId; summary: UsageSummary }[];
  byProviderModel: UsageBreakdownRow[];
  byDay: UsageDailyRow[];
  topThreads: {
    threadId: string;
    projectPath: string;
    provider: AgentProviderId;
    summary: UsageSummary;
  }[];
  entryCount: number;
}

export type UsageDatePreset = "today" | "7d" | "30d";

export interface UsageProjectOption {
  path: string;
  name: string;
}

export interface VoiceTokenStyle {
  ink: string;
  tint: string;
  text: string;
  label: string;
}

export const VOICE_TOKENS: Record<AgentProviderId, VoiceTokenStyle> = {
  claude: {
    ink: "var(--voice-claude-ink)",
    tint: "var(--voice-claude-tint)",
    text: "var(--voice-claude-text)",
    label: "Claude Code",
  },
  codex: {
    ink: "var(--voice-codex-ink)",
    tint: "var(--voice-codex-tint)",
    text: "var(--voice-codex-text)",
    label: "Codex",
  },
  antigravity: {
    ink: "var(--voice-antigravity-ink)",
    tint: "var(--voice-antigravity-tint)",
    text: "var(--voice-antigravity-text)",
    label: "Antigravity",
  },
  "custom-acp": {
    ink: "var(--voice-custom-ink)",
    tint: "var(--voice-custom-tint)",
    text: "var(--voice-custom-text)",
    label: "Custom ACP",
  },
};

export function computeDateRange(
  preset: UsageDatePreset,
  nowMs: number = Date.now(),
): { startMs: number; endMs: number } {
  if (preset === "today") {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: nowMs };
  }
  const days = preset === "7d" ? 7 : 30;
  return {
    startMs: nowMs - days * 86_400_000,
    endMs: nowMs,
  };
}

export async function queryUsageLog(params: {
  startMs?: number | null;
  endMs?: number | null;
  projectPath?: string | null;
}): Promise<UsageLogQueryResult> {
  return invoke<UsageLogQueryResult>("agent_query_usage_log", {
    startMs: params.startMs ?? null,
    endMs: params.endMs ?? null,
    projectPath: params.projectPath ?? null,
  });
}

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildUsageCsv(
  result: UsageLogQueryResult,
  meta: { rangeLabel: string; projectLabel: string },
): string {
  const lines: string[] = [];
  lines.push(
    [
      "section",
      "range",
      "project",
      "date",
      "provider",
      "model",
      "input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cost_usd",
      "cache_share",
      "hit_rate",
      "threads_count",
    ].join(","),
  );

  for (const row of result.byProviderModel) {
    lines.push(
      [
        "breakdown",
        meta.rangeLabel,
        meta.projectLabel,
        "",
        row.provider,
        row.model ?? "",
        row.summary.inputTokens,
        row.summary.cacheReadTokens,
        row.summary.cacheWriteTokens,
        row.summary.outputTokens,
        row.summary.reasoningTokens,
        row.summary.costUsd,
        row.summary.cacheShare,
        row.summary.hitRate,
        row.summary.threadsCount,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  lines.push(
    [
      "total",
      meta.rangeLabel,
      meta.projectLabel,
      "",
      "all",
      "",
      result.total.inputTokens,
      result.total.cacheReadTokens,
      result.total.cacheWriteTokens,
      result.total.outputTokens,
      result.total.reasoningTokens,
      result.total.costUsd,
      result.total.cacheShare,
      result.total.hitRate,
      result.total.threadsCount,
    ]
      .map(escapeCsvCell)
      .join(","),
  );

  for (const day of result.byDay) {
    lines.push(
      [
        "daily",
        meta.rangeLabel,
        meta.projectLabel,
        day.date,
        day.provider,
        "",
        day.inputTokens,
        day.cacheReadTokens,
        day.cacheWriteTokens,
        day.outputTokens,
        "",
        "",
        "",
        "",
        "",
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}
