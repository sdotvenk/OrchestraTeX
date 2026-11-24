import type { AgentProviderId } from "@/lib/agent/types";

/** CSS token names shared by voice indicators across the workspace. */
export const VOICE_COLORS: Record<
  AgentProviderId | "you",
  { ink: string; tint: string; text: string }
> = {
  claude: {
    ink: "var(--voice-claude-ink)",
    tint: "var(--voice-claude-tint)",
    text: "var(--voice-claude-text)",
  },
  codex: {
    ink: "var(--voice-codex-ink)",
    tint: "var(--voice-codex-tint)",
    text: "var(--voice-codex-text)",
  },
  antigravity: {
    ink: "var(--voice-antigravity-ink)",
    tint: "var(--voice-antigravity-tint)",
    text: "var(--voice-antigravity-text)",
  },
  "custom-acp": {
    ink: "var(--voice-custom-ink)",
    tint: "var(--voice-custom-tint)",
    text: "var(--voice-custom-text)",
  },
  you: {
    ink: "var(--voice-you-ink)",
    tint: "var(--voice-you-tint)",
    text: "var(--voice-you-ink)",
  },
};
