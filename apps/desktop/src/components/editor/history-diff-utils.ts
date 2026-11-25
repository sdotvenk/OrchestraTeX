export type CheckpointAuthorKind = "you" | "claude" | "codex" | "antigravity" | "custom";

export type ParsedCheckpointMessage = {
  kind: "agentTurn" | "safety" | "manual";
  title: string;
  author: CheckpointAuthorKind;
  authorLabel: string;
  providerId?: string;
  threadId?: string;
  phase?: "before" | "after" | string;
};

export type DiffLine = {
  type: "context" | "add" | "del";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

export type DiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  rawPatch: string;
};

export type ParsedFileDiff = {
  path: string;
  headerLines: string[];
  hunks: DiffHunk[];
};

const PROVIDER_LABELS: Record<string, { author: CheckpointAuthorKind; label: string }> = {
  claude: { author: "claude", label: "Claude" },
  "claude-code": { author: "claude", label: "Claude" },
  codex: { author: "codex", label: "Codex" },
  openai: { author: "codex", label: "Codex" },
  antigravity: { author: "antigravity", label: "Antigravity" },
  custom: { author: "custom", label: "Custom ACP" },
  "custom-acp": { author: "custom", label: "Custom ACP" },
  user: { author: "you", label: "You" },
  you: { author: "you", label: "You" },
};

function extractHarnessPrefix(rawTitle: string): {
  author?: CheckpointAuthorKind;
  authorLabel?: string;
  title: string;
} {
  const match =
    /^\[(claude|claude-code|codex|openai|antigravity|custom|custom-acp|user|you)\]\s*(.*)$/i.exec(
      rawTitle.trim(),
    );
  if (!match) {
    return { title: rawTitle.trim() };
  }
  const key = (match[1] ?? "").toLowerCase();
  const mapped = PROVIDER_LABELS[key];
  const stripped = (match[2] ?? "").trim();
  return {
    author: mapped?.author,
    authorLabel: mapped?.label,
    title: stripped || rawTitle.trim(),
  };
}

export function parseCheckpointMessage(id: string, rawMessage: string): ParsedCheckpointMessage {
  const trimmed = rawMessage.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "agentTurn") {
          const providerId = typeof record.providerId === "string" ? record.providerId : undefined;
          const normalizedProvider = providerId?.toLowerCase() ?? "";
          const rawTitle =
            typeof record.title === "string" && record.title.trim().length > 0
              ? record.title.trim()
              : id;
          const prefixed = extractHarnessPrefix(rawTitle);
          const mapped = PROVIDER_LABELS[normalizedProvider] ?? {
            author: prefixed.author ?? (providerId ? "custom" : "you"),
            label: prefixed.authorLabel ?? (providerId || "Agent"),
          };
          const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
          const phase = typeof record.phase === "string" ? record.phase : undefined;

          return {
            kind: "agentTurn",
            title: prefixed.title,
            author: mapped.author,
            authorLabel: mapped.label,
            providerId,
            threadId,
            phase,
          };
        }
        if (typeof record.title === "string" && record.title.trim().length > 0) {
          const isSafety = record.type === "safety" || id.startsWith("safety-");
          const prefixed = extractHarnessPrefix(record.title.trim());
          return {
            kind: isSafety ? "safety" : "manual",
            title: prefixed.title,
            author: prefixed.author ?? "you",
            authorLabel: isSafety ? "Safety" : (prefixed.authorLabel ?? "You"),
          };
        }
      }
    } catch {
      // Fall through to manual/safety parsing
    }
  }

  const prefixed = extractHarnessPrefix(trimmed);
  if (id.startsWith("safety-") || trimmed.toLowerCase().includes("safety checkpoint")) {
    return {
      kind: "safety",
      title: prefixed.title || id,
      author: prefixed.author ?? "you",
      authorLabel: "Safety",
    };
  }

  return {
    kind: prefixed.author && prefixed.author !== "you" ? "agentTurn" : "manual",
    title: prefixed.title || id,
    author: prefixed.author ?? "you",
    authorLabel: prefixed.authorLabel ?? "You",
  };
}

