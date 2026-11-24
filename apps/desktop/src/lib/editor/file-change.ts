export interface FileChangeEvent {
  path: string;
  kind: "create" | "modify" | "remove" | "rename" | "access" | "other" | "unknown";
}

export function mayHaveNewContents(kind: FileChangeEvent["kind"]): boolean {
  // An atomic writer can replace a file by renaming a temporary file over it.
  return kind === "modify" || kind === "rename" || kind === "create";
}
