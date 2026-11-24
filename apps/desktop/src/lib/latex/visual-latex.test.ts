import { describe, expect, it } from "vitest";
import {
  parseInlines,
  parseVisualLatex,
  serializeInlines,
  serializeVisualLatex,
} from "./visual-latex";

describe("visual-latex parser & serializer", () => {
  it("losslessly round-trips a complete LaTeX document without edits", () => {
    const source = [
      "\\documentclass[11pt]{article}",
      "\\usepackage{amsmath,graphicx}",
      "",
      "% Preamble comment",
      "\\begin{document}",
      "\\maketitle",
      "",
      "\\section{Introduction}",
      "",
      "This is \\textbf{bold}, \\textit{italic}, and \\emph{emphasized} text with $x^2 + y^2 = z^2$ and \\cite{smith2024}.",
      "",
      "\\begin{itemize}",
      "  \\item First item",
      "  \\item Second item with \\ref{fig:arch}",
      "\\end{itemize}",
      "",
      "\\begin{equation}",
      "  E = mc^2",
      "\\end{equation}",
      "",
      "\\begin{tikzpicture}",
      "  \\draw (0,0) -- (1,1);",
      "\\end{tikzpicture}",
      "",
      "\\end{document}",
      "",
    ].join("\n");

    const doc = parseVisualLatex(source);
    expect(doc.kind).toBe("complete");
    expect(doc.preamble).toContain("\\documentclass[11pt]{article}");
    expect(doc.postamble).toContain("\\end{document}");
    expect(serializeVisualLatex(doc)).toBe(source);
  });

  it("losslessly round-trips an included fragment without \\begin{document}", () => {
    const fragment = [
      "% Section fragment",
      "\\subsection*{Background}",
      "",
      "Some prose with \\texttt{inline_code} and \\mycustommacro{arg1}.",
      "",
    ].join("\n");

    const doc = parseVisualLatex(fragment);
    expect(doc.kind).toBe("fragment");
    expect(doc.preamble).toBe("");
    expect(doc.postamble).toBe("");
    expect(serializeVisualLatex(doc)).toBe(fragment);
  });

  it("preserves untouched blocks verbatim when editing a single heading", () => {
    const source = [
      "\\section{Old Title}",
      "",
      "Untouched   paragraph   with   extra   spaces.",
      "",
      "\\begin{equation}",
      "  a^2 + b^2 = c^2",
      "\\end{equation}",
      "",
    ].join("\n");

    const doc = parseVisualLatex(source);
    const heading = doc.blocks[0];
    expect(heading?.type).toBe("heading");
    if (heading?.type === "heading") {
      heading.title = "New Title";
      heading.dirty = true;
    }

    const result = serializeVisualLatex(doc);
    expect(result).toContain("\\section{New Title}");
    expect(result).toContain("Untouched   paragraph   with   extra   spaces.");
    expect(result).toContain("\\begin{equation}\n  a^2 + b^2 = c^2\n\\end{equation}");
  });

  it("parses and serializes inline formatting, math, citations, and refs", () => {
    const line =
      "See \\textbf{Theorem 1} in \\citep[p. 4]{doe2025} and \\eqref{eq:main} with \\(a+b\\).";
    const inlines = parseInlines(line);
    expect(inlines.some((n) => n.type === "bold")).toBe(true);
    expect(inlines.some((n) => n.type === "cite")).toBe(true);
    expect(inlines.some((n) => n.type === "ref")).toBe(true);
    expect(inlines.some((n) => n.type === "math" && n.delimiter === "\\(")).toBe(true);
    expect(serializeInlines(inlines)).toBe(line);
  });

  it("updates figure caption and label while preserving figure environment", () => {
    const source = [
      "\\begin{figure}[htbp]",
      "  \\centering",
      "  \\includegraphics[width=0.8\\linewidth]{figures/arch.png}",
      "  \\caption{Original caption}",
      "  \\label{fig:old}",
      "\\end{figure}",
      "",
    ].join("\n");

    const doc = parseVisualLatex(source);
    const fig = doc.blocks[0];
    expect(fig?.type).toBe("figure");
    if (fig?.type === "figure") {
      expect(fig.imagePath).toBe("figures/arch.png");
      expect(fig.caption).toBe("Original caption");
      fig.caption = "Updated caption";
      fig.label = "fig:new";
      fig.dirty = true;
    }

    const result = serializeVisualLatex(doc);
    expect(result).toContain("\\caption{Updated caption}");
    expect(result).toContain("\\label{fig:new}");
    expect(result).toContain("\\includegraphics[width=0.8\\linewidth]{figures/arch.png}");
  });

  it("parses table rows and updates table caption without losing tabular body", () => {
    const source = [
      "\\begin{table}[t]",
      "  \\centering",
      "  \\caption{Results}",
      "  \\label{tab:res}",
      "  \\begin{tabular}{lcc}",
      "    \\toprule",
      "    Model & Acc & F1 \\\\",
      "    \\midrule",
      "    Ours & 94.2 & 93.8 \\\\",
      "    \\bottomrule",
      "  \\end{tabular}",
      "\\end{table}",
    ].join("\n");

    const doc = parseVisualLatex(source);
    const tbl = doc.blocks[0];
    expect(tbl?.type).toBe("table");
    if (tbl?.type === "table") {
      expect(tbl.rows.length).toBe(2);
      expect(tbl.rows[0]).toEqual(["Model", "Acc", "F1"]);
      tbl.caption = "Updated Results";
      tbl.dirty = true;
    }

    const result = serializeVisualLatex(doc);
    expect(result).toContain("\\caption{Updated Results}");
    expect(result).toContain("Ours & 94.2 & 93.8 \\\\");
  });

  it("adds missing figure metadata and preserves literal replacement characters", () => {
    const source = "\\begin{figure}\n  \\includegraphics{original.png}\n\\end{figure}";
    const doc = parseVisualLatex(source);
    const figure = doc.blocks[0];
    expect(figure?.type).toBe("figure");
    if (figure?.type !== "figure") return;
    figure.caption = "$& is literal";
    figure.label = "fig:added";
    figure.imagePath = "figures/result$1.png";
    figure.dirty = true;
    expect(serializeVisualLatex(doc)).toBe(
      "\\begin{figure}\n  \\includegraphics{figures/result$1.png}\n  \\caption{$& is literal}\n  \\label{fig:added}\n\\end{figure}",
    );
  });

  it("preserves a nested list as a single source block", () => {
    const list =
      "\\begin{itemize}\n\\item Outer\n\\begin{itemize}\n\\item Inner\n\\end{itemize}\n\\end{itemize}";
    const source = `${list}\n\n\\section{Next}\n`;
    const doc = parseVisualLatex(source);
    expect(doc.blocks.map((block) => block.type)).toEqual(["opaque", "heading"]);
    expect(doc.blocks[0]?.raw).toBe(list);
    expect(serializeVisualLatex(doc)).toBe(source);
  });
});
