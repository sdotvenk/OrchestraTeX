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
import { useTheme } from "next-themes";
import { useCallback, useEffect, useId, useState } from "react";
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
  UI_PALETTES,
  type UiPalette,
} from "@/lib/editor/types";
import {
  COMPILER_DISPLAY_NAMES,
  DEFAULT_LATEX_SETTINGS,
  type LaTeXCompiler,
  type LaTeXCompilersStatus,
  type LaTeXSettings,
  type LatexmkEngine,
} from "@/lib/latex/types";

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
  initialTab?: "build" | "editor" | "agents";
}

// Section header component for visual grouping - editorial style
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-6 pb-2 border-t border-border mt-4 first:mt-0 first:border-t-0 first:pt-2">
      <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
        {children}
      </h3>
    </div>
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
  description: string;
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
        <span className="text-sm font-medium text-foreground-secondary group-hover:text-foreground transition-colors">
          {label}
        </span>
        <p className="text-xs text-muted mt-0.5">{description}</p>
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
  options: { value: string | number; label: string }[];
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 gap-8">
      <div className="shrink-0">
        <span className="text-sm font-medium text-foreground-secondary block">{label}</span>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={String(opt.value)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AppearanceToggle({
  palette,
  onChangePalette,
}: {
  palette: UiPalette;
  onChangePalette: (next: UiPalette) => void;
}) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="py-2 space-y-4">
      <div>
        <span className="text-[13px] font-medium block mb-2 text-foreground-strong">
          Color mode
        </span>
        <div className="inline-flex w-full p-0.5 rounded-lg bg-sunken gap-0.5">
          {(
            [
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ] as const
          ).map((mode) => (
            <button
              type="button"
              key={mode.value}
              onClick={() => setTheme(mode.value)}
              className={`flex-1 h-8 px-3 rounded-md text-[12.5px] font-medium transition-all ${
                theme === mode.value
                  ? "bg-panel text-foreground-strong shadow-xs"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="text-[13px] font-medium block mb-2 text-foreground-strong">
          Theme palette
        </span>
        <div className="grid grid-cols-3 gap-2">
          {UI_PALETTES.map((item) => {
            const active = palette === item.id;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => onChangePalette(item.id)}
                className={`p-2.5 rounded-xl border text-left transition-all ${
                  active
                    ? "border-accent bg-accent-soft/60"
                    : "border-border bg-panel hover:border-border-dark hover:bg-subtle/60"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-2">
                  {item.swatches.map((hex) => (
                    <span
                      key={hex}
                      className="size-3.5 rounded-full border border-black/15"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
                <div className="text-[12.5px] font-semibold text-foreground-strong">
                  {item.label}
                </div>
                <div className="text-[11px] text-muted leading-snug mt-0.5 line-clamp-2">
                  {item.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>
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
        <Dialog.Overlay className="fixed inset-0 bg-black/35 backdrop-blur-[2px] z-[9999]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-panel rounded-2xl border border-border w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
          style={{ boxShadow: "var(--shadow-3)" }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2.5">
              <Dialog.Title className="text-[16px] font-semibold tracking-tight text-foreground-strong">
                Settings
              </Dialog.Title>
              <span className="text-[11px] text-muted-foreground">Auto-saved</span>
            </div>
            <Dialog.Close
              className="size-8 rounded-lg inline-flex items-center justify-center text-muted hover:text-foreground hover:bg-subtle transition-colors"
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>

          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col overflow-hidden"
          >
            {/* Tabs */}
            <Tabs.List className="flex px-4 gap-1 border-b border-border shrink-0">
              <Tabs.Trigger
                value="build"
                className="px-3 py-2.5 text-[13px] font-medium transition-colors relative text-muted hover:text-foreground data-[state=active]:text-accent border-b-2 border-transparent data-[state=active]:border-accent -mb-px"
              >
                Build
              </Tabs.Trigger>
              <Tabs.Trigger
                value="editor"
                className="px-3 py-2.5 text-[13px] font-medium transition-colors relative text-muted hover:text-foreground data-[state=active]:text-accent border-b-2 border-transparent data-[state=active]:border-accent -mb-px"
              >
                Editor
              </Tabs.Trigger>
              <Tabs.Trigger
                value="agents"
                className="px-3 py-2.5 text-[13px] font-medium transition-colors relative text-muted hover:text-foreground data-[state=active]:text-accent border-b-2 border-transparent data-[state=active]:border-accent -mb-px"
              >
                Agents
              </Tabs.Trigger>
            </Tabs.List>

            {/* ===== EDITOR TAB ===== */}
            <Tabs.Content value="editor" className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              <SectionHeader>Appearance</SectionHeader>

              {/* Light/Dark & Palette Switcher */}
              <AppearanceToggle
                palette={editorSettings.uiPalette}
                onChangePalette={(uiPalette) => onUpdateEditorSettings({ uiPalette })}
              />

              <SectionHeader>Keybindings</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 border flex items-center justify-center font-mono text-xs font-bold tracking-tight transition-colors ${
                      editorSettings.vimMode
                        ? "bg-foreground border-foreground text-background"
                        : "bg-accent-hover border-border text-muted-foreground"
                    }`}
                  >
                    Vi
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground-secondary">
                        Vim Mode
                      </span>
                      {editorSettings.vimMode && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-foreground text-background font-mono font-bold tracking-wider">
                          NORMAL
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      Modal Vim-style keybindings in editor
                    </p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.vimMode}
                  onCheckedChange={(v) => onUpdateEditorSettings({ vimMode: v })}
                />
              </div>

              <SectionHeader>Display</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label
                  htmlFor="editor-font-family"
                  className="text-sm font-medium text-foreground-secondary shrink-0"
                >
                  Font Family
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
                  className="w-full max-w-sm px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-font-size"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  Font Size
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.max(8, editorSettings.fontSize - 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label="Decrease font size"
                  >
                    <MinusIcon className="size-3" />
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
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.min(32, editorSettings.fontSize + 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label="Increase font size"
                  >
                    <PlusIcon className="size-3" />
                  </button>
                  <span className="text-xs text-muted-foreground px-2 border-l border-border">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-line-height"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  Line Height
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
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
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label="Decrease line height"
                  >
                    <MinusIcon className="size-3" />
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
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
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
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label="Increase line height"
                  >
                    <PlusIcon className="size-3" />
                  </button>
                </div>
              </div>

              <SelectField
                label="Line Numbers"
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
                  { value: "interval", label: "Interval (every 10)" },
                ]}
              />

              <SelectField
                label="Render Whitespace"
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

              <div className="space-y-3 pt-1">
                <CheckboxItem
                  checked={editorSettings.smoothScrolling}
                  onChange={(v) => onUpdateEditorSettings({ smoothScrolling: v })}
                  label="Smooth Scrolling"
                  description="Enable smooth scroll animation"
                />
              </div>

              <SectionHeader>Minimap</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground-secondary">
                      Enable Minimap
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border border-border text-muted font-medium uppercase tracking-wider">
                      Preview
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-0.5">Code overview panel</p>
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
                <div className="space-y-1 pl-4 border-l-2 border-border ml-1">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-sm font-medium text-foreground-secondary">Position</span>
                    <div className="flex">
                      {(["left", "right"] as const).map((side, index) => (
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
                          className={`px-4 py-1.5 text-sm border transition-all ${
                            editorSettings.minimap.side === side
                              ? "bg-foreground text-background border-foreground"
                              : "bg-background text-muted border-border hover:border-border-dark"
                          } ${index === 0 ? "" : "-ml-px"}`}
                        >
                          {side === "left" ? "Left" : "Right"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Size Mode */}
                  <SelectField
                    label="Size Mode"
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
                    description="How the minimap scales relative to content"
                  />

                  {/* Show Slider */}
                  <SelectField
                    label="Show Slider"
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
                      { value: "mouseover", label: "On Hover" },
                      { value: "always", label: "Always" },
                    ]}
                    description="When to show the viewport indicator"
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
                      label="Render Characters"
                      description="Show actual characters instead of blocks"
                    />
                  </div>
                </div>
              )}

              <SectionHeader>Cursor</SectionHeader>

              <SelectField
                label="Cursor Style"
                value={editorSettings.cursorStyle}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    cursorStyle: v as EditorSettings["cursorStyle"],
                  })
                }
                options={[
                  { value: "line", label: "Line" },
                  { value: "line-thin", label: "Line (Thin)" },
                  { value: "block", label: "Block" },
                  { value: "block-outline", label: "Block Outline" },
                  { value: "underline", label: "Underline" },
                  { value: "underline-thin", label: "Underline (Thin)" },
                ]}
              />

              <SelectField
                label="Cursor Blinking"
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
                label="Tab Size"
                value={editorSettings.tabSize}
                onChange={(v) => onUpdateEditorSettings({ tabSize: parseInt(v, 10) })}
                options={[
                  { value: 2, label: "2 spaces" },
                  { value: 4, label: "4 spaces" },
                  { value: 8, label: "8 spaces" },
                ]}
              />

              <SelectField
                label="Word Wrap"
                value={editorSettings.wordWrap}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    wordWrap: v as EditorSettings["wordWrap"],
                  })
                }
                options={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                  { value: "wordWrapColumn", label: "Wrap at Column" },
                  { value: "bounded", label: "Bounded" },
                ]}
              />

              {editorSettings.wordWrap === "wordWrapColumn" && (
                <div className="pl-4 border-l-2 border-border ml-1 py-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="editor-word-wrap-column"
                      className="text-sm font-medium text-foreground-secondary"
                    >
                      Wrap Column
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
                      className="w-20 px-3 py-2 text-sm text-center border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono"
                    />
                  </div>
                </div>
              )}

              <SelectField
                label="Auto-close Brackets"
                value={editorSettings.autoClosingBrackets}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingBrackets: v as EditorSettings["autoClosingBrackets"],
                  })
                }
                options={[
                  { value: "always", label: "Always" },
                  { value: "languageDefined", label: "Language Defined" },
                  {
                    value: "beforeWhitespace",
                    label: "Before Whitespace",
                  },
                  { value: "never", label: "Never" },
                ]}
              />

              <SelectField
                label="Auto-close Quotes"
                value={editorSettings.autoClosingQuotes}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingQuotes: v as EditorSettings["autoClosingQuotes"],
                  })
                }
                options={[
                  { value: "always", label: "Always" },
                  { value: "languageDefined", label: "Language Defined" },
                  {
                    value: "beforeWhitespace",
                    label: "Before Whitespace",
                  },
                  { value: "never", label: "Never" },
                ]}
              />

              <div className="space-y-3 pt-1">
                <CheckboxItem
                  checked={editorSettings.insertSpaces}
                  onChange={(v) => onUpdateEditorSettings({ insertSpaces: v })}
                  label="Insert Spaces"
                  description="Use spaces instead of tabs for indentation"
                />
              </div>

              <SectionHeader>Formatting</SectionHeader>

              <div className="space-y-3">
                <CheckboxItem
                  checked={editorSettings.formatOnSave}
                  onChange={(v) => onUpdateEditorSettings({ formatOnSave: v })}
                  label="Format on Save"
                  description="Automatically format code when saving"
                />
                <CheckboxItem
                  checked={editorSettings.formatOnPaste}
                  onChange={(v) => onUpdateEditorSettings({ formatOnPaste: v })}
                  label="Format on Paste"
                  description="Automatically format pasted code"
                />
              </div>

              <SectionHeader>Terminal</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label
                  htmlFor="editor-terminal-font-family"
                  className="text-sm font-medium text-foreground-secondary shrink-0"
                >
                  Font Family
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
                  className="w-full max-w-sm px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-terminal-font-size"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  Font Size
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.max(8, editorSettings.terminalFontSize - 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label="Decrease terminal font size"
                  >
                    <MinusIcon className="size-3" />
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
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.min(32, editorSettings.terminalFontSize + 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label="Increase terminal font size"
                  >
                    <PlusIcon className="size-3" />
                  </button>
                  <span className="text-xs text-muted-foreground px-2 border-l border-border">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-terminal-line-height"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  Line Height
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
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
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label="Decrease terminal line height"
                  >
                    <MinusIcon className="size-3" />
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
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
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
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label="Increase terminal line height"
                  >
                    <PlusIcon className="size-3" />
                  </button>
                </div>
              </div>

              <SelectField
                label="Shell Selection"
                value={editorSettings.terminalShellMode}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    terminalShellMode: v as EditorSettings["terminalShellMode"],
                  })
                }
                options={[
                  { value: "auto", label: "Auto Detect" },
                  { value: "custom", label: "Custom" },
                ]}
                description="Auto mode chooses shell per OS fallback rules"
              />

              {editorSettings.terminalShellMode === "custom" && (
                <div className="pl-4 border-l-2 border-border ml-1 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <label
                      htmlFor="editor-terminal-shell-path"
                      className="text-sm font-medium text-foreground-secondary shrink-0"
                    >
                      Shell Command
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
                      className="w-full px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Leave empty to fall back to auto detection.
                  </p>
                </div>
              )}
            </Tabs.Content>

            {/* ===== BUILD TAB ===== */}
            <Tabs.Content value="build" className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              <SectionHeader>Main File</SectionHeader>

              <div className="py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-foreground-secondary">
                    Main .tex File
                  </span>
                </div>
                {texFiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    No .tex files found in project
                  </p>
                ) : (
                  <Select
                    value={settings.mainFile || ""}
                    onValueChange={(v) => onUpdateSettings({ mainFile: v || null })}
                  >
                    <SelectTrigger className="w-full" aria-label="Main .tex file">
                      <SelectValue placeholder="Select main .tex file..." />
                    </SelectTrigger>
                    <SelectContent>
                      {texFiles.map((file) => (
                        <SelectItem key={file} value={file}>
                          {file}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-muted-foreground mt-1.5">
                  The entry point for LaTeX compilation
                </p>
              </div>

              <SectionHeader>Compiler & Live Preview</SectionHeader>

              <SelectField
                label="Compiler"
                description="Engine used when building your document"
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
                          ? " (Installed)"
                          : " (Not found)"
                        : "";
                  return {
                    value: c,
                    label: `${COMPILER_DISPLAY_NAMES[c]}${suffix}`,
                  };
                })}
              />

              {(settings.compiler === "latexmk" || settings.compiler === "auto") && (
                <SelectField
                  label="Latexmk Engine"
                  description="Underlying engine passed to latexmk"
                  value={settings.latexmkEngine}
                  onChange={(v) => onUpdateSettings({ latexmkEngine: v as LatexmkEngine })}
                  options={[
                    { value: "pdflatex", label: "pdfLaTeX" },
                    { value: "xelatex", label: "XeLaTeX (Unicode / CJK)" },
                    { value: "lualatex", label: "LuaLaTeX" },
                  ]}
                />
              )}

              <div className="flex items-center justify-between py-2">
                <div>
                  <span className="text-sm font-medium text-foreground-secondary">
                    Auto-Compile Live Preview
                  </span>
                  <p className="text-xs text-muted mt-0.5">
                    Automatically recompile after edits or AI modifications
                  </p>
                </div>
                <Switch
                  checked={settings.autoCompile}
                  onCheckedChange={(v) => onUpdateSettings({ autoCompile: v })}
                />
              </div>

              {settings.autoCompile && (
                <SelectField
                  label="Auto-Compile Delay"
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

              <div className="flex items-center justify-between py-2">
                <div>
                  <span className="text-sm font-medium text-foreground-secondary">
                    Shell Escape (-shell-escape)
                  </span>
                  <p className="text-xs text-muted mt-0.5">
                    Required for packages like minted or external tools (use on trusted repos)
                  </p>
                </div>
                <Switch
                  checked={settings.shellEscape}
                  onCheckedChange={(v) => onUpdateSettings({ shellEscape: v })}
                />
              </div>

              <div className="py-2 space-y-1.5">
                <label
                  htmlFor="latex-custom-args"
                  className="text-sm font-medium text-foreground-secondary block"
                >
                  Extra Compiler Arguments
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
                  className="w-full px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              <div className="py-2 space-y-1.5">
                <label
                  htmlFor="latex-custom-path"
                  className="text-sm font-medium text-foreground-secondary block"
                >
                  Custom Compiler Binary Path (optional)
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
                  className="w-full px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              {onCleanAuxFiles && (
                <div className="py-2 flex items-center justify-between border-t border-border mt-2 pt-3">
                  <div>
                    <span className="text-sm font-medium text-foreground-secondary">
                      Auxiliary Files
                    </span>
                    <p className="text-xs text-muted mt-0.5">
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
                    className="btn btn-outline btn-sm"
                  >
                    {cleaningAux ? "Cleaning..." : "Clean Aux Files"}
                  </button>
                </div>
              )}

              <SectionHeader>Git</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 border flex items-center justify-center transition-colors ${
                      editorSettings.gitAutoFetchEnabled
                        ? "bg-foreground border-foreground"
                        : "bg-accent-hover border-border"
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className={
                        editorSettings.gitAutoFetchEnabled
                          ? "text-background"
                          : "text-muted-foreground"
                      }
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
                      <span className="text-sm font-medium text-foreground-secondary">
                        Auto Fetch
                      </span>
                      {editorSettings.gitAutoFetchEnabled && (
                        <span className="text-[10px] px-1.5 py-0.5 border border-emerald-300 text-emerald-600 font-medium uppercase tracking-wider bg-emerald-50">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      Periodically sync remote refs in background
                    </p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.gitAutoFetchEnabled}
                  onCheckedChange={(v) => onUpdateEditorSettings({ gitAutoFetchEnabled: v })}
                />
              </div>

              {editorSettings.gitAutoFetchEnabled && (
                <div className="pl-4 border-l-2 border-border ml-1">
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

            {/* ===== AGENTS TAB ===== */}
            <Tabs.Content value="agents" className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex items-center justify-between pt-2 pb-1">
                <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                  Detected Agent CLIs
                </h3>
                {onRefreshAgentProviders && (
                  <button
                    type="button"
                    onClick={() => void onRefreshAgentProviders()}
                    className="btn btn-outline btn-sm inline-flex items-center gap-1"
                  >
                    <ArrowsClockwiseIcon className="size-3.5" aria-hidden="true" />
                    <span>Re-detect</span>
                  </button>
                )}
              </div>

              <div className="space-y-2">
                {agentProviders.map((p) => (
                  <div
                    key={p.id}
                    className="border border-border bg-surface-secondary px-3 py-2 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-foreground flex items-center gap-2">
                        <span>{p.name}</span>
                        <span className="text-[10px] font-mono uppercase text-muted">
                          {p.transport}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-muted truncate">
                        {p.binaryPath || p.authError || "Not detected on PATH"}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-mono uppercase px-1.5 py-0.5 border shrink-0 ${
                        p.installed && p.authenticated
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted"
                      }`}
                    >
                      {p.installed ? (p.authenticated ? "Ready" : "Auth Needed") : "Missing"}
                    </span>
                  </div>
                ))}
              </div>

              {agentSettings && onUpdateAgentSettings && (
                <>
                  <SectionHeader>Session Defaults</SectionHeader>

                  <SelectField
                    label="Default Provider"
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
                    label="Default Interaction Mode"
                    value={agentSettings.defaultInteractionMode}
                    onChange={(v) =>
                      onUpdateAgentSettings({ defaultInteractionMode: v as InteractionMode })
                    }
                    options={[
                      { value: "default", label: "Default (Edit)" },
                      { value: "plan", label: "Plan" },
                    ]}
                  />

                  <SelectField
                    label="Default Permission Policy"
                    value={agentSettings.defaultRuntimeMode}
                    onChange={(v) =>
                      onUpdateAgentSettings({ defaultRuntimeMode: v as RuntimeMode })
                    }
                    options={[
                      { value: "approval-required", label: "Approval Required (Ask)" },
                      { value: "auto-accept-edits", label: "Auto-Accept File Edits" },
                      { value: "full-access", label: "Full Access" },
                    ]}
                  />

                  {onUpdateCustomProvider && (
                    <>
                      <SectionHeader>Custom CLI Paths & ACP Server</SectionHeader>

                      {(["claude", "codex", "antigravity"] as const).map((pid) => (
                        <div key={pid} className="py-1.5 space-y-1">
                          <label
                            htmlFor={`agent-bin-${pid}`}
                            className="text-xs font-mono uppercase text-foreground-secondary block"
                          >
                            {pid} Binary Path (optional)
                          </label>
                          <input
                            id={`agent-bin-${pid}`}
                            type="text"
                            value={agentSettings.customProviders[pid].binaryPath}
                            onChange={(e) =>
                              onUpdateCustomProvider(pid, { binaryPath: e.target.value })
                            }
                            placeholder={`Auto-detect ${pid === "antigravity" ? "agy" : pid}`}
                            className="w-full px-3 py-1.5 text-xs border border-border focus:outline-none focus:border-foreground font-mono bg-background"
                          />
                        </div>
                      ))}

                      <div className="pt-2 border-t border-border space-y-2">
                        <div className="text-xs font-mono uppercase text-foreground-secondary">
                          Custom ACP Agent (Optional)
                        </div>
                        <input
                          type="text"
                          value={agentSettings.customProviders["custom-acp"].customName}
                          onChange={(e) =>
                            onUpdateCustomProvider("custom-acp", { customName: e.target.value })
                          }
                          placeholder="Display name (e.g. Custom ACP Agent)"
                          aria-label="Custom ACP agent display name"
                          className="w-full px-3 py-1.5 text-xs border border-border focus:outline-none focus:border-foreground font-mono bg-background"
                        />
                        <input
                          type="text"
                          value={agentSettings.customProviders["custom-acp"].customCommand}
                          onChange={(e) =>
                            onUpdateCustomProvider("custom-acp", { customCommand: e.target.value })
                          }
                          placeholder="Command (e.g. /path/to/agent-acp)"
                          aria-label="Custom ACP agent command"
                          className="w-full px-3 py-1.5 text-xs border border-border focus:outline-none focus:border-foreground font-mono bg-background"
                        />
                        <input
                          type="text"
                          value={agentSettings.customProviders["custom-acp"].customArgs}
                          onChange={(e) =>
                            onUpdateCustomProvider("custom-acp", { customArgs: e.target.value })
                          }
                          placeholder="Arguments (e.g. --stdio)"
                          aria-label="Custom ACP agent arguments"
                          className="w-full px-3 py-1.5 text-xs border border-border focus:outline-none focus:border-foreground font-mono bg-background"
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </Tabs.Content>
          </Tabs.Root>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t border-border">
            {canResetActiveTab ? (
              <button
                type="button"
                onClick={
                  activeTab === "editor" ? handleResetEditorSettings : handleResetLatexSettings
                }
                className="text-xs text-muted hover:text-foreground transition-colors flex items-center gap-1.5 group"
              >
                <ArrowCounterClockwiseIcon className="size-3.5 group-hover:rotate-[-45deg] transition-transform" />
                Reset to Defaults
              </button>
            ) : (
              <div className="text-xs text-muted-foreground">
                Agent CLI settings auto-save locally.
              </div>
            )}
            <Dialog.Close className="btn btn-primary">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
