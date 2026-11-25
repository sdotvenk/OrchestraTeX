"use client";

import {
  BookOpenText,
  FilePdf,
  FileText,
  GearSix,
  Hash,
  ListBullets,
  MagnifyingGlass,
  Play,
  Robot,
  SidebarSimple,
  Swatches,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BibEntry, LabelEntry } from "@/lib/latex";
import type { LatexDiagnostic } from "@/lib/latex/types";

export interface CommandPaletteItem {
  id: string;
  group: "Files" | "Sections & Labels" | "Citations" | "Diagnostics" | "Actions";
  title: string;
  subtitle?: string;
  shortcut?: string;
  mono?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  files: string[];
  labels: LabelEntry[];
  bibEntries: BibEntry[];
  diagnostics: LatexDiagnostic[];
  onOpenFile: (path: string, line?: number) => void;
  onCompile: () => void;
  onToggleSidebar: () => void;
  onTogglePdf: () => void;
  onToggleAgent: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onOpenThemePicker: () => void;
}

export function CommandPalette({
  open,
  onClose,
  files,
  labels,
  bibEntries,
  diagnostics,
  onOpenFile,
  onCompile,
  onToggleSidebar,
  onTogglePdf,
  onToggleAgent,
  onToggleTerminal,
  onOpenSettings,
  onOpenThemePicker,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const allItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [];

    for (const f of files.slice(0, 120)) {
      items.push({
        id: `file:${f}`,
        group: "Files",
        title: f.split("/").pop() ?? f,
        subtitle: f,
        mono: true,
        onSelect: () => onOpenFile(f),
      });
    }

    for (const lbl of labels.slice(0, 80)) {
      items.push({
        id: `label:${lbl.file}:${lbl.key}`,
        group: "Sections & Labels",
        title: `\\label{${lbl.key}}`,
        subtitle: `${lbl.file}:${lbl.line}`,
        mono: true,
        onSelect: () => onOpenFile(lbl.file, lbl.line),
      });
    }

    for (const bib of bibEntries.slice(0, 80)) {
      items.push({
        id: `bib:${bib.key}`,
        group: "Citations",
        title: `@${bib.key}`,
        subtitle: [bib.title, bib.author, bib.year].filter(Boolean).join(" · "),
        mono: true,
        onSelect: () => {
          if (bib.file) onOpenFile(bib.file);
        },
      });
    }

    for (const d of diagnostics.slice(0, 30)) {
      items.push({
        id: `diag:${d.file}:${d.line}:${d.message}`,
        group: "Diagnostics",
        title: d.message,
        subtitle: `${d.severity} · ${d.file}${d.line > 0 ? `:${d.line}` : ""}`,
        onSelect: () => onOpenFile(d.file.replace(/^\.\//, ""), d.line > 0 ? d.line : undefined),
      });
    }

    items.push(
      {
        id: "act:compile",
        group: "Actions",
        title: "Compile LaTeX PDF",
        shortcut: "⌘⇧B",
        onSelect: onCompile,
      },
      {
        id: "act:pdf",
        group: "Actions",
        title: "Toggle Live PDF Preview",
        shortcut: "⌘P",
        onSelect: onTogglePdf,
      },
      {
        id: "act:agent",
        group: "Actions",
        title: "Toggle Agent Panel",
        shortcut: "⌘L",
        onSelect: onToggleAgent,
      },
      {
        id: "act:sidebar",
        group: "Actions",
        title: "Toggle Sidebar",
        shortcut: "⌘\\",
        onSelect: onToggleSidebar,
      },
      {
        id: "act:terminal",
        group: "Actions",
        title: "Toggle Terminal",
        onSelect: onToggleTerminal,
      },
      {
        id: "act:palette",
        group: "Actions",
        title: "Choose theme",
        onSelect: onOpenThemePicker,
      },
      {
        id: "act:settings",
        group: "Actions",
        title: "Open Settings",
        onSelect: onOpenSettings,
      },
    );

    return items;
  }, [
    bibEntries,
    diagnostics,
    files,
    labels,
    onCompile,
    onOpenThemePicker,
    onOpenFile,
    onOpenSettings,
    onToggleAgent,
    onTogglePdf,
    onToggleSidebar,
    onToggleTerminal,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Show top files + actions when empty
      const topFiles = allItems.filter((i) => i.group === "Files").slice(0, 6);
      const topDiags = allItems.filter((i) => i.group === "Diagnostics").slice(0, 3);
      const actions = allItems.filter((i) => i.group === "Actions");
      return [...topDiags, ...topFiles, ...actions];
    }
    return allItems
      .filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          (item.subtitle ?? "").toLowerCase().includes(q) ||
          item.group.toLowerCase().includes(q),
      )
      .slice(0, 24);
  }, [allItems, query]);

  const grouped = useMemo(() => {
    const map = new Map<CommandPaletteItem["group"], CommandPaletteItem[]>();
    for (const item of filtered) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (filtered.length > 0 ? (i + 1) % filtered.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) =>
        filtered.length > 0 ? (i - 1 + filtered.length) % filtered.length : 0,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[selectedIndex];
      if (target) {
        onClose();
        target.onSelect();
      }
    }
  };

  const renderIcon = (item: CommandPaletteItem) => {
    if (item.group === "Files") return <FileText className="size-4 text-muted shrink-0" />;
    if (item.group === "Sections & Labels") return <Hash className="size-4 text-accent shrink-0" />;
    if (item.group === "Citations") return <BookOpenText className="size-4 text-muted shrink-0" />;
    if (item.group === "Diagnostics")
      return <WarningCircle className="size-4 text-error shrink-0" />;
    if (item.id === "act:compile") return <Play className="size-4 text-primary shrink-0" />;
    if (item.id === "act:pdf") return <FilePdf className="size-4 text-muted shrink-0" />;
    if (item.id === "act:agent") return <Robot className="size-4 text-muted shrink-0" />;
    if (item.id === "act:sidebar") return <SidebarSimple className="size-4 text-muted shrink-0" />;
    if (item.id === "act:terminal")
      return <TerminalWindow className="size-4 text-muted shrink-0" />;
    if (item.id === "act:palette") return <Swatches className="size-4 text-muted shrink-0" />;
    if (item.id === "act:settings") return <GearSix className="size-4 text-muted shrink-0" />;
    return <ListBullets className="size-4 text-muted shrink-0" />;
  };

  let flatIdx = -1;

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4 modal-overlay">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="fixed inset-0 cursor-default"
      />
      <div
        className="relative z-10 w-full max-w-[600px] rounded-2xl border border-border bg-panel overflow-hidden modal-content"
        style={{ boxShadow: "var(--shadow-3)" }}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border">
          <MagnifyingGlass className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Find files, \labels, @citations, or commands..."
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd>esc</kbd>
        </div>

        <div className="max-h-[380px] overflow-y-auto p-2 space-y-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted">No matching results.</div>
          ) : (
            grouped.map(([groupName, items]) => (
              <div key={groupName}>
                <div className="px-2.5 py-1 text-[11px] font-medium text-muted">{groupName}</div>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    flatIdx += 1;
                    const idx = flatIdx;
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(idx)}
                        onClick={() => {
                          onClose();
                          item.onSelect();
                        }}
                        className={`w-full px-2.5 h-9 rounded-lg flex items-center gap-2.5 text-left transition-colors ${
                          isSelected
                            ? "bg-accent-soft text-foreground-strong"
                            : "text-foreground hover:bg-subtle"
                        }`}
                      >
                        {renderIcon(item)}
                        <span
                          className={`text-[13px] truncate ${
                            item.mono ? "font-mono text-[12.5px]" : "font-medium"
                          }`}
                        >
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="text-[11.5px] text-muted truncate flex-1">
                            {item.subtitle}
                          </span>
                        )}
                        {item.shortcut && <kbd className="ml-auto shrink-0">{item.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
