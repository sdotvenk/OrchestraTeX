use super::binary::{find_cli_binary, persist_attachment_to_disk, spawn_cli_command};
use super::store::ThreadStore;
use super::types::{
    now_millis, AccountInfo, AgentMessage, AgentPart, AgentProviderId, AgentStreamEvent,
    AgentThread, AttachmentInput, InteractionMode, InteractionResponse, ModelInfo,
    PendingInteraction, PermissionOption, PlanTaskItem, ProviderStatus, QuestionItem,
    QuestionOption, RateLimitWindow, RateLimitsSnapshot, RuntimeMode, TokenUsageSnapshot,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone)]
enum PendingCodexKind {
    UserInput,
    CommandApproval,
    FileChangeApproval,
}

#[derive(Debug, Clone)]
struct PendingCodexServerRequest {
    rpc_id: Value,
    kind: PendingCodexKind,
    #[allow(dead_code)]
    local_thread_id: String,
    #[allow(dead_code)]
    project_path: String,
}

#[derive(Clone)]
pub struct CodexClient {
    stdin_tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicU64>,
    pending_rpc: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    child: Arc<Mutex<Option<Child>>>,
    codex_to_local: Arc<Mutex<HashMap<String, (String, String)>>>,
    active_turns: Arc<Mutex<HashMap<String, String>>>,
    active_assistant_msgs: Arc<Mutex<HashMap<String, (String, String, String)>>>,
    pending_server_requests: Arc<Mutex<HashMap<String, PendingCodexServerRequest>>>,
    rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
}

