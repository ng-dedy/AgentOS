import type { FastifyInstance } from "fastify";
import { AgentCreateSchema, AgentUpdateSchema, type AgentCreate } from "@agentos/contracts";
import { Prisma, type PrismaClient } from "@agentos/db";
import type { AppDeps } from "../app";
import { requireAuth } from "../auth/plugin";
import { AppError, notFound, parse } from "../http/errors";
import { audit, idempotent, money } from "../http/support";

type AgentRow = Prisma.AgentGetPayload<{ include: { skills: { include: { skill: true } } } }>;

export function serializeAgent(a: AgentRow, providers: AppDeps["providers"]) {
  const provider = providers.get(a.provider);
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    instructions: a.instructions,
    provider: a.provider,
    model: a.model,
    providerConfigured: provider?.isConfigured() ?? false,
    isMock: provider?.isMock ?? false,
    allowedTools: a.allowedTools,
    maxIterations: a.maxIterations,
    maxRunCostUsd: money(a.maxRunCostUsd),
    maxRunTokens: a.maxRunTokens,
    status: a.status,
    skills: a.skills.map((s) => ({ id: s.skill.id, name: s.skill.name, version: s.skill.version })),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const include = { skills: { include: { skill: true } } } as const;

export async function agentRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, providers, tools } = deps;

  const validate = async (orgId: string, a: Partial<AgentCreate>, current?: { provider: string; model: string }) => {
    const provider = a.provider ?? current?.provider;
    const model = a.model ?? current?.model;
    if (provider !== undefined && !providers.get(provider)) throw new AppError(400, "invalid_provider", `Provider '${provider}' is not available`);
    if (provider !== undefined && model !== undefined && !providers.catalog.find(provider, model)) {
      throw new AppError(400, "invalid_model", `Model '${model}' is not available for provider '${provider}'`);
    }
    const unknown = (a.allowedTools ?? []).filter((t) => !tools.has(t));
    if (unknown.length) throw new AppError(400, "invalid_tools", `Unknown tools: ${unknown.join(", ")}`);
    if (a.skillIds?.length) {
      const n = await prisma.skill.count({ where: { organizationId: orgId, id: { in: a.skillIds } } });
      if (n !== new Set(a.skillIds).size) throw new AppError(400, "invalid_skills", "One or more skills were not found");
    }
  };

  app.get("/agents", async (req) => {
    const { organizationId } = requireAuth(req);
    const rows = await prisma.agent.findMany({ where: { organizationId }, include, orderBy: { createdAt: "asc" } });
    const active = await prisma.task.groupBy({
      by: ["agentId"],
      where: { organizationId, status: { in: ["running", "awaiting_approval"] } },
      _count: true,
    });
    const activeBy = new Map(active.map((r) => [r.agentId, r._count]));
    return rows.map((a) => ({ ...serializeAgent(a, providers), activeTasks: activeBy.get(a.id) ?? 0 }));
  });

  app.post("/agents", async (req, reply) => {
    const auth = requireAuth(req);
    const body = parse(AgentCreateSchema, req.body);
    await validate(auth.organizationId, body);
    return idempotent(prisma, req, reply, auth.organizationId, "POST /agents", async () => {
      const { skillIds, ...data } = body;
      try {
        const agent = await prisma.agent.create({
          data: {
            ...data,
            allowedTools: [...new Set(data.allowedTools)],
            maxRunCostUsd: new Prisma.Decimal(data.maxRunCostUsd),
            organizationId: auth.organizationId,
            createdById: auth.userId,
            skills: { create: [...new Set(skillIds)].map((skillId) => ({ skillId })) },
          },
          include,
        });
        await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "agent.created", { type: "agent", id: agent.id }, { name: agent.name, tools: agent.allowedTools });
        return { status: 201, body: serializeAgent(agent, providers) };
      } catch (err) {
        throw uniqueName(err);
      }
    });
  });

  app.get("/agents/:id", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const agent = await prisma.agent.findFirst({ where: { id, organizationId }, include });
    if (!agent) throw notFound("Agent");
    const [recentTasks, usage] = await Promise.all([
      prisma.task.findMany({ where: { organizationId, agentId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.usageRecord.aggregate({ where: { organizationId, agentId: id }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
    ]);
    return {
      ...serializeAgent(agent, providers),
      recentTasks: recentTasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, createdAt: t.createdAt.toISOString() })),
      usage: {
        modelCalls: usage._count,
        costUsd: money(usage._sum.costUsd),
        inputTokens: usage._sum.inputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
      },
    };
  });

  app.patch("/agents/:id", async (req) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parse(AgentUpdateSchema, req.body);
    const current = await prisma.agent.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!current) throw notFound("Agent");
    await validate(auth.organizationId, body, current);
    const { skillIds, maxRunCostUsd, allowedTools, ...rest } = body;
    try {
      const agent = await prisma.$transaction(async (tx) => {
        if (skillIds) {
          await tx.skillAssignment.deleteMany({ where: { agentId: id } });
          await tx.skillAssignment.createMany({ data: [...new Set(skillIds)].map((skillId) => ({ agentId: id, skillId })) });
        }
        return tx.agent.update({
          where: { id },
          data: {
            ...rest,
            ...(allowedTools ? { allowedTools: [...new Set(allowedTools)] } : {}),
            ...(maxRunCostUsd !== undefined ? { maxRunCostUsd: new Prisma.Decimal(maxRunCostUsd) } : {}),
          },
          include,
        });
      });
      await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "agent.updated", { type: "agent", id }, { fields: Object.keys(body) });
      return serializeAgent(agent, providers);
    } catch (err) {
      throw uniqueName(err);
    }
  });
}

function uniqueName(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return new AppError(409, "name_taken", "An agent with this name already exists");
  }
  return err;
}

export type { PrismaClient };
