import { invoke } from "@tauri-apps/api/core";

export const RELEASES_URL = "https://github.com/sdotvenk/OrchestraTeX/releases";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string;
  updateAvailable: boolean;
}

/** Asks GitHub for the latest release. Only called on request or when auto-check is on. */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_update");
}
