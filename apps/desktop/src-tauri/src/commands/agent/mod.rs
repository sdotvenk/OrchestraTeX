pub mod acp;
pub mod binary;
pub mod claude;
pub mod codex;
pub mod store;
pub mod types;
pub mod usage_log;
pub mod worktree;

use acp::{probe_acp, AcpClient};
use binary::find_cli_binary;
use claude::{probe_claude, run_claude_one_shot, spawn_claude_session, ClaudeSessionHandle};
use codex::{ensure_codex_client, probe_codex, run_codex_one_shot, CodexClient};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use store::ThreadStore;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use types::{
    now_millis, AgentMessage, AgentPart, AgentProviderId, AgentStreamEvent, AgentThread,
    AttachmentInput, InteractionMode, InteractionResponse, ProviderCustomConfig, ProviderStatus,
    RateLimitsSnapshot, RuntimeMode, ScheduleRunResult, ThreadSchedule, ThreadSummary,
};

pub struct AgentManagerState {
    store: Mutex<Option<Arc<ThreadStore>>>,
    usage_log: Mutex<Option<Arc<usage_log::UsageLogStore>>>,
    claude_sessions: Arc<Mutex<HashMap<String, ClaudeSessionHandle>>>,
    codex_client: Arc<Mutex<Option<CodexClient>>>,
    acp_clients: Arc<Mutex<HashMap<String, AcpClient>>>,
    rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
    worktree_locks: worktree::WorktreeLockMap,
}

