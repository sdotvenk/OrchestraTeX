"use client";

import { CaretDown } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatModelDisplayName } from "@/lib/agent/model-display";
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
import { HarnessQuotaCard } from "./harness-quota-card";
import { ProviderIcon } from "./icons";
import { formatTokenCount } from "./utils";

export interface UsageDashboardTopBarState {
  refreshedAt: string | null;
  loading: boolean;
  canExport: boolean;
  exportStatus: string | null;
  onRefresh: () => void;
  onExportCsv: () => void;
}

interface UsageDashboardProps {
  providers: ProviderStatus[];
  currentProjectPath?: string | null;
  recentProjects?: UsageProjectOption[];
  threadTitles?: Record<string, string>;
  onTopBarStateChange?: (state: UsageDashboardTopBarState) => void;
}

const HARNESS_ORDER: AgentProviderId[] = ["claude", "codex", "antigravity", "custom-acp"];

const DATE_PRESETS: { id: UsageDatePreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

function formatCompactTokens(value: number | null | undefined): string {
  return formatTokenCount(value).replace(/K$/, "k");
}

function formatNullableTokens(
  value: number | null | undefined,
  treatZeroAsUnreported = false,
): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return treatZeroAsUnreported ? "—" : "0";
  return formatCompactTokens(value);
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
  onTopBarStateChange,
}: UsageDashboardProps) {
  const [datePreset, setDatePreset] = useState<UsageDatePreset>("7d");
  const [selectedProject, setSelectedProject] = useState<string>(currentProjectPath ?? "__all__");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (!projectMenuRef.current?.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [projectMenuOpen]);

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

  const [loadedScope, setLoadedScope] = useState<{
    result: UsageLogQueryResult;
    datePreset: UsageDatePreset;
    selectedProject: string;
    rangeLabel: string;
    projectLabel: string;
  } | null>(null);
  const requestIdRef = useRef(0);
  const scopeMatchesCurrent =
    loadedScope !== null &&
    loadedScope.datePreset === datePreset &&
    loadedScope.selectedProject === selectedProject;
  const result = scopeMatchesCurrent ? loadedScope.result : null;

  const loadUsage = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setExportStatus(null);
    const rangeLabel = DATE_PRESETS.find((p) => p.id === datePreset)?.label ?? datePreset;
    const projectLabel =
      selectedProject === "__all__"
        ? "All projects"
        : (projectOptions.find((p) => p.path === selectedProject)?.name ?? selectedProject);
    try {
      const { startMs, endMs } = computeDateRange(datePreset);
      const projectPath = selectedProject === "__all__" ? null : selectedProject;
      const data = await queryUsageLog({ startMs, endMs, projectPath });
      if (requestIdRef.current !== requestId) return;
      setLoadedScope({
        result: data,
        datePreset,
        selectedProject,
        rangeLabel,
        projectLabel,
      });
      setRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setLoadedScope(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [datePreset, selectedProject, projectOptions]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const handleExportCsv = useCallback(async () => {
    if (!loadedScope || !scopeMatchesCurrent) return;
    setExportStatus(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: `orchestratex-usage-${loadedScope.datePreset}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!dest) return;
      const csv = buildUsageCsv(loadedScope.result, {
        rangeLabel: loadedScope.rangeLabel,
        projectLabel: loadedScope.projectLabel,
      });
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(dest, csv);
      setExportStatus("Exported");
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : "Export failed");
    }
  }, [loadedScope, scopeMatchesCurrent]);

  useEffect(() => {
    onTopBarStateChange?.({
      refreshedAt,
      loading,
      canExport: scopeMatchesCurrent && !loading && !error,
      exportStatus,
      onRefresh: () => void loadUsage(),
      onExportCsv: () => void handleExportCsv(),
    });
  }, [
    onTopBarStateChange,
    refreshedAt,
    loading,
    scopeMatchesCurrent,
    error,
    exportStatus,
    loadUsage,
    handleExportCsv,
  ]);

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
    const map = new Map<string, UsageDailyRow[]>();
    if (result) {
      for (const row of result.byDay) {
        const list = map.get(row.date) ?? [];
        list.push(row);
        map.set(row.date, list);
      }
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    let dates: string[];
    if (datePreset === "7d") {
      dates = [];
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
    } else {
      dates = Array.from(map.keys()).sort();
    }

    let maxTotal = 0;
    let totalInput = 0;
    const days = dates.map((date) => {
      const rows = map.get(date) ?? [];
      const dayTotal = rows.reduce((acc, r) => acc + (r.inputTokens ?? 0), 0);
      if (dayTotal > maxTotal) maxTotal = dayTotal;
      totalInput += dayTotal;
      const d = new Date(`${date}T12:00:00`);
      const weekdayInitial = ["S", "M", "T", "W", "T", "F", "S"][d.getDay()] ?? "";
      return {
        date,
        rows,
        dayTotal,
        weekdayInitial,
        isToday: date === todayStr,
      };
    });
    return { days, maxTotal, totalInput };
  }, [result, datePreset]);

  const orderedProviders = useMemo(() => {
    const byId = new Map(providers.map((p) => [p.id, p]));
    return HARNESS_ORDER.map((id) => ({
      id,
      provider: byId.get(id) ?? null,
    }));
  }, [providers]);

  return (
    <div className="flex flex-col gap-3.5 px-7 py-5 bg-bg text-foreground min-h-full">
      {/* Subheader */}
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="font-display text-[34px] leading-none text-foreground">
          Usage &amp; limits
        </h1>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <fieldset
            className="inline-flex rounded-[9px] bg-sunken p-[3px] gap-0.5 text-[12.5px]"
            aria-label="Date range"
          >
            {DATE_PRESETS.map((preset) => {
              const active = datePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setDatePreset(preset.id)}
                  className={`px-3 py-1 rounded-[7px] transition-colors ${
                    active
                      ? "bg-panel text-foreground font-medium shadow-xs ring-1 ring-border"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </fieldset>

          <div ref={projectMenuRef} className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={projectMenuOpen}
              aria-label="Project scope"
              onClick={() => setProjectMenuOpen((open) => !open)}
              className="btn btn-secondary btn-sm whitespace-nowrap inline-flex items-center gap-1.5"
            >
              <span className="max-w-[180px] truncate">
                {selectedProject === "__all__"
                  ? "All projects"
                  : (projectOptions.find((p) => p.path === selectedProject)?.name ??
                    selectedProject)}
              </span>
              <CaretDown className="size-3 opacity-75 shrink-0" aria-hidden="true" />
            </button>
            {projectMenuOpen && (
              <div
                role="listbox"
                aria-label="Project scope options"
                className="ox-popover absolute right-0 top-full mt-1.5 z-30 min-w-[200px] max-h-60 overflow-y-auto p-1"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedProject === "__all__"}
                  onClick={() => {
                    setSelectedProject("__all__");
                    setProjectMenuOpen(false);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-[6px] text-left text-[12px] flex items-center justify-between gap-2 transition-colors ${
                    selectedProject === "__all__"
                      ? "bg-subtle text-foreground-strong font-medium"
                      : "text-foreground hover:bg-subtle"
                  }`}
                >
                  <span>All projects</span>
                  {selectedProject === "__all__" && (
                    <span className="font-mono text-[11px]">✓</span>
                  )}
                </button>
                {projectOptions.map((proj) => {
                  const selected = selectedProject === proj.path;
                  return (
                    <button
                      key={proj.path}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setSelectedProject(proj.path);
                        setProjectMenuOpen(false);
                      }}
                      className={`w-full px-2.5 py-1.5 rounded-[6px] text-left text-[12px] flex items-center justify-between gap-2 transition-colors ${
                        selected
                          ? "bg-subtle text-foreground-strong font-medium"
                          : "text-foreground hover:bg-subtle"
                      }`}
                    >
                      <span className="truncate">{proj.name}</span>
                      {selected && <span className="font-mono text-[11px]">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-error bg-error-bg px-3 py-2 text-[12px] text-error">
          {error}
        </div>
      )}

      {/* 4 Harness Quota Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {orderedProviders.map(({ id, provider }) => (
          <HarnessQuotaCard key={id} providerId={id} provider={provider} />
        ))}
      </div>

      {/* Bottom 2-column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-3 flex-1 min-h-0">
        {/* Tokens by harness and model */}
        <div className="ox-frame p-3.5 overflow-x-auto">
          <div className="flex items-center justify-between gap-2 pb-3">
            <span className="text-[13px] font-semibold">Tokens by harness and model</span>
            <span className="text-[11.5px] text-muted">
              Input includes cache reads once · — = not reported
            </span>
          </div>

          <table className="w-full table-fixed border-collapse text-right">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[10%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[11%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-[11px] font-semibold text-muted">
                <th className="text-left pb-2 pr-2 font-semibold">Harness / model</th>
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
                  <td colSpan={8} className="py-6 text-center font-sans text-[12px] text-muted">
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
                <tr className="font-semibold text-foreground">
                  <td className="py-2 pr-2 text-left font-sans">All harnesses</td>
                  <td className="py-2 px-2">{formatNullableTokens(result.total.inputTokens)}</td>
                  <td className="py-2 px-2">
                    {formatNullableTokens(result.total.cacheReadTokens)}
                  </td>
                  <td className="py-2 px-2">
                    {formatNullableTokens(result.total.cacheWriteTokens, true)}
                  </td>
                  <td className="py-2 px-2">{formatNullableTokens(result.total.outputTokens)}</td>
                  <td className="py-2 px-2">{formatRatioPercent(result.total.cacheShare)}</td>
                  <td className="py-2 px-2 text-muted">
                    {formatRatioPercent(result.total.hitRate)}
                  </td>
                  <td className="py-2 pl-2">{result.total.threadsCount}</td>
                </tr>
              )}
            </tbody>
          </table>

          <p className="mt-2.5 text-[11.5px] text-muted leading-relaxed">
            Cache share is computed over entries reporting both cache read and input tokens. Hit
            rate requires request-level counts, so it isn&apos;t totalled.
          </p>
        </div>

        {/* Right stack: Input tokens per day + Heaviest threads */}
        <div className="flex flex-col gap-3 min-h-0">
          <div className="ox-frame p-3.5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold">Input tokens per day</span>
              <span className="text-[11.5px] font-mono text-muted tabular-nums">
                Total {formatCompactTokens(dailyBuckets.totalInput)}
              </span>
            </div>

            {dailyBuckets.days.length === 0 ? (
              <div className="h-[132px] flex items-center justify-center text-[12px] text-muted border-b border-border">
                No daily data
              </div>
            ) : (
              <>
                <div
                  className="flex h-[132px] items-end justify-center gap-3 border-b border-border-dark px-1"
                  role="img"
                  aria-label={`Daily input tokens across ${dailyBuckets.days.length} days, totaling ${formatCompactTokens(dailyBuckets.totalInput)}`}
                >
                  {dailyBuckets.days.map((day) => {
                    const max = dailyBuckets.maxTotal || 1;
                    const nonZeroRows = day.rows.filter((r) => (r.inputTokens ?? 0) > 0);
                    return (
                      <div
                        key={day.date}
                        className="flex h-full min-w-[6px] flex-1 flex-col items-center justify-end gap-0.5"
                        title={`${day.date}: ${formatCompactTokens(day.dayTotal)}`}
                      >
                        {nonZeroRows.map((r, idx) => {
                          const tokens = r.inputTokens ?? 0;
                          const pct = Math.max(3, (tokens / max) * 100);
                          const isTopOfToday = day.isToday && idx === 0;
                          return (
                            <span
                              key={`${day.date}-${r.provider}`}
                              className={`w-full max-w-10 rounded-[2px] ${
                                isTopOfToday
                                  ? "outline outline-[1.5px] outline-foreground outline-offset-1"
                                  : ""
                              }`}
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
                {datePreset === "7d" ? (
                  <div className="mt-1.5 flex justify-around font-mono text-[10.5px] text-muted">
                    {dailyBuckets.days.map((day) => (
                      <span
                        key={`lbl-${day.date}`}
                        className={day.isToday ? "font-semibold text-foreground" : ""}
                      >
                        {day.weekdayInitial}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div
                    className={`mt-1.5 flex font-mono text-[10.5px] text-muted ${
                      dailyBuckets.days.length === 1 ? "justify-center" : "justify-between"
                    }`}
                  >
                    <span>{dailyBuckets.days[0]?.date.slice(5)}</span>
                    {dailyBuckets.days.length > 1 && (
                      <span>{dailyBuckets.days.at(-1)?.date.slice(5)}</span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <section className="ox-frame p-3.5 flex-1 text-[12.5px]">
            <h3 className="mb-2 font-semibold text-[13px]">Heaviest threads</h3>
            {!result || result.topThreads.length === 0 ? (
              <div className="py-4 text-center text-[12px] text-muted">No threads recorded</div>
            ) : (
              <ul className="space-y-0.5">
                {result.topThreads.map((thread) => {
                  const cachePct = formatRatioPercent(thread.summary.cacheShare);
                  return (
                    <li
                      key={`${thread.projectPath}:${thread.threadId}`}
                      className="flex items-center gap-2 h-[28px]"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: VOICE_TOKENS[thread.provider].ink }}
                      />
                      <span className="min-w-0 flex-1 truncate" title={thread.projectPath}>
                        {threadTitles?.[thread.threadId] ?? `Thread ${thread.threadId.slice(0, 8)}`}
                      </span>
                      <span className="shrink-0 font-mono text-[12px] text-muted">
                        {formatNullableTokens(thread.summary.inputTokens)} · {cachePct}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
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
          <span style={{ color: voice.ink }} className="mr-2 inline-flex align-text-bottom">
            <ProviderIcon providerId={group.provider} className="size-3" />
          </span>
          {voice.label}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.inputTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.cacheReadTokens)}
        </td>
        <td className="py-1.5 px-2 font-mono font-normal">
          {formatNullableTokens(group.summary.cacheWriteTokens, true)}
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
          <td className="py-1.5 pr-2 pl-6 text-left font-sans text-[12px] text-[var(--text)] truncate">
            {formatModelDisplayName(row.model) || "Unspecified model"}
          </td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.inputTokens)}</td>
          <td className="py-1.5 px-2">{formatNullableTokens(row.summary.cacheReadTokens)}</td>
          <td className="py-1.5 px-2">
            {formatNullableTokens(row.summary.cacheWriteTokens, true)}
          </td>
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
