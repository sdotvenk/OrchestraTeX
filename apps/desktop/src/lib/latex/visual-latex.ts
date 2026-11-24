export type DocumentKind = "complete" | "fragment";

export type HeadingLevel =
  | "part"
  | "chapter"
  | "section"
  | "subsection"
  | "subsubsection"
  | "paragraph";

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "emph"; children: InlineNode[] }
  | { type: "underline"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "math"; tex: string; delimiter: "$" | "\\(" }
  | {
      type: "cite";
      command: string;
      keys: string;
      optional?: string;
      raw: string;
    }
  | { type: "ref"; command: string; target: string; raw: string }
  | { type: "label"; key: string; raw: string }
  | { type: "opaque"; raw: string };

export interface BaseBlock {
  id: string;
  leadingWhitespace: string;
  raw: string;
  dirty?: boolean;
}

export interface HeadingBlock extends BaseBlock {
  type: "heading";
  level: HeadingLevel;
  starred: boolean;
  title: string;
}

export interface ParagraphBlock extends BaseBlock {
  type: "paragraph";
  inlines: InlineNode[];
}

export interface ListItem {
  id: string;
  optional?: string;
  inlines: InlineNode[];
}

export interface ListBlock extends BaseBlock {
  type: "list";
  ordered: boolean;
  options?: string;
  items: ListItem[];
}

export interface MathBlock extends BaseBlock {
  type: "math";
  env: "$$" | "\\[" | string;
  tex: string;
}

export interface FigureBlock extends BaseBlock {
  type: "figure";
  env: "figure" | "figure*";
  placement?: string;
  imagePath?: string;
  imageOptions?: string;
  caption?: string;
  label?: string;
}

export interface TableBlock extends BaseBlock {
  type: "table";
  env: "table" | "table*" | "tabular";
  placement?: string;
  caption?: string;
  label?: string;
  alignment?: string;
  rows: string[][];
}

export interface OpaqueBlock extends BaseBlock {
  type: "opaque";
  summary: string;
}

export type VisualBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | MathBlock
  | FigureBlock
  | TableBlock
  | OpaqueBlock;

export interface VisualLatexDocument {
  kind: DocumentKind;
  preamble: string;
  postamble: string;
  trailingWhitespace: string;
  blocks: VisualBlock[];
}

const HEADING_COMMANDS: readonly HeadingLevel[] = [
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
];

const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "alignat",
  "alignat*",
]);

const CITE_COMMANDS = new Set([
  "cite",
  "citep",
  "citet",
  "citeauthor",
  "citeyear",
  "parencite",
  "textcite",
  "autocite",
  "nocite",
]);

const REF_COMMANDS = new Set([
  "ref",
  "eqref",
  "autoref",
  "cref",
  "Cref",
  "pageref",
  "nameref",
  "vref",
]);

/**
 * Find the matching closing brace `}` for an opening `{` at `openIdx`,
 * respecting escaped braces (`\{`, `\}`) and nested braces.
 */
