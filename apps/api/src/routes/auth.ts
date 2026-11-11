import type { FastifyInstance } from "fastify";
import { LoginSchema, SignupSchema } from "@agentos/contracts";
import type { AppDeps } from "../app";
import { requireAuth, SESSION_COOKIE, startSession } from "../auth/plugin";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../auth/password";
import { AppError, parse } from "../http/errors";
import { audit } from "../http/support";
import { ensureVerificationSkill } from "../seedData";

export async function authRoutes(app: FastifyInstance, { prisma, config }: AppDeps) {
  const authLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute", keyGenerator: (req: { ip: string }) => req.ip } };

  app.post("/auth/signup", { config: { public: true, ...authLimit } }, async (req, reply) => {
    const body = parse(SignupSchema, req.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) throw new AppError(409, "email_taken", "An account with this email already exists");
    const passwordHash = await hashPassword(body.password);
    const { user, org } = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: body.organizationName } });
      const user = await tx.user.create({ data: { email, name: body.name, passwordHash } });
      await tx.membership.create({ data: { organizationId: org.id, userId: user.id, role: "owner" } });
      return { user, org };
    });
    await ensureVerificationSkill(prisma, org.id);
    await startSession(prisma, config, reply, user.id, org.id);
    await audit(prisma, org.id, { type: "user", id: user.id }, "auth.signup");
    return reply.status(201).send({ user: { id: user.id, email, name: user.name }, organization: { id: org.id, name: org.name }, role: "owner" });
  });

  app.post("/auth/login", { config: { public: true, ...authLimit } }, async (req, reply) => {
    const body = parse(LoginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() }, include: { memberships: { include: { organization: true } } } });
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : (await verifyPassword(body.password, await DUMMY_HASH_PROMISE), false);
    const membership = user?.memberships[0];
    if (!user || !ok || !membership) throw new AppError(401, "invalid_credentials", "Email or password is incorrect");
    await startSession(prisma, config, reply, user.id, membership.organizationId);
    await audit(prisma, membership.organizationId, { type: "user", id: user.id }, "auth.login");
    return {
      user: { id: user.id, email: user.email, name: user.name },
      organization: { id: membership.organization.id, name: membership.organization.name },
      role: membership.role,
    };
  });

  app.post("/auth/logout", async (req, reply) => {
    const auth = requireAuth(req);
    await prisma.session.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date() } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const auth = requireAuth(req);
    const [user, org] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }),
      prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } }),
    ]);
    return { user: { id: user.id, email: user.email, name: user.name }, organization: { id: org.id, name: org.name }, role: auth.role };
  });
}
