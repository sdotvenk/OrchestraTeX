use super::types::{
    now_millis, AgentMessage, AgentPart, AgentProviderId, AgentThread, InteractionMode,
    PendingInteraction, PlanTaskItem, RuntimeMode, ThreadSchedule, ThreadSummary,
    TokenUsageSnapshot,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

pub struct ThreadStore {
    root_dir: PathBuf,
    /// Per-project in-memory cache of threads keyed by `project_storage_key(project_path)`.
    /// Avoids full-file disk reads/writes on high-frequency streaming deltas.
    cache: Mutex<HashMap<String, Vec<AgentThread>>>,
    io_lock: Mutex<()>,
}

impl ThreadStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self {
            root_dir,
            cache: Mutex::new(HashMap::new()),
            io_lock: Mutex::new(()),
        }
    }

    fn project_file(&self, project_path: &str) -> PathBuf {
        self.root_dir
            .join(format!("{}.json", project_storage_key(project_path)))
    }

    pub fn worktrees_dir(&self, project_path: &str) -> PathBuf {
        self.root_dir
            .join("worktrees")
            .join(project_storage_key(project_path))
    }

    async fn read_all_from_disk(&self, project_path: &str) -> Result<Vec<AgentThread>, String> {
        let file = self.project_file(project_path);
        if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
            return Ok(Vec::new());
        }
        let raw = tokio::fs::read_to_string(&file)
            .await
            .map_err(|e| format!("Failed to read thread store: {}", e))?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse thread store: {}", e))
    }

    async fn ensure_loaded_in_cache(
        &self,
        project_path: &str,
        cache: &mut HashMap<String, Vec<AgentThread>>,
    ) -> Result<String, String> {
        let key = project_storage_key(project_path);
        if !cache.contains_key(&key) {
            let loaded = self.read_all_from_disk(project_path).await?;
            cache.insert(key.clone(), loaded);
        }
        Ok(key)
    }

    async fn write_all_locked(
        &self,
        project_path: &str,
        threads: &[AgentThread],
    ) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.root_dir)
            .await
            .map_err(|e| format!("Failed to create thread store dir: {}", e))?;
        let file = self.project_file(project_path);
        let tmp = self.root_dir.join(format!(
            "{}.{}.tmp",
            project_storage_key(project_path),
            uuid::Uuid::new_v4()
        ));
        // Compact JSON serialization is significantly faster and smaller than pretty JSON
        // when threads contain long transcripts or image attachments.
        let json = serde_json::to_vec(threads)
            .map_err(|e| format!("Failed to serialize threads: {}", e))?;
        tokio::fs::write(&tmp, json)
            .await
            .map_err(|e| format!("Failed to write temp thread store: {}", e))?;
        tokio::fs::rename(&tmp, &file)
            .await
            .map_err(|e| format!("Failed to commit thread store: {}", e))?;
        Ok(())
    }

    pub async fn list_threads(&self, project_path: &str) -> Result<Vec<ThreadSummary>, String> {
        let mut cache = self.cache.lock().await;
        let key = self
            .ensure_loaded_in_cache(project_path, &mut cache)
            .await?;
        let threads = cache.get(&key).map(|v| v.as_slice()).unwrap_or(&[]);
        let mut summaries: Vec<ThreadSummary> = threads.iter().map(|t| t.summary.clone()).collect();
        summaries.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(summaries)
    }

    /// Lists persisted projects as well as current in-memory updates.
    pub async fn list_all_threads(&self) -> Result<Vec<ThreadSummary>, String> {
        let cache = self.cache.lock().await;
        let _guard = self.io_lock.lock().await;
        let mut summaries: Vec<ThreadSummary> = cache
            .values()
            .flat_map(|threads| threads.iter().map(|thread| thread.summary.clone()))
            .collect();
        if tokio::fs::try_exists(&self.root_dir)
            .await
            .map_err(|e| e.to_string())?
        {
            let mut entries = tokio::fs::read_dir(&self.root_dir)
                .await
                .map_err(|e| e.to_string())?;
            while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let Some(key) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                if cache.contains_key(key) {
                    continue;
                }
                let raw = tokio::fs::read(&path)
                    .await
                    .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
                if raw.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let threads: Vec<AgentThread> = serde_json::from_slice(&raw)
                    .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
                summaries.extend(threads.into_iter().map(|thread| thread.summary));
            }
        }
        summaries.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(summaries)
    }

    pub async fn get_thread(
        &self,
        project_path: &str,
        thread_id: &str,
    ) -> Result<Option<AgentThread>, String> {
        let mut cache = self.cache.lock().await;
        let key = self
            .ensure_loaded_in_cache(project_path, &mut cache)
            .await?;
        Ok(cache
            .get(&key)
            .and_then(|threads| threads.iter().find(|t| t.summary.id == thread_id).cloned()))
    }

    pub async fn get_thread_model(&self, project_path: &str, thread_id: &str) -> Option<String> {
        let mut cache = self.cache.lock().await;
        let key = self
            .ensure_loaded_in_cache(project_path, &mut cache)
            .await
            .ok()?;
        cache
            .get(&key)?
            .iter()
            .find(|thread| thread.summary.id == thread_id)?
            .summary
            .model
            .clone()
    }

    #[allow(dead_code)]
    pub async fn find_thread_anywhere(
        &self,
        thread_id: &str,
    ) -> Result<Option<AgentThread>, String> {
        {
            let cache = self.cache.lock().await;
            for threads in cache.values() {
                if let Some(found) = threads.iter().find(|t| t.summary.id == thread_id) {
                    return Ok(Some(found.clone()));
                }
            }
        }
        let _guard = self.io_lock.lock().await;
        if !tokio::fs::try_exists(&self.root_dir).await.unwrap_or(false) {
            return Ok(None);
        }
        let mut entries = tokio::fs::read_dir(&self.root_dir)
            .await
            .map_err(|e| e.to_string())?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = tokio::fs::read_to_string(&path).await {
                if let Ok(threads) = serde_json::from_str::<Vec<AgentThread>>(&raw) {
                    if let Some(found) = threads.into_iter().find(|t| t.summary.id == thread_id) {
                        return Ok(Some(found));
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn save_thread(&self, thread: AgentThread) -> Result<(), String> {
        let _guard = self.io_lock.lock().await;
        let project_path = thread.summary.project_path.clone();
        let snapshot = {
            let mut cache = self.cache.lock().await;
            let key = self
                .ensure_loaded_in_cache(&project_path, &mut cache)
                .await?;
            let threads = cache.entry(key).or_default();
            if let Some(existing) = threads
                .iter_mut()
                .find(|t| t.summary.id == thread.summary.id)
            {
                *existing = thread;
            } else {
                threads.push(thread);
            }
            threads.clone()
        };
        self.write_all_locked(&project_path, &snapshot).await
    }

    /// Mutates a thread in memory ONLY (zero disk I/O).
    /// Intended for high-frequency streaming deltas (`PartDelta`) that are flushed on turn/item completion.
    pub async fn mutate_thread_memory<F>(
        &self,
        project_path: &str,
        thread_id: &str,
        mutator: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&mut AgentThread),
    {
        let mut cache = self.cache.lock().await;
        let key = self
            .ensure_loaded_in_cache(project_path, &mut cache)
            .await?;
        if let Some(target) = cache
            .get_mut(&key)
            .and_then(|threads| threads.iter_mut().find(|t| t.summary.id == thread_id))
        {
            mutator(target);
            target.summary.updated_at = now_millis();
            target.summary.message_count = target.messages.len();
        }
        Ok(())
    }

    /// Flushes a project's cached threads to disk atomically.
    #[allow(dead_code)]
    pub async fn flush_project(&self, project_path: &str) -> Result<(), String> {
        let _guard = self.io_lock.lock().await;
        let snapshot = {
            let cache = self.cache.lock().await;
            let key = project_storage_key(project_path);
            cache.get(&key).cloned()
        };
        if let Some(threads) = snapshot {
            self.write_all_locked(project_path, &threads).await?;
        }
        Ok(())
    }

    pub async fn mutate_thread<F>(
        &self,
        project_path: &str,
        thread_id: &str,
        mutator: F,
    ) -> Result<Option<AgentThread>, String>
    where
        F: FnOnce(&mut AgentThread),
    {
        let _guard = self.io_lock.lock().await;
        let (cloned, snapshot, completed_turn_id) = {
            let mut cache = self.cache.lock().await;
            let key = self
                .ensure_loaded_in_cache(project_path, &mut cache)
                .await?;
            let Some(threads) = cache.get_mut(&key) else {
                return Ok(None);
            };
            let Some(target) = threads.iter_mut().find(|t| t.summary.id == thread_id) else {
                return Ok(None);
            };
            let was_active = matches!(target.summary.status.as_str(), "running" | "waiting_input");
            mutator(target);
            target.summary.updated_at = now_millis();
            target.summary.message_count = target.messages.len();
            let is_terminal = matches!(target.summary.status.as_str(), "idle" | "error");
            let completed_turn_id = (was_active && is_terminal)
                .then(|| {
                    target
                        .messages
                        .iter()
                        .rev()
                        .find(|message| message.role == "user")
                })
                .flatten()
                .map(|message| message.id.clone());
            (target.clone(), threads.clone(), completed_turn_id)
        };
        self.write_all_locked(project_path, &snapshot).await?;
        if let Some(id) = completed_turn_id {
            super::capture_turn_checkpoint(&cloned.summary, &id, "after").await;
        }
        Ok(Some(cloned))
    }

    pub async fn delete_thread(&self, project_path: &str, thread_id: &str) -> Result<(), String> {
        let _guard = self.io_lock.lock().await;
        let snapshot = {
            let mut cache = self.cache.lock().await;
            let key = self
                .ensure_loaded_in_cache(project_path, &mut cache)
                .await?;
            let threads = cache.entry(key).or_default();
            threads.retain(|t| t.summary.id != thread_id);
            threads.clone()
        };
        self.write_all_locked(project_path, &snapshot).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_thread(
        &self,
        project_path: String,
        provider_id: AgentProviderId,
        model: Option<String>,
        reasoning_effort: Option<String>,
        interaction_mode: InteractionMode,
        runtime_mode: RuntimeMode,
        title: Option<String>,
    ) -> Result<AgentThread, String> {
        self.create_thread_with_parent(
            project_path,
            provider_id,
            model,
            reasoning_effort,
            interaction_mode,
            runtime_mode,
            title,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_thread_with_parent(
        &self,
        project_path: String,
        provider_id: AgentProviderId,
        model: Option<String>,
        reasoning_effort: Option<String>,
        interaction_mode: InteractionMode,
        runtime_mode: RuntimeMode,
        title: Option<String>,
        parent_thread_id: Option<String>,
    ) -> Result<AgentThread, String> {
        let now = now_millis();
        let thread = AgentThread {
            summary: ThreadSummary {
                id: uuid::Uuid::new_v4().to_string(),
                project_path,
                title: title.unwrap_or_else(|| "New Chat".to_string()),
                provider_id,
                provider_session_id: None,
                model,
                reasoning_effort,
                interaction_mode,
                runtime_mode,
                pinned: false,
                archived: false,
                created_at: now,
                updated_at: now,
                message_count: 0,
                last_preview: None,
                status: "idle".to_string(),
                workspace_path: None,
                workspace_branch: None,
                parent_thread_id,
                schedule: None,
            },
            messages: Vec::new(),
            usage: None,
            tasks: Vec::new(),
            pending_interaction: None,
        };
        self.save_thread(thread.clone()).await?;
        Ok(thread)
    }

    /// Atomically claims all due, non-overlapping schedules for `project_path`.
    /// Repeating schedules advance `run_at` to `now_ms + interval`; one-shot schedules are cleared.
    pub async fn claim_due_schedules(
        &self,
        project_path: &str,
        now_ms: i64,
    ) -> Result<Vec<(String, ThreadSchedule)>, String> {
        let _guard = self.io_lock.lock().await;
        let (claimed, snapshot) = {
            let mut cache = self.cache.lock().await;
            let key = self
                .ensure_loaded_in_cache(project_path, &mut cache)
                .await?;
            let threads = cache.entry(key).or_default();
            let mut claimed = Vec::new();
            for t in threads.iter_mut() {
                if t.summary.archived
                    || t.summary.status == "running"
                    || t.summary.status == "waiting_input"
                {
                    continue;
                }
                let Some(sched) = t.summary.schedule.as_mut() else {
                    continue;
                };
                if sched.run_at > now_ms {
                    continue;
                }
                let claimed_sched = sched.clone();
                if let Some(interval) = sched.repeat_interval_ms.filter(|&ms| ms > 0) {
                    sched.run_at = now_ms.saturating_add(interval);
                    sched.last_run_at = Some(now_ms);
                } else {
                    t.summary.schedule = None;
                }
                t.summary.updated_at = now_ms;
                claimed.push((t.summary.id.clone(), claimed_sched));
            }
            let snapshot = if claimed.is_empty() {
                None
            } else {
                Some(threads.clone())
            };
            (claimed, snapshot)
        };
        if let Some(snapshot) = snapshot {
            self.write_all_locked(project_path, &snapshot).await?;
        }
        Ok(claimed)
    }

    pub fn append_message_to_thread(thread: &mut AgentThread, message: AgentMessage) {
        if let Some(preview) = message.parts.iter().find_map(|p| match p {
            AgentPart::Text { text, .. } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        }) {
            let truncated: String = preview.chars().take(100).collect();
            thread.summary.last_preview = Some(truncated);
            if thread.summary.title == "New Chat" && message.role == "user" {
                let title_text: String = preview
                    .lines()
                    .next()
                    .unwrap_or(preview)
                    .chars()
                    .take(48)
                    .collect();
                if !title_text.is_empty() {
                    thread.summary.title = title_text;
                }
            }
        }
        thread.messages.push(message);
        thread.summary.message_count = thread.messages.len();
        thread.summary.updated_at = now_millis();
    }

    pub fn upsert_part_in_thread(thread: &mut AgentThread, message_id: &str, part: AgentPart) {
        if let Some(msg) = thread.messages.iter_mut().find(|m| m.id == message_id) {
            if let Some(existing) = msg.parts.iter_mut().find(|p| p.id() == part.id()) {
                *existing = part;
            } else {
                msg.parts.push(part);
            }
        }
    }

    pub fn append_delta_in_thread(
        thread: &mut AgentThread,
        message_id: &str,
        part_id: &str,
        part_type: &str,
        delta: &str,
    ) {
        let Some(msg) = thread.messages.iter_mut().find(|m| m.id == message_id) else {
            return;
        };

        if let Some(existing) = msg.parts.iter_mut().find(|p| p.id() == part_id) {
            match (existing, part_type) {
                (AgentPart::Text { text, .. }, "text") => text.push_str(delta),
                (AgentPart::Reasoning { text, .. }, "reasoning") => text.push_str(delta),
                (AgentPart::Tool { output, .. }, "tool_output") => {
                    let buf = output.get_or_insert_with(String::new);
                    buf.push_str(delta);
                }
                _ => {}
            }
            return;
        }

        match part_type {
            "text" => msg.parts.push(AgentPart::Text {
                id: part_id.to_string(),
                text: delta.to_string(),
            }),
            "reasoning" => msg.parts.push(AgentPart::Reasoning {
                id: part_id.to_string(),
                text: delta.to_string(),
            }),
            _ => {}
        }
    }

    pub fn set_usage(thread: &mut AgentThread, usage: TokenUsageSnapshot) {
        thread.usage = Some(usage);
    }

    pub fn set_tasks(thread: &mut AgentThread, tasks: Vec<PlanTaskItem>) {
        thread.tasks = tasks;
    }

    pub fn set_pending_interaction(
        thread: &mut AgentThread,
        interaction: Option<PendingInteraction>,
    ) {
        thread.pending_interaction = interaction;
    }
}

pub fn project_storage_key(project_path: &str) -> String {
    let normalized = project_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let base = Path::new(&normalized)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let safe_base: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(24)
        .collect();
    format!("{}_{:016x}", safe_base, hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn thread_store_crud_roundtrip() {
        let dir = TempDir::new().unwrap();
        let store = ThreadStore::new(dir.path().to_path_buf());
        let project = "/tmp/my-paper";

        let created = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Claude,
                Some("opus".to_string()),
                Some("high".to_string()),
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                None,
            )
            .await
            .unwrap();

        let list = store.list_threads(project).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.summary.id);
        assert_eq!(list[0].title, "New Chat");

        store
            .mutate_thread(project, &created.summary.id, |t| {
                ThreadStore::append_message_to_thread(
                    t,
                    AgentMessage {
                        id: "m1".to_string(),
                        role: "user".to_string(),
                        created_at: 1000,
                        completed_at: Some(1000),
                        provider_id: None,
                        model: None,
                        parts: vec![AgentPart::Text {
                            id: "p1".to_string(),
                            text: "Fix abstract wording".to_string(),
                        }],
                        changed_files: vec![],
                        error: None,
                    },
                );
            })
            .await
            .unwrap();

        let loaded = store
            .get_thread(project, &created.summary.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.summary.title, "Fix abstract wording");
        assert_eq!(loaded.messages.len(), 1);

        store
            .delete_thread(project, &created.summary.id)
            .await
            .unwrap();
        assert!(store.list_threads(project).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn thread_store_memory_mutation_and_flush_roundtrip() {
        let dir = TempDir::new().unwrap();
        let store = ThreadStore::new(dir.path().to_path_buf());
        let project = "/tmp/my-streaming-paper";

        let created = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Codex,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                None,
            )
            .await
            .unwrap();

        store
            .mutate_thread_memory(project, &created.summary.id, |t| {
                ThreadStore::append_message_to_thread(
                    t,
                    AgentMessage {
                        id: "a1".to_string(),
                        role: "assistant".to_string(),
                        created_at: 2000,
                        completed_at: None,
                        provider_id: Some(AgentProviderId::Codex),
                        model: None,
                        parts: Vec::new(),
                        changed_files: Vec::new(),
                        error: None,
                    },
                );
                ThreadStore::append_delta_in_thread(t, "a1", "p1", "text", "Hello ");
                ThreadStore::append_delta_in_thread(t, "a1", "p1", "text", "LaTeX");
            })
            .await
            .unwrap();

        // Visible immediately in memory
        let mem = store
            .get_thread(project, &created.summary.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(mem.messages.len(), 1);
        match &mem.messages[0].parts[0] {
            AgentPart::Text { text, .. } => assert_eq!(text, "Hello LaTeX"),
            _ => panic!("expected text part"),
        }

        // Persisted after flush and readable by a fresh ThreadStore instance
        store.flush_project(project).await.unwrap();
        let reopened = ThreadStore::new(dir.path().to_path_buf());
        let loaded = reopened
            .get_thread(project, &created.summary.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.messages.len(), 1);
        match &loaded.messages[0].parts[0] {
            AgentPart::Text { text, .. } => assert_eq!(text, "Hello LaTeX"),
            _ => panic!("expected text part after reload"),
        }
    }

    #[tokio::test]
    async fn child_thread_and_schedule_edge_cases() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThreadStore::new(dir.path().to_path_buf());
        let project = "/tmp/orch-schedule-test";

        let parent = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Claude,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                Some("Parent".to_string()),
            )
            .await
            .unwrap();
        assert_eq!(parent.summary.parent_thread_id, None);
        assert_eq!(parent.summary.schedule, None);

        let child = store
            .create_thread_with_parent(
                project.to_string(),
                AgentProviderId::Codex,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::ApprovalRequired,
                Some("Child".to_string()),
                Some(parent.summary.id.clone()),
            )
            .await
            .unwrap();
        assert_eq!(
            child.summary.parent_thread_id.as_deref(),
            Some(parent.summary.id.as_str())
        );

        let running = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Claude,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                Some("Running".to_string()),
            )
            .await
            .unwrap();

        let future = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Claude,
                None,
                None,
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                Some("Future".to_string()),
            )
            .await
            .unwrap();

        let now = 1_000_000i64;
        // One-shot due on parent
        store
            .mutate_thread(project, &parent.summary.id, |t| {
                t.summary.schedule = Some(ThreadSchedule {
                    run_at: now - 100,
                    prompt: "one-shot".to_string(),
                    repeat_interval_ms: None,
                    last_result: None,
                    last_run_at: None,
                });
            })
            .await
            .unwrap();

        // Repeating due on child
        store
            .mutate_thread(project, &child.summary.id, |t| {
                t.summary.schedule = Some(ThreadSchedule {
                    run_at: now,
                    prompt: "repeat".to_string(),
                    repeat_interval_ms: Some(5000),
                    last_result: None,
                    last_run_at: None,
                });
            })
            .await
            .unwrap();

        // Due but running -> must not overlap
        store
            .mutate_thread(project, &running.summary.id, |t| {
                t.summary.status = "running".to_string();
                t.summary.schedule = Some(ThreadSchedule {
                    run_at: now - 50,
                    prompt: "overlap".to_string(),
                    repeat_interval_ms: None,
                    last_result: None,
                    last_run_at: None,
                });
            })
            .await
            .unwrap();

        // Future -> must not claim
        store
            .mutate_thread(project, &future.summary.id, |t| {
                t.summary.schedule = Some(ThreadSchedule {
                    run_at: now + 1000,
                    prompt: "later".to_string(),
                    repeat_interval_ms: None,
                    last_result: None,
                    last_run_at: None,
                });
            })
            .await
            .unwrap();

        let claimed = store.claim_due_schedules(project, now).await.unwrap();
        assert_eq!(claimed.len(), 2);

        // Second claim at same timestamp must be empty (atomic claim)
        let second = store.claim_due_schedules(project, now).await.unwrap();
        assert!(second.is_empty());

        // One-shot cleared, repeating advanced
        let p_after = store
            .get_thread(project, &parent.summary.id)
            .await
            .unwrap()
            .unwrap();
        assert!(p_after.summary.schedule.is_none());

        let c_after = store
            .get_thread(project, &child.summary.id)
            .await
            .unwrap()
            .unwrap();
        let c_sched = c_after.summary.schedule.unwrap();
        assert_eq!(c_sched.run_at, now + 5000);
        assert_eq!(c_sched.last_run_at, Some(now));
    }

    #[tokio::test]
    async fn turn_checkpoint_lifecycle_captures_before_and_after_and_dedupes() {
        let base = std::env::temp_dir().join(format!(
            "orchestratex-turn-cp-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repo_dir = base.join("repo");
        let non_git_dir = base.join("plain");
        let store_dir = base.join("store");
        std::fs::create_dir_all(&repo_dir).unwrap();
        std::fs::create_dir_all(&non_git_dir).unwrap();

        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo_dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {:?} failed", args);
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(repo_dir.join("main.tex"), "\\documentclass{article}\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);

        let store = ThreadStore::new(store_dir);
        let project = repo_dir.to_str().unwrap();
        let created = store
            .create_thread(
                project.to_string(),
                AgentProviderId::Claude,
                Some("Turn CP Test".to_string()),
                None,
                InteractionMode::Default,
                RuntimeMode::AutoAcceptEdits,
                None,
            )
            .await
            .unwrap();

        let user_msg = AgentMessage {
            id: "u1".to_string(),
            role: "user".to_string(),
            created_at: 1,
            completed_at: Some(1),
            provider_id: None,
            model: None,
            parts: vec![],
            changed_files: vec![],
            error: None,
        };

        let running = store
            .mutate_thread(project, &created.summary.id, |t| {
                ThreadStore::append_message_to_thread(t, user_msg);
                t.summary.status = "running".to_string();
            })
            .await
            .unwrap()
            .unwrap();

        super::super::capture_turn_checkpoint(&running.summary, "u1", "before").await;
        // Modify working tree during turn
        std::fs::write(
            repo_dir.join("main.tex"),
            "\\documentclass{article}\n% edited\n",
        )
        .unwrap();

        // Transition running -> idle triggers post-turn checkpoint
        store
            .mutate_thread(project, &created.summary.id, |t| {
                t.summary.status = "idle".to_string();
            })
            .await
            .unwrap();

        // Dedupe: calling before again must not fail or overwrite
        super::super::capture_turn_checkpoint(&running.summary, "u1", "before").await;

        let cps = crate::commands::checkpoints::checkpoint_list(project.to_string())
            .await
            .unwrap();
        assert_eq!(cps.len(), 2);
        let before = cps.iter().find(|c| c.id == "turn-u1-before").unwrap();
        let after = cps.iter().find(|c| c.id == "turn-u1-after").unwrap();
        assert_ne!(before.tree_oid, after.tree_oid);

        let before_meta: serde_json::Value = serde_json::from_str(&before.message).unwrap();
        assert_eq!(before_meta["type"], "agentTurn");
        assert_eq!(before_meta["threadId"], created.summary.id);
        assert_eq!(before_meta["title"], created.summary.title);
        assert_eq!(before_meta["providerId"], "claude");
        assert_eq!(before_meta["phase"], "before");

        let after_meta: serde_json::Value = serde_json::from_str(&after.message).unwrap();
        assert_eq!(after_meta["phase"], "after");

        // Non-Git directory must silently no-op
        let mut plain_summary = running.summary.clone();
        plain_summary.project_path = non_git_dir.to_str().unwrap().to_string();
        super::super::capture_turn_checkpoint(&plain_summary, "u2", "before").await;

        let _ = std::fs::remove_dir_all(&base);
    }
}
