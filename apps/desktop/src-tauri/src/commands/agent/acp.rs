use super::binary::{find_cli_binary, persist_attachment_to_disk, spawn_cli_command};
use super::store::ThreadStore;
use super::types::{
    now_millis, AgentMessage, AgentPart, AgentProviderId, AgentStreamEvent, AgentThread,
    AttachmentInput, InteractionMode, InteractionResponse, ModelInfo, PendingInteraction,
    PermissionOption, PlanTaskItem, ProviderCustomConfig, ProviderStatus, RateLimitsSnapshot,
    SlashCommandInfo, TokenUsageSnapshot,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::time::{timeout, Duration};

const MAX_ACP_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;

struct AcpTerminalProcess {
    output: Arc<Mutex<String>>,
    truncated: Arc<Mutex<bool>>,
    exit_rx: watch::Receiver<Option<i32>>,
    kill_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

#[derive(Debug, Clone)]
struct PendingAcpPermission {
    rpc_id: Value,
    #[allow(dead_code)]
    local_thread_id: String,
    #[allow(dead_code)]
    project_path: String,
    options: Vec<PermissionOption>,
}

type PendingRpcMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Clone)]
pub struct AcpClient {
    pub provider_id: AgentProviderId,
    stdin_tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicU64>,
    pending_rpc: PendingRpcMap,
    child: Arc<Mutex<Option<Child>>>,
    terminals: Arc<Mutex<HashMap<String, AcpTerminalProcess>>>,
    session_to_local: Arc<Mutex<HashMap<String, String>>>,
    active_turns: Arc<Mutex<HashMap<String, AcpActiveTurn>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingAcpPermission>>>,
    session_models: Arc<Mutex<HashMap<String, Vec<ModelInfo>>>>,
    session_modes: Arc<Mutex<HashMap<String, Vec<String>>>>,
    session_model_config_id: Arc<Mutex<HashMap<String, String>>>,
    session_effort_config_id: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone)]
struct AcpActiveTurn {
    #[allow(dead_code)]
    local_thread_id: String,
    project_path: String,
    workspace_path: String,
    message_id: String,
    text_part_id: Option<String>,
    reasoning_part_id: Option<String>,
}

