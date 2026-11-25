//! "Check for updates": compares the running version with the latest GitHub release.
//!
//! Only runs when the user clicks "Check for updates" or has turned on automatic checks.
//! It sends one unauthenticated GET to the GitHub API and nothing about the user.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

pub const RELEASES_URL: &str = "https://github.com/sdotvenk/OrchestraTeX/releases";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/sdotvenk/OrchestraTeX/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: String,
    pub update_available: bool,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("OrchestraTeX-update-check")
        .build()
        .map_err(|e| format!("Could not start the update check: {e}"))?;
    let response = client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "Couldn't reach GitHub. Check your connection and try again.".to_string())?;

    // No published release yet.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateCheckResult {
            current_version,
            latest_version: None,
            release_url: RELEASES_URL.to_string(),
            update_available: false,
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub returned {}. Try again later.",
            response.status()
        ));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|_| "GitHub sent an unexpected response.".to_string())?;
    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer(&latest_version, &current_version);
    Ok(UpdateCheckResult {
        current_version,
        latest_version: Some(latest_version),
        release_url: release
            .html_url
            .filter(|url| url.starts_with("https://github.com/"))
            .unwrap_or_else(|| RELEASES_URL.to_string()),
        update_available,
    })
}

/// True when `latest` is a higher dotted version than `current` (pre-release suffixes ignored).
fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(latest), parts(current));
    let len = a.len().max(b.len());
    for i in 0..len {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_dotted_versions() {
        assert!(is_newer("0.1.8", "0.1.7"));
        assert!(is_newer("0.2.0", "0.1.12"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.1.7", "0.1.7"));
        assert!(!is_newer("0.1.6", "0.1.7"));
        assert!(!is_newer("0.1.7", "0.1.7-beta"));
        assert!(!is_newer("0.1.10", "0.1.10.0"));
    }
}