export function findMatchingBrace(source: string, openIdx: number): number {
  if (source[openIdx] !== "{") return -1;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++; // skip escaped character
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the matching closing bracket `]` for an opening `[` at `openIdx`.
 */
function findMatchingBracket(source: string, openIdx: number): number {
  if (source[openIdx] !== "[") return -1;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse inline LaTeX prose into InlineNode[].
 * Preserves unsupported commands/macros as `opaque` nodes so serialization is lossless.
 */
export function parseInlines(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let textBuf = "";
  let i = 0;

  const flushText = () => {
    if (textBuf.length > 0) {
      nodes.push({ type: "text", text: textBuf });
      textBuf = "";
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // Escaped characters like \$, \%, \{, \}, \\
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "(") {
        const closeIdx = input.indexOf("\\)", i + 2);
        if (closeIdx !== -1) {
          flushText();
          nodes.push({
            type: "math",
            tex: input.slice(i + 2, closeIdx),
            delimiter: "\\(",
          });
          i = closeIdx + 2;
          continue;
        }
      }

      if (next && /[a-zA-Z]/.test(next)) {
        // Read command name
        let cmdEnd = i + 1;
        while (cmdEnd < input.length && /[a-zA-Z*]/.test(input[cmdEnd] ?? "")) {
          cmdEnd++;
        }
        const cmd = input.slice(i + 1, cmdEnd);

        // Optional [...] argument
        let cursor = cmdEnd;
        let optional: string | undefined;
        if (input[cursor] === "[") {
          const closeBracket = findMatchingBracket(input, cursor);
          if (closeBracket !== -1) {
            optional = input.slice(cursor + 1, closeBracket);
            cursor = closeBracket + 1;
          }
        }

        if (input[cursor] === "{") {
          const closeBrace = findMatchingBrace(input, cursor);
          if (closeBrace !== -1) {
            const arg = input.slice(cursor + 1, closeBrace);
            const raw = input.slice(i, closeBrace + 1);

            if (cmd === "textbf" && optional === undefined) {
              flushText();
              nodes.push({ type: "bold", children: parseInlines(arg) });
              i = closeBrace + 1;
              continue;
            }
            if (cmd === "textit" && optional === undefined) {
              flushText();
              nodes.push({ type: "italic", children: parseInlines(arg) });
              i = closeBrace + 1;
              continue;
            }
            if (cmd === "emph" && optional === undefined) {
              flushText();
              nodes.push({ type: "emph", children: parseInlines(arg) });
              i = closeBrace + 1;
              continue;
            }
            if (cmd === "underline" && optional === undefined) {
              flushText();
              nodes.push({ type: "underline", children: parseInlines(arg) });
              i = closeBrace + 1;
              continue;
            }
            if (cmd === "texttt" && optional === undefined) {
              flushText();
              nodes.push({ type: "code", text: arg });
              i = closeBrace + 1;
              continue;
            }
            if (CITE_COMMANDS.has(cmd)) {
              flushText();
              nodes.push({
                type: "cite",
                command: cmd,
                keys: arg,
                optional,
                raw,
              });
              i = closeBrace + 1;
              continue;
            }
            if (REF_COMMANDS.has(cmd) && optional === undefined) {
              flushText();
              nodes.push({ type: "ref", command: cmd, target: arg, raw });
              i = closeBrace + 1;
              continue;
            }
            if (cmd === "label" && optional === undefined) {
              flushText();
              nodes.push({ type: "label", key: arg, raw });
              i = closeBrace + 1;
              continue;
            }

            // Unsupported command with braces: keep as opaque inline
            flushText();
            nodes.push({ type: "opaque", raw });
            i = closeBrace + 1;
            continue;
          }
        }
      }

      // Escaped char or command without braces
      textBuf += ch + (next ?? "");
      i += next !== undefined ? 2 : 1;
      continue;
    }

    // Inline math $...$
    if (ch === "$" && input[i + 1] !== "$") {
      let closeIdx = i + 1;
      let found = false;
      while (closeIdx < input.length) {
        if (input[closeIdx] === "\\") {
          closeIdx += 2;
          continue;
        }
        if (input[closeIdx] === "$") {
          found = true;
          break;
        }
        closeIdx++;
      }
      if (found) {
        flushText();
        nodes.push({
          type: "math",
          tex: input.slice(i + 1, closeIdx),
          delimiter: "$",
        });
        i = closeIdx + 1;
        continue;
      }
    }

    textBuf += ch;
    i++;
  }

  flushText();
  return nodes;
}

export function serializeInlines(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "bold":
          return `\\textbf{${serializeInlines(node.children)}}`;
        case "italic":
          return `\\textit{${serializeInlines(node.children)}}`;
        case "emph":
          return `\\emph{${serializeInlines(node.children)}}`;
        case "underline":
          return `\\underline{${serializeInlines(node.children)}}`;
        case "code":
          return `\\texttt{${node.text}}`;
        case "math":
          return node.delimiter === "$" ? `$${node.tex}$` : `\\(${node.tex}\\)`;
        case "cite": {
          const opt = node.optional !== undefined ? `[${node.optional}]` : "";
          return `\\${node.command}${opt}{${node.keys}}`;
        }
        case "ref":
          return `\\${node.command}{${node.target}}`;
        case "label":
          return `\\label{${node.key}}`;
        case "opaque":
          return node.raw;
        default:
          return "";
      }
    })
    .join("");
}

