"use client";

import type { FileNode } from "@orchestratex/shared";
import {
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { type FileOperations, FileTree, type FileVoiceDot } from "@/components/editor/file-tree";

type FileSidebarPanelProps = Pick<
  ComponentProps<typeof FileTree>,
  | "onPlanRename"
  | "onApplyRename"
  | "onSetMainFile"
  | "onAskAgentOpening"
  | "mainFile"
  | "gitStatusByPath"
  | "errorCountByPath"
  | "activeProviderId"
> & {
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
  ...fileActions
}: FileSidebarPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
      <div className="h-7 px-1 pl-2 flex items-center" title={projectPath}>
        <span className="ox-sec">Files</span>
        <div className="ml-auto flex items-center">
          <button
            type="button"
            onClick={onCreateFile}
            className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="New File"
            aria-label="New file"
          >
            <FilePlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onCreateDirectory}
            className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="New Folder"
            aria-label="New folder"
          >
            <FolderPlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void handleImportFiles()}
            className="size-7 rounded-[7px] inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
            title="Import / Upload Files"
            aria-label="Upload"
          >
            <UploadSimpleIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 rounded-[7px] border border-border bg-panel px-2 py-1 mx-0.5 mb-1 text-[12px]">
        <MagnifyingGlassIcon className="w-3 h-3 text-muted shrink-0" aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Find in project"
          aria-label="Find in project"
          className="w-full min-w-0 bg-transparent text-foreground placeholder:text-muted focus:outline-none text-[12px]"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="ml-auto text-muted hover:text-foreground shrink-0"
            aria-label="Clear search"
          >
            <XIcon className="w-3 h-3" aria-hidden="true" />
          </button>
        ) : (
          <span className="ml-auto font-mono text-[10.5px] text-muted shrink-0">⇧⌘F</span>
        )}
      </div>

      <EditorErrorBoundary>
        <FileTree
          key={projectPath}
          {...fileActions}
          files={files}
          selectedFile={selectedFile}
          highlightedFile={highlightedFile}
          onFileSelect={onFileSelect}
          className="flex-1 min-h-0 overflow-hidden"
          fileOperations={fileOperations}
          projectPath={projectPath}
          onRefresh={onRefreshFiles}
          fileVoiceDots={fileVoiceDots}
          searchQuery={searchQuery}
        />
      </EditorErrorBoundary>
    </>
  );
}
