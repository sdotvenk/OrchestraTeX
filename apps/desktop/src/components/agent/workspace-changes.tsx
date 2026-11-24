"use client";

import type { GitStatus } from "@orchestratex/shared";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

type WorkspaceChange = GitStatus["changes"][number];

interface WorkspaceChangesProps {
  directory: string;
  status: GitStatus;
  onChanged: () => Promise<void>;
}

export function WorkspaceChanges({ directory, status, onChanged }: WorkspaceChangesProps) {
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openDiff = (change: WorkspaceChange) =>
    run(async () => {
      const content = await invoke<string>("git_diff", {
        dir: directory,
        file: change.path,
        staged: change.staged,
      });
      setDiff({ path: change.path, content });
    });

  const changeStage = (change: WorkspaceChange) =>
    run(async () => {
      await invoke(change.staged ? "git_unstage" : "git_add", {
        dir: directory,
        files: [change.path],
      });
      setDiff(null);
      await onChanged();
    });

  return (
    <section aria-label="Checkout changes" className="space-y-2 p-2 text-xs">
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {status.changes.length === 0 ? (
        <p className="text-muted">No working changes</p>
      ) : (
        <ul className="divide-y divide-border">
          {status.changes.map((change) => (
            <li key={`${change.staged}-${change.path}`} className="flex items-center gap-2 py-1">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono text-accent"
                title={change.path}
                disabled={busy}
                onClick={() => void openDiff(change)}
              >
                {change.path}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void changeStage(change)}
              >
                {change.staged ? "Unstage" : "Stage"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="rounded border border-border bg-panel p-2">
          <h3 className="break-all font-mono font-medium">{diff.path}</h3>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-muted">
            {diff.content || "No Git diff available"}
          </pre>
        </div>
      )}
    </section>
  );
}
