"use client";

import { CaretDown, CaretUp, Sparkle } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import type { CompileOutputEvent, LatexDiagnostic } from "@/lib/latex/types";

export type BuildActivityTab = "score" | "problems" | "build-log" | "terminal";

export interface BuildActivityDrawerProps {
  activeTab: BuildActivityTab;
  onChange: (tab: BuildActivityTab) => void;
  collapsed: boolean;
  onToggle: () => void;
  scorePanel: ReactNode;
  terminalPanel: ReactNode;
  diagnostics: LatexDiagnostic[];
  log: CompileOutputEvent[];
  onJumpToDiagnostic: (diagnostic: LatexDiagnostic) => void;
  onFixDiagnostics: (diagnostics: LatexDiagnostic[]) => void;
  fixLabel?: string;
  diagnosticSuggestion?: (diagnostic: LatexDiagnostic) => ReactNode;
}

const tabs: { id: BuildActivityTab; label: string }[] = [
  { id: "score", label: "Score" },
  { id: "problems", label: "Problems" },
  { id: "build-log", label: "Build log" },
  { id: "terminal", label: "Terminal" },
];

export function BuildActivityDrawer({
  activeTab,
  onChange,
  collapsed,
  onToggle,
  scorePanel,
  terminalPanel,
  diagnostics,
  log,
  onJumpToDiagnostic,
  onFixDiagnostics,
  fixLabel = "Fix with agent",
  diagnosticSuggestion,
}: BuildActivityDrawerProps) {
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      tabRefs.current[next]?.focus();
    }
  }
  return (
    <section
      aria-label="Build activity"
      className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-panel"
    >
      <div className="flex items-center border-b border-border">
        <div
          role="tablist"
          aria-label="Build activity"
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${id}-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={
                tab.id === "terminal"
                  ? `${id}-terminal-panel`
                  : !collapsed && activeTab === tab.id
                    ? `${id}-panel`
                    : undefined
              }
              tabIndex={activeTab === tab.id ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onClick={() => onChange(tab.id)}
              className={`flex h-8 shrink-0 items-center gap-1 border-b-2 px-3 text-xs ${activeTab === tab.id ? "border-accent text-foreground-strong" : "border-transparent text-muted hover:text-foreground"}`}
            >
              {tab.label}
              {tab.id === "problems" && errors.length > 0 && (
                <span
                  className="rounded-full bg-error-bg px-1.5 text-error"
                  role="img"
                  aria-label={`${errors.length} errors`}
                >
                  {errors.length}
                </span>
              )}
              {tab.id === "problems" && warnings.length > 0 && (
                <span
                  className="rounded-full bg-warn-bg px-1.5 text-warn"
                  role="img"
                  aria-label={`${warnings.length} warnings`}
                >
                  {warnings.length}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand build activity" : "Collapse build activity"}
          className="btn-ghost m-1 rounded-md p-1 text-muted"
        >
          {collapsed ? <CaretUp aria-hidden="true" /> : <CaretDown aria-hidden="true" />}
        </button>
      </div>
      <div
        role="tabpanel"
        id={`${id}-terminal-panel`}
        aria-labelledby={`${id}-terminal`}
        className={!collapsed && activeTab === "terminal" ? "h-48 overflow-hidden" : "hidden"}
      >
        {terminalPanel}
      </div>
      {!collapsed && activeTab !== "terminal" && (
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${activeTab}`}
          className="h-40 overflow-auto p-2"
        >
          {activeTab === "score" && scorePanel}
          {activeTab === "problems" &&
            (diagnostics.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">No LaTeX errors or warnings.</p>
            ) : (
              <div className="space-y-1.5">
                {diagnostics.map((d, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: identical diagnostics need distinct keys.
                    key={`${d.severity}-${d.file}-${d.line}-${d.message}-${index}`}
                    className={`rounded-xl border px-3 py-2 text-xs ${d.severity === "error" ? "border-error/25 bg-error-bg/50" : "border-border bg-subtle/50"}`}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => onJumpToDiagnostic(d)}
                        className="group min-w-0 flex-1 text-left"
                      >
                        <span
                          className={`rounded-full px-1.5 font-medium capitalize ${d.severity === "error" ? "bg-error-bg text-error" : "bg-warn-bg text-warn"}`}
                        >
                          {d.severity}
                        </span>{" "}
                        <span className="font-mono text-accent group-hover:underline">
                          {d.file}
                          {d.line > 0 ? `:${d.line}` : ""}
                        </span>
                        <div className="mt-1 break-words text-foreground">{d.message}</div>
                      </button>
                      {d.severity === "error" && (
                        <button
                          type="button"
                          onClick={() => onFixDiagnostics([d])}
                          className="btn btn-secondary btn-sm h-6 shrink-0 px-2 text-[11px]"
                        >
                          <Sparkle className="size-3 text-accent" aria-hidden="true" /> {fixLabel}
                        </button>
                      )}
                    </div>
                    {diagnosticSuggestion?.(d)}
                  </div>
                ))}
              </div>
            ))}
          {activeTab === "build-log" &&
            (log.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">No compile output captured yet.</p>
            ) : (
              <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
                {log.map((entry, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: log lines can repeat and sequence numbers are optional.
                    key={`${entry.seq ?? "line"}-${index}`}
                    className={`whitespace-pre-wrap break-all ${entry.is_error ? "text-error" : entry.is_warning ? "text-warn" : "text-muted"}`}
                  >
                    {entry.line}
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
