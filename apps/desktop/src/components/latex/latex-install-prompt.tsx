"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useLatexInstaller } from "@/lib/latex";

interface LaTeXInstallPromptProps {
  onRefreshCompilers?: () => void;
}

export function LaTeXInstallPrompt({ onRefreshCompilers }: LaTeXInstallPromptProps) {
  const {
    distributions,
    progress,
    result,
    fetchDistributions,
    install,
    openDownloadPage,
    reset,
    isInstalling,
  } = useLatexInstaller();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetchDistributions();
  }, [fetchDistributions]);

  useEffect(() => {
    if (distributions.length > 0 && !selectedId) {
      const first = distributions[0];
      if (first) setSelectedId(first.id);
    }
  }, [distributions, selectedId]);

  const selectedDist = distributions.find((d) => d.id === selectedId) ?? distributions[0] ?? null;

  const handleInstall = async (distributionId: string) => {
    const outcome = await install(distributionId);
    if (outcome?.success) onRefreshCompilers?.();
  };

  const handleOpenDownload = (url: string) => {
    openDownloadPage(url);
  };

  const handleRefresh = useCallback(() => {
    onRefreshCompilers?.();
    reset();
  }, [onRefreshCompilers, reset]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5 min-h-[30px] text-[12.5px]">
        <span
          className="size-4 rounded-full bg-error-bg text-error text-[10px] font-bold flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          ✕
        </span>
        <span className="text-foreground">No TeX distribution found on PATH</span>
      </div>

      <AnimatePresence mode="wait">
        {isInstalling && progress && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-[10px] border border-border bg-background p-3"
          >
            <div className="flex items-center gap-2">
              <Spinner className="size-4" />
              <span className="text-[12.5px] font-medium">{progress.stage}</span>
            </div>
            <p className="text-[12px] text-muted mt-1 break-words">{progress.message}</p>
            {progress.progress !== null && (
              <div className="mt-2 h-1.5 bg-sunken rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.progress * 100}%` }}
                />
              </div>
            )}
          </motion.div>
        )}

        {result && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className={`rounded-[10px] border p-3 ${
              result.success
                ? "bg-success-bg border-[var(--ok-line)]"
                : "bg-error-bg border-[var(--danger-line)]"
            }`}
          >
            <p
              className={`text-[12.5px] whitespace-pre-wrap ${
                result.success ? "text-success" : "text-error"
              }`}
            >
              {result.message}
            </p>
            {result.success ? (
              <div className="mt-2.5 flex items-center gap-3">
                <button type="button" onClick={handleRefresh} className="btn btn-primary btn-sm">
                  Detect again
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={reset}
                className="mt-2 text-[12px] text-foreground underline underline-offset-2"
              >
                Try again
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!isInstalling && !result && distributions.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {distributions.map((dist) => {
              const isSelected = selectedDist?.id === dist.id;
              return (
                <label
                  key={dist.id}
                  className={`flex items-start gap-3 rounded-[10px] border p-3 bg-background cursor-pointer transition-colors ${
                    isSelected
                      ? "border-[1.5px] border-foreground shadow-[2px_2px_0_var(--popover-border)]"
                      : "border-border hover:border-border-dark"
                  }`}
                >
                  <input
                    type="radio"
                    name="latex-dist"
                    checked={isSelected}
                    onChange={() => setSelectedId(dist.id)}
                    className="mt-0.5 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 font-semibold text-[12.5px]">
                      <span>{dist.name}</span>
                      {dist.install_command && (
                        <span className="font-mono font-normal text-[11.5px] text-muted truncate">
                          {dist.install_command}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-muted mt-0.5">{dist.description}</p>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-1">
            {selectedDist?.install_command && (
              <button
                type="button"
                onClick={() => handleInstall(selectedDist.id)}
                className="btn btn-primary btn-sm"
              >
                Install {selectedDist.name}
              </button>
            )}
            <button type="button" onClick={handleRefresh} className="btn btn-secondary btn-sm">
              Detect again
            </button>
            {selectedDist?.download_url && (
              <button
                type="button"
                onClick={() => {
                  if (selectedDist.download_url) handleOpenDownload(selectedDist.download_url);
                }}
                className="btn btn-ghost btn-sm underline underline-offset-3"
              >
                Download page
              </button>
            )}
          </div>
        </>
      )}

      {!isInstalling && !result && distributions.length === 0 && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted py-1">
          <Spinner className="size-3.5" />
          <span>Loading available distributions…</span>
        </div>
      )}
    </div>
  );
}
