import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { APPEARANCE_STORAGE_KEY, isNocturneAppearance } from "./appearance";
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_MINIMAP_SETTINGS,
  type EditorSettings,
  type EditorTheme,
} from "./types";

const STORAGE_KEY = "editor-settings";

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

// Migration helper for backward compatibility
function migrateSettings(parsed: Record<string, unknown>): EditorSettings {
  const settings = { ...DEFAULT_EDITOR_SETTINGS, ...parsed };

  // Remove retired appearance settings. The app theme is stored by next-themes.
  delete (settings as Record<string, unknown>).theme;
  delete (settings as Record<string, unknown>).uiPalette;

  // Migrate old boolean minimap format to new object format
  if (typeof parsed.minimap === "boolean") {
    settings.minimap = {
      ...DEFAULT_MINIMAP_SETTINGS,
      enabled: parsed.minimap,
    };
  } else if (parsed.minimap && typeof parsed.minimap === "object") {
    settings.minimap = { ...DEFAULT_MINIMAP_SETTINGS, ...parsed.minimap };
  }

  if (typeof parsed.gitAutoFetchIntervalSeconds === "number") {
    settings.gitAutoFetchIntervalSeconds = Math.min(
      3600,
      Math.max(15, Math.round(parsed.gitAutoFetchIntervalSeconds)),
    );
  }

  settings.fontFamily = sanitizeString(settings.fontFamily);
  settings.fontSize = clampInteger(settings.fontSize, DEFAULT_EDITOR_SETTINGS.fontSize, 8, 32);
  settings.lineHeight =
    Math.round(
      clampNumber(settings.lineHeight, DEFAULT_EDITOR_SETTINGS.lineHeight, 1.0, 3.0) * 10,
    ) / 10;

  if (settings.terminalShellMode !== "auto" && settings.terminalShellMode !== "custom") {
    settings.terminalShellMode = DEFAULT_EDITOR_SETTINGS.terminalShellMode;
  }

  settings.terminalShellPath = sanitizeString(
    settings.terminalShellPath,
    DEFAULT_EDITOR_SETTINGS.terminalShellPath,
  );
  settings.terminalFontFamily = sanitizeString(settings.terminalFontFamily);
  settings.terminalFontSize = clampInteger(
    settings.terminalFontSize,
    DEFAULT_EDITOR_SETTINGS.terminalFontSize,
    8,
    32,
  );
  settings.terminalLineHeight =
    Math.round(
      clampNumber(
        settings.terminalLineHeight,
        DEFAULT_EDITOR_SETTINGS.terminalLineHeight,
        1.0,
        3.0,
      ) * 10,
    ) / 10;

  return settings as EditorSettings;
}

export function useEditorSettings() {
  const { resolvedTheme, setTheme } = useTheme();

  const [settings, setSettings] = useState(DEFAULT_EDITOR_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    if (settingsLoaded) return;

    try {
      const appearance = localStorage.getItem(APPEARANCE_STORAGE_KEY);
      if (appearance === "light" || appearance === "dark") {
        setTheme(appearance === "light" ? "lux" : "nocturne");
      }

      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: Record<string, unknown> = JSON.parse(saved);
        // Legacy palettes defaulted to the light appearance.
        if (typeof parsed.uiPalette === "string" && appearance === null) {
          setTheme("lux");
        }
        setSettings(migrateSettings(parsed));
      }
    } catch {
      // Ignore parse errors
    }
    setSettingsLoaded(true);
  }, [settingsLoaded, setTheme]);

  // Derive editor theme from app theme
  const editorTheme: EditorTheme = isNocturneAppearance(resolvedTheme) ? "one-dark" : "one-light";

  // Persist settings to localStorage
  useEffect(() => {
    if (!settingsLoaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }, [settings, settingsLoaded]);

  const updateSettings = useCallback((updates: Partial<EditorSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_EDITOR_SETTINGS);
  }, []);

  return {
    settings,
    editorTheme,
    updateSettings,
    resetSettings,
  };
}
