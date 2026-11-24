"use client";

import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { AgentStatusCard } from "@/components/agent/agent-status-card";
import { LaTeXInstallPrompt } from "@/components/latex/latex-install-prompt";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ProviderStatus } from "@/lib/agent/types";
import type { LaTeXCompilersStatus } from "@/lib/latex/types";
import type { RecentProject } from "@/lib/recent-projects";

export interface ProjectThreadCounts {
  total: number;
  running: number;
  waiting: number;
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
  onRefreshRateLimits,
  onOpenAgentSettings,
}: HomeWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = recentProjects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(normalizedQuery),
  );
  const hasCompiler =
    compilersStatus && Object.values(compilersStatus).some((compiler) => compiler.available);

  return (
    <section aria-label="Home" className="h-full overflow-auto bg-bg p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="font-display text-5xl tracking-tight text-foreground-strong">
          OrchestraTeX
        </h1>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
          <section
            aria-labelledby="recent-projects-heading"
            className="ox-frame min-w-0 bg-panel p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="recent-projects-heading" className="text-lg font-semibold">
                Recent projects
              </h2>
              <input
                aria-label="Search recent projects"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <ul className="mt-4 divide-y divide-border">
              {filtered.map((project) => {
                const counts = threadCounts?.[project.path];
                return (
                  <li key={project.path} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenProject(project.path)}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-subtle"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{project.name}</span>
                        <span className="block truncate font-mono text-xs text-muted">
                          {project.path}
                        </span>
                      </span>
                      {counts && (
                        <span className="shrink-0 text-xs text-muted">
                          {counts.running > 0
                            ? `${counts.running} running`
                            : counts.waiting > 0
                              ? `${counts.waiting} waiting`
                              : `${counts.total} ${counts.total === 1 ? "thread" : "threads"}`}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${project.name} from recent projects`}
                      className="btn btn-ghost btn-sm"
                      onClick={() => onRemoveProject(project.path)}
                    >
                      <TrashIcon className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {filtered.length === 0 && (
              <p className="py-4 text-sm text-muted">
                {normalizedQuery ? "No matching projects" : "No recent projects"}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={onOpenFolder}>
                Open folder
              </button>
              <button type="button" className="btn btn-secondary" onClick={onNewProject}>
                New project
              </button>
              <button type="button" className="btn btn-secondary" onClick={onCloneFromGit}>
                Clone from Git
              </button>
              {recentProjects.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmClear(true)}
                >
                  Clear recents
                </button>
              )}
            </div>
          </section>
          <aside className="space-y-4" aria-label="Setup status">
            <section className="ox-frame bg-panel p-5">
              <h2 className="mb-3 text-lg font-semibold">LaTeX</h2>
              {!compilersStatus ? (
                <p className="text-sm text-muted">Checking compilers</p>
              ) : hasCompiler ? (
                <ul className="space-y-1 text-sm">
                  {Object.entries(compilersStatus)
                    .filter(([, compiler]) => compiler.available)
                    .map(([name]) => (
                      <li key={name}>{name}</li>
                    ))}
                </ul>
              ) : (
                <LaTeXInstallPrompt onRefreshCompilers={onRefreshCompilers} />
              )}
            </section>
            <section className="ox-frame bg-panel p-5">
              <h2 className="mb-3 text-lg font-semibold">Agent tools</h2>
              <AgentStatusCard
                providers={providers}
                loading={providersLoading}
                onRefreshProviders={onRefreshProviders}
                onRefreshRateLimits={onRefreshRateLimits}
                onOpenSettings={onOpenAgentSettings}
              />
            </section>
          </aside>
        </div>
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