export function inlinesToPlainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "bold":
        case "italic":
        case "emph":
        case "underline":
          return inlinesToPlainText(node.children);
        case "code":
          return node.text;
        case "math":
          return node.delimiter === "$" ? `$${node.tex}$` : `\\(${node.tex}\\)`;
        case "cite":
          return `[${node.keys}]`;
        case "ref":
          return `[${node.target}]`;
        case "label":
          return "";
        case "opaque":
          return node.raw;
        default:
          return "";
      }
    })
    .join("");
}

function parseListItems(body: string, blockId: string): ListItem[] {
  const items: ListItem[] = [];
  const itemRegex = /\\item\b/g;
  const matches: number[] = [];
  let m = itemRegex.exec(body);
  while (m !== null) {
    matches.push(m.index);
    m = itemRegex.exec(body);
  }

  for (let idx = 0; idx < matches.length; idx++) {
    const start = matches[idx] ?? 0;
    const end = idx + 1 < matches.length ? (matches[idx + 1] ?? body.length) : body.length;
    let content = body.slice(start + 5, end).trim();
    let optional: string | undefined;
    if (content.startsWith("[")) {
      const closeBracket = findMatchingBracket(content, 0);
      if (closeBracket !== -1) {
        optional = content.slice(1, closeBracket);
        content = content.slice(closeBracket + 1).trim();
      }
    }
    items.push({
      id: `${blockId}-item-${idx}`,
      optional,
      inlines: parseInlines(content),
    });
  }

  return items;
}

function parseFigureBlock(
  raw: string,
  env: "figure" | "figure*",
  body: string,
  placement: string | undefined,
  leadingWhitespace: string,
  id: string,
): FigureBlock {
  const imgMatch = /\\includegraphics(?:\[([^\]]*)\])?\{([^}]*)\}/.exec(body);
  const capMatch = /\\caption\{/.exec(body);
  let caption: string | undefined;
  if (capMatch) {
    const openIdx = capMatch.index + "\\caption".length;
    const closeIdx = findMatchingBrace(body, openIdx);
    if (closeIdx !== -1) {
      caption = body.slice(openIdx + 1, closeIdx);
    }
  }
  const labelMatch = /\\label\{([^}]*)\}/.exec(body);

  return {
    id,
    type: "figure",
    env,
    placement,
    imageOptions: imgMatch?.[1],
    imagePath: imgMatch?.[2],
    caption,
    label: labelMatch?.[1],
    leadingWhitespace,
    raw,
  };
}

function parseTableRows(tabularBody: string): string[][] {
  const lines = tabularBody
    .replace(/\\(toprule|midrule|bottomrule|hline)\b/g, "")
    .split("\\\\")
    .map((row) => row.trim())
    .filter((row) => row.length > 0 && !row.startsWith("%"));

  return lines.map((row) => row.split("&").map((cell) => cell.trim()));
}

function parseTableBlock(
  raw: string,
  env: "table" | "table*" | "tabular",
  body: string,
  placement: string | undefined,
  leadingWhitespace: string,
  id: string,
): TableBlock {
  let caption: string | undefined;
  let label: string | undefined;
  let alignment: string | undefined;
  let tabularBody = body;

  if (env !== "tabular") {
    const capMatch = /\\caption\{/.exec(body);
    if (capMatch) {
      const openIdx = capMatch.index + "\\caption".length;
      const closeIdx = findMatchingBrace(body, openIdx);
      if (closeIdx !== -1) {
        caption = body.slice(openIdx + 1, closeIdx);
      }
    }
    const labelMatch = /\\label\{([^}]*)\}/.exec(body);
    label = labelMatch?.[1];

    const tabMatch = /\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/.exec(body);
    if (tabMatch) {
      alignment = tabMatch[1];
      tabularBody = tabMatch[2] ?? "";
    }
  } else {
    const alignMatch = /^\{([^}]*)\}([\s\S]*)$/.exec(body.trimStart());
    if (alignMatch) {
      alignment = alignMatch[1];
      tabularBody = alignMatch[2] ?? "";
    }
  }

  return {
    id,
    type: "table",
    env,
    placement,
    caption,
    label,
    alignment,
    rows: parseTableRows(tabularBody),
    leadingWhitespace,
    raw,
  };
}

