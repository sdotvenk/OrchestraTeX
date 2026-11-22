import { describe, expect, it } from "vitest";
import { parseBibTeXEntries, parseLatexLabels } from "./bib-parser";

describe("bib-parser", () => {
  it("parses BibTeX keys and metadata", () => {
    const bib = `
@inproceedings{vaswani2017attention,
  title = {Attention Is {All} You Need},
  author = {Ashish Vaswani and Noam Shazeer},
  year = {2017},
}

@article{lecun2015deep,
  title = "Deep learning",
  author = "Yann LeCun",
  year = 2015
}
`;
    const entries = parseBibTeXEntries(bib, "refs.bib");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: "vaswani2017attention",
      entryType: "inproceedings",
      title: "Attention Is All You Need",
      author: "Ashish Vaswani and Noam Shazeer",
      year: "2017",
      file: "refs.bib",
    });
    expect(entries[1]?.year).toBe("2015");
  });

  it("extracts active LaTeX labels while skipping comments", () => {
    const tex = `
\\section{Intro}\\label{sec:intro}
% \\label{sec:commented}
\\begin{figure}
\\caption{Demo}\\label{fig:demo}
\\end{figure}
`;
    const labels = parseLatexLabels(tex, "main.tex");
    expect(labels).toEqual([
      { key: "sec:intro", file: "main.tex", line: 2 },
      { key: "fig:demo", file: "main.tex", line: 5 },
    ]);
  });
});
