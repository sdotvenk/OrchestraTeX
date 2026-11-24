use super::binary::{decode_data_url, find_cli_binary, spawn_cli_command};
use super::store::ThreadStore;
use super::types::{
    now_millis, AccountInfo, AgentMessage, AgentPart, AgentProviderId, AgentStreamEvent,
    AgentThread, AttachmentInput, InteractionMode, InteractionResponse, ModelInfo, ModelTokenUsage,
    PendingInteraction, PermissionOption, PlanTaskItem, ProviderStatus, QuestionItem,
    QuestionOption, RateLimitWindow, RateLimitsSnapshot, RuntimeMode, SlashCommandInfo,
    TokenUsageSnapshot,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSessionConfig {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub interaction_mode: InteractionMode,
    pub runtime_mode: RuntimeMode,
}

impl ClaudeSessionConfig {
    pub fn from_summary(summary: &super::types::ThreadSummary) -> Self {
        Self {
            model: summary
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "default")
                .map(str::to_owned),
            reasoning_effort: summary
                .reasoning_effort
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            interaction_mode: summary.interaction_mode,
            runtime_mode: summary.runtime_mode,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PendingClaudeControl {
    request_id: String,
    tool_name: String,
    original_input: Value,
    permission_suggestions: Option<Value>,
    interaction: PendingInteraction,
}

#[derive(Clone)]
pub struct ClaudeSessionHandle {
    #[allow(dead_code)]
    pub thread_id: String,
    #[allow(dead_code)]
    pub project_path: String,
    stdin_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    pending_controls: Arc<Mutex<HashMap<String, PendingClaudeControl>>>,
    pending_rpc: Arc<Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>>,
    session_config: Arc<Mutex<ClaudeSessionConfig>>,
}

impl ClaudeSessionHandle {
    pub async fn send_turn(
        &self,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<(), String> {
        let mut content_blocks: Vec<Value> = Vec::new();
        for att in attachments {
            if let Some(ref data_url) = att.data_url {
                if let Ok((mime, _)) = decode_data_url(data_url) {
                    if let Some((_, b64)) = data_url.split_once(',') {
                        content_blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": b64.trim(),
                            }
                        }));
                    }
                }
            }
        }
        if !text.trim().is_empty() || content_blocks.is_empty() {
            content_blocks.push(json!({
                "type": "text",
                "text": text,
            }));
        }

        let payload = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content_blocks,
            }
        });
        self.write_json(&payload)
    }

    pub async fn interrupt(&self) -> Result<(), String> {
        let req = json!({
            "type": "control_request",
            "request_id": format!("int_{}", uuid::Uuid::new_v4()),
            "request": {
                "subtype": "interrupt"
            }
        });
        self.write_json(&req)
    }

    pub async fn is_compatible_with(&self, summary: &super::types::ThreadSummary) -> bool {
        let current = self.session_config.lock().await.clone();
        current == ClaudeSessionConfig::from_summary(summary)
    }

    async fn send_control_rpc(&self, request_id: String, req: &Value) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.pending_rpc.lock().await.insert(request_id.clone(), tx);
        if let Err(err) = self.write_json(req) {
            self.pending_rpc.lock().await.remove(&request_id);
            return Err(err);
        }
        match timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Claude session closed before confirming update".to_string()),
            Err(_) => {
                self.pending_rpc.lock().await.remove(&request_id);
                Err("Timed out waiting for Claude to confirm settings update".to_string())
            }
        }
    }

    pub async fn set_model(&self, model: &str) -> Result<(), String> {
        let request_id = format!("mdl_{}", uuid::Uuid::new_v4());
        let req = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "set_model",
                "model": model,
            }
        });
        self.send_control_rpc(request_id, &req).await?;
        let mut cfg = self.session_config.lock().await;
        cfg.model = if model.trim().is_empty() || model == "default" {
            None
        } else {
            Some(model.trim().to_string())
        };
        Ok(())
    }

    pub async fn set_permission_mode(
        &self,
        interaction_mode: InteractionMode,
        runtime_mode: RuntimeMode,
    ) -> Result<(), String> {
        let mode = map_claude_permission_mode(interaction_mode, runtime_mode);
        let request_id = format!("pm_{}", uuid::Uuid::new_v4());
        let req = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "set_permission_mode",
                "mode": mode,
            }
        });
        self.send_control_rpc(request_id, &req).await?;
        let mut cfg = self.session_config.lock().await;
        cfg.interaction_mode = interaction_mode;
        cfg.runtime_mode = runtime_mode;
        Ok(())
    }

    pub async fn send_compact(&self) -> Result<(), String> {
        self.send_turn("/compact", &[]).await
    }

    pub async fn respond_interaction(
        &self,
        interaction_id: &str,
        response: &InteractionResponse,
        runtime_mode: RuntimeMode,
    ) -> Result<(), String> {
        let pending = {
            let mut guard = self.pending_controls.lock().await;
            guard.remove(interaction_id)
        }
        .ok_or_else(|| format!("Pending interaction '{}' not found", interaction_id))?;

        let response_payload = match (&pending.interaction, response) {
            (
                PendingInteraction::Question { questions, .. },
                InteractionResponse::QuestionAnswer { answers, dismissed },
            ) => {
                if *dismissed {
                    json!({
                        "behavior": "deny",
                        "message": "User dismissed the questions."
                    })
                } else {
                    let mut answer_map = serde_json::Map::new();
                    for q in questions {
                        if let Some(selected) = answers.get(&q.id) {
                            answer_map.insert(q.question.clone(), json!(selected.join(", ")));
                        }
                    }
                    let mut updated = pending.original_input.clone();
                    if let Some(obj) = updated.as_object_mut() {
                        obj.insert("answers".to_string(), Value::Object(answer_map));
                    }
                    json!({
                        "behavior": "allow",
                        "updatedInput": updated,
                    })
                }
            }
            (
                PendingInteraction::PlanApproval { .. },
                InteractionResponse::PlanDecision { approved, feedback },
            ) => {
                if *approved {
                    let next_mode =
                        map_claude_permission_mode(InteractionMode::Default, runtime_mode);
                    let _ = self.write_json(&json!({
                        "type": "control_request",
                        "request_id": format!("pm_{}", uuid::Uuid::new_v4()),
                        "request": {
                            "subtype": "set_permission_mode",
                            "mode": next_mode,
                        }
                    }));
                    json!({
                        "behavior": "allow",
                        "updatedInput": pending.original_input,
                    })
                } else {
                    json!({
                        "behavior": "deny",
                        "message": feedback.clone().unwrap_or_else(|| "User requested revisions to the plan.".to_string()),
                    })
                }
            }
            (
                PendingInteraction::Approval { .. },
                InteractionResponse::ApprovalDecision {
                    decision, reason, ..
                },
            ) => {
                if decision == "allow_once" {
                    json!({
                        "behavior": "allow",
                        "updatedInput": pending.original_input,
                    })
                } else if decision == "allow_session" {
                    let mut resp_obj = serde_json::Map::new();
                    resp_obj.insert("behavior".to_string(), json!("allow"));
                    resp_obj.insert("updatedInput".to_string(), pending.original_input.clone());
                    if let Some(suggestions) = pending.permission_suggestions.clone() {
                        resp_obj.insert("updatedPermissions".to_string(), suggestions);
                    }
                    Value::Object(resp_obj)
                } else {
                    json!({
                        "behavior": "deny",
                        "message": reason.clone().unwrap_or_else(|| format!("User denied {} execution.", pending.tool_name)),
                    })
                }
            }
            _ => {
                return Err("Mismatched interaction response kind".to_string());
            }
        };

        let control_resp = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": pending.request_id,
                "response": response_payload,
            }
        });
        self.write_json(&control_resp)
    }

    pub async fn kill(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }

    fn write_json(&self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(line)
            .map_err(|_| "Claude session stdin closed".to_string())
    }
}

