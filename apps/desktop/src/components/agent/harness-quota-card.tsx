import { pickQuotaWindows } from "@/lib/agent/quota-windows";
import type { AgentProviderId, ProviderStatus } from "@/lib/agent/types";
import { VOICE_TOKENS } from "@/lib/agent/usage-dashboard";
import { ProviderIcon } from "./icons";
import { formatResetCountdown } from "./utils";

export function HarnessQuotaCard({
  providerId: id,
  provider,
}: {
  providerId: AgentProviderId;
  provider: ProviderStatus | null | undefined;
}) {
  const voice = VOICE_TOKENS[id];
  const { primary: primaryWindow, secondary: secondaryWindow } = pickQuotaWindows(
    provider?.rateLimits,
  );
  const usedPct = primaryWindow?.usedPercent;
  const hasQuota = usedPct !== null && usedPct !== undefined;
  const isInstalled = Boolean(provider?.installed);
  const resetText = formatResetCountdown(primaryWindow?.resetsAt);
  const hasSecondary =
    secondaryWindow?.usedPercent !== null && secondaryWindow?.usedPercent !== undefined;
  const footerText = hasQuota
    ? (resetText ?? primaryWindow?.status ?? "Active")
    : isInstalled
      ? (provider?.rateLimits?.note ?? "Token counts only")
      : "Configure in Settings → Agents";

  return (
    <div
      className="ox-frame p-3.5 flex flex-col"
      style={{ borderTopWidth: "3px", borderTopColor: voice.ink }}
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span style={{ color: voice.ink }} className="inline-flex shrink-0">
          <ProviderIcon providerId={id} className="size-3.5 shrink-0" />
        </span>
        <span className="truncate">{provider?.name || voice.label}</span>
        <span className="ml-auto text-[11.5px] font-normal text-muted truncate">
          {provider?.account?.planType ??
            provider?.rateLimits?.planType ??
            (isInstalled ? (provider?.transport ?? "ACP") : null)}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span
          className={`text-[28px] leading-none font-semibold tracking-tight tabular-nums ${
            hasQuota ? "text-foreground" : "text-muted"
          }`}
        >
          {hasQuota ? `${Math.round(usedPct)}%` : "—"}
        </span>
        <span className="text-[12px] text-muted truncate">
          {hasQuota
            ? `of ${primaryWindow?.label ?? "5-hour window"}`
            : isInstalled
              ? "quota not reported"
              : "not configured"}
        </span>
      </div>

      <div
        className="mt-2 h-2 rounded-[4px] bg-sunken overflow-hidden relative"
        style={
          !hasQuota
            ? {
                backgroundImage:
                  "repeating-linear-gradient(135deg, var(--hatch-a) 0 4px, var(--hatch-b) 4px 8px)",
              }
            : undefined
        }
      >
        {hasQuota && (
          <span
            className="absolute inset-y-0 left-0 rounded-[4px]"
            style={{
              width: `${Math.min(100, Math.max(0, usedPct))}%`,
              backgroundColor: voice.ink,
            }}
          />
        )}
      </div>

      <div className="mt-2 flex items-center text-[11.5px] text-muted gap-2">
        <span
          className={hasSecondary ? "truncate shrink-0 max-w-[50%]" : "truncate min-w-0"}
          title={footerText}
        >
          {footerText}
        </span>
        {hasSecondary && secondaryWindow?.usedPercent != null && (
          <span
            className="ml-auto flex min-w-0 items-baseline gap-1"
            title={`${secondaryWindow.label} ${Math.round(secondaryWindow.usedPercent)}%`}
          >
            <span className="truncate">{secondaryWindow.label}</span>
            <span className="font-mono tabular-nums shrink-0">
              {Math.round(secondaryWindow.usedPercent)}%
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
