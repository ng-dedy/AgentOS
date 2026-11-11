import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApprovalDecisionSchema, ApprovalStatusSchema, TERMINAL_TASK_STATUSES, type TaskStatus } from "@agentos/contracts";
import type { AppDeps } from "../app";
import { requireAuth, requireOwner } from "../auth/plugin";
import { conflict, notFound, parse } from "../http/errors";
import { audit } from "../http/support";

export async function approvalRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, workflow, sink, tools } = deps;

  app.get("/approvals", async (req) => {
    const { organizationId } = requireAuth(req);
    const q = parse(z.object({ status: ApprovalStatusSchema.optional() }), req.query);
    const rows = await prisma.approval.findMany({
      where: { organizationId, ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const agentIds = [...new Set(rows.map((r) => r.agentId))];
    const taskIds = [...new Set(rows.map((r) => r.taskId))];
    const [agents, tasks] = await Promise.all([
      prisma.agent.findMany({ where: { organizationId, id: { in: agentIds } }, select: { id: true, name: true } }),
      prisma.task.findMany({ where: { organizationId, id: { in: taskIds } }, select: { id: true, title: true, parentTaskId: true } }),
    ]);
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    return rows.map((a) => ({
      id: a.id,
      status: a.status,
      toolName: a.toolName,
      risk: tools.get(a.toolName)?.risk ?? null,
      arguments: a.arguments,
      reason: a.reason,
      agent: { id: a.agentId, name: agentName.get(a.agentId) ?? "unknown" },
      task: { id: a.taskId, title: taskById.get(a.taskId)?.title ?? "", rootTaskId: taskById.get(a.taskId)?.parentTaskId ?? a.taskId },
      decisionNote: a.decisionNote,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }));
  });

  /**
   * Decide an approval. Only workspace owners may decide, only for their own
   * organization, and only while the run is actually waiting on this tool call:
   * a decision for a cancelled/finished task or an already-decided approval is
   * rejected with 409 and changes nothing.
   */
  app.post("/approvals/:id/decision", async (req) => {
    const auth = requireOwner(req);
    const { id } = req.params as { id: string };
    const body = parse(ApprovalDecisionSchema, req.body);
    const status = body.decision === "approve" ? "approved" : "rejected";
    const approval = await prisma.approval.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!approval) throw notFound("Approval");
    if (approval.status !== "pending") {
      if (approval.status === status) return { id, status, idempotent: true }; // same decision repeated
      throw conflict(`Approval was already ${approval.status}`);
    }
    const [task, toolCall] = await Promise.all([
      prisma.task.findFirst({ where: { id: approval.taskId, organizationId: auth.organizationId }, select: { status: true, cancelRequestedAt: true } }),
      prisma.toolCall.findFirst({ where: { id: approval.toolCallId, organizationId: auth.organizationId }, select: { status: true } }),
    ]);
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status as TaskStatus) || task.cancelRequestedAt) {
      throw conflict("This approval is stale: its task is no longer running");
    }
    if (toolCall?.status !== "awaiting_approval") throw conflict("This approval is stale: the tool call is no longer waiting for a decision");

    // Compare-and-set so two reviewers cannot both decide.
    const updated = await prisma.approval.updateMany({
      where: { id, organizationId: auth.organizationId, status: "pending" },
      data: { status, decidedById: auth.userId, decisionNote: body.note ?? null, decidedAt: new Date() },
    });
    if (updated.count === 0) {
      // Lost a race with another reviewer (or the task was cancelled meanwhile).
      const now = await prisma.approval.findFirst({ where: { id, organizationId: auth.organizationId }, select: { status: true } });
      if (now?.status === status) return { id, status, idempotent: true };
      throw conflict(`Approval was already ${now?.status ?? "decided"}`);
    }
    await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, `approval.${status}`, { type: "approval", id }, {
      toolName: approval.toolName,
      taskId: approval.taskId,
      note: body.note ?? null,
    });
    await sink.emit({
      organizationId: auth.organizationId,
      taskId: approval.taskId,
      runId: approval.runId,
      agentId: approval.agentId,
      type: "approval.decided",
      payload: { approvalId: id, toolCallId: approval.toolCallId, toolName: approval.toolName, decision: status, note: body.note ?? null },
    });
    await workflow.signalApproval(auth.organizationId, approval.taskId);
    return { id, status, idempotent: false };
  });

  app.get("/audit", async (req) => {
    const { organizationId } = requireAuth(req);
    const rows = await prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 });
    const userIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds }, memberships: { some: { organizationId } } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actorType === "user" ? (name.get(r.actorId ?? "") ?? "user") : "system",
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