impl Default for AgentManagerState {
    fn default() -> Self {
        Self {
            store: Mutex::new(None),
            usage_log: Mutex::new(None),
            claude_sessions: Arc::new(Mutex::new(HashMap::new())),
            codex_client: Arc::new(Mutex::new(None)),
            acp_clients: Arc::new(Mutex::new(HashMap::new())),
            rate_limit_cache: Arc::new(Mutex::new(HashMap::new())),
            worktree_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AgentManagerState {
    async fn get_store(&self, app: &AppHandle) -> Result<Arc<ThreadStore>, String> {
        let mut guard = self.store.lock().await;
        if let Some(ref existing) = *guard {
            return Ok(existing.clone());
        }
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent_threads");
        let created = Arc::new(ThreadStore::new(dir));
        *guard = Some(created.clone());
        Ok(created)
    }

    pub async fn get_usage_log(
        &self,
        app: &AppHandle,
    ) -> Result<Arc<usage_log::UsageLogStore>, String> {
        let mut guard = self.usage_log.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        let path = app
            .path()
            .app_data_dir()
            .map_err(|err| err.to_string())?
            .join("usage_log.jsonl");
        let created = Arc::new(usage_log::UsageLogStore::new(path));
        *guard = Some(created.clone());
        Ok(created)
    }

    pub async fn shutdown_all(&self) {
        let claude_handles: Vec<ClaudeSessionHandle> = {
            let mut guard = self.claude_sessions.lock().await;
            guard.drain().map(|(_, h)| h).collect()
        };
        for h in claude_handles {
            h.kill().await;
        }

        if let Some(codex) = self.codex_client.lock().await.take() {
            codex.kill().await;
        }

        let acp_handles: Vec<AcpClient> = {
            let mut guard = self.acp_clients.lock().await;
            guard.drain().map(|(_, c)| c).collect()
        };
        for c in acp_handles {
            c.kill().await;
        }
    }
}

fn find_custom_config(
    configs: &[ProviderCustomConfig],
    provider_id: AgentProviderId,
) -> Option<&ProviderCustomConfig> {
    configs.iter().find(|c| c.provider_id == Some(provider_id))
}

#[tauri::command]
pub async fn agent_list_providers(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<Vec<ProviderStatus>, String> {
    let store = state.get_store(&app).await?;
    let configs = custom_configs.unwrap_or_default();

    let claude_custom = find_custom_config(&configs, AgentProviderId::Claude)
        .and_then(|c| c.binary_path.as_deref());
    let codex_custom =
        find_custom_config(&configs, AgentProviderId::Codex).and_then(|c| c.binary_path.as_deref());
    let agy_cfg = find_custom_config(&configs, AgentProviderId::Antigravity);
    let custom_acp_cfg = find_custom_config(&configs, AgentProviderId::CustomAcp);

    let cached_claude = state
        .rate_limit_cache
        .lock()
        .await
        .get(&AgentProviderId::Claude)
        .cloned();

    let (claude_st, codex_st, agy_st, custom_st) = tokio::join!(
        probe_claude(claude_custom, cached_claude),
        probe_codex(
            app.clone(),
            store.clone(),
            state.rate_limit_cache.clone(),
            state.codex_client.clone(),
            codex_custom,
        ),
        probe_acp(AgentProviderId::Antigravity, agy_cfg),
        probe_acp(AgentProviderId::CustomAcp, custom_acp_cfg),
    );

    let mut list = vec![claude_st, codex_st, agy_st];
    if custom_acp_cfg
        .and_then(|c| c.custom_command.as_deref())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        list.push(custom_st);
    }

    Ok(list)
}

#[tauri::command]
pub async fn agent_refresh_rate_limits(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    provider_id: AgentProviderId,
    custom_binary_path: Option<String>,
) -> Result<Option<RateLimitsSnapshot>, String> {
    match provider_id {
        AgentProviderId::Codex => {
            let store = state.get_store(&app).await?;
            let bin = find_cli_binary(&["codex"], custom_binary_path.as_deref())
                .await
                .ok_or_else(|| "Codex CLI not found.".to_string())?;
            let client = ensure_codex_client(
                app.clone(),
                store,
                state.rate_limit_cache.clone(),
                state.codex_client.clone(),
                &bin,
            )
            .await?;
            let snap = client.read_rate_limits().await?;
            let _ = app.emit(
                "agent-event",
                AgentStreamEvent::RateLimitsUpdated {
                    provider_id: AgentProviderId::Codex,
                    rate_limits: snap.clone(),
                },
            );
            Ok(Some(snap))
        }
        _ => Ok(state
            .rate_limit_cache
            .lock()
            .await
            .get(&provider_id)
            .cloned()),
    }
}

#[tauri::command]
pub async fn agent_create_worktree(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
) -> Result<ThreadSummary, String> {
    let store = state.get_store(&app).await?;
    worktree::create_worktree_core(
        Some(&app),
        &store,
        &state.worktree_locks,
        &project_path,
        &thread_id,
    )
    .await
}

#[tauri::command]
pub async fn agent_list_threads(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
) -> Result<Vec<ThreadSummary>, String> {
    let store = state.get_store(&app).await?;
    store.list_threads(&project_path).await
}

#[tauri::command]
pub async fn agent_list_all_threads(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
) -> Result<Vec<ThreadSummary>, String> {
    state.get_store(&app).await?.list_all_threads().await
}

#[tauri::command]
pub async fn agent_load_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
) -> Result<AgentThread, String> {
    let store = state.get_store(&app).await?;
    store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_create_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    provider_id: AgentProviderId,
    model: Option<String>,
    reasoning_effort: Option<String>,
    interaction_mode: Option<InteractionMode>,
    runtime_mode: Option<RuntimeMode>,
    title: Option<String>,
) -> Result<AgentThread, String> {
    let store = state.get_store(&app).await?;
    let thread = store
        .create_thread(
            project_path,
            provider_id,
            model,
            reasoning_effort,
            interaction_mode.unwrap_or_default(),
            runtime_mode.unwrap_or_default(),
            title,
        )
        .await?;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: thread.summary.clone(),
        },
    );
    Ok(thread)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_update_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
    provider_id: Option<AgentProviderId>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    interaction_mode: Option<InteractionMode>,
    runtime_mode: Option<RuntimeMode>,
) -> Result<ThreadSummary, String> {
    let _thread_guard =
        worktree::acquire_thread_lock(&state.worktree_locks, &project_path, &thread_id).await;
    let store = state.get_store(&app).await?;
    let existing = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    let provider_changed = provider_id
        .map(|p| p != existing.summary.provider_id)
        .unwrap_or(false);

    let next_effort = reasoning_effort.as_ref().map(|e| {
        if e.is_empty() {
            None
        } else {
            Some(e.clone())
        }
    });
    let effort_changed = next_effort
        .as_ref()
        .map(|e| *e != existing.summary.reasoning_effort)
        .unwrap_or(false);
    let full_access_changed = runtime_mode
        .map(|rm| {
            (rm == RuntimeMode::FullAccess)
                != (existing.summary.runtime_mode == RuntimeMode::FullAccess)
        })
        .unwrap_or(false);
    let is_turn_active = matches!(existing.summary.status.as_str(), "running" | "waiting_input");
    let claude_startup_change = !provider_changed
        && existing.summary.provider_id == AgentProviderId::Claude
        && (effort_changed || full_access_changed);
    let acp_runtime_changed = !provider_changed
        && matches!(
            existing.summary.provider_id,
            AgentProviderId::Antigravity | AgentProviderId::CustomAcp
        )
        && runtime_mode
            .map(|rm| rm != existing.summary.runtime_mode)
            .unwrap_or(false);

    if is_turn_active && (provider_changed || claude_startup_change || acp_runtime_changed) {
        return Err(
            "Stop the active turn before changing provider, effort, or access mode on a running thread."
                .to_string(),
        );
    }

    let existing_claude_handle = if !provider_changed
        && existing.summary.provider_id == AgentProviderId::Claude
    {
        let guard = state.claude_sessions.lock().await;
        guard.get(&thread_id).cloned()
    } else {
        None
    };

    if let Some(handle) = existing_claude_handle {
        if claude_startup_change {
            // Idle Claude process cannot apply --effort or --allow-dangerously-skip-permissions live.
            // Terminate it while preserving provider_session_id so the next turn resumes with the new flags.
            let removed = { state.claude_sessions.lock().await.remove(&thread_id) };
            if let Some(removed) = removed {
                removed.kill().await;
            }
        } else {
            let mut live_failed: Option<String> = None;
            if let Some(ref m) = model {
                if !m.is_empty() && existing.summary.model.as_deref() != Some(m.as_str()) {
                    if let Err(err) = handle.set_model(m).await {
                        live_failed = Some(err);
                    }
                }
            }
            let next_interaction = interaction_mode.unwrap_or(existing.summary.interaction_mode);
            let next_runtime = runtime_mode.unwrap_or(existing.summary.runtime_mode);
            if live_failed.is_none()
                && (next_interaction != existing.summary.interaction_mode
                    || next_runtime != existing.summary.runtime_mode)
            {
                if let Err(err) = handle
                    .set_permission_mode(next_interaction, next_runtime)
                    .await
                {
                    live_failed = Some(err);
                }
            }
            if let Some(err) = live_failed {
                if is_turn_active {
                    return Err(format!("Failed to apply Claude setting live: {}", err));
                }
                // Idle session rejected/timed out on live RPC; restart on next turn while keeping provider_session_id.
                let removed = { state.claude_sessions.lock().await.remove(&thread_id) };
                if let Some(removed) = removed {
                    removed.kill().await;
                }
            }
        }
    }

    let updated = store
        .mutate_thread(&project_path, &thread_id, |t| {
            if let Some(ref v) = title {
                t.summary.title = v.clone();
            }
            if let Some(v) = pinned {
                t.summary.pinned = v;
            }
            if let Some(v) = archived {
                t.summary.archived = v;
            }
            if let Some(p) = provider_id {
                if p != t.summary.provider_id {
                    t.summary.provider_id = p;
                    t.summary.provider_session_id = None;
                }
            }
            if let Some(ref m) = model {
                t.summary.model = if m.is_empty() { None } else { Some(m.clone()) };
            }
            if let Some(ref e) = reasoning_effort {
                t.summary.reasoning_effort = if e.is_empty() { None } else { Some(e.clone()) };
            }
            if let Some(im) = interaction_mode {
                t.summary.interaction_mode = im;
            }
            if let Some(rm) = runtime_mode {
                t.summary.runtime_mode = rm;
            }
        })
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    if provider_changed {
        if let Some(handle) = state.claude_sessions.lock().await.remove(&thread_id) {
            handle.kill().await;
        }
        let acp_keys: Vec<String> = state
            .acp_clients
            .lock()
            .await
            .keys()
            .filter(|k| k.ends_with(&format!(":{}", thread_id)))
            .cloned()
            .collect();
        for k in acp_keys {
            if let Some(c) = state.acp_clients.lock().await.remove(&k) {
                c.kill().await;
            }
        }
    } else if matches!(
        updated.summary.provider_id,
        AgentProviderId::Antigravity | AgentProviderId::CustomAcp
    ) && runtime_mode.is_some()
        && existing.summary.runtime_mode != updated.summary.runtime_mode
    {
        // ACP permission flags (e.g. --dangerously-skip-permissions) are CLI spawn flags
        let key = format!("{:?}:{}", updated.summary.provider_id, thread_id);
        if let Some(c) = state.acp_clients.lock().await.remove(&key) {
            c.kill().await;
        }
    }

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: updated.summary.clone(),
        },
    );
    Ok(updated.summary)
}

