import { describe, expect, it } from "vitest";
import { parseLatexOutline } from "./outline";

describe("parseLatexOutline", () => {
  it("extracts headings, starred sections, optional short titles, and inputs while skipping comments", () => {
    const tex = `
% \\section{Commented Out}
\\title{Test Paper}
\\begin{document}
\\section[Intro]{Introduction to \\textbf{LaTeX}}
Some 100\\% real text here.
\\subsection*{Background \\texorpdfstring{Math}{Math}}
\\input{sections/method}
\\subsubsection{Ablation Study}
\\include{sections/appendix.tex}
\\end{document}
`;

    const outline = parseLatexOutline(tex);
    expect(outline).toHaveLength(5);

    expect(outline[0]).toMatchObject({
      kind: "heading",
      command: "section",
      level: 2,
      title: "Introduction to LaTeX",
      line: 5,
    });

    expect(outline[1]).toMatchObject({
      kind: "heading",
      command: "subsection",
      level: 3,
      title: "Background Math",
      line: 7,
    });

    expect(outline[2]).toMatchObject({
      kind: "input",
      command: "input",
      targetFile: "sections/method.tex",
      line: 8,
    });

    expect(outline[3]).toMatchObject({
      kind: "heading",
      command: "subsubsection",
      level: 4,
      title: "Ablation Study",
      line: 9,
    });

    expect(outline[4]).toMatchObject({
      kind: "input",
      command: "include",
      targetFile: "sections/appendix.tex",
      line: 10,
    });
  });
});