impl AcpClient {
    pub async fn spawn(
        app: AppHandle,
        store: Arc<ThreadStore>,
        provider_id: AgentProviderId,
        binary_path: &str,
        extra_args: &[String],
        project_path: &str,
        cwd: &str,
    ) -> Result<Self, String> {
        let mut cmd = spawn_cli_command(binary_path, extra_args, cwd).await;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn ACP agent '{}': {}", binary_path, e))?;

        let mut stdin = child.stdin.take().ok_or("Missing ACP stdin")?;
        let stdout = child.stdout.take().ok_or("Missing ACP stdout")?;
        let stderr = child.stderr.take();

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        let pending_rpc = Arc::new(Mutex::new(HashMap::<
            u64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));
        let child_arc = Arc::new(Mutex::new(Some(child)));
        let session_to_local = Arc::new(Mutex::new(HashMap::<String, String>::new()));
        let active_turns = Arc::new(Mutex::new(HashMap::<String, AcpActiveTurn>::new()));
        let pending_permissions =
            Arc::new(Mutex::new(HashMap::<String, PendingAcpPermission>::new()));
        let terminals = Arc::new(Mutex::new(HashMap::<String, AcpTerminalProcess>::new()));

        let client = Self {
            provider_id,
            stdin_tx: stdin_tx.clone(),
            next_id: Arc::new(AtomicU64::new(1)),
            pending_rpc: pending_rpc.clone(),
            child: child_arc.clone(),
            terminals: terminals.clone(),
            session_to_local: session_to_local.clone(),
            active_turns: active_turns.clone(),
            pending_permissions: pending_permissions.clone(),
            session_models: Arc::new(Mutex::new(HashMap::new())),
            session_modes: Arc::new(Mutex::new(HashMap::new())),
            session_model_config_id: Arc::new(Mutex::new(HashMap::new())),
            session_effort_config_id: Arc::new(Mutex::new(HashMap::new())),
        };

        if let Some(stderr) = stderr {
            let app_err = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "agent-event",
                        AgentStreamEvent::ProviderLog {
                            provider_id,
                            thread_id: None,
                            stream: "stderr".to_string(),
                            message: line,
                        },
                    );
                }
            });
        }

        // Stdout JSON-RPC reader
        let app_out = app.clone();
        let store_out = store.clone();
        let thread_project = project_path.to_string();
        let cwd_root = cwd.to_string();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };

                let has_method = msg.get("method").and_then(|v| v.as_str()).is_some();
                let has_id = msg.get("id").is_some() && !msg.get("id").unwrap().is_null();

                if !has_method && has_id {
                    if let Some(id_num) = msg.get("id").and_then(|v| v.as_u64()) {
                        if let Some(tx) = pending_rpc.lock().await.remove(&id_num) {
                            if let Some(err) = msg.get("error") {
                                let err_msg = err
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("ACP error")
                                    .to_string();
                                let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                                let _ = tx.send(Err(format!("{} (code {})", err_msg, code)));
                            } else {
                                let _ =
                                    tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                    continue;
                }

                if has_method && !has_id {
                    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    if method == "session/update" {
                        handle_acp_session_update(
                            &app_out,
                            &store_out,
                            provider_id,
                            &session_to_local,
                            &active_turns,
                            &params,
                        )
                        .await;
                    }
                    continue;
                }

                if has_method && has_id {
                    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                    let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    handle_acp_agent_request(
                        &app_out,
                        &store_out,
                        &stdin_tx,
                        &cwd_root,
                        &thread_project,
                        &active_turns,
                        &session_to_local,
                        &pending_permissions,
                        &terminals,
                        method,
                        rpc_id,
                        &params,
                    )
                    .await;
                }
            }

            // Process exited - fail pending RPCs
            let mut guard = pending_rpc.lock().await;
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err("ACP agent process exited".to_string()));
            }
        });

        // Handshake
        let _init_res = client
            .rpc_call(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": true, "writeTextFile": true },
                        "terminal": true
                    },
                    "clientInfo": {
                        "name": "orchestratex",
                        "version": "0.1.3"
                    }
                }),
            )
            .await?;

        Ok(client)
    }

    pub async fn rpc_call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending_rpc.lock().await.insert(id, tx);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(line).is_err() {
            self.pending_rpc.lock().await.remove(&id);
            return Err("ACP stdin channel closed".to_string());
        }

        timeout(Duration::from_secs(300), rx)
            .await
            .map_err(|_| format!("ACP request '{}' timed out", method))?
            .map_err(|_| "ACP response channel dropped".to_string())?
    }

    pub fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(line)
            .map_err(|_| "ACP stdin channel closed".to_string())
    }

    pub async fn ensure_session(
        &self,
        store: &ThreadStore,
        app: &AppHandle,
        thread: &AgentThread,
    ) -> Result<String, String> {
        if let Some(ref existing_sid) = thread.summary.provider_session_id {
            let already_mapped = self
                .session_to_local
                .lock()
                .await
                .contains_key(existing_sid);
            if already_mapped {
                return Ok(existing_sid.clone());
            }
            self.session_to_local
                .lock()
                .await
                .insert(existing_sid.clone(), thread.summary.id.clone());
            if let Ok(load_res) = self
                .rpc_call(
                    "session/load",
                    json!({
                        "sessionId": existing_sid,
                        "cwd": thread.summary.effective_workspace_path(),
                        "mcpServers": [],
                    }),
                )
                .await
            {
                self.capture_session_metadata(existing_sid, &load_res).await;
                return Ok(existing_sid.clone());
            }
        }

        let res = self
            .rpc_call(
                "session/new",
                json!({
                    "cwd": thread.summary.effective_workspace_path(),
                    "mcpServers": [],
                }),
            )
            .await?;

        let sid = res
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "ACP session/new missing sessionId".to_string())?
            .to_string();

        self.session_to_local
            .lock()
            .await
            .insert(sid.clone(), thread.summary.id.clone());

        self.capture_session_metadata(&sid, &res).await;

        if let Ok(Some(updated)) = store
            .mutate_thread(&thread.summary.project_path, &thread.summary.id, |t| {
                t.summary.provider_session_id = Some(sid.clone());
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

        Ok(sid)
    }

    async fn capture_session_metadata(&self, session_id: &str, res: &Value) {
        if let Some(modes_arr) = res
            .get("modes")
            .and_then(|m| m.get("availableModes"))
            .and_then(|a| a.as_array())
        {
            let mode_ids: Vec<String> = modes_arr
                .iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            self.session_modes
                .lock()
                .await
                .insert(session_id.to_string(), mode_ids);
        }

        let mut models = Vec::new();
        if let Some(models_arr) = res
            .get("models")
            .and_then(|m| m.get("availableModels"))
            .and_then(|a| a.as_array())
        {
            for m in models_arr {
                if let Some(id) = m.get("modelId").and_then(|v| v.as_str()) {
                    models.push(ModelInfo {
                        id: id.to_string(),
                        name: m
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(id)
                            .to_string(),
                        description: m
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        supports_effort: false,
                        supported_effort_levels: Vec::new(),
                        default_effort: None,
                        supports_fast_mode: false,
                        is_default: res
                            .get("models")
                            .and_then(|mm| mm.get("currentModelId"))
                            .and_then(|v| v.as_str())
                            == Some(id),
                        context_window: None,
                    });
                }
            }
        }

        if let Some(opts) = res.get("configOptions").and_then(|v| v.as_array()) {
            for opt in opts {
                let cid = opt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let cat = opt.get("category").and_then(|v| v.as_str()).unwrap_or("");
                if cat == "model" || cid.to_ascii_lowercase().contains("model") {
                    self.session_model_config_id
                        .lock()
                        .await
                        .insert(session_id.to_string(), cid.to_string());
                    if models.is_empty() {
                        if let Some(choices) = opt.get("options").and_then(|v| v.as_array()) {
                            let current_val = opt.get("currentValue").and_then(|v| v.as_str());
                            for c in choices {
                                if let Some(val) = c.get("value").and_then(|v| v.as_str()) {
                                    models.push(ModelInfo {
                                        id: val.to_string(),
                                        name: c
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or(val)
                                            .to_string(),
                                        description: c
                                            .get("description")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                        supports_effort: false,
                                        supported_effort_levels: Vec::new(),
                                        default_effort: None,
                                        supports_fast_mode: false,
                                        is_default: current_val == Some(val),
                                        context_window: None,
                                    });
                                }
                            }
                        }
                    }
                } else if cat == "thought_level" || cid.to_ascii_lowercase().contains("effort") {
                    self.session_effort_config_id
                        .lock()
                        .await
                        .insert(session_id.to_string(), cid.to_string());
                }
            }
        }

        if !models.is_empty() {
            self.session_models
                .lock()
                .await
                .insert(session_id.to_string(), models);
        }
    }

    pub async fn start_prompt(
        &self,
        app: AppHandle,
        store: Arc<ThreadStore>,
        thread: &AgentThread,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<(), String> {
        let session_id = self.ensure_session(&store, &app, thread).await?;

        // Apply mode/model/effort if supported
        if let Some(available_modes) = self.session_modes.lock().await.get(&session_id).cloned() {
            let desired = if thread.summary.interaction_mode == InteractionMode::Plan {
                available_modes
                    .iter()
                    .find(|m| m.to_ascii_lowercase().contains("plan"))
            } else {
                available_modes.iter().find(|m| {
                    matches!(
                        m.to_ascii_lowercase().as_str(),
                        "default" | "code" | "accept-edits"
                    )
                })
            };
            if let Some(mode_id) = desired {
                let _ = self
                    .rpc_call(
                        "session/set_mode",
                        json!({ "sessionId": session_id, "modeId": mode_id }),
                    )
                    .await;
            }
        }

        if let Some(ref model) = thread.summary.model {
            if let Some(cfg_id) = self
                .session_model_config_id
                .lock()
                .await
                .get(&session_id)
                .cloned()
            {
                let _ = self
                    .rpc_call(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": cfg_id, "value": model }),
                    )
                    .await;
            } else {
                let has_session_model = self
                    .session_models
                    .lock()
                    .await
                    .get(&session_id)
                    .map(|ms| ms.iter().any(|m| m.id == *model))
                    .unwrap_or(false);
                if has_session_model {
                    let _ = self
                        .rpc_call(
                            "session/set_model",
                            json!({ "sessionId": session_id, "modelId": model }),
                        )
                        .await;
                }
            }
        }
        if let Some(ref effort) = thread.summary.reasoning_effort {
            if let Some(cfg_id) = self
                .session_effort_config_id
                .lock()
                .await
                .get(&session_id)
                .cloned()
            {
                let _ = self
                    .rpc_call(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": cfg_id, "value": effort }),
                    )
                    .await;
            }
        }

        // Build prompt content blocks
        let mut prompt_blocks: Vec<Value> = Vec::new();
        for att in attachments {
            if let Ok((_path, mime, bytes)) = persist_attachment_to_disk(&app, att).await {
                let b64 = super::binary::encode_base64(&bytes);
                prompt_blocks.push(json!({
                    "type": "image",
                    "data": b64,
                    "mimeType": mime,
                }));
            }
        }
        if !text.trim().is_empty() || prompt_blocks.is_empty() {
            prompt_blocks.push(json!({
                "type": "text",
                "text": text,
            }));
        }

        // Create assistant placeholder message
        let msg_id = uuid::Uuid::new_v4().to_string();
        let assistant_msg = AgentMessage {
            id: msg_id.clone(),
            role: "assistant".to_string(),
            created_at: now_millis(),
            completed_at: None,
            provider_id: Some(self.provider_id),
            model: thread.summary.model.clone(),
            parts: Vec::new(),
            changed_files: Vec::new(),
            error: None,
        };
        let _ = store
            .mutate_thread(&thread.summary.project_path, &thread.summary.id, |t| {
                ThreadStore::append_message_to_thread(t, assistant_msg.clone());
                t.summary.status = "running".to_string();
            })
            .await;
        let _ = app.emit(
            "agent-event",
            AgentStreamEvent::MessageAdded {
                thread_id: thread.summary.id.clone(),
                message: assistant_msg,
            },
        );

        self.active_turns.lock().await.insert(
            session_id.clone(),
            AcpActiveTurn {
                local_thread_id: thread.summary.id.clone(),
                project_path: thread.summary.project_path.clone(),
                workspace_path: thread.summary.effective_workspace_path().to_string(),
                message_id: msg_id.clone(),
                text_part_id: None,
                reasoning_part_id: None,
            },
        );

        let client_clone = self.clone();
        let local_tid = thread.summary.id.clone();
        let project_path = thread.summary.project_path.clone();
        tokio::spawn(async move {
            let result = client_clone
                .rpc_call(
                    "session/prompt",
                    json!({
                        "sessionId": session_id,
                        "prompt": prompt_blocks,
                    }),
                )
                .await;

            client_clone.active_turns.lock().await.remove(&session_id);

            let err_msg = result.err();
            let final_status = if err_msg.is_some() { "error" } else { "idle" };

            let _ = store
                .mutate_thread(&project_path, &local_tid, |t| {
                    t.summary.status = final_status.to_string();
                    ThreadStore::set_pending_interaction(t, None);
                    if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                        m.completed_at = Some(now_millis());
                        if let Some(ref em) = err_msg {
                            m.error = Some(em.clone());
                        }
                    }
                })
                .await;

            let _ = app.emit(
                "agent-event",
                AgentStreamEvent::TurnStatus {
                    thread_id: local_tid,
                    status: final_status.to_string(),
                    error: err_msg,
                },
            );
        });

        Ok(())
    }

    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.send_notification("session/cancel", json!({ "sessionId": session_id }))
    }

    pub async fn respond_permission(
        &self,
        interaction_id: &str,
        response: &InteractionResponse,
    ) -> Result<(), String> {
        let pending = self
            .pending_permissions
            .lock()
            .await
            .remove(interaction_id)
            .ok_or_else(|| format!("Pending ACP permission '{}' not found", interaction_id))?;

        let outcome_payload = match response {
            InteractionResponse::ApprovalDecision {
                decision,
                option_id,
                ..
            } => {
                if let Some(explicit_id) = option_id {
                    json!({
                        "outcome": {
                            "outcome": "selected",
                            "optionId": explicit_id,
                        }
                    })
                } else {
                    let target_kind = match decision.as_str() {
                        "allow_once" => "allow_once",
                        "allow_session" => "allow_always",
                        _ => "reject_once",
                    };
                    if let Some(found) = pending
                        .options
                        .iter()
                        .find(|o| o.kind == target_kind)
                        .or_else(|| {
                            if decision != "deny" {
                                pending.options.first()
                            } else {
                                pending
                                    .options
                                    .iter()
                                    .find(|o| o.kind.starts_with("reject"))
                            }
                        })
                    {
                        json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": found.id,
                            }
                        })
                    } else {
                        json!({
                            "outcome": {
                                "outcome": "cancelled"
                            }
                        })
                    }
                }
            }
            _ => json!({ "outcome": { "outcome": "cancelled" } }),
        };

        let resp = json!({
            "jsonrpc": "2.0",
            "id": pending.rpc_id,
            "result": outcome_payload,
        });
        let line = serde_json::to_string(&resp).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(line)
            .map_err(|_| "ACP stdin closed".to_string())
    }

    pub async fn kill(&self) {
        let active_terms: Vec<AcpTerminalProcess> = {
            let mut guard = self.terminals.lock().await;
            guard.drain().map(|(_, t)| t).collect()
        };
        for term in active_terms {
            if let Some(tx) = term.kill_tx.lock().await.take() {
                let _ = tx.send(());
            }
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }
}

