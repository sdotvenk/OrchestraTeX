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
};

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
          const mapped = PROVIDER_LABELS[normalizedProvider] ?? {
            author: providerId ? "custom" : "you",
            label: providerId || "Agent",
          };
          const title =
            typeof record.title === "string" && record.title.trim().length > 0
              ? record.title.trim()
              : id;
          const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
          const phase = typeof record.phase === "string" ? record.phase : undefined;

          return {
            kind: "agentTurn",
            title,
            author: mapped.author,
            authorLabel: mapped.label,
            providerId,
            threadId,
            phase,
          };
        }
      }
    } catch {
      // Fall through to manual/safety parsing
    }
  }

  if (id.startsWith("safety-") || trimmed.toLowerCase().includes("safety checkpoint")) {
    return {
      kind: "safety",
      title: trimmed || id,
      author: "you",
      authorLabel: "Safety",
    };
  }

  return {
    kind: "manual",
    title: trimmed || id,
    author: "you",
    authorLabel: "You",
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
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
      const parts = line.split(" ");
      const bPath = parts[3]?.startsWith("b/") ? parts[3].slice(2) : (parts[3] ?? "unknown");
      currentFile = {
        path: bPath,
        headerLines: [line],
        hunkBlocks: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("@@ ")) {
      flushHunk();
      currentHunk = [line];
      continue;
    }

    if (currentHunk) {
      currentHunk.push(line);
    } else {
      if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
        currentFile.path = line.slice(6).replace(/\t$/, "");
      }
      currentFile.headerLines.push(line);
    }
  }

  flushFile();
  return files;
}
