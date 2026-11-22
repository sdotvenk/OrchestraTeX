use super::super::util::command;
use super::types::AttachmentInput;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;
use tokio::sync::OnceCell;
use tokio::time::{timeout, Duration};

static ENRICHED_PATH_CACHE: OnceCell<String> = OnceCell::const_new();

pub async fn enriched_path() -> &'static str {
    ENRICHED_PATH_CACHE
        .get_or_init(|| async { compute_enriched_path().await })
        .await
        .as_str()
}

async fn compute_enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };

    let mut candidates: Vec<String> = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        let default_shell = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else if tokio::fs::try_exists("/bin/bash").await.unwrap_or(false) {
            "/bin/bash"
        } else {
            "/bin/sh"
        };
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| default_shell.to_string());
        if let Ok(Ok(output)) = timeout(
            Duration::from_secs(2),
            command(&shell)
                .args(["-lc", "printf '%s' \"$PATH\""])
                .output(),
        )
        .await
        {
            if output.status.success() {
                let shell_path = String::from_utf8_lossy(&output.stdout);
                for entry in shell_path.split(':') {
                    if !entry.trim().is_empty() {
                        candidates.push(entry.trim().to_string());
                    }
                }
            }
        }

        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{}/.local/bin", home));
            candidates.push(format!("{}/.cargo/bin", home));
            candidates.push(format!("{}/.npm-global/bin", home));
            candidates.push(format!("{}/.bun/bin", home));
            candidates.push(format!("{}/.nvm/current/bin", home));
            candidates.push(format!("{}/bin", home));
        }
        candidates.push("/opt/homebrew/bin".to_string());
        candidates.push("/usr/local/bin".to_string());
        candidates.push("/usr/bin".to_string());
        candidates.push("/bin".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{}\\npm", appdata));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            candidates.push(format!("{}\\.local\\bin", profile));
            candidates.push(format!("{}\\.bun\\bin", profile));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{}\\Programs", local));
            candidates.push(format!("{}\\pnpm", local));
        }
    }

    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for part in candidates
        .into_iter()
        .chain(base.split(sep).map(|s| s.to_string()))
    {
        let trimmed = part.trim().to_string();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            merged.push(trimmed);
        }
    }

    merged.join(sep)
}

pub async fn find_cli_binary(names: &[&str], custom_path: Option<&str>) -> Option<String> {
    if let Some(custom) = custom_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            if p.is_file() {
                return Some(trimmed.to_string());
            }
            // Also allow bare executable name in custom_path
            if !trimmed.contains('/') && !trimmed.contains('\\') {
                if let Some(found) = find_in_path_list(trimmed, enriched_path().await).await {
                    return Some(found);
                }
            }
        }
    }

    let path_env = enriched_path().await;
    for name in names {
        if let Some(found) = find_in_path_list(name, path_env).await {
            return Some(found);
        }
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    for name in names {
        if let Ok(output) = command(which_cmd)
            .arg(name)
            .env("PATH", path_env)
            .output()
            .await
        {
            if output.status.success() {
                if let Some(first) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(|s| s.trim().to_string())
                {
                    if !first.is_empty() && Path::new(&first).exists() {
                        return Some(first);
                    }
                }
            }
        }
    }

    None
}

async fn find_in_path_list(name: &str, path_env: &str) -> Option<String> {
    let sep = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };

    let dirs: Vec<PathBuf> = path_env
        .split(sep)
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    let name_owned = name.to_string();

    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let exts = {
            let has_ext = Path::new(&name_owned).extension().is_some();
            if has_ext {
                vec!["".to_string()]
            } else {
                vec![
                    ".exe".to_string(),
                    ".cmd".to_string(),
                    ".bat".to_string(),
                    ".com".to_string(),
                    "".to_string(),
                ]
            }
        };
        #[cfg(not(target_os = "windows"))]
        let exts = vec!["".to_string()];

        for dir in dirs {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", name_owned, ext));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

pub async fn spawn_cli_command(binary_path: &str, args: &[String], cwd: &str) -> TokioCommand {
    let path_env = enriched_path().await;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let lower = binary_path.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = command("cmd.exe");
            c.arg("/C").arg(binary_path).args(args);
            c
        } else {
            let mut c = command(binary_path);
            c.args(args);
            c
        }
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = command(binary_path);
        c.args(args);
        c
    };

    if !cwd.trim().is_empty() && Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    cmd.env("PATH", path_env);
    cmd
}

pub fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| "Invalid data URL".to_string())?;
    let (header, payload) = rest
        .split_once(',')
        .ok_or_else(|| "Invalid data URL: missing comma".to_string())?;
    let mime = header
        .split(';')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = decode_base64(payload)?;
    Ok((mime, bytes))
}

pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;

    for byte in input.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            break;
        }
        let val = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err(format!("Invalid base64 byte: {}", byte)),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }

    Ok(out)
}

#[allow(dead_code)]
pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub async fn persist_attachment_to_disk(
    app: &AppHandle,
    attachment: &AttachmentInput,
) -> Result<(String, String, Vec<u8>), String> {
    if let Some(ref existing_path) = attachment.file_path {
        let p = Path::new(existing_path);
        if p.exists() && p.is_file() {
            let bytes = tokio::fs::read(p).await.map_err(|e| e.to_string())?;
            return Ok((existing_path.clone(), attachment.mime.clone(), bytes));
        }
    }

    let data_url = attachment
        .data_url
        .as_deref()
        .ok_or_else(|| "Attachment missing dataUrl and filePath".to_string())?;
    let (mime, bytes) = decode_data_url(data_url)?;

    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => Path::new(&attachment.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin"),
    };

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("attachments");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    Ok((file_path.to_string_lossy().to_string(), mime, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_works() {
        let raw = b"hello world! LaTeX + T3";
        let encoded = encode_base64(raw);
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded, raw);
    }

    #[test]
    fn decode_data_url_extracts_mime_and_bytes() {
        let raw = b"abc";
        let url = format!("data:image/png;base64,{}", encode_base64(raw));
        let (mime, bytes) = decode_data_url(&url).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, raw);
    }
}
