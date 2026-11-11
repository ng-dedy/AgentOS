import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RETRYABLE_FAILURES, TaskCreateSchema, TaskStatusSchema, TERMINAL_TASK_STATUSES, type FailureCode, type TaskStatus } from "@agentos/contracts";
import type { Prisma } from "@agentos/db";
import type { AppDeps } from "../app";
import { requireAuth } from "../auth/plugin";
import { readOrgEvents, readTreeEvents, toRunEvent } from "@agentos/platform";
import { lastEventId, streamEvents } from "../events/sse";
import { AppError, conflict, notFound, parse } from "../http/errors";
import { audit, idempotent, money } from "../http/support";
import { providersForOrg, readyProviders } from "../providers/status";

const ListQuery = z.object({
  status: TaskStatusSchema.optional(),
  agentId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type TaskRow = Prisma.TaskGetPayload<{ include: { agent: { select: { id: true; name: true } } } }>;

export function serializeTask(t: TaskRow) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    instruction: t.instruction,
    status: t.status,
    agent: t.agent ? { id: t.agent.id, name: t.agent.name } : null,
    conversationId: t.conversationId,
    parentTaskId: t.parentTaskId,
    stepIndex: t.stepIndex,
    result: t.result,
    resultData: t.resultData ?? null,
    failureCode: t.failureCode,
    failureMessage: t.failureMessage,
    retryable: t.status === "failed" && t.parentTaskId === null && RETRYABLE_FAILURES.includes(t.failureCode as FailureCode),
    retryOfId: t.retryOfId,
    workflowId: t.workflowId,
    maxCostUsd: t.maxCostUsd === null ? null : Number(t.maxCostUsd),
    handoffInput: t.handoffInput ?? null,
    createdAt: t.createdAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

export async function taskRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, providers, workflow, sink, bus, config } = deps;
  const withAgent = { agent: { select: { id: true, name: true } } } as const;

  async function assertRunnableAgent(orgId: string, agentId: string) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, organizationId: orgId } });
    if (!agent) throw new AppError(404, "not_found", "Agent not found");
    if (agent.status !== "active") throw new AppError(422, "agent_paused", `Agent '${agent.name}' is paused`);
    const p = providers.get(agent.provider);
    if (!p || !(await readyProviders(deps, orgId)).has(agent.provider)) {
      throw new AppError(422, "provider_not_configured", `Provider '${agent.provider}' for agent '${agent.name}' is not configured for this workspace`);
    }
    return agent;
  }

  /** Create a top-level task (single or pipeline) with its conversation and initial message. */
  async function createTask(orgId: string, userId: string, body: z.infer<typeof TaskCreateSchema>, retryOfId: string | null = null) {
    if (body.kind === "single") {
      const agent = await assertRunnableAgent(orgId, body.agentId);
      return prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({ data: { organizationId: orgId, agentId: agent.id, title: body.title } });
        await tx.message.create({ data: { organizationId: orgId, conversationId: conversation.id, role: "user", content: body.instruction } });
        return tx.task.create({
          data: {
            organizationId: orgId,
            kind: "single",
            title: body.title,
            instruction: body.instruction,
            agentId: agent.id,
            conversationId: conversation.id,
            createdById: userId,
            retryOfId,
            ...(body.maxCostUsd !== undefined ? { maxCostUsd: body.maxCostUsd } : {}),
          },
          include: withAgent,
        });
      });
    }
    for (const step of body.steps) await assertRunnableAgent(orgId, step.agentId);
    return prisma.task.create({
      data: {
        organizationId: orgId,
        kind: "pipeline",
        title: body.title,
        instruction: body.instruction,
        pipelineSpec: body.steps,
        agentId: body.steps[0]!.agentId,
        createdById: userId,
        retryOfId,
        ...(body.maxCostUsd !== undefined ? { maxCostUsd: body.maxCostUsd } : {}),
      },
      include: withAgent,
    });
  }

  async function launch(orgId: string, task: TaskRow) {
    await sink.emit({ organizationId: orgId, taskId: task.id, runId: null, agentId: task.agentId, type: "task.created", payload: { kind: task.kind, title: task.title } });
    // If the workflow service is unavailable the task stays queued; the dispatcher starts it later.
    try {
      await workflow.start(orgId, task.id);
    } catch (err) {
      app.log.warn({ event: "workflow_start_deferred", taskId: task.id, err: err instanceof Error ? err.message : String(err) }, "could not start workflow; will retry");
    }
  }

  app.get("/tasks", async (req) => {
    const { organizationId } = requireAuth(req);
    const q = parse(ListQuery, req.query);
    const rows = await prisma.task.findMany({
      where: { organizationId, parentTaskId: null, kind: { not: "chat" }, ...(q.status ? { status: q.status } : {}), ...(q.agentId ? { agentId: q.agentId } : {}) },
      include: withAgent,
      orderBy: { createdAt: "desc" },
      take: q.limit,
    });
    return rows.map(serializeTask);
  });

  app.post("/tasks", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = parse(TaskCreateSchema, req.body);
    return idempotent(prisma, req, reply, auth.organizationId, "POST /tasks", async () => {
      const task = await createTask(auth.organizationId, auth.userId, body);
      await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "task.created", { type: "task", id: task.id }, { kind: task.kind });
      await launch(auth.organizationId, task);
      return { status: 201, body: serializeTask(task) };
    });
  });

  app.get("/tasks/:id", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId }, include: withAgent });
    if (!task) throw notFound("Task");
    const children = await prisma.task.findMany({ where: { organizationId, parentTaskId: id }, include: withAgent, orderBy: { stepIndex: "asc" } });
    const taskIds = [id, ...children.map((c) => c.id)];
    const [runs, approvals] = await Promise.all([
      prisma.agentRun.findMany({
        where: { organizationId, taskId: { in: taskIds } },
        include: { toolCalls: { orderBy: { createdAt: "asc" } }, agent: { select: { name: true } } },
        orderBy: { startedAt: "asc" },
      }),
      prisma.approval.findMany({ where: { organizationId, taskId: { in: taskIds } }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      ...serializeTask(task),
      pipelineSpec: task.pipelineSpec ?? null,
      children: children.map(serializeTask),
      runs: runs.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        agentId: r.agentId,
        agentName: r.agent.name,
        provider: r.provider,
        model: r.model,
        isMock: providers.get(r.provider)?.isMock ?? false,
        status: r.status,
        iterations: r.iterations,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: money(r.costUsd),
        failureCode: r.failureCode,
        failureMessage: r.failureMessage,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        toolCalls: r.toolCalls.map((tc) => ({
          id: tc.id,
          toolName: tc.toolName,
          arguments: tc.arguments,
          status: tc.status,
          risk: tc.risk,
          output: tc.output ?? null,
          error: tc.error,
          durationMs: tc.durationMs,
          createdAt: tc.createdAt.toISOString(),
        })),
      })),
      approvals: approvals.map((a) => ({ id: a.id, toolName: a.toolName, status: a.status, reason: a.reason, taskId: a.taskId, decisionNote: a.decisionNote })),
    };
  });

  app.get("/tasks/:id/events", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId }, select: { id: true, parentTaskId: true } });
    if (!task) throw notFound("Task");
    const rows = await prisma.runEvent.findMany({
      where: { organizationId, rootTaskId: task.parentTaskId ?? task.id, seq: { gt: lastEventId(req) } },
      orderBy: { seq: "asc" },
      take: 2000,
    });
    return rows.map(toRunEvent);
  });

  app.get("/tasks/:id/events/stream", { config: { rateLimit: false } }, async (req, reply) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId }, select: { id: true, parentTaskId: true } });
    if (!task) throw notFound("Task");
    const root = task.parentTaskId ?? task.id;
    await streamEvents(req, reply, bus, {
      orgId: organizationId,
      allowedOrigin: config.WEB_ORIGIN,
      lifecycle: deps.lifecycle,
      filter: (e) => e.rootTaskId === root,
      replay: (cursor) => readTreeEvents(prisma, organizationId, root, cursor),
    });
  });

  app.get("/events/stream", { config: { rateLimit: false } }, async (req, reply) => {
    const { organizationId } = requireAuth(req);
    // The dashboard feed replays at most the last 50 events on first connect.
    await streamEvents(req, reply, bus, {
      orgId: organizationId,
      allowedOrigin: config.WEB_ORIGIN,
      lifecycle: deps.lifecycle,
      filter: (e) => e.seq !== null,
      replay: (cursor) => readOrgEvents(prisma, organizationId, cursor),
    });
  });

  app.post("/tasks/:id/cancel", async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!task) throw notFound("Task");
    if (task.parentTaskId) throw conflict("Cancel the parent pipeline task instead");
    if (!TERMINAL_TASK_STATUSES.includes(task.status as TaskStatus)) {
      await workflow.cancel(auth.organizationId, id);
      await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "task.cancel_requested", { type: "task", id });
    }
    const fresh = await prisma.task.findFirstOrThrow({ where: { id }, include: withAgent });
    return reply.status(202).send(serializeTask(fresh));
  });

  app.post("/tasks/:id/retry", async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId: auth.organizationId }, include: withAgent });
    if (!task) throw notFound("Task");
    if (!serializeTask(task).retryable) throw conflict("Only failed top-level tasks with a retryable failure can be retried");
    return idempotent(prisma, req, reply, auth.organizationId, `POST /tasks/${id}/retry`, async () => {
      const body =
        task.kind === "pipeline"
          ? { kind: "pipeline" as const, title: task.title, instruction: task.instruction, steps: task.pipelineSpec as { agentId: string; instruction: string }[] }
          : { kind: "single" as const, title: task.title, instruction: task.instruction, agentId: task.agentId ?? "" };
      if (task.maxCostUsd !== null) Object.assign(body, { maxCostUsd: Number(task.maxCostUsd) });
      const retry = await createTask(auth.organizationId, auth.userId, parse(TaskCreateSchema, body), task.id);
      await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "task.retried", { type: "task", id: retry.id }, { retryOf: id });
      await launch(auth.organizationId, retry);
      return { status: 201, body: serializeTask(retry) };
    });
  });

  app.get("/dashboard", async (req) => {
    const { organizationId } = requireAuth(req);
    const [byStatus, agents, usage, pendingApprovals, byProvider] = await Promise.all([
      prisma.task.groupBy({ by: ["status"], where: { organizationId, parentTaskId: null }, _count: true }),
      prisma.agent.count({ where: { organizationId } }),
      prisma.usageRecord.aggregate({ where: { organizationId }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
      prisma.approval.count({ where: { organizationId, status: "pending" } }),
      prisma.usageRecord.groupBy({ by: ["provider"], where: { organizationId }, _sum: { costUsd: true }, _count: true }),
    ]);
    const split = { live: { modelCalls: 0, costUsd: 0 }, mock: { modelCalls: 0, costUsd: 0 } };
    for (const r of byProvider) {
      const bucket = deps.providers.get(r.provider)?.isMock ? split.mock : split.live;
      bucket.modelCalls += r._count;
      bucket.costUsd += money(r._sum.costUsd);
    }
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count]));
    return {
      agents,
      tasks: {
        active: (counts.running ?? 0) + (counts.queued ?? 0) + (counts.awaiting_approval ?? 0),
        queued: counts.queued ?? 0,
        running: counts.running ?? 0,
        awaitingApproval: counts.awaiting_approval ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        cancelled: counts.cancelled ?? 0,
      },
      pendingApprovals,
      usage: {
        modelCalls: usage._count,
        costUsd: money(usage._sum.costUsd),
        inputTokens: usage._sum.inputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
        ...split,
      },
      providers: (await providersForOrg(deps, organizationId)).map((p) => ({ id: p.id, label: p.label, configured: p.configured, isMock: p.isMock, credentialSource: p.credential?.source ?? null })),
    };
  });
}
