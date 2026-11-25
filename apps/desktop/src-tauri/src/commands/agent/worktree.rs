use crate::commands::agent::store::ThreadStore;
use crate::commands::agent::types::{now_millis, AgentStreamEvent, ThreadSummary};
use crate::commands::util::command;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub type WorktreeLockMap = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

fn validate_thread_id(thread_id: &str) -> Result<(), String> {
    if thread_id.is_empty() || thread_id.len() > 128 {
        return Err("Invalid threadId".to_string());
    }
    if !thread_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid threadId: contains disallowed characters".to_string());
    }
    Ok(())
}

async fn validate_project_dir(project_path: &str) -> Result<PathBuf, String> {
    if project_path.trim().is_empty() {
        return Err("projectPath is required".to_string());
    }
    let canonical = tokio::fs::canonicalize(project_path)
        .await
        .map_err(|e| format!("Invalid projectPath: {}", e))?;
    let meta = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| format!("Cannot access projectPath: {}", e))?;
    if !meta.is_dir() {
        return Err("projectPath is not a directory".to_string());
    }
    Ok(canonical)
}

async fn run_git(project_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = command("git")
        .arg("-C")
        .arg(project_dir)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} failed: {}", args.join(" "), detail));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn cleanup_failed_worktree(project_dir: &Path, worktree_dir: &Path, branch_name: &str) {
    if tokio::fs::try_exists(worktree_dir).await.unwrap_or(false) {
        let _ = tokio::fs::remove_dir_all(worktree_dir).await;
    }
    let _ = run_git(project_dir, &["worktree", "prune"]).await;
    let _ = run_git(project_dir, &["branch", "-D", branch_name]).await;
}