#[tauri::command]
pub async fn agent_delete_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
) -> Result<(), String> {
    if let Some(handle) = state.claude_sessions.lock().await.remove(&thread_id) {
        handle.kill().await;
    }
    let acp_keys: Vec<String> = state
        .acp_clients
        .lock()
        .await
        .keys()
        .filter(|k| k.ends_with(&format!(":{}", thread_id)))
        .cloned()
        .collect();
    for k in acp_keys {
        if let Some(c) = state.acp_clients.lock().await.remove(&k) {
            c.kill().await;
        }
    }
    let store = state.get_store(&app).await?;
    store.delete_thread(&project_path, &thread_id).await?;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadDeleted {
            project_path,
            thread_id,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn agent_fork_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    custom_binary_path: Option<String>,
    fork_to_main_workspace: Option<bool>,
) -> Result<AgentThread, String> {
    let store = state.get_store(&app).await?;
    let source = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    let now = now_millis();
    let new_id = uuid::Uuid::new_v4().to_string();
    let mut forked_provider_sid = None;

    if source.summary.provider_id == AgentProviderId::Codex {
        if let Some(ref src_sid) = source.summary.provider_session_id {
            let bin = find_cli_binary(&["codex"], custom_binary_path.as_deref())
                .await
                .ok_or_else(|| "Codex CLI not found".to_string())?;
            let client = ensure_codex_client(
                app.clone(),
                store.clone(),
                state.rate_limit_cache.clone(),
                state.codex_client.clone(),
                &bin,
            )
            .await?;
            forked_provider_sid = client.fork_thread(src_sid).await.ok();
        }
    } else if source.summary.provider_id == AgentProviderId::Claude {
        // Claude forks on first message using --resume <src> --fork-session or immediately spawns
        forked_provider_sid = None;
    }

    let forked = AgentThread {
        summary: ThreadSummary {
            id: new_id.clone(),
            project_path: source.summary.project_path.clone(),
            title: format!("{} (Fork)", source.summary.title),
            provider_id: source.summary.provider_id,
            provider_session_id: forked_provider_sid,
            model: source.summary.model.clone(),
            reasoning_effort: source.summary.reasoning_effort.clone(),
            interaction_mode: source.summary.interaction_mode,
            runtime_mode: source.summary.runtime_mode,
            pinned: false,
            archived: false,
            created_at: now,
            updated_at: now,
            message_count: source.messages.len(),
            last_preview: source.summary.last_preview.clone(),
            status: "idle".to_string(),
            workspace_path: if fork_to_main_workspace.unwrap_or(false) {
                None
            } else {
                source.summary.workspace_path.clone()
            },
            workspace_branch: if fork_to_main_workspace.unwrap_or(false) {
                None
            } else {
                source.summary.workspace_branch.clone()
            },
            parent_thread_id: None,
            schedule: None,
        },
        messages: source.messages.clone(),
        usage: source.usage.clone(),
        tasks: source.tasks.clone(),
        pending_interaction: None,
    };

    store.save_thread(forked.clone()).await?;

    if source.summary.provider_id == AgentProviderId::Claude {
        if let Some(ref src_sid) = source.summary.provider_session_id {
            if let Ok(handle) = spawn_claude_session(
                app.clone(),
                store.clone(),
                state.rate_limit_cache.clone(),
                state.claude_sessions.clone(),
                &forked,
                custom_binary_path.as_deref(),
                Some(src_sid),
            )
            .await
            {
                state.claude_sessions.lock().await.insert(new_id, handle);
            }
        }
    }

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: forked.summary.clone(),
        },
    );
    Ok(forked)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnCheckpointMetadata<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    thread_id: &'a str,
    title: &'a str,
    provider_id: AgentProviderId,
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_path: Option<&'a str>,
}

