use super::util::command;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaTeXDistribution {
    pub name: String,
    pub id: String,
    pub description: String,
    pub install_command: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgress {
    pub stage: String,
    pub message: String,
    pub progress: Option<f32>, // 0.0 to 1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub success: bool,
    pub message: String,
    pub needs_restart: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilerInfo {
    pub name: String,
    pub path: Option<String>,
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaTeXCompilersStatus {
    pub pdflatex: CompilerInfo,
    pub xelatex: CompilerInfo,
    pub lualatex: CompilerInfo,
    pub latexmk: CompilerInfo,
    pub tectonic: CompilerInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatexDiagnostic {
    pub file: String,
    pub line: u32,
    pub message: String,
    pub severity: String, // "error" | "warning"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilationResult {
    pub success: bool,
    pub cancelled: bool,
    pub exit_code: Option<i32>,
    pub pdf_path: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub errors: Vec<LatexDiagnostic>,
    pub warnings: Vec<LatexDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileOutputEvent {
    pub line: String,
    pub is_error: bool,
    pub is_warning: bool,
}

pub struct LaTeXCompilationState {
    pub current_process: Arc<Mutex<Option<(u64, Child)>>>,
    pub generation: Arc<AtomicU64>,
}

impl Default for LaTeXCompilationState {
    fn default() -> Self {
        Self {
            current_process: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

pub fn build_tex_env_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let mut extras: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            extras.push(format!("{}/Library/TinyTeX/bin/universal-darwin", home));
            extras.push(format!("{}/Library/TinyTeX/bin/arm64-darwin", home));
            extras.push(format!("{}/Library/TinyTeX/bin/x86_64-darwin", home));
            extras.push(format!("{}/.cargo/bin", home));
            extras.push(format!("{}/.local/bin", home));
        }
        extras.push("/Library/TeX/texbin".to_string());
        extras.push("/opt/homebrew/bin".to_string());
        extras.push("/usr/local/bin".to_string());
        for year in (2020..=2030).rev() {
            extras.push(format!("/usr/local/texlive/{}/bin/universal-darwin", year));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(format!("{}\\TinyTeX\\bin\\windows", appdata));
            extras.push(format!("{}\\TinyTeX\\bin\\win32", appdata));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            extras.push(format!("{}\\Programs\\MiKTeX\\miktex\\bin\\x64", local));
            extras.push(format!("{}\\Programs\\tectonic", local));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            extras.push(format!("{}\\.cargo\\bin", profile));
        }
        extras.push(r"C:\Program Files\MiKTeX\miktex\bin\x64".to_string());
        extras.push(r"C:\Program Files (x86)\MiKTeX\miktex\bin".to_string());
        for year in (2020..=2030).rev() {
            extras.push(format!(r"C:\texlive\{}\bin\windows", year));
            extras.push(format!(r"C:\texlive\{}\bin\win32", year));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            extras.push(format!("{}/.TinyTeX/bin/x86_64-linux", home));
            extras.push(format!("{}/.TinyTeX/bin/aarch64-linux", home));
            extras.push(format!("{}/.cargo/bin", home));
            extras.push(format!("{}/.local/bin", home));
            extras.push(format!("{}/bin", home));
        }
        extras.push("/usr/local/bin".to_string());
        extras.push("/usr/bin".to_string());
        for year in (2020..=2030).rev() {
            extras.push(format!("/usr/local/texlive/{}/bin/x86_64-linux", year));
        }
    }

    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for entry in extras
        .into_iter()
        .chain(existing.split(sep).map(|s| s.to_string()))
    {
        let trimmed = entry.trim().to_string();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            parts.push(trimmed);
        }
    }
    parts.join(sep)
}

async fn find_compiler(name: &str) -> CompilerInfo {
    let env_path = build_tex_env_path();
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    // Try enriched PATH first
    let output = command(which_cmd)
        .arg(name)
        .env("PATH", &env_path)
        .output()
        .await;

    if let Ok(output) = output {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();

            if !path.is_empty() {
                let version = get_compiler_version(name, &path).await;
                return CompilerInfo {
                    name: name.to_string(),
                    path: Some(path),
                    available: true,
                    version,
                };
            }
        }
    }

    // Check common installation paths directly
    let common_paths = get_common_paths(name);
    for path in common_paths {
        if Path::new(&path).exists() {
            let version = get_compiler_version(name, &path).await;
            return CompilerInfo {
                name: name.to_string(),
                path: Some(path),
                available: true,
                version,
            };
        }
    }

    CompilerInfo {
        name: name.to_string(),
        path: None,
        available: false,
        version: None,
    }
}

fn get_common_paths(name: &str) -> Vec<String> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            paths.push(format!("{}\\TinyTeX\\bin\\windows\\{}.exe", appdata, name));
            paths.push(format!("{}\\TinyTeX\\bin\\win32\\{}.exe", appdata, name));
        }
        for year in (2020..=2030).rev() {
            paths.push(format!("C:\\texlive\\{}\\bin\\win32\\{}.exe", year, name));
            paths.push(format!("C:\\texlive\\{}\\bin\\windows\\{}.exe", year, name));
        }
        paths.push(format!(
            "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\{}.exe",
            name
        ));
        paths.push(format!(
            "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\{}.exe",
            name
        ));
        if let Ok(home) = std::env::var("LOCALAPPDATA") {
            paths.push(format!(
                "{}\\Programs\\MiKTeX\\miktex\\bin\\x64\\{}.exe",
                home, name
            ));
            paths.push(format!("{}\\Programs\\tectonic\\{}.exe", home, name));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            paths.push(format!("{}\\.cargo\\bin\\{}.exe", profile, name));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            paths.push(format!(
                "{}/Library/TinyTeX/bin/universal-darwin/{}",
                home, name
            ));
            paths.push(format!(
                "{}/Library/TinyTeX/bin/x86_64-darwin/{}",
                home, name
            ));
            paths.push(format!(
                "{}/Library/TinyTeX/bin/arm64-darwin/{}",
                home, name
            ));
            paths.push(format!("{}/.cargo/bin/{}", home, name));
        }
        paths.push(format!("/Library/TeX/texbin/{}", name));
        paths.push(format!("/opt/homebrew/bin/{}", name));
        paths.push(format!("/usr/local/bin/{}", name));
        for year in (2020..=2030).rev() {
            paths.push(format!(
                "/usr/local/texlive/{}/bin/universal-darwin/{}",
                year, name
            ));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            paths.push(format!("{}/.TinyTeX/bin/x86_64-linux/{}", home, name));
            paths.push(format!("{}/.TinyTeX/bin/aarch64-linux/{}", home, name));
            paths.push(format!("{}/.cargo/bin/{}", home, name));
            paths.push(format!("{}/bin/{}", home, name));
        }
        paths.push(format!("/usr/bin/{}", name));
        paths.push(format!("/usr/local/bin/{}", name));
        for year in (2020..=2030).rev() {
            paths.push(format!(
                "/usr/local/texlive/{}/bin/x86_64-linux/{}",
                year, name
            ));
        }
    }

    paths
}

