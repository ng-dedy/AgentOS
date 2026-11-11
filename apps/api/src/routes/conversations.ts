import type { FastifyInstance } from "fastify";
import { ChatMessageCreateSchema, ConversationCreateSchema, TERMINAL_TASK_STATUSES, type TaskStatus } from "@agentos/contracts";
import type { AppDeps } from "../app";
import { requireAuth } from "../auth/plugin";
import { AppError, conflict, notFound, parse } from "../http/errors";
import { idempotent } from "../http/support";

export async function conversationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, providers, workflow, sink } = deps;

  app.get("/agents/:id/conversations", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await prisma.conversation.findMany({
      // Chat conversations only: task transcripts are reached through their task.
      where: { organizationId, agentId: id, tasks: { none: { kind: { not: "chat" } } } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return rows.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() }));
  });

  app.post("/agents/:id/conversations", async (req, reply) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parse(ConversationCreateSchema, req.body ?? {});
    const agent = await prisma.agent.findFirst({ where: { id, organizationId } });
    if (!agent) throw notFound("Agent");
    const c = await prisma.conversation.create({ data: { organizationId, agentId: id, title: body.title || `Chat with ${agent.name}` } });
    return reply.status(201).send({ id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() });
  });

  app.get("/conversations/:id", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const c = await prisma.conversation.findFirst({
      where: { id, organizationId },
      include: { agent: { select: { id: true, name: true, provider: true, model: true } }, messages: { orderBy: { seq: "asc" } } },
    });
    if (!c) throw notFound("Conversation");
    const activeTask = await prisma.task.findFirst({
      where: { organizationId, conversationId: id, status: { in: ["queued", "running", "awaiting_approval"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    return {
      id: c.id,
      title: c.title,
      agent: { ...c.agent, isMock: providers.get(c.agent.provider)?.isMock ?? false },
      activeTask,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? [],
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError: m.isError,
        runId: m.runId,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  app.post("/conversations/:id/messages", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parse(ChatMessageCreateSchema, req.body);
    const c = await prisma.conversation.findFirst({ where: { id, organizationId: auth.organizationId }, include: { agent: true } });
    if (!c) throw notFound("Conversation");
    const p = providers.get(c.agent.provider);
    if (!p || !p.isConfigured()) throw new AppError(422, "provider_not_configured", `Provider '${c.agent.provider}' is not configured`);
    if (c.agent.status !== "active") throw new AppError(422, "agent_paused", "Agent is paused");
    const busy = await prisma.task.findFirst({ where: { conversationId: id, status: { in: ["queued", "running", "awaiting_approval"] } } });
    if (busy && !TERMINAL_TASK_STATUSES.includes(busy.status as TaskStatus)) throw conflict("The agent is still answering the previous message");

    return idempotent(prisma, req, reply, auth.organizationId, `POST /conversations/${id}/messages`, async () => {
      const task = await prisma.$transaction(async (tx) => {
        await tx.message.create({ data: { organizationId: auth.organizationId, conversationId: id, role: "user", content: body.content } });
        await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
        return tx.task.create({
          data: {
            organizationId: auth.organizationId,
            kind: "chat",
            title: body.content.slice(0, 80),
            instruction: body.content,
            agentId: c.agentId,
            conversationId: id,
            createdById: auth.userId,
          },
        });
      });
      await sink.emit({ organizationId: auth.organizationId, taskId: task.id, runId: null, agentId: c.agentId, type: "task.created", payload: { kind: "chat", title: task.title } });
      workflow.start(auth.organizationId, task.id);
      return { status: 202, body: { taskId: task.id } };
    });
  });
}
