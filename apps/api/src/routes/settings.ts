import type { FastifyInstance } from "fastify";
import { CredentialPutSchema, SkillCreateSchema, WorkspaceUpdateSchema } from "@agentos/contracts";
import { isCredentialProvider } from "@agentos/platform";
import { ProviderError } from "@agentos/providers";
import { toJsonSchema } from "@agentos/tools";
import type { AppDeps } from "../app";
import { requireAuth, requireOwner } from "../auth/plugin";
import { parse } from "../http/errors";
import { audit, money } from "../http/support";
import { AppError } from "../http/errors";
import { providersForOrg } from "../providers/status";

export async function settingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, providers, tools } = deps;

  app.get("/providers", async (req) => {
    const { organizationId } = requireAuth(req);
    return (await providersForOrg(deps, organizationId)).map((p) => ({ ...p, discovery: deps.discovery.peek(organizationId, p.id) }));
  });

  /** Compare the catalog with the provider's Models API, using this organization's key. */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/providers/:id/models", async (req) => {
    const { organizationId } = requireAuth(req);
    const result = await deps.discovery.discover(organizationId, req.params.id, req.query.refresh === "1");
    if (!result) throw new AppError(404, "not_found", "Provider not found");
    return result;
  });

  // ---- Organization provider credentials (owner only; keys are write-only) ----

  const credentialProvider = (raw: string) => {
    if (!isCredentialProvider(raw)) throw new AppError(404, "not_found", "Unknown provider");
    return raw;
  };

  app.get("/credentials", async (req) => {
    const { organizationId } = requireAuth(req);
    return {
      storage: {
        enabled: deps.credentials.enabled,
        kms: deps.credentials.kmsName,
        developmentOnly: deps.credentials.kmsDevelopmentOnly,
      },
      allowDeploymentKeys: deps.config.AGENTOS_ALLOW_DEPLOYMENT_KEYS,
      items: await deps.credentials.list(organizationId),
    };
  });

  app.put<{ Params: { provider: string } }>("/credentials/:provider", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireOwner(req);
    const provider = credentialProvider(req.params.provider);
    const body = parse(CredentialPutSchema, req.body);
    if (!deps.credentials.enabled) throw new AppError(503, "credentials_unavailable", "Credential storage is not configured on this server");
    const adapter = providers.get(provider);
    // Check the key before storing it. A key the provider rejects is never saved.
    let check: { ok: boolean; error: string | null } = { ok: false, error: null };
    if (body.verify !== false && adapter?.listModels) {
      try {
        await adapter.listModels(AbortSignal.timeout(15_000), body.apiKey);
        check = { ok: true, error: null };
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "auth") {
          throw new AppError(422, "credential_rejected", `${adapter.label} rejected this key (${err.code})`);
        }
        check = { ok: false, error: err instanceof ProviderError ? `${err.code}: ${err.message}` : "Connection check failed" };
      }
    }
    const { created } = await deps.credentials.put(auth.organizationId, provider, body.apiKey, { userId: auth.userId });
    if (check.ok || check.error) {
      await prisma.providerCredential.updateMany({
        where: { organizationId: auth.organizationId, provider },
        data: { status: check.ok ? "valid" : "unverified", lastVerifiedAt: new Date(), lastVerifyError: check.error },
      });
    }
    deps.discovery.invalidate(auth.organizationId, provider);
    const item = (await deps.credentials.list(auth.organizationId)).find((c) => c.provider === provider)!;
    return { created, credential: item };
  });

  app.post<{ Params: { provider: string } }>("/credentials/:provider/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireOwner(req);
    const provider = credentialProvider(req.params.provider);
    const result = await deps.credentials.verify(auth.organizationId, provider, providers, { userId: auth.userId });
    deps.discovery.invalidate(auth.organizationId, provider);
    const item = (await deps.credentials.list(auth.organizationId)).find((c) => c.provider === provider)!;
    return { result, credential: item };
  });

  app.delete<{ Params: { provider: string } }>("/credentials/:provider", async (req, reply) => {
    const auth = requireOwner(req);
    const provider = credentialProvider(req.params.provider);
    const deleted = await deps.credentials.delete(auth.organizationId, provider, { userId: auth.userId });
    deps.discovery.invalidate(auth.organizationId, provider);
    if (!deleted) throw new AppError(404, "not_found", "No credential stored for this provider");
    return reply.status(204).send();
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