async fn get_compiler_version(_name: &str, path: &str) -> Option<String> {
    let env_path = build_tex_env_path();
    let output = command(path)
        .arg("--version")
        .env("PATH", env_path)
        .output()
        .await
        .ok()?;

    if output.status.success() {
        let version_output = String::from_utf8_lossy(&output.stdout);
        let first_line = version_output.lines().next()?.trim();
        if first_line.is_empty() {
            None
        } else {
            Some(first_line.to_string())
        }
    } else {
        None
    }
}

#[tauri::command]
pub async fn latex_detect_compilers() -> Result<LaTeXCompilersStatus, String> {
    let (pdflatex, xelatex, lualatex, latexmk, tectonic) = tokio::join!(
        find_compiler("pdflatex"),
        find_compiler("xelatex"),
        find_compiler("lualatex"),
        find_compiler("latexmk"),
        find_compiler("tectonic"),
    );

    Ok(LaTeXCompilersStatus {
        pdflatex,
        xelatex,
        lualatex,
        latexmk,
        tectonic,
    })
}

fn has_any_compiler(status: &LaTeXCompilersStatus) -> bool {
    status.pdflatex.available
        || status.xelatex.available
        || status.lualatex.available
        || status.latexmk.available
        || status.tectonic.available
}

async fn is_compiler_detectable_after_install() -> bool {
    match latex_detect_compilers().await {
        Ok(status) => has_any_compiler(&status),
        Err(_) => false,
    }
}

pub fn build_compile_args(
    compiler: &str,
    latexmk_engine: Option<&str>,
    user_args: &[String],
    file_name: &str,
) -> Vec<String> {
    let mut cmd_args = Vec::new();

    if compiler == "tectonic" {
        cmd_args.push("-X".to_string());
        cmd_args.push("compile".to_string());
        cmd_args.push("--synctex".to_string());
        cmd_args.push("--keep-logs".to_string());
    } else {
        if compiler == "latexmk" {
            let engine_flag = match latexmk_engine.unwrap_or("pdflatex") {
                "xelatex" => "-xelatex",
                "lualatex" => "-lualatex",
                _ => "-pdf",
            };
            cmd_args.push(engine_flag.to_string());
        }
        cmd_args.push("-interaction=nonstopmode".to_string());
        cmd_args.push("-file-line-error".to_string());
        cmd_args.push("-synctex=1".to_string());
    }

    for arg in user_args {
        if !arg.trim().is_empty() {
            cmd_args.push(arg.clone());
        }
    }

    cmd_args.push(file_name.to_string());
    cmd_args
}

fn extract_input_line_number(line: &str) -> u32 {
    if let Some(idx) = line.find("on input line ") {
        let rest = &line[idx + "on input line ".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            return n;
        }
    }
    if let Some(idx) = line.find("at lines ") {
        let rest = &line[idx + "at lines ".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            return n;
        }
    }
    if let Some(idx) = line.find("at line ") {
        let rest = &line[idx + "at line ".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            return n;
        }
    }
    0
}

fn try_parse_file_line_error(line: &str) -> Option<LatexDiagnostic> {
    let trimmed = line.trim();
    // Format: `<file>:<line>: <message>`
    // Ignore warning prefixes or compiler banners that happen to contain colons
    if trimmed.starts_with("LaTeX ")
        || trimmed.starts_with("Package ")
        || trimmed.starts_with("Class ")
        || trimmed.starts_with("Overfull ")
        || trimmed.starts_with("Underfull ")
    {
        return None;
    }

    let bytes = trimmed.as_bytes();
    for (idx, b) in bytes.iter().enumerate() {
        if *b != b':' {
            continue;
        }
        let after = &trimmed[idx + 1..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        let after_digits = &after[digits.len()..];
        if !after_digits.starts_with(": ") {
            continue;
        }
        let file_part = trimmed[..idx].trim();
        let lower = file_part.to_ascii_lowercase();
        let looks_like_file = lower.ends_with(".tex")
            || lower.ends_with(".ltx")
            || lower.ends_with(".sty")
            || lower.ends_with(".cls")
            || lower.ends_with(".bib")
            || file_part.contains('/')
            || file_part.contains('\\');
        if !looks_like_file {
            continue;
        }
        let line_num = digits.parse::<u32>().ok()?;
        let msg = after_digits[2..].trim().to_string();
        if msg.is_empty() {
            continue;
        }
        let clean_file = file_part
            .strip_prefix("./")
            .unwrap_or(file_part)
            .to_string();
        return Some(LatexDiagnostic {
            file: clean_file,
            line: line_num,
            message: msg,
            severity: "error".to_string(),
        });
    }

    None
}

pub fn parse_latex_diagnostics(
    log_and_output: &str,
    default_file: &str,
) -> (Vec<LatexDiagnostic>, Vec<LatexDiagnostic>) {
    let mut errors: Vec<LatexDiagnostic> = Vec::new();
    let mut warnings: Vec<LatexDiagnostic> = Vec::new();
    let mut seen: HashSet<(String, String, u32, String)> = HashSet::new();

    let lines: Vec<&str> = log_and_output.lines().collect();
    let mut current_file = default_file.to_string();

    let mut push_diag = |diag: LatexDiagnostic| {
        let key = (
            diag.severity.clone(),
            diag.file.clone(),
            diag.line,
            diag.message.clone(),
        );
        if seen.insert(key) {
            if diag.severity == "error" {
                errors.push(diag);
            } else {
                warnings.push(diag);
            }
        }
    };

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Track active file(s) when TeX opens (./foo.tex
        let mut search_from = 0;
        while let Some(rel_pos) = trimmed[search_from..].find('(') {
            let abs_pos = search_from + rel_pos;
            let after_paren = &trimmed[abs_pos + 1..];
            let token: String = after_paren
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != ')' && *c != '(')
                .collect();
            if token.ends_with(".tex") || token.ends_with(".sty") || token.ends_with(".cls") {
                current_file = token.strip_prefix("./").unwrap_or(&token).to_string();
            }
            search_from = abs_pos + 1;
        }

        // 1. -file-line-error format (`./main.tex:42: Undefined control sequence.`)
        if let Some(diag) = try_parse_file_line_error(trimmed) {
            current_file = diag.file.clone();
            push_diag(diag);
            continue;
        }

        // 2. Classic `! <error>` format with following `l.<line>`
        if let Some(err_msg) = trimmed.strip_prefix("! ") {
            let mut err_line: u32 = 0;
            for lookahead in lines.iter().skip(i + 1).take(6) {
                let lt = lookahead.trim();
                if let Some(rest) = lt.strip_prefix("l.") {
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(n) = digits.parse::<u32>() {
                        err_line = n;
                        break;
                    }
                }
            }
            push_diag(LatexDiagnostic {
                file: current_file.clone(),
                line: err_line,
                message: err_msg.trim().to_string(),
                severity: "error".to_string(),
            });
            continue;
        }

        // 3. Tectonic / generic fatal error lines
        if let Some(rest) = trimmed.strip_prefix("error: ") {
            push_diag(LatexDiagnostic {
                file: current_file.clone(),
                line: 0,
                message: rest.trim().to_string(),
                severity: "error".to_string(),
            });
            continue;
        }

        // 4. Warnings
        let is_warning_line = trimmed.starts_with("LaTeX Warning:")
            || trimmed.starts_with("LaTeX Font Warning:")
            || (trimmed.starts_with("Package ") && trimmed.contains(" Warning:"))
            || (trimmed.starts_with("Class ") && trimmed.contains(" Warning:"))
            || trimmed.starts_with("Overfull \\")
            || trimmed.starts_with("Underfull \\")
            || trimmed.starts_with("warning:");

        if is_warning_line {
            let warn_line = extract_input_line_number(trimmed);
            push_diag(LatexDiagnostic {
                file: current_file.clone(),
                line: warn_line,
                message: trimmed.to_string(),
                severity: "warning".to_string(),
            });
        }
    }

    (errors, warnings)
}