pub async fn probe_acp(
    provider_id: AgentProviderId,
    custom_config: Option<&ProviderCustomConfig>,
) -> ProviderStatus {
    let (names, default_args, login_cmd, display_name) = match provider_id {
        AgentProviderId::Antigravity => (
            vec!["agy"],
            vec!["acp".to_string(), "--stdio".to_string()],
            AgentProviderId::Antigravity.login_command().to_string(),
            AgentProviderId::Antigravity.display_name().to_string(),
        ),
        AgentProviderId::CustomAcp => {
            let cmd = custom_config
                .and_then(|c| c.custom_command.clone())
                .unwrap_or_default();
            let name = custom_config
                .and_then(|c| c.custom_name.clone())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Custom ACP".to_string());
            let args = custom_config
                .and_then(|c| c.custom_args.clone())
                .unwrap_or_default();
            if cmd.trim().is_empty() {
                return ProviderStatus {
                    id: provider_id,
                    name,
                    transport: "acp".to_string(),
                    installed: false,
                    binary_path: None,
                    version: None,
                    authenticated: false,
                    auth_error: Some(
                        "Configure a Custom ACP command in Settings → Agents.".to_string(),
                    ),
                    login_command: String::new(),
                    account: None,
                    models: Vec::new(),
                    commands: Vec::new(),
                    rate_limits: None,
                    supports_steer: false,
                    supports_fork: false,
                    supports_compact: false,
                    supports_questions: false,
                };
            }
            (vec![], args, String::new(), name)
        }
        _ => (
            vec![],
            vec![],
            String::new(),
            provider_id.display_name().to_string(),
        ),
    };

    let custom_bin = if provider_id == AgentProviderId::CustomAcp {
        custom_config.and_then(|c| c.custom_command.as_deref())
    } else {
        custom_config.and_then(|c| c.binary_path.as_deref())
    };
    let name_refs: Vec<&str> = names.to_vec();
    let bin_path = find_cli_binary(&name_refs, custom_bin).await;
    let Some(bin_path) = bin_path else {
        return ProviderStatus {
            id: provider_id,
            name: display_name,
            transport: "acp".to_string(),
            installed: false,
            binary_path: None,
            version: None,
            authenticated: false,
            auth_error: Some(format!(
                "{} binary not found in PATH.",
                provider_id.display_name()
            )),
            login_command: login_cmd,
            account: None,
            models: Vec::new(),
            commands: Vec::new(),
            rate_limits: None,
            supports_steer: false,
            supports_fork: false,
            supports_compact: false,
            supports_questions: false,
        };
    };

    let mut version: Option<String> = None;
    let mut authenticated = true;
    let mut auth_error: Option<String> = None;
    let mut models: Vec<ModelInfo> = Vec::new();

    if provider_id == AgentProviderId::Antigravity {
        version = timeout(Duration::from_secs(3), async {
            let out = spawn_cli_command(&bin_path, &["--version".to_string()], "")
                .await
                .output()
                .await
                .ok()?;
            if out.status.success() {
                Some(
                    String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string(),
                )
            } else {
                None
            }
        })
        .await
        .ok()
        .flatten();
    }

    // Quick ACP probe for init + session/list auth verification
    if let Ok((init_res, list_res)) = probe_acp_stdio(&bin_path, &default_args).await {
        if version.is_none() {
            version = init_res
                .get("agentInfo")
                .and_then(|a| a.get("version"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        if let Err(err_str) = list_res {
            let lower = err_str.to_ascii_lowercase();
            if lower.contains("auth") || lower.contains("-32000") {
                authenticated = false;
                auth_error = Some(if !login_cmd.is_empty() {
                    format!("Not signed in. Run `{}`.", login_cmd)
                } else {
                    err_str
                });
            }
        }
    }

    if provider_id == AgentProviderId::Antigravity && authenticated {
        if let Ok(Ok(out)) = timeout(
            Duration::from_secs(4),
            spawn_cli_command(&bin_path, &["models".to_string()], "")
                .await
                .output(),
        )
        .await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty()
                    || trimmed.starts_with("Fetching")
                    || trimmed.starts_with("Error:")
                    || trimmed.starts_with("Available")
                {
                    continue;
                }
                let id = trimmed
                    .split_whitespace()
                    .next()
                    .unwrap_or(trimmed)
                    .to_string();
                models.push(ModelInfo {
                    id: id.clone(),
                    name: trimmed.to_string(),
                    description: None,
                    supports_effort: false,
                    supported_effort_levels: Vec::new(),
                    default_effort: None,
                    supports_fast_mode: false,
                    is_default: models.is_empty(),
                    context_window: None,
                });
            }
        }
    }

    let rate_limits = if provider_id == AgentProviderId::Antigravity {
        Some(RateLimitsSnapshot {
            provider_id,
            updated_at: now_millis(),
            plan_type: None,
            windows: Vec::new(),
            credits_balance: None,
            note: Some("Antigravity ACP reports session context usage (`usage_update`), not account quota windows.".to_string()),
        })
    } else {
        None
    };

    ProviderStatus {
        id: provider_id,
        name: display_name,
        transport: "acp".to_string(),
        installed: true,
        binary_path: Some(bin_path),
        version,
        authenticated,
        auth_error,
        login_command: login_cmd,
        account: None,
        models,
        commands: Vec::new(),
        rate_limits,
        supports_steer: false,
        supports_fork: false,
        supports_compact: false,
        supports_questions: false,
    }
}

async fn probe_acp_stdio(
    bin_path: &str,
    args: &[String],
) -> Result<(Value, Result<Value, String>), String> {
    let mut cmd = spawn_cli_command(bin_path, args, "").await;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;

    let init_req = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true },
            "clientInfo": { "name": "orchestratex", "version": "0.1.3" }
        }
    }))
    .map_err(|e| e.to_string())?;

    stdin
        .write_all(format!("{}\n", init_req).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stdout).lines();
    let mut init_res = Value::Null;
    let mut list_res: Result<Value, String> = Ok(Value::Null);

    let probe_res = timeout(Duration::from_secs(5), async {
        while let Ok(Some(line)) = reader.next_line().await {
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match val.get("id").and_then(|v| v.as_i64()) {
                Some(1) => {
                    init_res = val.get("result").cloned().unwrap_or(Value::Null);
                    let list_req = serde_json::to_string(&json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "session/list",
                        "params": { "cwd": "" }
                    }))
                    .unwrap_or_default();
                    let _ = stdin.write_all(format!("{}\n", list_req).as_bytes()).await;
                    let _ = stdin.flush().await;
                }
                Some(2) => {
                    if let Some(err) = val.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Error")
                            .to_string();
                        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                        list_res = Err(format!("{} (code {})", msg, code));
                    } else {
                        list_res = Ok(val.get("result").cloned().unwrap_or(Value::Null));
                    }
                    break;
                }
                _ => {}
            }
        }
        Ok::<(), String>(())
    })
    .await;

    let _ = child.kill().await;
    probe_res.map_err(|_| "ACP probe timed out".to_string())??;
    Ok((init_res, list_res))
}

