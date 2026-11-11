import type { RunEvent } from "@agentos/contracts";
import type { ModelMessage } from "@agentos/providers";
import type {
  AgentConfig,
  ApprovalRecord,
  EventSink,
  NewEvent,
  RunRecord,
  RunStore,
  TaskRecord,
  ToolCallRecord,
} from "./store";

let seq = 0;
const nextId = (p: string) => `${p}_${(++seq).toString(36)}`;

/**
 * In-memory RunStore + EventSink used by unit tests. Mirrors the org-scoping
 * contract of the Prisma implementation.
 */
export class MemoryRunStore implements RunStore, EventSink {
  tasks = new Map<string, TaskRecord>();
  agents = new Map<string, AgentConfig>();
  runs = new Map<string, RunRecord>();
  messages = new Map<string, ModelMessage[]>();
  toolCalls = new Map<string, ToolCallRecord & { organizationId: string; taskId: string }>();
  approvals = new Map<string, ApprovalRecord>();
  usage: { organizationId: string; runId: string; costUsd: number; inputTokens: number; outputTokens: number; cachedTokens: number }[] = [];
  events: RunEvent[] = [];
  transient: NewEvent[] = [];
  private eventSeq = 0;

  addAgent(a: Partial<AgentConfig> & Pick<AgentConfig, "organizationId" | "name">): AgentConfig {
    const agent: AgentConfig = {
      id: nextId("agent"),
      role: "Test agent",
      instructions: "",
      provider: "mock",
      model: "mock-scripted",
      allowedTools: ["calculator"],
      maxIterations: 5,
      maxRunCostUsd: 1,
      maxRunTokens: null,
      status: "active",
      skills: [],
      ...a,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  addTask(t: Partial<TaskRecord> & Pick<TaskRecord, "organizationId" | "instruction">): TaskRecord {
    const conversationId = t.conversationId ?? (t.kind === "pipeline" ? null : nextId("conv"));
    const task: TaskRecord = {
      id: nextId("task"),
      kind: "single",
      title: "Test task",
      status: "queued",
      agentId: null,
      conversationId,
      parentTaskId: null,
      stepIndex: null,
      pipelineSpec: null,
      handoffInput: null,
      result: null,
      resultData: null,
      failureCode: null,
      failureMessage: null,
      cancelRequestedAt: null,
      ...t,
    };
    this.tasks.set(task.id, task);
    if (conversationId) this.messages.set(conversationId, [{ role: "user", content: task.instruction }]);
    return task;
  }

  private own<T extends { organizationId: string }>(row: T | undefined, orgId: string): T | null {
    return row && row.organizationId === orgId ? row : null;
  }

  async getTask(orgId: string, id: string) {
    const t = this.own(this.tasks.get(id), orgId);
    return t ? { ...t } : null;
  }
  async updateTask(orgId: string, id: string, patch: Partial<TaskRecord>) {
    const t = this.own(this.tasks.get(id), orgId);
    if (t) Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "startedAt" && k !== "completedAt")));
  }
  async requestCancel(orgId: string, id: string) {
    const t = this.own(this.tasks.get(id), orgId);
    if (t && !t.cancelRequestedAt) t.cancelRequestedAt = new Date();
  }
  async listChildTasks(orgId: string, parentId: string) {
    return [...this.tasks.values()].filter((t) => t.organizationId === orgId && t.parentTaskId === parentId).map((t) => ({ ...t }));
  }
  async createChildTask(orgId: string, input: Parameters<RunStore["createChildTask"]>[1]) {
    return this.addTask({
      organizationId: orgId,
      kind: "pipeline_step",
      parentTaskId: input.parentTaskId,
      stepIndex: input.stepIndex,
      agentId: input.agentId,
      title: input.title,
      instruction: input.instruction,
      handoffInput: input.handoffInput,
      status: input.status ?? "queued",
    });
  }
  async getAgent(orgId: string, id: string) {
    return this.own(this.agents.get(id), orgId);
  }
  async createRun(orgId: string, input: { taskId: string; agentId: string; provider: string; model: string }) {
    const run: RunRecord = { id: nextId("run"), organizationId: orgId, status: "running", iterations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ...input };
    this.runs.set(run.id, run);
    return { ...run };
  }
  async getRun(orgId: string, id: string) {
    const r = this.own(this.runs.get(id), orgId);
    return r ? { ...r } : null;
  }
  async getLatestRun(orgId: string, taskId: string) {
    const runs = [...this.runs.values()].filter((r) => r.organizationId === orgId && r.taskId === taskId);
    const r = runs[runs.length - 1];
    return r ? { ...r } : null;
  }
  async updateRun(orgId: string, id: string, patch: Partial<RunRecord>) {
    const r = this.own(this.runs.get(id), orgId);
    if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([k]) => ["status", "iterations", "inputTokens", "outputTokens", "costUsd"].includes(k))));
  }
  async loadMessages(_orgId: string, conversationId: string) {
    return [...(this.messages.get(conversationId) ?? [])];
  }
  async appendMessage(_orgId: string, conversationId: string, _runId: string | null, m: ModelMessage) {
    this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), m]);
  }
  async createToolCall(orgId: string, input: Parameters<RunStore["createToolCall"]>[1]) {
    const existing = [...this.toolCalls.values()].find((t) => t.runId === input.runId && t.providerCallId === input.call.id);
    if (existing) return { record: { ...existing }, created: false };
    const rec = {
      id: nextId("tc"),
      organizationId: orgId,
      taskId: input.taskId,
      runId: input.runId,
      providerCallId: input.call.id,
      toolName: input.call.name,
      arguments: input.call.arguments,
      status: input.status,
      output: null,
      error: null,
    };
    this.toolCalls.set(rec.id, rec);
    return { record: { ...rec }, created: true };
  }
  async updateToolCall(orgId: string, id: string, patch: Parameters<RunStore["updateToolCall"]>[2]) {
    const t = this.own(this.toolCalls.get(id), orgId);
    if (t) Object.assign(t, { status: patch.status, ...(patch.output !== undefined ? { output: patch.output } : {}), ...(patch.error !== undefined ? { error: patch.error } : {}) });
  }
  async listToolCalls(orgId: string, runId: string, status?: string) {
    return [...this.toolCalls.values()].filter((t) => t.organizationId === orgId && t.runId === runId && (!status || t.status === status));
  }
  async createApproval(orgId: string, input: Parameters<RunStore["createApproval"]>[1]) {
    const a: ApprovalRecord = { id: nextId("appr"), organizationId: orgId, toolCallId: input.toolCallId, taskId: input.taskId, runId: input.runId, status: "pending", decisionNote: null };
    this.approvals.set(a.id, a);
    return { ...a };
  }
  async getApprovalByToolCall(orgId: string, toolCallId: string) {
    const a = [...this.approvals.values()].find((x) => x.organizationId === orgId && x.toolCallId === toolCallId);
    return a ? { ...a } : null;
  }
  async closePendingApprovals(orgId: string, taskId: string, note: string) {
    let n = 0;
    for (const a of this.approvals.values()) {
      if (a.organizationId === orgId && a.taskId === taskId && a.status === "pending") {
        a.status = "rejected";
        a.decisionNote = note;
        n++;
      }
    }
    return n;
  }
  async recordUsage(orgId: string, input: Parameters<RunStore["recordUsage"]>[1]) {
    this.usage.push({ organizationId: orgId, runId: input.runId, costUsd: input.costUsd, inputTokens: input.inputTokens, outputTokens: input.outputTokens, cachedTokens: input.cachedTokens });
  }

  /** Test helper: decide an approval as a human would through the API. */
  decide(approvalId: string, approve: boolean, note?: string) {
    const a = this.approvals.get(approvalId);
    if (!a) throw new Error("no approval");
    a.status = approve ? "approved" : "rejected";
    a.decisionNote = note ?? null;
  }

  async emit(e: NewEvent) {
    const rootTaskId = this.rootOf(e.taskId);
    this.events.push({ ...e, seq: String(++this.eventSeq), rootTaskId, createdAt: new Date().toISOString() });
  }
  emitTransient(e: NewEvent) {
    this.transient.push(e);
  }
  private rootOf(taskId: string): string {
    let t = this.tasks.get(taskId);
    while (t?.parentTaskId) t = this.tasks.get(t.parentTaskId);
    return t?.id ?? taskId;
  }
}
