"use client";

import "@/lib/monaco/config";

import Editor, { type Monaco, type OnChange, type OnMount } from "@monaco-editor/react";
import type { editor, IDisposable, Position } from "monaco-editor";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AttributedEdit } from "@/lib/agent/edit-attribution";
import { resolveMonoFontFamily } from "@/lib/editor/font-stacks";
import type { EditorSettings, EditorTheme } from "@/lib/editor/types";
import { VOICE_COLORS } from "@/lib/editor/voice-colors";
import type { BibEntry, LabelEntry } from "@/lib/latex/bib-parser";
import type { LatexDiagnostic } from "@/lib/latex/types";
import { registerLaTeXLanguage } from "@/lib/monaco/latex";
import { defineEditorThemes } from "@/lib/monaco/themes";

type Props = {
  content?: string;
  readOnly?: boolean;
  className?: string;
  language?: string;
  filePath?: string | null;
  editorSettings?: Partial<EditorSettings>;
  editorTheme?: EditorTheme;
  diagnostics?: LatexDiagnostic[];
  bibEntries?: BibEntry[];
  texLabels?: LabelEntry[];
  onContentChange?: (content: string) => void;
  onCompileShortcut?: () => void;
  onForwardSync?: (line: number, column: number) => void;
  onAskAgent?: (
    selectionText: string,
    filePath: string,
    startLine: number,
    endLine: number,
  ) => void;
  onCursorChange?: (pos: { line: number; column: number }) => void;
  goToLine?: number;
  attributedEdits?: AttributedEdit[];
  onKeepEdit?: (edit: AttributedEdit) => void;
  onUndoEdit?: (edit: AttributedEdit) => void;
};

type VimModeController = {
  dispose: () => void;
};

// Shared module-level completion store + singleton provider so split panes never duplicate \cite / \ref suggestions
let sharedBibEntries: BibEntry[] = [];
let sharedTexLabels: LabelEntry[] = [];
let sharedRefCiteProviderRegistered = false;

function ensureLatexRefCiteProvider(monaco: Monaco) {
  if (sharedRefCiteProviderRegistered) return;
  sharedRefCiteProviderRegistered = true;
  monaco.languages.registerCompletionItemProvider("latex", {
    triggerCharacters: ["{", ","],
    provideCompletionItems: (model: editor.ITextModel, position: Position) => {
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      if (/\\cite[a-zA-Z*]*\{[^}]*$/.test(linePrefix)) {
        return {
          suggestions: sharedBibEntries.map((entry) => ({
            label: entry.key,
            kind: monaco.languages.CompletionItemKind.Reference,
            insertText: entry.key,
            detail: [entry.author, entry.year].filter(Boolean).join(" · ") || entry.entryType,
            documentation: entry.title,
            range,
          })),
        };
      }

      if (/\\(?:ref|eqref|pageref|autoref|cref|Cref)\*?\{[^}]*$/.test(linePrefix)) {
        return {
          suggestions: sharedTexLabels.map((lbl) => ({
            label: lbl.key,
            kind: monaco.languages.CompletionItemKind.Bookmark,
            insertText: lbl.key,
            detail: `${lbl.file}:${lbl.line}`,
            range,
          })),
        };
      }

      return { suggestions: [] };
    },
  });
}

