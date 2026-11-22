import { Cpu, Plugs, Sparkle, TerminalWindow } from "@phosphor-icons/react";
import type { AgentProviderId } from "@/lib/agent/types";

export function ProviderIcon({
  providerId,
  className = "size-3.5",
}: {
  providerId: AgentProviderId;
  className?: string;
}) {
  switch (providerId) {
    case "claude":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
          <path
            d="M8 1.5L9.7 5.8L14 4.5L11.1 8L14 11.5L9.7 10.2L8 14.5L6.3 10.2L2 11.5L4.9 8L2 4.5L6.3 5.8L8 1.5Z"
            fill="currentColor"
          />
        </svg>
      );
    case "codex":
      return <TerminalWindow className={className} weight="duotone" aria-hidden="true" />;
    case "antigravity":
      return <Sparkle className={className} weight="fill" aria-hidden="true" />;
    case "custom-acp":
      return <Plugs className={className} weight="regular" aria-hidden="true" />;
    default:
      return <Cpu className={className} weight="regular" aria-hidden="true" />;
  }
}

export function ProviderBadge({
  providerId,
  label,
}: {
  providerId: AgentProviderId;
  label?: string;
}) {
  const defaultLabel =
    providerId === "claude"
      ? "Claude"
      : providerId === "codex"
        ? "Codex"
        : providerId === "antigravity"
          ? "Antigravity"
          : "ACP";

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider border border-border bg-surface-secondary text-foreground">
      <ProviderIcon providerId={providerId} className="size-3 text-accent" />
      <span>{label || defaultLabel}</span>
    </span>
  );
}
