"use client";

import { ArrowsClockwise, DownloadSimple, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProviderId, ProviderStatus } from "@/lib/agent/types";
import {
  buildUsageCsv,
  computeDateRange,
  queryUsageLog,
  type UsageBreakdownRow,
  type UsageDailyRow,
  type UsageDatePreset,
  type UsageLogQueryResult,
  type UsageProjectOption,
  VOICE_TOKENS,
} from "@/lib/agent/usage-dashboard";
import { formatResetCountdown, formatTokenCount } from "./utils";

interface UsageDashboardProps {
  providers: ProviderStatus[];
  currentProjectPath?: string | null;
  recentProjects?: UsageProjectOption[];
  threadTitles?: Record<string, string>;
  onClose?: () => void;
}

const DATE_PRESETS: { id: UsageDatePreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

function formatNullableTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "0";
  return formatTokenCount(value);
}

function formatRatioPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function UsageDashboard({
  providers,
  currentProjectPath,
  recentProjects = [],
  threadTitles,
  onClose,
}: UsageDashboardProps) {
  const [datePreset, setDatePreset] = useState<UsageDatePreset>("7d");
  const [selectedProject, setSelectedProject] = useState<string>(currentProjectPath ?? "__all__");
  const [result, setResult] = useState<UsageLogQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: UsageProjectOption[] = [];
    if (currentProjectPath) {
      seen.add(currentProjectPath);
      const name = currentProjectPath.split(/[\\/]/).filter(Boolean).pop() ?? currentProjectPath;
      options.push({ path: currentProjectPath, name: `${name} (current)` });
    }
    for (const proj of recentProjects) {
      if (!seen.has(proj.path)) {
        seen.add(proj.path);
        options.push(proj);
      }
    }
    return options;
  }, [currentProjectPath, recentProjects]);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { startMs, endMs } = computeDateRange(datePreset);
      const projectPath = selectedProject === "__all__" ? null : selectedProject;
      const data = await queryUsageLog({ startMs, endMs, projectPath });
      setResult(data);
      setRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [datePreset, selectedProject]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const handleExportCsv = async () => {
    if (!result) return;
    setExportStatus(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: `orchestratex-usage-${datePreset}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!dest) return;
      const rangeLabel = DATE_PRESETS.find((p) => p.id === datePreset)?.label ?? datePreset;
      const projectLabel =
        selectedProject === "__all__"
          ? "All projects"
          : (projectOptions.find((p) => p.path === selectedProject)?.name ?? selectedProject);
      const csv = buildUsageCsv(result, { rangeLabel, projectLabel });
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(dest, csv);
      setExportStatus("Exported");
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : "Export failed");
    }
  };

  const groupedBreakdown = useMemo(() => {
    if (!result) return [];
    const byProvider = new Map<AgentProviderId, UsageBreakdownRow[]>();
    for (const row of result.byProviderModel) {
      const list = byProvider.get(row.provider) ?? [];
      list.push(row);
      byProvider.set(row.provider, list);
    }
    return result.byProvider.map(({ provider, summary }) => ({
      provider,
      summary,
      rows: byProvider.get(provider) ?? [],
    }));
  }, [result]);

  const dailyBuckets = useMemo(() => {
    if (!result) return { days: [], maxTotal: 0, totalInput: 0 };
    const map = new Map<string, UsageDailyRow[]>();
    for (const row of result.byDay) {
      const list = map.get(row.date) ?? [];
      list.push(row);
      map.set(row.date, list);
    }
    const sortedDates = Array.from(map.keys()).sort();
    let maxTotal = 0;
    let totalInput = 0;
    const days = sortedDates.map((date) => {
      const rows = map.get(date) ?? [];
      const dayTotal = rows.reduce((acc, r) => acc + (r.inputTokens ?? 0), 0);
      if (dayTotal > maxTotal) maxTotal = dayTotal;
      totalInput += dayTotal;
      return { date, rows, dayTotal };
    });
    return { days, maxTotal, totalInput };
  }, [result]);

  return (
    <div className="flex flex-col gap-3 p-4 bg-[var(--bg)] text-[var(--text)] min-h-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Usage &amp; limits</h2>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {refreshedAt && (
            <span className="text-[11.5px] text-[var(--muted)] tabular-nums">
              Refreshed {refreshedAt}
            </span>
          )}

          <fieldset
            className="inline-flex rounded-lg bg-[var(--sunken)] p-0.5 border border-[var(--line)]"
            aria-label="Date range"
          >
            {DATE_PRESETS.map((preset) => {
              const active = datePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setDatePreset(preset.id)}
                  className={`px-2.5 py-1 text-[12px] rounded-md transition-colors ${
                    active
                      ? "bg-[var(--panel)] text-[var(--text)] font-medium shadow-sm"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </fieldset>

          <select
            aria-label="Project scope"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="h-7 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2 text-[12px] text-[var(--text)]"
          >
            <option value="__all__">All projects</option>
            {projectOptions.map((proj) => (
              <option key={proj.path} value={proj.path}>
                {proj.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void loadUsage()}
            disabled={loading}
            className="btn-secondary h-7 px-2.5 text-[12px] inline-flex items-center gap-1.5 rounded-lg"
            title="Refresh usage"
          >
            <ArrowsClockwise
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => void handleExportCsv()}
            disabled={!result || loading}
            className="btn-secondary h-7 px-2.5 text-[12px] inline-flex items-center gap-1.5 rounded-lg"
          >
            <DownloadSimple className="size-3.5" aria-hidden="true" />
            <span>{exportStatus ?? "Export CSV"}</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost h-7 w-7 inline-flex items-center justify-center rounded-lg"
              aria-label="Close usage dashboard"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--error)] bg-[var(--error-bg)] px-3 py-2 text-[12px] text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Quota windows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {providers.map((provider) => {
          const voice = VOICE_TOKENS[provider.id];
          const primaryWindow = provider.rateLimits?.windows[0] ?? null;
          const secondaryWindow = provider.rateLimits?.windows[1] ?? null;
          const usedPct = primaryWindow?.usedPercent;
          const hasQuota = usedPct !== null && usedPct !== undefined;
          const resetText = formatResetCountdown(primaryWindow?.resetsAt);

          return (
            <div
              key={provider.id}
              className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-3.5 flex flex-col"
              style={{ borderTopWidth: "3px", borderTopColor: voice.ink }}
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: voice.ink }}
                  aria-hidden="true"
                />
                <span className="truncate">{provider.name || voice.label}</span>
                <span className="ml-auto text-[11px] font-normal text-[var(--muted)] truncate">
                  {provider.account?.planType ??
                    provider.rateLimits?.planType ??
                    provider.transport}
                </span>
              </div>

              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span
                  className={`text-[24px] font-semibold tracking-tight tabular-nums ${
                    hasQuota ? "text-[var(--text)]" : "text-[var(--muted)]"
                  }`}
                >
                  {hasQuota ? `${Math.round(usedPct)}%` : "—"}
                </span>
                <span className="text-[11.5px] text-[var(--muted)] truncate">
                  {hasQuota ? `of ${primaryWindow?.label ?? "window"}` : "quota not reported"}
                </span>
              </div>

              <div className="mt-2 h-2 rounded bg-[var(--sunken)] overflow-hidden relative">
                {hasQuota && (
                  <span
                    className="absolute inset-y-0 left-0 rounded"
                    style={{
                      width: `${Math.min(100, Math.max(0, usedPct))}%`,
                      backgroundColor: voice.ink,
                    }}
                  />
                )}
              </div>

              <div className="mt-2 flex items-center text-[11px] text-[var(--muted)] gap-2">
                <span className="truncate">
                  {hasQuota
                    ? (resetText ?? primaryWindow?.status ?? "Active")
                    : (provider.rateLimits?.note ?? "Token counts only")}
                </span>
                {secondaryWindow?.usedPercent !== null &&
                  secondaryWindow?.usedPercent !== undefined && (
                    <span className="ml-auto font-mono tabular-nums shrink-0">
                      {secondaryWindow.label} {Math.round(secondaryWindow.usedPercent)}%
                    </span>
                  )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Main content: Breakdown table + Daily chart */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-3 min-h-0">
        {/* Tokens by provider and model */}
        <div className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-3.5 overflow-x-auto">
          <div className="flex items-center justify-between gap-2 pb-2.5">
            <span className="text-[13px] font-semibold">Tokens by provider and model</span>
            <span className="text-[11px] text-[var(--muted)]">— = not reported</span>
          </div>

          <table className="w-full border-collapse text-right">
            <thead>
              <tr className="border-b border-[var(--line)] text-[11px] font-semibold text-[var(--muted)]">
                <th className="text-left pb-2 pr-2 font-semibold">Provider / model</th>
                <th className="pb-2 px-2 font-semibold">Input</th>
                <th className="pb-2 px-2 font-semibold">Cache read</th>
                <th className="pb-2 px-2 font-semibold">Cache write</th>
                <th className="pb-2 px-2 font-semibold">Output</th>
                <th className="pb-2 px-2 font-semibold">Cache share</th>
                <th className="pb-2 px-2 font-semibold">Hit rate</th>
                <th className="pb-2 pl-2 font-semibold">Threads</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[12px] tabular-nums">
              {groupedBreakdown.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="py-6 text-center font-sans text-[12px] text-[var(--muted)]"
                  >
                    {loading ? "Loading usage…" : "No usage recorded for this scope."}
                  </td>
                </tr>
              ) : (
                groupedBreakdown.map((group) => {
                  const voice = VOICE_TOKENS[group.provider];
                  return <ProviderGroupRows key={group.provider} voice={voice} group={group} />;
                })
              )}

              {result && groupedBreakdown.length > 0 && (
                <tr className="font-semibold text-[var(--text)]">
                  <td className="py-2 pr-2 text-left font-sans">All providers</td>
                  <td className="py-2 px-2">{formatNullableTokens(result.total.inputTokens)}</td>
                  <td className="py-2 px-2">
                    {formatNullableTokens(result.total.cacheReadTokens)}
                  </td>
                  <td className="py-2 px-2">
                    {formatNullableTokens(result.total.cacheWriteTokens)}
                  </td>
                  <td className="py-2 px-2">{formatNullableTokens(result.total.outputTokens)}</td>
                  <td className="py-2 px-2">{formatRatioPercent(result.total.cacheShare)}</td>
                  <td className="py-2 px-2 text-[var(--muted)]">
                    {formatRatioPercent(result.total.hitRate)}
                  </td>
                  <td className="py-2 pl-2">{result.total.threadsCount}</td>
                </tr>
              )}
            </tbody>
          </table>

          <p className="mt-2.5 text-[11px] text-[var(--muted)] leading-relaxed">
            Cache share is computed over entries reporting both cache read and input tokens. Hit
            rate requires request-level counts.
          </p>
        </div>

        {/* Daily input chart + limitations */}
        <div className="flex flex-col gap-3 min-h-0">
          <div className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold">Input tokens per day</span>
              <span className="text-[11.5px] font-mono text-[var(--muted)] tabular-nums">
                Total {formatTokenCount(dailyBuckets.totalInput)}
              </span>
            </div>

            {dailyBuckets.days.length === 0 ? (
              <div className="h-[132px] flex items-center justify-center text-[12px] text-[var(--muted)] border-b border-[var(--line)]">
                No daily data
              </div>
            ) : (
              <>
                <div
                  className="flex h-[132px] items-end justify-center gap-1.5 border-b border-[var(--line-strong)] px-1"
                  role="img"
                  aria-label={`Daily input tokens across ${dailyBuckets.days.length} days, totaling ${formatTokenCount(dailyBuckets.totalInput)}`}
                >
                  {dailyBuckets.days.map((day) => {
                    const max = dailyBuckets.maxTotal || 1;
                    return (
                      <div
                        key={day.date}
                        className="flex h-full min-w-[6px] flex-1 flex-col items-center justify-end gap-0.5"
                        title={`${day.date}: ${formatTokenCount(day.dayTotal)}`}
                      >
                        {day.rows.map((r) => {
                          const tokens = r.inputTokens ?? 0;
                          if (tokens <= 0) return null;
                          const pct = Math.max(2, (tokens / max) * 100);
                          return (
                            <span
                              key={`${day.date}-${r.provider}`}
                              className="w-full max-w-10 rounded-[2px]"
                              style={{
                                height: `${pct}%`,
                                backgroundColor: VOICE_TOKENS[r.provider].ink,
                              }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                <div
                  className={`mt-1.5 flex font-mono text-[10.5px] text-[var(--muted)] ${
                    dailyBuckets.days.length === 1 ? "justify-center" : "justify-between"
                  }`}
                >
                  <span>{dailyBuckets.days[0]?.date.slice(5)}</span>
                  {dailyBuckets.days.length > 1 && (
                    <span>{dailyBuckets.days.at(-1)?.date.slice(5)}</span>
                  )}
                </div>
              </>
            )}
          </div>

          {result && result.topThreads.length > 0 && (
            <section className="rounded-[10px] border border-border bg-panel p-3.5 text-xs">
              <h3 className="mb-1 font-semibold">Threads by input tokens</h3>
              <ul className="divide-y divide-border">
                {result.topThreads.map((thread) => (
                  <li
                    key={`${thread.projectPath}:${thread.threadId}`}
                    className="flex items-center gap-2 py-1.5"
                  >
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: VOICE_TOKENS[thread.provider].ink }}
                    />
                    <span className="min-w-0 flex-1 truncate" title={thread.projectPath}>
                      {threadTitles?.[thread.threadId] ?? `Thread ${thread.threadId.slice(0, 8)}`}
                    </span>
                    <span className="shrink-0 font-mono text-muted">
                      {formatNullableTokens(thread.summary.inputTokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderGroupRows({
  voice,
  group,
}: {
  voice: { ink: string; label: string };
  group: {
    provider: AgentProviderId;
    rows: UsageBreakdownRow[];
    summary: {
      inputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      outputTokens: number | null;
      cacheShare: number | null;
      hitRate: number | null;
      threadsCount: number;
    };
  };
}) {
  return (
    <>
      <tr className="bg-[var(--sunken)] font-sans font-semibold text-[12.5px] border-b border-[var(--line)]">
        <td className="py-1.5 pr-2 text-left">
          <span
            className="inline-block size-2 rounded-full mr-2"
            style={{ backgroundColor: voice.ink }}
            aria-hidden="true"
          />
          {voice.label}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.inputTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.cacheReadTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.cacheWriteTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.outputTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatRatioPercent(group.summary.cacheShare)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal text-[var(--muted)]">
          {formatRatioPercent(group.summary.hitRate)}
        </td>
        <td className="py-1.5 pl-2 font-mono font-normal">{group.summary.threadsCount}</td>
      </tr>
      {group.rows.map((row) => (
        <tr
          key={`${group.provider}-${row.model ?? "unknown"}`}
          className="border-b border-[var(--line)]"
        >
          <td className="py-1.5 pr-2 pl-6 text-left font-sans text-[12px] text-[var(--text)]">
            {row.model ?? "Unspecified model"}
          </td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.inputTokens)}</td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.cacheReadTokens)}</td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.cacheWriteTokens)}</td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.outputTokens)}</td>
          <td className="py-1.5 px-2">{formatRatioPercent(row.summary.cacheShare)}</td>
          <td className="py-1.5 px-2 text-[var(--muted)]">
            {formatRatioPercent(row.summary.hitRate)}
          </td>
          <td className="py-1.5 pl-2">{row.summary.threadsCount}</td>
        </tr>
      ))}
    </>
  );
}
