import type { FailureCode, Handoff, RunStatus, TaskKind, TaskStatus, ToolCallStatus, ApprovalStatus } from "@agentos/contracts";
import { Prisma, type PrismaClient } from "@agentos/db";
import type { ModelMessage, ToolCallRequest } from "@agentos/providers";
import type { AgentConfig, ApprovalRecord, AssistantTurn, PipelineStepSpec, RunRecord, RunStore, TaskRecord, ToolCallRecord } from "@agentos/runtime";
import { jsonSafe } from "../events/bus";

type TaskRow = Prisma.TaskGetPayload<object>;
type RunRow = Prisma.AgentRunGetPayload<object>;
type ToolCallRow = Prisma.ToolCallGetPayload<object>;

export function toTaskRecord(t: TaskRow): TaskRecord {
  return {
    id: t.id,
    organizationId: t.organizationId,
    kind: t.kind as TaskKind,
    title: t.title,
    instruction: t.instruction,
    status: t.status as TaskStatus,
    agentId: t.agentId,
    conversationId: t.conversationId,
    parentTaskId: t.parentTaskId,
    stepIndex: t.stepIndex,
    pipelineSpec: (t.pipelineSpec as PipelineStepSpec[] | null) ?? null,
    handoffInput: (t.handoffInput as Handoff | null) ?? null,
    result: t.result,
    resultData: t.resultData ?? null,
    failureCode: (t.failureCode as FailureCode | null) ?? null,
    failureMessage: t.failureMessage,
    cancelRequestedAt: t.cancelRequestedAt,
    maxCostUsd: t.maxCostUsd === null ? null : Number(t.maxCostUsd),
  };
}

function toRunRecord(r: RunRow): RunRecord {
  return {
    id: r.id,
    organizationId: r.organizationId,
    taskId: r.taskId,
    agentId: r.agentId,
    provider: r.provider,
    model: r.model,
    status: r.status as RunStatus,
    iterations: r.iterations,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: Number(r.costUsd),
  };
}

function toToolCallRecord(t: ToolCallRow): ToolCallRecord {
  return {
    id: t.id,
    runId: t.runId,
    providerCallId: t.providerCallId,
    toolName: t.toolName,
    arguments: t.arguments,
    status: t.status as ToolCallStatus,
    output: t.output ?? null,
    error: t.error,
    risk: t.risk,
  };
}

const nullableJson = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : jsonSafe(v));

const TERMINAL_TOOL_STATUSES = ["succeeded", "failed", "rejected", "invalid", "approval_rejected"];