impl CodexClient {
    pub async fn spawn(
        app: AppHandle,
        store: Arc<ThreadStore>,
        rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
        binary_path: &str,
    ) -> Result<Self, String> {
        let args = vec!["app-server".to_string(), "--stdio".to_string()];
        let mut cmd = spawn_cli_command(binary_path, &args, "").await;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Codex app-server: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Missing Codex stdin")?;
        let stdout = child.stdout.take().ok_or("Missing Codex stdout")?;
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

        let pending_rpc = Arc::new(Mutex::new(
            HashMap::<u64, oneshot::Sender<Result<Value, String>>>::new(),
        ));
        let child_arc = Arc::new(Mutex::new(Some(child)));
        let codex_to_local = Arc::new(Mutex::new(HashMap::<String, (String, String)>::new()));
        let active_turns = Arc::new(Mutex::new(HashMap::<String, String>::new()));
        let active_assistant_msgs =
            Arc::new(Mutex::new(HashMap::<String, (String, String, String)>::new()));
        let pending_server_requests =
            Arc::new(Mutex::new(HashMap::<String, PendingCodexServerRequest>::new()));

        let client = Self {
            stdin_tx: stdin_tx.clone(),
            next_id: Arc::new(AtomicU64::new(1)),
            pending_rpc: pending_rpc.clone(),
            child: child_arc.clone(),
            codex_to_local: codex_to_local.clone(),
            active_turns: active_turns.clone(),
            active_assistant_msgs: active_assistant_msgs.clone(),
            pending_server_requests: pending_server_requests.clone(),
            rate_limit_cache: rate_limit_cache.clone(),
        };

        if let Some(stderr) = stderr {
            let app_err = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "agent-event",
                        AgentStreamEvent::ProviderLog {
                            provider_id: AgentProviderId::Codex,
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
        let client_for_reader = client.clone();
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
                                    .unwrap_or("Codex RPC error")
                                    .to_string();
                                let _ = tx.send(Err(err_msg));
                            } else {
                                let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                    continue;
                }

                let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                let params = msg.get("params").cloned().unwrap_or(Value::Null);

                if has_method && !has_id {
                    handle_codex_notification(
                        &app_out,
                        &store_out,
                        &client_for_reader,
                        method,
                        &params,
                    )
                    .await;
                    continue;
                }

                if has_method && has_id {
                    let rpc_id = msg.get("id").cloned().unwrap_or(Value::Null);
                    handle_codex_server_request(
                        &app_out,
                        &store_out,
                        &client_for_reader,
                        method,
                        rpc_id,
                        &params,
                    )
                    .await;
                }
            }

            let mut guard = pending_rpc.lock().await;
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err("Codex app-server exited".to_string()));
            }
        });

        // Initialize handshake
        client
            .rpc_call(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "lmms-lab-writer",
                        "version": "0.1.3"
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;

        client.send_notification("initialized", json!({}))?;
        Ok(client)
    }

    pub async fn is_alive(&self) -> bool {
        let mut guard = self.child.lock().await;
        match guard.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
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
            return Err("Codex stdin channel closed".to_string());
        }

        timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| format!("Codex RPC '{}' timed out", method))?
            .map_err(|_| "Codex RPC channel dropped".to_string())?
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
            .map_err(|_| "Codex stdin channel closed".to_string())
    }

    pub fn send_rpc_result(&self, rpc_id: Value, result: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "result": result,
        });
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(line)
            .map_err(|_| "Codex stdin channel closed".to_string())
    }

    pub async fn read_rate_limits(&self) -> Result<RateLimitsSnapshot, String> {
        let res = self.rpc_call("account/rateLimits/read", json!({})).await?;
        let existing = self
            .rate_limit_cache
            .lock()
            .await
            .get(&AgentProviderId::Codex)
            .cloned();
        let snapshot = parse_codex_rate_limits(&res, existing.as_ref())
            .ok_or_else(|| "Failed to parse Codex rate limits".to_string())?;
        self.rate_limit_cache
            .lock()
            .await
            .insert(AgentProviderId::Codex, snapshot.clone());
        Ok(snapshot)
    }

    pub async fn ensure_thread(
        &self,
        app: &AppHandle,
        store: &ThreadStore,
        thread: &AgentThread,
    ) -> Result<String, String> {
        let approval_policy = map_codex_approval_policy(thread.summary.runtime_mode);
        let sandbox_mode =
            map_codex_sandbox_mode(thread.summary.interaction_mode, thread.summary.runtime_mode);

        if let Some(ref codex_tid) = thread.summary.provider_session_id {
            let already_mapped = self.codex_to_local.lock().await.contains_key(codex_tid);
            if already_mapped {
                return Ok(codex_tid.clone());
            }
            self.codex_to_local.lock().await.insert(
                codex_tid.clone(),
                (
                    thread.summary.id.clone(),
                    thread.summary.project_path.clone(),
                ),
            );
            let resume_res = self
                .rpc_call(
                    "thread/resume",
                    json!({
                        "threadId": codex_tid,
                        "cwd": thread.summary.project_path,
                        "model": thread.summary.model,
                        "approvalPolicy": approval_policy,
                        "sandbox": sandbox_mode,
                        "excludeTurns": true,
                    }),
                )
                .await;
            if resume_res.is_ok() {
                return Ok(codex_tid.clone());
            }
        }

        let res = self
            .rpc_call(
                "thread/start",
                json!({
                    "cwd": thread.summary.project_path,
                    "model": thread.summary.model,
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox_mode,
                    "ephemeral": false,
                }),
            )
            .await?;

        let codex_tid = res
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Codex thread/start missing thread.id".to_string())?
            .to_string();

        self.codex_to_local.lock().await.insert(
            codex_tid.clone(),
            (
                thread.summary.id.clone(),
                thread.summary.project_path.clone(),
            ),
        );

        if let Ok(Some(updated)) = store
            .mutate_thread(&thread.summary.project_path, &thread.summary.id, |t| {
                t.summary.provider_session_id = Some(codex_tid.clone());
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

        Ok(codex_tid)
    }

    pub async fn start_turn(
        &self,
        app: &AppHandle,
        store: &ThreadStore,
        thread: &AgentThread,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<(), String> {
        let codex_tid = self.ensure_thread(app, store, thread).await?;
        let input = build_codex_user_input(app, text, attachments).await;

        let approval_policy = map_codex_approval_policy(thread.summary.runtime_mode);
        let sandbox_policy = map_codex_sandbox_policy(
            thread.summary.interaction_mode,
            thread.summary.runtime_mode,
            &thread.summary.project_path,
        );

        let mut params = serde_json::Map::new();
        params.insert("threadId".to_string(), json!(codex_tid));
        params.insert("input".to_string(), Value::Array(input));
        params.insert("approvalPolicy".to_string(), json!(approval_policy));
        params.insert("sandboxPolicy".to_string(), sandbox_policy);
        if let Some(ref model) = thread.summary.model {
            if !model.trim().is_empty() {
                params.insert("model".to_string(), json!(model));
            }
        }
        if let Some(ref effort) = thread.summary.reasoning_effort {
            if !effort.trim().is_empty() {
                params.insert("effort".to_string(), json!(effort));
            }
        }
        if thread.summary.interaction_mode == InteractionMode::Plan {
            let model_name = thread
                .summary
                .model
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "gpt-6.2-sol".to_string());
            params.insert(
                "collaborationMode".to_string(),
                json!({
                    "mode": "plan",
                    "settings": {
                        "model": model_name,
                        "reasoning_effort": thread.summary.reasoning_effort,
                        "developer_instructions": null,
                    }
                }),
            );
        }

        let res = self.rpc_call("turn/start", Value::Object(params)).await?;
        if let Some(turn_id) = res
            .get("turn")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
        {
            self.active_turns
                .lock()
                .await
                .insert(codex_tid, turn_id.to_string());
            ensure_codex_assistant_msg(
                app,
                store,
                &self.active_assistant_msgs,
                turn_id,
                &thread.summary.id,
                &thread.summary.project_path,
                thread.summary.model.clone(),
            )
            .await;
        }
        Ok(())
    }

    pub async fn steer_turn(
        &self,
        app: &AppHandle,
        thread: &AgentThread,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<(), String> {
        let Some(ref codex_tid) = thread.summary.provider_session_id else {
            return Err("No active Codex session for thread".to_string());
        };
        let expected_turn_id = self
            .active_turns
            .lock()
            .await
            .get(codex_tid)
            .cloned()
            .ok_or_else(|| "No active Codex turn to steer".to_string())?;
        let input = build_codex_user_input(app, text, attachments).await;
        self.rpc_call(
            "turn/steer",
            json!({
                "threadId": codex_tid,
                "expectedTurnId": expected_turn_id,
                "input": input,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn interrupt_turn(&self, thread: &AgentThread) -> Result<(), String> {
        let Some(ref codex_tid) = thread.summary.provider_session_id else {
            return Ok(());
        };
        let Some(turn_id) = self.active_turns.lock().await.get(codex_tid).cloned() else {
            return Ok(());
        };
        self.rpc_call(
            "turn/interrupt",
            json!({
                "threadId": codex_tid,
                "turnId": turn_id,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn fork_thread(&self, source_codex_tid: &str) -> Result<String, String> {
        let res = self
            .rpc_call(
                "thread/fork",
                json!({
                    "threadId": source_codex_tid,
                }),
            )
            .await?;
        res.get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Codex thread/fork missing thread.id".to_string())
    }

    pub async fn compact_thread(&self, codex_tid: &str) -> Result<(), String> {
        self.rpc_call("thread/compact/start", json!({ "threadId": codex_tid }))
            .await?;
        Ok(())
    }

    pub async fn respond_interaction(
        &self,
        interaction_id: &str,
        response: &InteractionResponse,
    ) -> Result<(), String> {
        let pending = self
            .pending_server_requests
            .lock()
            .await
            .remove(interaction_id)
            .ok_or_else(|| format!("Pending Codex interaction '{}' not found", interaction_id))?;

        let result_payload = match (&pending.kind, response) {
            (
                PendingCodexKind::UserInput,
                InteractionResponse::QuestionAnswer { answers, dismissed },
            ) => {
                if *dismissed {
                    json!({ "answers": {} })
                } else {
                    let mut map = serde_json::Map::new();
                    for (qid, ans_list) in answers {
                        map.insert(qid.clone(), json!({ "answers": ans_list }));
                    }
                    json!({ "answers": Value::Object(map) })
                }
            }
            (
                PendingCodexKind::CommandApproval | PendingCodexKind::FileChangeApproval,
                InteractionResponse::ApprovalDecision { decision, .. },
            ) => {
                let codex_dec = match decision.as_str() {
                    "allow_once" => "accept",
                    "allow_session" => "acceptForSession",
                    _ => "decline",
                };
                json!({ "decision": codex_dec })
            }
            _ => return Err("Mismatched Codex interaction response".to_string()),
        };

        self.send_rpc_result(pending.rpc_id, result_payload)
    }

    pub async fn kill(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }
}

async fn build_codex_user_input(
    app: &AppHandle,
    text: &str,
    attachments: &[AttachmentInput],
) -> Vec<Value> {
    let mut items = Vec::new();
    for att in attachments {
        if let Ok((disk_path, _, _)) = persist_attachment_to_disk(app, att).await {
            items.push(json!({
                "type": "localImage",
                "path": disk_path,
            }));
        }
    }
    if !text.trim().is_empty() || items.is_empty() {
        items.push(json!({
            "type": "text",
            "text": text,
        }));
    }
    items
}

fn map_codex_approval_policy(runtime_mode: RuntimeMode) -> &'static str {
    match runtime_mode {
        RuntimeMode::ApprovalRequired => "untrusted",
        RuntimeMode::AutoAcceptEdits => "on-request",
        RuntimeMode::FullAccess => "never",
    }
}

fn map_codex_sandbox_mode(
    interaction_mode: InteractionMode,
    runtime_mode: RuntimeMode,
) -> &'static str {
    if interaction_mode == InteractionMode::Plan {
        return "read-only";
    }
    match runtime_mode {
        RuntimeMode::FullAccess => "danger-full-access",
        _ => "workspace-write",
    }
}

fn map_codex_sandbox_policy(
    interaction_mode: InteractionMode,
    runtime_mode: RuntimeMode,
    project_path: &str,
) -> Value {
    if interaction_mode == InteractionMode::Plan {
        return json!({ "type": "readOnly" });
    }
    match runtime_mode {
        RuntimeMode::FullAccess => json!({ "type": "dangerFullAccess" }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [project_path],
        }),
    }
}

pub async fn probe_codex(
    app: AppHandle,
    store: Arc<ThreadStore>,
    rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
    client_slot: Arc<Mutex<Option<CodexClient>>>,
    custom_path: Option<&str>,
) -> ProviderStatus {
    let binary = find_cli_binary(&["codex"], custom_path).await;
    let Some(bin_path) = binary else {
        let cached = rate_limit_cache
            .lock()
            .await
            .get(&AgentProviderId::Codex)
            .cloned();
        return ProviderStatus {
            id: AgentProviderId::Codex,
            name: AgentProviderId::Codex.display_name().to_string(),
            transport: "app-server".to_string(),
            installed: false,
            binary_path: None,
            version: None,
            authenticated: false,
            auth_error: Some("Codex CLI ('codex') not found in PATH.".to_string()),
            login_command: AgentProviderId::Codex.login_command().to_string(),
            account: None,
            models: Vec::new(),
            commands: Vec::new(),
            rate_limits: cached,
            supports_steer: true,
            supports_fork: true,
            supports_compact: true,
            supports_questions: true,
        };
    };

    let version = timeout(Duration::from_secs(3), async {
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

    let client = match ensure_codex_client(
        app,
        store,
        rate_limit_cache.clone(),
        client_slot,
        &bin_path,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderStatus {
                id: AgentProviderId::Codex,
                name: AgentProviderId::Codex.display_name().to_string(),
                transport: "app-server".to_string(),
                installed: true,
                binary_path: Some(bin_path),
                version,
                authenticated: false,
                auth_error: Some(e),
                login_command: AgentProviderId::Codex.login_command().to_string(),
                account: None,
                models: Vec::new(),
                commands: Vec::new(),
                rate_limits: None,
                supports_steer: true,
                supports_fork: true,
                supports_compact: true,
                supports_questions: true,
            };
        }
    };

    let (acc_res, models_res, rl_res) = tokio::join!(
        client.rpc_call("account/read", json!({})),
        client.rpc_call("model/list", json!({})),
        client.read_rate_limits(),
    );

    let mut authenticated = false;
    let mut auth_error: Option<String> = None;
    let mut account: Option<AccountInfo> = None;

    if let Ok(acc_val) = acc_res {
        if let Some(acc) = acc_val.get("account").filter(|a| !a.is_null()) {
            authenticated = true;
            account = Some(AccountInfo {
                email: acc
                    .get("email")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                organization: acc
                    .get("workspaceName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                plan_type: acc
                    .get("planType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                subscription_type: acc
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                api_provider: Some("openai".to_string()),
            });
        } else {
            let requires_auth = acc_val
                .get("requiresOpenaiAuth")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            authenticated = !requires_auth;
            if !authenticated {
                auth_error = Some("Not signed in to Codex. Run `codex login`.".to_string());
            }
        }
    } else {
        auth_error = Some("Failed to read Codex account status.".to_string());
    }

    let mut models = Vec::new();
    if let Ok(m_val) = models_res {
        if let Some(arr) = m_val.get("data").and_then(|v| v.as_array()) {
            for m in arr {
                if m.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false) {
                    continue;
                }
                if let Some(parsed) = parse_codex_model_info(m) {
                    models.push(parsed);
                }
            }
        }
    }

    let rate_limits = match rl_res {
        Ok(rl) => Some(rl),
        Err(_) => rate_limit_cache
            .lock()
            .await
            .get(&AgentProviderId::Codex)
            .cloned(),
    };

    ProviderStatus {
        id: AgentProviderId::Codex,
        name: AgentProviderId::Codex.display_name().to_string(),
        transport: "app-server".to_string(),
        installed: true,
        binary_path: Some(bin_path),
        version,
        authenticated,
        auth_error,
        login_command: AgentProviderId::Codex.login_command().to_string(),
        account,
        models,
        commands: Vec::new(),
        rate_limits,
        supports_steer: true,
        supports_fork: true,
        supports_compact: true,
        supports_questions: true,
    }
}

pub async fn ensure_codex_client(
    app: AppHandle,
    store: Arc<ThreadStore>,
    rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
    client_slot: Arc<Mutex<Option<CodexClient>>>,
    binary_path: &str,
) -> Result<CodexClient, String> {
    let mut guard = client_slot.lock().await;
    if let Some(ref existing) = *guard {
        if existing.is_alive().await {
            return Ok(existing.clone());
        }
    }
    let spawned = CodexClient::spawn(app, store, rate_limit_cache, binary_path).await?;
    *guard = Some(spawned.clone());
    Ok(spawned)
}

fn parse_codex_model_info(m: &Value) -> Option<ModelInfo> {
    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
    let name = m
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let levels = m
        .get("supportedReasoningEfforts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    e.get("reasoningEffort")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ModelInfo {
        id,
        name,
        description: m
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        supports_effort: !levels.is_empty(),
        supported_effort_levels: levels,
        default_effort: m
            .get("defaultReasoningEffort")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        supports_fast_mode: m
            .get("additionalSpeedTiers")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        is_default: m
            .get("isDefault")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        context_window: None,
    })
}

async fn ensure_codex_assistant_msg(
    app: &AppHandle,
    store: &ThreadStore,
    active_msgs: &Arc<Mutex<HashMap<String, (String, String, String)>>>,
    turn_id: &str,
    local_tid: &str,
    project_path: &str,
    model: Option<String>,
) -> String {
    {
        let guard = active_msgs.lock().await;
        if let Some((msg_id, _, _)) = guard.get(turn_id) {
            return msg_id.clone();
        }
    }
    let msg_id = uuid::Uuid::new_v4().to_string();
    let msg = AgentMessage {
        id: msg_id.clone(),
        role: "assistant".to_string(),
        created_at: now_millis(),
        completed_at: None,
        provider_id: Some(AgentProviderId::Codex),
        model,
        parts: Vec::new(),
        changed_files: Vec::new(),
        error: None,
    };
    let _ = store
        .mutate_thread(project_path, local_tid, |t| {
            ThreadStore::append_message_to_thread(t, msg.clone());
            t.summary.status = "running".to_string();
        })
        .await;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::MessageAdded {
            thread_id: local_tid.to_string(),
            message: msg,
        },
    );
    active_msgs.lock().await.insert(
        turn_id.to_string(),
        (
            msg_id.clone(),
            local_tid.to_string(),
            project_path.to_string(),
        ),
    );
    msg_id
}

async fn handle_codex_notification(
    app: &AppHandle,
    store: &ThreadStore,
    client: &CodexClient,
    method: &str,
    params: &Value,
) {
    match method {
        "account/rateLimits/updated" => {
            let existing = client
                .rate_limit_cache
                .lock()
                .await
                .get(&AgentProviderId::Codex)
                .cloned();
            if let Some(snapshot) = parse_codex_rate_limits(params, existing.as_ref()) {
                client
                    .rate_limit_cache
                    .lock()
                    .await
                    .insert(AgentProviderId::Codex, snapshot.clone());
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::RateLimitsUpdated {
                        provider_id: AgentProviderId::Codex,
                        rate_limits: snapshot,
                    },
                );
            }
        }
        "turn/started" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            let turn_id = params
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some((local_tid, project_path)) =
                client.codex_to_local.lock().await.get(codex_tid).cloned()
            {
                if !turn_id.is_empty() {
                    client
                        .active_turns
                        .lock()
                        .await
                        .insert(codex_tid.to_string(), turn_id.to_string());
                    ensure_codex_assistant_msg(
                        app,
                        store,
                        &client.active_assistant_msgs,
                        turn_id,
                        &local_tid,
                        &project_path,
                        None,
                    )
                    .await;
                }
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::TurnStatus {
                        thread_id: local_tid,
                        status: "running".to_string(),
                        error: None,
                    },
                );
            }
        }
        "turn/completed" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let turn_id = turn.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let status_str = turn
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let err_msg = turn
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            client.active_turns.lock().await.remove(codex_tid);
            let msg_entry = client.active_assistant_msgs.lock().await.remove(turn_id);
            let mapping = client.codex_to_local.lock().await.get(codex_tid).cloned();

            if let Some((local_tid, project_path)) = mapping {
                let final_status = if status_str == "failed" {
                    "error"
                } else {
                    "idle"
                };
                let _ = store
                    .mutate_thread(&project_path, &local_tid, |t| {
                        t.summary.status = final_status.to_string();
                        ThreadStore::set_pending_interaction(t, None);
                        if let Some((ref mid, _, _)) = msg_entry {
                            if let Some(m) = t.messages.iter_mut().find(|m| m.id == *mid) {
                                m.completed_at = Some(now_millis());
                                if let Some(ref em) = err_msg {
                                    m.error = Some(em.clone());
                                }
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

                // Refresh rate limits in background after turn finishes
                let client_rl = client.clone();
                let app_rl = app.clone();
                tokio::spawn(async move {
                    if let Ok(snapshot) = client_rl.read_rate_limits().await {
                        let _ = app_rl.emit(
                            "agent-event",
                            AgentStreamEvent::RateLimitsUpdated {
                                provider_id: AgentProviderId::Codex,
                                rate_limits: snapshot,
                            },
                        );
                    }
                });
            }
        }
        "thread/tokenUsage/updated" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            if let Some((local_tid, project_path)) =
                client.codex_to_local.lock().await.get(codex_tid).cloned()
            {
                if let Some(usage) = parse_codex_token_usage(params.get("tokenUsage")) {
                    let _ = store
                        .mutate_thread(&project_path, &local_tid, |t| {
                            ThreadStore::set_usage(t, usage.clone());
                        })
                        .await;
                    let _ = app.emit(
                        "agent-event",
                        AgentStreamEvent::TokenUsageUpdated {
                            thread_id: local_tid,
                            usage,
                        },
                    );
                }
            }
        }
        "turn/plan/updated" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            if let Some((local_tid, project_path)) =
                client.codex_to_local.lock().await.get(codex_tid).cloned()
            {
                if let Some(tasks) = parse_codex_plan_steps(params.get("plan")) {
                    let _ = store
                        .mutate_thread(&project_path, &local_tid, |t| {
                            ThreadStore::set_tasks(t, tasks.clone());
                        })
                        .await;
                    let _ = app.emit(
                        "agent-event",
                        AgentStreamEvent::PlanUpdated {
                            thread_id: local_tid,
                            tasks,
                        },
                    );
                }
            }
        }
        "item/started" | "item/completed" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            let turn_id = params.get("turnId").and_then(|v| v.as_str()).unwrap_or("");
            let Some(item) = params.get("item") else {
                return;
            };
            let Some((local_tid, project_path)) =
                client.codex_to_local.lock().await.get(codex_tid).cloned()
            else {
                return;
            };
            let msg_id = ensure_codex_assistant_msg(
                app,
                store,
                &client.active_assistant_msgs,
                turn_id,
                &local_tid,
                &project_path,
                None,
            )
            .await;

            let is_completed = method == "item/completed";
            if let Some((part, changed_files)) = parse_codex_thread_item(item, is_completed) {
                let _ = store
                    .mutate_thread(&project_path, &local_tid, |t| {
                        ThreadStore::upsert_part_in_thread(t, &msg_id, part.clone());
                        if !changed_files.is_empty() {
                            if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                                for cf in &changed_files {
                                    if !m.changed_files.contains(cf) {
                                        m.changed_files.push(cf.clone());
                                    }
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
        "item/agentMessage/delta" => {
            emit_codex_delta(app, store, client, params, "text").await;
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            emit_codex_delta(app, store, client, params, "reasoning").await;
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            emit_codex_delta(app, store, client, params, "tool_output").await;
        }
        "error" => {
            let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            let will_retry = params
                .get("willRetry")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let err_msg = params
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Codex error")
                .to_string();
            if let Some((local_tid, _)) = client.codex_to_local.lock().await.get(codex_tid).cloned()
            {
                let _ = app.emit(
                    "agent-event",
                    AgentStreamEvent::TurnStatus {
                        thread_id: local_tid,
                        status: if will_retry { "retry" } else { "error" }.to_string(),
                        error: Some(err_msg),
                    },
                );
            }
        }
        _ => {}
    }
}

async fn emit_codex_delta(
    app: &AppHandle,
    store: &ThreadStore,
    client: &CodexClient,
    params: &Value,
    part_type: &str,
) {
    let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
    let turn_id = params.get("turnId").and_then(|v| v.as_str()).unwrap_or("");
    let item_id = params.get("itemId").and_then(|v| v.as_str()).unwrap_or("");
    let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
    if item_id.is_empty() || delta.is_empty() {
        return;
    }
    let Some((local_tid, project_path)) =
        client.codex_to_local.lock().await.get(codex_tid).cloned()
    else {
        return;
    };
    let msg_id = ensure_codex_assistant_msg(
        app,
        store,
        &client.active_assistant_msgs,
        turn_id,
        &local_tid,
        &project_path,
        None,
    )
    .await;

    let part_id = if part_type == "tool_output" {
        format!("tool_{}", item_id)
    } else {
        item_id.to_string()
    };

    let _ = store
        .mutate_thread_memory(&project_path, &local_tid, |t| {
            ThreadStore::append_delta_in_thread(t, &msg_id, &part_id, part_type, delta);
        })
        .await;

    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::PartDelta {
            thread_id: local_tid,
            message_id: msg_id,
            part_id,
            part_type: part_type.to_string(),
            delta: delta.to_string(),
        },
    );
}

async fn handle_codex_server_request(
    app: &AppHandle,
    store: &ThreadStore,
    client: &CodexClient,
    method: &str,
    rpc_id: Value,
    params: &Value,
) {
    let codex_tid = params.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
    let Some((local_tid, project_path)) =
        client.codex_to_local.lock().await.get(codex_tid).cloned()
    else {
        return;
    };

    match method {
        "item/tool/requestUserInput" => {
            if let Some((interaction_id, interaction)) =
                parse_codex_user_input_request(params, &local_tid)
            {
                client.pending_server_requests.lock().await.insert(
                    interaction_id,
                    PendingCodexServerRequest {
                        rpc_id,
                        kind: PendingCodexKind::UserInput,
                        local_thread_id: local_tid.clone(),
                        project_path: project_path.clone(),
                    },
                );
                let _ = store
                    .mutate_thread(&project_path, &local_tid, |t| {
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
        }
        "item/commandExecution/requestApproval" => {
            let interaction_id = uuid::Uuid::new_v4().to_string();
            let command_str = params
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let tool_call_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let interaction = PendingInteraction::Approval {
                id: interaction_id.clone(),
                thread_id: local_tid.clone(),
                tool_call_id,
                tool_name: "bash".to_string(),
                title: "Approve Command Execution".to_string(),
                command: command_str,
                file_path: None,
                diff: None,
                reason,
                input: params.clone(),
                options: vec![
                    PermissionOption {
                        id: "allow_once".to_string(),
                        label: "Allow Once".to_string(),
                        kind: "allow_once".to_string(),
                    },
                    PermissionOption {
                        id: "allow_session".to_string(),
                        label: "Allow for Session".to_string(),
                        kind: "allow_always".to_string(),
                    },
                    PermissionOption {
                        id: "deny".to_string(),
                        label: "Deny".to_string(),
                        kind: "reject_once".to_string(),
                    },
                ],
            };
            client.pending_server_requests.lock().await.insert(
                interaction_id,
                PendingCodexServerRequest {
                    rpc_id,
                    kind: PendingCodexKind::CommandApproval,
                    local_thread_id: local_tid.clone(),
                    project_path: project_path.clone(),
                },
            );
            let _ = store
                .mutate_thread(&project_path, &local_tid, |t| {
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
        "item/fileChange/requestApproval" => {
            let interaction_id = uuid::Uuid::new_v4().to_string();
            let file_path = params
                .get("grantRoot")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let tool_call_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let interaction = PendingInteraction::Approval {
                id: interaction_id.clone(),
                thread_id: local_tid.clone(),
                tool_call_id,
                tool_name: "edit".to_string(),
                title: "Approve File Changes".to_string(),
                command: None,
                file_path,
                diff: None,
                reason,
                input: params.clone(),
                options: vec![
                    PermissionOption {
                        id: "allow_once".to_string(),
                        label: "Allow Once".to_string(),
                        kind: "allow_once".to_string(),
                    },
                    PermissionOption {
                        id: "allow_session".to_string(),
                        label: "Allow for Session".to_string(),
                        kind: "allow_always".to_string(),
                    },
                    PermissionOption {
                        id: "deny".to_string(),
                        label: "Deny".to_string(),
                        kind: "reject_once".to_string(),
                    },
                ],
            };
            client.pending_server_requests.lock().await.insert(
                interaction_id,
                PendingCodexServerRequest {
                    rpc_id,
                    kind: PendingCodexKind::FileChangeApproval,
                    local_thread_id: local_tid.clone(),
                    project_path: project_path.clone(),
                },
            );
            let _ = store
                .mutate_thread(&project_path, &local_tid, |t| {
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
        _ => {}
    }
}

pub fn parse_codex_rate_limits(
    val: &Value,
    existing: Option<&RateLimitsSnapshot>,
) -> Option<RateLimitsSnapshot> {
    let rl = val.get("rateLimits").filter(|v| !v.is_null())?;
    let mut windows = Vec::new();

    if let Some(primary) = rl.get("primary").filter(|v| !v.is_null()) {
        let mins = primary.get("windowDurationMins").and_then(|v| v.as_u64());
        let label = match mins {
            Some(300) => "5-hour window".to_string(),
            Some(m) if m >= 1440 => format!("{}-day window", m / 1440),
            Some(m) => format!("{}-min window", m),
            None => "Primary window".to_string(),
        };
        windows.push(RateLimitWindow {
            id: "primary".to_string(),
            label,
            used_percent: primary.get("usedPercent").and_then(|v| v.as_f64()),
            status: None,
            window_duration_mins: mins,
            resets_at: primary.get("resetsAt").and_then(|v| v.as_i64()),
        });
    }

    if let Some(secondary) = rl.get("secondary").filter(|v| !v.is_null()) {
        let mins = secondary.get("windowDurationMins").and_then(|v| v.as_u64());
        let label = match mins {
            Some(10080) => "Weekly limit".to_string(),
            Some(m) if m >= 1440 => format!("{}-day window", m / 1440),
            Some(m) => format!("{}-min window", m),
            None => "Secondary window".to_string(),
        };
        windows.push(RateLimitWindow {
            id: "secondary".to_string(),
            label,
            used_percent: secondary.get("usedPercent").and_then(|v| v.as_f64()),
            status: None,
            window_duration_mins: mins,
            resets_at: secondary.get("resetsAt").and_then(|v| v.as_i64()),
        });
    }

    if windows.is_empty() {
        if let Some(prev) = existing {
            windows = prev.windows.clone();
        }
    }

    let plan_type = rl
        .get("planType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| existing.and_then(|e| e.plan_type.clone()));

    let credits_balance = rl
        .get("credits")
        .and_then(|c| {
            let unlimited = c.get("unlimited").and_then(|v| v.as_bool()).unwrap_or(false);
            if unlimited {
                Some("Unlimited".to_string())
            } else if c.get("hasCredits").and_then(|v| v.as_bool()).unwrap_or(false) {
                c.get("balance").and_then(|b| b.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        })
        .or_else(|| existing.and_then(|e| e.credits_balance.clone()));

    Some(RateLimitsSnapshot {
        provider_id: AgentProviderId::Codex,
        updated_at: now_millis(),
        plan_type,
        windows,
        credits_balance,
        note: None,
    })
}

pub fn parse_codex_token_usage(token_usage: Option<&Value>) -> Option<TokenUsageSnapshot> {
    let tu = token_usage?;
    let total = tu.get("total")?;
    let last = tu.get("last");
    let ctx_window = tu.get("modelContextWindow").and_then(|v| v.as_u64());

    let last_ctx = last
        .map(|l| {
            let total_last = l.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let inp = l.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let cached = l.get("cachedInputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            if total_last > 0 {
                total_last
            } else {
                inp + cached
            }
        })
        .unwrap_or(0);

    Some(TokenUsageSnapshot {
        input_tokens: total.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: total.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_read_tokens: total
            .get("cachedInputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_write_tokens: total
            .get("cacheWriteInputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        reasoning_tokens: total
            .get("reasoningOutputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        context_used_tokens: last_ctx,
        context_window_tokens: ctx_window,
        total_cost_usd: None,
        model_usage: Vec::new(),
    })
}

pub fn parse_codex_plan_steps(plan: Option<&Value>) -> Option<Vec<PlanTaskItem>> {
    let arr = plan?.as_array()?;
    let items: Vec<PlanTaskItem> = arr
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let content = item.get("step")?.as_str()?.to_string();
            let raw_status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending");
            let status = match raw_status {
                "inProgress" | "in_progress" => "in_progress",
                "completed" => "completed",
                "cancelled" => "cancelled",
                _ => "pending",
            }
            .to_string();
            Some(PlanTaskItem {
                id: format!("codex_step_{}", i),
                content,
                status,
                priority: None,
            })
        })
        .collect();
    Some(items)
}

pub fn parse_codex_user_input_request(
    params: &Value,
    local_tid: &str,
) -> Option<(String, PendingInteraction)> {
    let arr = params.get("questions")?.as_array()?;
    let questions: Vec<QuestionItem> = arr
        .iter()
        .filter_map(|q| {
            let id = q.get("id")?.as_str()?.to_string();
            let header = q
                .get("header")
                .and_then(|v| v.as_str())
                .unwrap_or("Question")
                .to_string();
            let question = q.get("question")?.as_str()?.to_string();
            let is_other = q.get("isOther").and_then(|v| v.as_bool()).unwrap_or(false);
            let is_secret = q.get("isSecret").and_then(|v| v.as_bool()).unwrap_or(false);
            let options = q
                .get("options")
                .and_then(|o| o.as_array())
                .map(|opts| {
                    opts.iter()
                        .filter_map(|opt| {
                            Some(QuestionOption {
                                label: opt.get("label")?.as_str()?.to_string(),
                                description: opt
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string()),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(QuestionItem {
                id,
                header,
                question,
                options,
                multi_select: false,
                is_other,
                is_secret,
            })
        })
        .collect();

    let iid = uuid::Uuid::new_v4().to_string();
    let tool_call_id = params
        .get("itemId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some((
        iid.clone(),
        PendingInteraction::Question {
            id: iid,
            thread_id: local_tid.to_string(),
            tool_call_id,
            questions,
        },
    ))
}

fn parse_codex_thread_item(item: &Value, completed: bool) -> Option<(AgentPart, Vec<String>)> {
    let item_id = item.get("id")?.as_str()?.to_string();
    let item_type = item.get("type")?.as_str()?;
    let mut changed_files = Vec::new();

    match item_type {
        "agentMessage" | "plan" => {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some((
                AgentPart::Text { id: item_id, text },
                changed_files,
            ))
        }
        "reasoning" => {
            let mut chunks: Vec<String> = Vec::new();
            if let Some(summary) = item.get("summary").and_then(|v| v.as_array()) {
                for s in summary {
                    if let Some(txt) = s.as_str() {
                        chunks.push(txt.to_string());
                    }
                }
            }
            if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                for c in content {
                    if let Some(txt) = c.as_str() {
                        chunks.push(txt.to_string());
                    }
                }
            }
            Some((
                AgentPart::Reasoning {
                    id: item_id,
                    text: chunks.join("\n"),
                },
                changed_files,
            ))
        }
        "commandExecution" => {
            let command_str = item
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let raw_status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or(if completed { "completed" } else { "inProgress" });
            let status = match raw_status {
                "completed" => "completed",
                "failed" | "declined" => "error",
                _ => "running",
            }
            .to_string();
            let output = item
                .get("aggregatedOutput")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some((
                AgentPart::Tool {
                    id: format!("tool_{}", item_id),
                    call_id: item_id,
                    tool: "bash".to_string(),
                    title: Some(command_str.clone()),
                    status: status.clone(),
                    input: json!({
                        "command": command_str,
                        "cwd": item.get("cwd").cloned().unwrap_or(Value::Null),
                    }),
                    output: if status == "error" { None } else { output.clone() },
                    error: if status == "error" { output } else { None },
                    file_path: None,
                    diff: None,
                    parent_tool_call_id: None,
                },
                changed_files,
            ))
        }
        "fileChange" => {
            let changes = item.get("changes").and_then(|c| c.as_array());
            let mut diffs = Vec::new();
            let mut first_path: Option<String> = None;
            if let Some(arr) = changes {
                for ch in arr {
                    if let Some(p) = ch.get("path").and_then(|v| v.as_str()) {
                        if first_path.is_none() {
                            first_path = Some(p.to_string());
                        }
                        if completed {
                            changed_files.push(p.to_string());
                        }
                    }
                    if let Some(d) = ch.get("diff").and_then(|v| v.as_str()) {
                        diffs.push(d.to_string());
                    }
                }
            }
            let raw_status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or(if completed { "completed" } else { "inProgress" });
            let status = match raw_status {
                "completed" => "completed",
                "failed" | "declined" => "error",
                _ => "running",
            }
            .to_string();
            Some((
                AgentPart::Tool {
                    id: format!("tool_{}", item_id),
                    call_id: item_id,
                    tool: "edit".to_string(),
                    title: first_path.clone(),
                    status,
                    input: json!({ "changes": changes.cloned().unwrap_or_default() }),
                    output: None,
                    error: None,
                    file_path: first_path,
                    diff: if diffs.is_empty() {
                        None
                    } else {
                        Some(diffs.join("\n"))
                    },
                    parent_tool_call_id: None,
                },
                changed_files,
            ))
        }
        "mcpToolCall" | "dynamicToolCall" => {
            let tool = item
                .get("tool")
                .and_then(|v| v.as_str())
                .unwrap_or("mcp")
                .to_string();
            let input = item.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let raw_status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or(if completed { "completed" } else { "inProgress" });
            let status = match raw_status {
                "completed" => "completed",
                "failed" => "error",
                _ => "running",
            }
            .to_string();
            let output = item
                .get("result")
                .or_else(|| item.get("contentItems"))
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default());
            let err = item
                .get("error")
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default());
            Some((
                AgentPart::Tool {
                    id: format!("tool_{}", item_id),
                    call_id: item_id,
                    tool,
                    title: None,
                    status,
                    input,
                    output,
                    error: err,
                    file_path: None,
                    diff: None,
                    parent_tool_call_id: None,
                },
                changed_files,
            ))
        }
        "webSearch" => Some((
            AgentPart::Tool {
                id: format!("tool_{}", item_id),
                call_id: item_id,
                tool: "websearch".to_string(),
                title: item
                    .get("query")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                status: if completed { "completed" } else { "running" }.to_string(),
                input: json!({ "query": item.get("query").cloned().unwrap_or(Value::Null) }),
                output: None,
                error: None,
                file_path: None,
                diff: None,
                parent_tool_call_id: None,
            },
            changed_files,
        )),
        "collabAgentToolCall" | "subAgentActivity" => Some((
            AgentPart::Tool {
                id: format!("tool_{}", item_id),
                call_id: item_id,
                tool: "task".to_string(),
                title: item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("kind").and_then(|v| v.as_str()))
                    .map(|s| s.to_string()),
                status: if completed { "completed" } else { "running" }.to_string(),
                input: item.clone(),
                output: None,
                error: None,
                file_path: None,
                diff: None,
                parent_tool_call_id: None,
            },
            changed_files,
        )),
        _ => None,
    }
}

pub async fn run_codex_one_shot(
    project_path: &str,
    model: Option<&str>,
    prompt: &str,
    custom_binary_path: Option<&str>,
) -> Result<String, String> {
    let bin_path = find_cli_binary(&["codex"], custom_binary_path)
        .await
        .ok_or_else(|| "Codex CLI ('codex') not found.".to_string())?;

    let out_file = std::env::temp_dir().join(format!("codex_oneshot_{}.txt", uuid::Uuid::new_v4()));
    let out_str = out_file.to_string_lossy().to_string();

    let mut args = vec![
        "exec".to_string(),
        "--skip-git-repo-check".to_string(),
        "--ephemeral".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "-o".to_string(),
        out_str,
    ];
    if let Some(m) = model {
        if !m.trim().is_empty() {
            args.push("-m".to_string());
            args.push(m.to_string());
        }
    }
    args.push(prompt.to_string());

    let out = timeout(
        Duration::from_secs(90),
        spawn_cli_command(&bin_path, &args, project_path)
            .await
            .output(),
    )
    .await
    .map_err(|_| "Codex one-shot prompt timed out".to_string())?
    .map_err(|e| format!("Failed to run Codex: {}", e))?;

    let file_text = tokio::fs::read_to_string(&out_file).await.ok();
    let _ = tokio::fs::remove_file(&out_file).await;

    if let Some(txt) = file_text {
        if !txt.trim().is_empty() {
            return Ok(txt.trim().to_string());
        }
    }

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Codex failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_rate_limits_snapshot() {
        let raw = json!({
            "rateLimits": {
                "limitId": "codex",
                "planType": "plus",
                "primary": { "usedPercent": 15, "windowDurationMins": 300, "resetsAt": 1795395298 },
                "secondary": { "usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1795559531 },
                "credits": { "hasCredits": true, "unlimited": false, "balance": "12.50" }
            }
        });
        let snap = parse_codex_rate_limits(&raw, None).unwrap();
        assert_eq!(snap.plan_type.as_deref(), Some("plus"));
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(snap.windows[0].label, "5-hour window");
        assert_eq!(snap.windows[0].used_percent, Some(15.0));
        assert_eq!(snap.windows[1].label, "Weekly limit");
        assert_eq!(snap.credits_balance.as_deref(), Some("12.50"));
    }

    #[test]
    fn parses_codex_token_usage_and_plan_and_request_user_input() {
        let tu = json!({
            "modelContextWindow": 258400,
            "last": { "inputTokens": 1000, "cachedInputTokens": 4000, "outputTokens": 200, "reasoningOutputTokens": 50, "totalTokens": 5200 },
            "total": { "inputTokens": 3000, "cachedInputTokens": 8000, "outputTokens": 600, "reasoningOutputTokens": 150, "totalTokens": 11600 }
        });
        let parsed_tu = parse_codex_token_usage(Some(&tu)).unwrap();
        assert_eq!(parsed_tu.context_used_tokens, 5200);
        assert_eq!(parsed_tu.context_window_tokens, Some(258400));
        assert_eq!(parsed_tu.reasoning_tokens, 150);

        let plan = json!([
            { "step": "Check refs", "status": "completed" },
            { "step": "Build PDF", "status": "inProgress" }
        ]);
        let parsed_plan = parse_codex_plan_steps(Some(&plan)).unwrap();
        assert_eq!(parsed_plan.len(), 2);
        assert_eq!(parsed_plan[1].status, "in_progress");

        let req = json!({
            "itemId": "itm_1",
            "questions": [{
                "id": "q1",
                "header": "Style",
                "question": "Use IEEE format?",
                "isOther": true,
                "isSecret": false,
                "options": [{ "label": "Yes", "description": "IEEEtran" }]
            }]
        });
        let (_, interaction) = parse_codex_user_input_request(&req, "t1").unwrap();
        match interaction {
            PendingInteraction::Question { questions, .. } => {
                assert_eq!(questions[0].id, "q1");
                assert_eq!(questions[0].options[0].label, "Yes");
            }
            _ => panic!("expected Question"),
        }
    }
}
