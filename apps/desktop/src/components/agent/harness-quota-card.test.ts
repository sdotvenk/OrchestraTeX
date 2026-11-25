import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pickQuotaWindows } from "@/lib/agent/quota-windows";
import type { ProviderStatus, RateLimitsSnapshot } from "@/lib/agent/types";
import { HarnessQuotaCard } from "./harness-quota-card";

const HOUR = 3_600_000;

function antigravitySnapshot(now: number): RateLimitsSnapshot {
  return {
    providerId: "antigravity",
    updatedAt: now,
    planType: null,
    creditsBalance: null,
    note: null,
    windows: [
      {
        id: "3p-shared-5h",
        label: "Claude & GPT (shared) · 5-hour window",
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: null,
      },
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly limit",
        usedPercent: 62,
        windowDurationMins: 10080,
        resetsAt: now + 50 * HOUR,
      },
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour window",
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: now + 2 * HOUR,
      },
    ],
  };
}

function provider(rateLimits: RateLimitsSnapshot): ProviderStatus {
  return {
    id: "antigravity",
    name: "Antigravity",
    transport: "acp",
    installed: true,
    binaryPath: null,
    version: null,
    authenticated: true,
    authError: null,
    loginCommand: "",
    account: null,
    models: [],
    commands: [],
    rateLimits,
    supportsSteer: false,
    supportsFork: false,
    supportsCompact: false,
    supportsQuestions: false,
  };
}

describe("pickQuotaWindows", () => {
  it("prefers the most-used 5-hour window, then the most-used weekly window", () => {
    const { primary, secondary } = pickQuotaWindows(antigravitySnapshot(Date.now()));
    expect(primary?.id).toBe("gemini-5h");
    expect(secondary?.id).toBe("gemini-weekly");
  });

  it("falls back to reported order when windows have no known cadence", () => {
    const { primary, secondary } = pickQuotaWindows({
      ...antigravitySnapshot(0),
      windows: [
        { id: "a", label: "Gemini · Reported quota", usedPercent: 5 },
        { id: "b", label: "Claude · Reported quota", usedPercent: 9 },
      ],
    });
    expect(primary?.id).toBe("a");
    expect(secondary?.id).toBe("b");
  });

  it("treats a snapshot without percentages as unknown", () => {
    expect(pickQuotaWindows({ ...antigravitySnapshot(0), windows: [] }).primary).toBeNull();
  });
});

describe("HarnessQuotaCard", () => {
  it("renders Antigravity 5-hour and weekly windows like Claude and Codex", () => {
    const html = renderToStaticMarkup(
      createElement(HarnessQuotaCard, {
        providerId: "antigravity",
        provider: provider(antigravitySnapshot(Date.now())),
      }),
    );
    expect(html).toContain("40%");
    expect(html).toContain("of Gemini · 5-hour window");
    expect(html).toContain("Gemini · Weekly limit 62%");
    expect(html).toMatch(/\d+h/);
    expect(html).not.toMatch(/daily quota/i);
  });

  it("shows unknown quota with the reason instead of 0%", () => {
    const html = renderToStaticMarkup(
      createElement(HarnessQuotaCard, {
        providerId: "antigravity",
        provider: provider({
          ...antigravitySnapshot(Date.now()),
          windows: [],
          note: "Quota unknown: HTTP 500",
        }),
      }),
    );
    expect(html).toContain("quota not reported");
    expect(html).toContain("Quota unknown: HTTP 500");
    expect(html).not.toContain("0%");
  });
});
