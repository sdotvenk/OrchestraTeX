import { describe, expect, it } from "vitest";
import { countLatexWords } from "./word-count";

describe("countLatexWords", () => {
  it("ignores preamble, comments, math, and reference keys while counting body words", () => {
    const tex = `
\\documentclass{article}
\\usepackage{amsmath}
\\title{Ignored Preamble}
\\begin{document}
\\section{Introduction}
This paper presents \\textbf{fast} training \\cite{smith2024} in Section~\\ref{sec:method}.
% This whole comment should be excluded
The loss is $L = x^2 + 1$.
\\begin{equation}
E = mc^2
\\end{equation}
\\end{document}
`;

    // Body readable words: Introduction, This, paper, presents, fast, training, in, Section, The, loss, is => 11
    const counts = countLatexWords(tex);
    expect(counts.words).toBe(11);
    expect(counts.lines).toBeGreaterThan(10);
  });

  it("handles fragments without begin/end document", () => {
    const tex = `\\subsection{Experiments}\nWe evaluate five baselines across three datasets.`;
    expect(countLatexWords(tex).words).toBe(8);
  });
});