async fn handle_acp_session_update(
    app: &AppHandle,
    store: &ThreadStore,
    provider_id: AgentProviderId,
    session_to_local: &Arc<Mutex<HashMap<String, String>>>,
    active_turns: &Arc<Mutex<HashMap<String, AcpActiveTurn>>>,
    params: &Value,
) {
    let Some(session_id) = params.get("sessionId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(update) = params.get("update") else {
        return;
    };
    let local_tid = {
        let map = session_to_local.lock().await;
        map.get(session_id).cloned()
    };
    let Some(local_tid) = local_tid else {
        return;
    };

    let update_type = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match update_type {
        "agent_message_chunk" => {
            let chunk_text = extract_acp_content_text(update.get("content"));
            if chunk_text.is_empty() {
                return;
            }
            let turn_info = {
                let mut guard = active_turns.lock().await;
                if let Some(turn) = guard.get_mut(session_id) {
                    let pid = turn
                        .text_part_id
                        .get_or_insert_with(|| format!("txt_{}", turn.message_id))
                        .clone();
                    Some((turn.project_path.clone(), turn.message_id.clone(), pid))
                } else {
                    None
                }
            };
            if let Some((project_path, msg_id, part_id)) = turn_info {
                let _ = store
                    .mutate_thread_memory(&project_path, &local_tid, |t| {
                        ThreadStore::append_delta_in_thread(
                            t,
                            &msg_id,
                            &part_id,
                            "text",
                            &chunk_text,
                        );
                    })
                    .await;
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::PartDelta {
                        thread_id: local_tid,
                        message_id: msg_id,
                        part_id,
                        part_type: "text".to_string(),
                        delta: chunk_text,
                    },
                );
            }
        }
        "agent_thought_chunk" => {
            let chunk_text = extract_acp_content_text(update.get("content"));
            if chunk_text.is_empty() {
                return;
            }
            let turn_info = {
                let mut guard = active_turns.lock().await;
                if let Some(turn) = guard.get_mut(session_id) {
                    let pid = turn
                        .reasoning_part_id
                        .get_or_insert_with(|| format!("thk_{}", turn.message_id))
                        .clone();
                    Some((turn.project_path.clone(), turn.message_id.clone(), pid))
                } else {
                    None
                }
            };
            if let Some((project_path, msg_id, part_id)) = turn_info {
                let _ = store
                    .mutate_thread_memory(&project_path, &local_tid, |t| {
                        ThreadStore::append_delta_in_thread(
                            t,
                            &msg_id,
                            &part_id,
                            "reasoning",
                            &chunk_text,
                        );
                    })
                    .await;
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::PartDelta {
                        thread_id: local_tid,
                        message_id: msg_id,
                        part_id,
                        part_type: "reasoning".to_string(),
                        delta: chunk_text,
                    },
                );
            }
        }
        "tool_call" | "tool_call_update" => {
            let turn_info = {
                let guard = active_turns.lock().await;
                guard
                    .get(session_id)
                    .map(|t| (t.project_path.clone(), t.message_id.clone()))
            };
            let Some((project_path, msg_id)) = turn_info else {
                return;
            };
            if let Some(part) = parse_acp_tool_call(update) {
                let changed_file = match &part {
                    AgentPart::Tool {
                        status,
                        tool,
                        file_path: Some(fp),
                        ..
                    } if status == "completed"
                        && matches!(tool.as_str(), "edit" | "write" | "delete") =>
                    {
                        Some(fp.clone())
                    }
                    _ => None,
                };
                let _ = store
                    .mutate_thread(&project_path, &local_tid, |t| {
                        ThreadStore::upsert_part_in_thread(t, &msg_id, part.clone());
                        if let Some(ref cf) = changed_file {
                            if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                                if !m.changed_files.contains(cf) {
                                    m.changed_files.push(cf.clone());
                                }
                            }
                        }
                    })
                    .await;
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::PartUpdated {
                        thread_id: local_tid,
                        message_id: msg_id,
                        part,
                    },
                );
            }
        }
        "plan" => {
            if let Some(tasks) = parse_acp_plan(update) {
                if let Some(project_path) = get_turn_project(active_turns, session_id).await {
                    let _ = store
                        .mutate_thread(&project_path, &local_tid, |t| {
                            ThreadStore::set_tasks(t, tasks.clone());
                        })
                        .await;
                }
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::PlanUpdated {
                        thread_id: local_tid,
                        tasks,
                    },
                );
            }
        }
        "usage_update" => {
            if let Some(project_path) = get_turn_project(active_turns, session_id).await {
                if let Some(mgr) = app.try_state::<super::AgentManagerState>() {
                    if let Ok(log) = mgr.get_usage_log(&app).await {
                        let model = store.get_thread_model(&project_path, &local_tid).await;
                        let _ = log
                            .record_acp_update(
                                provider_id,
                                &project_path,
                                &local_tid,
                                model.as_deref(),
                                update,
                            )
                            .await;
                    }
                }
            }
            if let Some(usage) = parse_acp_usage(update) {
                if let Some(project_path) = get_turn_project(active_turns, session_id).await {
                    let _ = store
                        .mutate_thread(&project_path, &local_tid, |t| {
                            ThreadStore::set_usage(t, usage.clone());
                        })
                        .await;
                }
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::TokenUsageUpdated {
                        thread_id: local_tid,
                        usage,
                    },
                );
            }
        }
        "available_commands_update" => {
            if let Some(arr) = update.get("availableCommands").and_then(|v| v.as_array()) {
                let commands: Vec<SlashCommandInfo> = arr
                    .iter()
                    .filter_map(|c| {
                        let name = c.get("name")?.as_str()?.to_string();
                        Some(SlashCommandInfo {
                            name,
                            description: c
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            argument_hint: c
                                .get("input")
                                .and_then(|i| i.get("hint"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        })
                    })
                    .collect();
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::CommandsUpdated {
                        provider_id,
                        commands,
                    },
                );
            }
        }
        _ => {}
    }
}

