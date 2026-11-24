"use client";

import { FileText, ListNumbers, MagnifyingGlass } from "@phosphor-icons/react";
import { memo, useMemo, useState } from "react";
import { parseLatexOutline } from "@/lib/latex/outline";

interface SidebarOutlinePanelProps {
  activeFile: string | null;
  content: string;
  onJumpToLine: (line: number) => void;
  onOpenInputFile: (relativePath: string) => void;
  compact?: boolean;
  cursorLine?: number;
}

export const SidebarOutlinePanel = memo(function SidebarOutlinePanel({
  activeFile,
  content,
  onJumpToLine,
  onOpenInputFile,
  compact = false,
  cursorLine,
}: SidebarOutlinePanelProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  const items = useMemo(() => {
    if (!content) return [];
    return parseLatexOutline(content);
  }, [content]);

  const activeItemId = useMemo(() => {
    if (cursorLine == null || items.length === 0) return null;
    let lastMatch: string | null = null;
    for (const item of items) {
      if (item.line <= cursorLine) {
        lastMatch = item.id;
      } else {
        break;
      }
    }
    return lastMatch;
  }, [cursorLine, items]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) => item.title.toLowerCase().includes(q) || item.command.toLowerCase().includes(q),
    );
  }, [filter, items]);

  if (!activeFile) {
    if (!activeFile) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
          <ListNumbers className="w-8 h-8 mb-2 opacity-30" aria-hidden="true" />
          <p className="text-xs">Open a .tex file to see its outline</p>
        </div>
      );
    }

    if (compact) {
      const fileName = activeFile.split(/[\\/]/).pop() ?? activeFile;
      return (
        <div className="flex flex-col min-h-0">
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-expanded={!collapsed}
            className="h-[26px] px-1 pl-2 flex items-center w-full text-left rounded-[6px] hover:bg-subtle transition-colors"
          >
            <span className="ox-sec">Outline</span>
            <span className="ml-auto text-[11px] text-muted truncate max-w-[140px]">
              {fileName}
            </span>
          </button>

          {!collapsed && (
            <div className="overflow-y-auto space-y-0.5 mt-0.5">
              {items.length === 0 ? (
                <div className="px-2 py-1.5 text-[11.5px] text-muted">No sections found</div>
              ) : (
                items.map((item) => {
                  const indentPx = Math.max(0, item.level - 1) * 12;
                  const isActive = item.id === activeItemId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (item.kind === "input" && item.targetFile) {
                          onOpenInputFile(item.targetFile);
                        } else {
                          onJumpToLine(item.line);
                        }
                      }}
                      style={{ paddingLeft: `${10 + indentPx}px` }}
                      className={`relative w-full h-[25px] pr-2 text-left flex items-center rounded-[6px] text-[12.5px] hover:bg-subtle transition-colors ${
                        isActive
                          ? "font-medium text-foreground-strong"
                          : "text-foreground-secondary"
                      }`}
                      title={
                        item.kind === "input"
                          ? `Open ${item.targetFile}`
                          : `Jump to line ${item.line}`
                      }
                    >
                      {isActive && (
                        <span
                          className="absolute left-1 top-[6px] bottom-[6px] w-[2px] bg-foreground rounded-full"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{item.title}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
        <ListNumbers className="w-8 h-8 mb-2 opacity-30" aria-hidden="true" />
        <p className="text-xs">Open a .tex file to see its outline</p>
      </div>
    );
  }

  if (!activeFile) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
        <ListNumbers className="w-8 h-8 mb-2 opacity-30" aria-hidden="true" />
        <p className="text-xs">Open a .tex file to see its outline</p>
      </div>
    );
  }

  if (compact) {
    const fileName = activeFile.split(/[\\/]/).pop() ?? activeFile;
    return (
      <div className="flex flex-col min-h-0">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="h-[26px] px-1 pl-2 flex items-center w-full text-left rounded-[6px] hover:bg-subtle transition-colors"
        >
          <span className="ox-sec">Outline</span>
          <span className="ml-auto text-[11px] text-muted truncate max-w-[140px]">{fileName}</span>
        </button>

        {!collapsed && (
          <div className="overflow-y-auto space-y-0.5 mt-0.5">
            {items.length === 0 ? (
              <div className="px-2 py-1.5 text-[11.5px] text-muted">No sections found</div>
            ) : (
              items.map((item) => {
                const indentPx = Math.max(0, item.level - 1) * 12;
                const isActive = item.id === activeItemId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (item.kind === "input" && item.targetFile) {
                        onOpenInputFile(item.targetFile);
                      } else {
                        onJumpToLine(item.line);
                      }
                    }}
                    style={{ paddingLeft: `${10 + indentPx}px` }}
                    className={`relative w-full h-[25px] pr-2 text-left flex items-center rounded-[6px] text-[12.5px] hover:bg-subtle transition-colors ${
                      isActive ? "font-medium text-foreground-strong" : "text-foreground-secondary"
                    }`}
                    title={
                      item.kind === "input"
                        ? `Open ${item.targetFile}`
                        : `Jump to line ${item.line}`
                    }
                  >
                    {isActive && (
                      <span
                        className="absolute left-1 top-[6px] bottom-[6px] w-[2px] bg-foreground rounded-full"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{item.title}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-border space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted">
            Outline ({items.length})
          </span>
          <span className="text-[10px] font-mono text-muted truncate max-w-[120px]">
            {activeFile.split(/[\\/]/).pop()}
          </span>
        </div>

        <div className="relative">
          <MagnifyingGlass
            className="size-3 text-muted absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sections..."
            aria-label="Filter document outline"
            className="w-full pl-6 pr-2 py-1 text-xs font-mono border border-border bg-surface-secondary text-foreground placeholder:text-muted focus:outline-none focus:border-foreground"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted">
            {items.length === 0
              ? "No \\section or \\input directives found in this file."
              : "No matching headings."}
          </div>
        ) : (
          filtered.map((item) => {
            const indentPx = Math.max(0, item.level - 1) * 12;
            if (!activeFile) {
              return (
                <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
                  <ListNumbers className="w-8 h-8 mb-2 opacity-30" aria-hidden="true" />
                  <p className="text-xs">Open a .tex file to see its outline</p>
                </div>
              );
            }

            if (compact) {
              const fileName = activeFile.split(/[\\/]/).pop() ?? activeFile;
              return (
                <div className="flex flex-col min-h-0">
                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => !prev)}
                    aria-expanded={!collapsed}
                    className="h-[26px] px-1 pl-2 flex items-center w-full text-left rounded-[6px] hover:bg-subtle transition-colors"
                  >
                    <span className="ox-sec">Outline</span>
                    <span className="ml-auto text-[11px] text-muted truncate max-w-[140px]">
                      {fileName}
                    </span>
                  </button>

                  {!collapsed && (
                    <div className="overflow-y-auto space-y-0.5 mt-0.5">
                      {items.length === 0 ? (
                        <div className="px-2 py-1.5 text-[11.5px] text-muted">
                          No sections found
                        </div>
                      ) : (
                        items.map((item) => {
                          const indentPx = Math.max(0, item.level - 1) * 12;
                          const isActive = item.id === activeItemId;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                if (item.kind === "input" && item.targetFile) {
                                  onOpenInputFile(item.targetFile);
                                } else {
                                  onJumpToLine(item.line);
                                }
                              }}
                              style={{ paddingLeft: `${10 + indentPx}px` }}
                              className={`relative w-full h-[25px] pr-2 text-left flex items-center rounded-[6px] text-[12.5px] hover:bg-subtle transition-colors ${
                                isActive
                                  ? "font-medium text-foreground-strong"
                                  : "text-foreground-secondary"
                              }`}
                              title={
                                item.kind === "input"
                                  ? `Open ${item.targetFile}`
                                  : `Jump to line ${item.line}`
                              }
                            >
                              {isActive && (
                                <span
                                  className="absolute left-1 top-[6px] bottom-[6px] w-[2px] bg-foreground rounded-full"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate">{item.title}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.kind === "input" && item.targetFile) {
                    onOpenInputFile(item.targetFile);
                  } else {
                    onJumpToLine(item.line);
                  }
                }}
                style={{ paddingLeft: `${8 + indentPx}px` }}
                className="w-full pr-2 py-1 text-left flex items-center justify-between gap-2 hover:bg-surface-secondary text-xs transition-colors"
                title={
                  item.kind === "input" ? `Open ${item.targetFile}` : `Jump to line ${item.line}`
                }
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {item.kind === "input" ? (
                    <FileText className="size-3 text-muted shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="text-[10px] font-mono uppercase text-muted shrink-0 w-4">
                      {item.command === "chapter"
                        ? "Ch"
                        : item.command === "part"
                          ? "Pt"
                          : `H${item.level}`}
                    </span>
                  )}
                  <span
                    className={`truncate ${
                      item.kind === "input"
                        ? "font-mono text-[11px] text-foreground-secondary"
                        : item.level <= 2
                          ? "font-medium text-foreground"
                          : "text-foreground-secondary"
                    }`}
                  >
                    {item.title}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-muted shrink-0">:{item.line}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});
