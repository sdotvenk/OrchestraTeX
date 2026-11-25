export const APPEARANCE_STORAGE_KEY = "theme";

export const APPEARANCE_THEMES = ["lux", "nocturne"];

// Auto resolves to an OS color scheme. These aliases also style legacy selections
// during startup, before the saved preference is migrated.
export const APPEARANCE_CLASSES = {
  lux: "light",
  nocturne: "dark",
  light: "light",
  dark: "dark",
};

export function isNocturneAppearance(resolvedTheme: string | undefined): boolean {
  return resolvedTheme === "nocturne" || resolvedTheme === "dark";
}
