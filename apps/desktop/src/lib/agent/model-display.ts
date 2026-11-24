import type { AgentProviderId } from "./types";

const PROVIDER_DISPLAY_NAMES: Record<AgentProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  "custom-acp": "Custom ACP",
};

/**
 * Return the human-readable harness display name for a provider ID.
 */
export function formatProviderDisplayName(
  providerId: AgentProviderId | string | null | undefined,
): string {
  if (!providerId) return "Assistant";
  if (providerId in PROVIDER_DISPLAY_NAMES) {
    return PROVIDER_DISPLAY_NAMES[providerId as AgentProviderId];
  }
  return providerId;
}

function capitalizeWord(word: string): string {
  if (!word) return word;
  if (/^\d+(?:\.\d+)?$/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function titleCaseHyphenated(raw: string): string {
  return raw.split("-").filter(Boolean).map(capitalizeWord).join(" ");
}

/**
 * Format a raw model ID (e.g. `claude-opus-4-6-20260514`, `gpt-5.4`, `gemini-3.1-pro`)
 * into a clean human-readable display name, preferring any matching `models` entry name.
 */
export function formatModelDisplayName(
  modelId: string | null | undefined,
  models?: Array<{ id: string; name?: string | null }>,
): string {
  const raw = modelId?.trim();
  if (!raw) return "";

  const matched = models?.find((m) => m.id === raw);
  if (matched?.name?.trim()) {
    return matched.name.trim();
  }

  // Strip trailing dated / variant suffixes
  const cleaned = raw.replace(/(?:-\d{8}|-extended-thinking|-latest)+$/i, "");

  // Claude: claude-opus-4-6 -> Claude Opus 4.6
  const claudeFamilyFirst = /^claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)(?:-(.+))?$/i.exec(cleaned);
  if (claudeFamilyFirst) {
    const family = capitalizeWord((claudeFamilyFirst[1] ?? "").toLowerCase());
    const major = claudeFamilyFirst[2] ?? "";
    const minor = claudeFamilyFirst[3] ?? "";
    return `Claude ${family} ${major}.${minor}`;
  }

  const claudeVersionFirst = /^claude-(\d+)[.-](\d+)-(opus|sonnet|haiku)(?:-(.+))?$/i.exec(cleaned);
  if (claudeVersionFirst) {
    const major = claudeVersionFirst[1] ?? "";
    const minor = claudeVersionFirst[2] ?? "";
    const family = capitalizeWord((claudeVersionFirst[3] ?? "").toLowerCase());
    return `Claude ${family} ${major}.${minor}`;
  }

  // GPT: gpt-5.4 -> GPT-5.4, gpt-5.4-codex -> GPT-5.4 Codex
  const gptMatch = /^gpt-([0-9a-z.]+)(?:-(.+))?$/i.exec(cleaned);
  if (gptMatch) {
    const version = gptMatch[1] ?? "";
    const suffix = gptMatch[2] ? ` ${titleCaseHyphenated(gptMatch[2])}` : "";
    return `GPT-${version}${suffix}`;
  }

  // OpenAI o-series: o3-mini -> o3 Mini
  const oSeriesMatch = /^o(\d+)(?:-(.+))?$/i.exec(cleaned);
  if (oSeriesMatch) {
    const num = oSeriesMatch[1] ?? "";
    const suffix = oSeriesMatch[2] ? ` ${titleCaseHyphenated(oSeriesMatch[2])}` : "";
    return `o${num}${suffix}`;
  }

  // Gemini: gemini-3.1-pro -> Gemini 3.1 Pro
  const geminiMatch = /^gemini-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(cleaned);
  if (geminiMatch) {
    const version = geminiMatch[1] ?? "";
    const suffix = geminiMatch[2] ? ` ${titleCaseHyphenated(geminiMatch[2])}` : "";
    return `Gemini ${version}${suffix}`;
  }

  return cleaned.split(/[-_]+/).filter(Boolean).map(capitalizeWord).join(" ");
}
