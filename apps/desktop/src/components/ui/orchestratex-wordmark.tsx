export function OrchestraTeXWordmark({ prominent = false }: { prominent?: boolean }) {
  return (
    <span
      className={`inline-flex items-center font-display leading-none text-foreground ${prominent ? "gap-4 text-5xl tracking-[-0.02em]" : "gap-[7px] text-[19px] tracking-[-0.01em]"}`}
    >
      <svg
        aria-hidden="true"
        className="shrink-0"
        width={prominent ? 62 : 20}
        height={prominent ? 48 : 16}
        viewBox="0 0 20 16"
        fill="none"
      >
        <path
          d="M0 3h20M0 6.5h20M0 10h20M0 13.5h20"
          stroke="currentColor"
          strokeWidth={prominent ? 1 : 1.3}
        />
        <path
          d="M6 1l8 14"
          stroke="var(--primary-offset)"
          strokeWidth={prominent ? 2.2 : 2.4}
          strokeLinecap="round"
        />
      </svg>
      OrchestraTeX
    </span>
  );
}
