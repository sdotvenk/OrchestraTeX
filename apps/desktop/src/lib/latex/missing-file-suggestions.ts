import { pathSync } from "@/lib/path";
import type { LatexDiagnostic } from "./types";

export interface RecentRenameRecord {
  oldPath: string;
  newPath: string;
  renamedAt?: number;
}

export interface MissingFileSuggestion {
  diagnostic: LatexDiagnostic;
  missingPath: string;
  suggestedFile: string;
  suggestedArg: string;
  reason: "renamed" | "typo" | "moved";
  confidence: number;
  line: number;
  column?: number;
  startOffset?: number;
  endOffset?: number;
  before?: string;
  after?: string;
}

export interface FindMissingFileSuggestionsOptions {
  diagnostic: LatexDiagnostic;
  projectFiles: string[];
  sourceContent?: string;
  projectRoot?: string;
  recentRenames?: RecentRenameRecord[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function toProjectRelative(filePath: string, projectRoot?: string): string {
  const posix = toPosix(filePath).replace(/^\.\//, "");
  if (!projectRoot) return posix;
  const normRoot = toPosix(projectRoot).replace(/\/+$/, "");
  if (posix.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return posix.slice(normRoot.length + 1);
  }
  return posix;
}

/**
 * Extract the missing file path from a LaTeX compiler diagnostic message.
 */
export function extractMissingFilePath(message: string): string | null {
  const patterns = [
    /File\s+`([^']+)'\s+not found/i,
    /File\s+"([^"]+)"\s+not found/i,
    /File\s+([^\s'"]+)\s+not found/i,
    /I can't find file\s+`([^']+)'/i,
    /Cannot find file\s+'([^']+)'/i,
    /Cannot find file\s+"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return toPosix(match[1].trim());
    }
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j] ?? 0, dp[j - 1] ?? 0);
      }
      prev = temp;
    }
  }

  return dp[n] ?? 0;
}

function stripTexExt(p: string): string {
  return p.toLowerCase().endsWith(".tex") ? p.slice(0, -4) : p;
}

