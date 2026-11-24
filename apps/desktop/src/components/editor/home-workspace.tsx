"use client";

import { TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ProviderIcon } from "@/components/agent/icons";
import { LaTeXInstallPrompt } from "@/components/latex/latex-install-prompt";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OrchestraTeXWordmark } from "@/components/ui/orchestratex-wordmark";
import type { AgentProviderId, ProviderStatus } from "@/lib/agent/types";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
import { COMPILER_DISPLAY_NAMES, type LaTeXCompilersStatus } from "@/lib/latex/types";
import type { RecentProject } from "@/lib/recent-projects";

export interface ProjectThreadCounts {
  total: number;
  running: number;
  waiting: number;
  providerIds: AgentProviderId[];
}

export interface HomeWorkspaceProps {
  recentProjects: RecentProject[];
  threadCounts?: Record<string, ProjectThreadCounts>;
  compilersStatus: LaTeXCompilersStatus | null;
  providers: ProviderStatus[];
  providersLoading?: boolean;
  onOpenProject: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onClearProjects: () => void;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onCloneFromGit: () => void;
  onRefreshCompilers: () => void;
  onRefreshProviders: () => Promise<unknown>;
  onRefreshRateLimits: (providerId: ProviderStatus["id"]) => Promise<unknown>;
  onOpenAgentSettings: () => void;
}

const HARNESS_ORDER: { id: AgentProviderId; name: string; fallbackMeta: string }[] = [
  { id: "claude", name: "Claude Code", fallbackMeta: "claude" },
  { id: "codex", name: "Codex", fallbackMeta: "app-server" },
  { id: "antigravity", name: "Antigravity", fallbackMeta: "agy acp" },
  { id: "custom-acp", name: "Custom ACP", fallbackMeta: "any ACP binary" },
];