fn validate_relative_main_file(main_file: &str) -> Result<(), String> {
    let rel = Path::new(main_file);
    for comp in rel.components() {
        match comp {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "Invalid main file path '{}': must be relative to project directory",
                    main_file
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn latex_compile(
    app: AppHandle,
    state: State<'_, LaTeXCompilationState>,
    directory: String,
    compiler: String,
    main_file: String,
    args: Vec<String>,
    custom_path: Option<String>,
    latexmk_engine: Option<String>,
) -> Result<CompilationResult, String> {
    validate_relative_main_file(&main_file)?;
    let started_at = std::time::Instant::now();
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Stop any existing compilation
    {
        let mut process_guard = state.current_process.lock().await;
        if let Some((_, mut child)) = process_guard.take() {
            let _ = child.kill().await;
        }
    }

    let main_rel_path = Path::new(&main_file);
    let work_dir: PathBuf = match main_rel_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Path::new(&directory).join(parent),
        _ => Path::new(&directory).to_path_buf(),
    };

    if !tokio::fs::try_exists(&work_dir).await.unwrap_or(false)
        || !tokio::fs::metadata(&work_dir)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false)
    {
        return Err(format!(
            "Working directory does not exist: {}",
            work_dir.display()
        ));
    }

    let file_name = main_rel_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| main_file.clone());

    let compiler_bin = if let Some(ref path) = custom_path {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            find_compiler(&compiler)
                .await
                .path
                .unwrap_or_else(|| compiler.clone())
        } else {
            trimmed.to_string()
        }
    } else {
        find_compiler(&compiler)
            .await
            .path
            .unwrap_or_else(|| compiler.clone())
    };

    let cmd_args = build_compile_args(&compiler, latexmk_engine.as_deref(), &args, &file_name);

    let env_path = build_tex_env_path();
    let mut cmd = command(&compiler_bin);
    cmd.current_dir(&work_dir)
        .args(&cmd_args)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start compiler '{}': {}", compiler_bin, e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut process_guard = state.current_process.lock().await;
        if state.generation.load(Ordering::SeqCst) != my_gen {
            let _ = child.kill().await;
            let duration_ms = started_at.elapsed().as_millis() as u64;
            return Ok(CompilationResult {
                success: false,
                cancelled: true,
                exit_code: None,
                pdf_path: None,
                error: None,
                duration_ms,
                errors: Vec::new(),
                warnings: Vec::new(),
            });
        }
        *process_guard = Some((my_gen, child));
    }

    let collected_lines = Arc::new(Mutex::new(Vec::<String>::new()));

    let app_clone = app.clone();
    let lines_out = collected_lines.clone();
    let stdout_handle = stdout.map(|stdout| {
        let app = app_clone.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let is_error = line.starts_with("! ")
                    || line.contains("Error")
                    || line.contains("error:")
                    || try_parse_file_line_error(&line).is_some();
                let is_warning = line.contains("Warning:")
                    || line.contains("warning:")
                    || line.starts_with("Overfull \\")
                    || line.starts_with("Underfull \\");

                {
                    let mut guard = lines_out.lock().await;
                    if guard.len() < 4000 {
                        guard.push(line.clone());
                    }
                }

                let event = CompileOutputEvent {
                    line,
                    is_error,
                    is_warning,
                };
                let _ = app.emit("latex-compile-output", &event);
            }
        })
    });

    let lines_err = collected_lines.clone();
    let stderr_handle = stderr.map(|stderr| {
        let app = app_clone;
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                {
                    let mut guard = lines_err.lock().await;
                    if guard.len() < 4000 {
                        guard.push(line.clone());
                    }
                }
                let event = CompileOutputEvent {
                    line,
                    is_error: true,
                    is_warning: false,
                };
                let _ = app.emit("latex-compile-output", &event);
            }
        })
    });

    if let Some(handle) = stdout_handle {
        let _ = handle.await;
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.await;
    }

    let exit_code;
    {
        let mut process_guard = state.current_process.lock().await;
        let is_ours = process_guard
            .as_ref()
            .map(|(g, _)| *g == my_gen)
            .unwrap_or(false);
        if is_ours {
            if let Some((_, mut child)) = process_guard.take() {
                match child.wait().await {
                    Ok(status) => {
                        exit_code = status.code();
                    }
                    Err(e) => {
                        return Err(format!("Failed to wait for compiler: {}", e));
                    }
                }
            } else {
                exit_code = None;
            }
        } else {
            // Process was killed or replaced by a newer generation before wait()
            let duration_ms = started_at.elapsed().as_millis() as u64;
            return Ok(CompilationResult {
                success: false,
                cancelled: true,
                exit_code: None,
                pdf_path: None,
                error: None,
                duration_ms,
                errors: Vec::new(),
                warnings: Vec::new(),
            });
        }
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    if state.generation.load(Ordering::SeqCst) != my_gen {
        return Ok(CompilationResult {
            success: false,
            cancelled: true,
            exit_code,
            pdf_path: None,
            error: None,
            duration_ms,
            errors: Vec::new(),
            warnings: Vec::new(),
        });
    }

    let base_name = file_name.strip_suffix(".tex").unwrap_or(&file_name);
    let pdf_path_buf = work_dir.join(format!("{}.pdf", base_name));
    let log_path_buf = work_dir.join(format!("{}.log", base_name));
    let pdf_path_str = pdf_path_buf.to_string_lossy().to_string();

    let mut combined_log = tokio::fs::read_to_string(&log_path_buf)
        .await
        .unwrap_or_default();

    {
        let output_lines = collected_lines.lock().await;
        if !output_lines.is_empty() {
            if !combined_log.is_empty() {
                combined_log.push('\n');
            }
            combined_log.push_str(&output_lines.join("\n"));
        }
    }

    let (errors, warnings) = parse_latex_diagnostics(&combined_log, &file_name);
    let pdf_exists = tokio::fs::try_exists(&pdf_path_buf).await.unwrap_or(false);
    let success = exit_code == Some(0) && pdf_exists;

    Ok(CompilationResult {
        success,
        cancelled: false,
        exit_code,
        pdf_path: if pdf_exists { Some(pdf_path_str) } else { None },
        error: if !success && !pdf_exists {
            Some("PDF was not generated".to_string())
        } else if !success {
            Some(format!("Compilation failed with exit code {:?}", exit_code))
        } else {
            None
        },
        duration_ms,
        errors,
        warnings,
    })
}

