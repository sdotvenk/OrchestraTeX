"use client";

import "katex/dist/katex.min.css";
import { Check, Copy, FileText } from "@phosphor-icons/react";
import { isValidElement, memo, type ReactNode, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

interface MarkdownTextProps {
  text: string;
  projectFiles?: string[];
  onFileClick?: (path: string) => void;
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextContent).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractTextContent(node.props.children);
  }
  return "";
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="my-2 rounded-lg border border-border bg-sunken/70 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-subtle/80">
        <span className="text-[11px] font-mono text-muted">{language || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-muted hover:text-foreground hover:bg-panel transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="size-3 text-success" aria-hidden="true" />
              <span className="text-success">Copied</span>
            </>
          ) : (
            <>
              <Copy className="size-3" aria-hidden="true" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] font-mono leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

export const MarkdownText = memo(function MarkdownText({
  text,
  projectFiles = [],
  onFileClick,
}: MarkdownTextProps) {
  const fileSet = useMemo(() => new Set(projectFiles), [projectFiles]);

  const components = useMemo(() => {
    const matchProjectFile = (token: string): string | null => {
      const clean = token.trim().replace(/^`|`$/g, "").replace(/^\.\//, "");
      if (!clean) return null;
      if (fileSet.has(clean)) return clean;
      const withoutLine = clean.replace(/:\d+(?::\d+)?$/, "");
      if (withoutLine !== clean && fileSet.has(withoutLine)) return withoutLine;
      // Match basename if unambiguous or looks like project TeX/Bib file
      if (/\.(tex|bib|cls|sty|md|txt|json|py|rs|ts|tsx)$/i.test(withoutLine)) {
        if (fileSet.size === 0) return withoutLine;
        for (const f of fileSet) {
          if (f === withoutLine || f.endsWith(`/${withoutLine}`)) {
            return f;
          }
        }
      }
      return null;
    };

    return {
      pre({ children }: { children?: ReactNode }) {
        let lang = "text";
        if (isValidElement<{ className?: string }>(children)) {
          const cls = children.props.className ?? "";
          const m = cls.match(/language-([^\s]+)/);
          if (m?.[1]) lang = m[1];
        }
        const code = extractTextContent(children).replace(/\n$/, "");
        return <CodeBlock language={lang} code={code} />;
      },
      code({ className, children, ...rest }: { className?: string; children?: ReactNode }) {
        const isBlock = Boolean(className && /language-/.test(className));
        if (isBlock) {
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );
        }
        const raw = extractTextContent(children);
        const matchedFile = onFileClick ? matchProjectFile(raw) : null;
        if (matchedFile && onFileClick) {
          return (
            <button
              type="button"
              onClick={() => onFileClick(matchedFile)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md text-[12px] font-mono bg-accent-soft text-accent hover:brightness-95 transition-all align-baseline"
              title={`Open ${matchedFile}`}
            >
              <FileText className="size-3 shrink-0" aria-hidden="true" />
              <span>{raw}</span>
            </button>
          );
        }
        return (
          <code
            className="px-1.5 py-0.5 rounded-md text-[12px] font-mono bg-sunken text-foreground-strong"
            {...rest}
          >
            {children}
          </code>
        );
      },
      p({ children }: { children?: ReactNode }) {
        return <p className="leading-relaxed">{children}</p>;
      },
      ul({ children }: { children?: ReactNode }) {
        return <ul className="list-disc pl-5 space-y-1">{children}</ul>;
      },
      ol({ children }: { children?: ReactNode }) {
        return <ol className="list-decimal pl-5 space-y-1">{children}</ol>;
      },
      blockquote({ children }: { children?: ReactNode }) {
        return (
          <blockquote className="border-l-2 border-accent pl-3 py-0.5 text-muted italic">
            {children}
          </blockquote>
        );
      },
      table({ children }: { children?: ReactNode }) {
        return (
          <div className="overflow-x-auto my-2 border border-border">
            <table className="w-full text-xs border-collapse">{children}</table>
          </div>
        );
      },
      th({ children }: { children?: ReactNode }) {
        return (
          <th className="text-left px-2.5 py-1.5 border-b border-border bg-surface-secondary font-mono text-[11px] uppercase tracking-wider">
            {children}
          </th>
        );
      },
      td({ children }: { children?: ReactNode }) {
        return <td className="px-2.5 py-1.5 border-b border-border/60">{children}</td>;
      },
      a({ href, children }: { href?: string; children?: ReactNode }) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            {children}
          </a>
        );
      },
    };
  }, [fileSet, onFileClick]);

  return (
    <div className="agent-markdown text-sm leading-relaxed text-foreground break-words space-y-2">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