pub(crate) async fn capture_turn_checkpoint(
    summary: &ThreadSummary,
    user_msg_id: &str,
    phase: &str,
) {
    let dir = summary.effective_workspace_path();
    let id = format!("turn-{user_msg_id}-{phase}");
    let metadata = TurnCheckpointMetadata {
        kind: "agentTurn",
        thread_id: &summary.id,
        title: &summary.title,
        provider_id: summary.provider_id,
        phase,
        workspace_path: summary.workspace_path.as_deref(),
    };
    let Ok(message) = serde_json::to_string(&metadata) else {
        return;
    };
    if !crate::commands::checkpoints::checkpoint_exists(dir, &id).await {
        let _ = crate::commands::checkpoints::checkpoint_create(
            dir.to_string(),
            Some(id),
            Some(message),
        )
        .await;
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_send_message(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    content: String,
    attachments: Option<Vec<AttachmentInput>>,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<(), String> {
    let store = state.get_store(&app).await?;
    let atts = attachments.unwrap_or_default();
    let configs = custom_configs.unwrap_or_default();

    let mut user_parts: Vec<AgentPart> = Vec::new();
    for (idx, att) in atts.iter().enumerate() {
        if let Some(ref url) = att.data_url {
            user_parts.push(AgentPart::Image {
                id: format!("img_{}", idx),
                url: url.clone(),
                mime: att.mime.clone(),
                filename: Some(att.filename.clone()),
            });
        }
    }
    if !content.is_empty() {
        user_parts.push(AgentPart::Text {
            id: uuid::Uuid::new_v4().to_string(),
            text: content.clone(),
        });
    }

    let user_msg = AgentMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        created_at: now_millis(),
        completed_at: Some(now_millis()),
        provider_id: None,
        model: None,
        parts: user_parts,
        changed_files: Vec::new(),
        error: None,
    };

    let thread = {
        let _wt_guard =
            worktree::acquire_thread_lock(&state.worktree_locks, &project_path, &thread_id).await;
        let current = store
            .get_thread(&project_path, &thread_id)
            .await?
            .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;
        if matches!(current.summary.status.as_str(), "running" | "waiting_input") {
            return Err("This thread already has a turn in progress".to_string());
        }
        store
            .mutate_thread(&project_path, &thread_id, |t| {
                ThreadStore::append_message_to_thread(t, user_msg.clone());
                t.summary.status = "running".to_string();
                ThreadStore::set_pending_interaction(t, None);
            })
            .await?
            .ok_or_else(|| format!("Thread '{}' not found", thread_id))?
    };

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: thread.summary.clone(),
        },
    );
    let user_msg_id = user_msg.id.clone();
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::MessageAdded {
            thread_id: thread_id.clone(),
            message: user_msg,
        },
    );
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::TurnStatus {
            thread_id: thread_id.clone(),
            status: "running".to_string(),
            error: None,
        },
    );

    capture_turn_checkpoint(&thread.summary, &user_msg_id, "before").await;

    let dispatch_res = async {
        match thread.summary.provider_id {
            AgentProviderId::Claude => {
                let custom_bin = find_custom_config(&configs, AgentProviderId::Claude)
                    .and_then(|c| c.binary_path.as_deref());
                let existing = state.claude_sessions.lock().await.get(&thread_id).cloned();
                let compatible_existing = match existing {
                    Some(h) if h.is_compatible_with(&thread.summary).await => Some(h),
                    Some(stale) => {
                        state.claude_sessions.lock().await.remove(&thread_id);
                        stale.kill().await;
                        None
                    }
                    None => None,
                };
                let handle = if let Some(h) = compatible_existing {
                    h
                } else {
                    let spawned = spawn_claude_session(
                        app.clone(),
                        store.clone(),
                        state.rate_limit_cache.clone(),
                        state.claude_sessions.clone(),
                        &thread,
                        custom_bin,
                        None,
                    )
                    .await?;
                    state
                        .claude_sessions
                        .lock()
                        .await
                        .insert(thread_id.clone(), spawned.clone());
                    spawned
                };
                handle.send_turn(&content, &atts).await
            }
            AgentProviderId::Codex => {
                let custom_bin = find_custom_config(&configs, AgentProviderId::Codex)
                    .and_then(|c| c.binary_path.as_deref());
                let bin = find_cli_binary(&["codex"], custom_bin)
                    .await
                    .ok_or_else(|| "Codex CLI ('codex') not found.".to_string())?;
                let client = ensure_codex_client(
                    app.clone(),
                    store.clone(),
                    state.rate_limit_cache.clone(),
                    state.codex_client.clone(),
                    &bin,
                )
                .await?;
                client
                    .start_turn(&app, &store, &thread, &content, &atts)
                    .await
            }
            AgentProviderId::Antigravity | AgentProviderId::CustomAcp => {
                let client =
                    ensure_acp_client_for_thread(&app, &state, &store, &thread, &configs).await?;
                client
                    .start_prompt(app.clone(), store.clone(), &thread, &content, &atts)
                    .await
            }
        }
    }
    .await;

    if let Err(err) = dispatch_res {
        let _ = store
            .mutate_thread(&project_path, &thread_id, |t| {
                t.summary.status = "error".to_string();
            })
            .await;
        let _ = app.emit(
            "agent-event",
            AgentStreamEvent::TurnStatus {
                thread_id,
                status: "error".to_string(),
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

    Ok(())
}

async fn ensure_acp_client_for_thread(
    app: &AppHandle,
    state: &AgentManagerState,
    store: &Arc<ThreadStore>,
    thread: &AgentThread,
    configs: &[ProviderCustomConfig],
) -> Result<AcpClient, String> {
    let key = format!("{:?}:{}", thread.summary.provider_id, thread.summary.id);
    if let Some(existing) = state.acp_clients.lock().await.get(&key).cloned() {
        return Ok(existing);
    }

    let cfg = find_custom_config(configs, thread.summary.provider_id);
    let (bin_path, args) = match thread.summary.provider_id {
        AgentProviderId::Antigravity => {
            let custom_bin = cfg.and_then(|c| c.binary_path.as_deref());
            let bin = find_cli_binary(&["agy"], custom_bin)
                .await
                .ok_or_else(|| "Antigravity CLI ('agy') not found.".to_string())?;
            let mut args = vec!["acp".to_string(), "--stdio".to_string()];
            if thread.summary.runtime_mode == RuntimeMode::FullAccess {
                args.push("--dangerously-skip-permissions".to_string());
            }
            (bin, args)
        }
        AgentProviderId::CustomAcp => {
            let cmd = cfg
                .and_then(|c| c.custom_command.as_deref())
                .ok_or_else(|| "Custom ACP command is not configured.".to_string())?;
            let bin = find_cli_binary(&[], Some(cmd))
                .await
                .ok_or_else(|| format!("Custom ACP binary '{}' not found.", cmd))?;
            let args = cfg.and_then(|c| c.custom_args.clone()).unwrap_or_default();
            (bin, args)
        }
        _ => return Err("Unsupported ACP provider".to_string()),
    };

    let client = AcpClient::spawn(
        app.clone(),
        store.clone(),
        thread.summary.provider_id,
        &bin_path,
        &args,
        &thread.summary.project_path,
        thread.summary.effective_workspace_path(),
    )
    .await?;
    state.acp_clients.lock().await.insert(key, client.clone());
    Ok(client)
}

#[tauri::command]
pub async fn agent_steer_turn(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    content: String,
    attachments: Option<Vec<AttachmentInput>>,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<(), String> {
    let store = state.get_store(&app).await?;
    let thread = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;
    let atts = attachments.unwrap_or_default();
    let configs = custom_configs.unwrap_or_default();

    if thread.summary.provider_id == AgentProviderId::Codex {
        let custom_bin = find_custom_config(&configs, AgentProviderId::Codex)
            .and_then(|c| c.binary_path.as_deref());
        let bin = find_cli_binary(&["codex"], custom_bin)
            .await
            .ok_or_else(|| "Codex CLI not found".to_string())?;
        let client = ensure_codex_client(
            app.clone(),
            store.clone(),
            state.rate_limit_cache.clone(),
            state.codex_client.clone(),
            &bin,
        )
        .await?;

        let user_msg = AgentMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".to_string(),
            created_at: now_millis(),
            completed_at: Some(now_millis()),
            provider_id: None,
            model: None,
            parts: vec![AgentPart::Text {
                id: uuid::Uuid::new_v4().to_string(),
                text: content.clone(),
            }],
            changed_files: Vec::new(),
            error: None,
        };
        let _ = store
            .mutate_thread(&project_path, &thread_id, |t| {
                ThreadStore::append_message_to_thread(t, user_msg.clone());
            })
            .await;
        let _ = app.emit(
            "agent-event",
            AgentStreamEvent::MessageAdded {
                thread_id: thread_id.clone(),
                message: user_msg,
            },
        );
        return client.steer_turn(&app, &thread, &content, &atts).await;
    }

    // For Claude & ACP, interrupt active turn and immediately send steered follow-up
    let _ = agent_interrupt_turn(
        app.clone(),
        state.clone(),
        project_path.clone(),
        thread_id.clone(),
    )
    .await;
    tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;
    agent_send_message(
        app,
        state,
        project_path,
        thread_id,
        content,
        Some(atts),
        Some(configs),
    )
    .await
}

#[tauri::command]
pub async fn agent_interrupt_turn(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
) -> Result<(), String> {
    let store = state.get_store(&app).await?;
    let thread = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    match thread.summary.provider_id {
        AgentProviderId::Claude => {
            if let Some(handle) = state.claude_sessions.lock().await.get(&thread_id).cloned() {
                let _ = handle.interrupt().await;
            }
        }
        AgentProviderId::Codex => {
            if let Some(client) = state.codex_client.lock().await.clone() {
                let _ = client.interrupt_turn(&thread).await;
            }
        }
        AgentProviderId::Antigravity | AgentProviderId::CustomAcp => {
            let key = format!("{:?}:{}", thread.summary.provider_id, thread.summary.id);
            if let Some(client) = state.acp_clients.lock().await.get(&key).cloned() {
                if let Some(ref sid) = thread.summary.provider_session_id {
                    let _ = client.cancel_session(sid).await;
                }
            }
        }
    }

    let _ = store
        .mutate_thread(&project_path, &thread_id, |t| {
            t.summary.status = "idle".to_string();
            ThreadStore::set_pending_interaction(t, None);
        })
        .await;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::TurnStatus {
            thread_id,
            status: "idle".to_string(),
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn agent_compact_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<(), String> {
    let store = state.get_store(&app).await?;
    let thread = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;
    let configs = custom_configs.unwrap_or_default();

    match thread.summary.provider_id {
        AgentProviderId::Claude => {
            let claude_handle = state.claude_sessions.lock().await.get(&thread_id).cloned();
            if let Some(handle) = claude_handle {
                handle.send_compact().await
            } else {
                agent_send_message(
                    app,
                    state,
                    project_path,
                    thread_id,
                    "/compact".to_string(),
                    None,
                    Some(configs),
                )
                .await
            }
        }
        AgentProviderId::Codex => {
            let Some(ref codex_tid) = thread.summary.provider_session_id else {
                return Err("No active Codex session to compact".to_string());
            };
            let custom_bin = find_custom_config(&configs, AgentProviderId::Codex)
                .and_then(|c| c.binary_path.as_deref());
            let bin = find_cli_binary(&["codex"], custom_bin)
                .await
                .ok_or_else(|| "Codex CLI not found".to_string())?;
            let client = ensure_codex_client(
                app,
                store,
                state.rate_limit_cache.clone(),
                state.codex_client.clone(),
                &bin,
            )
            .await?;
            client.compact_thread(codex_tid).await
        }
        AgentProviderId::Antigravity | AgentProviderId::CustomAcp => {
            Err("Compact is not supported by this ACP provider.".to_string())
        }
    }
}

#[tauri::command]
pub async fn agent_respond_interaction(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    interaction_id: String,
    response: InteractionResponse,
) -> Result<(), String> {
    let store = state.get_store(&app).await?;
    let thread = store
        .get_thread(&project_path, &thread_id)
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    match thread.summary.provider_id {
        AgentProviderId::Claude => {
            let handle = state
                .claude_sessions
                .lock()
                .await
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| "Claude session not active".to_string())?;
            handle
                .respond_interaction(&interaction_id, &response, thread.summary.runtime_mode)
                .await?;
        }
        AgentProviderId::Codex => {
            let client = state
                .codex_client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Codex app-server not active".to_string())?;
            client
                .respond_interaction(&interaction_id, &response)
                .await?;
        }
        AgentProviderId::Antigravity | AgentProviderId::CustomAcp => {
            let key = format!("{:?}:{}", thread.summary.provider_id, thread.summary.id);
            let client = state
                .acp_clients
                .lock()
                .await
                .get(&key)
                .cloned()
                .ok_or_else(|| "ACP session not active".to_string())?;
            client
                .respond_permission(&interaction_id, &response)
                .await?;
        }
    }

    let _ = store
        .mutate_thread(&project_path, &thread_id, |t| {
            ThreadStore::set_pending_interaction(t, None);
            t.summary.status = "running".to_string();
        })
        .await;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::InteractionResolved {
            thread_id: thread_id.clone(),
            interaction_id,
        },
    );
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::TurnStatus {
            thread_id,
            status: "running".to_string(),
            error: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn agent_one_shot_prompt(
    project_path: String,
    provider_id: AgentProviderId,
    model: Option<String>,
    prompt: String,
    custom_binary_path: Option<String>,
) -> Result<String, String> {
    match provider_id {
        AgentProviderId::Claude => {
            run_claude_one_shot(
                &project_path,
                model.as_deref(),
                &prompt,
                custom_binary_path.as_deref(),
            )
            .await
        }
        AgentProviderId::Codex => {
            run_codex_one_shot(
                &project_path,
                model.as_deref(),
                &prompt,
                custom_binary_path.as_deref(),
            )
            .await
        }
        AgentProviderId::Antigravity => {
            let bin = find_cli_binary(&["agy"], custom_binary_path.as_deref())
                .await
                .ok_or_else(|| "Antigravity CLI ('agy') not found.".to_string())?;
            let mut args = vec![
                "-p".to_string(),
                prompt,
                "--output-format".to_string(),
                "json".to_string(),
            ];
            if let Some(ref m) = model {
                if !m.trim().is_empty() {
                    args.push("--model".to_string());
                    args.push(m.clone());
                }
            }
            let out = tokio::time::timeout(
                tokio::time::Duration::from_secs(60),
                binary::spawn_cli_command(&bin, &args, &project_path)
                    .await
                    .output(),
            )
            .await
            .map_err(|_| "Antigravity prompt timed out".to_string())?
            .map_err(|e| format!("Failed to run agy: {}", e))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            let raw = String::from_utf8_lossy(&out.stdout);
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(res) = val.get("result").and_then(|v| v.as_str()) {
                    return Ok(res.trim().to_string());
                }
            }
            Ok(raw.trim().to_string())
        }
        AgentProviderId::CustomAcp => {
            Err("One-shot prompt is not supported for Custom ACP.".to_string())
        }
    }
}

fn runtime_mode_rank(mode: RuntimeMode) -> u8 {
    match mode {
        RuntimeMode::ApprovalRequired => 0,
        RuntimeMode::AutoAcceptEdits => 1,
        RuntimeMode::FullAccess => 2,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_delegate_thread(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    parent_thread_id: String,
    provider_id: AgentProviderId,
    brief: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    interaction_mode: Option<InteractionMode>,
    runtime_mode: Option<RuntimeMode>,
    title: Option<String>,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<AgentThread, String> {
    if brief.trim().is_empty() {
        return Err("Delegation brief cannot be empty".to_string());
    }
    let store = state.get_store(&app).await?;
    let parent = store
        .get_thread(&project_path, &parent_thread_id)
        .await?
        .ok_or_else(|| format!("Parent thread '{}' not found", parent_thread_id))?;

    let effective_runtime_mode = runtime_mode.unwrap_or(parent.summary.runtime_mode);
    if runtime_mode_rank(effective_runtime_mode) > runtime_mode_rank(parent.summary.runtime_mode) {
        return Err(
            "Child runtimeMode cannot escalate beyond parent thread's runtimeMode".to_string(),
        );
    }

    let child = store
        .create_thread_with_parent(
            project_path.clone(),
            provider_id,
            model,
            reasoning_effort,
            interaction_mode.unwrap_or_default(),
            effective_runtime_mode,
            title,
            Some(parent_thread_id),
        )
        .await?;
    let child_id = child.summary.id.clone();

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: child.summary.clone(),
        },
    );

    agent_send_message(
        app,
        state.clone(),
        project_path.clone(),
        child_id.clone(),
        brief,
        None,
        custom_configs,
    )
    .await?;

    Ok(store
        .get_thread(&project_path, &child_id)
        .await?
        .unwrap_or(child))
}

#[tauri::command]
pub async fn agent_set_thread_schedule(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    thread_id: String,
    schedule: Option<ThreadSchedule>,
) -> Result<ThreadSummary, String> {
    if let Some(ref sched) = schedule {
        if sched.prompt.trim().is_empty() {
            return Err("Schedule prompt cannot be empty".to_string());
        }
        if sched.repeat_interval_ms.is_some_and(|ms| ms <= 0) {
            return Err("Schedule repeatIntervalMs must be positive".to_string());
        }
    }
    let store = state.get_store(&app).await?;
    let updated = store
        .mutate_thread(&project_path, &thread_id, |t| {
            t.summary.schedule = schedule;
        })
        .await?
        .ok_or_else(|| format!("Thread '{}' not found", thread_id))?;

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::ThreadUpdated {
            thread: updated.summary.clone(),
        },
    );
    Ok(updated.summary)
}

#[tauri::command]
pub async fn agent_run_due_schedules(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    project_path: String,
    custom_configs: Option<Vec<ProviderCustomConfig>>,
) -> Result<Vec<ScheduleRunResult>, String> {
    let store = state.get_store(&app).await?;
    let now = now_millis();
    let claimed = store.claim_due_schedules(&project_path, now).await?;
    let mut results = Vec::with_capacity(claimed.len());

    for (thread_id, sched) in claimed {
        let send_res = agent_send_message(
            app.clone(),
            state.clone(),
            project_path.clone(),
            thread_id.clone(),
            sched.prompt,
            None,
            custom_configs.clone(),
        )
        .await;

        match send_res {
            Ok(()) => {
                if sched.repeat_interval_ms.is_some() {
                    if let Ok(Some(updated)) = store
                        .mutate_thread(&project_path, &thread_id, |t| {
                            if let Some(ref mut s) = t.summary.schedule {
                                s.last_result = Some("ok".to_string());
                            }
                        })
                        .await
                    {
                        let _ = app.emit(
                            "agent-event",
                            AgentStreamEvent::ThreadUpdated {
                                thread: updated.summary,
                            },
                        );
                    }
                }
                results.push(ScheduleRunResult {
                    thread_id,
                    ok: true,
                    error: None,
                });
            }
            Err(err) => {
                if let Ok(Some(updated)) = store
                    .mutate_thread(&project_path, &thread_id, |t| {
                        if let Some(ref mut s) = t.summary.schedule {
                            s.last_result = Some(format!("error: {}", err));
                        }
                    })
                    .await
                {
                    let _ = app.emit(
                        "agent-event",
                        AgentStreamEvent::ThreadUpdated {
                            thread: updated.summary,
                        },
                    );
                }
                results.push(ScheduleRunResult {
                    thread_id,
                    ok: false,
                    error: Some(err),
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn agent_shutdown_all(state: State<'_, AgentManagerState>) -> Result<(), String> {
    state.shutdown_all().await;
    Ok(())
}

#[allow(dead_code)]
fn _unused_json_marker() -> serde_json::Value {
    json!({})
}

#[tauri::command]
pub async fn agent_query_usage_log(
    app: AppHandle,
    state: State<'_, AgentManagerState>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    project_path: Option<String>,
) -> Result<usage_log::UsageLogQueryResult, String> {
    let log = state.get_usage_log(&app).await?;
    log.query(start_ms, end_ms, project_path.as_deref()).await
}
