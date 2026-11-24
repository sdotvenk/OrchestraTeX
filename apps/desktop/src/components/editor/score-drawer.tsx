import { LockSimpleIcon } from "@phosphor-icons/react";
import type { ScoreLane, ScoreMark } from "@/lib/agent/score";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";

const shapes = {
  read: "□",
  edit: "●",
  compile: "◆",
  wait: <LockSimpleIcon aria-hidden="true" className="size-3" />,
};

export function ScoreDrawer({
  lanes,
  start,
  end,
  onMark,
}: {
  lanes: ScoreLane[];
  start: number;
  end: number;
  onMark: (mark: ScoreMark) => void;
}) {
  return (
    <section aria-label="Score" className="overflow-auto text-xs">
      <div className="flex flex-wrap gap-3 px-3 py-2">
        {Object.entries(shapes).map(([kind, shape]) => (
          <span key={kind} className="flex items-center gap-1">
            {shape} {kind}
          </span>
        ))}
      </div>
      <div className="flex min-w-[400px] px-3">
        <span className="w-40 shrink-0" />
        <div className="flex flex-1 justify-between">
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) => (
            <span key={fraction}>
              {new Date(start + (end - start) * fraction).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div key={lane.id} className="flex min-w-[400px] items-center px-3">
          <span className="flex w-40 shrink-0 items-center gap-2 pr-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: VOICE_COLORS[lane.provider].ink }}
              aria-hidden="true"
            />
            <span className="truncate">{lane.title}</span>
          </span>
          <div className="relative h-8 flex-1 border-b border-border">
            {lane.marks.map((mark) => (
              <button
                type="button"
                key={mark.id}
                onClick={() => onMark(mark)}
                aria-label={`${mark.kind}${mark.waitState ? `, ${mark.waitState}` : ""}${mark.filePath ? `, ${mark.filePath}` : ""}, ${new Date(mark.at).toLocaleTimeString()}`}
                title={`${mark.kind}${mark.filePath ? `: ${mark.filePath}` : ""}`}
                className="absolute top-0 -translate-x-1/2 p-1"
                style={{
                  left: `${Math.max(0, Math.min(100, ((mark.at - start) / Math.max(1, end - start)) * 100))}%`,
                  color:
                    mark.waitState === "waiting"
                      ? "var(--warn)"
                      : mark.waitState === "approved"
                        ? "var(--ok)"
                        : mark.kind === "wait"
                          ? "var(--muted)"
                          : VOICE_COLORS[lane.provider].ink,
                }}
              >
                {shapes[mark.kind]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
