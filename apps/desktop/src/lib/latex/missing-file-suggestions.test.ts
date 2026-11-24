import { describe, expect, it } from "vitest";
import { extractMissingFilePath, findMissingFileSuggestion } from "./missing-file-suggestions";
import type { LatexDiagnostic } from "./types";

describe("extractMissingFilePath", () => {
  it("extracts paths from standard LaTeX missing-file diagnostics", () => {
    expect(extractMissingFilePath("! LaTeX Error: File `sections/discusion.tex' not found.")).toBe(
      "sections/discusion.tex",
    );
    expect(extractMissingFilePath("File sections/discusion.tex not found")).toBe(
      "sections/discusion.tex",
    );
    expect(extractMissingFilePath("Undefined control sequence")).toBeNull();
  });
});

describe("findMissingFileSuggestion", () => {
  it("suggests recently renamed file with exact source position and before/after", () => {
    const diagnostic: LatexDiagnostic = {
      file: "main.tex",
      line: 2,
      message: "! LaTeX Error: File `sections/discusion.tex' not found.",
      severity: "error",
    };

    const suggestion = findMissingFileSuggestion({
      diagnostic,
      projectFiles: ["main.tex", "sections/introduction.tex", "sections/discussion.tex"],
      recentRenames: [
        {
          oldPath: "sections/discusion.tex",
          newPath: "sections/discussion.tex",
        },
      ],
      sourceContent: "\\begin{document}\n\\input{sections/discusion}\n\\end{document}",
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion).toMatchObject({
      suggestedFile: "sections/discussion.tex",
      suggestedArg: "sections/discussion",
      reason: "renamed",
      confidence: 1,
      line: 2,
      column: 1,
      before: "\\input{sections/discusion}",
      after: "\\input{sections/discussion}",
    });
  });

  it("suggests typo match when Levenshtein distance is within threshold", () => {
    const diagnostic: LatexDiagnostic = {
      file: "main.tex",
      line: 1,
      message: "File `sections/introducton.tex' not found.",
      severity: "error",
    };

    const suggestion = findMissingFileSuggestion({
      diagnostic,
      projectFiles: ["main.tex", "sections/introduction.tex", "sections/methods.tex"],
      sourceContent: "\\input{sections/introducton}",
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.suggestedArg).toBe("sections/introduction");
    expect(suggestion?.reason).toBe("typo");
  });

  it("returns null when no plausible suggestion exists (not actionable)", () => {
    const diagnostic: LatexDiagnostic = {
      file: "main.tex",
      line: 1,
      message: "File `appendix/completely-different.tex' not found.",
      severity: "error",
    };

    const suggestion = findMissingFileSuggestion({
      diagnostic,
      projectFiles: ["main.tex", "sections/introduction.tex"],
    });

    expect(suggestion).toBeNull();
  });
});