function formatShortPath(fullPath?: string | null): string {
  if (!fullPath) return "";
  return fullPath.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function HomeWorkspace({
  recentProjects,
  threadCounts,
  compilersStatus,
  providers,
  providersLoading,
  onOpenProject,
  onRemoveProject,
  onClearProjects,
  onOpenFolder,
  onNewProject,
  onCloneFromGit,
  onRefreshCompilers,
  onRefreshProviders,
  onOpenAgentSettings,
}: HomeWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = recentProjects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(normalizedQuery),
  );
  const hasCompiler =
    compilersStatus && Object.values(compilersStatus).some((compiler) => compiler.available);

  const installedCompilers = compilersStatus
    ? Object.values(compilersStatus)
        .filter((compiler) => compiler.available)
        .map((compiler) => COMPILER_DISPLAY_NAMES[compiler.name as keyof LaTeXCompilersStatus])
        .join(", ")
    : "";

  const isMac = detectIsMac();

  return (
    <section aria-label="Home" className="h-full overflow-auto bg-bg">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_520px] gap-7 px-6 lg:px-14 pt-4 pb-10 max-w-[1440px] mx-auto min-h-full">
        {/* Left column */}
        <div className="flex flex-col gap-5 min-h-0">
          <h1>
            <OrchestraTeXWordmark prominent />
          </h1>

          <div className="flex flex-wrap items-center gap-2.5">
            <button type="button" className="btn btn-primary" onClick={onOpenFolder}>
              Open folder…
            </button>
            <button type="button" className="btn btn-secondary" onClick={onNewProject}>
              New project
            </button>
            <button type="button" className="btn btn-secondary" onClick={onCloneFromGit}>
              Clone from Git…
            </button>
          </div>

          <section
            aria-labelledby="recent-projects-heading"
            className="ox-frame rounded-[12px] flex-1 flex flex-col min-h-0 bg-panel"
          >
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
              <h2 id="recent-projects-heading" className="ox-sec">
                Recent projects
              </h2>
              <div className="ml-auto flex items-center gap-2">
                <input
                  ref={searchInputRef}
                  aria-label="Search recent projects"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search ⌘P"
                  className="w-40 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] placeholder:text-muted focus:outline-none focus:border-border-dark"
                />
                {recentProjects.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-[12px] text-muted"
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {filtered.length > 0 ? (
              <ul className="flex-1 overflow-auto divide-y divide-border/60">
                {filtered.map((project) => {
                  const counts = threadCounts?.[project.path];
                  const uniqueProviders = counts?.providerIds ?? [];
                  const threadLabel = counts
                    ? counts.running > 0
                      ? `${counts.running} running`
                      : counts.waiting > 0
                        ? `${counts.waiting} waiting`
                        : counts.total > 0
                          ? `${counts.total} ${counts.total === 1 ? "thread" : "threads"} active`
                          : null
                    : null;

                  return (
                    <li
                      key={project.path}
                      className="group flex items-center gap-3.5 px-4 py-3 hover:bg-subtle/60 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenProject(project.path)}
                        className="flex flex-1 min-w-0 items-center gap-3.5 text-left"
                      >
                        {/* Miniature page thumbnail */}
                        <span
                          aria-hidden="true"
                          className="w-[42px] h-[54px] rounded-[2px] bg-background shadow-xs ring-1 ring-border shrink-0 p-1.5 flex flex-col gap-[3px]"
                        >
                          <span className="h-[3px] w-[70%] bg-foreground/75 rounded-[0.5px]" />
                          <span className="h-[2px] w-full bg-muted-foreground/45 rounded-[0.5px]" />
                          <span className="h-[2px] w-[85%] bg-muted-foreground/45 rounded-[0.5px]" />
                          <span className="h-[12px] w-full mt-0.5 border border-border rounded-[1px]" />
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-[13px] text-foreground">
                            {project.name}
                          </span>
                          <span className="block truncate font-mono text-[11.5px] text-muted mt-0.5">
                            {formatShortPath(project.path)}
                          </span>
                        </span>

                        {threadLabel && (
                          <span className="shrink-0 flex items-center gap-1.5 text-[12px] text-muted">
                            {uniqueProviders.map((pid) => (
                              <span
                                key={pid}
                                className="size-[7px] rounded-full shrink-0"
                                style={{ backgroundColor: VOICE_COLORS[pid].ink }}
                                aria-hidden="true"
                              />
                            ))}
                            <span>{threadLabel}</span>
                          </span>
                        )}

                        <span className="shrink-0 text-[12px] text-muted w-20 text-right tabular-nums">
                          {formatRelativeTime(project.lastOpened)}
                        </span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Remove ${project.name} from recent projects`}
                        className="btn btn-ghost btn-sm w-0 overflow-hidden px-0 opacity-0 group-hover:w-7 group-hover:px-1.5 group-hover:opacity-100 focus:w-7 focus:px-1.5 focus:opacity-100 transition-all shrink-0"
                        onClick={() => onRemoveProject(project.path)}
                      >
                        <TrashIcon className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-6 text-[13px] text-muted">
                {normalizedQuery ? "No matching projects" : "No recent projects"}
              </p>
            )}
          </section>
        </div>

        {/* Right column: unified setup sheet */}
        <aside
          aria-label="Setup status"
          className="ox-frame rounded-[12px] bg-panel p-6 flex flex-col gap-4 self-start"
        >
          <h2 className="text-[17px] font-semibold text-foreground">
            {isMac ? "Set up this Mac" : "Set up this machine"}
          </h2>

          {/* Section 1: LaTeX */}
          <div className="flex flex-col gap-2">
            <div className="ox-sec">LaTeX</div>
            {!compilersStatus ? (
              <p className="text-[12.5px] text-muted">Checking compilers…</p>
            ) : hasCompiler ? (
              <div className="flex items-center gap-2.5 min-h-[30px] text-[12.5px]">
                <span
                  className="size-4 rounded-full bg-success-bg text-success text-[10px] font-bold flex items-center justify-center shrink-0"
                  aria-hidden="true"
                >
                  ✓
                </span>
                <span className="font-medium text-foreground">Ready</span>
                <span className="text-muted truncate">· {installedCompilers}</span>
                <button
                  type="button"
                  onClick={onRefreshCompilers}
                  className="ml-auto rounded-md border border-border-dark bg-panel px-2.5 py-0.5 text-[12px] hover:bg-subtle shrink-0"
                >
                  Detect again
                </button>
              </div>
            ) : (
              <LaTeXInstallPrompt onRefreshCompilers={onRefreshCompilers} />
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Section 2: Agents */}
          <div className="flex flex-col gap-1.5">
            <div className="ox-sec mb-1">Agents</div>
            {HARNESS_ORDER.map((harness) => {
              const status = providers.find((p) => p.id === harness.id);
              const installed = status?.installed ?? false;
              const authenticated = status?.authenticated ?? false;
              const versionText = status?.version ? `v${status.version}` : harness.fallbackMeta;
              const statusLabel = installed
                ? authenticated
                  ? `${versionText} · signed in`
                  : `${versionText} · not signed in`
                : harness.id === "custom-acp"
                  ? harness.fallbackMeta
                  : "not found";
              const rightMeta: string | null =
                status?.models.find((m) => m.isDefault)?.name ??
                status?.models[0]?.name ??
                status?.account?.planType ??
                status?.rateLimits?.planType ??
                null;

              return (
                <div
                  key={harness.id}
                  className="flex items-center gap-2.5 min-h-[30px] text-[12.5px]"
                >
                  {installed && authenticated ? (
                    <span
                      className="size-4 rounded-full bg-success-bg text-success text-[10px] font-bold flex items-center justify-center shrink-0"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  ) : installed && !authenticated ? (
                    <span
                      className="size-4 rounded-full bg-warn-bg text-warn text-[10px] font-bold flex items-center justify-center shrink-0"
                      aria-hidden="true"
                    >
                      !
                    </span>
                  ) : (
                    <span
                      className="size-4 rounded-full border-[1.5px] border-dashed border-muted-foreground shrink-0"
                      aria-hidden="true"
                    />
                  )}

                  <span
                    className="shrink-0 flex items-center"
                    style={{ color: VOICE_COLORS[harness.id].ink }}
                  >
                    <ProviderIcon providerId={harness.id} className="size-3.5" />
                  </span>

                  <span className="font-medium text-foreground shrink-0">{harness.name}</span>
                  <span className="font-mono text-[11.5px] text-muted truncate">{statusLabel}</span>

                  {installed && authenticated ? (
                    rightMeta && (
                      <span className="ml-auto text-[12px] text-muted truncate">{rightMeta}</span>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={onOpenAgentSettings}
                      className="ml-auto rounded-md border border-border-dark bg-panel px-2.5 py-0.5 text-[12px] hover:bg-subtle shrink-0"
                    >
                      {harness.id === "custom-acp" && !installed ? "Add…" : "Configure"}
                    </button>
                  )}
                </div>
              );
            })}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => void Promise.all([onRefreshCompilers(), onRefreshProviders()])}
                disabled={providersLoading}
                className="btn btn-secondary btn-sm"
              >
                {providersLoading ? "Detecting…" : "Detect again"}
              </button>
              <button type="button" onClick={onOpenAgentSettings} className="btn btn-ghost btn-sm">
                Configure…
              </button>
            </div>
          </div>
        </aside>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="Clear recent projects?"
          message="Remove all projects from this list."
          confirmLabel="Clear recents"
          onConfirm={() => {
            onClearProjects();
            setConfirmClear(false);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </section>
  );
}
