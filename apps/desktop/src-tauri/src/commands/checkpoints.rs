use super::util::command;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::io::AsyncWriteExt;

// Git keeps these refs local to the checkout that created them.
const CHECKPOINT_REF_PREFIX: &str = "refs/worktree/orchestratex/checkpoints/";
static TEMP_INDEX_COUNTER: AtomicU64 = AtomicU64::new(1);
static REPO_LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn repo_lock(repo_root: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let map = REPO_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(repo_root.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub id: String,
    pub ref_name: String,
    pub commit_oid: String,
    pub tree_oid: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffResult {
    pub from_id: String,
    pub to_id: Option<String>,
    pub diff_text: String,
    pub files: Vec<CheckpointDiffFile>,
    pub working_tree: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheckpointResult {
    pub restored_id: String,
    pub safety_checkpoint: CheckpointInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelInfo {
    pub name: String,
    pub commit_oid: String,
    pub message: String,
    pub created_at: String,
}

struct TempIndexGuard {
    path: PathBuf,
}

impl TempIndexGuard {
    fn new() -> Self {
        let seq = TEMP_INDEX_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("orchestratex-git-index-{pid}-{seq}"));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn path_str(&self) -> String {
        self.path.to_string_lossy().to_string()
    }
}

impl Drop for TempIndexGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn validate_ref_component(name: &str, kind: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err(format!("Invalid {kind}: must be 1..=128 characters"));
    }
    if name.starts_with('/')
        || name.ends_with('/')
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
    {
        return Err(format!("Invalid {kind}: unsafe ref syntax"));
    }
    for ch in name.chars() {
        if ch.is_control()
            || ch.is_whitespace()
            || matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        {
            return Err(format!("Invalid {kind}: disallowed character '{ch}'"));
        }
    }
    Ok(())
}

async fn run_git_env(cwd: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = command("git");
    cmd.args(args).current_dir(cwd);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

async fn run_git_stdin(cwd: &str, args: &[&str], stdin_data: &str) -> Result<String, String> {
    let mut cmd = command("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_data.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

async fn ensure_git_repo(dir: &str) -> Result<PathBuf, String> {
    if dir.trim().is_empty() || !Path::new(dir).is_dir() {
        return Err("Project directory does not exist".to_string());
    }
    let toplevel = run_git_env(dir, &["rev-parse", "--show-toplevel"], &[])
        .await
        .map_err(|_| "Not a Git repository".to_string())?;
    let root = tokio::fs::canonicalize(toplevel.trim())
        .await
        .map_err(|error| error.to_string())?;
    let selected = tokio::fs::canonicalize(dir)
        .await
        .map_err(|error| error.to_string())?;
    if selected != root {
        return Err("Open the Git checkout root to use checkpoints".to_string());
    }
    Ok(root)
}

async fn resolve_real_index_path(dir: &str) -> Result<PathBuf, String> {
    let raw = run_git_env(dir, &["rev-parse", "--git-path", "index"], &[]).await?;
    let p = PathBuf::from(raw.trim());
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(Path::new(dir).join(p))
    }
}

async fn write_working_tree_to_temp_index(
    dir: &str,
    idx: &TempIndexGuard,
) -> Result<String, String> {
    let idx_path = idx.path_str();
    let envs = [("GIT_INDEX_FILE", idx_path.as_str())];

    let real_index = resolve_real_index_path(dir).await?;
    if tokio::fs::try_exists(&real_index).await.unwrap_or(false) {
        tokio::fs::copy(&real_index, &idx.path)
            .await
            .map_err(|e| format!("Failed to seed temp index: {e}"))?;
    } else if run_git_env(dir, &["rev-parse", "--verify", "HEAD"], &[])
        .await
        .is_ok()
    {
        run_git_env(dir, &["read-tree", "HEAD"], &envs).await?;
    }

    run_git_env(dir, &["add", "-A"], &envs).await?;
    let tree_oid = run_git_env(dir, &["write-tree"], &envs).await?;
    Ok(tree_oid.trim().to_string())
}

async fn compute_working_tree_identity(
    dir: &str,
    known_working_tree_oid: Option<&str>,
) -> Result<String, String> {
    let head_oid = run_git_env(dir, &["rev-parse", "--verify", "HEAD"], &[])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "UNBORN".to_string());

    let index_tree_oid = run_git_env(dir, &["write-tree"], &[])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "NO_INDEX".to_string());

    let working_tree_oid = match known_working_tree_oid {
        Some(oid) => oid.to_string(),
        None => {
            let idx = TempIndexGuard::new();
            write_working_tree_to_temp_index(dir, &idx).await?
        }
    };

    Ok(format!("{head_oid}:{index_tree_oid}:{working_tree_oid}"))
}

fn next_checkpoint_id() -> String {
    let seq = TEMP_INDEX_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("cp-{nanos}-{seq}")
}

async fn checkpoint_create_locked(
    dir: &str,
    id: Option<String>,
    message: Option<String>,
) -> Result<CheckpointInfo, String> {
    let cp_id = match id {
        Some(custom) => {
            validate_ref_component(&custom, "checkpoint id")?;
            custom
        }
        None => next_checkpoint_id(),
    };
    let ref_name = format!("{CHECKPOINT_REF_PREFIX}{cp_id}");
    let msg = message.unwrap_or_else(|| format!("Checkpoint {cp_id}"));

    let idx = TempIndexGuard::new();
    let tree_oid = write_working_tree_to_temp_index(dir, &idx).await?;

    let head_oid = run_git_env(dir, &["rev-parse", "--verify", "HEAD"], &[])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let commit_oid = if let Some(parent) = head_oid.as_deref() {
        run_git_env(
            dir,
            &["commit-tree", &tree_oid, "-p", parent, "-m", &msg],
            &[],
        )
        .await?
    } else {
        run_git_env(dir, &["commit-tree", &tree_oid, "-m", &msg], &[]).await?
    };
    let commit_oid = commit_oid.trim().to_string();

    run_git_env(dir, &["update-ref", &ref_name, &commit_oid], &[]).await?;

    let created_at = run_git_env(dir, &["show", "-s", "--format=%cI", &commit_oid], &[])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(CheckpointInfo {
        id: cp_id,
        ref_name,
        commit_oid,
        tree_oid,
        message: msg,
        created_at,
    })
}

#[tauri::command]
pub async fn checkpoint_create(
    dir: String,
    id: Option<String>,
    message: Option<String>,
) -> Result<CheckpointInfo, String> {
    let repo_root = ensure_git_repo(&dir).await?;
    let lock = repo_lock(&repo_root);
    let _guard = lock.lock().await;
    checkpoint_create_locked(&dir, id, message).await
}

pub async fn checkpoint_exists(dir: &str, id: &str) -> bool {
    if validate_ref_component(id, "checkpoint id").is_err() {
        return false;
    }
    let ref_name = format!("{CHECKPOINT_REF_PREFIX}{id}");
    run_git_env(dir, &["rev-parse", "--verify", "--quiet", &ref_name], &[])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn checkpoint_list(dir: String) -> Result<Vec<CheckpointInfo>, String> {
    ensure_git_repo(&dir).await?;
    let out = run_git_env(
        &dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)%09%(committerdate:iso8601-strict)",
            CHECKPOINT_REF_PREFIX,
        ],
        &[],
    )
    .await?;

    let mut items = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() < 5 {
            continue;
        }
        let ref_name = parts[0].to_string();
        let id = ref_name
            .strip_prefix(CHECKPOINT_REF_PREFIX)
            .unwrap_or(&ref_name)
            .to_string();
        items.push(CheckpointInfo {
            id,
            ref_name,
            commit_oid: parts[1].to_string(),
            tree_oid: parts[2].to_string(),
            message: parts[3].to_string(),
            created_at: parts[4].to_string(),
        });
    }
    Ok(items)
}

async fn resolve_checkpoint_commit(dir: &str, id: &str) -> Result<String, String> {
    validate_ref_component(id, "checkpoint id")?;
    let ref_name = format!("{CHECKPOINT_REF_PREFIX}{id}");
    let oid = run_git_env(dir, &["rev-parse", "--verify", &ref_name], &[])
        .await
        .map_err(|_| format!("Checkpoint '{id}' not found"))?;
    Ok(oid.trim().to_string())
}

fn parse_numstat_and_status(numstat: &str, name_status: &str) -> Vec<CheckpointDiffFile> {
    use std::collections::HashMap;
    let mut statuses: HashMap<String, String> = HashMap::new();
    for line in name_status.lines() {
        let mut parts = line.splitn(2, '\t');
        if let (Some(code), Some(path)) = (parts.next(), parts.next()) {
            let status = match code.chars().next() {
                Some('A') => "added",
                Some('M') => "modified",
                Some('D') => "deleted",
                Some('R') => "renamed",
                Some('C') => "copied",
                _ => "unknown",
            };
            statuses.insert(path.to_string(), status.to_string());
        }
    }

    let mut files = Vec::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = parts[0].parse::<usize>().unwrap_or(0);
        let deletions = parts[1].parse::<usize>().unwrap_or(0);
        let path = parts[2].to_string();
        let status = statuses
            .get(&path)
            .cloned()
            .unwrap_or_else(|| "modified".to_string());
        files.push(CheckpointDiffFile {
            path,
            status,
            additions,
            deletions,
        });
    }
    files
}

