import { LockSimpleIcon } from "@phosphor-icons/react";
import type { ScoreLane, ScoreMark } from "@/lib/agent/score";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";

function MarkGlyph({ kind, color }: { kind: ScoreMark["kind"]; color: string }) {
  if (kind === "read") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="8"
          height="8"
          fill="var(--panel)"
          stroke={color}
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (kind === "compile") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M5 0.5L9.5 5 5 9.5 0.5 5z" fill={color} />
      </svg>
    );
  }
  if (kind === "wait") {
    return <LockSimpleIcon aria-hidden="true" className="size-3" />;
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill={color} />
    </svg>
  );
}

const PROVIDER_DISPLAY: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  "custom-acp": "Custom ACP",
  you: "",
};

export function ScoreDrawer({
  lanes,
  start,
  end,
  onMark,
  pendingApprovals,
}: {
  lanes: ScoreLane[];
  start: number;
  end: number;
  onMark: (mark: ScoreMark) => void;
  pendingApprovals?: Record<string, { label: string; onAllow: () => void }>;
}) {
  const span = Math.max(1, end - start);

  return (
    <section aria-label="Score" className="relative overflow-auto text-xs py-1.5 pr-3">
      <div className="flex min-w-[400px] items-center h-4">
        <span className="w-[200px] shrink-0" />
        <div className="flex flex-1 justify-between font-mono text-[10px] text-muted pr-1">
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) =>
            fraction === 1 ? (
              <span key={fraction} className="text-foreground-strong font-medium whitespace-nowrap">
                now
              </span>
            ) : (
              <span key={fraction} className="whitespace-nowrap tabular-nums">
                {new Date(start + span * fraction).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="relative">
        <div
          className="pointer-events-none absolute right-1 top-0 bottom-0 w-[1.5px] bg-foreground/30"
          aria-hidden="true"
        />
        {lanes.map((lane) => {
          const voice = VOICE_COLORS[lane.provider] ?? VOICE_COLORS["custom-acp"];
          const positions = lane.marks.map((m) =>
            Math.max(0, Math.min(100, ((m.at - start) / span) * 100)),
          );
          const minPos = positions.length > 0 ? Math.min(...positions) : 0;
          const maxPos = positions.length > 0 ? Math.max(...positions) : 0;
          const approval = pendingApprovals?.[lane.id];

          return (
            <div key={lane.id} className="flex min-w-[400px] items-center h-[26px]">
              <div className="flex w-[200px] shrink-0 items-center gap-[7px] pl-3 pr-2 text-[12px]">
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ backgroundColor: voice.ink }}
                  aria-hidden="true"
                />
                <span className="truncate font-medium text-foreground-strong">{lane.title}</span>
                {PROVIDER_DISPLAY[lane.provider] && (
                  <span className="shrink-0 text-[11px] text-muted">
                    {PROVIDER_DISPLAY[lane.provider]}
                  </span>
                )}
              </div>
              <div className="relative h-[26px] flex-1">
                <div
                  className="pointer-events-none absolute inset-x-0 top-[13px] h-px bg-border/60"
                  aria-hidden="true"
                />
                {positions.length > 1 && (
                  <div
                    className="absolute top-[12px] h-[2px]"
                    style={{
                      left: `${minPos}%`,
                      width: `${Math.max(0, maxPos - minPos)}%`,
                      backgroundColor: voice.tint,
                    }}
                    aria-hidden="true"
                  />
                )}
                {lane.marks.map((mark) => {
                  const color =
                    mark.waitState === "waiting"
                      ? "var(--warn)"
                      : mark.waitState === "approved"
                        ? "var(--ok)"
                        : mark.kind === "wait"
                          ? "var(--muted)"
                          : voice.ink;
                  return (
                    <button
                      type="button"
                      key={mark.id}
                      onClick={() => onMark(mark)}
                      aria-label={`${mark.kind}${mark.waitState ? `, ${mark.waitState}` : ""}${mark.filePath ? `, ${mark.filePath}` : ""}, ${new Date(mark.at).toLocaleTimeString()}`}
                      title={`${mark.kind}${mark.filePath ? `: ${mark.filePath}` : ""}`}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-0.5 hover:scale-125 transition-transform"
                      style={{
                        left: `${Math.max(0, Math.min(100, ((mark.at - start) / span) * 100))}%`,
                        color,
                      }}
                    >
                      <MarkGlyph kind={mark.kind} color={color} />
                    </button>
                  );
                })}
                {approval && (
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 rounded-full bg-warn-bg border border-[var(--warn-line)] text-warn pl-2 pr-1 py-0.5 text-[11px] whitespace-nowrap">
                    <span>{approval.label}</span>
                    <button
                      type="button"
                      onClick={approval.onAllow}
                      className="bg-primary text-primary-text rounded-full px-2 py-0.5 font-semibold text-[10.5px]"
                    >
                      Allow
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