pub fn map_claude_permission_mode(
    interaction_mode: InteractionMode,
    runtime_mode: RuntimeMode,
) -> &'static str {
    if interaction_mode == InteractionMode::Plan {
        return "plan";
    }
    match runtime_mode {
        RuntimeMode::ApprovalRequired => "default",
        RuntimeMode::AutoAcceptEdits => "acceptEdits",
        RuntimeMode::FullAccess => "bypassPermissions",
    }
}

pub async fn probe_claude(
    custom_path: Option<&str>,
    cached_rate_limits: Option<RateLimitsSnapshot>,
) -> ProviderStatus {
    let binary = find_cli_binary(&["claude"], custom_path).await;
    let Some(bin_path) = binary else {
        return ProviderStatus {
            id: AgentProviderId::Claude,
            name: AgentProviderId::Claude.display_name().to_string(),
            transport: "cli-stream".to_string(),
            installed: false,
            binary_path: None,
            version: None,
            authenticated: false,
            auth_error: Some("Claude Code CLI ('claude') not found in PATH.".to_string()),
            login_command: AgentProviderId::Claude.login_command().to_string(),
            account: None,
            models: Vec::new(),
            commands: Vec::new(),
            rate_limits: cached_rate_limits,
            supports_steer: false,
            supports_fork: true,
            supports_compact: true,
            supports_questions: true,
        };
    };

    let version = timeout(Duration::from_secs(4), async {
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

    let mut authenticated = false;
    let mut auth_error: Option<String> = None;
    let mut account: Option<AccountInfo> = None;

    if let Ok(Ok(out)) = timeout(
        Duration::from_secs(5),
        spawn_cli_command(&bin_path, &["auth".to_string(), "status".to_string()], "")
            .await
            .output(),
    )
    .await
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        if let Ok(val) = serde_json::from_str::<Value>(&stdout) {
            authenticated = val
                .get("loggedIn")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            account = Some(AccountInfo {
                email: val
                    .get("email")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                organization: val
                    .get("orgName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                plan_type: val
                    .get("subscriptionType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                subscription_type: val
                    .get("subscriptionType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                api_provider: val
                    .get("apiProvider")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
            if !authenticated {
                auth_error =
                    Some("Not signed in to Claude Code. Run `claude auth login`.".to_string());
            }
        } else if !out.status.success() {
            auth_error = Some("Unable to verify Claude Code authentication.".to_string());
        }
    }

    let mut models: Vec<ModelInfo> = Vec::new();
    let mut commands: Vec<SlashCommandInfo> = Vec::new();

    if authenticated {
        if let Ok(init_resp) = probe_claude_initialize(&bin_path).await {
            if let Some(resp_models) = init_resp.get("models").and_then(|v| v.as_array()) {
                for m in resp_models {
                    if let Some(parsed) = parse_claude_model_info(m) {
                        models.push(parsed);
                    }
                }
            }
            if let Some(resp_cmds) = init_resp.get("commands").and_then(|v| v.as_array()) {
                for c in resp_cmds {
                    if let Some(name) = c.get("name").and_then(|v| v.as_str()) {
                        commands.push(SlashCommandInfo {
                            name: name.to_string(),
                            description: c
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            argument_hint: c
                                .get("argumentHint")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                                .map(|s| s.to_string()),
                        });
                    }
                }
            }
            if account.is_none() {
                if let Some(acc) = init_resp.get("account") {
                    account = Some(AccountInfo {
                        email: acc
                            .get("email")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        organization: acc
                            .get("organization")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        plan_type: acc
                            .get("subscriptionType")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        subscription_type: acc
                            .get("subscriptionType")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        api_provider: acc
                            .get("apiProvider")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                }
            }
        }
    }

    if models.is_empty() && authenticated {
        models = default_claude_models();
    }

    ProviderStatus {
        id: AgentProviderId::Claude,
        name: AgentProviderId::Claude.display_name().to_string(),
        transport: "cli-stream".to_string(),
        installed: true,
        binary_path: Some(bin_path),
        version,
        authenticated,
        auth_error,
        login_command: AgentProviderId::Claude.login_command().to_string(),
        account,
        models,
        commands,
        rate_limits: cached_rate_limits,
        supports_steer: false,
        supports_fork: true,
        supports_compact: true,
        supports_questions: true,
    }
}

async fn probe_claude_initialize(bin_path: &str) -> Result<Value, String> {
    let args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
    ];
    let mut cmd = spawn_cli_command(bin_path, &args, "").await;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;

    let req = json!({
        "type": "control_request",
        "request_id": "probe_init",
        "request": { "subtype": "initialize" }
    });
    let mut bytes = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stdout).lines();
    let res = timeout(Duration::from_secs(6), async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if val.get("type").and_then(|t| t.as_str()) == Some("control_response") {
                    if let Some(resp) = val.get("response").and_then(|r| r.get("response")) {
                        return Ok(resp.clone());
                    }
                }
            }
        }
        Err("Claude initialize closed without response".to_string())
    })
    .await
    .map_err(|_| "Claude initialize timed out".to_string())?;

    let _ = child.kill().await;
    res
}

fn parse_claude_model_info(m: &Value) -> Option<ModelInfo> {
    let value = m.get("value").and_then(|v| v.as_str())?;
    let display_name = m
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(value);
    let resolved = m.get("resolvedModel").and_then(|v| v.as_str());
    let name = if value == "default" {
        if let Some(res) = resolved {
            format!("Default ({})", res)
        } else {
            display_name.to_string()
        }
    } else {
        display_name.to_string()
    };
    let supported_effort_levels: Vec<String> = m
        .get("supportedEffortLevels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Some(ModelInfo {
        id: value.to_string(),
        name,
        description: m
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        supports_effort: m
            .get("supportsEffort")
            .and_then(|v| v.as_bool())
            .unwrap_or(!supported_effort_levels.is_empty()),
        supported_effort_levels,
        default_effort: Some("high".to_string()),
        supports_fast_mode: m
            .get("supportsFastMode")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_default: value == "default",
        context_window: None,
    })
}

fn default_claude_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "default".to_string(),
            name: "Default".to_string(),
            description: Some("Recommended Claude Code model".to_string()),
            supports_effort: true,
            supported_effort_levels: vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "max".to_string(),
            ],
            default_effort: Some("high".to_string()),
            supports_fast_mode: false,
            is_default: true,
            context_window: None,
        },
        ModelInfo {
            id: "opus".to_string(),
            name: "Opus".to_string(),
            description: Some("Most capable Claude model".to_string()),
            supports_effort: true,
            supported_effort_levels: vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "max".to_string(),
            ],
            default_effort: Some("high".to_string()),
            supports_fast_mode: true,
            is_default: false,
            context_window: None,
        },
        ModelInfo {
            id: "sonnet".to_string(),
            name: "Sonnet".to_string(),
            description: Some("Balanced coding and writing model".to_string()),
            supports_effort: true,
            supported_effort_levels: vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "max".to_string(),
            ],
            default_effort: Some("high".to_string()),
            supports_fast_mode: false,
            is_default: false,
            context_window: None,
        },
        ModelInfo {
            id: "haiku".to_string(),
            name: "Haiku".to_string(),
            description: Some("Fast lightweight model".to_string()),
            supports_effort: false,
            supported_effort_levels: Vec::new(),
            default_effort: None,
            supports_fast_mode: false,
            is_default: false,
            context_window: None,
        },
    ]
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_claude_session(
    app: AppHandle,
    store: Arc<ThreadStore>,
    rate_limit_cache: Arc<Mutex<HashMap<AgentProviderId, RateLimitsSnapshot>>>,
    sessions_map: Arc<Mutex<HashMap<String, ClaudeSessionHandle>>>,
    thread: &AgentThread,
    custom_binary_path: Option<&str>,
    fork_from_session_id: Option<&str>,
) -> Result<ClaudeSessionHandle, String> {
    let bin_path = find_cli_binary(&["claude"], custom_binary_path)
        .await
        .ok_or_else(|| "Claude Code CLI ('claude') not found.".to_string())?;

    let mut args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
        "--forward-subagent-text".to_string(),
    ];

    if let Some(ref model) = thread.summary.model {
        if !model.trim().is_empty() && model != "default" {
            args.push("--model".to_string());
            args.push(model.clone());
        }
    }

    if let Some(ref effort) = thread.summary.reasoning_effort {
        if !effort.trim().is_empty() {
            args.push("--effort".to_string());
            args.push(effort.clone());
        }
    }

    let perm_mode =
        map_claude_permission_mode(thread.summary.interaction_mode, thread.summary.runtime_mode);
    args.push("--permission-mode".to_string());
    args.push(perm_mode.to_string());
    if thread.summary.runtime_mode == RuntimeMode::FullAccess {
        args.push("--allow-dangerously-skip-permissions".to_string());
    }

    if let Some(src_sid) = fork_from_session_id {
        args.push("--resume".to_string());
        args.push(src_sid.to_string());
        args.push("--fork-session".to_string());
    } else if let Some(ref sid) = thread.summary.provider_session_id {
        args.push("--resume".to_string());
        args.push(sid.clone());
    } else {
        args.push("--session-id".to_string());
        args.push(thread.summary.id.clone());
    }

    let mut cmd =
        spawn_cli_command(&bin_path, &args, thread.summary.effective_workspace_path()).await;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude Code: {}", e))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open Claude stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Claude stdout".to_string())?;
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

    // Initialize handshake
    let init_line = serde_json::to_string(&json!({
        "type": "control_request",
        "request_id": format!("init_{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "initialize" }
    }))
    .unwrap_or_default();
    let _ = stdin_tx.send(init_line);

    let child_arc = Arc::new(Mutex::new(Some(child)));
    let pending_controls = Arc::new(Mutex::new(HashMap::<String, PendingClaudeControl>::new()));
    let pending_rpc = Arc::new(Mutex::new(
        HashMap::<String, oneshot::Sender<Result<(), String>>>::new(),
    ));
    let session_config = Arc::new(Mutex::new(ClaudeSessionConfig::from_summary(&thread.summary)));

    let handle = ClaudeSessionHandle {
        thread_id: thread.summary.id.clone(),
        project_path: thread.summary.project_path.clone(),
        stdin_tx,
        child: child_arc.clone(),
        pending_controls: pending_controls.clone(),
        pending_rpc: pending_rpc.clone(),
        session_config,
    };

    // Stderr logger
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        let tid = thread.summary.id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_err.emit(
                    "agent-event",
                    AgentStreamEvent::ProviderLog {
                        provider_id: AgentProviderId::Claude,
                        thread_id: Some(tid.clone()),
                        stream: "stderr".to_string(),
                        message: line,
                    },
                );
            }
        });
    }

    // Stdout event processor
    let thread_id = thread.summary.id.clone();
    let project_path = thread.summary.project_path.clone();
    let app_out = app.clone();
    let store_out = store.clone();
    let rate_cache_out = rate_limit_cache.clone();
    let pending_out = pending_controls.clone();
    let pending_rpc_out = pending_rpc.clone();
    let sessions_out = sessions_map.clone();
    let child_id = child_arc.clone();

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut active_message_id: Option<String> = None;
        let mut active_blocks: HashMap<usize, ActiveStreamBlock> = HashMap::new();
        let mut tool_inputs_by_call: HashMap<String, (String, Value)> = HashMap::new();
        let mut last_usage = TokenUsageSnapshot::default();
        let mut step_seq: usize = 0;
        let mut current_step_key = String::from("s0");

        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };

            let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match event_type {
                "system" => {
                    let subtype = val.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                    if subtype == "init" {
                        if let Some(sid) = val.get("session_id").and_then(|v| v.as_str()) {
                            let sid_owned = sid.to_string();
                            if let Ok(Some(updated)) = store_out
                                .mutate_thread(&project_path, &thread_id, |t| {
                                    t.summary.provider_session_id = Some(sid_owned.clone());
                                })
                                .await
                            {
                                let _ = app_out.emit(
                                    "agent-event",
                                    AgentStreamEvent::ThreadUpdated {
                                        thread: updated.summary,
                                    },
                                );
                            }
                        }
                    }
                }
                "control_response" => {
                    if let Some(resp) = val.get("response") {
                        if let Some(req_id) = resp.get("request_id").and_then(|v| v.as_str()) {
                            if let Some(waiter) = pending_rpc_out.lock().await.remove(req_id) {
                                let subtype = resp
                                    .get("subtype")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("success");
                                if subtype == "error" {
                                    let msg = resp
                                        .get("error")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Claude rejected control request")
                                        .to_string();
                                    let _ = waiter.send(Err(msg));
                                } else {
                                    let _ = waiter.send(Ok(()));
                                }
                            }
                        }
                    }
                    if let Some(cmds) = val
                        .get("response")
                        .and_then(|r| r.get("response"))
                        .and_then(|r| r.get("commands"))
                        .and_then(|c| c.as_array())
                    {
                        let parsed: Vec<SlashCommandInfo> = cmds
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
                                        .get("argumentHint")
                                        .and_then(|v| v.as_str())
                                        .filter(|s| !s.is_empty())
                                        .map(|s| s.to_string()),
                                })
                            })
                            .collect();
                        if !parsed.is_empty() {
                            let _ = app_out.emit(
                                "agent-event",
                                AgentStreamEvent::CommandsUpdated {
                                    provider_id: AgentProviderId::Claude,
                                    commands: parsed,
                                },
                            );
                        }
                    }
                }
                "stream_event" => {
                    let Some(ev) = val.get("event") else {
                        continue;
                    };
                    let parent_tool_use_id = val
                        .get("parent_tool_use_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let msg_id = ensure_active_assistant_message(
                        &app_out,
                        &store_out,
                        &project_path,
                        &thread_id,
                        &mut active_message_id,
                    )
                    .await;

                    let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ev_type {
                        "message_start" => {
                            step_seq += 1;
                            current_step_key = ev
                                .get("message")
                                .and_then(|m| m.get("id"))
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("s{}", step_seq));
                            active_blocks.clear();
                            if let Some(u) = ev.get("message").and_then(|m| m.get("usage")) {
                                apply_claude_usage(&mut last_usage, u);
                                let _ = app_out.emit(
                                    "agent-event",
                                    AgentStreamEvent::TokenUsageUpdated {
                                        thread_id: thread_id.clone(),
                                        usage: last_usage.clone(),
                                    },
                                );
                            }
                        }
                        "content_block_start" => {
                            let idx =
                                ev.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            let Some(cb) = ev.get("content_block") else {
                                continue;
                            };
                            let cb_type = cb.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match cb_type {
                                "text" => {
                                    let pid =
                                        format!("txt_{}_{}_{}", msg_id, current_step_key, idx);
                                    let part = AgentPart::Text {
                                        id: pid.clone(),
                                        text: cb
                                            .get("text")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                    };
                                    active_blocks.insert(
                                        idx,
                                        ActiveStreamBlock {
                                            part_id: pid,
                                            kind: "text".to_string(),
                                            tool_name: None,
                                            tool_call_id: None,
                                            json_buf: String::new(),
                                            parent_tool_call_id: parent_tool_use_id.clone(),
                                        },
                                    );
                                    let _ = app_out.emit(
                                        "agent-event",
                                        AgentStreamEvent::PartUpdated {
                                            thread_id: thread_id.clone(),
                                            message_id: msg_id.clone(),
                                            part,
                                        },
                                    );
                                }
                                "thinking" => {
                                    let pid =
                                        format!("thk_{}_{}_{}", msg_id, current_step_key, idx);
                                    let part = AgentPart::Reasoning {
                                        id: pid.clone(),
                                        text: cb
                                            .get("thinking")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                    };
                                    active_blocks.insert(
                                        idx,
                                        ActiveStreamBlock {
                                            part_id: pid,
                                            kind: "reasoning".to_string(),
                                            tool_name: None,
                                            tool_call_id: None,
                                            json_buf: String::new(),
                                            parent_tool_call_id: parent_tool_use_id.clone(),
                                        },
                                    );
                                    let _ = app_out.emit(
                                        "agent-event",
                                        AgentStreamEvent::PartUpdated {
                                            thread_id: thread_id.clone(),
                                            message_id: msg_id.clone(),
                                            part,
                                        },
                                    );
                                }
                                "tool_use" => {
                                    let call_id = cb
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let tool_name = cb
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool")
                                        .to_string();
                                    let pid = if call_id.is_empty() {
                                        format!("tool_{}_{}_{}", msg_id, current_step_key, idx)
                                    } else {
                                        format!("tool_{}", call_id)
                                    };
                                    let input =
                                        cb.get("input").cloned().unwrap_or_else(|| json!({}));
                                    let part = AgentPart::Tool {
                                        id: pid.clone(),
                                        call_id: call_id.clone(),
                                        tool: tool_name.clone(),
                                        title: None,
                                        status: "running".to_string(),
                                        input,
                                        output: None,
                                        error: None,
                                        file_path: None,
                                        diff: None,
                                        parent_tool_call_id: parent_tool_use_id.clone(),
                                    };
                                    active_blocks.insert(
                                        idx,
                                        ActiveStreamBlock {
                                            part_id: pid,
                                            kind: "tool".to_string(),
                                            tool_name: Some(tool_name),
                                            tool_call_id: Some(call_id),
                                            json_buf: String::new(),
                                            parent_tool_call_id: parent_tool_use_id.clone(),
                                        },
                                    );
                                    let _ = app_out.emit(
                                        "agent-event",
                                        AgentStreamEvent::PartUpdated {
                                            thread_id: thread_id.clone(),
                                            message_id: msg_id.clone(),
                                            part,
                                        },
                                    );
                                }
                                _ => {}
                            }
                        }
                        "content_block_delta" => {
                            let idx =
                                ev.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            let Some(delta_obj) = ev.get("delta") else {
                                continue;
                            };
                            let delta_type =
                                delta_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if let Some(block) = active_blocks.get_mut(&idx) {
                                match delta_type {
                                    "text_delta" => {
                                        if let Some(txt) =
                                            delta_obj.get("text").and_then(|v| v.as_str())
                                        {
                                            let part_id = block.part_id.clone();
                                            let _ = store_out
                                                .mutate_thread_memory(
                                                    &project_path,
                                                    &thread_id,
                                                    |t| {
                                                        ThreadStore::append_delta_in_thread(
                                                            t, &msg_id, &part_id, "text", txt,
                                                        );
                                                    },
                                                )
                                                .await;
                                            let _ = app_out.emit(
                                                "agent-event",
                                                AgentStreamEvent::PartDelta {
                                                    thread_id: thread_id.clone(),
                                                    message_id: msg_id.clone(),
                                                    part_id,
                                                    part_type: "text".to_string(),
                                                    delta: txt.to_string(),
                                                },
                                            );
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(txt) =
                                            delta_obj.get("thinking").and_then(|v| v.as_str())
                                        {
                                            let part_id = block.part_id.clone();
                                            let _ = store_out
                                                .mutate_thread_memory(
                                                    &project_path,
                                                    &thread_id,
                                                    |t| {
                                                        ThreadStore::append_delta_in_thread(
                                                            t,
                                                            &msg_id,
                                                            &part_id,
                                                            "reasoning",
                                                            txt,
                                                        );
                                                    },
                                                )
                                                .await;
                                            let _ = app_out.emit(
                                                "agent-event",
                                                AgentStreamEvent::PartDelta {
                                                    thread_id: thread_id.clone(),
                                                    message_id: msg_id.clone(),
                                                    part_id,
                                                    part_type: "reasoning".to_string(),
                                                    delta: txt.to_string(),
                                                },
                                            );
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(part_json) =
                                            delta_obj.get("partial_json").and_then(|v| v.as_str())
                                        {
                                            block.json_buf.push_str(part_json);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "content_block_stop" => {
                            let idx =
                                ev.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            if let Some(block) = active_blocks.remove(&idx) {
                                if block.kind == "tool" && !block.json_buf.is_empty() {
                                    if let Ok(parsed_input) =
                                        serde_json::from_str::<Value>(&block.json_buf)
                                    {
                                        let tool_name = block
                                            .tool_name
                                            .clone()
                                            .unwrap_or_else(|| "tool".to_string());
                                        let call_id =
                                            block.tool_call_id.clone().unwrap_or_default();
                                        let file_path = extract_file_path_from_input(&parsed_input);
                                        tool_inputs_by_call.insert(
                                            call_id.clone(),
                                            (tool_name.clone(), parsed_input.clone()),
                                        );
                                        if let Some(tasks) = extract_tasks_from_claude_tool(
                                            &tool_name,
                                            &parsed_input,
                                        ) {
                                            let _ = store_out
                                                .mutate_thread(&project_path, &thread_id, |t| {
                                                    ThreadStore::set_tasks(t, tasks.clone());
                                                })
                                                .await;
                                            let _ = app_out.emit(
                                                "agent-event",
                                                AgentStreamEvent::PlanUpdated {
                                                    thread_id: thread_id.clone(),
                                                    tasks,
                                                },
                                            );
                                        }
                                        let part = AgentPart::Tool {
                                            id: block.part_id,
                                            call_id,
                                            tool: tool_name,
                                            title: None,
                                            status: "running".to_string(),
                                            input: parsed_input,
                                            output: None,
                                            error: None,
                                            file_path,
                                            diff: None,
                                            parent_tool_call_id: block.parent_tool_call_id,
                                        };
                                        let _ = store_out
                                            .mutate_thread(&project_path, &thread_id, |t| {
                                                ThreadStore::upsert_part_in_thread(
                                                    t,
                                                    &msg_id,
                                                    part.clone(),
                                                );
                                            })
                                            .await;
                                        let _ = app_out.emit(
                                            "agent-event",
                                            AgentStreamEvent::PartUpdated {
                                                thread_id: thread_id.clone(),
                                                message_id: msg_id.clone(),
                                                part,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                        "message_delta" => {
                            if let Some(u) = ev.get("usage") {
                                apply_claude_usage(&mut last_usage, u);
                                let _ = app_out.emit(
                                    "agent-event",
                                    AgentStreamEvent::TokenUsageUpdated {
                                        thread_id: thread_id.clone(),
                                        usage: last_usage.clone(),
                                    },
                                );
                            }
                        }
                        _ => {}
                    }
                }
                "assistant" => {
                    let msg_id = ensure_active_assistant_message(
                        &app_out,
                        &store_out,
                        &project_path,
                        &thread_id,
                        &mut active_message_id,
                    )
                    .await;
                    let parent_tool_use_id = val
                        .get("parent_tool_use_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if let Some(msg) = val.get("message") {
                        let envelope_step_key = msg
                            .get("id")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| current_step_key.clone());

                        let mut usage_updated = false;
                        if let Some(u) = msg.get("usage") {
                            apply_claude_usage(&mut last_usage, u);
                            usage_updated = true;
                        }

                        let mut parts_to_upsert: Vec<AgentPart> = Vec::new();
                        let mut updated_tasks: Option<Vec<PlanTaskItem>> = None;

                        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                            for (idx, block) in content.iter().enumerate() {
                                let btype =
                                    block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                match btype {
                                    "text" => {
                                        let text = block
                                            .get("text")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let pid =
                                            format!("txt_{}_{}_{}", msg_id, envelope_step_key, idx);
                                        parts_to_upsert.push(AgentPart::Text { id: pid, text });
                                    }
                                    "thinking" => {
                                        let text = block
                                            .get("thinking")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let pid =
                                            format!("thk_{}_{}_{}", msg_id, envelope_step_key, idx);
                                        parts_to_upsert
                                            .push(AgentPart::Reasoning { id: pid, text });
                                    }
                                    "tool_use" => {
                                        let call_id = block
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let tool_name = block
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("tool")
                                            .to_string();
                                        let input = block
                                            .get("input")
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));
                                        let file_path = extract_file_path_from_input(&input);
                                        tool_inputs_by_call.insert(
                                            call_id.clone(),
                                            (tool_name.clone(), input.clone()),
                                        );
                                        if let Some(tasks) =
                                            extract_tasks_from_claude_tool(&tool_name, &input)
                                        {
                                            updated_tasks = Some(tasks);
                                        }
                                        let pid = if call_id.is_empty() {
                                            format!("tool_{}_{}_{}", msg_id, envelope_step_key, idx)
                                        } else {
                                            format!("tool_{}", call_id)
                                        };
                                        parts_to_upsert.push(AgentPart::Tool {
                                            id: pid,
                                            call_id,
                                            tool: tool_name,
                                            title: None,
                                            status: "running".to_string(),
                                            input,
                                            output: None,
                                            error: None,
                                            file_path,
                                            diff: None,
                                            parent_tool_call_id: parent_tool_use_id.clone(),
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }

                        if usage_updated || updated_tasks.is_some() || !parts_to_upsert.is_empty() {
                            let usage_snapshot = if usage_updated {
                                Some(last_usage.clone())
                            } else {
                                None
                            };
                            let tasks_clone = updated_tasks.clone();
                            let parts_clone = parts_to_upsert.clone();
                            let _ = store_out
                                .mutate_thread(&project_path, &thread_id, |t| {
                                    if let Some(u) = usage_snapshot {
                                        ThreadStore::set_usage(t, u);
                                    }
                                    if let Some(tasks) = tasks_clone {
                                        ThreadStore::set_tasks(t, tasks);
                                    }
                                    for part in parts_clone {
                                        ThreadStore::upsert_part_in_thread(t, &msg_id, part);
                                    }
                                })
                                .await;
                        }

                        if usage_updated {
                            let _ = app_out.emit(
                                "agent-event",
                                AgentStreamEvent::TokenUsageUpdated {
                                    thread_id: thread_id.clone(),
                                    usage: last_usage.clone(),
                                },
                            );
                        }
                        if let Some(tasks) = updated_tasks {
                            let _ = app_out.emit(
                                "agent-event",
                                AgentStreamEvent::PlanUpdated {
                                    thread_id: thread_id.clone(),
                                    tasks,
                                },
                            );
                        }
                        for part in parts_to_upsert {
                            let _ = app_out.emit(
                                "agent-event",
                                AgentStreamEvent::PartUpdated {
                                    thread_id: thread_id.clone(),
                                    message_id: msg_id.clone(),
                                    part,
                                },
                            );
                        }
                    }
                }
                "user" => {
                    if let Some(msg_id) = active_message_id.clone() {
                        if let Some(content) = val
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_array())
                        {
                            let mut parts_to_upsert: Vec<AgentPart> = Vec::new();
                            let mut changed_files: Vec<String> = Vec::new();

                            for block in content {
                                if block.get("type").and_then(|v| v.as_str()) == Some("tool_result")
                                {
                                    let call_id = block
                                        .get("tool_use_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let is_err = block
                                        .get("is_error")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    let out_text = extract_tool_result_text(block.get("content"));
                                    let (tool_name, input) = tool_inputs_by_call
                                        .get(&call_id)
                                        .cloned()
                                        .unwrap_or_else(|| ("tool".to_string(), json!({})));
                                    let file_path = extract_file_path_from_input(&input);
                                    let pid = format!("tool_{}", call_id);
                                    let part = AgentPart::Tool {
                                        id: pid,
                                        call_id: call_id.clone(),
                                        tool: tool_name.clone(),
                                        title: None,
                                        status: if is_err {
                                            "error".to_string()
                                        } else {
                                            "completed".to_string()
                                        },
                                        input,
                                        output: if is_err { None } else { Some(out_text.clone()) },
                                        error: if is_err { Some(out_text) } else { None },
                                        file_path: file_path.clone(),
                                        diff: None,
                                        parent_tool_call_id: val
                                            .get("parent_tool_use_id")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                    };
                                    if !is_err
                                        && matches!(
                                            tool_name.to_ascii_lowercase().as_str(),
                                            "edit" | "write" | "multiedit" | "notebookedit"
                                        )
                                    {
                                        if let Some(cf) = file_path {
                                            if !changed_files.contains(&cf) {
                                                changed_files.push(cf);
                                            }
                                        }
                                    }
                                    parts_to_upsert.push(part);
                                }
                            }

                            if !parts_to_upsert.is_empty() {
                                let parts_clone = parts_to_upsert.clone();
                                let _ = store_out
                                    .mutate_thread(&project_path, &thread_id, |t| {
                                        for part in parts_clone {
                                            ThreadStore::upsert_part_in_thread(t, &msg_id, part);
                                        }
                                        if !changed_files.is_empty() {
                                            if let Some(m) =
                                                t.messages.iter_mut().find(|m| m.id == msg_id)
                                            {
                                                for cf in &changed_files {
                                                    if !m.changed_files.contains(cf) {
                                                        m.changed_files.push(cf.clone());
                                                    }
                                                }
                                            }
                                        }
                                    })
                                    .await;
                                for part in parts_to_upsert {
                                    let _ = app_out.emit(
                                        "agent-event",
                                        AgentStreamEvent::PartUpdated {
                                            thread_id: thread_id.clone(),
                                            message_id: msg_id.clone(),
                                            part,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
                "rate_limit_event" => {
                    let existing = rate_cache_out
                        .lock()
                        .await
                        .get(&AgentProviderId::Claude)
                        .cloned();
                    if let Some(snapshot) = parse_claude_rate_limit(&val, existing.as_ref()) {
                        rate_cache_out
                            .lock()
                            .await
                            .insert(AgentProviderId::Claude, snapshot.clone());
                        let _ = app_out.emit(
                            "agent-event",
                            AgentStreamEvent::RateLimitsUpdated {
                                provider_id: AgentProviderId::Claude,
                                rate_limits: snapshot,
                            },
                        );
                    }
                }
                "control_request" => {
                    if let Some(pending) = parse_claude_control_request(&val, &thread_id) {
                        let interaction = pending.interaction.clone();
                        let iid = interaction.id().to_string();
                        pending_out.lock().await.insert(iid, pending);
                        let _ = store_out
                            .mutate_thread(&project_path, &thread_id, |t| {
                                ThreadStore::set_pending_interaction(t, Some(interaction.clone()));
                                t.summary.status = "waiting_input".to_string();
                            })
                            .await;
                        let _ = app_out.emit(
                            "agent-event",
                            AgentStreamEvent::InteractionRequested {
                                thread_id: thread_id.clone(),
                                interaction,
                            },
                        );
                        let _ = app_out.emit(
                            "agent-event",
                            AgentStreamEvent::TurnStatus {
                                thread_id: thread_id.clone(),
                                status: "waiting_input".to_string(),
                                error: None,
                            },
                        );
                    }
                }
                "result" => {
                    let is_error = val
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let err_msg = if is_error {
                        val.get("result")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                val.get("errors")
                                    .and_then(|e| e.as_array())
                                    .and_then(|a| a.first())
                                    .and_then(|s| s.as_str())
                            })
                            .map(|s| s.to_string())
                    } else {
                        None
                    };

                    apply_claude_result_usage(&mut last_usage, &val);
                    if let Some(mgr) = app_out.try_state::<super::AgentManagerState>() {
                        if let Ok(log) = mgr.get_usage_log(&app_out).await {
                            let _ = log
                                .record_claude_result(&project_path, &thread_id, None, &val)
                                .await;
                        }
                    }

                    let mut emitted_fallback_part: Option<(String, AgentPart)> = None;
                    if let Some(msg_id) = active_message_id.take() {
                        let _ = store_out
                            .mutate_thread(&project_path, &thread_id, |t| {
                                ThreadStore::set_usage(t, last_usage.clone());
                                ThreadStore::set_pending_interaction(t, None);
                                t.summary.status = if is_error {
                                    "error".to_string()
                                } else {
                                    "idle".to_string()
                                };
                                if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                                    m.completed_at = Some(now_millis());
                                    if let Some(ref em) = err_msg {
                                        m.error = Some(em.clone());
                                    }
                                    // If result carried final text and assistant has no text parts, attach it
                                    if !is_error {
                                        let has_text = m
                                            .parts
                                            .iter()
                                            .any(|p| matches!(p, AgentPart::Text { text, .. } if !text.trim().is_empty()));
                                        if !has_text {
                                            if let Some(res_txt) =
                                                val.get("result").and_then(|v| v.as_str())
                                            {
                                                if !res_txt.trim().is_empty() {
                                                    let part = AgentPart::Text {
                                                        id: format!("txt_{}_final", msg_id),
                                                        text: res_txt.to_string(),
                                                    };
                                                    m.parts.push(part.clone());
                                                    emitted_fallback_part = Some((msg_id.clone(), part));
                                                }
                                            }
                                        }
                                    }
                                }
                            })
                            .await;
                    } else {
                        let _ = store_out
                            .mutate_thread(&project_path, &thread_id, |t| {
                                ThreadStore::set_usage(t, last_usage.clone());
                                ThreadStore::set_pending_interaction(t, None);
                                t.summary.status = if is_error {
                                    "error".to_string()
                                } else {
                                    "idle".to_string()
                                };
                            })
                            .await;
                    }

                    if let Some((mid, part)) = emitted_fallback_part {
                        let _ = app_out.emit(
                            "agent-event",
                            AgentStreamEvent::PartUpdated {
                                thread_id: thread_id.clone(),
                                message_id: mid,
                                part,
                            },
                        );
                    }

                    active_blocks.clear();
                    step_seq = 0;
                    current_step_key = String::from("s0");
                    let _ = app_out.emit(
                        "agent-event",
                        AgentStreamEvent::TokenUsageUpdated {
                            thread_id: thread_id.clone(),
                            usage: last_usage.clone(),
                        },
                    );
                    let _ = app_out.emit(
                        "agent-event",
                        AgentStreamEvent::TurnStatus {
                            thread_id: thread_id.clone(),
                            status: if is_error {
                                "error".to_string()
                            } else {
                                "idle".to_string()
                            },
                            error: err_msg,
                        },
                    );
                }
                _ => {}
            }
        }

        // Process exited: fail any pending control RPCs immediately and only remove our own session entry.
        for (_, waiter) in pending_rpc_out.lock().await.drain() {
            let _ = waiter.send(Err("Claude process exited".to_string()));
        }
        {
            let mut sessions = sessions_out.lock().await;
            if let Some(current) = sessions.get(&thread_id) {
                if Arc::ptr_eq(&current.child, &child_id) {
                    sessions.remove(&thread_id);
                }
            }
        }
        if active_message_id.is_some() {
            let _ = store_out
                .mutate_thread(&project_path, &thread_id, |t| {
                    t.summary.status = "idle".to_string();
                    ThreadStore::set_pending_interaction(t, None);
                })
                .await;
            let _ = app_out.emit(
                "agent-event",
                AgentStreamEvent::TurnStatus {
                    thread_id: thread_id.clone(),
                    status: "idle".to_string(),
                    error: None,
                },
            );
        }
    });

    Ok(handle)
}

struct ActiveStreamBlock {
    part_id: String,
    kind: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    json_buf: String,
    parent_tool_call_id: Option<String>,
}

async fn ensure_active_assistant_message(
    app: &AppHandle,
    store: &ThreadStore,
    project_path: &str,
    thread_id: &str,
    active_message_id: &mut Option<String>,
) -> String {
    if let Some(ref existing) = active_message_id {
        return existing.clone();
    }
    let msg_id = uuid::Uuid::new_v4().to_string();
    let msg = AgentMessage {
        id: msg_id.clone(),
        role: "assistant".to_string(),
        created_at: now_millis(),
        completed_at: None,
        provider_id: Some(AgentProviderId::Claude),
        model: None,
        parts: Vec::new(),
        changed_files: Vec::new(),
        error: None,
    };
    let _ = store
        .mutate_thread(project_path, thread_id, |t| {
            ThreadStore::append_message_to_thread(t, msg.clone());
            t.summary.status = "running".to_string();
        })
        .await;
    let _ = app.emit(
        "agent-event",
        AgentStreamEvent::MessageAdded {
            thread_id: thread_id.to_string(),
            message: msg,
        },
    );
    *active_message_id = Some(msg_id.clone());
    msg_id
}

fn extract_file_path_from_input(input: &Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("filePath"))
        .or_else(|| input.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_tool_result_text(content: Option<&Value>) -> String {
    let Some(val) = content else {
        return String::new();
    };
    if let Some(s) = val.as_str() {
        return s.to_string();
    }
    if let Some(arr) = val.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    serde_json::to_string_pretty(val).unwrap_or_default()
}

fn extract_tasks_from_claude_tool(tool_name: &str, input: &Value) -> Option<Vec<PlanTaskItem>> {
    if tool_name.eq_ignore_ascii_case("TodoWrite") {
        let todos = input.get("todos")?.as_array()?;
        let items: Vec<PlanTaskItem> = todos
            .iter()
            .enumerate()
            .filter_map(|(i, item)| {
                let content = item.get("content")?.as_str()?.to_string();
                let status = item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending")
                    .to_string();
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("todo_{}", i));
                let priority = item
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
        return Some(items);
    }
    None
}

fn apply_claude_usage(target: &mut TokenUsageSnapshot, usage: &Value) {
    let input = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_write = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let ctx = input + cache_read + cache_write;
    if ctx > 0 {
        target.context_used_tokens = ctx;
    }
    if input > 0 {
        target.input_tokens = target.input_tokens.max(input);
    }
    if output > 0 {
        target.output_tokens = target.output_tokens.max(output);
    }
    if cache_read > 0 {
        target.cache_read_tokens = target.cache_read_tokens.max(cache_read);
    }
    if cache_write > 0 {
        target.cache_write_tokens = target.cache_write_tokens.max(cache_write);
    }
}

pub fn apply_claude_result_usage(target: &mut TokenUsageSnapshot, result_val: &Value) {
    if let Some(cost) = result_val.get("total_cost_usd").and_then(|v| v.as_f64()) {
        target.total_cost_usd = Some(cost);
    }
    if let Some(u) = result_val.get("usage") {
        target.input_tokens = u
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(target.input_tokens);
        target.output_tokens = u
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(target.output_tokens);
        target.cache_read_tokens = u
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(target.cache_read_tokens);
        target.cache_write_tokens = u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(target.cache_write_tokens);
    }
    if let Some(mu_obj) = result_val.get("modelUsage").and_then(|v| v.as_object()) {
        let mut models = Vec::new();
        let mut max_ctx: Option<u64> = None;
        for (model_name, data) in mu_obj {
            let cw = data.get("contextWindow").and_then(|v| v.as_u64());
            if let Some(w) = cw {
                max_ctx = Some(max_ctx.map_or(w, |cur| cur.max(w)));
            }
            models.push(ModelTokenUsage {
                model: model_name.clone(),
                input_tokens: data
                    .get("inputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                output_tokens: data
                    .get("outputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                cache_read_tokens: data
                    .get("cacheReadInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                cache_write_tokens: data
                    .get("cacheCreationInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                cost_usd: data.get("costUSD").and_then(|v| v.as_f64()),
                context_window: cw,
            });
        }
        if max_ctx.is_some() {
            target.context_window_tokens = max_ctx;
        }
        if !models.is_empty() {
            target.model_usage = models;
        }
    }
}

pub fn parse_claude_rate_limit(
    val: &Value,
    existing: Option<&RateLimitsSnapshot>,
) -> Option<RateLimitsSnapshot> {
    let info = val.get("rate_limit_info")?;
    let rate_limit_type = info
        .get("rateLimitType")
        .and_then(|v| v.as_str())
        .unwrap_or("five_hour")
        .to_string();
    let label = match rate_limit_type.as_str() {
        "five_hour" => "5-hour window".to_string(),
        "seven_day" => "Weekly limit".to_string(),
        other => other.replace('_', " "),
    };
    let duration_mins = match rate_limit_type.as_str() {
        "five_hour" => Some(300),
        "seven_day" => Some(10080),
        _ => None,
    };
    let status = info
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let resets_at = info.get("resetsAt").and_then(|v| v.as_i64());
    let used_percent =
        info.get("utilization")
            .and_then(|v| v.as_f64())
            .map(|u| if u <= 1.0 { u * 100.0 } else { u });

    let mut windows = existing.map(|e| e.windows.clone()).unwrap_or_default();
    let new_win = RateLimitWindow {
        id: rate_limit_type.clone(),
        label,
        used_percent,
        status,
        window_duration_mins: duration_mins,
        resets_at,
    };
    if let Some(pos) = windows.iter().position(|w| w.id == rate_limit_type) {
        windows[pos] = new_win;
    } else {
        windows.push(new_win);
    }

    Some(RateLimitsSnapshot {
        provider_id: AgentProviderId::Claude,
        updated_at: now_millis(),
        plan_type: existing.and_then(|e| e.plan_type.clone()),
        windows,
        credits_balance: None,
        note: if used_percent.is_none() {
            Some(
                "Claude Code reports exact utilization once usage nears window thresholds."
                    .to_string(),
            )
        } else {
            None
        },
    })
}

pub fn parse_claude_control_request(val: &Value, thread_id: &str) -> Option<PendingClaudeControl> {
    let request_id = val.get("request_id")?.as_str()?.to_string();
    let req = val.get("request")?;
    let subtype = req.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if subtype != "can_use_tool" {
        return None;
    }

    let tool_name = req
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = req.get("input").cloned().unwrap_or_else(|| json!({}));
    let tool_use_id = req
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let permission_suggestions = req.get("permission_suggestions").cloned();

    let interaction = if tool_name == "AskUserQuestion" {
        let mut questions = Vec::new();
        if let Some(qs) = input.get("questions").and_then(|q| q.as_array()) {
            for q in qs {
                let q_text = q
                    .get("question")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let header = q
                    .get("header")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Question")
                    .to_string();
                let multi_select = q
                    .get("multiSelect")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let options = q
                    .get("options")
                    .and_then(|o| o.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|opt| {
                                let label = opt.get("label")?.as_str()?.to_string();
                                let description = opt
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                Some(QuestionOption { label, description })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                questions.push(QuestionItem {
                    id: q_text.clone(),
                    header,
                    question: q_text,
                    options,
                    multi_select,
                    is_other: true,
                    is_secret: false,
                });
            }
        }
        PendingInteraction::Question {
            id: request_id.clone(),
            thread_id: thread_id.to_string(),
            tool_call_id: tool_use_id,
            questions,
        }
    } else if tool_name == "ExitPlanMode" {
        let plan_text = input
            .get("plan")
            .and_then(|v| v.as_str())
            .unwrap_or("Review proposed plan and approve execution.")
            .to_string();
        PendingInteraction::PlanApproval {
            id: request_id.clone(),
            thread_id: thread_id.to_string(),
            tool_call_id: tool_use_id,
            plan_text,
        }
    } else {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let file_path = extract_file_path_from_input(&input);
        let reason = req
            .get("decision_reason")
            .and_then(|v| v.as_str())
            .or_else(|| input.get("description").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        PendingInteraction::Approval {
            id: request_id.clone(),
            thread_id: thread_id.to_string(),
            tool_call_id: tool_use_id,
            tool_name: tool_name.clone(),
            title: format!("Allow {}", tool_name),
            command,
            file_path,
            diff: None,
            reason,
            input: input.clone(),
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
        }
    };

    Some(PendingClaudeControl {
        request_id,
        tool_name,
        original_input: input,
        permission_suggestions,
        interaction,
    })
}

pub async fn run_claude_one_shot(
    project_path: &str,
    model: Option<&str>,
    prompt: &str,
    custom_binary_path: Option<&str>,
) -> Result<String, String> {
    let bin_path = find_cli_binary(&["claude"], custom_binary_path)
        .await
        .ok_or_else(|| "Claude Code CLI ('claude') not found.".to_string())?;

    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--no-session-persistence".to_string(),
        "--tools".to_string(),
        "".to_string(),
    ];
    if let Some(m) = model {
        if !m.trim().is_empty() && m != "default" {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
    }
    args.push(prompt.to_string());

    let out = timeout(
        Duration::from_secs(60),
        spawn_cli_command(&bin_path, &args, project_path)
            .await
            .output(),
    )
    .await
    .map_err(|_| "Claude one-shot prompt timed out".to_string())?
    .map_err(|e| format!("Failed to run Claude: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Claude failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Ok(val) = serde_json::from_str::<Value>(&stdout) {
        if let Some(res) = val.get("result").and_then(|v| v.as_str()) {
            return Ok(res.trim().to_string());
        }
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_ask_user_question_control_request() {
        let raw = json!({
            "type": "control_request",
            "request_id": "req_q1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "tool_use_id": "toolu_123",
                "input": {
                    "questions": [{
                        "question": "Which LaTeX engine?",
                        "header": "Compiler",
                        "multiSelect": false,
                        "options": [
                            {"label": "XeLaTeX", "description": "Unicode support"},
                            {"label": "pdfLaTeX", "description": "Classic"}
                        ]
                    }]
                }
            }
        });
        let parsed = parse_claude_control_request(&raw, "thread_1").unwrap();
        match parsed.interaction {
            PendingInteraction::Question { questions, .. } => {
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].header, "Compiler");
                assert_eq!(questions[0].options.len(), 2);
            }
            _ => panic!("expected Question interaction"),
        }
    }

    #[test]
    fn parses_claude_rate_limit_and_result_usage() {
        let rl = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "rateLimitType": "five_hour",
                "utilization": 0.82,
                "resetsAt": 1795000000
            }
        });
        let snap = parse_claude_rate_limit(&rl, None).unwrap();
        assert_eq!(snap.windows.len(), 1);
        assert!((snap.windows[0].used_percent.unwrap() - 82.0).abs() < 0.01);

        let mut usage = TokenUsageSnapshot::default();
        let res = json!({
            "type": "result",
            "total_cost_usd": 0.042,
            "usage": {
                "input_tokens": 1200,
                "output_tokens": 300,
                "cache_read_input_tokens": 4000,
                "cache_creation_input_tokens": 500
            },
            "modelUsage": {
                "claude-sonnet-5-5": {
                    "inputTokens": 1200,
                    "outputTokens": 300,
                    "cacheReadInputTokens": 4000,
                    "cacheCreationInputTokens": 500,
                    "costUSD": 0.042,
                    "contextWindow": 200000
                }
            }
        });
        apply_claude_result_usage(&mut usage, &res);
        assert_eq!(usage.context_window_tokens, Some(200000));
        assert_eq!(usage.model_usage.len(), 1);
        assert!((usage.total_cost_usd.unwrap() - 0.042).abs() < 0.0001);
    }
}
