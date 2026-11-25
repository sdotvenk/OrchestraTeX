"use client";

import { CheckIcon, FileTextIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MainFileDetectionResult } from "@/lib/latex/types";
import { pathSync } from "@/lib/path";

interface MainFileSelectionDialogProps {
  open: boolean;
  detectionResult: MainFileDetectionResult;
  onSelect: (mainFile: string) => void;
  onCancel: () => void;
}

export function MainFileSelectionDialog({
  open,
  detectionResult,
  onSelect,
  onCancel,
}: MainFileSelectionDialogProps) {
  const [selected, setSelected] = useState<string | null>(
    detectionResult.main_file || detectionResult.tex_files[0] || null,
  );

  useEffect(() => {
    setSelected(detectionResult.main_file || detectionResult.tex_files[0] || null);
  }, [detectionResult]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && selected) {
        e.preventDefault();
        onSelect(selected);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selected, onSelect, onCancel]);

  if (!open) return null;

  const getFileName = (path: string) => pathSync.basename(path);

  return createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-foreground/30"
          onClick={onCancel}
        />

        {/* Dialog */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 6 }}
          transition={{ duration: 0.12 }}
          className="relative z-10 w-full max-w-md ox-frame rounded-[12px] bg-panel border border-border text-foreground shadow-[var(--frame-shadow)]"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-[15px] font-semibold text-foreground-strong">Select main file</h3>
            <p className="mt-1 text-[13px] text-muted">{detectionResult.message}</p>
          </div>

          {/* Content */}
          <div className="px-5 py-4 max-h-64 overflow-y-auto">
            {detectionResult.tex_files.length === 0 ? (
              <p className="text-[13px] text-muted py-4 text-center">
                No .tex files found in the project.
              </p>
            ) : (
              <div className="space-y-1">
                {detectionResult.tex_files.map((file) => {
                  const isSelected = selected === file;
                  const fileName = getFileName(file);
                  const isRecommended = file === detectionResult.main_file;

                  return (
                    <button
                      type="button"
                      key={file}
                      onClick={() => setSelected(file)}
                      className={`w-full text-left px-3 py-2 rounded-[8px] text-[13px] transition-colors flex items-center justify-between group ${
                        isSelected
                          ? "bg-primary text-primary-text"
                          : "hover:bg-subtle text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTextIcon
                          className={`size-4 flex-shrink-0 ${isSelected ? "text-primary-text" : "text-muted-foreground"}`}
                        />
                        <span className="truncate font-medium">{fileName}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isRecommended && (
                          <span
                            className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${
                              isSelected
                                ? "bg-primary-text/20 text-primary-text"
                                : "bg-success-bg text-success"
                            }`}
                          >
                            Recommended
                          </span>
                        )}
                        {isSelected && <CheckIcon className="size-4" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t border-border">
            <p className="text-xs text-muted">
              {detectionResult.tex_files.length} file
              {detectionResult.tex_files.length !== 1 ? "s" : ""} found
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onCancel} className="btn btn-sm btn-secondary">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => selected && onSelect(selected)}
                disabled={!selected}
                className="btn btn-sm btn-primary"
              >
                Compile
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