pub async fn acquire_thread_lock(
    worktree_locks: &WorktreeLockMap,
    project_path: &str,
    thread_id: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let canonical = tokio::fs::canonicalize(project_path)
        .await
        .unwrap_or_else(|_| PathBuf::from(project_path));
    let lock_key = format!("{}::{}", canonical.display(), thread_id);
    let thread_lock = {
        let mut locks = worktree_locks.lock().await;
        locks
            .entry(lock_key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    thread_lock.lock_owned().await
}

pub async fn create_worktree_core(
    app: Option<&AppHandle>,
    store: &ThreadStore,
    worktree_locks: &WorktreeLockMap,
    project_path: &str,
    thread_id: &str,
) -> Result<ThreadSummary, String> {
    validate_thread_id(thread_id)?;
    let canonical_project = validate_project_dir(project_path).await?;

    let _guard = acquire_thread_lock(worktree_locks, project_path, thread_id).await;

    let thread = store
        .get_thread(project_path, thread_id)
        .await?
        .ok_or_else(|| format!("Thread not found: {}", thread_id))?;

    if thread.summary.workspace_path.is_some() {
        return Err("Thread already has a worktree".to_string());
    }
    if thread.summary.provider_session_id.is_some()
        || thread.summary.message_count > 0
        || !thread.messages.is_empty()
    {
        return Err(
            "Cannot create worktree for a thread that already has an active session or messages"
                .to_string(),
        );
    }
    if thread.summary.status == "running" || thread.summary.status == "waiting_input" {
        return Err("Cannot create worktree while thread is active".to_string());
    }

    // Verify project is a Git repository with at least one commit.
    let root = run_git(&canonical_project, &["rev-parse", "--show-toplevel"]).await?;
    let root = tokio::fs::canonicalize(root.trim())
        .await
        .map_err(|error| error.to_string())?;
    if root != canonical_project {
        return Err("Open the Git checkout root to create a worktree".to_string());
    }
    run_git(&canonical_project, &["rev-parse", "--verify", "HEAD"]).await?;

    let worktrees_root = store.worktrees_dir(&canonical_project.to_string_lossy());
    tokio::fs::create_dir_all(&worktrees_root)
        .await
        .map_err(|e| format!("Failed to create worktrees directory: {}", e))?;

    let worktree_dir = worktrees_root.join(thread_id);
    let branch_name = format!("orchestratex/{}", thread_id);

    // Never delete an existing user path or collision branch.
    if tokio::fs::try_exists(&worktree_dir).await.unwrap_or(false) {
        return Err(format!(
            "Worktree directory already exists: {}",
            worktree_dir.display()
        ));
    }
    let branch_ref = format!("refs/heads/{}", branch_name);
    if run_git(
        &canonical_project,
        &["show-ref", "--verify", "--quiet", &branch_ref],
    )
    .await
    .is_ok()
    {
        return Err(format!("Worktree branch already exists: {}", branch_name));
    }

    let worktree_dir_str = worktree_dir
        .to_str()
        .ok_or_else(|| "Worktree path is not valid UTF-8".to_string())?;

    if let Err(err) = run_git(
        &canonical_project,
        &[
            "worktree",
            "add",
            "-b",
            &branch_name,
            worktree_dir_str,
            "HEAD",
        ],
    )
    .await
    {
        cleanup_failed_worktree(&canonical_project, &worktree_dir, &branch_name).await;
        return Err(err);
    }

    let canonical_worktree = match tokio::fs::canonicalize(&worktree_dir).await {
        Ok(p) => p,
        Err(e) => {
            cleanup_failed_worktree(&canonical_project, &worktree_dir, &branch_name).await;
            return Err(format!("Failed to canonicalize worktree path: {}", e));
        }
    };
    let canonical_worktree_str = canonical_worktree
        .to_str()
        .ok_or_else(|| "Canonical worktree path is not valid UTF-8".to_string())?
        .to_string();

    let branch_clone = branch_name.clone();
    let updated = match store
        .mutate_thread(project_path, thread_id, move |t| {
            t.summary.workspace_path = Some(canonical_worktree_str);
            t.summary.workspace_branch = Some(branch_clone);
            t.summary.updated_at = now_millis();
        })
        .await
    {
        Ok(Some(t)) => t,
        Ok(None) => {
            cleanup_failed_worktree(&canonical_project, &worktree_dir, &branch_name).await;
            return Err(format!("Thread not found: {}", thread_id));
        }
        Err(e) => {
            cleanup_failed_worktree(&canonical_project, &worktree_dir, &branch_name).await;
            return Err(e);
        }
    };

    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "agent-event",
            AgentStreamEvent::ThreadUpdated {
                thread: updated.summary.clone(),
            },
        );
    }

    Ok(updated.summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent::types::{AgentProviderId, InteractionMode, RuntimeMode};

    async fn setup_temp_git_repo(dir: &Path) {
        let status = command("git")
            .arg("init")
            .current_dir(dir)
            .output()
            .await
            .expect("git init");
        assert!(status.status.success(), "git init failed");

        let _ = command("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir)
            .output()
            .await
            .expect("git config email");
        let _ = command("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(dir)
            .output()
            .await
            .expect("git config name");

        let commit = command("git")
            .args(["commit", "--allow-empty", "-m", "initial commit"])
            .current_dir(dir)
            .output()
            .await
            .expect("git commit");
        assert!(commit.status.success(), "git commit failed");
    }

    #[tokio::test]
    async fn creates_worktree_and_prevents_unsafe_moves() {
        let base = std::env::temp_dir().join(format!("ox_wt_test_{}", uuid::Uuid::new_v4()));
        let repo_dir = base.join("repo");
        let store_dir = base.join("store");
        tokio::fs::create_dir_all(&repo_dir).await.unwrap();
        tokio::fs::create_dir_all(&store_dir).await.unwrap();

        setup_temp_git_repo(&repo_dir).await;

        let store = ThreadStore::new(store_dir);
        let locks: WorktreeLockMap = Arc::new(Mutex::new(HashMap::new()));
        let project_path = repo_dir.to_string_lossy().to_string();

        let thread = store
            .create_thread(
                project_path.clone(),
                AgentProviderId::Claude,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::FullAccess,
                Some("Worktree Test".to_string()),
            )
            .await
            .unwrap();

        let summary = create_worktree_core(None, &store, &locks, &project_path, &thread.summary.id)
            .await
            .expect("create_worktree_core should succeed");

        assert_eq!(summary.project_path, project_path);
        let wt_path = summary.workspace_path.as_ref().expect("workspace_path set");
        let wt_branch = summary
            .workspace_branch
            .as_ref()
            .expect("workspace_branch set");
        assert!(Path::new(wt_path).is_dir());
        assert!(!Path::new(wt_path).starts_with(&repo_dir));
        assert_eq!(wt_branch, &format!("orchestratex/{}", thread.summary.id));
        assert_eq!(summary.effective_workspace_path(), wt_path);

        // Deleting the thread must preserve the concrete app-data worktree on disk.
        store
            .delete_thread(&project_path, &thread.summary.id)
            .await
            .unwrap();
        assert!(Path::new(wt_path).is_dir());

        // Second call on same thread must fail.
        let second =
            create_worktree_core(None, &store, &locks, &project_path, &thread.summary.id).await;
        assert!(second.is_err());

        // Thread with existing provider_session_id must fail.
        let active_thread = store
            .create_thread(
                project_path.clone(),
                AgentProviderId::Codex,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::FullAccess,
                None,
            )
            .await
            .unwrap();
        store
            .mutate_thread(&project_path, &active_thread.summary.id, |t| {
                t.summary.provider_session_id = Some("sess-123".to_string());
            })
            .await
            .unwrap();
        let active_res = create_worktree_core(
            None,
            &store,
            &locks,
            &project_path,
            &active_thread.summary.id,
        )
        .await;
        assert!(active_res.is_err());

        // Invalid thread_id must fail.
        let bad_id = create_worktree_core(None, &store, &locks, &project_path, "../evil").await;
        assert!(bad_id.is_err());

        let _ = tokio::fs::remove_dir_all(&base).await;
    }
}