async fn get_turn_project(
    active_turns: &Arc<Mutex<HashMap<String, AcpActiveTurn>>>,
    session_id: &str,
) -> Option<String> {
    active_turns
        .lock()
        .await
        .get(session_id)
        .map(|t| t.project_path.clone())
}

#[allow(clippy::too_many_arguments)]
async fn handle_acp_agent_request(
    app: &AppHandle,
    store: &ThreadStore,
    stdin_tx: &mpsc::UnboundedSender<String>,
    project_root: &str,
    thread_project: &str,
    active_turns: &Arc<Mutex<HashMap<String, AcpActiveTurn>>>,
    session_to_local: &Arc<Mutex<HashMap<String, String>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingAcpPermission>>>,
    terminals: &Arc<Mutex<HashMap<String, AcpTerminalProcess>>>,
    method: &str,
    rpc_id: Value,
    params: &Value,
) {
    let session_id_param = params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let effective_root = if !session_id_param.is_empty() {
        active_turns
            .lock()
            .await
            .get(session_id_param)
            .map(|t| t.workspace_path.clone())
            .unwrap_or_else(|| project_root.to_string())
    } else {
        project_root.to_string()
    };
    let project_root = effective_root.as_str();
    match method {
        "session/request_permission" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let local_tid = {
                session_to_local
                    .lock()
                    .await
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default()
            };
            if local_tid.is_empty() {
                send_rpc_error(stdin_tx, rpc_id, -32000, "Unknown session");
                return;
            }
            let tool_call = params.get("toolCall").cloned().unwrap_or_else(|| json!({}));
            let tool_call_id = tool_call
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let title = tool_call
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Approve Tool Execution")
                .to_string();
            let tool_name = tool_call
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let raw_input = tool_call
                .get("rawInput")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let file_path = tool_call
                .get("locations")
                .and_then(|l| l.as_array())
                .and_then(|a| a.first())
                .and_then(|loc| loc.get("path"))
                .and_then(|p| p.as_str())
                .map(|s| s.to_string());
            let command = raw_input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let options: Vec<PermissionOption> = params
                .get("options")
                .and_then(|o| o.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| {
                            Some(PermissionOption {
                                id: o.get("optionId")?.as_str()?.to_string(),
                                label: o.get("name")?.as_str()?.to_string(),
                                kind: o
                                    .get("kind")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("allow_once")
                                    .to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            let interaction_id = uuid::Uuid::new_v4().to_string();
            let interaction = PendingInteraction::Approval {
                id: interaction_id.clone(),
                thread_id: local_tid.clone(),
                tool_call_id,
                tool_name,
                title,
                command,
                file_path,
                diff: None,
                reason: None,
                input: raw_input,
                options: options.clone(),
            };

            pending_permissions.lock().await.insert(
                interaction_id,
                PendingAcpPermission {
                    rpc_id,
                    local_thread_id: local_tid.clone(),
                    project_path: thread_project.to_string(),
                    options,
                },
            );

            let _ = store
                .mutate_thread(thread_project, &local_tid, |t| {
                    ThreadStore::set_pending_interaction(t, Some(interaction.clone()));
                    t.summary.status = "waiting_input".to_string();
                })
                .await;

            let _ = app.emit(
                "agent-event",
                AgentStreamEvent::InteractionRequested {
                    thread_id: local_tid.clone(),
                    interaction,
                },
            );
            let _ = app.emit(
                "agent-event",
                AgentStreamEvent::TurnStatus {
                    thread_id: local_tid,
                    status: "waiting_input".to_string(),
                    error: None,
                },
            );
        }
        "fs/read_text_file" => {
            let Some(path_str) = params.get("path").and_then(|v| v.as_str()) else {
                send_rpc_error(stdin_tx, rpc_id, -32602, "Missing path");
                return;
            };
            match validate_acp_path(path_str, project_root).await {
                Ok(resolved) => match tokio::fs::read_to_string(&resolved).await {
                    Ok(content) => {
                        let start_line = params.get("line").and_then(|v| v.as_u64()).unwrap_or(1);
                        let limit = params.get("limit").and_then(|v| v.as_u64());
                        let sliced = if start_line > 1 || limit.is_some() {
                            let lines: Vec<&str> = content.lines().collect();
                            let skip = (start_line.saturating_sub(1)) as usize;
                            let take = limit.map(|l| l as usize).unwrap_or(lines.len());
                            lines
                                .into_iter()
                                .skip(skip)
                                .take(take)
                                .collect::<Vec<_>>()
                                .join("\n")
                        } else {
                            content
                        };
                        send_rpc_ok(stdin_tx, rpc_id, json!({ "content": sliced }));
                    }
                    Err(e) => send_rpc_error(stdin_tx, rpc_id, -32000, &e.to_string()),
                },
                Err(e) => send_rpc_error(stdin_tx, rpc_id, -32000, &e),
            }
        }
        "fs/write_text_file" => {
            let Some(path_str) = params.get("path").and_then(|v| v.as_str()) else {
                send_rpc_error(stdin_tx, rpc_id, -32602, "Missing path");
                return;
            };
            let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
            match validate_acp_write_path(path_str, project_root).await {
                Ok(resolved) => {
                    if let Some(parent) = resolved.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    match tokio::fs::write(&resolved, content).await {
                        Ok(_) => send_rpc_ok(stdin_tx, rpc_id, json!({})),
                        Err(e) => send_rpc_error(stdin_tx, rpc_id, -32000, &e.to_string()),
                    }
                }
                Err(e) => send_rpc_error(stdin_tx, rpc_id, -32000, &e),
            }
        }
        "terminal/create" => {
            let command_str = params
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args: Vec<String> = params
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let requested_cwd = params
                .get("cwd")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(project_root);
            let cwd = match validate_acp_path(requested_cwd, project_root).await {
                Ok(valid) => valid.to_string_lossy().to_string(),
                Err(_) => project_root.to_string(),
            };

            let mut cmd = spawn_cli_command(&command_str, &args, &cwd).await;
            cmd.stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            match cmd.spawn() {
                Ok(mut child) => {
                    let tid = uuid::Uuid::new_v4().to_string();
                    let out_buf = Arc::new(Mutex::new(String::new()));
                    let truncated = Arc::new(Mutex::new(false));
                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();
                    let (exit_tx, exit_rx) = watch::channel::<Option<i32>>(None);
                    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

                    if let Some(mut s) = stdout {
                        let buf = out_buf.clone();
                        let trunc = truncated.clone();
                        tokio::spawn(async move {
                            let mut chunk = [0u8; 4096];
                            while let Ok(n) = s.read(&mut chunk).await {
                                if n == 0 {
                                    break;
                                }
                                append_capped_output(
                                    &buf,
                                    &trunc,
                                    &String::from_utf8_lossy(&chunk[..n]),
                                )
                                .await;
                            }
                        });
                    }
                    if let Some(mut s) = stderr {
                        let buf = out_buf.clone();
                        let trunc = truncated.clone();
                        tokio::spawn(async move {
                            let mut chunk = [0u8; 4096];
                            while let Ok(n) = s.read(&mut chunk).await {
                                if n == 0 {
                                    break;
                                }
                                append_capped_output(
                                    &buf,
                                    &trunc,
                                    &String::from_utf8_lossy(&chunk[..n]),
                                )
                                .await;
                            }
                        });
                    }

                    // Exclusive ownership of `child` inside the wait task eliminates
                    // mutex deadlocks between `wait()` and `terminal/kill`.
                    tokio::spawn(async move {
                        let code = tokio::select! {
                            status = child.wait() => {
                                status.ok().and_then(|s| s.code()).unwrap_or(0)
                            }
                            _ = &mut kill_rx => {
                                let _ = child.kill().await;
                                let _ = child.wait().await;
                                -1
                            }
                        };
                        let _ = exit_tx.send(Some(code));
                    });

                    terminals.lock().await.insert(
                        tid.clone(),
                        AcpTerminalProcess {
                            output: out_buf,
                            truncated,
                            exit_rx,
                            kill_tx: Arc::new(Mutex::new(Some(kill_tx))),
                        },
                    );
                    send_rpc_ok(stdin_tx, rpc_id, json!({ "terminalId": tid }));
                }
                Err(e) => send_rpc_error(stdin_tx, rpc_id, -32000, &e.to_string()),
            }
        }
        "terminal/output" => {
            let tid = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(term) = terminals.lock().await.get(tid) {
                let output = term.output.lock().await.clone();
                let is_truncated = *term.truncated.lock().await;
                let code = *term.exit_rx.borrow();
                let mut payload = serde_json::Map::new();
                payload.insert("output".to_string(), json!(output));
                payload.insert("truncated".to_string(), json!(is_truncated));
                if let Some(c) = code {
                    payload.insert("exitStatus".to_string(), json!({ "exitCode": c }));
                }
                send_rpc_ok(stdin_tx, rpc_id, Value::Object(payload));
            } else {
                send_rpc_error(stdin_tx, rpc_id, -32000, "Terminal not found");
            }
        }
        "terminal/wait_for_exit" => {
            let tid = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let exit_rx_opt = terminals.lock().await.get(&tid).map(|t| t.exit_rx.clone());
            if let Some(mut exit_rx) = exit_rx_opt {
                if let Some(c) = *exit_rx.borrow() {
                    send_rpc_ok(stdin_tx, rpc_id, json!({ "exitCode": c }));
                    return;
                }
                // Spawn wait off the stdout reader task so ACP stream never stalls
                let tx_clone = stdin_tx.clone();
                tokio::spawn(async move {
                    let wait_res = timeout(Duration::from_secs(60), async {
                        loop {
                            if let Some(c) = *exit_rx.borrow() {
                                return Some(c);
                            }
                            if exit_rx.changed().await.is_err() {
                                return *exit_rx.borrow();
                            }
                        }
                    })
                    .await;
                    match wait_res {
                        Ok(Some(c)) => send_rpc_ok(&tx_clone, rpc_id, json!({ "exitCode": c })),
                        Ok(None) => send_rpc_error(
                            &tx_clone,
                            rpc_id,
                            -32000,
                            "Terminal closed unexpectedly",
                        ),
                        Err(_) => send_rpc_error(
                            &tx_clone,
                            rpc_id,
                            -32000,
                            "Timed out waiting for terminal",
                        ),
                    }
                });
            } else {
                send_rpc_error(stdin_tx, rpc_id, -32000, "Terminal not found");
            }
        }
        "terminal/kill" => {
            let tid = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let kill_tx_arc = terminals.lock().await.get(tid).map(|t| t.kill_tx.clone());
            if let Some(arc) = kill_tx_arc {
                if let Some(tx) = arc.lock().await.take() {
                    let _ = tx.send(());
                }
            }
            send_rpc_ok(stdin_tx, rpc_id, json!({}));
        }
        "terminal/release" => {
            let tid = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(term) = terminals.lock().await.remove(tid) {
                if let Some(tx) = term.kill_tx.lock().await.take() {
                    let _ = tx.send(());
                }
            }
            send_rpc_ok(stdin_tx, rpc_id, json!({}));
        }
        _ => {
            send_rpc_error(
                stdin_tx,
                rpc_id,
                -32601,
                &format!("Unsupported method: {}", method),
            );
        }
    }
}

async fn append_capped_output(buf: &Arc<Mutex<String>>, truncated: &Arc<Mutex<bool>>, chunk: &str) {
    let mut guard = buf.lock().await;
    if guard.len() >= MAX_ACP_TERMINAL_OUTPUT_BYTES {
        *truncated.lock().await = true;
        return;
    }
    let remaining = MAX_ACP_TERMINAL_OUTPUT_BYTES - guard.len();
    if chunk.len() <= remaining {
        guard.push_str(chunk);
    } else {
        let mut end = remaining;
        while end > 0 && !chunk.is_char_boundary(end) {
            end -= 1;
        }
        guard.push_str(&chunk[..end]);
        *truncated.lock().await = true;
    }
}

async fn validate_acp_path(path_str: &str, project_root: &str) -> Result<PathBuf, String> {
    let canonical_root = tokio::fs::canonicalize(project_root)
        .await
        .map_err(|e| e.to_string())?;
    let target = if Path::new(path_str).is_absolute() {
        PathBuf::from(path_str)
    } else {
        canonical_root.join(path_str)
    };
    let canonical_target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("Access denied: path outside project root".to_string());
    }
    Ok(canonical_target)
}

async fn validate_acp_write_path(path_str: &str, project_root: &str) -> Result<PathBuf, String> {
    let canonical_root = tokio::fs::canonicalize(project_root)
        .await
        .map_err(|e| e.to_string())?;
    let target = if Path::new(path_str).is_absolute() {
        PathBuf::from(path_str)
    } else {
        canonical_root.join(path_str)
    };
    let mut ancestor = target.clone();
    while !tokio::fs::try_exists(&ancestor).await.unwrap_or(false) {
        match ancestor.parent() {
            Some(p) => ancestor = p.to_path_buf(),
            None => return Err("Invalid path".to_string()),
        }
    }
    let canonical_ancestor = tokio::fs::canonicalize(&ancestor)
        .await
        .map_err(|e| e.to_string())?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err("Access denied: write outside project root".to_string());
    }
    Ok(target)
}

fn send_rpc_ok(stdin_tx: &mpsc::UnboundedSender<String>, id: Value, result: Value) {
    if let Ok(line) = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })) {
        let _ = stdin_tx.send(line);
    }
}

