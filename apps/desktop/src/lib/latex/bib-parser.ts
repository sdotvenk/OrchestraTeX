export interface BibEntry {
  key: string;
  entryType: string;
  title?: string;
  author?: string;
  year?: string;
  file?: string;
}

export interface LabelEntry {
  key: string;
  file: string;
  line: number;
}

function extractField(block: string, fieldName: string): string | undefined {
  const re = new RegExp(`\\b${fieldName}\\s*=\\s*`, "i");
  const m = re.exec(block);
  if (!m) return undefined;
  let pos = m.index + m[0].length;
  while (pos < block.length && /\s/.test(block[pos] ?? "")) pos += 1;
  const opener = block[pos];
  if (opener === "{") {
    let depth = 0;
    let out = "";
    for (let i = pos; i < block.length; i += 1) {
      const ch = block[i];
      if (ch === "{") {
        if (depth > 0) out += ch;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return out.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
        }
        out += ch;
      } else if (depth > 0) {
        out += ch;
      }
    }
  } else if (opener === '"') {
    const endIdx = block.indexOf('"', pos + 1);
    if (endIdx > pos) {
      return block
        .slice(pos + 1, endIdx)
        .replace(/\s+/g, " ")
        .trim();
    }
  } else {
    const bare = block.slice(pos).match(/^([A-Za-z0-9_-]+)/);
    return bare?.[1];
  }
  return undefined;
}

export function parseBibTeXEntries(content: string, file?: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const seen = new Set<string>();
  const headerRe = /@([A-Za-z]+)\s*[{(]\s*([^,\s{}]+)\s*,/g;

  let match = headerRe.exec(content);
  while (match !== null) {
    const entryType = (match[1] ?? "").toLowerCase();
    const key = (match[2] ?? "").trim();
    if (entryType !== "comment" && entryType !== "preamble" && entryType !== "string" && key) {
      const nextHeaderOffset = content.indexOf("\n@", match.index + match[0].length);
      const blockEnd = nextHeaderOffset >= 0 ? nextHeaderOffset : content.length;
      const block = content.slice(match.index, blockEnd);

      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          key,
          entryType,
          title: extractField(block, "title"),
          author: extractField(block, "author"),
          year: extractField(block, "year"),
          file,
        });
      }
    }
    match = headerRe.exec(content);
  }

  return entries;
}

export function parseLatexLabels(content: string, file: string): LabelEntry[] {
  const labels: LabelEntry[] = [];
  const lines = content.split("\n");
  const labelRe = /\\label\{([^}]+)\}/g;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const commentIdx = rawLine.indexOf("%");
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    labelRe.lastIndex = 0;
    let m = labelRe.exec(code);
    while (m !== null) {
      const key = (m[1] ?? "").trim();
      if (key) {
        labels.push({
          key,
          file,
          line: i + 1,
        });
      }
      m = labelRe.exec(code);
    }
  }

  return labels;
}
