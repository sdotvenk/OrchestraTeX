export interface LatexOutlineItem {
  id: string;
  level: number;
  title: string;
  line: number;
  kind: "heading" | "input";
  command: string;
  targetFile?: string;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

function stripLineComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "%") {
      // Count preceding backslashes
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

function extractBalancedBraces(text: string, openIdx: number): string | null {
  if (text[openIdx] !== "{") return null;
  let depth = 0;
  let result = "";
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth > 0) result += ch;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return result;
      }
      result += ch;
    } else if (depth > 0) {
      result += ch;
    }
  }
  return null;
}

function cleanLatexTitle(raw: string): string {
  return raw
    .replace(/\\(?:textbf|textit|emph|texttt|textrm|textsc|underline)\{([^}]*)\}/g, "$1")
    .replace(/\\texorpdfstring\{([^}]*)\}\{[^}]*\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLatexOutline(source: string): LatexOutlineItem[] {
  const items: LatexOutlineItem[] = [];
  const lines = source.split("\n");

  const headingRegex =
    /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\s*\[[^\]]*\])?\s*\{/g;
  const inputRegex = /\\(input|include|subfile)\s*\{([^}]+)\}/g;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const rawLine = lines[i] ?? "";
    const code = stripLineComment(rawLine);
    if (!code.trim()) continue;

    headingRegex.lastIndex = 0;
    let match = headingRegex.exec(code);
    while (match !== null) {
      const cmd = match[1] ?? "section";
      const openBraceIdx = match.index + match[0].length - 1;
      const inside = extractBalancedBraces(code, openBraceIdx);
      if (inside !== null) {
        const title = cleanLatexTitle(inside) || `(${cmd})`;
        items.push({
          id: `heading-${lineNum}-${match.index}-${cmd}`,
          level: SECTION_LEVELS[cmd] ?? 2,
          title,
          line: lineNum,
          kind: "heading",
          command: cmd,
        });
      }
      match = headingRegex.exec(code);
    }

    inputRegex.lastIndex = 0;
    let inMatch = inputRegex.exec(code);
    while (inMatch !== null) {
      const cmd = inMatch[1] ?? "input";
      const target = (inMatch[2] ?? "").trim();
      if (target) {
        const normalizedTarget = target.endsWith(".tex") ? target : `${target}.tex`;
        items.push({
          id: `input-${lineNum}-${inMatch.index}-${target}`,
          level: 2,
          title: normalizedTarget,
          line: lineNum,
          kind: "input",
          command: cmd,
          targetFile: normalizedTarget,
        });
      }
      inMatch = inputRegex.exec(code);
    }
  }

  return items;
}
