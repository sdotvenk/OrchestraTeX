export interface LatexWordCountResult {
  words: number;
  characters: number;
  lines: number;
}

const MATH_AND_VERBATIM_ENVS = [
  "equation",
  "equation\\*",
  "align",
  "align\\*",
  "alignat",
  "alignat\\*",
  "gather",
  "gather\\*",
  "multline",
  "multline\\*",
  "eqnarray",
  "eqnarray\\*",
  "verbatim",
  "verbatim\\*",
  "lstlisting",
  "minted",
  "tikzpicture",
];

function stripUnescapedComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "%") {
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
    })
    .join("\n");
}

function extractBodyContent(source: string): string {
  const beginDoc = source.match(/\\begin\{document\}/);
  if (!beginDoc || beginDoc.index === undefined) {
    return source;
  }
  const afterBegin = source.slice(beginDoc.index + beginDoc[0].length);
  const endDoc = afterBegin.match(/\\end\{document\}/);
  if (!endDoc || endDoc.index === undefined) {
    return afterBegin;
  }
  return afterBegin.slice(0, endDoc.index);
}

export function countLatexWords(source: string): LatexWordCountResult {
  const lines = source.length === 0 ? 0 : source.split("\n").length;
  const noComments = stripUnescapedComments(source);
  let body = extractBodyContent(noComments);

  // Strip display math & verbatim environments
  for (const env of MATH_AND_VERBATIM_ENVS) {
    const re = new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g");
    body = body.replace(re, " ");
  }

  // Strip inline & display math expressions
  body = body
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ");

  // Remove reference / citation / structural commands along with their key/path arguments
  body = body.replace(
    /\\(?:cite|citep|citet|citealp|citealt|nocite|ref|eqref|pageref|autoref|cref|Cref|label|input|include|subfile|includegraphics|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|begin|end|hspace|vspace|setlength|newcommand|renewcommand|url|href)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g,
    " ",
  );

  // Remove optional bracket args like [htbp] or [width=\linewidth]
  body = body.replace(/\[[^\]\n]{0,120}\]/g, " ");

  // Keep inner text for common formatting & sectioning macros
  for (let pass = 0; pass < 3; pass += 1) {
    body = body.replace(
      /\\(?:textbf|textit|emph|texttt|textrm|textsc|underline|title|section|subsection|subsubsection|paragraph|chapter|part|caption|footnote|text)\*?\{([^{}]*)\}/g,
      " $1 ",
    );
  }

  // Remove remaining LaTeX command names (e.g. \maketitle, \item, \\, \LaTeX)
  body = body
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/\\[^\w\s]/g, " ")
    .replace(/[{}~]/g, " ");

  const trimmed = body.trim();
  const words = trimmed
    ? trimmed.split(/\s+/).filter((w) => /[A-Za-z0-9\u4e00-\u9fff]/.test(w)).length
    : 0;
  const characters = trimmed.replace(/\s+/g, " ").length;

  return { words, characters, lines };
}
