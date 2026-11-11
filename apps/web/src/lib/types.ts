import type { RunEvent, TaskStatus } from "@agentos/contracts";

export type { RunEvent, TaskStatus };

export interface Me {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string };
  role: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider: string;
  model: string;
  providerConfigured: boolean;
  isMock: boolean;
  allowedTools: string[];
  maxIterations: number;
  maxRunCostUsd: number;
  maxRunTokens: number | null;
  status: "active" | "paused";
  skills: { id: string; name: string; version: number }[];
  activeTasks?: number;
  createdAt: string;
}

export interface AgentDetail extends Agent {
  recentTasks: { id: string; title: string; kind: string; status: TaskStatus; createdAt: string }[];
  usage: { modelCalls: number; costUsd: number; inputTokens: number; outputTokens: number };
}

export interface Provider {
  id: string;
  label: string;
  configured: boolean;
  isMock: boolean;
  endpoint: string | null;
  models: { id: string; label: string; inputPerMTok: number; outputPerMTok: number; priceSource: "published" | "unverified" | "mock" }[];
  discovery: ModelDiscovery | null;
  credential: CredentialInfo | null;
}

export interface CredentialInfo {
  provider: string;
  source: "organization" | "deployment" | "none";
  keyHint: string | null;
  status: "unverified" | "valid" | "invalid" | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  kekId: string | null;
  updatedAt: string | null;
}

export interface CredentialsResponse {
  storage: { enabled: boolean; kms: string | null; developmentOnly: boolean };
  allowDeploymentKeys: boolean;
  items: CredentialInfo[];
}

export interface SystemHealth {
  engine: "temporal" | "inprocess";
  taskQueue: string | null;
  temporal: { reachable: boolean; workflowPollers: number; activityPollers: number; error?: string } | null;
  workers: { id: string; hostname?: string; pid?: number; status: string; activeActivities: number; lastSeenAt: string; startedAt: string; healthy: boolean; version: string }[];
  healthyWorkers: number;
  events: { crossInstance: boolean; listenerConnected: boolean; reconnects: number };
  credentials: { enabled: boolean; kms: string | null; developmentOnly: boolean };
}

export interface SystemMetrics {
  queueLatencyMs: { p50: number | null; p95: number | null; samples: number };
  runDurationMs: { p50: number | null; p95: number | null; samples: number };
  modelLatencyMs: { provider: string; p50: number | null; p95: number | null; samples: number }[];
  failuresByCode: { code: string; count: number }[];
  retries: { model: number; activity: number };
}

export interface Diagnostics {
  checkedAt: string;
  engine: string;
  issues: { kind: string; taskId?: string; detail: string; hint: string }[];
}

export interface WorkflowInfo {
  engine: "temporal" | "inprocess";
  workflowId: string | null;
  status: string;
  historyLength?: number;
  startTime?: string | null;
  closeTime?: string | null;
  pendingActivities: { activityType: string; attempt: number; state: string; lastFailure?: string | null; lastHeartbeatTime?: string | null }[];
}

export interface TaskWorkflow {
  taskId: string;
  status: string;
  workflowId: string | null;
  workflow: WorkflowInfo | null;
  children: { taskId: string; stepIndex: number | null; status: string; workflow: WorkflowInfo | null }[];
  retryHistory: { seq: string; type: string; taskId: string; payload: Record<string, unknown>; createdAt: string }[];
}

export interface ModelDiscovery {
  provider: string;
  checkedAt: string;
  ok: boolean;
  error: { code: string; message: string; status?: number } | null;
  catalog: { id: string; label: string; availableOnAccount: boolean | null; priceSource: string }[];
  listedCount: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: "safe" | "sensitive" | "dangerous";
  requiresApproval: boolean;
}

export interface Skill {
  id: string;
  name: string;
  version: number;
  description: string;
  instructions: string;
  agentIds: string[];
}

export interface Task {
  id: string;
  kind: "single" | "pipeline" | "pipeline_step" | "chat";
  title: string;
  instruction: string;
  status: TaskStatus;
  agent: { id: string; name: string } | null;
  conversationId: string | null;
  parentTaskId: string | null;
  stepIndex: number | null;
  result: string | null;
  resultData: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  retryable: boolean;
  retryOfId: string | null;
  workflowId?: string | null;
  maxCostUsd?: number | null;
  handoffInput: { fromAgentName: string; summary: string; data: unknown } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: unknown;
  status: string;
  risk: string | null;
  output: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  isMock: boolean;
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  toolCalls: ToolCall[];
}

export interface TaskDetail extends Task {
  pipelineSpec: { agentId: string; instruction: string }[] | null;
  children: Task[];
  runs: Run[];
  approvals: { id: string; toolName: string; status: string; reason: string; taskId: string; decisionNote: string | null }[];
}

export interface Approval {
  id: string;
  status: "pending" | "approved" | "rejected";
  toolName: string;
  risk: string | null;
  arguments: unknown;
  reason: string;
  agent: { id: string; name: string };
  task: { id: string; title: string; rootTaskId: string };
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface Dashboard {
  agents: number;
  tasks: { active: number; queued: number; running: number; awaitingApproval: number; completed: number; failed: number; cancelled: number };
  pendingApprovals: number;
  usage: {
    modelCalls: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    live: { modelCalls: number; costUsd: number };
    mock: { modelCalls: number; costUsd: number };
  };
  providers: { id: string; label: string; configured: boolean; isMock: boolean; credentialSource: "organization" | "deployment" | "none" | null }[];
}

export interface UsageSummary {
  total: { modelCalls: number; costUsd: number; inputTokens: number; outputTokens: number };
  byModel: { provider: string; model: string; isMock: boolean; priceSource: string; modelCalls: number; costUsd: number; inputTokens: number; outputTokens: number }[];
  byAgent: { agentId: string; agentName: string; modelCalls: number; costUsd: number }[];
}

export interface Conversation {
  id: string;
  title: string;
  agent: { id: string; name: string; provider: string; model: string; isMock: boolean };
  activeTask: { id: string; status: string } | null;
  messages: {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls: { id: string; name: string; arguments: unknown }[];
    toolName: string | null;
    isError: boolean;
    createdAt: string;
  }[];
}
