"use client";

import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useId, useState } from "react";
import { ProviderIcon } from "@/components/agent/icons";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  AgentProviderId,
  AgentSettings,
  InteractionMode,
  ProviderCustomSettings,
  ProviderStatus,
  RuntimeMode,
} from "@/lib/agent/types";
import { splitArgsString } from "@/lib/agent/use-agent-settings";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type MinimapSettings,
} from "@/lib/editor/types";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
import {
  COMPILER_DISPLAY_NAMES,
  DEFAULT_LATEX_SETTINGS,
  type LaTeXCompiler,
  type LaTeXCompilersStatus,
  type LaTeXSettings,
  type LatexmkEngine,
} from "@/lib/latex/types";
import { checkForUpdate, RELEASES_URL, type UpdateCheckResult } from "@/lib/update";

interface LaTeXSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: LaTeXSettings;
  onUpdateSettings: (updates: Partial<LaTeXSettings>) => void;
  compilersStatus?: LaTeXCompilersStatus | null;
  onCleanAuxFiles?: () => Promise<unknown> | undefined;
  editorSettings: EditorSettings;
  onUpdateEditorSettings: (updates: Partial<EditorSettings>) => void;
  texFiles: string[];
  agentSettings?: AgentSettings;
  onUpdateAgentSettings?: (patch: Partial<AgentSettings>) => void;
  onUpdateCustomProvider?: (
    providerId: AgentProviderId,
    patch: Partial<ProviderCustomSettings>,
  ) => void;
  agentProviders?: ProviderStatus[];
  onRefreshAgentProviders?: () => Promise<unknown> | undefined;
  initialTab?: "build" | "editor" | "agents" | "about";
}

const SETTINGS_TABS = [
  { id: "build", label: "Build" },
  { id: "editor", label: "Editor" },
  { id: "agents", label: "Agents" },
  { id: "about", label: "About" },
] as const;

const CLI_PATH_FIELDS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
] as const;

const CUSTOM_ACP_FIELDS = [
  { key: "customName", label: "Display name", placeholder: "Custom ACP" },
  { key: "customCommand", label: "Command", placeholder: "/path/to/agent-acp" },
  { key: "customArgs", label: "Arguments", placeholder: "--stdio" },
] as const;

const TRANSPORT_LABELS: Partial<Record<string, string>> = {
  "cli-stream": "CLI stream",
  "app-server": "App server",
  acp: "ACP",
};

const SELECT_TRIGGER =
  "h-8 min-w-0 rounded-lg border-border-dark bg-panel text-xs hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const AGENT_HEADING = "text-sm font-semibold text-foreground-strong";
const AGENT_INPUT =
  "h-8 w-full min-w-0 rounded-lg border border-border-dark bg-panel px-2.5 text-xs text-foreground outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";

const ROW_LABEL = "text-[13px] font-medium text-foreground-strong";
const ROW_HINT = "mt-0.5 text-xs text-muted";
const STEPPER =
  "flex h-8 items-center overflow-hidden rounded-lg border border-border-dark bg-panel transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent";
const STEPPER_BUTTON =
  "flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-subtle hover:text-foreground";
const STEPPER_INPUT =
  "h-full w-12 border-0 bg-transparent text-center font-mono text-xs text-foreground outline-none";

// Section header: matches the Agents tab headings, with a hairline divider between sections.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-border pt-4 pb-1 first:mt-0 first:border-t-0 first:pt-1">
      <h3 className={AGENT_HEADING}>{children}</h3>
    </div>
  );
}

