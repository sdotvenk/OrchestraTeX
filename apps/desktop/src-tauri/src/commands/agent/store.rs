use super::types::{
    now_millis, AgentMessage, AgentPart, AgentProviderId, AgentThread, InteractionMode,
    PendingInteraction, PlanTaskItem, RuntimeMode, ThreadSummary, TokenUsageSnapshot,
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
        let key = self.ensure_loaded_in_cache(project_path, &mut cache).await?;
        let threads = cache.get(&key).map(|v| v.as_slice()).unwrap_or(&[]);
        let mut summaries: Vec<ThreadSummary> =
            threads.iter().map(|t| t.summary.clone()).collect();
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
        let key = self.ensure_loaded_in_cache(project_path, &mut cache).await?;
        Ok(cache
            .get(&key)
            .and_then(|threads| threads.iter().find(|t| t.summary.id == thread_id).cloned()))
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
        if !tokio::fs::try_exists(&self.root_dir)
            .await
            .unwrap_or(false)
        {
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
        let project_path = thread.summary.project_path.clone();
        let snapshot = {
            let mut cache = self.cache.lock().await;
            let key = self.ensure_loaded_in_cache(&project_path, &mut cache).await?;
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
        let _guard = self.io_lock.lock().await;
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
        let key = self.ensure_loaded_in_cache(project_path, &mut cache).await?;
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
        let snapshot = {
            let cache = self.cache.lock().await;
            let key = project_storage_key(project_path);
            cache.get(&key).cloned()
        };
        if let Some(threads) = snapshot {
            let _guard = self.io_lock.lock().await;
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
        let (cloned, snapshot) = {
            let mut cache = self.cache.lock().await;
            let key = self.ensure_loaded_in_cache(project_path, &mut cache).await?;
            let Some(threads) = cache.get_mut(&key) else {
                return Ok(None);
            };
            let Some(target) = threads.iter_mut().find(|t| t.summary.id == thread_id) else {
                return Ok(None);
            };
            mutator(target);
            target.summary.updated_at = now_millis();
            target.summary.message_count = target.messages.len();
            (target.clone(), threads.clone())
        };
        let _guard = self.io_lock.lock().await;
        self.write_all_locked(project_path, &snapshot).await?;
        Ok(Some(cloned))
    }

    pub async fn delete_thread(&self, project_path: &str, thread_id: &str) -> Result<(), String> {
        let snapshot = {
            let mut cache = self.cache.lock().await;
            let key = self.ensure_loaded_in_cache(project_path, &mut cache).await?;
            let threads = cache.entry(key).or_default();
            threads.retain(|t| t.summary.id != thread_id);
            threads.clone()
        };
        let _guard = self.io_lock.lock().await;
        self.write_all_locked(project_path, &snapshot).await
    }

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
            },
            messages: Vec::new(),
            usage: None,
            tasks: Vec::new(),
            pending_interaction: None,
        };
        self.save_thread(thread.clone()).await?;
        Ok(thread)
    }

    pub fn append_message_to_thread(thread: &mut AgentThread, message: AgentMessage) {
        if let Some(preview) = message.parts.iter().find_map(|p| match p {
            AgentPart::Text { text, .. } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        }) {
            let truncated: String = preview.chars().take(100).collect();
            thread.summary.last_preview = Some(truncated);
            if thread.summary.title == "New Chat" && message.role == "user" {
                let title_text: String = preview.lines().next().unwrap_or(preview).chars().take(48).collect();
                if !title_text.is_empty() {
                    thread.summary.title = title_text;
                }
            }
        }
        thread.messages.push(message);
        thread.summary.message_count = thread.messages.len();
        thread.summary.updated_at = now_millis();
    }

    pub fn upsert_part_in_thread(
        thread: &mut AgentThread,
        message_id: &str,
        part: AgentPart,
    ) {
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
    let normalized = project_path.replace('\\', "/").trim_end_matches('/').to_string();
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
}
