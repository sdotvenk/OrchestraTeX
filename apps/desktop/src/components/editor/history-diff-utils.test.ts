import { describe, expect, it } from "vitest";
import { decodeGitPatchPath, parseUnifiedDiff } from "./history-diff-utils";

describe("history-diff-utils", () => {
  it("decodes C-quoted Git paths with Unicode, spaces, tabs, quotes, and emoji", () => {
    expect(decodeGitPatchPath('"b/r\\303\\251sum\\303\\251.tex"')).toBe("résumé.tex");
    expect(decodeGitPatchPath('"b/ lead space\\t\\"quoted\\" 🎉.tex"\t')).toBe(
      ' lead space\t"quoted" 🎉.tex',
    );
    expect(decodeGitPatchPath("b/sections/my paper 1.tex")).toBe("sections/my paper 1.tex");
  });

  it("parses unified diffs with spaces, C-quoted Unicode, and rename-only metadata", () => {
    const diff = [
      'diff --git "a/r\\303\\251sum\\303\\251.tex" "b/r\\303\\251sum\\303\\251.tex"',
      "index 1111111..2222222 100644",
      '--- "a/r\\303\\251sum\\303\\251.tex"',
      '+++ "b/r\\303\\251sum\\303\\251.tex"',
      "@@ -1,1 +1,2 @@",
      " \\section{Intro}",
      "+\\section{Results}",
      "diff --git a/sections/my draft.tex b/sections/my draft.tex",
      "index 3333333..4444444 100644",
      "--- a/sections/my draft.tex\t",
      "+++ b/sections/my draft.tex\t",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/old name.tex b/a/nested.tex",
      "similarity index 100%",
      "rename from old name.tex",
      "rename to a/nested.tex",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(3);
    expect(files[0]?.path).toBe("résumé.tex");
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[1]?.path).toBe("sections/my draft.tex");
    expect(files[1]?.hunks[0]?.lines.map((l) => `${l.type}:${l.content}`)).toEqual([
      "del:old",
      "add:new",
    ]);
    expect(files[2]?.path).toBe("a/nested.tex");
    expect(files[2]?.hunks).toHaveLength(0);
  });
});
