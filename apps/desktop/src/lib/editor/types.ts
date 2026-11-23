// Editor theme options - auto-follows app light/dark mode
export type EditorTheme = "one-light" | "one-dark";
export type TerminalShellMode = "auto" | "custom";
export type UiPalette = "atelier" | "conductor" | "monograph";

export const UI_PALETTES: readonly {
  id: UiPalette;
  label: string;
  description: string;
  swatches: readonly [string, string, string];
}[] = [
  {
    id: "atelier",
    label: "Atelier",
    description: "Warm cotton paper, Prussian ink, vermilion CTA",
    swatches: ["#F6F5F0", "#2C4F7C", "#D14E2A"],
  },
  {
    id: "conductor",
    label: "Conductor",
    description: "Cool alabaster, cobalt slate, warm brass CTA",
    swatches: ["#F3F5F8", "#3652B8", "#C48B28"],
  },
  {
    id: "monograph",
    label: "Monograph",
    description: "Warm linen, oxblood plum, deep teal CTA",
    swatches: ["#F7F4F0", "#6E3450", "#256B60"],
  },
] as const;

// Minimap configuration matching Monaco Editor API
export interface MinimapSettings {
  enabled: boolean;
  side: "left" | "right";
  showSlider: "always" | "mouseover";
  renderCharacters: boolean;
  size: "proportional" | "fill" | "fit";
  scale: number;
}

export interface EditorSettings {
  // Appearance
  uiPalette: UiPalette;

  // Keybindings
  vimMode: boolean;

  // Display
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  wordWrapColumn: number;

  // Editing
  tabSize: number;
  insertSpaces: boolean;
  autoClosingBrackets: "always" | "languageDefined" | "beforeWhitespace" | "never";
  autoClosingQuotes: "always" | "languageDefined" | "beforeWhitespace" | "never";

  // Features
  minimap: MinimapSettings;
  lineNumbers: "on" | "off" | "relative" | "interval";
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all";
  smoothScrolling: boolean;
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  cursorStyle: "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";

  // Formatting
  formatOnSave: boolean;
  formatOnPaste: boolean;

  // Git
  gitAutoFetchEnabled: boolean;
  gitAutoFetchIntervalSeconds: number;

  // Terminal
  terminalShellMode: TerminalShellMode;
  terminalShellPath: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
}

export const DEFAULT_MINIMAP_SETTINGS: MinimapSettings = {
  enabled: false,
  side: "right",
  showSlider: "mouseover",
  renderCharacters: false,
  size: "proportional",
  scale: 1,
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  uiPalette: "atelier",
  vimMode: false,

  // Display
  fontFamily: "",
  fontSize: 14,
  lineHeight: 1.6,
  wordWrap: "off",
  wordWrapColumn: 80,

  // Editing
  tabSize: 2,
  insertSpaces: true,
  autoClosingBrackets: "languageDefined",
  autoClosingQuotes: "languageDefined",

  // Features
  minimap: DEFAULT_MINIMAP_SETTINGS,
  lineNumbers: "on",
  renderWhitespace: "selection",
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorStyle: "line",

  // Formatting
  formatOnSave: false,
  formatOnPaste: false,

  // Git
  gitAutoFetchEnabled: true,
  gitAutoFetchIntervalSeconds: 120,

  // Terminal
  terminalShellMode: "auto",
  terminalShellPath: "",
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalLineHeight: 1.4,
};
