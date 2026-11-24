export type AgentProviderId = "claude" | "codex" | "antigravity" | "custom-acp";

export type InteractionMode = "default" | "plan";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export type ThreadStatus = "idle" | "running" | "waiting_input" | "error";

export type TurnStatusValue = "idle" | "running" | "waiting_input" | "retry" | "error";

export interface ProviderCustomConfig {
  providerId?: AgentProviderId;
  binaryPath?: string;
  customCommand?: string;
  customArgs?: string[];
  customName?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string | null;
  supportsEffort: boolean;
  supportedEffortLevels: string[];
  defaultEffort?: string | null;
  supportsFastMode: boolean;
  isDefault: boolean;
  contextWindow?: number | null;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string | null;
}

export interface AccountInfo {
  email?: string | null;
  organization?: string | null;
  planType?: string | null;
  subscriptionType?: string | null;
  apiProvider?: string | null;
}

export interface RateLimitWindow {
  id: string;
  label: string;
  usedPercent?: number | null;
  status?: string | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RateLimitsSnapshot {
  providerId: AgentProviderId;
  updatedAt: number;
  planType?: string | null;
  windows: RateLimitWindow[];
  creditsBalance?: string | null;
  note?: string | null;
}

export interface ModelTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number | null;
  contextWindow?: number | null;
}

export interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  contextUsedTokens: number;
  contextWindowTokens?: number | null;
  totalCostUsd?: number | null;
  modelUsage: ModelTokenUsage[];
}

export interface ProviderStatus {
  id: AgentProviderId;
  name: string;
  transport: "cli-stream" | "app-server" | "acp" | string;
  installed: boolean;
  binaryPath?: string | null;
  version?: string | null;
  authenticated: boolean;
  authError?: string | null;
  loginCommand: string;
  account?: AccountInfo | null;
  models: ModelInfo[];
  commands: SlashCommandInfo[];
  rateLimits?: RateLimitsSnapshot | null;
  supportsSteer: boolean;
  supportsFork: boolean;
  supportsCompact: boolean;
  supportsQuestions: boolean;
}

export interface AttachmentInput {
  dataUrl?: string;
  filePath?: string;
  mime: string;
  filename: string;
}

export interface QuestionOption {
  label: string;
  description?: string | null;
}

export interface QuestionItem {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  isOther: boolean;
  isSecret: boolean;
}

export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}

export type PendingInteraction =
  | {
      kind: "question";
      id: string;
      threadId: string;
      toolCallId?: string | null;
      questions: QuestionItem[];
    }
  | {
      kind: "approval";
      id: string;
      threadId: string;
      toolCallId?: string | null;
      toolName: string;
      title: string;
      command?: string | null;
      filePath?: string | null;
      diff?: string | null;
      reason?: string | null;
      input: unknown;
      options: PermissionOption[];
    }
  | {
      kind: "planApproval";
      id: string;
      threadId: string;
      toolCallId?: string | null;
      planText: string;
    };

export type InteractionResponse =
  | {
      kind: "questionAnswer";
      answers: Record<string, string[]>;
      dismissed: boolean;
    }
  | {
      kind: "approvalDecision";
      decision: "allow_once" | "allow_session" | "deny";
      optionId?: string;
      reason?: string;
    }
  | {
      kind: "planDecision";
      approved: boolean;
      feedback?: string;
    };

export interface PlanTaskItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority?: string | null;
}

export type AgentPart =
  | {
      type: "text";
      id: string;
      text: string;
    }
  | {
      type: "reasoning";
      id: string;
      text: string;
    }
  | {
      type: "tool";
      id: string;
      callId: string;
      tool: string;
      title?: string | null;
      status: "pending" | "running" | "completed" | "error" | string;
      input: Record<string, unknown>;
      output?: string | null;
      error?: string | null;
      filePath?: string | null;
      diff?: string | null;
      parentToolCallId?: string | null;
    }
  | {
      type: "image";
      id: string;
      url: string;
      mime: string;
      filename?: string | null;
    };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | string;
  createdAt: number;
  completedAt?: number | null;
  providerId?: AgentProviderId | null;
  model?: string | null;
  parts: AgentPart[];
  changedFiles: string[];
  error?: string | null;
}

export interface ThreadSchedule {
  runAt: number;
  prompt: string;
  repeatIntervalMs?: number | null;
  lastResult?: string | null;
  lastRunAt?: number | null;
}

export interface ThreadSummary {
  id: string;
  projectPath: string;
  title: string;
  providerId: AgentProviderId;
  providerSessionId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  interactionMode: InteractionMode;
  runtimeMode: RuntimeMode;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastPreview?: string | null;
  status: ThreadStatus | string;
  workspacePath?: string | null;
  workspaceBranch?: string | null;
  parentThreadId?: string | null;
  schedule?: ThreadSchedule | null;
}

export interface AgentThread {
  summary: ThreadSummary;
  messages: AgentMessage[];
  usage?: TokenUsageSnapshot | null;
  tasks: PlanTaskItem[];
  pendingInteraction?: PendingInteraction | null;
}

export type AgentStreamEvent =
  | {
      type: "threadUpdated";
      thread: ThreadSummary;
    }
  | {
      type: "threadDeleted";
      projectPath: string;
      threadId: string;
    }
  | {
      type: "messageAdded";
      threadId: string;
      message: AgentMessage;
    }
  | {
      type: "partUpdated";
      threadId: string;
      messageId: string;
      part: AgentPart;
    }
  | {
      type: "partDelta";
      threadId: string;
      messageId: string;
      partId: string;
      partType: "text" | "reasoning" | "tool_output" | string;
      delta: string;
    }
  | {
      type: "turnStatus";
      threadId: string;
      status: TurnStatusValue | string;
      error?: string | null;
    }
  | {
      type: "tokenUsageUpdated";
      threadId: string;
      usage: TokenUsageSnapshot;
    }
  | {
      type: "rateLimitsUpdated";
      providerId: AgentProviderId;
      rateLimits: RateLimitsSnapshot;
    }
  | {
      type: "planUpdated";
      threadId: string;
      tasks: PlanTaskItem[];
    }
  | {
      type: "interactionRequested";
      threadId: string;
      interaction: PendingInteraction;
    }
  | {
      type: "interactionResolved";
      threadId: string;
      interactionId: string;
    }
  | {
      type: "commandsUpdated";
      providerId: AgentProviderId;
      commands: SlashCommandInfo[];
    }
  | {
      type: "providerLog";
      providerId: AgentProviderId;
      threadId?: string | null;
      stream: "stderr" | "info" | string;
      message: string;
    };

export interface QueuedMessage {
  id: string;
  threadId: string;
  content: string;
  attachments: AttachmentInput[];
  createdAt: number;
}

export interface PendingEdit {
  id: string;
  filePath: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status: "pending" | "accepted" | "rejected";
}

export interface ProviderCustomSettings {
  binaryPath: string;
  customCommand: string;
  customArgs: string;
  customName: string;
}

export interface AgentSettings {
  defaultProvider: AgentProviderId;
  defaultModelByProvider: Partial<Record<AgentProviderId, string>>;
  defaultEffortByProvider: Partial<Record<AgentProviderId, string>>;
  defaultInteractionMode: InteractionMode;
  defaultRuntimeMode: RuntimeMode;
  customProviders: Record<AgentProviderId, ProviderCustomSettings>;
}
