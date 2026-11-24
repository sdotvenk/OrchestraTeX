import { describe, expect, it } from "vitest";
import { planRenameReferences } from "./rename-references";

describe("planRenameReferences", () => {
  it("preserves extension style and ./ prefix on file rename", () => {
    const edits = planRenameReferences({
      oldPath: "sections/intro.tex",
      newPath: "sections/introduction.tex",
      files: [
        {
          path: "main.tex",
          content: [
            "\\input{sections/intro}",
            "\\include{sections/intro.tex}",
            "\\input{./sections/intro}",
          ].join("\n"),
        },
      ],
    });

    expect(edits).toHaveLength(3);
    expect(edits[0]).toMatchObject({
      filePath: "main.tex",
      command: "input",
      line: 1,
      column: 1,
      before: "\\input{sections/intro}",
      after: "\\input{sections/introduction}",
      beforeArg: "sections/intro",
      afterArg: "sections/introduction",
    });
    expect(edits[1]).toMatchObject({
      line: 2,
      before: "\\include{sections/intro.tex}",
      after: "\\include{sections/introduction.tex}",
    });
    expect(edits[2]).toMatchObject({
      line: 3,
      before: "\\input{./sections/intro}",
      after: "\\input{./sections/introduction}",
    });
  });

  it("ignores comments, escaped %, and verbatim examples", () => {
    const edits = planRenameReferences({
      oldPath: "sections/intro.tex",
      newPath: "sections/introduction.tex",
      files: [
        {
          path: "main.tex",
          content: [
            "% \\input{sections/intro}",
            "50\\% \\input{sections/intro}",
            "\\verb|\\input{sections/intro}|",
            "\\begin{verbatim}",
            "\\input{sections/intro}",
            "\\end{verbatim}",
          ].join("\n"),
        },
      ],
    });

    expect(edits).toHaveLength(1);
    expect(edits[0]?.line).toBe(2);
    expect(edits[0]?.after).toBe("\\input{sections/introduction}");
  });

  it("does not conflate unrelated basenames in different directories", () => {
    const edits = planRenameReferences({
      oldPath: "a/intro.tex",
      newPath: "a/introduction.tex",
      files: [
        {
          path: "main.tex",
          content: ["\\input{a/intro}", "\\input{b/intro}", "\\input{intro}"].join("\n"),
        },
      ],
    });

    expect(edits).toHaveLength(1);
    expect(edits[0]?.beforeArg).toBe("a/intro");
    expect(edits[0]?.afterArg).toBe("a/introduction");
  });

  it("plans directory rename edits and preserves relative paths", () => {
    const edits = planRenameReferences({
      oldPath: "sections",
      newPath: "chapters",
      isDirectory: true,
      files: [
        {
          path: "main.tex",
          content: "\\input{sections/intro}\n\\include{sections/methods.tex}",
        },
      ],
    });

    expect(edits).toHaveLength(2);
    expect(edits[0]?.after).toBe("\\input{chapters/intro}");
    expect(edits[1]?.after).toBe("\\include{chapters/methods.tex}");
  });

  it("handles Windows paths and emits POSIX slashes in LaTeX", () => {
    const edits = planRenameReferences({
      oldPath: "C:\\paper\\sections\\intro.tex",
      newPath: "C:\\paper\\sections\\introduction.tex",
      projectRoot: "C:\\paper",
      files: [
        {
          path: "C:\\paper\\main.tex",
          content: "\\input{sections/intro}",
        },
      ],
    });

    expect(edits).toHaveLength(1);
    expect(edits[0]?.after).toBe("\\input{sections/introduction}");
  });

  it("resolves references from the main document directory and preserves argument spacing", () => {
    const edits = planRenameReferences({
      oldPath: "chapter/intro.tex",
      newPath: "chapter/start.tex",
      mainFile: "chapter/main.tex",
      files: [
        { path: "chapter/main.tex", content: "\\input { intro }\n\\\\input{intro}" },
        { path: "intro.tex", content: "" },
      ],
    });
    expect(edits.map((edit) => edit.after)).toEqual(["\\input { start }"]);
  });

  it("leaves references unchanged when the main document and include move together", () => {
    expect(
      planRenameReferences({
        oldPath: "chapter",
        newPath: "renamed",
        mainFile: "chapter/main.tex",
        isDirectory: true,
        files: [{ path: "chapter/main.tex", content: "\\input{intro}" }],
      }),
    ).toEqual([]);
  });
});
