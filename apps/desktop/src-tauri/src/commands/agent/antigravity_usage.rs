//! Antigravity (agy CLI) quota probe: 5-hour and weekly windows from Cloud Code.
//!
//! OrchestraTeX spawns `agy acp` with the user's own environment, so the probe reads the
//! user's global agy sign-in. agy 1.5.16+ keeps Google sign-ins in the OS keyring
//! (service `gemini`, account `antigravity`) unless `AGY_CLI_FORCE_FILE_TOKEN_STORAGE`
//! is set, in which case it writes `$GEMINI_HOME/antigravity-acp/antigravity-oauth-token`.
//! Both stores are checked. The CLI token stores no OAuth client and cannot be refreshed
//! here; only the legacy `acp_token.json` (which carries its client) is refreshed.

use super::types::{AgentProviderId, RateLimitWindow, RateLimitsSnapshot};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

const DAILY_ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";
const FIVE_HOUR_MINS: u64 = 5 * 60;
const WEEKLY_MINS: u64 = 7 * 24 * 60;
const CACHE_TTL_MS: i64 = 60_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the provider-status call waits for a fresh probe before reporting unknown.
pub const STATUS_WAIT: Duration = Duration::from_secs(8);

pub const NO_SIGN_IN_NOTE: &str = "Session context usage only";

#[derive(Debug, Clone)]
pub enum ProbeOutcome {
    Windows(Vec<RateLimitWindow>),
    /// No agy sign-in found in either store.
    NoSignIn,
    /// Quota could not be read; the reason is short and safe to show.
    Unknown(String),
}

