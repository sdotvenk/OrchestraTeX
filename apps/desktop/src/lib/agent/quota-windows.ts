import type { RateLimitsSnapshot, RateLimitWindow } from "./types";

const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 7 * 24 * 60;

export interface QuotaWindowPair {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

function hasPercent(w: RateLimitWindow): boolean {
  return typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent);
}

/**
 * Picks the card's primary (5-hour) and secondary (weekly) windows. Providers that report
 * several buckets per cadence (Antigravity) show the most-used one; otherwise falls back
 * to the reported order, as Claude and Codex send it.
 */
export function pickQuotaWindows(
  rateLimits: RateLimitsSnapshot | null | undefined,
): QuotaWindowPair {
  const windows = (rateLimits?.windows ?? []).filter(hasPercent);
  const mostUsed = (mins: number) =>
    windows
      .filter((w) => w.windowDurationMins === mins)
      .reduce<RateLimitWindow | null>(
        (best, w) => (best && (best.usedPercent ?? 0) >= (w.usedPercent ?? 0) ? best : w),
        null,
      );
  const fiveHour = mostUsed(FIVE_HOUR_MINS);
  const weekly = mostUsed(WEEKLY_MINS);
  const rest = windows.filter((w) => w !== fiveHour && w !== weekly);
  const primary = fiveHour ?? weekly ?? rest[0] ?? null;
  const secondary = fiveHour
    ? (weekly ?? rest[0] ?? null)
    : weekly
      ? (rest[0] ?? null)
      : (rest[1] ?? null);
  return { primary, secondary };
}
