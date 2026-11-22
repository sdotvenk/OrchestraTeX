"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AgentProviderId,
  AgentSettings,
  InteractionMode,
  ProviderCustomConfig,
  ProviderCustomSettings,
  RuntimeMode,
} from "./types";

const AGENT_SETTINGS_KEY = "lmms-lab-writer:agent-settings:v1";

function createDefaultCustomProviders(): Record<AgentProviderId, ProviderCustomSettings> {
  return {
    claude: {
      binaryPath: "",
      customCommand: "",
      customArgs: "",
      customName: "",
    },
    codex: {
      binaryPath: "",
      customCommand: "",
      customArgs: "",
      customName: "",
    },
    antigravity: {
      binaryPath: "",
      customCommand: "",
      customArgs: "",
      customName: "",
    },
    "custom-acp": {
      binaryPath: "",
      customCommand: "",
      customArgs: "",
      customName: "Custom ACP Agent",
    },
  };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  defaultProvider: "claude",
  defaultModelByProvider: {},
  defaultEffortByProvider: {},
  defaultInteractionMode: "default",
  defaultRuntimeMode: "auto-accept-edits",
  customProviders: createDefaultCustomProviders(),
};

function parseCustomProviders(raw: unknown): Record<AgentProviderId, ProviderCustomSettings> {
  const defaults = createDefaultCustomProviders();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const rec = raw as Record<string, unknown>;
  const providerIds: AgentProviderId[] = ["claude", "codex", "antigravity", "custom-acp"];
  for (const id of providerIds) {
    const entry = rec[id];
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      defaults[id] = {
        binaryPath: typeof e.binaryPath === "string" ? e.binaryPath : defaults[id].binaryPath,
        customCommand:
          typeof e.customCommand === "string" ? e.customCommand : defaults[id].customCommand,
        customArgs: typeof e.customArgs === "string" ? e.customArgs : defaults[id].customArgs,
        customName: typeof e.customName === "string" ? e.customName : defaults[id].customName,
      };
    }
  }
  return defaults;
}

function isProviderId(value: unknown): value is AgentProviderId {
  return (
    value === "claude" || value === "codex" || value === "antigravity" || value === "custom-acp"
  );
}

function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "default" || value === "plan";
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "approval-required" || value === "auto-accept-edits" || value === "full-access";
}

function loadStoredAgentSettings(): AgentSettings {
  if (typeof window === "undefined") {
    return DEFAULT_AGENT_SETTINGS;
  }
  try {
    const stored = window.localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!stored) {
      return DEFAULT_AGENT_SETTINGS;
    }
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const modelMap: Partial<Record<AgentProviderId, string>> = {};
    if (parsed.defaultModelByProvider && typeof parsed.defaultModelByProvider === "object") {
      for (const [k, v] of Object.entries(
        parsed.defaultModelByProvider as Record<string, unknown>,
      )) {
        if (isProviderId(k) && typeof v === "string") {
          modelMap[k] = v;
        }
      }
    }
    const effortMap: Partial<Record<AgentProviderId, string>> = {};
    if (parsed.defaultEffortByProvider && typeof parsed.defaultEffortByProvider === "object") {
      for (const [k, v] of Object.entries(
        parsed.defaultEffortByProvider as Record<string, unknown>,
      )) {
        if (isProviderId(k) && typeof v === "string") {
          effortMap[k] = v;
        }
      }
    }

    return {
      defaultProvider: isProviderId(parsed.defaultProvider)
        ? parsed.defaultProvider
        : DEFAULT_AGENT_SETTINGS.defaultProvider,
      defaultModelByProvider: modelMap,
      defaultEffortByProvider: effortMap,
      defaultInteractionMode: isInteractionMode(parsed.defaultInteractionMode)
        ? parsed.defaultInteractionMode
        : DEFAULT_AGENT_SETTINGS.defaultInteractionMode,
      defaultRuntimeMode: isRuntimeMode(parsed.defaultRuntimeMode)
        ? parsed.defaultRuntimeMode
        : DEFAULT_AGENT_SETTINGS.defaultRuntimeMode,
      customProviders: parseCustomProviders(parsed.customProviders),
    };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function splitArgsString(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (!ch) continue;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export function buildProviderCustomConfigs(
  settings: Pick<AgentSettings, "customProviders">,
): ProviderCustomConfig[] {
  const ids: AgentProviderId[] = ["claude", "codex", "antigravity", "custom-acp"];
  return ids.map((providerId) => {
    const cfg = settings.customProviders[providerId];
    return {
      providerId,
      binaryPath: cfg.binaryPath.trim() || undefined,
      customCommand: cfg.customCommand.trim() || undefined,
      customArgs: cfg.customArgs.trim() ? splitArgsString(cfg.customArgs) : undefined,
      customName: cfg.customName.trim() || undefined,
    };
  });
}

export function useAgentSettings() {
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setSettings(loadStoredAgentSettings());
    setIsLoaded(true);
  }, []);

  const updateSettings = useCallback((updater: Partial<AgentSettings>) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        ...updater,
        defaultModelByProvider: updater.defaultModelByProvider ?? prev.defaultModelByProvider,
        defaultEffortByProvider: updater.defaultEffortByProvider ?? prev.defaultEffortByProvider,
        customProviders: updater.customProviders ?? prev.customProviders,
      };
      try {
        window.localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const setDefaultModel = useCallback((providerId: AgentProviderId, modelId: string) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        defaultModelByProvider: {
          ...prev.defaultModelByProvider,
          [providerId]: modelId,
        },
      };
      try {
        window.localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const setDefaultEffort = useCallback((providerId: AgentProviderId, effort: string) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        defaultEffortByProvider: {
          ...prev.defaultEffortByProvider,
          [providerId]: effort,
        },
      };
      try {
        window.localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const updateCustomProvider = useCallback(
    (providerId: AgentProviderId, patch: Partial<ProviderCustomSettings>) => {
      setSettings((prev) => {
        const next: AgentSettings = {
          ...prev,
          customProviders: {
            ...prev.customProviders,
            [providerId]: {
              ...prev.customProviders[providerId],
              ...patch,
            },
          },
        };
        try {
          window.localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage errors
        }
        return next;
      });
    },
    [],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_AGENT_SETTINGS);
    try {
      window.localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(DEFAULT_AGENT_SETTINGS));
    } catch {
      // Ignore storage errors
    }
  }, []);

  return {
    settings,
    isLoaded,
    updateSettings,
    setDefaultModel,
    setDefaultEffort,
    updateCustomProvider,
    resetSettings,
  };
}