impl ProbeOutcome {
    pub fn into_snapshot(self, now_ms: i64) -> RateLimitsSnapshot {
        let (windows, note) = match self {
            ProbeOutcome::Windows(w) => (w, None),
            ProbeOutcome::NoSignIn => (Vec::new(), Some(NO_SIGN_IN_NOTE.to_string())),
            ProbeOutcome::Unknown(reason) => (Vec::new(), Some(format!("Quota unknown: {reason}"))),
        };
        RateLimitsSnapshot {
            provider_id: AgentProviderId::Antigravity,
            updated_at: now_ms,
            plan_type: None,
            windows,
            credits_balance: None,
            note,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- pure parsing ----------

/// Parses RFC 3339 (`2026-11-24T13:44:01.16-07:00`, `...Z`) into epoch milliseconds.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = s.get(start..i)?;
        if digits.is_empty() {
            return None;
        }
        let padded: String = digits.chars().chain("000".chars()).take(3).collect();
        frac_ms = padded.parse().ok()?;
    }
    let offset_secs = match s.get(i..)? {
        "Z" | "z" => 0,
        tz if tz.len() == 6 && (tz.starts_with('+') || tz.starts_with('-')) => {
            let oh: i64 = tz.get(1..3)?.parse().ok()?;
            let om: i64 = tz.get(4..6)?.parse().ok()?;
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            sign * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_secs;
    Some(secs * 1000 + frac_ms)
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    let input = input.trim();
    if input.len() % 2 != 0 {
        return None;
    }
    (0..input.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(input.get(i..i + 2)?, 16).ok())
        .collect()
}

/// go-keyring stores UTF-8 and prefixes encoded values on macOS.
pub fn decode_go_keyring_secret(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let bytes = if let Some(rest) = raw.strip_prefix("go-keyring-base64:") {
        base64_decode(rest)?
    } else if let Some(rest) = raw.strip_prefix("go-keyring-encoded:") {
        hex_decode(rest)?
    } else {
        return Some(raw.to_string());
    };
    String::from_utf8(bytes).ok()
}

#[derive(Debug, Clone, PartialEq)]
pub struct CliToken {
    pub access_token: String,
    pub expiry_ms: Option<i64>,
}

/// Decodes the agy 1.5.x CLI token JSON: `{"token":{"access_token","expiry",...}}`.
pub fn parse_cli_token(text: &str) -> Option<CliToken> {
    let v: Value = serde_json::from_str(text).ok()?;
    let t = v.get("token")?;
    let access_token = t.get("access_token")?.as_str()?.trim();
    if access_token.is_empty() {
        return None;
    }
    Some(CliToken {
        access_token: access_token.to_string(),
        expiry_ms: t
            .get("expiry")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms),
    })
}

/// A CLI token is usable only with a known expiry more than a minute away.
pub fn cli_token_is_fresh(token: &CliToken, now: i64) -> bool {
    token.expiry_ms.is_some_and(|e| e > now + 60_000)
}

fn bucket_family(bucket_id: &str, group_name: Option<&str>) -> String {
    let group = group_name.map(str::trim).filter(|s| !s.is_empty());
    if bucket_id.starts_with("gemini-argon-") {
        group.unwrap_or("Gemini Argon").to_string()
    } else if bucket_id.starts_with("gemini-carbon-") {
        group.unwrap_or("Gemini Carbon").to_string()
    } else if bucket_id.starts_with("gemini-") {
        "Gemini".to_string()
    } else if bucket_id.starts_with("3p-") {
        "Claude & GPT (shared)".to_string()
    } else {
        group.unwrap_or(bucket_id).to_string()
    }
}

fn used_percent(remaining: Option<f64>) -> Option<f64> {
    let r = remaining.filter(|r| r.is_finite())?;
    Some((1.0 - r.clamp(0.0, 1.0)) * 100.0)
}

/// Windows from a `retrieveUserQuotaSummary` answer requested at `requested_at` (ms).
pub fn summary_windows(response: &Value, requested_at: i64) -> Vec<RateLimitWindow> {
    let groups: Vec<(Option<&str>, &Vec<Value>)> = response
        .get("groups")
        .and_then(Value::as_array)
        .map(|gs| {
            gs.iter()
                .filter_map(|g| {
                    let buckets = g.get("buckets")?.as_array()?;
                    Some((g.get("displayName").and_then(Value::as_str), buckets))
                })
                .filter(|(_, b)| !b.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let groups = if groups.is_empty() {
        response
            .get("buckets")
            .and_then(Value::as_array)
            .map(|b| vec![(None, b)])
            .unwrap_or_default()
    } else {
        groups
    };

    let mut out: Vec<RateLimitWindow> = Vec::new();
    for (group_name, buckets) in groups {
        for bucket in buckets {
            let Some(id) = bucket
                .get("bucketId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(used) = used_percent(bucket.get("remainingFraction").and_then(Value::as_f64))
            else {
                continue;
            };
            let window = bucket.get("window").and_then(Value::as_str);
            let (suffix, mins) = match window {
                Some("5h") => ("5-hour window".to_string(), Some(FIVE_HOUR_MINS)),
                Some("weekly") => ("Weekly limit".to_string(), Some(WEEKLY_MINS)),
                _ => (
                    bucket
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Quota")
                        .to_string(),
                    None,
                ),
            };
            let reset = bucket
                .get("resetTime")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_ms);
            // Untouched buckets report a rolling full-window reset; there is nothing to count down.
            let untouched = bucket.get("remainingFraction").and_then(Value::as_f64) == Some(1.0)
                && bucket.get("description").is_none()
                && match (mins, reset) {
                    (Some(m), Some(r)) => (r - requested_at - (m as i64) * 60_000).abs() <= 60_000,
                    _ => false,
                };
            if out.iter().any(|w| w.id == id) {
                continue;
            }
            out.push(RateLimitWindow {
                id: id.to_string(),
                label: format!("{} · {}", bucket_family(id, group_name), suffix),
                used_percent: Some(used),
                status: None,
                window_duration_mins: mins,
                resets_at: if untouched { None } else { reset },
            });
        }
    }
    out
}

/// Older accounts expose per-model quotas without a window length. Only `weeklyQuotaInfo`
/// has a known cadence; never invent one for `quotaInfo`.
pub fn model_windows(response: &Value) -> Vec<RateLimitWindow> {
    let Some(models) = response.get("models").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut by_id: HashMap<String, RateLimitWindow> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (model_id, model) in models {
        let provider = model
            .get("modelProvider")
            .and_then(Value::as_str)
            .unwrap_or("");
        let family = if provider == "MODEL_PROVIDER_GOOGLE" || model_id.starts_with("gemini-") {
            "Gemini"
        } else if provider == "MODEL_PROVIDER_ANTHROPIC" || model_id.starts_with("claude-") {
            "Claude"
        } else if provider == "MODEL_PROVIDER_OPENAI" || model_id.starts_with("gpt-") {
            "GPT"
        } else {
            continue;
        };
        for (suffix, key) in [("quota", "quotaInfo"), ("weekly", "weeklyQuotaInfo")] {
            let Some(q) = model.get(key) else { continue };
            let Some(used) = used_percent(q.get("remainingFraction").and_then(Value::as_f64))
            else {
                continue;
            };
            let weekly = suffix == "weekly";
            let id = format!("{}-{}", family.to_lowercase(), suffix);
            let w = RateLimitWindow {
                id: id.clone(),
                label: format!(
                    "{family} · {}",
                    if weekly {
                        "Weekly limit"
                    } else {
                        "Reported quota"
                    }
                ),
                used_percent: Some(used),
                status: None,
                window_duration_mins: weekly.then_some(WEEKLY_MINS),
                resets_at: q
                    .get("resetTime")
                    .and_then(Value::as_str)
                    .and_then(parse_rfc3339_ms),
            };
            match by_id.get(&id) {
                Some(prev) if prev.used_percent >= w.used_percent => {}
                Some(_) => {
                    by_id.insert(id, w);
                }
                None => {
                    order.push(id.clone());
                    by_id.insert(id, w);
                }
            }
        }
    }
    order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect()
}

/// Puts the most-used 5-hour window first and the most-used weekly window second,
/// matching how Claude and Codex present primary/secondary windows.
pub fn order_windows(mut windows: Vec<RateLimitWindow>) -> Vec<RateLimitWindow> {
    let take_max = |ws: &mut Vec<RateLimitWindow>, mins: u64| -> Option<RateLimitWindow> {
        let idx = ws
            .iter()
            .enumerate()
            .rev() // ties go to the earliest (metered-host) window
            .filter(|(_, w)| w.window_duration_mins == Some(mins))
            .max_by(|a, b| {
                a.1.used_percent
                    .unwrap_or(0.0)
                    .partial_cmp(&b.1.used_percent.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| i)?;
        Some(ws.remove(idx))
    };
    let mut out = Vec::with_capacity(windows.len());
    out.extend(take_max(&mut windows, FIVE_HOUR_MINS));
    out.extend(take_max(&mut windows, WEEKLY_MINS));
    out.extend(windows);
    out
}

/// Merges endpoint answers by window id; earlier endpoints win.
fn merge(responses: Vec<Vec<RateLimitWindow>>) -> Vec<RateLimitWindow> {
    let mut out: Vec<RateLimitWindow> = Vec::new();
    for w in responses.into_iter().flatten() {
        if !out.iter().any(|o| o.id == w.id) {
            out.push(w);
        }
    }
    out
}

// ---------- IO ----------

enum Credential {
    Cli(String),
    Legacy {
        access_token: String,
        project_id: Option<String>,
    },
}

fn gemini_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("GEMINI_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(h));
    }
    dirs_home().map(|h| h.join(".gemini"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

async fn read_keyring_secret() -> Option<String> {
    #[cfg(target_os = "macos")]
    let out = tokio::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "gemini",
            "-a",
            "antigravity",
            "-w",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    #[cfg(target_os = "linux")]
    let out = tokio::process::Command::new("secret-tool")
        .args(["lookup", "service", "gemini", "username", "antigravity"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    #[cfg(target_os = "windows")]
    let out = {
        // go-keyring's target is `gemini:antigravity` (CRED_TYPE_GENERIC). Read it with
        // CredRead via PowerShell so no native crate is needed.
        const SCRIPT: &str = r#"$ErrorActionPreference='Stop'
Add-Type -Namespace OxCred -Name N -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, int ty, int f, out IntPtr c);
[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
'@
$p=[IntPtr]::Zero
if(-not [OxCred.N]::CredReadW('gemini:antigravity',1,0,[ref]$p)){exit 1}
try{$size=[Runtime.InteropServices.Marshal]::ReadInt32($p,32);$blob=[Runtime.InteropServices.Marshal]::ReadIntPtr($p,40);$b=New-Object byte[] $size;[Runtime.InteropServices.Marshal]::Copy($blob,$b,0,$size);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))}finally{[OxCred.N]::CredFree($p)}"#;
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[allow(unused_imports)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output().await.ok()?
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return None;
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    {
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8(out.stdout).ok()?;
        decode_go_keyring_secret(&text).filter(|s| !s.is_empty())
    }
}

async fn http_json(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let resp = timeout(REQUEST_TIMEOUT, req.send())
        .await
        .map_err(|_| "request timed out".to_string())?
        .map_err(|_| "network error".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    timeout(REQUEST_TIMEOUT, resp.json::<Value>())
        .await
        .map_err(|_| "request timed out".to_string())?
        .map_err(|_| "unreadable response".to_string())
}

/// Finds the user's agy sign-in. `Ok(None)` means no sign-in exists in any store.
async fn load_credential(client: &reqwest::Client) -> Result<Option<Credential>, String> {
    let acp_dir = gemini_home().map(|h| h.join("antigravity-acp"));
    if let Some(dir) = &acp_dir {
        // Legacy ACP token carries its OAuth client and can be refreshed.
        if let Ok(text) = tokio::fs::read_to_string(dir.join("acp_token.json")).await {
            let v: Value = serde_json::from_str(&text).map_err(|_| "unreadable sign-in file")?;
            let field = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
            let (Some(id), Some(secret), Some(refresh)) = (
                field("client_id"),
                field("client_secret"),
                field("refresh_token"),
            ) else {
                return Err("unreadable sign-in file".into());
            };
            let resp = http_json(
                client
                    .post("https://oauth2.googleapis.com/token")
                    .header(
                        reqwest::header::CONTENT_TYPE,
                        "application/x-www-form-urlencoded",
                    )
                    .body(form_encode(&[
                        ("client_id", id),
                        ("client_secret", secret),
                        ("refresh_token", refresh),
                        ("grant_type", "refresh_token"),
                    ])),
            )
            .await
            .map_err(|e| format!("sign-in refresh failed ({e})"))?;
            let access_token = resp
                .get("access_token")
                .and_then(Value::as_str)
                .ok_or("sign-in refresh failed")?
                .to_string();
            return Ok(Some(Credential::Legacy {
                access_token,
                project_id: field("project_id").map(str::to_string),
            }));
        }
    }
    // agy 1.5.16+: file store (AGY_CLI_FORCE_FILE_TOKEN_STORAGE) first, then the OS keyring.
    let file_token = match &acp_dir {
        Some(dir) => tokio::fs::read_to_string(dir.join("antigravity-oauth-token"))
            .await
            .ok(),
        None => None,
    };
    let stored = match file_token {
        Some(t) => Some(t),
        None => read_keyring_secret().await,
    };
    let Some(stored) = stored else {
        return Ok(None);
    };
    let token = parse_cli_token(&stored).ok_or("unreadable sign-in")?;
    if !cli_token_is_fresh(&token, now_ms()) {
        return Err("sign-in expired — start an Antigravity turn to renew it".into());
    }
    Ok(Some(Credential::Cli(token.access_token)))
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    let enc = |v: &str| -> String {
        v.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn user_agent() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("antigravity/hub/2.24.0 (aidev_client; os_type={os}; arch={arch}; cl=963137146)")
}

async fn fetch_windows(
    client: &reqwest::Client,
    access_token: &str,
    body: &Value,
    operation: &str,
    parse: fn(&Value, i64) -> Vec<RateLimitWindow>,
) -> (Vec<RateLimitWindow>, Option<String>) {
    let call = |endpoint: &'static str| {
        let req = client
            .post(format!("{endpoint}/v1internal:{operation}"))
            .bearer_auth(access_token)
            .header(reqwest::header::USER_AGENT, user_agent())
            .json(body);
        async move {
            let requested_at = now_ms();
            http_json(req).await.map(|v| parse(&v, requested_at))
        }
    };
    let (daily, prod) = tokio::join!(call(DAILY_ENDPOINT), call(PROD_ENDPOINT));
    let err = match (&daily, &prod) {
        (Err(e), Err(_)) => Some(e.clone()),
        _ => None,
    };
    (
        merge(vec![daily.unwrap_or_default(), prod.unwrap_or_default()]),
        err,
    )
}

async fn probe_uncached() -> ProbeOutcome {
    let Ok(client) = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return ProbeOutcome::Unknown("HTTP client unavailable".into());
    };
    let (token, body) = match load_credential(&client).await {
        Ok(None) => return ProbeOutcome::NoSignIn,
        Err(reason) => return ProbeOutcome::Unknown(reason),
        Ok(Some(Credential::Cli(t))) => (t, json!({})),
        Ok(Some(Credential::Legacy {
            access_token,
            project_id,
        })) => (
            access_token,
            project_id
                .map(|p| json!({ "project": p }))
                .unwrap_or_else(|| json!({})),
        ),
    };
    let (summary, err) = fetch_windows(
        &client,
        &token,
        &body,
        "retrieveUserQuotaSummary",
        summary_windows,
    )
    .await;
    if !summary.is_empty() {
        return ProbeOutcome::Windows(order_windows(summary));
    }
    let (models, err2) = fetch_windows(&client, &token, &body, "fetchAvailableModels", |v, _| {
        model_windows(v)
    })
    .await;
    if !models.is_empty() {
        return ProbeOutcome::Windows(order_windows(models));
    }
    ProbeOutcome::Unknown(match err.or(err2) {
        Some(e) => format!("quota request failed ({e})"),
        None => "Antigravity returned no quota windows".into(),
    })
}

struct Cache {
    at: i64,
    outcome: ProbeOutcome,
}

fn cache() -> &'static Mutex<Option<Cache>> {
    static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Probes Antigravity quota, reusing a result younger than a minute. Concurrent callers
/// share one in-flight probe through the cache lock. Bounded by `PROBE_TIMEOUT`.
pub async fn probe() -> ProbeOutcome {
    let mut guard = cache().lock().await;
    if let Some(c) = guard.as_ref() {
        if now_ms() - c.at < CACHE_TTL_MS {
            return c.outcome.clone();
        }
    }
    let outcome = timeout(PROBE_TIMEOUT, probe_uncached())
        .await
        .unwrap_or_else(|_| ProbeOutcome::Unknown("quota request timed out".into()));
    *guard = Some(Cache {
        at: now_ms(),
        outcome: outcome.clone(),
    });
    outcome
}

/// Snapshot for the provider-status call. Never waits longer than `STATUS_WAIT`; a probe
/// that runs over keeps going in the background and fills the cache for the next refresh.
pub async fn status_snapshot() -> RateLimitsSnapshot {
    let task = tokio::spawn(probe());
    let outcome = match timeout(STATUS_WAIT, task).await {
        Ok(Ok(o)) => o,
        Ok(Err(_)) => ProbeOutcome::Unknown("quota probe failed".into()),
        Err(_) => ProbeOutcome::Unknown("quota request still running — refresh shortly".into()),
    };
    outcome.into_snapshot(now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQ: i64 = 1_795_000_000_000; // fixed request time (ms)

    fn iso(ms: i64) -> String {
        // Build an RFC 3339 UTC string for `ms` via the inverse of days-from-civil.
        let secs = ms.div_euclid(1000);
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    }

    #[test]
    fn rfc3339_parses_offsets_and_fractions() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T01:00:00.5+01:00"), Some(500));
        assert_eq!(
            parse_rfc3339_ms("2026-11-24T13:44:01.1637-07:00"),
            parse_rfc3339_ms("2026-11-24T20:44:01.163Z")
        );
        assert_eq!(parse_rfc3339_ms(&iso(REQ)), Some(REQ));
        assert_eq!(parse_rfc3339_ms("not a date"), None);
        assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn summary_maps_5h_and_weekly_windows() {
        let r5 = REQ + 2 * 3_600_000;
        let rw = REQ + 3 * 86_400_000;
        let resp = json!({
            "groups": [{
                "displayName": "Default",
                "buckets": [
                    {"bucketId": "gemini-default-5h", "window": "5h", "remainingFraction": 0.75,
                     "resetTime": iso(r5), "description": "Resets in 2h"},
                    {"bucketId": "gemini-default-weekly", "window": "weekly", "remainingFraction": 0.4,
                     "resetTime": iso(rw)},
                    {"bucketId": "3p-shared-5h", "window": "5h", "remainingFraction": 0.1,
                     "resetTime": iso(r5), "description": "x"},
                    {"bucketId": "gemini-off", "window": "5h", "remainingFraction": 0.0, "disabled": true}
                ]
            }]
        });
        let ws = summary_windows(&resp, REQ);
        assert_eq!(ws.len(), 3);
        let five = &ws[0];
        assert_eq!(five.label, "Gemini · 5-hour window");
        assert_eq!(five.window_duration_mins, Some(300));
        assert!((five.used_percent.unwrap() - 25.0).abs() < 1e-9);
        assert_eq!(five.resets_at, Some(r5));
        let weekly = &ws[1];
        assert_eq!(weekly.label, "Gemini · Weekly limit");
        assert_eq!(weekly.window_duration_mins, Some(10080));
        assert!((weekly.used_percent.unwrap() - 60.0).abs() < 1e-9);
        assert_eq!(weekly.resets_at, Some(rw));
        assert_eq!(ws[2].label, "Claude & GPT (shared) · 5-hour window");

        // Ordering puts the most-used 5h first, then the most-used weekly.
        let ordered = order_windows(ws);
        assert_eq!(ordered[0].id, "3p-shared-5h");
        assert_eq!(ordered[1].id, "gemini-default-weekly");
    }

    #[test]
    fn untouched_bucket_has_no_reset() {
        let resp = json!({
            "buckets": [
                {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 1.0,
                 "resetTime": iso(REQ + 300 * 60_000 + 20_000)},
                {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 1.0,
                 "resetTime": iso(REQ + 2 * 86_400_000)}
            ]
        });
        let ws = summary_windows(&resp, REQ);
        assert_eq!(ws[0].used_percent, Some(0.0));
        assert_eq!(
            ws[0].resets_at, None,
            "rolling full-window reset is dropped"
        );
        // A full bucket with a real (non-rolling) reset keeps it.
        assert_eq!(ws[1].resets_at, Some(REQ + 2 * 86_400_000));
    }

    #[test]
    fn per_model_fallback_never_invents_cadence() {
        let resp = json!({
            "models": {
                "gemini-3-pro": {"modelProvider": "MODEL_PROVIDER_GOOGLE",
                    "quotaInfo": {"remainingFraction": 0.9},
                    "weeklyQuotaInfo": {"remainingFraction": 0.5, "resetTime": iso(REQ + 86_400_000)}},
                "gemini-3-flash": {"quotaInfo": {"remainingFraction": 0.2}},
                "claude-sonnet": {"modelProvider": "MODEL_PROVIDER_ANTHROPIC",
                    "weeklyQuotaInfo": {"remainingFraction": 0.7}},
                "mystery": {"quotaInfo": {"remainingFraction": 0.1}}
            }
        });
        let ws = model_windows(&resp);
        let get = |id: &str| ws.iter().find(|w| w.id == id).cloned().unwrap();
        let q = get("gemini-quota");
        assert_eq!(q.label, "Gemini · Reported quota");
        assert_eq!(q.window_duration_mins, None);
        assert!(
            (q.used_percent.unwrap() - 80.0).abs() < 1e-9,
            "highest usage wins"
        );
        let w = get("gemini-weekly");
        assert_eq!(w.label, "Gemini · Weekly limit");
        assert_eq!(w.window_duration_mins, Some(10080));
        assert_eq!(get("claude-weekly").label, "Claude · Weekly limit");
        assert!(ws.iter().all(|w| !w.id.starts_with("mystery")));
    }

    #[test]
    fn malformed_data_yields_no_windows() {
        for bad in [
            json!(null),
            json!("oops"),
            json!({"groups": "nope"}),
            json!({"buckets": [{"window": "5h", "remainingFraction": 0.5}]}),
            json!({"buckets": [{"bucketId": "gemini-x", "window": "5h", "remainingFraction": "half"}]}),
        ] {
            assert!(summary_windows(&bad, REQ).is_empty(), "{bad}");
        }
        assert!(model_windows(&json!({"models": []})).is_empty());
        // Unknown (no windows) is reported as unknown, never as 0%.
        let snap = ProbeOutcome::Unknown("HTTP 500".into()).into_snapshot(REQ);
        assert!(snap.windows.is_empty());
        assert_eq!(snap.note.as_deref(), Some("Quota unknown: HTTP 500"));
        let none = ProbeOutcome::NoSignIn.into_snapshot(REQ);
        assert_eq!(none.note.as_deref(), Some(NO_SIGN_IN_NOTE));
    }

    #[test]
    fn go_keyring_prefixes_decode() {
        let plain = r#"{"token":{"access_token":"a"}}"#;
        let b64 = "go-keyring-base64:eyJ0b2tlbiI6eyJhY2Nlc3NfdG9rZW4iOiJhIn19";
        let hex: String = plain.bytes().map(|b| format!("{b:02x}")).collect();
        assert_eq!(decode_go_keyring_secret(b64).as_deref(), Some(plain));
        assert_eq!(
            decode_go_keyring_secret(&format!("go-keyring-encoded:{hex}")).as_deref(),
            Some(plain)
        );
        assert_eq!(decode_go_keyring_secret(plain).as_deref(), Some(plain));
        assert_eq!(decode_go_keyring_secret("go-keyring-encoded:zz"), None);
    }

    #[test]
    fn cli_token_expiry() {
        let fresh = parse_cli_token(&format!(
            r#"{{"token":{{"access_token":"t","expiry":"{}"}}}}"#,
            iso(REQ + 3_600_000)
        ))
        .unwrap();
        assert!(cli_token_is_fresh(&fresh, REQ));
        let stale = parse_cli_token(&format!(
            r#"{{"token":{{"access_token":"t","expiry":"{}"}}}}"#,
            iso(REQ + 30_000)
        ))
        .unwrap();
        assert!(!cli_token_is_fresh(&stale, REQ));
        let no_expiry = parse_cli_token(r#"{"token":{"access_token":"t"}}"#).unwrap();
        assert!(!cli_token_is_fresh(&no_expiry, REQ));
        assert!(parse_cli_token(r#"{"token":{"access_token":""}}"#).is_none());
        assert!(parse_cli_token("garbage").is_none());
    }

    /// Live check against the signed-in account. Prints labels and percentages only.
    /// Run: cargo test --lib -- --ignored antigravity_live --nocapture
    #[tokio::test]
    #[ignore]
    async fn antigravity_live() {
        match probe_uncached().await {
            ProbeOutcome::Windows(ws) => {
                for w in ws {
                    println!(
                        "{} | {}% | reset {}",
                        w.label,
                        w.used_percent.map(|p| p.round() as i64).unwrap_or(-1),
                        if w.resets_at.is_some() { "set" } else { "none" }
                    );
                }
            }
            other => println!("{other:?}"),
        }
    }
}
