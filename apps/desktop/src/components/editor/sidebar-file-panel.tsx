"use client";

import type { FileNode } from "@orchestratex/shared";
import {
  ArrowClockwiseIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { type FileOperations, FileTree, type FileVoiceDot } from "@/components/editor/file-tree";
import { pathSync } from "@/lib/path";

type FileSidebarPanelProps = {
  projectPath: string | null;
  files: FileNode[];
  selectedFile?: string;
  highlightedFile: string | null;
  onFileSelect: (path: string) => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onRefreshFiles: () => void | Promise<void>;
  fileOperations: FileOperations;
  fileVoiceDots?: Record<string, FileVoiceDot[]>;
};

export function FileSidebarPanel({
  projectPath,
  files,
  selectedFile,
  highlightedFile,
  onFileSelect,
  onCreateFile,
  onCreateDirectory,
  onRefreshFiles,
  fileOperations,
  fileVoiceDots,
}: FileSidebarPanelProps) {
  if (!projectPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
        <FolderIcon className="w-8 h-8 mb-2 opacity-30" />
        <p className="text-xs">No folder open</p>
      </div>
    );
  }

  const handleImportFiles = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "Import files into project",
      });
      const paths = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? [selected]
          : [];
      if (paths.length === 0) return;

      for (const srcPath of paths) {
        const base = srcPath.split(/[\\/]/).pop();
        if (!base) continue;
        const imported = await invoke<string>("import_external_file", {
          sourcePath: srcPath,
          destRelativePath: base,
        });
        onFileSelect(imported);
      }
      await onRefreshFiles();
    } catch (error) {
      console.error("Failed to import files:", error);
    }
  };

  return (
    <>
      <div className="px-2.5 py-1.5 flex items-center justify-between gap-2" title={projectPath}>
        <span className="text-[11.5px] font-medium text-muted truncate">
          {pathSync.basename(projectPath)}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => void handleImportFiles()}
            className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="Import / Upload Files"
            aria-label="Import Files"
          >
            <UploadSimpleIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onCreateFile}
            className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="New File"
            aria-label="New File"
          >
            <FilePlusIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onCreateDirectory}
            className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="New Folder"
            aria-label="New Folder"
          >
            <FolderPlusIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRefreshFiles}
            className="size-6 rounded-md inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="Refresh Files"
            aria-label="Refresh Files"
          >
            <ArrowClockwiseIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <EditorErrorBoundary>
        <FileTree
          files={files}
          selectedFile={selectedFile}
          highlightedFile={highlightedFile}
          onFileSelect={onFileSelect}
          className="flex-1 min-h-0 overflow-hidden"
          fileOperations={fileOperations}
          projectPath={projectPath}
          onRefresh={onRefreshFiles}
          fileVoiceDots={fileVoiceDots}
        />
      </EditorErrorBoundary>
    </>
  );
}