#[tauri::command]
pub async fn latex_stop_compilation(
    state: State<'_, LaTeXCompilationState>,
) -> Result<bool, String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut process_guard = state.current_process.lock().await;
    if let Some((_, mut child)) = process_guard.take() {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to stop compilation: {}", e))?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn latex_clean_aux_files(
    directory: String,
    main_file: Option<String>,
) -> Result<Vec<String>, String> {
    let aux_extensions = [
        ".aux",
        ".log",
        ".out",
        ".toc",
        ".lof",
        ".lot",
        ".fls",
        ".fdb_latexmk",
        ".bbl",
        ".blg",
        ".nav",
        ".snm",
        ".vrb",
        ".xdv",
        ".bcf",
        ".run.xml",
    ];

    let mut removed: Vec<String> = Vec::new();

    if let Some(ref mf) = main_file {
        if !mf.trim().is_empty() {
            validate_relative_main_file(mf)?;
            let main_rel_path = Path::new(mf);
            let work_dir: PathBuf = match main_rel_path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => {
                    Path::new(&directory).join(parent)
                }
                _ => Path::new(&directory).to_path_buf(),
            };
            let file_name = main_rel_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| mf.clone());
            let base_name = file_name.strip_suffix(".tex").unwrap_or(&file_name);

            for ext in &aux_extensions {
                let candidate_name = format!("{}{}", base_name, ext);
                let file_path = work_dir.join(&candidate_name);
                if tokio::fs::try_exists(&file_path).await.unwrap_or(false)
                    && tokio::fs::remove_file(&file_path).await.is_ok()
                {
                    removed.push(candidate_name);
                }
            }
            return Ok(removed);
        }
    }

    // Fallback when no main_file is configured: remove auxiliary files in directory root
    let mut entries = tokio::fs::read_dir(&directory)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if aux_extensions.iter().any(|ext| name.ends_with(ext))
            && tokio::fs::remove_file(&path).await.is_ok()
        {
            removed.push(name.to_string());
        }
    }

    Ok(removed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SynctexViewResult {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub h: f64,
    pub v: f64,
    pub width: f64,
    pub height: f64,
}

fn decode_process_bytes(bytes: &[u8]) -> String {
    if let Ok(s) = String::from_utf8(bytes.to_vec()) {
        s
    } else {
        #[cfg(target_os = "windows")]
        {
            let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
            decoded.into_owned()
        }
        #[cfg(not(target_os = "windows"))]
        {
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}

pub fn parse_synctex_view_output(stdout: &str) -> Result<SynctexViewResult, String> {
    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    let mut h: Option<f64> = None;
    let mut v: Option<f64> = None;
    let mut width: Option<f64> = None;
    let mut height: Option<f64> = None;
    let mut in_result = false;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed == "SyncTeX result begin" {
            in_result = true;
            continue;
        }
        if trimmed == "SyncTeX result end" && page.is_some() {
            break;
        }
        if !in_result && !trimmed.starts_with("Page:") {
            continue;
        }
        if let Some(val) = trimmed.strip_prefix("Page:") {
            if page.is_none() {
                page = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("x:") {
            if x.is_none() {
                x = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("y:") {
            if y.is_none() {
                y = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("h:") {
            if h.is_none() {
                h = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("v:") {
            if v.is_none() {
                v = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("W:") {
            if width.is_none() {
                width = val.trim().parse().ok();
            }
        } else if let Some(val) = trimmed.strip_prefix("H:") {
            if height.is_none() {
                height = val.trim().parse().ok();
            }
        }
    }

    let page_num = page.ok_or_else(|| "Could not find PDF position for this line".to_string())?;
    Ok(SynctexViewResult {
        page: page_num,
        x: x.unwrap_or(0.0),
        y: y.unwrap_or(0.0),
        h: h.unwrap_or(x.unwrap_or(0.0)),
        v: v.unwrap_or(y.unwrap_or(0.0)),
        width: width.unwrap_or(100.0),
        height: height.unwrap_or(14.0),
    })
}

#[tauri::command]
pub async fn latex_synctex_edit(
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let synctex_info = find_compiler("synctex").await;
    let synctex_bin = if synctex_info.available {
        synctex_info.path.unwrap_or_else(|| "synctex".to_string())
    } else {
        return Err("SYNCTEX_NOT_INSTALLED: SyncTeX binary was not found. Install a TeX distribution (TeX Live, MiKTeX, or TinyTeX) to enable PDF-to-source navigation.".to_string());
    };

    let input_spec = format!("{}:{}:{}:{}", page, x, y, pdf_path);
    let mut cmd = command(&synctex_bin);
    cmd.arg("edit")
        .arg("-o")
        .arg(&input_spec)
        .env("PATH", build_tex_env_path());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run synctex: {} (bin={})", e, synctex_bin))?;

    if !output.status.success() {
        let stderr = decode_process_bytes(&output.stderr);
        return Err(format!("synctex edit failed: {}", stderr));
    }

    let stdout = decode_process_bytes(&output.stdout);

    let mut file = String::new();
    let mut line: u32 = 0;
    let mut column: u32 = 0;

    for output_line in stdout.lines() {
        if let Some(val) = output_line.strip_prefix("Input:") {
            file = val.trim().to_string();
        } else if let Some(val) = output_line.strip_prefix("Line:") {
            line = val.trim().parse().unwrap_or(0);
        } else if let Some(val) = output_line.strip_prefix("Column:") {
            column = val.trim().parse().unwrap_or(0);
        }
    }

    if file.is_empty() || line == 0 {
        return Err("Could not find source location for this position".to_string());
    }

    Ok(SynctexResult { file, line, column })
}

#[tauri::command]
pub async fn latex_synctex_view(
    pdf_path: String,
    tex_path: String,
    line: u32,
    column: u32,
) -> Result<SynctexViewResult, String> {
    let synctex_info = find_compiler("synctex").await;
    let synctex_bin = if synctex_info.available {
        synctex_info.path.unwrap_or_else(|| "synctex".to_string())
    } else {
        return Err("SYNCTEX_NOT_INSTALLED: SyncTeX binary was not found. Install a TeX distribution (TeX Live, MiKTeX, or TinyTeX) to enable source-to-PDF navigation.".to_string());
    };

    let input_spec = format!("{}:{}:{}", line, column.max(1), tex_path);
    let mut cmd = command(&synctex_bin);
    cmd.arg("view")
        .arg("-i")
        .arg(&input_spec)
        .arg("-o")
        .arg(&pdf_path)
        .env("PATH", build_tex_env_path());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run synctex: {} (bin={})", e, synctex_bin))?;

    if !output.status.success() {
        let stderr = decode_process_bytes(&output.stderr);
        return Err(format!("synctex view failed: {}", stderr));
    }

    let stdout = decode_process_bytes(&output.stdout);
    parse_synctex_view_output(&stdout)
}

/// Quick-install synctex via tlmgr (when a TeX distribution already exists).
#[tauri::command]
pub async fn latex_install_synctex() -> Result<bool, String> {
    let tlmgr_info = find_compiler("tlmgr").await;
    if !tlmgr_info.available {
        return Ok(false);
    }

    let tlmgr_bin = tlmgr_info.path.unwrap_or_else(|| "tlmgr".to_string());

    let mut cmd = command(&tlmgr_bin);
    cmd.args(["install", "--reinstall", "synctex"])
        .env("PATH", build_tex_env_path());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run tlmgr: {}", e))?;

    if output.status.success() {
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tlmgr install synctex failed: {}", stderr))
    }
}

/// Get recommended LaTeX distributions for the current platform
#[tauri::command]
pub async fn latex_get_distributions() -> Result<Vec<LaTeXDistribution>, String> {
    let mut distributions = Vec::new();

    #[cfg(target_os = "windows")]
    {
        distributions.push(LaTeXDistribution {
            name: "TinyTeX".to_string(),
            id: "tinytex".to_string(),
            description: "Recommended. Lightweight (~150MB), cross-platform, with on-demand package installation.".to_string(),
            install_command: Some("tinytex-install".to_string()),
            download_url: Some("https://yihui.org/tinytex/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "Tectonic".to_string(),
            id: "tectonic".to_string(),
            description: "Modern standalone Rust TeX engine with automatic package fetching."
                .to_string(),
            install_command: Some("winget install tectonic-typesetting.tectonic".to_string()),
            download_url: Some("https://tectonic-typesetting.github.io/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "MiKTeX".to_string(),
            id: "miktex".to_string(),
            description: "Popular Windows distribution with on-demand package installation."
                .to_string(),
            install_command: Some("winget install MiKTeX.MiKTeX".to_string()),
            download_url: Some("https://miktex.org/download".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "TeX Live".to_string(),
            id: "texlive".to_string(),
            description: "Full-featured distribution, larger download size (~4GB).".to_string(),
            install_command: None,
            download_url: Some("https://tug.org/texlive/acquire-netinstall.html".to_string()),
        });
    }

    #[cfg(target_os = "macos")]
    {
        distributions.push(LaTeXDistribution {
            name: "TinyTeX".to_string(),
            id: "tinytex".to_string(),
            description: "Recommended. Lightweight (~150MB), cross-platform, with on-demand package installation.".to_string(),
            install_command: Some("tinytex-install".to_string()),
            download_url: Some("https://yihui.org/tinytex/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "Tectonic".to_string(),
            id: "tectonic".to_string(),
            description:
                "Fast standalone Rust TeX engine via Homebrew with automatic package fetching."
                    .to_string(),
            install_command: Some("brew install tectonic".to_string()),
            download_url: Some("https://tectonic-typesetting.github.io/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "BasicTeX".to_string(),
            id: "basictex".to_string(),
            description:
                "Smaller installation (~100MB). May need to install additional packages via tlmgr."
                    .to_string(),
            install_command: Some("brew install --cask basictex".to_string()),
            download_url: Some("https://tug.org/mactex/morepackages.html".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "MacTeX".to_string(),
            id: "mactex".to_string(),
            description: "Full TeX Live distribution with Mac-specific tools (~5GB).".to_string(),
            install_command: Some("brew install --cask mactex".to_string()),
            download_url: Some("https://tug.org/mactex/".to_string()),
        });
    }

    #[cfg(target_os = "linux")]
    {
        distributions.push(LaTeXDistribution {
            name: "TinyTeX".to_string(),
            id: "tinytex".to_string(),
            description: "Recommended. Lightweight (~150MB), cross-platform, with on-demand package installation.".to_string(),
            install_command: Some("tinytex-install".to_string()),
            download_url: Some("https://yihui.org/tinytex/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "Tectonic".to_string(),
            id: "tectonic".to_string(),
            description: "Modern standalone Rust TeX engine with automatic package fetching."
                .to_string(),
            install_command: None,
            download_url: Some("https://tectonic-typesetting.github.io/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "TeX Live (Full)".to_string(),
            id: "texlive-full".to_string(),
            description: "Complete TeX Live installation with all packages (~5GB).".to_string(),
            install_command: Some(get_linux_install_command("texlive-full")),
            download_url: Some("https://tug.org/texlive/".to_string()),
        });
        distributions.push(LaTeXDistribution {
            name: "TeX Live (Basic + CJK)".to_string(),
            id: "texlive-cjk".to_string(),
            description: "Basic installation with CJK (Chinese/Japanese/Korean) support."
                .to_string(),
            install_command: Some(get_linux_install_command("texlive-cjk")),
            download_url: None,
        });
    }

    Ok(distributions)
}

#[cfg(target_os = "linux")]
fn get_linux_install_command(package: &str) -> String {
    if Path::new("/usr/bin/apt").exists() {
        match package {
            "texlive-full" => "sudo apt install -y texlive-full".to_string(),
            "texlive-cjk" => "sudo apt install -y texlive-base texlive-xetex texlive-lang-chinese texlive-lang-japanese texlive-lang-korean".to_string(),
            _ => format!("sudo apt install -y {}", package),
        }
    } else if Path::new("/usr/bin/dnf").exists() {
        match package {
            "texlive-full" => "sudo dnf install -y texlive-scheme-full".to_string(),
            "texlive-cjk" => {
                "sudo dnf install -y texlive-scheme-basic texlive-xetex texlive-ctex".to_string()
            }
            _ => format!("sudo dnf install -y {}", package),
        }
    } else if Path::new("/usr/bin/pacman").exists() {
        match package {
            "texlive-full" => "sudo pacman -S --noconfirm texlive".to_string(),
            "texlive-cjk" => "sudo pacman -S --noconfirm texlive-basic texlive-xetex texlive-langchinese texlive-langjapanese texlive-langkorean".to_string(),
            _ => format!("sudo pacman -S --noconfirm {}", package),
        }
    } else {
        "# Please install TeX Live manually from https://tug.org/texlive/".to_string()
    }
}

/// Install LaTeX distribution
#[tauri::command]
pub async fn latex_install(
    app: AppHandle,
    distribution_id: String,
) -> Result<InstallResult, String> {
    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "starting".to_string(),
            message: "Preparing installation...".to_string(),
            progress: Some(0.0),
        },
    );

    #[cfg(target_os = "windows")]
    {
        return install_windows(&app, &distribution_id).await;
    }

    #[cfg(target_os = "macos")]
    {
        return install_macos(&app, &distribution_id).await;
    }

    #[cfg(target_os = "linux")]
    {
        return install_linux(&app, &distribution_id).await;
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

#[cfg(target_os = "windows")]
async fn install_windows(app: &AppHandle, distribution_id: &str) -> Result<InstallResult, String> {
    match distribution_id {
        "tinytex" => install_tinytex_windows(app).await,
        "miktex" => {
            install_winget_windows(
                app,
                "MiKTeX.MiKTeX",
                "MiKTeX",
                "https://miktex.org/download",
            )
            .await
        }
        "tectonic" => {
            install_winget_windows(
                app,
                "tectonic-typesetting.tectonic",
                "Tectonic",
                "https://tectonic-typesetting.github.io/",
            )
            .await
        }
        _ => Ok(InstallResult {
            success: false,
            message:
                "Please download and install this distribution manually from the official website."
                    .to_string(),
            needs_restart: false,
        }),
    }
}

#[cfg(target_os = "windows")]
async fn install_tinytex_windows(app: &AppHandle) -> Result<InstallResult, String> {
    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "downloading".to_string(),
            message: "Downloading TinyTeX installer...".to_string(),
            progress: Some(0.1),
        },
    );

    let temp_dir = std::env::temp_dir();
    let script_path = temp_dir.join("install-tinytex.bat");

    let mut child = command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Invoke-WebRequest -Uri 'https://yihui.org/tinytex/install-bin-windows.bat' -OutFile '{}'",
                script_path.display()
            ),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to download installer: {}", e))?;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !status.success() {
        return Ok(InstallResult {
            success: false,
            message: "Failed to download TinyTeX installer. Please check your internet connection or download manually from https://yihui.org/tinytex/".to_string(),
            needs_restart: false,
        });
    }

    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "installing".to_string(),
            message: "Installing TinyTeX... This may take a few minutes.".to_string(),
            progress: Some(0.3),
        },
    );

    let mut child = command("cmd")
        .args(["/c", &script_path.to_string_lossy()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run installer: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "latex-install-progress",
                    InstallProgress {
                        stage: "installing".to_string(),
                        message: line,
                        progress: None,
                    },
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Installation failed: {}", e))?;

    let _ = tokio::fs::remove_file(&script_path).await;

    if status.success() {
        let detected = is_compiler_detectable_after_install().await;
        let _ = app.emit(
            "latex-install-progress",
            InstallProgress {
                stage: "complete".to_string(),
                message: "TinyTeX installed successfully!".to_string(),
                progress: Some(1.0),
            },
        );

        Ok(InstallResult {
            success: true,
            message: if detected {
                "TinyTeX installed successfully and compiler detection is ready.".to_string()
            } else {
                "TinyTeX installed successfully. Please restart the application to detect the new installation."
                    .to_string()
            },
            needs_restart: !detected,
        })
    } else {
        Ok(InstallResult {
            success: false,
            message: "Installation failed. Please try downloading TinyTeX manually from https://yihui.org/tinytex/".to_string(),
            needs_restart: false,
        })
    }
}

#[cfg(target_os = "windows")]
async fn install_winget_windows(
    app: &AppHandle,
    package_id: &str,
    display_name: &str,
    fallback_url: &str,
) -> Result<InstallResult, String> {
    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "checking".to_string(),
            message: "Checking for winget...".to_string(),
            progress: Some(0.1),
        },
    );

    let winget_check = command("winget").arg("--version").output().await;

    if winget_check.is_err() || !winget_check.unwrap().status.success() {
        return Ok(InstallResult {
            success: false,
            message: format!(
                "winget is not available. Please install {} manually from {}",
                display_name, fallback_url
            ),
            needs_restart: false,
        });
    }

    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "installing".to_string(),
            message: format!(
                "Installing {} via winget... This may take several minutes.",
                display_name
            ),
            progress: Some(0.2),
        },
    );

    let mut child = command("winget")
        .args([
            "install",
            package_id,
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start winget: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "latex-install-progress",
                    InstallProgress {
                        stage: "installing".to_string(),
                        message: line,
                        progress: None,
                    },
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Installation failed: {}", e))?;

    if status.success() {
        let detected = is_compiler_detectable_after_install().await;
        let _ = app.emit(
            "latex-install-progress",
            InstallProgress {
                stage: "complete".to_string(),
                message: format!("{} installed successfully!", display_name),
                progress: Some(1.0),
            },
        );

        Ok(InstallResult {
            success: true,
            message: if detected {
                format!(
                    "{} installed successfully and compiler detection is ready.",
                    display_name
                )
            } else {
                format!(
                    "{} installed successfully. Please restart the application to detect the new installation.",
                    display_name
                )
            },
            needs_restart: !detected,
        })
    } else {
        Ok(InstallResult {
            success: false,
            message: format!(
                "Installation failed. Please try installing {} manually from {}",
                display_name, fallback_url
            ),
            needs_restart: false,
        })
    }
}

#[cfg(target_os = "macos")]
async fn install_macos(app: &AppHandle, distribution_id: &str) -> Result<InstallResult, String> {
    match distribution_id {
        "tinytex" => install_tinytex_unix(app).await,
        "tectonic" => install_brew(app, "tectonic", false).await,
        "mactex" | "basictex" => install_brew(app, distribution_id, true).await,
        _ => Ok(InstallResult {
            success: false,
            message: "Unknown distribution".to_string(),
            needs_restart: false,
        }),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn install_tinytex_unix(app: &AppHandle) -> Result<InstallResult, String> {
    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "downloading".to_string(),
            message: "Downloading and installing TinyTeX...".to_string(),
            progress: Some(0.1),
        },
    );

    let mut child = command("sh")
        .args([
            "-c",
            "curl -sL 'https://yihui.org/tinytex/install-bin-unix.sh' | sh",
        ])
        .env("PATH", build_tex_env_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start installer: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "latex-install-progress",
                    InstallProgress {
                        stage: "installing".to_string(),
                        message: line,
                        progress: None,
                    },
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "latex-install-progress",
                    InstallProgress {
                        stage: "installing".to_string(),
                        message: line,
                        progress: None,
                    },
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Installation failed: {}", e))?;

    if status.success() {
        let detected = is_compiler_detectable_after_install().await;
        let _ = app.emit(
            "latex-install-progress",
            InstallProgress {
                stage: "complete".to_string(),
                message: "TinyTeX installed successfully!".to_string(),
                progress: Some(1.0),
            },
        );

        Ok(InstallResult {
            success: true,
            message: if detected {
                "TinyTeX installed successfully and compiler detection is ready.".to_string()
            } else {
                "TinyTeX installed successfully. Please restart the application to detect the new installation."
                    .to_string()
            },
            needs_restart: !detected,
        })
    } else {
        Ok(InstallResult {
            success: false,
            message: "Installation failed. Please try downloading TinyTeX manually from https://yihui.org/tinytex/".to_string(),
            needs_restart: false,
        })
    }
}

#[cfg(target_os = "macos")]
async fn install_brew(
    app: &AppHandle,
    package: &str,
    is_cask: bool,
) -> Result<InstallResult, String> {
    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "checking".to_string(),
            message: "Checking for Homebrew...".to_string(),
            progress: Some(0.1),
        },
    );

    let env_path = build_tex_env_path();
    let brew_bin = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .unwrap_or("brew");

    let brew_check = command(brew_bin)
        .arg("--version")
        .env("PATH", &env_path)
        .output()
        .await;

    if brew_check.is_err() || !brew_check.unwrap().status.success() {
        return Ok(InstallResult {
            success: false,
            message: "Homebrew is not installed. Please install Homebrew first (https://brew.sh) or download manually.".to_string(),
            needs_restart: false,
        });
    }

    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "installing".to_string(),
            message: format!(
                "Installing {} via Homebrew... This may take a while.",
                package
            ),
            progress: Some(0.2),
        },
    );

    let mut args = vec!["install"];
    if is_cask {
        args.push("--cask");
    }
    args.push(package);

    let mut child = command(brew_bin)
        .args(&args)
        .env("PATH", &env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start brew: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "latex-install-progress",
                    InstallProgress {
                        stage: "installing".to_string(),
                        message: line,
                        progress: None,
                    },
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Installation failed: {}", e))?;

    if status.success() {
        let detected = is_compiler_detectable_after_install().await;
        let _ = app.emit(
            "latex-install-progress",
            InstallProgress {
                stage: "complete".to_string(),
                message: format!("{} installed successfully!", package),
                progress: Some(1.0),
            },
        );

        Ok(InstallResult {
            success: true,
            message: if detected {
                format!(
                    "{} installed successfully and compiler detection is ready.",
                    package
                )
            } else {
                format!(
                    "{} installed successfully. Please restart the application to detect the new installation.",
                    package
                )
            },
            needs_restart: !detected,
        })
    } else {
        Ok(InstallResult {
            success: false,
            message: format!(
                "Installation failed. Please try installing {} manually.",
                package
            ),
            needs_restart: false,
        })
    }
}

#[cfg(target_os = "linux")]
async fn install_linux(app: &AppHandle, distribution_id: &str) -> Result<InstallResult, String> {
    if distribution_id == "tinytex" {
        return install_tinytex_unix(app).await;
    }

    let install_cmd = get_linux_install_command(distribution_id);

    if install_cmd.starts_with('#') {
        return Ok(InstallResult {
            success: false,
            message: "Could not detect package manager. Please install TeX Live manually."
                .to_string(),
            needs_restart: false,
        });
    }

    let _ = app.emit(
        "latex-install-progress",
        InstallProgress {
            stage: "installing".to_string(),
            message: format!("Running: {}", install_cmd),
            progress: Some(0.1),
        },
    );

    Ok(InstallResult {
        success: false,
        message: format!(
            "Please run the following command in your terminal to install LaTeX:\n\n{}\n\nAfter installation, restart the application.",
            install_cmd
        ),
        needs_restart: true,
    })
}

/// Open the download URL for manual installation
#[tauri::command]
pub async fn latex_open_download_page(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {}", e))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MainFileDetectionResult {
    pub main_file: Option<String>,
    pub tex_files: Vec<String>,
    pub detection_method: String,
    pub needs_user_input: bool,
    pub message: String,
}

/// Detect the main LaTeX file in a directory
#[tauri::command]
pub async fn latex_detect_main_file(
    directory: String,
    configured_main_file: Option<String>,
) -> Result<MainFileDetectionResult, String> {
    use walkdir::WalkDir;

    let dir_path = Path::new(&directory);
    if !dir_path.exists() {
        return Err("Directory does not exist".to_string());
    }

    if let Some(ref main_file) = configured_main_file {
        let main_path = dir_path.join(main_file);
        if main_path.exists() {
            return Ok(MainFileDetectionResult {
                main_file: Some(main_file.clone()),
                tex_files: vec![main_file.clone()],
                detection_method: "configured".to_string(),
                needs_user_input: false,
                message: format!("Using configured main file: {}", main_file),
            });
        }
    }

    let mut tex_files: Vec<String> = Vec::new();
    for entry in WalkDir::new(&directory)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "tex" {
                    if let Some(name) = path.file_name() {
                        tex_files.push(name.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    if tex_files.len() == 1 {
        let main_file = tex_files[0].clone();
        return Ok(MainFileDetectionResult {
            main_file: Some(main_file.clone()),
            tex_files,
            detection_method: "single_file".to_string(),
            needs_user_input: false,
            message: format!("Only one .tex file found: {}", main_file),
        });
    }

    if tex_files.is_empty() {
        return Ok(MainFileDetectionResult {
            main_file: None,
            tex_files: vec![],
            detection_method: "none".to_string(),
            needs_user_input: true,
            message: "No .tex files found in the project directory".to_string(),
        });
    }

    let mut candidates: Vec<(String, i32)> = Vec::new();

    for tex_file in &tex_files {
        let file_path = dir_path.join(tex_file);
        if let Ok(content) = tokio::fs::read_to_string(&file_path).await {
            let mut score = 0;

            if content.contains("\\documentclass") {
                score += 10;
            }

            if content.contains("\\begin{document}") {
                score += 5;
            }

            let lower_name = tex_file.to_lowercase();
            if lower_name == "main.tex" {
                score += 8;
            } else if lower_name == "paper.tex"
                || lower_name == "article.tex"
                || lower_name == "thesis.tex"
                || lower_name == "dissertation.tex"
            {
                score += 5;
            } else if lower_name == "report.tex" || lower_name == "document.tex" {
                score += 3;
            }

            if lower_name.starts_with("chapter") || lower_name.starts_with("section") {
                score -= 3;
            }
            if lower_name == "preamble.tex"
                || lower_name == "packages.tex"
                || lower_name == "macros.tex"
            {
                score -= 5;
            }
            if lower_name == "abstract.tex"
                || lower_name == "appendix.tex"
                || lower_name == "bibliography.tex"
            {
                score -= 3;
            }

            if score > 0 {
                candidates.push((tex_file.clone(), score));
            }
        }
    }

    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.1));

    if !candidates.is_empty() {
        let best = &candidates[0];
        let second_best_score = candidates.get(1).map(|c| c.1).unwrap_or(0);

        if best.1 >= 10 && best.1 > second_best_score + 3 {
            return Ok(MainFileDetectionResult {
                main_file: Some(best.0.clone()),
                tex_files,
                detection_method: "auto_detected".to_string(),
                needs_user_input: false,
                message: format!(
                    "Auto-detected main file: {} (contains \\documentclass)",
                    best.0
                ),
            });
        }
    }

    let mut sorted_files = tex_files.clone();
    sorted_files.sort_by(|a, b| {
        let score_a = candidates
            .iter()
            .find(|c| &c.0 == a)
            .map(|c| c.1)
            .unwrap_or(0);
        let score_b = candidates
            .iter()
            .find(|c| &c.0 == b)
            .map(|c| c.1)
            .unwrap_or(0);
        score_b.cmp(&score_a)
    });

    Ok(MainFileDetectionResult {
        main_file: None,
        tex_files: sorted_files,
        detection_method: "ambiguous".to_string(),
        needs_user_input: true,
        message: format!(
            "Multiple .tex files found ({}). Please select the main file.",
            tex_files.len()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_common_paths_returns_non_empty() {
        let paths = get_common_paths("pdflatex");
        assert!(!paths.is_empty());
    }

    #[test]
    fn get_common_paths_all_contain_compiler_name() {
        let paths = get_common_paths("xelatex");
        for path in &paths {
            assert!(
                path.contains("xelatex"),
                "path '{}' should contain compiler name",
                path
            );
        }
    }

    fn empty_status() -> LaTeXCompilersStatus {
        LaTeXCompilersStatus {
            pdflatex: CompilerInfo {
                name: "pdflatex".into(),
                path: None,
                available: false,
                version: None,
            },
            xelatex: CompilerInfo {
                name: "xelatex".into(),
                path: None,
                available: false,
                version: None,
            },
            lualatex: CompilerInfo {
                name: "lualatex".into(),
                path: None,
                available: false,
                version: None,
            },
            latexmk: CompilerInfo {
                name: "latexmk".into(),
                path: None,
                available: false,
                version: None,
            },
            tectonic: CompilerInfo {
                name: "tectonic".into(),
                path: None,
                available: false,
                version: None,
            },
        }
    }

    #[test]
    fn has_any_compiler_all_unavailable() {
        assert!(!has_any_compiler(&empty_status()));
    }

    #[test]
    fn has_any_compiler_one_available() {
        let mut status = empty_status();
        status.pdflatex.available = true;
        status.pdflatex.path = Some("/usr/bin/pdflatex".into());
        assert!(has_any_compiler(&status));

        let mut status_tec = empty_status();
        status_tec.tectonic.available = true;
        status_tec.tectonic.path = Some("/opt/homebrew/bin/tectonic".into());
        assert!(has_any_compiler(&status_tec));
    }

    #[test]
    fn build_compile_args_matches_engines() {
        assert_eq!(
            build_compile_args(
                "latexmk",
                Some("xelatex"),
                &["-shell-escape".into()],
                "main.tex"
            ),
            vec![
                "-xelatex",
                "-interaction=nonstopmode",
                "-file-line-error",
                "-synctex=1",
                "-shell-escape",
                "main.tex"
            ]
        );
        assert_eq!(
            build_compile_args("tectonic", None, &[], "paper.tex"),
            vec!["-X", "compile", "--synctex", "--keep-logs", "paper.tex"]
        );
        assert_eq!(
            build_compile_args("pdflatex", None, &[], "main.tex"),
            vec![
                "-interaction=nonstopmode",
                "-file-line-error",
                "-synctex=1",
                "main.tex"
            ]
        );
    }

    #[test]
    fn parse_latex_diagnostics_extracts_file_line_classic_and_warnings() {
        let log = "\
(./main.tex (./sections/intro.tex
./sections/intro.tex:42: Undefined control sequence.
! Missing $ inserted.
<inserted text>
                $
l.18 x_1 = 2
LaTeX Warning: Reference `fig:missing' on page 2 undefined on input line 55.
Overfull \\hbox (12.0pt too wide) in paragraph at lines 70--75
";
        let (errors, warnings) = parse_latex_diagnostics(log, "main.tex");
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].file, "sections/intro.tex");
        assert_eq!(errors[0].line, 42);
        assert_eq!(errors[0].message, "Undefined control sequence.");
        assert_eq!(errors[1].file, "sections/intro.tex");
        assert_eq!(errors[1].line, 18);
        assert_eq!(errors[1].message, "Missing $ inserted.");

        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[0].line, 55);
        assert_eq!(warnings[1].line, 70);
    }

    #[test]
    fn parse_synctex_view_output_extracts_coordinates() {
        let sample = "\
SyncTeX result begin
Output:main.pdf
Page:3
x:120.5
y:340.25
h:108.0
v:332.0
W:240.0
H:12.5
before:
SyncTeX result end
";
        let parsed = parse_synctex_view_output(sample).unwrap();
        assert_eq!(parsed.page, 3);
        assert!((parsed.x - 120.5).abs() < 0.01);
        assert!((parsed.y - 340.25).abs() < 0.01);
        assert!((parsed.width - 240.0).abs() < 0.01);
    }

    #[test]
    fn compiler_info_serialization_roundtrip() {
        let info = CompilerInfo {
            name: "pdflatex".into(),
            path: Some("/usr/bin/pdflatex".into()),
            available: true,
            version: Some("3.14".into()),
        };
        let json = serde_json::to_string(&info).unwrap();
        let deserialized: CompilerInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, info.name);
        assert_eq!(deserialized.path, info.path);
    }

    #[test]
    fn compilation_result_serialization_roundtrip() {
        let result = CompilationResult {
            success: true,
            cancelled: false,
            exit_code: Some(0),
            pdf_path: Some("/tmp/main.pdf".into()),
            error: None,
            duration_ms: 412,
            errors: vec![],
            warnings: vec![],
        };
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: CompilationResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.success, result.success);
        assert_eq!(deserialized.exit_code, result.exit_code);
        assert_eq!(deserialized.pdf_path, result.pdf_path);
        assert_eq!(deserialized.duration_ms, 412);
    }

    #[test]
    fn validate_relative_main_file_rejects_traversal() {
        assert!(validate_relative_main_file("main.tex").is_ok());
        assert!(validate_relative_main_file("chapters/main.tex").is_ok());
        assert!(validate_relative_main_file("../escape.tex").is_err());
        assert!(validate_relative_main_file("/etc/passwd").is_err());
    }

    #[tokio::test]
    async fn latex_clean_aux_files_removes_matching_files_and_returns_names() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        tokio::fs::write(root.join("paper.tex"), "\\documentclass{article}")
            .await
            .unwrap();
        tokio::fs::write(root.join("paper.aux"), "aux")
            .await
            .unwrap();
        tokio::fs::write(root.join("paper.log"), "log")
            .await
            .unwrap();
        tokio::fs::write(root.join("other.aux"), "keep")
            .await
            .unwrap();

        let removed = latex_clean_aux_files(
            root.to_string_lossy().to_string(),
            Some("paper.tex".to_string()),
        )
        .await
        .unwrap();

        assert!(removed.contains(&"paper.aux".to_string()));
        assert!(removed.contains(&"paper.log".to_string()));
        assert!(!removed.contains(&"other.aux".to_string()));
        assert!(root.join("paper.tex").exists());
        assert!(root.join("other.aux").exists());

        // Fallback when main_file is None cleans directory aux files
        let removed_all = latex_clean_aux_files(root.to_string_lossy().to_string(), None)
            .await
            .unwrap();
        assert_eq!(removed_all, vec!["other.aux".to_string()]);
    }
}