fn send_rpc_error(stdin_tx: &mpsc::UnboundedSender<String>, id: Value, code: i64, message: &str) {
    if let Ok(line) = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })) {
        let _ = stdin_tx.send(line);
    }
}

fn extract_acp_content_text(content: Option<&Value>) -> String {
    let Some(val) = content else {
        return String::new();
    };
    if let Some(s) = val.get("text").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(arr) = val.as_array() {
        return arr
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

pub fn parse_acp_tool_call(update: &Value) -> Option<AgentPart> {
    let call_id = update.get("toolCallId")?.as_str()?.to_string();
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("other")
        .to_string();
    let raw_status = update
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending");
    let status = match raw_status {
        "in_progress" | "running" => "running",
        "completed" => "completed",
        "failed" | "error" => "error",
        _ => "pending",
    }
    .to_string();

    let input = update.get("rawInput").cloned().unwrap_or_else(|| json!({}));
    let output_val = update.get("rawOutput");
    let mut output = output_val.map(|v| {
        if let Some(s) = v.as_str() {
            s.to_string()
        } else {
            serde_json::to_string_pretty(v).unwrap_or_default()
        }
    });

    let mut diff: Option<String> = None;
    let mut file_path = update
        .get("locations")
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
        .and_then(|loc| loc.get("path"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    if let Some(content_arr) = update.get("content").and_then(|c| c.as_array()) {
        for c in content_arr {
            let ctype = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if ctype == "diff" {
                if file_path.is_none() {
                    file_path = c
                        .get("path")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                let old_t = c.get("oldText").and_then(|v| v.as_str()).unwrap_or("");
                let new_t = c.get("newText").and_then(|v| v.as_str()).unwrap_or("");
                diff = Some(format!("--- before\n{}\n+++ after\n{}", old_t, new_t));
            } else if output.is_none() {
                let txt = extract_acp_content_text(c.get("content"));
                if !txt.is_empty() {
                    output = Some(txt);
                }
            }
        }
    }

    let tool = match kind.as_str() {
        "read" => "read",
        "edit" => "edit",
        "delete" => "delete",
        "execute" | "terminal" => "bash",
        "search" => "grep",
        "fetch" => "webfetch",
        other => other,
    }
    .to_string();

    Some(AgentPart::Tool {
        id: format!("tool_{}", call_id),
        call_id,
        tool,
        title,
        status: status.clone(),
        input,
        output: if status == "error" {
            None
        } else {
            output.clone()
        },
        error: if status == "error" { output } else { None },
        file_path,
        diff,
        parent_tool_call_id: None,
    })
}

pub fn parse_acp_plan(update: &Value) -> Option<Vec<PlanTaskItem>> {
    let entries = update
        .get("entries")
        .or_else(|| update.get("steps"))
        .and_then(|v| v.as_array())?;
    let items: Vec<PlanTaskItem> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let content = e
                .get("content")
                .or_else(|| e.get("title"))
                .or_else(|| e.get("step"))
                .and_then(|v| v.as_str())?
                .to_string();
            let status = e
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending")
                .to_string();
            let id = e
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("acp_step_{}", i));
            let priority = e
                .get("priority")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(PlanTaskItem {
                id,
                content,
                status,
                priority,
            })
        })
        .collect();
    Some(items)
}

pub fn parse_acp_usage(update: &Value) -> Option<TokenUsageSnapshot> {
    let used = update.get("used").and_then(|v| v.as_u64()).unwrap_or(0);
    let size = update.get("size").and_then(|v| v.as_u64());
    let input_tokens = update
        .get("inputTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(used);
    let output_tokens = update
        .get("outputTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cost = update.get("cost").and_then(|c| {
        c.as_f64()
            .or_else(|| c.get("amount").and_then(|a| a.as_f64()))
    });

    Some(TokenUsageSnapshot {
        input_tokens,
        output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        context_used_tokens: used.max(input_tokens),
        context_window_tokens: size,
        total_cost_usd: cost,
        model_usage: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_acp_usage_update() {
        let u = json!({
            "sessionUpdate": "usage_update",
            "used": 14500,
            "size": 1000000,
            "cost": { "amount": 0.015, "currency": "USD" }
        });
        let snap = parse_acp_usage(&u).unwrap();
        assert_eq!(snap.context_used_tokens, 14500);
        assert_eq!(snap.context_window_tokens, Some(1000000));
        assert!((snap.total_cost_usd.unwrap() - 0.015).abs() < 0.0001);
    }

    #[test]
    fn parses_acp_tool_call_and_plan() {
        let tc = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc_1",
            "title": "Edit main.tex",
            "kind": "edit",
            "status": "completed",
            "locations": [{ "path": "main.tex", "line": 12 }],
            "content": [{ "type": "diff", "path": "main.tex", "oldText": "foo", "newText": "bar" }]
        });
        let part = parse_acp_tool_call(&tc).unwrap();
        match part {
            AgentPart::Tool {
                tool,
                status,
                file_path,
                diff,
                ..
            } => {
                assert_eq!(tool, "edit");
                assert_eq!(status, "completed");
                assert_eq!(file_path.as_deref(), Some("main.tex"));
                assert!(diff.unwrap().contains("+++ after"));
            }
            _ => panic!("expected tool"),
        }

        let pl = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Read paper", "status": "completed", "priority": "high" },
                { "content": "Compile PDF", "status": "in_progress" }
            ]
        });
        let tasks = parse_acp_plan(&pl).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].status, "completed");
    }
}
