import { describe, expect, it } from "vitest";
import { mayHaveNewContents } from "./file-change";

describe("external file changes", () => {
  it("reloads both in-place writes and atomic replacements", () => {
    expect(mayHaveNewContents("modify")).toBe(true);
    expect(mayHaveNewContents("rename")).toBe(true);
    expect(mayHaveNewContents("create")).toBe(true);
  });

  it("does not reload paths that were removed or only accessed", () => {
    expect(mayHaveNewContents("remove")).toBe(false);
    expect(mayHaveNewContents("access")).toBe(false);
  });
});