function AboutTab({
  autoCheck,
  onAutoCheckChange,
}: {
  autoCheck: boolean;
  onAutoCheckChange: (value: boolean) => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await checkForUpdate());
    } catch (err) {
      setResult(null);
      setError(String(err));
    } finally {
      setChecking(false);
    }
  };

  let status = "Not checked yet";
  if (checking) status = "Checking…";
  else if (error) status = error;
  else if (result?.updateAvailable) status = `Version ${result.latestVersion} is available`;
  else if (result?.latestVersion) status = "You're on the latest version";
  else if (result) status = "No releases published yet";

  return (
    <>
      <SectionHeader>OrchestraTeX</SectionHeader>
      <div className="flex items-center justify-between gap-4 py-2">
        <span className={ROW_LABEL}>Version</span>
        <span className="font-mono text-xs text-muted">{version ?? "—"}</span>
      </div>

      <SectionHeader>Updates</SectionHeader>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0">
          <span className={ROW_LABEL}>Check for updates</span>
          <p
            className={`${ROW_HINT} ${error ? "text-error" : result?.updateAvailable ? "text-accent" : ""}`}
            aria-live="polite"
          >
            {status}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {result?.updateAvailable && (
            <a href={result.releaseUrl} className="btn btn-secondary btn-sm">
              View release
            </a>
          )}
          <button
            type="button"
            onClick={() => void handleCheck()}
            disabled={checking}
            className="btn btn-secondary btn-sm"
          >
            <ArrowsClockwiseIcon
              className={`size-3.5 ${checking ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Check now
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 py-2">
        <div>
          <span className={ROW_LABEL}>Check automatically</span>
          <p className={ROW_HINT}>Checks GitHub at launch and once a day</p>
        </div>
        <Switch
          checked={autoCheck}
          onCheckedChange={onAutoCheckChange}
          aria-label="Check for updates automatically"
        />
      </div>
      <div className="flex items-center justify-between gap-4 py-2">
        <span className={ROW_LABEL}>Releases</span>
        <a href={RELEASES_URL} className="text-xs font-medium text-accent hover:underline">
          Open on GitHub
        </a>
      </div>
    </>
  );
}

function CheckboxItem({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  const checkboxId = useId();

  return (
    <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer group py-2">
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div className="flex-1">
        <span className={ROW_LABEL}>{label}</span>
        {description && <p className={ROW_HINT}>{description}</p>}
      </div>
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  description,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  options: { value: string | number; label: string; disabled?: boolean }[];
  description?: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_minmax(0,14rem)] items-center gap-3 py-1.5">
      <div className="min-w-0">
        <span className={`${ROW_LABEL} block`}>{label}</span>
        {description && <p className={ROW_HINT}>{description}</p>}
      </div>
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className={SELECT_TRIGGER}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-lg shadow-[var(--shadow-2)]">
          {options.map((opt) => (
            <SelectItem
              key={opt.value}
              value={String(opt.value)}
              disabled={opt.disabled}
              className="rounded-md"
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function LaTeXSettingsDialog({
  open,
  onClose,
  settings,
  onUpdateSettings,
  compilersStatus,
  onCleanAuxFiles,
  editorSettings,
  onUpdateEditorSettings,
  texFiles,
  agentSettings,
  onUpdateAgentSettings,
  onUpdateCustomProvider,
  agentProviders = [],
  onRefreshAgentProviders,
  initialTab = "build",
}: LaTeXSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const canResetActiveTab = activeTab === "build" || activeTab === "editor";
  const [cleaningAux, setCleaningAux] = useState(false);

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  const handleResetLatexSettings = useCallback(() => {
    onUpdateSettings(DEFAULT_LATEX_SETTINGS);
  }, [onUpdateSettings]);

  const handleResetEditorSettings = useCallback(() => {
    onUpdateEditorSettings(DEFAULT_EDITOR_SETTINGS);
  }, [onUpdateEditorSettings]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9999] bg-shadow/35 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[9999] flex max-h-[90dvh] w-[90vw] max-w-[576px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-dark bg-bg shadow-[var(--shadow-3)]"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between px-5 pt-3 pb-2">
            <div className="flex items-center gap-2.5">
              <Dialog.Title className="text-[16px] font-semibold tracking-tight text-foreground-strong">
                Settings
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted">Auto-saved</Dialog.Description>
            </div>
            <Dialog.Close className="btn btn-ghost btn-icon" aria-label="Close">
              <XIcon className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>

          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col overflow-hidden"
          >
            <Tabs.List
              aria-label="Settings sections"
              className="mx-5 mb-2 flex w-fit shrink-0 gap-0.5 rounded-lg border border-border bg-sunken p-0.5"
            >
              {SETTINGS_TABS.map(({ id, label }) => (
                <Tabs.Trigger
                  key={id}
                  value={id}
                  className="rounded-md px-3 py-1 text-xs font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent data-[state=active]:bg-panel data-[state=active]:text-foreground-strong data-[state=active]:shadow-xs"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            {/* ===== EDITOR TAB ===== */}
            <Tabs.Content
              value="editor"
              className="flex-1 overflow-y-auto border-y border-border bg-panel px-5 py-3"
            >
              <SectionHeader>Keybindings</SectionHeader>

              <div className="flex items-center justify-between gap-4 py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-8 items-center justify-center rounded-lg font-mono text-xs font-semibold transition-colors ${
                      editorSettings.vimMode ? "bg-accent-soft text-accent" : "bg-subtle text-muted"
                    }`}
                  >
                    Vi
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={ROW_LABEL}>Vim mode</span>
                      {editorSettings.vimMode && (
                        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium text-accent">
                          NORMAL
                        </span>
                      )}
                    </div>
                    <p className={ROW_HINT}>Modal Vim keybindings</p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.vimMode}
                  onCheckedChange={(v) => onUpdateEditorSettings({ vimMode: v })}
                />
              </div>

              <SectionHeader>Display</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label htmlFor="editor-font-family" className={`${ROW_LABEL} shrink-0`}>
                  Font family
                </label>
                <input
                  id="editor-font-family"
                  type="text"
                  value={editorSettings.fontFamily}
                  onChange={(e) =>
                    onUpdateEditorSettings({
                      fontFamily: e.target.value,
                    })
                  }
                  placeholder="Default monospace stack"
                  className={`${AGENT_INPUT} font-mono max-w-sm`}
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-2">
                <label htmlFor="editor-font-size" className={ROW_LABEL}>
                  Font size
                </label>
                <div className={STEPPER}>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.max(8, editorSettings.fontSize - 1),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-r border-border`}
                    aria-label="Decrease font size"
                  >
                    <MinusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <input
                    id="editor-font-size"
                    type="number"
                    min="8"
                    max="32"
                    value={editorSettings.fontSize}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        fontSize: Math.min(32, Math.max(8, parseInt(e.target.value, 10) || 14)),
                      })
                    }
                    className={STEPPER_INPUT}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.min(32, editorSettings.fontSize + 1),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-l border-border`}
                    aria-label="Increase font size"
                  >
                    <PlusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <span className="flex h-full items-center border-l border-border px-2 text-xs text-muted">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 py-2">
                <label htmlFor="editor-line-height" className={ROW_LABEL}>
                  Line height
                </label>
                <div className={STEPPER}>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        lineHeight: Math.max(
                          1.0,
                          Math.round((editorSettings.lineHeight - 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-r border-border`}
                    aria-label="Decrease line height"
                  >
                    <MinusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <input
                    id="editor-line-height"
                    type="number"
                    min="1.0"
                    max="3.0"
                    step="0.1"
                    value={editorSettings.lineHeight.toFixed(1)}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        lineHeight: Math.min(3.0, Math.max(1.0, parseFloat(e.target.value) || 1.6)),
                      })
                    }
                    className={STEPPER_INPUT}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        lineHeight: Math.min(
                          3.0,
                          Math.round((editorSettings.lineHeight + 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-l border-border`}
                    aria-label="Increase line height"
                  >
                    <PlusIcon className="size-3" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <SelectField
                label="Line numbers"
                value={editorSettings.lineNumbers}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    lineNumbers: v as EditorSettings["lineNumbers"],
                  })
                }
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                  { value: "relative", label: "Relative" },
                  { value: "interval", label: "Every 10 lines" },
                ]}
              />

              <SelectField
                label="Render whitespace"
                value={editorSettings.renderWhitespace}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    renderWhitespace: v as EditorSettings["renderWhitespace"],
                  })
                }
                options={[
                  { value: "none", label: "None" },
                  { value: "boundary", label: "Boundary" },
                  { value: "selection", label: "Selection" },
                  { value: "trailing", label: "Trailing" },
                  { value: "all", label: "All" },
                ]}
              />

              <div>
                <CheckboxItem
                  checked={editorSettings.smoothScrolling}
                  onChange={(v) => onUpdateEditorSettings({ smoothScrolling: v })}
                  label="Smooth scrolling"
                />
              </div>

              <SectionHeader>Minimap</SectionHeader>

              <div className="flex items-center justify-between gap-4 py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={ROW_LABEL}>Minimap</span>
                    <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted">
                      Preview
                    </span>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.minimap.enabled}
                  onCheckedChange={(v) =>
                    onUpdateEditorSettings({
                      minimap: {
                        ...editorSettings.minimap,
                        enabled: v,
                      },
                    })
                  }
                />
              </div>

              {editorSettings.minimap.enabled && (
                <div className="space-y-1 ml-1 border-l border-border pl-4">
                  <div className="flex items-center justify-between gap-4 py-2">
                    <span className={ROW_LABEL}>Position</span>
                    <div className="flex gap-0.5 rounded-lg border border-border bg-sunken p-0.5">
                      {(["left", "right"] as const).map((side) => (
                        <button
                          type="button"
                          key={side}
                          onClick={() =>
                            onUpdateEditorSettings({
                              minimap: {
                                ...editorSettings.minimap,
                                side,
                              },
                            })
                          }
                          aria-pressed={editorSettings.minimap.side === side}
                          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                            editorSettings.minimap.side === side
                              ? "bg-panel text-foreground-strong shadow-xs"
                              : "text-muted hover:text-foreground"
                          }`}
                        >
                          {side === "left" ? "Left" : "Right"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Size Mode */}
                  <SelectField
                    label="Size mode"
                    value={editorSettings.minimap.size}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        minimap: {
                          ...editorSettings.minimap,
                          size: v as MinimapSettings["size"],
                        },
                      })
                    }
                    options={[
                      { value: "proportional", label: "Proportional" },
                      { value: "fill", label: "Fill" },
                      { value: "fit", label: "Fit" },
                    ]}
                  />

                  {/* Show Slider */}
                  <SelectField
                    label="Show slider"
                    value={editorSettings.minimap.showSlider}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        minimap: {
                          ...editorSettings.minimap,
                          showSlider: v as MinimapSettings["showSlider"],
                        },
                      })
                    }
                    options={[
                      { value: "mouseover", label: "On hover" },
                      { value: "always", label: "Always" },
                    ]}
                  />

                  {/* Render Characters */}
                  <div className="pt-2">
                    <CheckboxItem
                      checked={editorSettings.minimap.renderCharacters}
                      onChange={(v) =>
                        onUpdateEditorSettings({
                          minimap: {
                            ...editorSettings.minimap,
                            renderCharacters: v,
                          },
                        })
                      }
                      label="Render characters"
                      description="Show actual characters instead of blocks"
                    />
                  </div>
                </div>
              )}

              <SectionHeader>Cursor</SectionHeader>

              <SelectField
                label="Cursor style"
                value={editorSettings.cursorStyle}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    cursorStyle: v as EditorSettings["cursorStyle"],
                  })
                }
                options={[
                  { value: "line", label: "Line" },
                  { value: "line-thin", label: "Thin line" },
                  { value: "block", label: "Block" },
                  { value: "block-outline", label: "Block outline" },
                  { value: "underline", label: "Underline" },
                  { value: "underline-thin", label: "Thin underline" },
                ]}
              />

              <SelectField
                label="Cursor blinking"
                value={editorSettings.cursorBlinking}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    cursorBlinking: v as EditorSettings["cursorBlinking"],
                  })
                }
                options={[
                  { value: "blink", label: "Blink" },
                  { value: "smooth", label: "Smooth" },
                  { value: "phase", label: "Phase" },
                  { value: "expand", label: "Expand" },
                  { value: "solid", label: "Solid" },
                ]}
              />

              <SectionHeader>Editing</SectionHeader>

              <SelectField
                label="Tab size"
                value={editorSettings.tabSize}
                onChange={(v) => onUpdateEditorSettings({ tabSize: parseInt(v, 10) })}
                options={[
                  { value: 2, label: "2 spaces" },
                  { value: 4, label: "4 spaces" },
                  { value: 8, label: "8 spaces" },
                ]}
              />

              <SelectField
                label="Word wrap"
                value={editorSettings.wordWrap}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    wordWrap: v as EditorSettings["wordWrap"],
                  })
                }
                options={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                  { value: "wordWrapColumn", label: "Wrap at column" },
                  { value: "bounded", label: "Bounded" },
                ]}
              />

              {editorSettings.wordWrap === "wordWrapColumn" && (
                <div className="ml-1 border-l border-border pl-4 py-2">
                  <div className="flex items-center justify-between">
                    <label htmlFor="editor-word-wrap-column" className={ROW_LABEL}>
                      Wrap column
                    </label>
                    <input
                      id="editor-word-wrap-column"
                      type="number"
                      min="40"
                      max="200"
                      value={editorSettings.wordWrapColumn}
                      onChange={(e) =>
                        onUpdateEditorSettings({
                          wordWrapColumn: parseInt(e.target.value, 10) || 80,
                        })
                      }
                      className={`${AGENT_INPUT} w-20 text-center font-mono`}
                    />
                  </div>
                </div>
              )}

              <SelectField
                label="Auto-close brackets"
                value={editorSettings.autoClosingBrackets}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingBrackets: v as EditorSettings["autoClosingBrackets"],
                  })
                }
                options={[
                  { value: "always", label: "Always" },
                  { value: "languageDefined", label: "Language defined" },
                  {
                    value: "beforeWhitespace",
                    label: "Before whitespace",
                  },
                  { value: "never", label: "Never" },
                ]}
              />

              <SelectField
                label="Auto-close quotes"
                value={editorSettings.autoClosingQuotes}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingQuotes: v as EditorSettings["autoClosingQuotes"],
                  })
                }
                options={[
                  { value: "always", label: "Always" },
                  { value: "languageDefined", label: "Language defined" },
                  {
                    value: "beforeWhitespace",
                    label: "Before whitespace",
                  },
                  { value: "never", label: "Never" },
                ]}
              />

              <div>
                <CheckboxItem
                  checked={editorSettings.insertSpaces}
                  onChange={(v) => onUpdateEditorSettings({ insertSpaces: v })}
                  label="Insert spaces"
                />
              </div>

              <SectionHeader>Formatting</SectionHeader>

              <div>
                <CheckboxItem
                  checked={editorSettings.formatOnSave}
                  onChange={(v) => onUpdateEditorSettings({ formatOnSave: v })}
                  label="Format on save"
                />
                <CheckboxItem
                  checked={editorSettings.formatOnPaste}
                  onChange={(v) => onUpdateEditorSettings({ formatOnPaste: v })}
                  label="Format on paste"
                />
              </div>

              <SectionHeader>Terminal</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label htmlFor="editor-terminal-font-family" className={`${ROW_LABEL} shrink-0`}>
                  Font family
                </label>
                <input
                  id="editor-terminal-font-family"
                  type="text"
                  value={editorSettings.terminalFontFamily}
                  onChange={(e) =>
                    onUpdateEditorSettings({
                      terminalFontFamily: e.target.value,
                    })
                  }
                  placeholder="Default monospace stack"
                  className={`${AGENT_INPUT} font-mono max-w-sm`}
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-2">
                <label htmlFor="editor-terminal-font-size" className={ROW_LABEL}>
                  Font size
                </label>
                <div className={STEPPER}>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.max(8, editorSettings.terminalFontSize - 1),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-r border-border`}
                    aria-label="Decrease terminal font size"
                  >
                    <MinusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <input
                    id="editor-terminal-font-size"
                    type="number"
                    min="8"
                    max="32"
                    value={editorSettings.terminalFontSize}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.min(
                          32,
                          Math.max(8, parseInt(e.target.value, 10) || 13),
                        ),
                      })
                    }
                    className={STEPPER_INPUT}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.min(32, editorSettings.terminalFontSize + 1),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-l border-border`}
                    aria-label="Increase terminal font size"
                  >
                    <PlusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <span className="flex h-full items-center border-l border-border px-2 text-xs text-muted">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 py-2">
                <label htmlFor="editor-terminal-line-height" className={ROW_LABEL}>
                  Line height
                </label>
                <div className={STEPPER}>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.max(
                          1.0,
                          Math.round((editorSettings.terminalLineHeight - 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-r border-border`}
                    aria-label="Decrease terminal line height"
                  >
                    <MinusIcon className="size-3" aria-hidden="true" />
                  </button>
                  <input
                    id="editor-terminal-line-height"
                    type="number"
                    min="1.0"
                    max="3.0"
                    step="0.1"
                    value={editorSettings.terminalLineHeight.toFixed(1)}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.min(
                          3.0,
                          Math.max(1.0, parseFloat(e.target.value) || 1.4),
                        ),
                      })
                    }
                    className={STEPPER_INPUT}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.min(
                          3.0,
                          Math.round((editorSettings.terminalLineHeight + 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className={`${STEPPER_BUTTON} border-l border-border`}
                    aria-label="Increase terminal line height"
                  >
                    <PlusIcon className="size-3" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <SelectField
                label="Shell"
                value={editorSettings.terminalShellMode}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    terminalShellMode: v as EditorSettings["terminalShellMode"],
                  })
                }
                options={[
                  { value: "auto", label: "Auto detect" },
                  { value: "custom", label: "Custom" },
                ]}
              />

              {editorSettings.terminalShellMode === "custom" && (
                <div className="ml-1 border-l border-border pl-4 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor="editor-terminal-shell-path" className={`${ROW_LABEL} shrink-0`}>
                      Shell command
                    </label>
                    <input
                      id="editor-terminal-shell-path"
                      type="text"
                      value={editorSettings.terminalShellPath}
                      onChange={(e) =>
                        onUpdateEditorSettings({
                          terminalShellPath: e.target.value,
                        })
                      }
                      placeholder="powershell.exe / pwsh / /bin/zsh"
                      className={`${AGENT_INPUT} font-mono`}
                    />
                  </div>
                  <p className={ROW_HINT}>Leave empty to auto detect.</p>
                </div>
              )}
            </Tabs.Content>

            {/* ===== BUILD TAB ===== */}
            <Tabs.Content
              value="build"
              className="flex-1 overflow-y-auto border-y border-border bg-panel px-5 py-3"
            >
              <SectionHeader>Main file</SectionHeader>

              <div className="py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className={ROW_LABEL}>Main .tex file</span>
                </div>
                {texFiles.length === 0 ? (
                  <p className="py-1 text-xs text-muted">No .tex files in this project</p>
                ) : (
                  <Select
                    value={settings.mainFile || ""}
                    onValueChange={(v) => onUpdateSettings({ mainFile: v || null })}
                  >
                    <SelectTrigger
                      className={`${SELECT_TRIGGER} w-full font-mono`}
                      aria-label="Main .tex file"
                    >
                      <SelectValue placeholder="Select main .tex file…" />
                    </SelectTrigger>
                    <SelectContent className="rounded-lg shadow-[var(--shadow-2)]">
                      {texFiles.map((file) => (
                        <SelectItem key={file} value={file} className="rounded-md font-mono">
                          {file}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <SectionHeader>Compiler and live preview</SectionHeader>

              <SelectField
                label="Compiler"
                value={settings.compiler}
                onChange={(v) => onUpdateSettings({ compiler: v as LaTeXCompiler })}
                options={(
                  ["auto", "latexmk", "pdflatex", "xelatex", "lualatex", "tectonic"] as const
                ).map((c) => {
                  const statusInfo =
                    c === "auto" ? null : compilersStatus ? compilersStatus[c] : null;
                  const suffix =
                    c === "auto"
                      ? ""
                      : statusInfo
                        ? statusInfo.available
                          ? " · installed"
                          : " · not found"
                        : "";
                  return {
                    value: c,
                    label: `${COMPILER_DISPLAY_NAMES[c]}${suffix}`,
                    disabled: statusInfo?.available === false,
                  };
                })}
              />

              {(settings.compiler === "latexmk" || settings.compiler === "auto") && (
                <SelectField
                  label="latexmk engine"
                  value={settings.latexmkEngine}
                  onChange={(v) => onUpdateSettings({ latexmkEngine: v as LatexmkEngine })}
                  options={[
                    { value: "pdflatex", label: "pdfLaTeX" },
                    { value: "xelatex", label: "XeLaTeX (Unicode / CJK)" },
                    { value: "lualatex", label: "LuaLaTeX" },
                  ]}
                />
              )}

              <div className="flex items-center justify-between gap-4 py-2">
                <div>
                  <span className={ROW_LABEL}>Auto-compile live preview</span>
                  <p className={ROW_HINT}>Recompile after your edits and agent changes</p>
                </div>
                <Switch
                  checked={settings.autoCompile}
                  onCheckedChange={(v) => onUpdateSettings({ autoCompile: v })}
                />
              </div>

              {settings.autoCompile && (
                <SelectField
                  label="Auto-compile delay"
                  value={settings.autoCompileDelayMs}
                  onChange={(v) =>
                    onUpdateSettings({
                      autoCompileDelayMs: Math.max(300, Number.parseInt(v, 10) || 900),
                    })
                  }
                  options={[
                    { value: 400, label: "Fast (400 ms)" },
                    { value: 900, label: "Balanced (900 ms)" },
                    { value: 1500, label: "Moderate (1.5 s)" },
                    { value: 2500, label: "Relaxed (2.5 s)" },
                  ]}
                />
              )}

              <div className="flex items-center justify-between gap-4 py-2">
                <div>
                  <span className={ROW_LABEL}>Shell escape</span>
                  <p className={ROW_HINT}>
                    <code className="font-mono">-shell-escape</code>, needed for minted and similar
                    packages. Enable only for trusted projects.
                  </p>
                </div>
                <Switch
                  checked={settings.shellEscape}
                  onCheckedChange={(v) => onUpdateSettings({ shellEscape: v })}
                />
              </div>

              <div className="space-y-1.5 py-2">
                <label htmlFor="latex-custom-args" className={`${ROW_LABEL} block`}>
                  Extra compiler arguments
                </label>
                <input
                  id="latex-custom-args"
                  type="text"
                  value={settings.customArgs.join(" ")}
                  onChange={(e) =>
                    onUpdateSettings({
                      customArgs: splitArgsString(e.target.value),
                    })
                  }
                  placeholder="-halt-on-error"
                  className={`${AGENT_INPUT} font-mono`}
                />
              </div>

              <div className="space-y-1.5 py-2">
                <label htmlFor="latex-custom-path" className={`${ROW_LABEL} block`}>
                  Custom compiler path
                </label>
                <input
                  id="latex-custom-path"
                  type="text"
                  value={settings.customCompilerPath ?? ""}
                  onChange={(e) =>
                    onUpdateSettings({
                      customCompilerPath: e.target.value.trim() || null,
                    })
                  }
                  placeholder="/Library/TeX/texbin/latexmk"
                  className={`${AGENT_INPUT} font-mono`}
                />
              </div>

              {onCleanAuxFiles && (
                <div className="flex items-center justify-between gap-4 py-2">
                  <div>
                    <span className={ROW_LABEL}>Auxiliary files</span>
                    <p className={ROW_HINT}>
                      Remove .aux, .log, .fls, .fdb_latexmk, .toc, .bbl, etc.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={cleaningAux}
                    onClick={async () => {
                      setCleaningAux(true);
                      try {
                        await onCleanAuxFiles();
                      } finally {
                        setCleaningAux(false);
                      }
                    }}
                    className="btn btn-secondary btn-sm shrink-0"
                  >
                    {cleaningAux ? "Cleaning…" : "Clean aux files"}
                  </button>
                </div>
              )}

              <SectionHeader>Git</SectionHeader>

              <div className="flex items-center justify-between gap-4 py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`size-8 rounded-lg flex items-center justify-center transition-colors ${
                      editorSettings.gitAutoFetchEnabled ? "bg-accent-soft" : "bg-subtle"
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className={editorSettings.gitAutoFetchEnabled ? "text-accent" : "text-muted"}
                    >
                      <path
                        d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM4.5 8a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm7 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"
                        fill="currentColor"
                        fillRule="evenodd"
                      />
                      <path
                        d="M8 5.75v2.5M6 9l-1-.5M10 9l1-.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={ROW_LABEL}>Auto fetch</span>
                      {editorSettings.gitAutoFetchEnabled && (
                        <span className="shrink-0 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">
                          Active
                        </span>
                      )}
                    </div>
                    <p className={ROW_HINT}>Fetch remote refs in the background</p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.gitAutoFetchEnabled}
                  onCheckedChange={(v) => onUpdateEditorSettings({ gitAutoFetchEnabled: v })}
                />
              </div>

              {editorSettings.gitAutoFetchEnabled && (
                <div className="ml-1 border-l border-border pl-4">
                  <SelectField
                    label="Interval"
                    value={editorSettings.gitAutoFetchIntervalSeconds}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        gitAutoFetchIntervalSeconds: Math.min(
                          3600,
                          Math.max(15, parseInt(v, 10) || 120),
                        ),
                      })
                    }
                    options={[
                      { value: 30, label: "30 seconds" },
                      { value: 60, label: "1 minute" },
                      { value: 120, label: "2 minutes" },
                      { value: 300, label: "5 minutes" },
                      { value: 600, label: "10 minutes" },
                    ]}
                  />
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content
              value="agents"
              className="mx-3 min-h-0 overflow-y-auto rounded-xl border border-border bg-panel px-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            >
              <section className="py-3" aria-label="Detected agent CLIs">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <h3 className={AGENT_HEADING}>Detected agent CLIs</h3>
                  {onRefreshAgentProviders && (
                    <button
                      type="button"
                      onClick={() => void onRefreshAgentProviders()}
                      className="btn btn-secondary btn-sm shrink-0"
                    >
                      <ArrowsClockwiseIcon className="size-3.5" aria-hidden="true" />
                      Detect again
                    </button>
                  )}
                </div>

                <ul className="divide-y divide-border">
                  {agentProviders.map((provider) => {
                    const voice = VOICE_COLORS[provider.id];
                    const status = !provider.installed
                      ? { label: "Not found", style: "bg-subtle text-muted" }
                      : provider.authenticated
                        ? { label: "Ready", style: "bg-success-bg text-success" }
                        : { label: "Sign-in required", style: "bg-warn-bg text-warn" };

                    return (
                      <li key={provider.id} className="flex items-center gap-2.5 py-2">
                        <span
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg"
                          style={{ color: voice.ink, backgroundColor: voice.tint }}
                        >
                          <ProviderIcon providerId={provider.id} className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-[13px] font-medium text-foreground-strong">
                              {provider.name}
                            </span>
                            <span className="text-xs text-muted">
                              {TRANSPORT_LABELS[provider.transport] ?? provider.transport}
                            </span>
                          </div>
                          {provider.binaryPath ? (
                            <p
                              className="truncate font-mono text-[11px] text-muted"
                              title={provider.binaryPath}
                            >
                              {provider.binaryPath}
                            </p>
                          ) : (
                            provider.authError && (
                              <p className="text-[11px] text-muted">{provider.authError}</p>
                            )
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.style}`}
                        >
                          {status.label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {agentSettings && onUpdateAgentSettings && (
                <>
                  <section
                    className="space-y-0.5 border-t border-border py-3"
                    aria-label="Session defaults"
                  >
                    <h3 className={AGENT_HEADING}>Session defaults</h3>

                    <SelectField
                      label="Default provider"
                      value={agentSettings.defaultProvider}
                      onChange={(v) =>
                        onUpdateAgentSettings({ defaultProvider: v as AgentProviderId })
                      }
                      options={[
                        { value: "claude", label: "Claude Code" },
                        { value: "codex", label: "OpenAI Codex" },
                        { value: "antigravity", label: "Antigravity (ACP)" },
                        { value: "custom-acp", label: "Custom ACP" },
                      ]}
                    />

                    <SelectField
                      label="Default interaction mode"
                      value={agentSettings.defaultInteractionMode}
                      onChange={(v) =>
                        onUpdateAgentSettings({ defaultInteractionMode: v as InteractionMode })
                      }
                      options={[
                        { value: "default", label: "Default (edit)" },
                        { value: "plan", label: "Plan" },
                      ]}
                    />

                    <SelectField
                      label="Default permission policy"
                      value={agentSettings.defaultRuntimeMode}
                      onChange={(v) =>
                        onUpdateAgentSettings({ defaultRuntimeMode: v as RuntimeMode })
                      }
                      options={[
                        { value: "approval-required", label: "Approval required (ask)" },
                        { value: "auto-accept-edits", label: "Auto-accept file edits" },
                        { value: "full-access", label: "Full access" },
                      ]}
                    />
                  </section>

                  {onUpdateCustomProvider && (
                    <div className="grid gap-4 border-t border-border py-3 sm:grid-cols-2">
                      <section className="min-w-0 space-y-2" aria-label="CLI paths">
                        <h3 className={AGENT_HEADING}>CLI paths</h3>
                        {CLI_PATH_FIELDS.map(({ id, label }) => (
                          <label key={id} className="block space-y-1 text-xs text-foreground">
                            <span>{label}</span>
                            <input
                              type="text"
                              value={agentSettings.customProviders[id].binaryPath}
                              onChange={(e) =>
                                onUpdateCustomProvider(id, { binaryPath: e.target.value })
                              }
                              placeholder="Auto-detect"
                              className={`${AGENT_INPUT} font-mono`}
                            />
                          </label>
                        ))}
                      </section>

                      <section
                        className="min-w-0 space-y-2 sm:border-l sm:border-border sm:pl-4"
                        aria-label="Custom ACP"
                      >
                        <h3 className={AGENT_HEADING}>Custom ACP</h3>
                        {CUSTOM_ACP_FIELDS.map(({ key, label, placeholder }) => (
                          <label key={key} className="block space-y-1 text-xs text-foreground">
                            <span>{label}</span>
                            <input
                              type="text"
                              value={agentSettings.customProviders["custom-acp"][key]}
                              onChange={(e) =>
                                onUpdateCustomProvider("custom-acp", { [key]: e.target.value })
                              }
                              placeholder={placeholder}
                              className={
                                key === "customName" ? AGENT_INPUT : `${AGENT_INPUT} font-mono`
                              }
                            />
                          </label>
                        ))}
                      </section>
                    </div>
                  )}
                </>
              )}
            </Tabs.Content>

            {/* ===== ABOUT TAB ===== */}
            <Tabs.Content
              value="about"
              className="flex-1 overflow-y-auto border-y border-border bg-panel px-5 py-3"
            >
              <AboutTab
                autoCheck={editorSettings.autoCheckUpdates}
                onAutoCheckChange={(v) => onUpdateEditorSettings({ autoCheckUpdates: v })}
              />
            </Tabs.Content>
          </Tabs.Root>

          <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
            {canResetActiveTab && (
              <button
                type="button"
                onClick={
                  activeTab === "editor" ? handleResetEditorSettings : handleResetLatexSettings
                }
                className="btn btn-ghost btn-sm"
              >
                <ArrowCounterClockwiseIcon className="size-3.5" aria-hidden="true" />
                Reset to defaults
              </button>
            )}
            <Dialog.Close className="btn btn-secondary btn-sm ml-auto">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
