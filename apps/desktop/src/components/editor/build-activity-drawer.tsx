"use client";

import { CaretDown, Plus } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import type { AgentProviderId } from "@/lib/agent/types";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
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
  fixProviders?: Array<{ id: AgentProviderId; label: string }>;
  onSelectFixProvider?: (providerId: AgentProviderId, diagnostics: LatexDiagnostic[]) => void;
  diagnosticSuggestion?: (diagnostic: LatexDiagnostic) => ReactNode;
  threadStatuses?: Array<{ id: string; providerId: AgentProviderId; label: string }>;
  buildSummary?: string;
  mainFileLogName?: string;
}

const tabs: { id: BuildActivityTab; label: string }[] = [
  { id: "score", label: "Score" },
  { id: "problems", label: "Problems" },
  { id: "build-log", label: "Build log" },
  { id: "terminal", label: "Terminal" },
];

function normalizeFixLabel(label: string): string {
  return label.replace(/\bClaude Code\b/g, "Claude").replace(/\bOpenAI Codex\b/g, "Codex");
}

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
  fixLabel = "Fix with Claude",
  fixProviders,
  onSelectFixProvider,
  diagnosticSuggestion,
  threadStatuses,
  buildSummary,
  mainFileLogName = "main.log",
}: BuildActivityDrawerProps) {
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selectedDiagIndex, setSelectedDiagIndex] = useState<number>(0);
  const [openFixPickerIndex, setOpenFixPickerIndex] = useState<number | null>(null);
  const shortFixLabel = normalizeFixLabel(fixLabel);
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
      className="ox-frame flex shrink-0 flex-col overflow-hidden"
    >
      {collapsed ? (
        <div className="@container flex h-8 items-center gap-3 px-3 text-[12px] text-muted min-w-0">
          <button
            type="button"
            onClick={() => onChange("score")}
            className="font-medium text-foreground-strong hover:underline shrink-0 whitespace-nowrap"
            aria-expanded={false}
          >
            ▸ Score
          </button>
          <div className="hidden @[520px]:flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
            {threadStatuses?.slice(0, 3).map((thread, index) => {
              const voice = VOICE_COLORS[thread.providerId] ?? VOICE_COLORS["custom-acp"];
              return (
                <span
                  key={thread.id}
                  className={`items-center gap-1.5 min-w-0 max-w-[140px] truncate ${
                    index === 0
                      ? "inline-flex"
                      : index === 1
                        ? "hidden sm:inline-flex"
                        : "hidden lg:inline-flex"
                  }`}
                  title={thread.label}
                >
                  <span
                    className="size-[7px] shrink-0 rounded-full"
                    style={{ backgroundColor: voice.ink }}
                    aria-hidden="true"
                  />
                  <span className="truncate whitespace-nowrap">{thread.label}</span>
                </span>
              );
            })}
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0 whitespace-nowrap">
            <button
              type="button"
              onClick={() => onChange("problems")}
              className="hover:text-foreground transition-colors"
            >
              Problems {diagnostics.length}
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onChange("build-log")}
              className="hover:text-foreground transition-colors"
            >
              Build log
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onChange("terminal")}
              className="hover:text-foreground transition-colors"
            >
              Terminal
            </button>
          </div>
        </div>
      ) : (
        <div className="flex h-8 items-center border-b border-border/70 px-1.5">
          <div
            role="tablist"
            aria-label="Build activity"
            className="flex min-w-0 flex-1 overflow-x-auto gap-0.5"
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
                className={`flex h-[31px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] transition-colors ${
                  activeTab === tab.id
                    ? "text-foreground-strong font-medium shadow-[inset_0_-2px_0_var(--text-strong)]"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {tab.label}
                {tab.id === "problems" && errors.length > 0 && (
                  <span
                    className="rounded-full bg-error-bg px-1.5 text-[10.5px] leading-[15px] text-error"
                    role="img"
                    aria-label={`${errors.length} errors`}
                  >
                    {errors.length}
                  </span>
                )}
                {tab.id === "problems" && warnings.length > 0 && (
                  <span
                    className="rounded-full bg-warn-bg px-1.5 text-[10.5px] leading-[15px] text-warn"
                    role="img"
                    aria-label={`${warnings.length} warnings`}
                  >
                    {warnings.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2.5 pr-1 text-[11.5px] text-muted shrink-0">
            {activeTab === "score" && (
              <>
                <span className="hidden md:inline-flex items-center gap-1">
                  <svg width="9" height="9" aria-hidden="true">
                    <circle cx="4.5" cy="4.5" r="3.5" fill="currentColor" />
                  </svg>
                  edit
                </span>
                <span className="hidden md:inline-flex items-center gap-1">
                  <svg width="9" height="9" aria-hidden="true">
                    <rect
                      x="1"
                      y="1"
                      width="7"
                      height="7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
                  read
                </span>
                <span className="hidden md:inline-flex items-center gap-1">
                  <svg width="10" height="10" aria-hidden="true">
                    <path d="M5 0.5L9.5 5 5 9.5 0.5 5z" fill="currentColor" />
                  </svg>
                  compile
                </span>
                <span className="hidden md:inline-flex items-center gap-1">
                  <svg width="10" height="10" aria-hidden="true">
                    <path
                      d="M1 9V3a4 4 0 0 1 8 0v6"
                      fill="none"
                      stroke="var(--warn)"
                      strokeWidth="1.6"
                    />
                  </svg>
                  waiting
                </span>
                <span className="hidden md:inline-block w-px h-3.5 bg-border" aria-hidden="true" />
                <span className="hidden sm:inline">Last 15 min</span>
              </>
            )}
            {activeTab === "problems" && buildSummary && (
              <span className="hidden sm:inline">{buildSummary}</span>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label="Collapse build activity"
              className="btn-ghost rounded-md p-1 text-muted hover:text-foreground"
            >
              <CaretDown aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
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
              <div>
                {diagnostics.map((d, index) => {
                  const isSelectedError = d.severity === "error" && selectedDiagIndex === index;
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: identical diagnostics need distinct keys.
                      key={`${d.severity}-${d.file}-${d.line}-${d.message}-${index}`}
                      className={`h-[34px] px-3 border-b border-border/60 flex items-center gap-2.5 text-[12.5px] transition-colors ${
                        isSelectedError ? "bg-error-bg/35" : ""
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedDiagIndex(index)}
                        className="min-w-0 flex-1 flex items-center gap-2.5 text-left"
                      >
                        <span
                          className={`w-[44px] shrink-0 rounded text-[10px] font-semibold text-center uppercase border ${
                            d.severity === "error"
                              ? "bg-error-bg border-[var(--danger-line)] text-error"
                              : "bg-warn-bg border-[var(--warn-line)] text-warn"
                          }`}
                        >
                          {d.severity === "error" ? "ERROR" : "WARN"}
                        </span>
                        <span className="font-mono text-foreground-strong truncate max-w-[45%] shrink">
                          {d.file}
                          {d.line > 0 ? `:${d.line}` : ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-foreground">{d.message}</span>
                      </button>
                      {diagnosticSuggestion?.(d)}
                      <div className="ml-auto flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDiagIndex(index);
                            onJumpToDiagnostic(d);
                          }}
                          className="btn btn-secondary btn-sm h-[23px] px-2 text-[12px]"
                        >
                          Go to line
                        </button>
                        {d.severity === "error" && (
                          <div className="relative inline-flex items-center">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDiagIndex(index);
                                onFixDiagnostics([d]);
                              }}
                              className={`btn btn-secondary btn-sm h-[23px] px-2 text-[12px] inline-flex items-center gap-1.5 ${
                                fixProviders && fixProviders.length > 1
                                  ? "rounded-r-none border-r-0"
                                  : ""
                              }`}
                            >
                              <span
                                className="size-[7px] rounded-full bg-[var(--voice-claude-ink)]"
                                aria-hidden="true"
                              />
                              <span>{shortFixLabel}</span>
                            </button>
                            {fixProviders && fixProviders.length > 1 && (
                              <button
                                type="button"
                                aria-label="Choose agent harness"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenFixPickerIndex((prev) => (prev === index ? null : index));
                                }}
                                className="h-[23px] w-[22px] rounded-r-[7px] border border-border-dark bg-panel text-muted hover:text-foreground hover:bg-subtle inline-flex items-center justify-center transition-colors shrink-0"
                              >
                                <CaretDown className="size-3" aria-hidden="true" />
                              </button>
                            )}
                            {openFixPickerIndex === index && fixProviders && (
                              <div className="ox-popover absolute right-0 top-full mt-1 w-40 p-1 z-50 text-[12px]">
                                {fixProviders.map((provider) => (
                                  <button
                                    key={provider.id}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenFixPickerIndex(null);
                                      if (onSelectFixProvider) {
                                        onSelectFixProvider(provider.id, [d]);
                                      } else {
                                        onFixDiagnostics([d]);
                                      }
                                    }}
                                    className="w-full px-2 py-1 rounded text-left flex items-center gap-1.5 hover:bg-subtle text-foreground"
                                  >
                                    <span
                                      className="size-[6px] rounded-full shrink-0"
                                      style={{
                                        backgroundColor: (
                                          VOICE_COLORS[provider.id] ?? VOICE_COLORS["custom-acp"]
                                        ).ink,
                                      }}
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">{provider.label}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="px-3 py-2 flex items-center gap-2 text-[12px] text-muted">
                  <button
                    type="button"
                    onClick={() => onFixDiagnostics(diagnostics)}
                    className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    <span>Send all problems to a new thread</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange("build-log")}
                    className="ml-auto font-mono hover:text-foreground transition-colors"
                  >
                    raw log: {mainFileLogName}
                    {log.length > 0 ? ` · ${log.length} lines` : ""}
                  </button>
                </div>
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