#[tauri::command]
pub async fn checkpoint_diff(
    dir: String,
    from_id: String,
    to_id: Option<String>,
) -> Result<CheckpointDiffResult, String> {
    ensure_git_repo(&dir).await?;
    let from_oid = resolve_checkpoint_commit(&dir, &from_id).await?;

    let (to_tree_or_commit, known_wt_oid) = match &to_id {
        Some(target) => (resolve_checkpoint_commit(&dir, target).await?, None),
        None => {
            let idx = TempIndexGuard::new();
            let wt_oid = write_working_tree_to_temp_index(&dir, &idx).await?;
            (wt_oid.clone(), Some(wt_oid))
        }
    };

    let diff_text = run_git_env(&dir, &["diff", &from_oid, &to_tree_or_commit], &[]).await?;
    let numstat = run_git_env(
        &dir,
        &["diff", "--numstat", &from_oid, &to_tree_or_commit],
        &[],
    )
    .await?;
    let name_status = run_git_env(
        &dir,
        &["diff", "--name-status", &from_oid, &to_tree_or_commit],
        &[],
    )
    .await?;

    let files = parse_numstat_and_status(&numstat, &name_status);
    let working_tree = compute_working_tree_identity(&dir, known_wt_oid.as_deref()).await?;

    Ok(CheckpointDiffResult {
        from_id,
        to_id,
        diff_text,
        files,
        working_tree,
    })
}

