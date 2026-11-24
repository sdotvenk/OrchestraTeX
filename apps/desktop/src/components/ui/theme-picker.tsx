"use client";

import { CheckIcon, SwatchesIcon } from "@phosphor-icons/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useId, useRef } from "react";

const THEMES = [
  { value: "lux", label: "Lux" },
  { value: "nocturne", label: "Nocturne" },
  { value: "system", label: "Auto" },
] as const;

function ThemePreview({ dark }: { dark: boolean }) {
  return (
    <span
      className={`flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden bg-[var(--bg)] p-1.5 ${dark ? "theme-preview-nocturne" : "theme-preview-lux"}`}
    >
      <span className="flex items-center justify-between">
        <span className="h-1 w-1/3 rounded-full bg-[var(--text)] opacity-65" />
        <span className="h-1 w-1/6 rounded-full bg-[var(--primary-offset)]" />
      </span>
      <span className="grid min-h-0 flex-1 grid-cols-[1fr_2fr] gap-1">
        <span className="flex flex-col gap-1 rounded-sm border border-[var(--line)] bg-[var(--panel)] p-1">
          <span className="h-0.5 rounded-full bg-[var(--muted)] opacity-40" />
          <span className="h-0.5 w-2/3 rounded-full bg-[var(--muted)] opacity-40" />
        </span>
        <span className="flex flex-col gap-1 rounded-sm border border-[var(--line)] bg-[var(--panel)] p-1">
          <span className="h-0.5 w-2/3 rounded-full bg-[var(--text)] opacity-70" />
          <span className="h-0.5 rounded-full bg-[var(--muted)] opacity-40" />
          <span className="h-0.5 w-4/5 rounded-full bg-[var(--muted)] opacity-40" />
        </span>
      </span>
    </span>
  );
}

export function ThemePicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const selected = THEMES.find((option) => option.value === theme) ?? THEMES[2];
  const dismissAndFocus = useCallback(() => {
    onOpenChange(false);
    triggerRef.current?.focus();
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    containerRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.focus({ preventScroll: true });

    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        onOpenChange(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissAndFocus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, onOpenChange, dismissAndFocus]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="Choose theme"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title="Choose theme"
        className={`inline-flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-accent ${open ? "bg-accent-soft text-accent" : "text-muted hover:bg-subtle hover:text-foreground"}`}
      >
        <SwatchesIcon className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <section
          id={popoverId}
          aria-label="Theme"
          className="absolute right-0 top-full z-50 mt-1.5 grid w-[min(22rem,calc(100vw-1rem))] grid-cols-3 gap-2 rounded-xl border border-border bg-panel p-2 shadow-[var(--shadow-2)]"
        >
          {THEMES.map(({ value, label }) => {
            const active = value === selected.value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setTheme(value);
                  dismissAndFocus();
                }}
                className={`min-w-0 rounded-lg border p-1.5 text-left text-[12px] font-medium text-foreground focus-visible:outline-2 focus-visible:outline-accent ${active ? "border-accent bg-accent-soft" : "border-border hover:bg-subtle"}`}
              >
                <span
                  aria-hidden="true"
                  className="flex h-14 overflow-hidden rounded-md border border-border"
                >
                  {value !== "nocturne" && <ThemePreview dark={false} />}
                  {value !== "lux" && <ThemePreview dark />}
                </span>
                <span className="flex items-center justify-between gap-1 px-0.5 pt-1.5">
                  {label}
                  {active && <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </section>
      )}
    </div>
  );
}
