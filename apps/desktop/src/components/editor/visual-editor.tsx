"use client";

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FigureBlock,
  type HeadingBlock,
  type HeadingLevel,
  type InlineNode,
  type ListBlock,
  type MathBlock,
  type OpaqueBlock,
  parseInlines,
  parseVisualLatex,
  serializeInlines,
  serializeVisualLatex,
  type TableBlock,
  type VisualBlock,
  type VisualLatexDocument,
} from "@/lib/latex/visual-latex";

export interface VisualEditorProps {
  value: string;
  onChange: (nextLatex: string) => void;
  filePath?: string;
  readOnly?: boolean;
  className?: string;
}

function keyedByContent<T>(items: readonly T[]) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const content = JSON.stringify(item);
    const count = (occurrences.get(content) ?? 0) + 1;
    occurrences.set(content, count);
    return { item, key: `${content}:${count}` };
  });
}

function InlineTokenPills({ inlines }: { inlines: InlineNode[] }) {
  const tokens = inlines.filter(
    (n) => n.type === "math" || n.type === "cite" || n.type === "ref" || n.type === "label",
  );
  if (tokens.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {keyedByContent(tokens).map(({ item: token, key }) => {
        if (token.type === "math") {
          return (
            <span
              key={key}
              className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] bg-[var(--subtle)] text-[var(--text-strong)] border border-[var(--line)]"
            >
              {token.delimiter === "$" ? `$${token.tex}$` : `\\(${token.tex}\\)`}
            </span>
          );
        }
        if (token.type === "cite") {
          return (
            <span
              key={key}
              className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--line)]"
            >
              \\{token.command}
              {"{"}
              {token.keys}
              {"}"}
            </span>
          );
        }
        if (token.type === "ref") {
          return (
            <span
              key={key}
              className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] bg-[var(--subtle)] text-[var(--accent)] border border-[var(--line)]"
            >
              \\{token.command}
              {"{"}
              {token.target}
              {"}"}
            </span>
          );
        }
        if (token.type === "label") {
          return (
            <span
              key={key}
              className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] bg-[var(--subtle)] text-[var(--muted)] border border-[var(--line)]"
            >
              \\label{"{"}
              {token.key}
              {"}"}
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}

const HEADING_SIZE_CLASS: Record<HeadingLevel, string> = {
  part: "text-2xl font-semibold tracking-tight",
  chapter: "text-xl font-semibold tracking-tight",
  section: "text-lg font-semibold tracking-tight",
  subsection: "text-base font-semibold",
  subsubsection: "text-sm font-semibold",
  paragraph: "text-sm font-medium",
};

export function VisualEditor({
  value,
  onChange,
  filePath,
  readOnly = false,
  className = "",
}: VisualEditorProps) {
  const [doc, setDoc] = useState<VisualLatexDocument>(() => parseVisualLatex(value));
  const docRef = useRef(doc);
  const [preambleOpen, setPreambleOpen] = useState(false);
  const [expandedOpaqueIds, setExpandedOpaqueIds] = useState<Set<string>>(() => new Set());

  // Track the last LaTeX string we emitted so our own edits don't trigger a
  // full re-parse and clobber caret/focus state.
  const lastEmittedRef = useRef<string>(value);
  const activeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeBlockIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      const parsed = parseVisualLatex(value);
      docRef.current = parsed;
      setDoc(parsed);
    }
  }, [value]);

  const commitDoc = useCallback(
    (nextDoc: VisualLatexDocument) => {
      docRef.current = nextDoc;
      setDoc(nextDoc);
      const serialized = serializeVisualLatex(nextDoc);
      lastEmittedRef.current = serialized;
      onChange(serialized);
    },
    [onChange],
  );

  const updateBlock = useCallback(
    (blockId: string, updater: (block: VisualBlock) => VisualBlock) => {
      const prev = docRef.current;
      const nextDoc = {
        ...prev,
        blocks: prev.blocks.map((b) => (b.id === blockId ? updater(b) : b)),
      };
      commitDoc(nextDoc);
    },
    [commitDoc],
  );

  const wrapSelectionInActiveTextarea = useCallback(
    (prefix: string, suffix: string, placeholder: string) => {
      const el = activeTextareaRef.current;
      const blockId = activeBlockIdRef.current;
      if (!el || !blockId || readOnly) return;

      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const current = el.value;
      const selected = current.slice(start, end) || placeholder;
      const nextText = `${current.slice(0, start)}${prefix}${selected}${suffix}${current.slice(end)}`;

      updateBlock(blockId, (block) => {
        if (block.type !== "paragraph") return block;
        return {
          ...block,
          inlines: parseInlines(nextText),
          dirty: true,
        };
      });

      requestAnimationFrame(() => {
        el.focus();
        const cursorStart = start + prefix.length;
        el.setSelectionRange(cursorStart, cursorStart + selected.length);
      });
    },
    [readOnly, updateBlock],
  );

  const appendBlock = useCallback(
    (newBlock: VisualBlock) => {
      if (readOnly) return;
      commitDoc({
        ...doc,
        blocks: [...doc.blocks, newBlock],
      });
    },
    [commitDoc, doc, readOnly],
  );

  const handleParagraphKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        wrapSelectionInActiveTextarea("\\textbf{", "}", "bold");
      } else if (key === "i") {
        e.preventDefault();
        wrapSelectionInActiveTextarea("\\textit{", "}", "italic");
      } else if (key === "e") {
        e.preventDefault();
        wrapSelectionInActiveTextarea("\\texttt{", "}", "code");
      }
    },
    [readOnly, wrapSelectionInActiveTextarea],
  );

  const toggleOpaque = useCallback((id: string) => {
    setExpandedOpaqueIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div
      className={`flex h-full flex-col bg-[var(--panel)] text-[var(--text)] ${className}`}
      data-testid="visual-latex-editor"
    >
      {/* Formatting & Insert Toolbar */}
      <div
        role="toolbar"
        aria-label="Visual LaTeX formatting"
        className="flex flex-wrap items-center gap-1 border-b border-[var(--line)] bg-[var(--bg)] px-3 py-1.5 text-xs"
      >
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\textbf{", "}", "bold")}
          aria-label="Bold (Mod+B)"
          title="Bold (Mod+B)"
          className="rounded px-2 py-1 font-semibold hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          B
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\textit{", "}", "italic")}
          aria-label="Italic (Mod+I)"
          title="Italic (Mod+I)"
          className="rounded px-2 py-1 italic hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          I
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\emph{", "}", "emphasis")}
          aria-label="Emphasis"
          title="Emphasis"
          className="rounded px-2 py-1 hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          Emph
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\texttt{", "}", "code")}
          aria-label="Monospace (Mod+E)"
          title="Monospace (Mod+E)"
          className="rounded px-2 py-1 font-mono hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          Code
        </button>

        <span className="mx-1 h-4 w-px bg-[var(--line-strong)]" aria-hidden="true" />

        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("$", "$", "x")}
          aria-label="Inline math"
          className="rounded px-2 py-1 font-mono hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          $x$
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\cite{", "}", "key")}
          aria-label="Insert citation"
          className="rounded px-2 py-1 hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          Cite
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => wrapSelectionInActiveTextarea("\\ref{", "}", "label")}
          aria-label="Insert reference"
          className="rounded px-2 py-1 hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          Ref
        </button>

        <span className="mx-1 h-4 w-px bg-[var(--line-strong)]" aria-hidden="true" />

        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            appendBlock({
              id: `block-${Date.now()}`,
              type: "heading",
              level: "section",
              starred: false,
              title: "New Section",
              leadingWhitespace: doc.blocks.length > 0 ? "\n\n" : "",
              raw: "\\section{New Section}",
              dirty: true,
            })
          }
          aria-label="Add section"
          className="rounded px-2 py-1 hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          + Section
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            appendBlock({
              id: `block-${Date.now()}`,
              type: "list",
              ordered: false,
              items: [
                {
                  id: `item-${Date.now()}`,
                  inlines: [{ type: "text", text: "List item" }],
                },
              ],
              leadingWhitespace: doc.blocks.length > 0 ? "\n\n" : "",
              raw: "\\begin{itemize}\n  \\item List item\n\\end{itemize}",
              dirty: true,
            })
          }
          aria-label="Add bulleted list"
          className="rounded px-2 py-1 hover:bg-[var(--subtle)] disabled:opacity-50"
        >
          + List
        </button>

        <span className="ml-auto font-mono text-[11px] text-[var(--muted)]">
          {doc.kind === "complete" ? "Document" : "Fragment"}
          {filePath ? ` · ${filePath.split("/").pop()}` : ""}
        </span>
      </div>

      {/* Document Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-4">
          {doc.kind === "complete" && doc.preamble.trim().length > 0 && (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setPreambleOpen((v) => !v)}
                aria-expanded={preambleOpen}
                className="flex w-full items-center justify-between font-mono text-[var(--muted)] hover:text-[var(--text-strong)]"
              >
                <span>Preamble (preserved)</span>
                <span>{preambleOpen ? "Hide" : "Show"}</span>
              </button>
              {preambleOpen && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--muted)]">
                  {doc.preamble.trim()}
                </pre>
              )}
            </div>
          )}

          {doc.blocks.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--line-strong)] p-6 text-center text-sm text-[var(--muted)]">
              Empty document
            </div>
          )}

          {doc.blocks.map((block) => {
            if (block.type === "heading") {
              return (
                <HeadingBlockView
                  key={block.id}
                  block={block}
                  readOnly={readOnly}
                  onChange={(title) =>
                    updateBlock(block.id, (b) =>
                      b.type === "heading" ? { ...b, title, dirty: true } : b,
                    )
                  }
                />
              );
            }

            if (block.type === "paragraph") {
              const text = serializeInlines(block.inlines);
              return (
                <div key={block.id} className="group">
                  <textarea
                    value={text}
                    readOnly={readOnly}
                    aria-label="Paragraph"
                    rows={Math.max(1, text.split("\n").length)}
                    onFocus={(e) => {
                      activeTextareaRef.current = e.currentTarget;
                      activeBlockIdRef.current = block.id;
                    }}
                    onKeyDown={handleParagraphKeyDown}
                    onChange={(e) => {
                      const nextVal = e.currentTarget.value;
                      updateBlock(block.id, (b) =>
                        b.type === "paragraph"
                          ? {
                              ...b,
                              inlines: parseInlines(nextVal),
                              dirty: true,
                            }
                          : b,
                      );
                    }}
                    className="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-[var(--text)] focus:border-[var(--line-strong)] focus:bg-[var(--bg)] focus:outline-none"
                  />
                  <InlineTokenPills inlines={block.inlines} />
                </div>
              );
            }

            if (block.type === "list") {
              return (
                <ListBlockView
                  key={block.id}
                  block={block}
                  readOnly={readOnly}
                  onChange={(items) =>
                    updateBlock(block.id, (b) =>
                      b.type === "list" ? { ...b, items, dirty: true } : b,
                    )
                  }
                />
              );
            }

            if (block.type === "math") {
              return (
                <MathBlockView
                  key={block.id}
                  block={block}
                  readOnly={readOnly}
                  onChange={(tex) =>
                    updateBlock(block.id, (b) =>
                      b.type === "math" ? { ...b, tex, dirty: true } : b,
                    )
                  }
                />
              );
            }

            if (block.type === "figure") {
              return (
                <FigureBlockView
                  key={block.id}
                  block={block}
                  readOnly={readOnly}
                  onChange={(patch) =>
                    updateBlock(block.id, (b) =>
                      b.type === "figure" ? { ...b, ...patch, dirty: true } : b,
                    )
                  }
                />
              );
            }

            if (block.type === "table") {
              return (
                <TableBlockView
                  key={block.id}
                  block={block}
                  readOnly={readOnly}
                  onChange={(patch) =>
                    updateBlock(block.id, (b) =>
                      b.type === "table" ? { ...b, ...patch, dirty: true } : b,
                    )
                  }
                />
              );
            }

            return (
              <OpaqueBlockView
                key={block.id}
                block={block}
                expanded={expandedOpaqueIds.has(block.id)}
                onToggle={() => toggleOpaque(block.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HeadingBlockView({
  block,
  readOnly,
  onChange,
}: {
  block: HeadingBlock;
  readOnly: boolean;
  onChange: (title: string) => void;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 font-mono text-[11px] text-[var(--muted)]">
        \{block.level}
        {block.starred ? "*" : ""}
      </span>
      <input
        type="text"
        value={block.title}
        readOnly={readOnly}
        aria-label={`${block.level} heading`}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={`w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[var(--text-strong)] focus:border-[var(--line-strong)] focus:bg-[var(--bg)] focus:outline-none ${HEADING_SIZE_CLASS[block.level]}`}
      />
    </div>
  );
}

function ListBlockView({
  block,
  readOnly,
  onChange,
}: {
  block: ListBlock;
  readOnly: boolean;
  onChange: (items: ListBlock["items"]) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] text-[var(--muted)]">
          {block.ordered ? "\\begin{enumerate}" : "\\begin{itemize}"}
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={() =>
              onChange([
                ...block.items,
                {
                  id: `${block.id}-item-${Date.now()}`,
                  inlines: [{ type: "text", text: "" }],
                },
              ])
            }
            className="rounded px-2 py-0.5 text-xs text-[var(--accent)] hover:bg-[var(--subtle)]"
          >
            + Item
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {block.items.map((item, idx) => {
          const text = serializeInlines(item.inlines);
          return (
            <div key={item.id} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-[var(--muted)]">
                {block.ordered ? `${idx + 1}.` : "•"}
              </span>
              <input
                type="text"
                value={text}
                readOnly={readOnly}
                aria-label={`List item ${idx + 1}`}
                onChange={(e) => {
                  const nextText = e.currentTarget.value;
                  onChange(
                    block.items.map((it) =>
                      it.id === item.id ? { ...it, inlines: parseInlines(nextText) } : it,
                    ),
                  );
                }}
                onKeyDown={(e) => {
                  if (readOnly) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const next = [...block.items];
                    next.splice(idx + 1, 0, {
                      id: `${block.id}-item-${Date.now()}`,
                      inlines: [{ type: "text", text: "" }],
                    });
                    onChange(next);
                  } else if (e.key === "Backspace" && text.length === 0 && block.items.length > 1) {
                    e.preventDefault();
                    onChange(block.items.filter((it) => it.id !== item.id));
                  }
                }}
                className="w-full rounded border border-transparent bg-[var(--panel)] px-2 py-1 text-sm text-[var(--text)] focus:border-[var(--line-strong)] focus:outline-none"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MathBlockView({
  block,
  readOnly,
  onChange,
}: {
  block: MathBlock;
  readOnly: boolean;
  onChange: (tex: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
      <div className="mb-1.5 font-mono text-[11px] text-[var(--muted)]">Math ({block.env})</div>
      <textarea
        value={block.tex}
        readOnly={readOnly}
        aria-label={`Display math (${block.env})`}
        rows={Math.max(1, block.tex.split("\n").length)}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="w-full resize-y rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-strong)] focus:border-[var(--accent)] focus:outline-none"
      />
    </div>
  );
}

function FigureBlockView({
  block,
  readOnly,
  onChange,
}: {
  block: FigureBlock;
  readOnly: boolean;
  onChange: (patch: Partial<FigureBlock>) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-[var(--muted)]">
        <span>
          \\begin{"{"}
          {block.env}
          {"}"}
          {block.placement ? `[${block.placement}]` : ""}
        </span>
        {block.imagePath && <span>{block.imagePath}</span>}
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--muted)]">Caption</span>
          <input
            type="text"
            value={block.caption ?? ""}
            readOnly={readOnly}
            onChange={(e) => onChange({ caption: e.currentTarget.value })}
            className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--muted)]">Label</span>
          <input
            type="text"
            value={block.label ?? ""}
            readOnly={readOnly}
            onChange={(e) => onChange({ label: e.currentTarget.value })}
            className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 font-mono text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
      </div>
    </div>
  );
}

function TableBlockView({
  block,
  readOnly,
  onChange,
}: {
  block: TableBlock;
  readOnly: boolean;
  onChange: (patch: Partial<TableBlock>) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-[var(--muted)]">
        <span>
          \\begin{"{"}
          {block.env}
          {"}"}
          {block.alignment ? `{${block.alignment}}` : ""}
        </span>
        {block.label && (
          <span>
            \\label{"{"}
            {block.label}
            {"}"}
          </span>
        )}
      </div>

      {block.caption !== undefined && (
        <label className="mb-2 block">
          <span className="mb-1 block text-[11px] text-[var(--muted)]">Caption</span>
          <input
            type="text"
            value={block.caption}
            readOnly={readOnly}
            onChange={(e) => onChange({ caption: e.currentTarget.value })}
            className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
      )}

      {block.rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse text-left text-xs">
            <tbody>
              {keyedByContent(block.rows).map(({ item: row, key }, rowIndex) => (
                <tr
                  key={key}
                  className={
                    rowIndex === 0
                      ? "border-b border-[var(--line-strong)] bg-[var(--subtle)] font-medium"
                      : "border-b border-[var(--line)] last:border-b-0"
                  }
                >
                  {keyedByContent(row).map(({ item: cell, key: cellKey }) => (
                    <td key={cellKey} className="px-2.5 py-1.5">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OpaqueBlockView({
  block,
  expanded,
  onToggle,
}: {
  block: OpaqueBlock;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-1.5 text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between font-mono text-[11px] text-[var(--muted)] hover:text-[var(--text-strong)]"
      >
        <span>{block.summary}</span>
        <span>{expanded ? "Hide" : "Source"}</span>
      </button>
      {expanded && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--muted)]">
          {block.raw}
        </pre>
      )}
    </div>
  );
}