function findReferenceOnLine(
  sourceContent: string,
  targetLine: number,
  missingPath: string,
): {
  command: "input" | "include";
  arg: string;
  fullMatch: string;
  column: number;
  startOffset: number;
  endOffset: number;
} | null {
  const lines = sourceContent.split("\n");
  const lineText = lines[targetLine - 1];
  if (lineText === undefined) return null;

  let lineStartOffset = 0;
  for (let i = 0; i < targetLine - 1; i++) {
    lineStartOffset += (lines[i]?.length ?? 0) + 1;
  }

  const missingNoExt = stripTexExt(missingPath).toLowerCase();
  const cmdRegex = /\\(input|include)\s*\{([^}]+)\}/g;

  for (const match of lineText.matchAll(cmdRegex)) {
    const arg = match[2]?.trim();
    if (!arg) continue;
    const argNoExt = stripTexExt(toPosix(arg).replace(/^\.\//, "")).toLowerCase();
    if (
      argNoExt === missingNoExt ||
      pathSync.basename(argNoExt) === pathSync.basename(missingNoExt)
    ) {
      const relIdx = match.index ?? 0;
      return {
        command: match[1] as "input" | "include",
        arg,
        fullMatch: match[0],
        column: relIdx + 1,
        startOffset: lineStartOffset + relIdx,
        endOffset: lineStartOffset + relIdx + match[0].length,
      };
    }
  }

  return null;
}

/**
 * Find a single actionable missing-file suggestion for a LaTeX diagnostic,
 * or `null` if no plausible candidate exists.
 */
export function findMissingFileSuggestion(
  options: FindMissingFileSuggestionsOptions,
): MissingFileSuggestion | null {
  const { diagnostic, projectFiles, sourceContent, projectRoot, recentRenames = [] } = options;

  const missingRaw = extractMissingFilePath(diagnostic.message);
  if (!missingRaw) return null;

  const relMissing = toProjectRelative(missingRaw, projectRoot);
  const relMissingWithTex = relMissing.toLowerCase().endsWith(".tex")
    ? relMissing
    : `${relMissing}.tex`;

  const relProjectFiles = projectFiles.map((f) => toProjectRelative(f, projectRoot));

  // If the exact file already exists, no suggestion is needed.
  if (relProjectFiles.some((f) => f.toLowerCase() === relMissingWithTex.toLowerCase())) {
    return null;
  }

  let bestMatch: {
    file: string;
    reason: "renamed" | "typo" | "moved";
    confidence: number;
  } | null = null;

  // 1. Check recent renames first
  for (const rename of recentRenames) {
    const relOld = toProjectRelative(rename.oldPath, projectRoot);
    const relNew = toProjectRelative(rename.newPath, projectRoot);
    if (
      relOld.toLowerCase() === relMissingWithTex.toLowerCase() &&
      relProjectFiles.some((f) => f.toLowerCase() === relNew.toLowerCase())
    ) {
      bestMatch = { file: relNew, reason: "renamed", confidence: 1.0 };
      break;
    }
  }

  // 2. Check moved file (exact basename match in a different directory, only if unique)
  if (!bestMatch) {
    const missingBase = pathSync.basename(relMissingWithTex).toLowerCase();
    const sameBase = relProjectFiles.filter(
      (f) => pathSync.basename(f).toLowerCase() === missingBase,
    );
    if (sameBase.length === 1 && sameBase[0]) {
      bestMatch = { file: sameBase[0], reason: "moved", confidence: 0.9 };
    }
  }

  // 3. Check fuzzy/typo match on full relative path
  if (!bestMatch) {
    const targetNoExt = stripTexExt(relMissingWithTex).toLowerCase();
    let bestDist = Number.POSITIVE_INFINITY;
    let bestFile: string | null = null;
    let tie = false;

    for (const candidate of relProjectFiles) {
      const candNoExt = stripTexExt(candidate).toLowerCase();
      const dist = levenshtein(targetNoExt, candNoExt);
      const maxLen = Math.max(targetNoExt.length, candNoExt.length);
      const threshold = Math.max(1, Math.floor(maxLen * 0.3));
      if (dist <= threshold) {
        if (dist < bestDist) {
          bestDist = dist;
          bestFile = candidate;
          tie = false;
        } else if (dist === bestDist) {
          tie = true;
        }
      }
    }

    if (bestFile && !tie) {
      const maxLen = Math.max(targetNoExt.length, stripTexExt(bestFile).length);
      bestMatch = {
        file: bestFile,
        reason: "typo",
        confidence: Number((1 - bestDist / Math.max(1, maxLen)).toFixed(2)),
      };
    }
  }

  if (!bestMatch) return null;

  const refLoc = sourceContent
    ? findReferenceOnLine(sourceContent, diagnostic.line, relMissing)
    : null;

  const hadTexExt = refLoc
    ? refLoc.arg.toLowerCase().endsWith(".tex")
    : missingRaw.toLowerCase().endsWith(".tex");
  const hadDotSlash = refLoc ? refLoc.arg.startsWith("./") : false;

  let suggestedArg = bestMatch.file;
  if (!hadTexExt && suggestedArg.toLowerCase().endsWith(".tex")) {
    suggestedArg = suggestedArg.slice(0, -4);
  }
  if (hadDotSlash && !suggestedArg.startsWith("./")) {
    suggestedArg = `./${suggestedArg}`;
  }

  return {
    diagnostic,
    missingPath: relMissing,
    suggestedFile: bestMatch.file,
    suggestedArg,
    reason: bestMatch.reason,
    confidence: bestMatch.confidence,
    line: diagnostic.line,
    ...(refLoc
      ? {
          column: refLoc.column,
          startOffset: refLoc.startOffset,
          endOffset: refLoc.endOffset,
          before: refLoc.fullMatch,
          after: `\\${refLoc.command}{${suggestedArg}}`,
        }
      : {}),
  };
}