function detectLanguage(lang: string): string {
  const languageMap: Record<string, string> = {
    tex: "latex",
    latex: "latex",
    bib: "bibtex",
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    py: "python",
    md: "markdown",
    json: "json",
    css: "css",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languageMap[lang.toLowerCase()] || lang;
}

export const MonacoEditor = memo(function MonacoEditor({
  content = "",
  readOnly = false,
  className = "",
  language = "latex",
  filePath = null,
  editorSettings,
  editorTheme = "one-light",
  diagnostics = [],
  bibEntries = [],
  texLabels = [],
  onContentChange,
  onCompileShortcut,
  onForwardSync,
  onAskAgent,
  onCursorChange,
  goToLine,
  attributedEdits,
  onKeepEdit,
  onUndoEdit,
}: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const isExternalUpdateRef = useRef(false);
  const contentRef = useRef(content);
  const vimModeRef = useRef<VimModeController | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const filePathRef = useRef(filePath);
  const onCompileShortcutRef = useRef(onCompileShortcut);
  const onForwardSyncRef = useRef(onForwardSync);
  const onAskAgentRef = useRef(onAskAgent);
  const onCursorChangeRef = useRef(onCursorChange);
  const cursorListenerRef = useRef<IDisposable | null>(null);

  sharedBibEntries = bibEntries;
  sharedTexLabels = texLabels;
  filePathRef.current = filePath;
  onCompileShortcutRef.current = onCompileShortcut;
  onForwardSyncRef.current = onForwardSync;
  onAskAgentRef.current = onAskAgent;
  onCursorChangeRef.current = onCursorChange;
  const loadingRows = [70, 45, 60, 80, 35, 55, 40, 65].map((width) => ({
    id: `monaco-loading-${width}`,
    width,
  }));

  const pendingGoToLineRef = useRef<number>(0);

  const handleEditorDidMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReady(true);
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());

    // Apply any pending goToLine that arrived before the editor was ready
    if (pendingGoToLineRef.current > 0) {
      const line = pendingGoToLineRef.current;
      pendingGoToLineRef.current = 0;
      setTimeout(() => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
        const decorations = editor.deltaDecorations(
          [],
          [
            {
              range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
              options: {
                isWholeLine: true,
                className: "synctex-line-highlight",
                overviewRuler: { color: "rgba(255, 200, 0, 0.6)", position: 1 },
              },
            },
          ],
        );
        setTimeout(() => editor.deltaDecorations(decorations, []), 1500);
      }, 50);
    }

    defineEditorThemes(monaco);
    registerLaTeXLanguage(monaco);

    editor.focus();

    editor.addAction({
      id: "toggle-latex-comment",
      label: "Toggle LaTeX Comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      run: (ed) => {
        const selection = ed.getSelection();
        if (!selection) return;

        const model = ed.getModel();
        if (!model) return;

        const edits: editor.IIdentifiedSingleEditOperation[] = [];

        for (
          let lineNumber = selection.startLineNumber;
          lineNumber <= selection.endLineNumber;
          lineNumber++
        ) {
          const lineContent = model.getLineContent(lineNumber);
          const trimmedLine = lineContent.trimStart();
          const leadingSpaces = lineContent.length - trimmedLine.length;

          if (trimmedLine.startsWith("%")) {
            const commentLength = trimmedLine.startsWith("% ") ? 2 : 1;
            edits.push({
              range: {
                startLineNumber: lineNumber,
                startColumn: leadingSpaces + 1,
                endLineNumber: lineNumber,
                endColumn: leadingSpaces + 1 + commentLength,
              },
              text: "",
            });
          } else {
            edits.push({
              range: {
                startLineNumber: lineNumber,
                startColumn: leadingSpaces + 1,
                endLineNumber: lineNumber,
                endColumn: leadingSpaces + 1,
              },
              text: "% ",
            });
          }
        }

        ed.executeEdits("toggle-comment", edits);
      },
    });

    const wrapWithCommand = (ed: editor.ICodeEditor, commandName: string) => {
      const model = ed.getModel();
      const selection = ed.getSelection();
      if (!model || !selection) return;
      const selected = model.getValueInRange(selection);
      const wrapped = selected ? `\\${commandName}{${selected}}` : `\\${commandName}{}`;
      ed.executeEdits(`latex-${commandName}`, [
        {
          range: selection,
          text: wrapped,
          forceMoveMarkers: true,
        },
      ]);
      if (!selected) {
        const nextCol = selection.startColumn + commandName.length + 2;
        ed.setPosition({ lineNumber: selection.startLineNumber, column: nextCol });
      }
    };

    editor.addAction({
      id: "latex-wrap-bold",
      label: "LaTeX: Bold (\\textbf)",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      run: (ed) => wrapWithCommand(ed, "textbf"),
    });

    editor.addAction({
      id: "latex-wrap-italic",
      label: "LaTeX: Italic (\\textit)",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      run: (ed) => wrapWithCommand(ed, "textit"),
    });

    editor.addAction({
      id: "latex-compile-shortcut",
      label: "LaTeX: Compile Document",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        onCompileShortcutRef.current?.();
      },
    });

    editor.addAction({
      id: "latex-sync-to-pdf",
      label: "Sync to PDF (SyncTeX)",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      run: (ed) => {
        const pos = ed.getPosition();
        if (!pos) return;
        onForwardSyncRef.current?.(pos.lineNumber, pos.column);
      },
    });

    editor.addAction({
      id: "latex-ask-agent-selection",
      label: "Ask Agent about Selection",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 9.5,
      run: (ed) => {
        const model = ed.getModel();
        const sel = ed.getSelection();
        if (!model || !sel) return;
        const selected = model.getValueInRange(sel).trim();
        const lineText = selected || model.getLineContent(sel.startLineNumber);
        onAskAgentRef.current?.(
          lineText,
          filePathRef.current ?? "",
          sel.startLineNumber,
          sel.endLineNumber,
        );
      },
    });

    cursorListenerRef.current?.dispose();
    cursorListenerRef.current = editor.onDidChangeCursorPosition((ev) => {
      onCursorChangeRef.current?.({
        line: ev.position.lineNumber,
        column: ev.position.column,
      });
    });

    ensureLatexRefCiteProvider(monaco);
  }, []);

  const handleChange: OnChange = useCallback(
    (value) => {
      if (isExternalUpdateRef.current) return;
      if (value !== undefined) {
        contentRef.current = value;
        onContentChange?.(value);
      }
    },
    [onContentChange],
  );

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    defineEditorThemes(monaco);
    registerLaTeXLanguage(monaco);
  }, []);

  useEffect(() => {
    if (monacoRef.current && editorTheme) {
      monacoRef.current.editor.setTheme(editorTheme);
    }
  }, [editorTheme]);

  useEffect(() => {
    if (!goToLine || goToLine <= 0) return;

    const ed = editorRef.current;
    if (!ed) {
      // Editor not ready yet — store for when it mounts
      pendingGoToLineRef.current = goToLine;
      return;
    }

    ed.revealLineInCenter(goToLine);
    ed.setPosition({ lineNumber: goToLine, column: 1 });
    ed.focus();

    // Briefly highlight the line
    const decorations = ed.deltaDecorations(
      [],
      [
        {
          range: {
            startLineNumber: goToLine,
            startColumn: 1,
            endLineNumber: goToLine,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: "synctex-line-highlight",
            overviewRuler: {
              color: "rgba(255, 200, 0, 0.6)",
              position: 1,
            },
          },
        },
      ],
    );

    const timer = setTimeout(() => {
      ed.deltaDecorations(decorations, []);
    }, 1500);

    return () => clearTimeout(timer);
  }, [goToLine]);

  useEffect(() => {
    const statusNode = vimStatusRef.current;
    if (!editorReady || !editorRef.current || !statusNode) return;

    vimModeRef.current?.dispose();
    vimModeRef.current = null;
    statusNode.textContent = "";

    const shouldEnableVim = !!editorSettings?.vimMode && !readOnly;
    if (!shouldEnableVim) return;

    let cancelled = false;

    (async () => {
      try {
        const monacoVim = await import("monaco-vim");
        if (cancelled || !editorRef.current) return;

        vimModeRef.current?.dispose();
        vimModeRef.current = monacoVim.initVimMode(editorRef.current, statusNode);
        editorRef.current.focus();
      } catch (error) {
        console.error("Failed to enable Vim mode:", error);
      }
    })();

    return () => {
      cancelled = true;
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
      statusNode.textContent = "";
    };
  }, [editorReady, editorSettings?.vimMode, readOnly]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!monaco || !model || !editorReady) return;
    void filePath;

    const markers: editor.IMarkerData[] = diagnostics
      .filter((d) => d.line > 0)
      .map((d) => {
        const maxLine = model.getLineCount();
        const line = Math.min(Math.max(1, d.line), maxLine);
        const endCol = Math.max(2, model.getLineMaxColumn(line));
        return {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: endCol,
          message: d.message,
          severity:
            d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          source: "LaTeX",
        };
      });

    monaco.editor.setModelMarkers(model, "latex", markers);
  }, [diagnostics, editorReady, filePath]);

  useEffect(() => {
    return () => {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
      cursorListenerRef.current?.dispose();
      cursorListenerRef.current = null;
    };
  }, []);

  const decorationIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !editorReady) return;
    const model = ed.getModel();
    if (!model) return;

    const lineCount = model.getLineCount();
    const nextDecorations: editor.IModelDeltaDecoration[] = (attributedEdits ?? []).map((edit) => {
      const provider = edit.thread.providerId;
      const startLine = Math.max(1, Math.min(edit.startLine, lineCount));
      const endLine = Math.max(startLine, Math.min(edit.endLine, lineCount));
      return {
        range: {
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: endLine,
          endColumn: model.getLineMaxColumn(endLine),
        },
        options: {
          isWholeLine: true,
          className: edit.status === "pending" ? `ox-voice-range--${provider}` : undefined,
          linesDecorationsClassName: `ox-voice-gutter--${provider}`,
          hoverMessage: {
            value: `${provider} · ${edit.thread.title}`,
          },
        },
      };
    });

    decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, nextDecorations);
    return () => {
      if (decorationIdsRef.current.length > 0 && editorRef.current) {
        decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []);
      }
    };
  }, [attributedEdits, editorReady]);

  const jumpToAttributedEdit = useCallback((edit: AttributedEdit) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(edit.startLine);
    ed.setPosition({ lineNumber: edit.startLine, column: 1 });
    ed.focus();
  }, []);

  const pendingEdits = attributedEdits?.filter((edit) => edit.status === "pending");

  return (
    <div className={`relative flex flex-col ${className}`}>
      {pendingEdits && pendingEdits.length > 0 && (
        <section
          className="absolute top-2 right-4 z-10 flex flex-col gap-1 max-w-[320px] pointer-events-auto"
          aria-label="Attributed agent edits"
        >
          {pendingEdits.map((edit) => {
            const voice = VOICE_COLORS[edit.thread.providerId] ?? VOICE_COLORS["custom-acp"];
            const label = `${edit.thread.providerId} · ${edit.thread.title}`;
            return (
              <div
                key={edit.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-panel/95 backdrop-blur-sm shadow-sm text-[11.5px]"
              >
                <button
                  type="button"
                  onClick={() => jumpToAttributedEdit(edit)}
                  className="inline-flex items-center gap-1.5 min-w-0 flex-1 text-left hover:underline"
                  title={`Jump to ${label} (L${edit.startLine})`}
                  aria-label={`Jump to ${label} at line ${edit.startLine}`}
                >
                  <span
                    className="inline-block w-[7px] h-[7px] rounded-full flex-shrink-0"
                    style={{ backgroundColor: voice.ink }}
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium" style={{ color: voice.text }}>
                    {label}
                  </span>
                </button>
                {onKeepEdit && (
                  <button
                    type="button"
                    onClick={() => onKeepEdit(edit)}
                    className="px-1.5 py-0.5 rounded text-[11px] text-foreground hover:bg-subtle transition-colors"
                    aria-label={`Keep edit from ${label}`}
                  >
                    Keep
                  </button>
                )}
                {onUndoEdit && (
                  <button
                    type="button"
                    onClick={() => onUndoEdit(edit)}
                    className="px-1.5 py-0.5 rounded text-[11px] text-foreground hover:bg-subtle transition-colors"
                    aria-label={`Undo edit from ${label}`}
                  >
                    Undo
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
      {editorSettings?.vimMode && !readOnly && (
        <div
          ref={vimStatusRef}
          className="pointer-events-none absolute right-3 top-3 z-10 border border-foreground bg-background px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider"
        />
      )}
      <Editor
        height="100%"
        language={detectLanguage(language)}
        value={content}
        theme={editorTheme}
        beforeMount={handleBeforeMount}
        onMount={handleEditorDidMount}
        onChange={handleChange}
        options={{
          readOnly,
          fontSize: editorSettings?.fontSize ?? 14,
          fontFamily: resolveMonoFontFamily(editorSettings?.fontFamily),
          fontLigatures: false,
          lineNumbers: editorSettings?.lineNumbers ?? "on",
          lineHeight: editorSettings?.lineHeight ?? 1.6,
          letterSpacing: 0,
          renderWhitespace: editorSettings?.renderWhitespace ?? "selection",
          tabSize: editorSettings?.tabSize ?? 2,
          insertSpaces: editorSettings?.insertSpaces ?? true,
          wordWrap: editorSettings?.wordWrap ?? "off",
          wordWrapColumn: editorSettings?.wordWrapColumn ?? 80,
          wrappingIndent: "indent",
          automaticLayout: true,
          minimap: {
            enabled: editorSettings?.minimap?.enabled ?? false,
            side: editorSettings?.minimap?.side ?? "right",
            size: editorSettings?.minimap?.size ?? "proportional",
            maxColumn: 120,
            renderCharacters: editorSettings?.minimap?.renderCharacters ?? false,
            scale: editorSettings?.minimap?.scale ?? 1,
            showSlider: editorSettings?.minimap?.showSlider ?? "mouseover",
          },
          scrollBeyondLastLine: false,
          smoothScrolling: editorSettings?.smoothScrolling ?? true,
          cursorBlinking: editorSettings?.cursorBlinking ?? "smooth",
          cursorSmoothCaretAnimation: "on",
          cursorStyle: editorSettings?.cursorStyle ?? "line",
          cursorWidth: 2,
          formatOnPaste: editorSettings?.formatOnPaste ?? false,
          formatOnType: editorSettings?.formatOnSave ?? false,
          autoClosingBrackets: editorSettings?.autoClosingBrackets ?? "languageDefined",
          autoClosingQuotes: editorSettings?.autoClosingQuotes ?? "languageDefined",
          renderLineHighlight: "line",
          renderLineHighlightOnlyWhenFocus: false,
          selectOnLineNumbers: true,
          folding: true,
          foldingStrategy: "auto",
          showFoldingControls: "mouseover",
          matchBrackets: "always",
          bracketPairColorization: {
            enabled: false,
          },
          guides: {
            bracketPairs: true,
            bracketPairsHorizontal: false,
            indentation: true,
            highlightActiveIndentation: true,
          },
          suggest: {
            showKeywords: true,
            showSnippets: true,
            showFunctions: true,
            showConstants: true,
            showVariables: true,
            filterGraceful: true,
            localityBonus: true,
          },
          quickSuggestions: {
            other: true,
            comments: false,
            strings: true,
          },
          acceptSuggestionOnCommitCharacter: true,
          acceptSuggestionOnEnter: "on",
          snippetSuggestions: "inline",
          parameterHints: {
            enabled: true,
          },
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: "multiline",
            seedSearchStringFromSelection: "selection",
          },
          padding: {
            top: 16,
            bottom: 16,
          },
          scrollbar: {
            vertical: "visible",
            horizontal: "visible",
            useShadows: false,
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            arrowSize: 0,
          },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          contextmenu: true,
          mouseWheelZoom: true,
          dragAndDrop: true,
          links: true,
          colorDecorators: false,
          accessibilitySupport: "auto",
        }}
        loading={
          <div className="flex flex-col h-full bg-background">
            <div className="flex-1 p-4 space-y-2">
              {loadingRows.map(({ id, width }) => (
                <div key={id} className="flex gap-4">
                  <div className="w-8 h-4 bg-surface-secondary animate-pulse" />
                  <div
                    className="flex-1 h-4 bg-surface-secondary animate-pulse"
                    style={{ width: `${width}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        }
      />
    </div>
  );
});
