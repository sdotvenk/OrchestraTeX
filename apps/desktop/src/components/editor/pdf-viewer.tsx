"use client";

import { Crosshair, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export interface PdfHighlightTarget {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  nonce: number;
}

type Props = {
  src?: string;
  pdfData?: Uint8Array | null;
  refreshKey?: number;
  onSynctexClick?: (page: number, x: number, y: number) => void;
  highlightTarget?: PdfHighlightTarget | null;
  compactToolbar?: boolean;
};

export const PdfViewer = memo(function PdfViewer({
  src,
  pdfData,
  refreshKey = 0,
  onSynctexClick,
  highlightTarget,
  compactToolbar = false,
}: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const currentPageRef = useRef(1);
  currentPageRef.current = currentPage;
  const [pageInput, setPageInput] = useState<string>("1");
  const [scale, setScale] = useState<number>(1.0);
  const [fitMode, setFitMode] = useState<"custom" | "width" | "page">("width");
  const [pageBaseSize, setPageBaseSize] = useState<{ width: number; height: number }>({
    width: 612,
    height: 792,
  });
  const [activeHighlight, setActiveHighlight] = useState<PdfHighlightTarget | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const fitOptionsRef = useRef<HTMLDetailsElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const preservedScrollTopRef = useRef<number | null>(null);
  const hasAutoFittedRef = useRef(false);

  useEffect(() => {
    const dismissFitOptions = (event: PointerEvent) => {
      const options = fitOptionsRef.current;
      if (options?.open && event.target instanceof Node && !options.contains(event.target)) {
        options.open = false;
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      const options = fitOptionsRef.current;
      if (event.key !== "Escape" || !options?.open) return;
      event.preventDefault();
      options.open = false;
      options.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismissFitOptions);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissFitOptions);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  // Clone Uint8Array so pdf.js worker transfer cannot detach caller state
  const documentFile = useMemo(() => {
    if (pdfData && pdfData.byteLength > 0) {
      return { data: new Uint8Array(pdfData) };
    }
    if (!src) return null;
    if (refreshKey > 0) {
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}_r=${refreshKey}`;
    }
    return src;
  }, [pdfData, refreshKey, src]);

  function onDocumentLoadSuccess({ numPages: total }: { numPages: number }) {
    setNumPages(total);
    setCurrentPage((prev) => Math.min(Math.max(1, prev), Math.max(1, total)));
    if (preservedScrollTopRef.current !== null && containerRef.current) {
      const targetScroll = preservedScrollTopRef.current;
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = targetScroll;
        }
      });
    }
  }

  const computeFitScale = useCallback(
    (mode: "width" | "page", dims = pageBaseSize) => {
      const el = containerRef.current;
      if (!el) return;
      const availW = Math.max(180, el.clientWidth - 32);
      const availH = Math.max(180, el.clientHeight - 32);
      const widthScale = availW / Math.max(1, dims.width);
      const next =
        mode === "width" ? widthScale : Math.min(widthScale, availH / Math.max(1, dims.height));
      const clamped = Math.max(0.25, Math.min(4.0, Number(next.toFixed(3))));
      setScale(clamped);
    },
    [pageBaseSize],
  );

  // Recompute fit scale on resize when in fit-width / fit-page mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!hasAutoFittedRef.current && fitMode === "width") {
      hasAutoFittedRef.current = true;
      computeFitScale("width");
    }
    const observer = new ResizeObserver(() => {
      if (fitMode === "width" || fitMode === "page") {
        computeFitScale(fitMode);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [computeFitScale, fitMode]);

  // Track currently visible page using IntersectionObserver
  useEffect(() => {
    const root = containerRef.current;
    if (!root || numPages === 0) return;

    const visibility = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageAttr = entry.target.getAttribute("data-page-number");
          if (!pageAttr) continue;
          const pg = Number.parseInt(pageAttr, 10);
          if (!Number.isFinite(pg)) continue;
          visibility.set(pg, entry.intersectionRatio);
        }
        let bestPage = currentPageRef.current;
        let bestRatio = -1;
        for (const [pg, ratio] of visibility.entries()) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = pg;
          }
        }
        if (bestRatio > 0 && bestPage !== currentPageRef.current) {
          currentPageRef.current = bestPage;
          setCurrentPage(bestPage);
          setPageInput(String(bestPage));
        }
      },
      { root, threshold: [0.1, 0.35, 0.65, 0.9] },
    );

    for (const el of pageRefs.current.values()) {
      io.observe(el);
    }
    return () => io.disconnect();
  }, [numPages]);

  // Forward SyncTeX highlight + scroll
  useEffect(() => {
    if (!highlightTarget) return;
    setActiveHighlight(highlightTarget);

    const targetPageEl = pageRefs.current.get(highlightTarget.page);
    if (targetPageEl && containerRef.current) {
      const container = containerRef.current;
      const topInContainer =
        targetPageEl.offsetTop +
        Math.max(0, highlightTarget.y * scale - container.clientHeight * 0.35);
      container.scrollTo({
        top: Math.max(0, topInContainer),
        behavior: "smooth",
      });
    }

    const timer = setTimeout(() => {
      setActiveHighlight((cur) => (cur?.nonce === highlightTarget.nonce ? null : cur));
    }, 2200);
    return () => clearTimeout(timer);
  }, [highlightTarget, scale]);

  const triggerInverseSync = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, pageNumber: number) => {
      if (!onSynctexClick) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // SyncTeX uses a top-left origin in 72 DPI big points (x right, y down)
      const xPdf = offsetX / scale;
      const yPdf = offsetY / scale;
      onSynctexClick(pageNumber, xPdf, yPdf);
    },
    [onSynctexClick, scale],
  );

  const jumpToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(Math.max(1, numPages), page));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      const el = pageRefs.current.get(clamped);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [numPages],
  );

  const zoomIn = useCallback(() => {
    setFitMode("custom");
    setScale((s) => Math.min(Number((s + 0.2).toFixed(2)), 4.0));
  }, []);

  const zoomOut = useCallback(() => {
    setFitMode("custom");
    setScale((s) => Math.max(Number((s - 0.2).toFixed(2)), 0.25));
  }, []);

  const pageNumbers = useMemo(() => Array.from({ length: numPages }, (_, i) => i + 1), [numPages]);

  if (!documentFile) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs font-mono text-muted p-4">
        No PDF available
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-surface-secondary shrink-0 gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted">
          {numPages > 0 ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = Number.parseInt(pageInput, 10);
                if (Number.isFinite(parsed)) {
                  jumpToPage(parsed);
                } else {
                  setPageInput(String(currentPage));
                }
              }}
              className="flex items-center gap-1"
            >
              <input
                type="text"
                inputMode="numeric"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                aria-label="Current PDF page"
                className="w-8 px-1 py-0.5 text-center border border-border bg-background text-foreground text-[11px] font-mono focus:outline-none focus:border-foreground"
              />
              <span>/ {numPages}</span>
            </form>
          ) : (
            <span>Loading...</span>
          )}
          {!compactToolbar && onSynctexClick && (
            <span className="hidden lg:inline text-[10px] text-muted border-l border-border pl-2">
              Double-click or Cmd/Ctrl+Click to jump to source
            </span>
          )}
        </div>

        <details
          ref={fitOptionsRef}
          className="relative"
          onBlur={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
              event.currentTarget.open = false;
            }
          }}
        >
          <summary className="cursor-pointer list-none rounded px-2 py-1 text-[12px] text-foreground hover:bg-subtle focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            {fitMode === "width"
              ? "Fit width"
              : fitMode === "page"
                ? "Fit page"
                : `${Math.round(scale * 100)}%`}
          </summary>
          <div className="absolute right-0 top-full z-50 flex flex-col gap-1 rounded-lg border border-border bg-panel p-1.5 shadow-[var(--shadow-2)]">
            <div className="flex gap-1 whitespace-nowrap">
              {(["width", "page"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={fitMode === mode}
                  className={`btn btn-sm ${fitMode === mode ? "btn-secondary" : "btn-ghost"}`}
                  onClick={() => {
                    setFitMode(mode);
                    computeFitScale(mode);
                    const options = fitOptionsRef.current;
                    if (options) {
                      options.open = false;
                      options.querySelector("summary")?.focus();
                    }
                  }}
                >
                  {mode === "width" ? "Fit width" : "Fit page"}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={zoomOut}
                className="btn btn-ghost btn-sm"
                title="Zoom out"
                aria-label="Zoom out"
              >
                <MagnifyingGlassMinus className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setFitMode("custom");
                  setScale(1.0);
                }}
                className="btn btn-ghost btn-sm font-mono tabular-nums"
                title="Reset zoom to 100%"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                className="btn btn-ghost btn-sm"
                title="Zoom in"
                aria-label="Zoom in"
              >
                <MagnifyingGlassPlus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </details>
      </div>

      <div
        ref={containerRef}
        onScroll={() => {
          if (containerRef.current) {
            preservedScrollTopRef.current = containerRef.current.scrollTop;
          }
        }}
        className="flex-1 overflow-auto bg-surface-tertiary/40 p-4"
      >
        <div className="flex flex-col items-center">
          <Document
            file={documentFile}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex items-center justify-center h-32 text-xs font-mono text-muted">
                Rendering PDF...
              </div>
            }
            error={
              <div className="flex items-center justify-center h-32 text-xs font-mono text-error">
                Failed to load PDF document.
              </div>
            }
          >
            {pageNumbers.map((pageNumber) => {
              const showHighlight = activeHighlight && activeHighlight.page === pageNumber;
              return (
                <div
                  key={`pdf-page-${pageNumber}`}
                  ref={(el) => {
                    if (el) pageRefs.current.set(pageNumber, el);
                    else pageRefs.current.delete(pageNumber);
                  }}
                  role="document"
                  data-page-number={pageNumber}
                  onDoubleClick={(e) => triggerInverseSync(e, pageNumber)}
                  onMouseUp={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      e.preventDefault();
                      triggerInverseSync(e, pageNumber);
                    }
                  }}
                  className="mb-4 relative bg-white shadow-sm border border-border/60"
                >
                  <Page
                    pageNumber={pageNumber}
                    scale={scale}
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                    onLoadSuccess={(page) => {
                      if (pageNumber === 1) {
                        const dims = {
                          width: page.originalWidth || 612,
                          height: page.originalHeight || 792,
                        };
                        setPageBaseSize(dims);
                        if (fitMode === "width" || fitMode === "page") {
                          computeFitScale(fitMode, dims);
                        }
                      }
                    }}
                  />

                  {showHighlight && (
                    <div
                      className="pointer-events-none absolute border-2 border-foreground bg-accent-dark/30 animate-pulse z-10"
                      style={{
                        left: `${Math.max(0, activeHighlight.x * scale - 4)}px`,
                        top: `${Math.max(0, (activeHighlight.y - activeHighlight.height) * scale - 2)}px`,
                        width: `${Math.max(48, activeHighlight.width * scale + 8)}px`,
                        height: `${Math.max(16, activeHighlight.height * scale + 6)}px`,
                      }}
                    >
                      <Crosshair className="size-3 text-foreground" aria-hidden="true" />
                    </div>
                  )}
                </div>
              );
            })}
          </Document>
        </div>
      </div>
    </div>
  );
});