function isBlockStart(trimmedLine: string): boolean {
  if (trimmedLine.startsWith("%")) return true;
  if (trimmedLine.startsWith("\\begin{")) return true;
  if (trimmedLine.startsWith("$$") || trimmedLine.startsWith("\\[")) return true;
  for (const level of HEADING_COMMANDS) {
    if (trimmedLine.startsWith(`\\${level}{`) || trimmedLine.startsWith(`\\${level}*{`)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a LaTeX source string into a VisualLatexDocument.
 * Complete documents (with `\begin{document}` / `\end{document}`) keep their
 * preamble and postamble intact; included fragments parse the whole file.
 */
export function parseVisualLatex(source: string): VisualLatexDocument {
  const beginDocMatch = /\\begin\{document\}/.exec(source);
  const endDocMatch = /\\end\{document\}/.exec(source);

  let kind: DocumentKind = "fragment";
  let preamble = "";
  let postamble = "";
  let body = source;

  if (beginDocMatch && endDocMatch && endDocMatch.index >= beginDocMatch.index) {
    kind = "complete";
    const bodyStart = beginDocMatch.index + beginDocMatch[0].length;
    preamble = source.slice(0, bodyStart);
    body = source.slice(bodyStart, endDocMatch.index);
    postamble = source.slice(endDocMatch.index);
  }

  const blocks: VisualBlock[] = [];
  let cursor = 0;
  let blockIndex = 0;

  const nextId = () => `block-${blockIndex++}`;

  while (cursor < body.length) {
    // Consume leading whitespace
    const wsStart = cursor;
    while (cursor < body.length && /\s/.test(body[cursor] ?? "")) {
      cursor++;
    }
    const leadingWhitespace = body.slice(wsStart, cursor);
    if (cursor >= body.length) {
      return {
        kind,
        preamble,
        postamble,
        trailingWhitespace: leadingWhitespace,
        blocks,
      };
    }

    const rest = body.slice(cursor);

    // 1. Comment line(s)
    if (rest.startsWith("%")) {
      let end = cursor;
      while (end < body.length) {
        const nl = body.indexOf("\n", end);
        const lineEnd = nl === -1 ? body.length : nl + 1;
        end = lineEnd;
        const nextLine = body.slice(end).trimStart();
        if (!body.slice(end).startsWith("%") || nextLine.length === 0) {
          break;
        }
      }
      const raw = body.slice(cursor, end).replace(/\n$/, "");
      // Adjust cursor to keep trailing newline in next block's leadingWhitespace
      const rawLen = raw.length;
      blocks.push({
        id: nextId(),
        type: "opaque",
        summary: "Comment",
        leadingWhitespace,
        raw,
      });
      cursor += rawLen;
      continue;
    }

    // 2. Display math $$...$$
    if (rest.startsWith("$$")) {
      const closeIdx = body.indexOf("$$", cursor + 2);
      if (closeIdx !== -1) {
        const raw = body.slice(cursor, closeIdx + 2);
        const tex = body.slice(cursor + 2, closeIdx).trim();
        blocks.push({
          id: nextId(),
          type: "math",
          env: "$$",
          tex,
          leadingWhitespace,
          raw,
        });
        cursor = closeIdx + 2;
        continue;
      }
    }

    // 3. Display math \[...\]
    if (rest.startsWith("\\[")) {
      const closeIdx = body.indexOf("\\]", cursor + 2);
      if (closeIdx !== -1) {
        const raw = body.slice(cursor, closeIdx + 2);
        const tex = body.slice(cursor + 2, closeIdx).trim();
        blocks.push({
          id: nextId(),
          type: "math",
          env: "\\[",
          tex,
          leadingWhitespace,
          raw,
        });
        cursor = closeIdx + 2;
        continue;
      }
    }

    // 4. Headings
    let matchedHeading = false;
    for (const level of HEADING_COMMANDS) {
      const prefix = `\\${level}`;
      if (rest.startsWith(prefix)) {
        const afterCmd = rest.slice(prefix.length);
        const starred = afterCmd.startsWith("*");
        const braceOffset = prefix.length + (starred ? 1 : 0);
        if (rest[braceOffset] === "{") {
          const closeBrace = findMatchingBrace(body, cursor + braceOffset);
          if (closeBrace !== -1) {
            const raw = body.slice(cursor, closeBrace + 1);
            const title = body.slice(cursor + braceOffset + 1, closeBrace);
            blocks.push({
              id: nextId(),
              type: "heading",
              level,
              starred,
              title,
              leadingWhitespace,
              raw,
            });
            cursor = closeBrace + 1;
            matchedHeading = true;
            break;
          }
        }
      }
    }
    if (matchedHeading) continue;

    // 5. Environments \begin{env}...\end{env}
    const beginMatch = /^\\begin\{([^}]+)\}/.exec(rest);
    if (beginMatch) {
      const envName = beginMatch[1] ?? "";
      const endTag = `\\end{${envName}}`;
      let endIdx = -1;
      let depth = 1;
      let searchAt = cursor + beginMatch[0].length;
      const beginTag = `\\begin{${envName}}`;
      while (depth > 0) {
        const nextBegin = body.indexOf(beginTag, searchAt);
        const nextEnd = body.indexOf(endTag, searchAt);
        if (nextEnd === -1) break;
        if (nextBegin !== -1 && nextBegin < nextEnd) {
          depth++;
          searchAt = nextBegin + beginTag.length;
        } else {
          depth--;
          endIdx = depth === 0 ? nextEnd : -1;
          searchAt = nextEnd + endTag.length;
        }
      }
      if (endIdx !== -1) {
        const blockEnd = endIdx + endTag.length;
        const raw = body.slice(cursor, blockEnd);
        let innerStart = cursor + beginMatch[0].length;
        let placement: string | undefined;

        if (body[innerStart] === "[") {
          const closeBracket = findMatchingBracket(body, innerStart);
          if (closeBracket !== -1 && closeBracket < endIdx) {
            placement = body.slice(innerStart + 1, closeBracket);
            innerStart = closeBracket + 1;
          }
        }
        const envBody = body.slice(innerStart, endIdx);
        const id = nextId();

        if (
          (envName === "itemize" || envName === "enumerate") &&
          !/\\begin\{(?:itemize|enumerate|description)\}/.test(envBody)
        ) {
          blocks.push({
            id,
            type: "list",
            ordered: envName === "enumerate",
            options: placement,
            items: parseListItems(envBody, id),
            leadingWhitespace,
            raw,
          });
        } else if (MATH_ENVS.has(envName)) {
          blocks.push({
            id,
            type: "math",
            env: envName,
            tex: envBody.trim(),
            leadingWhitespace,
            raw,
          });
        } else if (envName === "figure" || envName === "figure*") {
          blocks.push(parseFigureBlock(raw, envName, envBody, placement, leadingWhitespace, id));
        } else if (envName === "table" || envName === "table*" || envName === "tabular") {
          blocks.push(parseTableBlock(raw, envName, envBody, placement, leadingWhitespace, id));
        } else {
          blocks.push({
            id,
            type: "opaque",
            summary: `\\begin{${envName}}`,
            leadingWhitespace,
            raw,
          });
        }
        cursor = blockEnd;
        continue;
      }
    }

    // 6. Standalone single-line command (e.g. \maketitle, \tableofcontents, \input{...}, \bibliography{...})
    if (rest.startsWith("\\")) {
      const lineEndIdx = body.indexOf("\n", cursor);
      const line = lineEndIdx === -1 ? body.slice(cursor) : body.slice(cursor, lineEndIdx);
      const trimmed = line.trim();
      const isKnownBlockCmd =
        /^\\(maketitle|tableofcontents|listoffigures|listoftables|newpage|clearpage|pagebreak|noindent|vspace|hspace|input|include|bibliography|bibliographystyle|addbibresource|label|usepackage|documentclass)\b/.test(
          trimmed,
        );
      if (isKnownBlockCmd) {
        blocks.push({
          id: nextId(),
          type: "opaque",
          summary: trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed,
          leadingWhitespace,
          raw: line,
        });
        cursor = lineEndIdx === -1 ? body.length : lineEndIdx;
        continue;
      }
    }

    // 7. Paragraph: read until blank line or next block start
    let paraEnd = cursor;
    while (paraEnd < body.length) {
      const nl = body.indexOf("\n", paraEnd);
      if (nl === -1) {
        paraEnd = body.length;
        break;
      }
      const nextLineStart = nl + 1;
      const nextNl = body.indexOf("\n", nextLineStart);
      const nextLine =
        nextNl === -1 ? body.slice(nextLineStart) : body.slice(nextLineStart, nextNl);
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.length === 0 || isBlockStart(nextTrimmed)) {
        paraEnd = nl;
        break;
      }
      paraEnd = nextLineStart;
    }

    const raw = body.slice(cursor, paraEnd);
    blocks.push({
      id: nextId(),
      type: "paragraph",
      inlines: parseInlines(raw),
      leadingWhitespace,
      raw,
    });
    cursor = paraEnd;
  }

  return {
    kind,
    preamble,
    postamble,
    trailingWhitespace: "",
    blocks,
  };
}

function serializeBlockContent(block: VisualBlock): string {
  if (!block.dirty) {
    return block.raw;
  }

  switch (block.type) {
    case "heading": {
      const star = block.starred ? "*" : "";
      return `\\${block.level}${star}{${block.title}}`;
    }
    case "paragraph":
      return serializeInlines(block.inlines);
    case "list": {
      const env = block.ordered ? "enumerate" : "itemize";
      const opts = block.options !== undefined ? `[${block.options}]` : "";
      const items = block.items
        .map((item) => {
          const itemOpt = item.optional !== undefined ? `[${item.optional}]` : "";
          return `  \\item${itemOpt} ${serializeInlines(item.inlines)}`;
        })
        .join("\n");
      return `\\begin{${env}}${opts}\n${items}\n\\end{${env}}`;
    }
    case "math": {
      if (block.env === "$$") {
        return `$$\n${block.tex}\n$$`;
      }
      if (block.env === "\\[") {
        return `\\[\n${block.tex}\n\\]`;
      }
      return `\\begin{${block.env}}\n${block.tex}\n\\end{${block.env}}`;
    }
    case "figure": {
      // Preserve original figure structure, updating caption/label/imagePath if changed
      let next = block.raw;
      if (block.caption !== undefined) {
        const capMatch = /\\caption\{/.exec(next);
        if (capMatch) {
          const openIdx = capMatch.index + "\\caption".length;
          const closeIdx = findMatchingBrace(next, openIdx);
          if (closeIdx !== -1) {
            next = `${next.slice(0, openIdx + 1)}${block.caption}${next.slice(closeIdx)}`;
          }
        } else if (block.caption) {
          next = next.replace(
            /\\end\{figure\*?\}/,
            (end) => `  \\caption{${block.caption}}\n${end}`,
          );
        }
      }
      if (block.label !== undefined) {
        if (/\\label\{[^}]*\}/.test(next))
          next = next.replace(/\\label\{[^}]*\}/, () => `\\label{${block.label}}`);
        else if (block.label)
          next = next.replace(/\\end\{figure\*?\}/, (end) => `  \\label{${block.label}}\n${end}`);
      }
      if (block.imagePath !== undefined) {
        next = next.replace(
          /\\includegraphics(\[[^\]]*\])?\{[^}]*\}/,
          (_, options: string | undefined) =>
            `\\includegraphics${options ?? ""}{${block.imagePath}}`,
        );
      }
      return next;
    }
    case "table": {
      let next = block.raw;
      if (block.caption !== undefined) {
        const capMatch = /\\caption\{/.exec(next);
        if (capMatch) {
          const openIdx = capMatch.index + "\\caption".length;
          const closeIdx = findMatchingBrace(next, openIdx);
          if (closeIdx !== -1) {
            next = `${next.slice(0, openIdx + 1)}${block.caption}${next.slice(closeIdx)}`;
          }
        }
      }
      if (block.label !== undefined) {
        next = next.replace(/\\label\{[^}]*\}/, () => `\\label{${block.label}}`);
      }
      return next;
    }
    case "opaque":
      return block.raw;
  }
}

/**
 * Serialize a VisualLatexDocument back to LaTeX source.
 * Untouched blocks (`!block.dirty`) emit their exact original `raw` string.
 */
export function serializeVisualLatex(doc: VisualLatexDocument): string {
  const body =
    doc.blocks
      .map((block) => `${block.leadingWhitespace}${serializeBlockContent(block)}`)
      .join("") + doc.trailingWhitespace;

  if (doc.kind === "complete") {
    return `${doc.preamble}${body}${doc.postamble}`;
  }
  return body;
}
