import type { FastifyInstance } from "fastify";
import { SkillCreateSchema, WorkspaceUpdateSchema } from "@agentos/contracts";
import { toJsonSchema } from "@agentos/tools";
import type { AppDeps } from "../app";
import { requireAuth, requireOwner } from "../auth/plugin";
import { parse } from "../http/errors";
import { audit, money } from "../http/support";
import { AppError } from "../http/errors";

export async function settingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, providers, tools } = deps;

  app.get("/providers", async (req) => {
    requireAuth(req);
    return providers.list().map((p) => ({ ...p, discovery: deps.discovery.peek(p.id) }));
  });

  /** Compare the catalog with the provider's Models API for this deployment's key. */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/providers/:id/models", async (req) => {
    requireAuth(req);
    const result = await deps.discovery.discover(req.params.id, req.query.refresh === "1");
    if (!result) throw new AppError(404, "not_found", "Provider not found");
    return result;
  });

  app.get("/tools", async (req) => {
    requireAuth(req);
    return tools.list().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
      timeoutMs: t.timeoutMs,
      inputSchema: toJsonSchema(t.inputSchema),
    }));
  });

  app.get("/usage/summary", async (req) => {
    const { organizationId } = requireAuth(req);
    const [byModel, byAgent, total] = await Promise.all([
      prisma.usageRecord.groupBy({
        by: ["provider", "model"],
        where: { organizationId },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.usageRecord.groupBy({ by: ["agentId"], where: { organizationId }, _sum: { costUsd: true }, _count: true }),
      prisma.usageRecord.aggregate({ where: { organizationId }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
    ]);
    const agents = await prisma.agent.findMany({ where: { organizationId, id: { in: byAgent.map((a) => a.agentId) } }, select: { id: true, name: true } });
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    return {
      total: {
        modelCalls: total._count,
        costUsd: money(total._sum.costUsd),
        inputTokens: total._sum.inputTokens ?? 0,
        outputTokens: total._sum.outputTokens ?? 0,
      },
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        isMock: providers.get(r.provider)?.isMock ?? false,
        priceSource: providers.catalog.find(r.provider, r.model)?.priceSource ?? "unverified",
        modelCalls: r._count,
        costUsd: money(r._sum.costUsd),
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
      })),
      byAgent: byAgent.map((r) => ({ agentId: r.agentId, agentName: agentName.get(r.agentId) ?? "deleted agent", modelCalls: r._count, costUsd: money(r._sum.costUsd) })),
    };
  });

  app.get("/workspace", async (req) => {
    const { organizationId, role } = requireAuth(req);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    return { id: org.id, name: org.name, defaultProvider: org.defaultProvider, defaultModel: org.defaultModel, role };
  });

  app.patch("/workspace", async (req) => {
    const auth = requireOwner(req);
    const body = parse(WorkspaceUpdateSchema, req.body);
    const org = await prisma.organization.update({ where: { id: auth.organizationId }, data: body });
    await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "workspace.updated", { type: "organization", id: org.id }, body);
    return { id: org.id, name: org.name, defaultProvider: org.defaultProvider, defaultModel: org.defaultModel, role: auth.role };
  });

  app.get("/skills", async (req) => {
    const { organizationId } = requireAuth(req);
    const rows = await prisma.skill.findMany({
      where: { organizationId },
      orderBy: [{ name: "asc" }, { version: "desc" }],
      include: { assignments: { select: { agentId: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      instructions: s.instructions,
      agentIds: s.assignments.map((a) => a.agentId),
      createdAt: s.createdAt.toISOString(),
    }));
  });

  /** Skills are immutable versions: posting an existing name creates version n+1. */
  app.post("/skills", async (req, reply) => {
    const auth = requireAuth(req);
    const body = parse(SkillCreateSchema, req.body);
    const skill = await prisma.$transaction(async (tx) => {
      const latest = await tx.skill.findFirst({ where: { organizationId: auth.organizationId, name: body.name }, orderBy: { version: "desc" } });
      return tx.skill.create({ data: { organizationId: auth.organizationId, ...body, version: (latest?.version ?? 0) + 1 } });
    });
    await audit(prisma, auth.organizationId, { type: "user", id: auth.userId }, "skill.created", { type: "skill", id: skill.id }, { name: skill.name, version: skill.version });
    return reply.status(201).send({ ...skill, createdAt: skill.createdAt.toISOString(), agentIds: [] });
  });
}