async fn ensure_restore_preserves_ignored(dir: &str, target_tree: &str) -> Result<(), String> {
    let ignored_out = run_git_env(
        dir,
        &["ls-files", "--others", "--ignored", "--exclude-standard"],
        &[],
    )
    .await?;
    let ignored: std::collections::HashSet<&str> = ignored_out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if ignored.is_empty() {
        return Ok(());
    }

    let tree_files_out =
        run_git_env(dir, &["ls-tree", "-r", "--name-only", target_tree], &[]).await?;
    for path in tree_files_out.lines().map(str::trim) {
        if ignored.contains(path) {
            return Err(format!(
                "Restore aborted: target checkpoint would overwrite existing ignored path '{path}'"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn checkpoint_restore(
    dir: String,
    id: String,
    expected_working_tree: Option<String>,
) -> Result<RestoreCheckpointResult, String> {
    let repo_root = ensure_git_repo(&dir).await?;
    let lock = repo_lock(&repo_root);
    let _guard = lock.lock().await;

    if let Some(expected) = expected_working_tree {
        let current = compute_working_tree_identity(&dir, None).await?;
        if expected != current {
            return Err(
                "Stale preview: working tree, index, or HEAD changed since diff was generated"
                    .to_string(),
            );
        }
    }

    let target_commit = resolve_checkpoint_commit(&dir, &id).await?;
    let target_tree = run_git_env(
        &dir,
        &["rev-parse", &format!("{target_commit}^{{tree}}")],
        &[],
    )
    .await?
    .trim()
    .to_string();

    let safety_checkpoint = checkpoint_create_locked(
        &dir,
        None,
        Some(format!("Safety checkpoint before restoring {id}")),
    )
    .await?;

    ensure_restore_preserves_ignored(&dir, &target_tree).await?;

    let idx = TempIndexGuard::new();
    let _current_tree = write_working_tree_to_temp_index(&dir, &idx).await?;
    let idx_path = idx.path_str();
    let envs = [("GIT_INDEX_FILE", idx_path.as_str())];

    run_git_env(&dir, &["read-tree", "--reset", "-u", &target_tree], &envs).await?;

    Ok(RestoreCheckpointResult {
        restored_id: id,
        safety_checkpoint,
    })
}

#[tauri::command]
pub async fn checkpoint_create_label(
    dir: String,
    name: String,
    checkpoint_id: String,
    message: Option<String>,
) -> Result<LabelInfo, String> {
    ensure_git_repo(&dir).await?;
    validate_ref_component(&name, "label name")?;
    let commit_oid = resolve_checkpoint_commit(&dir, &checkpoint_id).await?;
    let msg = message.unwrap_or_else(|| format!("Label {name}"));

    run_git_env(&dir, &["tag", "-a", &name, &commit_oid, "-m", &msg], &[]).await?;

    let created_at = run_git_env(&dir, &["show", "-s", "--format=%cI", &commit_oid], &[])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(LabelInfo {
        name,
        commit_oid,
        message: msg,
        created_at,
    })
}

#[tauri::command]
pub async fn checkpoint_list_labels(dir: String) -> Result<Vec<LabelInfo>, String> {
    ensure_git_repo(&dir).await?;
    let out = run_git_env(
        &dir,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%09%(objectname)%09%(contents:subject)%09%(creatordate:iso8601-strict)",
            "refs/tags",
        ],
        &[],
    )
    .await?;

    let mut labels = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 4 {
            continue;
        }
        labels.push(LabelInfo {
            name: parts[0].to_string(),
            commit_oid: parts[1].to_string(),
            message: parts[2].to_string(),
            created_at: parts[3].to_string(),
        });
    }
    Ok(labels)
}

#[tauri::command]
pub async fn checkpoint_delete_label(dir: String, name: String) -> Result<(), String> {
    ensure_git_repo(&dir).await?;
    validate_ref_component(&name, "label name")?;
    run_git_env(&dir, &["tag", "-d", &name], &[]).await?;
    Ok(())
}

fn validate_single_hunk_patch(patch: &str) -> Result<(), String> {
    if patch.trim().is_empty() {
        return Err("Patch cannot be empty".to_string());
    }
    if patch.contains("GIT binary patch") {
        return Err("Binary patches are not supported for single-hunk reverse".to_string());
    }
    let file_headers = patch
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .count();
    if file_headers > 1 {
        return Err("Patch must target a single file".to_string());
    }
    let hunk_headers = patch
        .lines()
        .filter(|line| line.starts_with("@@ ") && line.contains(" @@"))
        .count();
    if hunk_headers != 1 {
        return Err(format!(
            "Patch must contain exactly one hunk (found {hunk_headers})"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn checkpoint_reverse_hunk(dir: String, patch: String) -> Result<(), String> {
    let repo_root = ensure_git_repo(&dir).await?;
    validate_single_hunk_patch(&patch)?;
    let lock = repo_lock(&repo_root);
    let _guard = lock.lock().await;
    run_git_stdin(&dir, &["apply", "--reverse", "--check", "-"], &patch)
        .await
        .map_err(|e| format!("Patch check failed: {e}"))?;
    run_git_stdin(&dir, &["apply", "--reverse", "-"], &patch).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_repo() -> PathBuf {
        let seq = TEMP_INDEX_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("orchestratex-cp-test-{}-{seq}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "user.email", "test@example.com"]);

        fs::write(dir.join(".gitignore"), "ignored.log\n").unwrap();
        fs::write(dir.join("main.tex"), "hello\nworld\n").unwrap();
        fs::write(dir.join("ignored.log"), "keep me\n").unwrap();

        run(&["add", ".gitignore", "main.tex"]);
        run(&["commit", "-m", "initial"]);

        dir
    }

    #[tokio::test]
    async fn checkpoint_refs_are_local_to_each_git_checkout() {
        let project = setup_test_repo();
        let worktree = project.with_extension("worktree");
        let project_path = project.to_string_lossy().to_string();
        let worktree_path = worktree.to_string_lossy().to_string();
        run_git_env(
            &project_path,
            &["worktree", "add", "--detach", &worktree_path],
            &[],
        )
        .await
        .unwrap();

        checkpoint_create(project_path.clone(), Some("local".into()), None)
            .await
            .unwrap();
        checkpoint_create(worktree_path.clone(), Some("other".into()), None)
            .await
            .unwrap();
        let local = checkpoint_list(project_path.clone()).await.unwrap();
        let other = checkpoint_list(worktree_path.clone()).await.unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].id, "local");
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].id, "other");
        assert!(checkpoint_diff(project_path.clone(), "other".into(), None)
            .await
            .is_err());

        run_git_env(&project_path, &["worktree", "remove", &worktree_path], &[])
            .await
            .unwrap();
        fs::remove_dir_all(project).unwrap();
    }

    #[tokio::test]
    async fn snapshot_diff_restore_preserves_index_head_and_ignored() {
        let dir = setup_test_repo();
        let dir_str = dir.to_string_lossy().to_string();

        // Modify tracked file, stage something else in real index, add untracked file
        fs::write(dir.join("main.tex"), "hello\nmodified\n").unwrap();
        fs::write(dir.join("staged.tex"), "staged content\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "staged.tex"])
            .current_dir(&dir)
            .output()
            .unwrap();
        fs::write(dir.join("untracked.tex"), "untracked before\n").unwrap();

        let head_before = run_git_env(&dir_str, &["rev-parse", "HEAD"], &[])
            .await
            .unwrap();
        let index_before = run_git_env(&dir_str, &["diff", "--cached", "--name-only"], &[])
            .await
            .unwrap();

        let _cp1 = checkpoint_create(dir_str.clone(), Some("turn-1".into()), None)
            .await
            .unwrap();

        // Real HEAD and real index must be untouched
        let head_after = run_git_env(&dir_str, &["rev-parse", "HEAD"], &[])
            .await
            .unwrap();
        let index_after = run_git_env(&dir_str, &["diff", "--cached", "--name-only"], &[])
            .await
            .unwrap();
        assert_eq!(head_before, head_after);
        assert_eq!(index_before, index_after);

        // Mutate working tree further
        fs::write(dir.join("main.tex"), "hello\nmutated\n").unwrap();
        fs::write(dir.join("new_untracked.tex"), "extra\n").unwrap();
        fs::write(dir.join("ignored.log"), "ignored updated\n").unwrap();

        // Diff against working tree
        let diff = checkpoint_diff(dir_str.clone(), "turn-1".into(), None)
            .await
            .unwrap();
        assert!(diff.diff_text.contains("new_untracked.tex"));
        assert!(diff.diff_text.contains("mutated"));

        // Stale working tree identity should be rejected
        let stale_err = checkpoint_restore(
            dir_str.clone(),
            "turn-1".into(),
            Some("stale-identity".into()),
        )
        .await;
        assert!(stale_err.is_err());

        // Restore with current working tree identity
        let restored =
            checkpoint_restore(dir_str.clone(), "turn-1".into(), Some(diff.working_tree))
                .await
                .unwrap();
        assert_eq!(restored.restored_id, "turn-1");
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "hello\nmodified\n"
        );
        assert!(!dir.join("new_untracked.tex").exists());
        assert!(dir.join("untracked.tex").exists());
        assert_eq!(
            fs::read_to_string(dir.join("ignored.log")).unwrap(),
            "ignored updated\n"
        );

        // Safety checkpoint can restore back to mutated state
        let _undo =
            checkpoint_restore(dir_str.clone(), restored.safety_checkpoint.id.clone(), None)
                .await
                .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "hello\nmutated\n"
        );
        assert!(dir.join("new_untracked.tex").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn labels_and_reverse_hunk_and_validation() {
        let dir = setup_test_repo();
        let dir_str = dir.to_string_lossy().to_string();

        let cp = checkpoint_create(dir_str.clone(), Some("v1".into()), Some("snap".into()))
            .await
            .unwrap();
        let label = checkpoint_create_label(
            dir_str.clone(),
            "submission-1".into(),
            cp.id.clone(),
            Some("Ready for review".into()),
        )
        .await
        .unwrap();
        assert_eq!(label.name, "submission-1");

        let labels = checkpoint_list_labels(dir_str.clone()).await.unwrap();
        assert_eq!(labels.len(), 1);

        checkpoint_delete_label(dir_str.clone(), "submission-1".into())
            .await
            .unwrap();
        assert!(checkpoint_list_labels(dir_str.clone())
            .await
            .unwrap()
            .is_empty());

        // Unsafe ref validation
        assert!(
            checkpoint_create(dir_str.clone(), Some("../bad".into()), None)
                .await
                .is_err()
        );

        // Reverse hunk guarded by git apply --check
        fs::write(dir.join("main.tex"), "hello\nchanged\n").unwrap();
        let patch = run_git_env(&dir_str, &["diff", "main.tex"], &[])
            .await
            .unwrap();
        checkpoint_reverse_hunk(dir_str.clone(), patch)
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "hello\nworld\n"
        );

        // Invalid patch fails check without modifying files
        assert!(
            checkpoint_reverse_hunk(dir_str.clone(), "not a patch".into())
                .await
                .is_err()
        );

        // Multi-hunk patch is rejected
        let multi_hunk = "diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,1 +5,1 @@\n-c\n+d\n";
        assert!(checkpoint_reverse_hunk(dir_str, multi_hunk.into())
            .await
            .is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn external_edit_stale_preview_and_tracked_ignored_and_restore_guard() {
        let dir = setup_test_repo();
        let dir_str = dir.to_string_lossy().to_string();

        // Force-add a tracked ignored file
        fs::write(dir.join("tracked.log"), "tracked ignored\n").unwrap();
        fs::write(dir.join(".gitignore"), "ignored.log\ntracked.log\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "-f", "tracked.log"])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "add tracked ignored"])
            .current_dir(&dir)
            .output()
            .unwrap();

        let cp1 = checkpoint_create(dir_str.clone(), Some("base".into()), None)
            .await
            .unwrap();
        // Tracked ignored file must be in the checkpoint tree
        let ls_out = run_git_env(
            &dir_str,
            &["ls-tree", "-r", "--name-only", &cp1.tree_oid],
            &[],
        )
        .await
        .unwrap();
        assert!(ls_out.lines().any(|l| l == "tracked.log"));

        // Mutate main.tex and generate diff
        fs::write(dir.join("main.tex"), "hello\nedit1\n").unwrap();
        let diff = checkpoint_diff(dir_str.clone(), "base".into(), None)
            .await
            .unwrap();

        // External edit happens after diff was generated
        fs::write(dir.join("main.tex"), "hello\nexternal edit\n").unwrap();
        let stale_res =
            checkpoint_restore(dir_str.clone(), "base".into(), Some(diff.working_tree)).await;
        assert!(stale_res.is_err());

        // Now test restore guard: if target checkpoint has a path that is currently an ignored file
        fs::write(dir.join("conflict.log"), "from cp\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "-f", "conflict.log"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let _cp_with_conflict =
            checkpoint_create(dir_str.clone(), Some("with-conflict".into()), None)
                .await
                .unwrap();
        std::process::Command::new("git")
            .args(["rm", "--cached", "conflict.log"])
            .current_dir(&dir)
            .output()
            .unwrap();
        fs::write(
            dir.join(".gitignore"),
            "ignored.log\ntracked.log\nconflict.log\n",
        )
        .unwrap();
        fs::write(dir.join("conflict.log"), "local ignored must survive\n").unwrap();

        let before_cps = checkpoint_list(dir_str.clone()).await.unwrap().len();
        let restore_err = checkpoint_restore(dir_str.clone(), "with-conflict".into(), None).await;
        assert!(restore_err.is_err());
        assert_eq!(
            fs::read_to_string(dir.join("conflict.log")).unwrap(),
            "local ignored must survive\n"
        );
        // Safety checkpoint was still created and is reachable
        let after_cps = checkpoint_list(dir_str).await.unwrap().len();
        assert_eq!(after_cps, before_cps + 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
