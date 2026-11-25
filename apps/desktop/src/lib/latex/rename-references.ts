import { pathSync, pathsEqual } from "@/lib/path";

export interface TexFileInput {
  path: string;
  content: string;
}

export interface PlannedReferenceEdit {
  filePath: string;
  command: "input" | "include";
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
  before: string;
  after: string;
  beforeArg: string;
  afterArg: string;
}

export interface PlanRenameReferencesOptions {
  oldPath: string;
  newPath: string;
  isDirectory?: boolean;
  projectRoot?: string;
  mainFile?: string | null;
  files: TexFileInput[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, "");
}

function isWindowsLike(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.includes("\\");
}

function normalizeForCompare(p: string, windowsMode: boolean): string {
  const posix = stripTrailingSlashes(toPosix(p)).replace(/^\.\//, "");
  return windowsMode ? posix.toLowerCase() : posix;
}

function toProjectRelative(filePath: string, projectRoot?: string): string {
  if (!projectRoot) {
    return toPosix(filePath).replace(/^\.\//, "");
  }
  const windowsMode = isWindowsLike(filePath) || isWindowsLike(projectRoot);
  const normFile = stripTrailingSlashes(toPosix(filePath));
  const normRoot = stripTrailingSlashes(toPosix(projectRoot));
  const cmpFile = windowsMode ? normFile.toLowerCase() : normFile;
  const cmpRoot = windowsMode ? normRoot.toLowerCase() : normRoot;

  if (cmpFile === cmpRoot) {
    return "";
  }
  if (cmpFile.startsWith(`${cmpRoot}/`)) {
    return normFile.slice(normRoot.length + 1);
  }
  return normFile.replace(/^\.\//, "");
}

function computeRelativePath(fromDir: string, toFile: string): string {
  const fromParts = fromDir ? toPosix(fromDir).split("/").filter(Boolean) : [];
  const toParts = toPosix(toFile).split("/").filter(Boolean);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = Array.from({ length: fromParts.length - common }, () => "..");
  const rest = toParts.slice(common);
  return [...ups, ...rest].join("/");
}

function resolveRelativePosix(baseDir: string, target: string): string | null {
  const combined = baseDir ? `${toPosix(baseDir)}/${toPosix(target)}` : toPosix(target);
  const parts = combined.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

/**
 * Build a boolean mask of character offsets in LaTeX source that are inside
 * `%` line comments, `\verb` inline verbatim, or verbatim-like environments.
 */
function buildIgnoredMask(content: string): Uint8Array {
  const len = content.length;
  const mask = new Uint8Array(len);

  // 1. Mark verbatim-like environments: verbatim, verbatim*, lstlisting, minted
  const envRegex = /\\begin\{(verbatim\*?|lstlisting|minted)\}([\s\S]*?)\\end\{\1\}/g;
  for (const match of content.matchAll(envRegex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    mask.fill(1, start, end);
  }

  // 2. Scan line-by-line for % comments and \verb<delim>...<delim>
  let i = 0;
  while (i < len) {
    if (mask[i] === 1) {
      i++;
      continue;
    }

    // Check for \verb or \verb*
    if (content.startsWith("\\verb", i)) {
      const afterVerb = i + 5;
      const delimIdx = content[afterVerb] === "*" ? afterVerb + 1 : afterVerb;
      const delim = content[delimIdx];
      if (delim && delim !== "\n" && delim !== "\r") {
        const closeIdx = content.indexOf(delim, delimIdx + 1);
        const end = closeIdx !== -1 ? closeIdx + 1 : len;
        mask.fill(1, i, end);
        i = end;
        continue;
      }
    }

    // Check for unescaped % comment
    if (content[i] === "%") {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && content[j] === "\\") {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        const newlineIdx = content.indexOf("\n", i);
        const end = newlineIdx !== -1 ? newlineIdx : len;
        mask.fill(1, i, end);
        i = end;
        continue;
      }
    }

    i++;
  }

  return mask;
}

function getLineAndColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (content[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return {
    line,
    column: offset - lastNewline,
  };
}

function formatReplacementArg(
  newRelPath: string,
  hadTexExtension: boolean,
  hadDotSlash: boolean,
): string {
  let result = toPosix(newRelPath);
  if (!hadTexExtension && result.toLowerCase().endsWith(".tex")) {
    result = result.slice(0, -4);
  }
  if (hadDotSlash && !result.startsWith("./") && !result.startsWith("../")) {
    result = `./${result}`;
  }
  return result;
}

/**
 * Plan `\input{...}` and `\include{...}` reference edits across `.tex` files
 * after a file or directory rename, without mutating any files.
 */
export function planRenameReferences(options: PlanRenameReferencesOptions): PlannedReferenceEdit[] {
  const { oldPath, newPath, isDirectory = false, projectRoot, mainFile, files } = options;
  const windowsMode =
    isWindowsLike(oldPath) ||
    isWindowsLike(newPath) ||
    (projectRoot ? isWindowsLike(projectRoot) : false);

  const relOld = toProjectRelative(oldPath, projectRoot);
  const relNew = toProjectRelative(newPath, projectRoot);

  if (!relOld || !relNew || pathsEqual(relOld, relNew)) {
    return [];
  }

  const cmpOld = normalizeForCompare(relOld, windowsMode);
  const comparison = (path: string) => normalizeForCompare(path, windowsMode);
  const knownPaths = new Set(
    files.map((file) => comparison(toProjectRelative(file.path, projectRoot))),
  );
  const renamedPath = (path: string) => {
    const candidate = comparison(path);
    if (candidate === cmpOld) return relNew;
    if (isDirectory && candidate.startsWith(`${cmpOld}/`)) {
      return `${relNew}/${path.slice(relOld.length + 1)}`;
    }
    return path;
  };
  const relMain = mainFile ? toProjectRelative(mainFile, projectRoot) : null;
  const compileDir = relMain ? pathSync.dirname(relMain) : "";
  const nextCompileDir = relMain ? pathSync.dirname(renamedPath(relMain)) : "";
  const edits: PlannedReferenceEdit[] = [];

  const cmdRegex = /\\(input|include)\s*\{([^}]+)\}/g;

  for (const file of files) {
    const relFile = toProjectRelative(file.path, projectRoot);
    const fileDir = pathSync.dirname(relFile);
    const normFileDir = fileDir === "." ? "" : toPosix(fileDir);
    const mask = buildIgnoredMask(file.content);

    for (const match of file.content.matchAll(cmdRegex)) {
      const fullMatch = match[0];
      const command = match[1] as "input" | "include";
      const rawArg = match[2];
      const startOffset = match.index ?? 0;

      if (rawArg === undefined || mask[startOffset] === 1) {
        continue;
      }
      let precedingSlashes = 0;
      for (let index = startOffset - 1; file.content[index] === "\\"; index--) {
        precedingSlashes++;
      }
      if (precedingSlashes % 2 !== 0) continue;

      const trimmedArg = rawArg.trim();
      if (!trimmedArg || /[\\{}#%]/.test(trimmedArg) || /^(?:\/|[a-z]:)/i.test(trimmedArg))
        continue;

      const hadDotSlash = trimmedArg.startsWith("./");
      const hadTexExtension = trimmedArg.toLowerCase().endsWith(".tex");
      const argWithTex = hadTexExtension ? trimmedArg : `${trimmedArg}.tex`;

      // Candidate 1: resolved relative to project root
      const rootResolved = resolveRelativePosix(compileDir, argWithTex);
      // Candidate 2: resolved relative to referencing file's directory
      const dirResolved = normFileDir
        ? resolveRelativePosix(normFileDir, argWithTex)
        : rootResolved;

      let matchedNewTarget: string | null = null;
      let resolvedViaDir = false;

      if (isDirectory) {
        const prefix = `${cmpOld}/`;
        const cmpRootResolved = rootResolved ? comparison(rootResolved) : "";
        const cmpDirResolved = dirResolved ? comparison(dirResolved) : "";

        if (rootResolved && cmpRootResolved.startsWith(prefix)) {
          matchedNewTarget = `${relNew}/${rootResolved.slice(relOld.length + 1)}`;
          resolvedViaDir = false;
        } else if (normFileDir && dirResolved && cmpDirResolved.startsWith(prefix)) {
          matchedNewTarget = `${relNew}/${dirResolved.slice(relOld.length + 1)}`;
          resolvedViaDir = true;
        }
      } else {
        const cmpRootResolved = rootResolved ? comparison(rootResolved) : "";
        const cmpDirResolved = dirResolved ? comparison(dirResolved) : "";

        if (cmpRootResolved === cmpOld) {
          matchedNewTarget = relNew;
          resolvedViaDir = false;
        } else if (normFileDir && cmpDirResolved === cmpOld) {
          matchedNewTarget = relNew;
          resolvedViaDir = true;
        }
      }

      if (!matchedNewTarget) {
        continue;
      }
      if (resolvedViaDir && rootResolved && knownPaths.has(comparison(rootResolved))) continue;

      const baseDir = resolvedViaDir ? pathSync.dirname(renamedPath(relFile)) : nextCompileDir;
      const newRelArg = computeRelativePath(baseDir, matchedNewTarget);

      const afterArg = formatReplacementArg(newRelArg, hadTexExtension, hadDotSlash);
      if (afterArg === trimmedArg) {
        continue;
      }

      const argumentStart = fullMatch.indexOf("{") + 1;
      const after = `${fullMatch.slice(0, argumentStart)}${rawArg.replace(trimmedArg, () => afterArg)}}`;
      const { line, column } = getLineAndColumn(file.content, startOffset);

      edits.push({
        filePath: file.path,
        command,
        line,
        column,
        startOffset,
        endOffset: startOffset + fullMatch.length,
        before: fullMatch,
        after,
        beforeArg: trimmedArg,
        afterArg,
      });
    }
  }

  return edits;
}