export function formatCheckpointTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const diffMs = now.getTime() - date.getTime();
  if (diffMs > 0 && diffMs < 6 * 86_400_000) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function decodeGitPatchPath(raw: string, stripDiffPrefix = true): string {
  const untabbed = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  const unquoted = (() => {
    if (untabbed.length >= 2 && untabbed.startsWith('"') && untabbed.endsWith('"')) {
      const inner = untabbed.slice(1, -1);
      const bytes: number[] = [];
      const encoder = new TextEncoder();
      for (let i = 0; i < inner.length; ) {
        const ch = inner[i];
        if (ch === "\\" && i + 1 < inner.length) {
          const next = inner[i + 1];
          if (next && next >= "0" && next <= "7") {
            const oct = inner.slice(i + 1, i + 4);
            if (/^[0-7]{3}$/.test(oct)) {
              bytes.push(Number.parseInt(oct, 8));
              i += 4;
              continue;
            }
          }
          const escapes: Record<string, number> = {
            n: 10,
            r: 13,
            t: 9,
            "\\": 92,
            '"': 34,
            b: 8,
            f: 12,
          };
          if (next && escapes[next] !== undefined) {
            bytes.push(escapes[next]);
            i += 2;
            continue;
          }
        }
        const cp = inner.codePointAt(i);
        if (cp === undefined) break;
        const charStr = String.fromCodePoint(cp);
        if (cp < 0x80) {
          bytes.push(cp);
        } else {
          for (const b of encoder.encode(charStr)) bytes.push(b);
        }
        i += charStr.length;
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    return untabbed;
  })();
  return stripDiffPrefix ? unquoted.replace(/^[ab]\//, "") : unquoted;
}

function extractDiffGitBPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  if (rest.endsWith('"')) {
    let i = rest.length - 2;
    while (i >= 0) {
      if (rest[i] === '"') {
        let backslashes = 0;
        for (let k = i - 1; k >= 0 && rest[k] === "\\"; k -= 1) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) {
          return decodeGitPatchPath(rest.slice(i));
        }
      }
      i -= 1;
    }
  }
  const idx = rest.lastIndexOf(" b/");
  if (idx !== -1) {
    return decodeGitPatchPath(rest.slice(idx + 1));
  }
  const parts = rest.split(" ");
  return decodeGitPatchPath(parts[parts.length - 1] ?? "unknown");
}

export function parseUnifiedDiff(diffText: string): ParsedFileDiff[] {
  if (!diffText.trim()) {
    return [];
  }

  const lines = diffText.split("\n");
  const files: ParsedFileDiff[] = [];
  let currentFile: { path: string; headerLines: string[]; hunkBlocks: string[][] } | null = null;
  let currentHunk: string[] | null = null;

  const flushHunk = () => {
    if (currentFile && currentHunk && currentHunk.length > 0) {
      currentFile.hunkBlocks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (!currentFile) return;

    const hunks: DiffHunk[] = [];
    for (let i = 0; i < currentFile.hunkBlocks.length; i++) {
      const block = currentFile.hunkBlocks[i];
      if (!block || block.length === 0) continue;
      const header = block[0] ?? "";
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
      const oldStart = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      const oldCount = match ? Number.parseInt(match[2] ?? "1", 10) : 0;
      const newStart = match ? Number.parseInt(match[3] ?? "0", 10) : 0;
      const newCount = match ? Number.parseInt(match[4] ?? "1", 10) : 0;

      let oldLine = oldStart;
      let newLine = newStart;
      const parsedLines: DiffLine[] = [];

      for (let j = 1; j < block.length; j++) {
        const line = block[j] ?? "";
        if (line.startsWith("+")) {
          parsedLines.push({
            type: "add",
            content: line.slice(1),
            oldLineNumber: null,
            newLineNumber: newLine,
          });
          newLine += 1;
        } else if (line.startsWith("-")) {
          parsedLines.push({
            type: "del",
            content: line.slice(1),
            oldLineNumber: oldLine,
            newLineNumber: null,
          });
          oldLine += 1;
        } else if (line.startsWith("\\")) {
          // "\ No newline at end of file" - keep in rawPatch, skip display line
        } else {
          parsedLines.push({
            type: "context",
            content: line.startsWith(" ") ? line.slice(1) : line,
            oldLineNumber: oldLine,
            newLineNumber: newLine,
          });
          oldLine += 1;
          newLine += 1;
        }
      }

      const rawPatch = `${currentFile.headerLines.join("\n")}\n${block.join("\n")}\n`;
      hunks.push({
        id: `${currentFile.path}::${i}`,
        header,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: parsedLines,
        rawPatch,
      });
    }

    files.push({
      path: currentFile.path,
      headerLines: currentFile.headerLines,
      hunks,
    });
    currentFile = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      currentFile = {
        path: extractDiffGitBPath(line),
        headerLines: [line],
        hunkBlocks: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (!currentHunk && line.startsWith("rename to ")) {
      currentFile.path = decodeGitPatchPath(line.slice("rename to ".length), false);
    }

    if (line.startsWith("@@ ")) {
      flushHunk();
      currentHunk = [line];
      continue;
    }

    if (currentHunk) {
      currentHunk.push(line);
    } else {
      if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
        currentFile.path = decodeGitPatchPath(line.slice(4));
      } else if (
        line.startsWith("--- ") &&
        !line.startsWith("--- /dev/null") &&
        currentFile.path === "unknown"
      ) {
        currentFile.path = decodeGitPatchPath(line.slice(4));
      }
      currentFile.headerLines.push(line);
    }
  }

  flushFile();
  return files;
}