function toolCallPatch(patch: Parameters<RunStore["updateToolCall"]>[2]) {
  return {
    status: patch.status,
    ...(patch.output !== undefined ? { output: nullableJson(patch.output) } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(TERMINAL_TOOL_STATUSES.includes(patch.status) ? { completedAt: new Date() } : {}),
  };
}

/** Prisma implementation of the runtime persistence port. Every query is org-scoped. */
export class PrismaRunStore implements RunStore {
  constructor(private readonly db: PrismaClient) {}

  async getTask(orgId: string, taskId: string) {
    const t = await this.db.task.findFirst({ where: { id: taskId, organizationId: orgId } });
    return t ? toTaskRecord(t) : null;
  }

  async updateTask(orgId: string, taskId: string, patch: Parameters<RunStore["updateTask"]>[2]) {
    const { resultData, ...rest } = patch;
    await this.db.task.updateMany({
      where: { id: taskId, organizationId: orgId },
      data: { ...rest, ...(resultData !== undefined ? { resultData: nullableJson(resultData) } : {}) },
    });
  }

  async requestCancel(orgId: string, taskId: string) {
    await this.db.task.updateMany({ where: { id: taskId, organizationId: orgId, cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
  }

  async listChildTasks(orgId: string, parentTaskId: string) {
    const rows = await this.db.task.findMany({ where: { organizationId: orgId, parentTaskId }, orderBy: { stepIndex: "asc" } });
    return rows.map(toTaskRecord);
  }

  async createChildTask(orgId: string, input: Parameters<RunStore["createChildTask"]>[1]) {
    const task = await this.db.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({ data: { organizationId: orgId, agentId: input.agentId, title: input.title } });
      if (input.status !== "skipped") {
        await tx.message.create({ data: { organizationId: orgId, conversationId: conversation.id, role: "user", content: input.instruction } });
      }
      return tx.task.create({
        data: {
          organizationId: orgId,
          kind: "pipeline_step",
          title: input.title,
          instruction: input.instruction,
          status: input.status ?? "queued",
          agentId: input.agentId,
          conversationId: conversation.id,
          parentTaskId: input.parentTaskId,
          stepIndex: input.stepIndex,
          handoffInput: nullableJson(input.handoffInput),
        },
      });
    });
    return toTaskRecord(task);
  }

  async getAgent(orgId: string, agentId: string): Promise<AgentConfig | null> {
    const a = await this.db.agent.findFirst({
      where: { id: agentId, organizationId: orgId },
      include: { skills: { include: { skill: true } } },
    });
    if (!a) return null;
    return {
      id: a.id,
      organizationId: a.organizationId,
      name: a.name,
      role: a.role,
      instructions: a.instructions,
      provider: a.provider,
      model: a.model,
      allowedTools: a.allowedTools,
      maxIterations: a.maxIterations,
      maxRunCostUsd: Number(a.maxRunCostUsd),
      maxRunTokens: a.maxRunTokens,
      status: a.status === "paused" ? "paused" : "active",
      skills: a.skills
        .map((s) => ({ name: s.skill.name, version: s.skill.version, instructions: s.skill.instructions }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    };
  }

  async createRun(orgId: string, input: { taskId: string; agentId: string; provider: string; model: string }) {
    return toRunRecord(await this.db.agentRun.create({ data: { organizationId: orgId, ...input } }));
  }

  async getRun(orgId: string, runId: string) {
    const r = await this.db.agentRun.findFirst({ where: { id: runId, organizationId: orgId } });
    return r ? toRunRecord(r) : null;
  }

  async getLatestRun(orgId: string, taskId: string) {
    const r = await this.db.agentRun.findFirst({ where: { taskId, organizationId: orgId }, orderBy: { startedAt: "desc" } });
    return r ? toRunRecord(r) : null;
  }

  async updateRun(orgId: string, runId: string, patch: Parameters<RunStore["updateRun"]>[2]) {
    const { costUsd, ...rest } = patch;
    await this.db.agentRun.updateMany({
      where: { id: runId, organizationId: orgId },
      data: { ...rest, ...(costUsd !== undefined ? { costUsd: new Prisma.Decimal(costUsd.toFixed(6)) } : {}) },
    });
  }

  async loadMessages(orgId: string, conversationId: string): Promise<ModelMessage[]> {
    const rows = await this.db.message.findMany({ where: { organizationId: orgId, conversationId }, orderBy: { seq: "asc" } });
    return rows.map((m): ModelMessage => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          toolCalls: (m.toolCalls as ToolCallRequest[] | null) ?? [],
          ...(m.providerState !== null ? { providerState: m.providerState } : {}),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", toolCallId: m.toolCallId ?? "", toolName: m.toolName ?? "", content: m.content, isError: m.isError };
      }
      return { role: "user", content: m.content };
    });
  }

  async appendMessage(orgId: string, conversationId: string, runId: string | null, m: ModelMessage) {
    await this.db.message.create({
      data: {
        organizationId: orgId,
        conversationId,
        runId,
        role: m.role,
        content: m.content,
        ...(m.role === "assistant"
          ? { toolCalls: jsonSafe(m.toolCalls), providerState: nullableJson(m.providerState) }
          : {}),
        ...(m.role === "tool" ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError } : {}),
      },
    });
  }

  async createToolCall(orgId: string, input: Parameters<RunStore["createToolCall"]>[1]) {
    const existing = await this.db.toolCall.findUnique({ where: { runId_providerCallId: { runId: input.runId, providerCallId: input.call.id } } });
    if (existing) return { record: toToolCallRecord(existing), created: false };
    try {
      const row = await this.db.toolCall.create({
        data: {
          organizationId: orgId,
          runId: input.runId,
          taskId: input.taskId,
          providerCallId: input.call.id,
          toolName: input.call.name.slice(0, 200),
          arguments: jsonSafe(input.call.arguments),
          status: input.status,
          risk: input.risk,
        },
      });
      return { record: toToolCallRecord(row), created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const row = await this.db.toolCall.findUniqueOrThrow({ where: { runId_providerCallId: { runId: input.runId, providerCallId: input.call.id } } });
        return { record: toToolCallRecord(row), created: false };
      }
      throw err;
    }
  }

  async updateToolCall(orgId: string, id: string, patch: Parameters<RunStore["updateToolCall"]>[2]) {
    await this.db.toolCall.updateMany({ where: { id, organizationId: orgId }, data: toolCallPatch(patch) });
  }

  async getToolCall(orgId: string, id: string) {
    const row = await this.db.toolCall.findFirst({ where: { id, organizationId: orgId } });
    return row ? toToolCallRecord(row) : null;
  }

  /** Single conditional UPDATE: Postgres row locking makes this an atomic compare-and-set. */
  async transitionToolCall(orgId: string, id: string, from: ToolCallStatus[], patch: Parameters<RunStore["transitionToolCall"]>[3]) {
    const r = await this.db.toolCall.updateMany({ where: { id, organizationId: orgId, status: { in: from } }, data: toolCallPatch(patch) });
    return r.count === 1;
  }

  async getAssistantTurns(orgId: string, conversationId: string, runId: string): Promise<AssistantTurn[]> {
    const rows = await this.db.message.findMany({
      where: { organizationId: orgId, conversationId, runId, role: "assistant" },
      orderBy: { seq: "asc" },
      select: { content: true, toolCalls: true },
    });
    return rows.map((m) => ({ content: m.content, toolCalls: (m.toolCalls as ToolCallRequest[] | null) ?? [] }));
  }

  async hasToolResult(orgId: string, conversationId: string, providerCallId: string) {
    return (await this.db.message.count({ where: { organizationId: orgId, conversationId, role: "tool", toolCallId: providerCallId } })) > 0;
  }

  async getTreeSpend(orgId: string, rootTaskId: string) {
    const r = await this.db.agentRun.aggregate({
      where: { organizationId: orgId, OR: [{ taskId: rootTaskId }, { task: { parentTaskId: rootTaskId } }] },
      _sum: { costUsd: true },
    });
    return Number(r._sum.costUsd ?? 0);
  }

  async listToolCalls(orgId: string, runId: string, status?: ToolCallStatus) {
    const rows = await this.db.toolCall.findMany({ where: { organizationId: orgId, runId, ...(status ? { status } : {}) }, orderBy: { createdAt: "asc" } });
    return rows.map(toToolCallRecord);
  }

  async createApproval(orgId: string, input: Parameters<RunStore["createApproval"]>[1]): Promise<ApprovalRecord> {
    // Idempotent on toolCallId (unique): a retried step gets the approval it already created.
    const a = await this.db.approval.upsert({
      where: { toolCallId: input.toolCallId },
      create: { organizationId: orgId, ...input, arguments: jsonSafe(input.arguments) },
      update: {},
    });
    if (a.organizationId !== orgId) throw new Error("approval belongs to another organization");
    return { id: a.id, organizationId: orgId, toolCallId: a.toolCallId, taskId: a.taskId, runId: a.runId, status: a.status as ApprovalStatus, decisionNote: a.decisionNote };
  }

  async getApprovalByToolCall(orgId: string, toolCallId: string): Promise<ApprovalRecord | null> {
    const a = await this.db.approval.findFirst({ where: { organizationId: orgId, toolCallId } });
    return a
      ? { id: a.id, organizationId: orgId, toolCallId: a.toolCallId, taskId: a.taskId, runId: a.runId, status: a.status as ApprovalStatus, decisionNote: a.decisionNote }
      : null;
  }

  async closePendingApprovals(orgId: string, taskId: string, note: string) {
    const r = await this.db.approval.updateMany({
      where: { organizationId: orgId, taskId, status: "pending" },
      data: { status: "rejected", decisionNote: note, decidedAt: new Date() },
    });
    return r.count;
  }

  async recordUsage(orgId: string, input: Parameters<RunStore["recordUsage"]>[1]) {
    await this.db.usageRecord.create({
      data: { organizationId: orgId, ...input, costUsd: new Prisma.Decimal(input.costUsd.toFixed(6)) },
    });
  }
}
