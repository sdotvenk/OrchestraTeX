use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProviderId {
    Claude,
    Codex,
    Antigravity,
    CustomAcp,
}

impl AgentProviderId {
    pub fn display_name(&self) -> &'static str {
        match self {
            AgentProviderId::Claude => "Claude Code",
            AgentProviderId::Codex => "Codex",
            AgentProviderId::Antigravity => "Antigravity",
            AgentProviderId::CustomAcp => "Custom ACP",
        }
    }

    pub fn login_command(&self) -> &'static str {
        match self {
            AgentProviderId::Claude => "claude auth login",
            AgentProviderId::Codex => "codex login",
            AgentProviderId::Antigravity => "agy acp --login",
            AgentProviderId::CustomAcp => "",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionMode {
    #[default]
    Default,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    ApprovalRequired,
    #[default]
    AutoAcceptEdits,
    FullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCustomConfig {
    pub provider_id: Option<AgentProviderId>,
    pub binary_path: Option<String>,
    pub custom_command: Option<String>,
    pub custom_args: Option<Vec<String>>,
    pub custom_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub supports_effort: bool,
    pub supported_effort_levels: Vec<String>,
    pub default_effort: Option<String>,
    pub supports_fast_mode: bool,
    pub is_default: bool,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInfo {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub email: Option<String>,
    pub organization: Option<String>,
    pub plan_type: Option<String>,
    pub subscription_type: Option<String>,
    pub api_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub status: Option<String>,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitsSnapshot {
    pub provider_id: AgentProviderId,
    pub updated_at: i64,
    pub plan_type: Option<String>,
    pub windows: Vec<RateLimitWindow>,
    pub credits_balance: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokenUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: Option<f64>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub context_used_tokens: u64,
    pub context_window_tokens: Option<u64>,
    pub total_cost_usd: Option<f64>,
    pub model_usage: Vec<ModelTokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: AgentProviderId,
    pub name: String,
    pub transport: String, // "cli-stream" | "app-server" | "acp"
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub authenticated: bool,
    pub auth_error: Option<String>,
    pub login_command: String,
    pub account: Option<AccountInfo>,
    pub models: Vec<ModelInfo>,
    pub commands: Vec<SlashCommandInfo>,
    pub rate_limits: Option<RateLimitsSnapshot>,
    pub supports_steer: bool,
    pub supports_fork: bool,
    pub supports_compact: bool,
    pub supports_questions: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub data_url: Option<String>,
    pub file_path: Option<String>,
    pub mime: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub is_other: bool,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingInteraction {
    #[serde(rename_all = "camelCase")]
    Question {
        id: String,
        thread_id: String,
        tool_call_id: Option<String>,
        questions: Vec<QuestionItem>,
    },
    #[serde(rename_all = "camelCase")]
    Approval {
        id: String,
        thread_id: String,
        tool_call_id: Option<String>,
        tool_name: String,
        title: String,
        command: Option<String>,
        file_path: Option<String>,
        diff: Option<String>,
        reason: Option<String>,
        input: serde_json::Value,
        options: Vec<PermissionOption>,
    },
    #[serde(rename_all = "camelCase")]
    PlanApproval {
        id: String,
        thread_id: String,
        tool_call_id: Option<String>,
        plan_text: String,
    },
}

impl PendingInteraction {
    pub fn id(&self) -> &str {
        match self {
            PendingInteraction::Question { id, .. } => id,
            PendingInteraction::Approval { id, .. } => id,
            PendingInteraction::PlanApproval { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InteractionResponse {
    #[serde(rename_all = "camelCase")]
    QuestionAnswer {
        answers: HashMap<String, Vec<String>>,
        dismissed: bool,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalDecision {
        decision: String, // "allow_once" | "allow_session" | "deny"
        option_id: Option<String>,
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PlanDecision {
        approved: bool,
        feedback: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTaskItem {
    pub id: String,
    pub content: String,
    pub status: String, // "pending" | "in_progress" | "completed" | "cancelled"
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentPart {
    #[serde(rename_all = "camelCase")]
    Text { id: String, text: String },
    #[serde(rename_all = "camelCase")]
    Reasoning { id: String, text: String },
    #[serde(rename_all = "camelCase")]
    Tool {
        id: String,
        call_id: String,
        tool: String,
        title: Option<String>,
        status: String, // "pending" | "running" | "completed" | "error"
        input: serde_json::Value,
        output: Option<String>,
        error: Option<String>,
        file_path: Option<String>,
        diff: Option<String>,
        parent_tool_call_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        id: String,
        url: String,
        mime: String,
        filename: Option<String>,
    },
}

impl AgentPart {
    pub fn id(&self) -> &str {
        match self {
            AgentPart::Text { id, .. } => id,
            AgentPart::Reasoning { id, .. } => id,
            AgentPart::Tool { id, .. } => id,
            AgentPart::Image { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub provider_id: Option<AgentProviderId>,
    pub model: Option<String>,
    pub parts: Vec<AgentPart>,
    pub changed_files: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub project_path: String,
    pub title: String,
    pub provider_id: AgentProviderId,
    pub provider_session_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub interaction_mode: InteractionMode,
    pub runtime_mode: RuntimeMode,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub last_preview: Option<String>,
    pub status: String, // "idle" | "running" | "waiting_input" | "error"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub summary: ThreadSummary,
    pub messages: Vec<AgentMessage>,
    pub usage: Option<TokenUsageSnapshot>,
    pub tasks: Vec<PlanTaskItem>,
    pub pending_interaction: Option<PendingInteraction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentStreamEvent {
    #[serde(rename_all = "camelCase")]
    ThreadUpdated { thread: ThreadSummary },
    #[serde(rename_all = "camelCase")]
    MessageAdded {
        thread_id: String,
        message: AgentMessage,
    },
    #[serde(rename_all = "camelCase")]
    PartUpdated {
        thread_id: String,
        message_id: String,
        part: AgentPart,
    },
    #[serde(rename_all = "camelCase")]
    PartDelta {
        thread_id: String,
        message_id: String,
        part_id: String,
        part_type: String, // "text" | "reasoning" | "tool_output"
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnStatus {
        thread_id: String,
        status: String, // "idle" | "running" | "waiting_input" | "retry" | "error"
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TokenUsageUpdated {
        thread_id: String,
        usage: TokenUsageSnapshot,
    },
    #[serde(rename_all = "camelCase")]
    RateLimitsUpdated {
        provider_id: AgentProviderId,
        rate_limits: RateLimitsSnapshot,
    },
    #[serde(rename_all = "camelCase")]
    PlanUpdated {
        thread_id: String,
        tasks: Vec<PlanTaskItem>,
    },
    #[serde(rename_all = "camelCase")]
    InteractionRequested {
        thread_id: String,
        interaction: PendingInteraction,
    },
    #[serde(rename_all = "camelCase")]
    InteractionResolved {
        thread_id: String,
        interaction_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CommandsUpdated {
        provider_id: AgentProviderId,
        commands: Vec<SlashCommandInfo>,
    },
    #[serde(rename_all = "camelCase")]
    ProviderLog {
        provider_id: AgentProviderId,
        thread_id: Option<String>,
        stream: String, // "stderr" | "info"
        message: String,
    },
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
