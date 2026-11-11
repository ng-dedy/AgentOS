import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@agentos/db";
import { ProviderError, type ProviderRegistry } from "@agentos/providers";
import type { CredentialResolver } from "@agentos/runtime";
import { openSecret, rewrapSecret, sealSecret } from "./envelope";
import type { KeyManagementService } from "./kms";

/** Providers that accept organization credentials. The mock never needs one. */
export const CREDENTIAL_PROVIDERS = ["openai", "anthropic", "xai"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];
export const isCredentialProvider = (p: string): p is CredentialProvider => (CREDENTIAL_PROVIDERS as readonly string[]).includes(p);

/** Deployment-wide env variable per provider, used only when explicitly allowed. */
export const DEPLOYMENT_KEY_ENV: Record<CredentialProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
};

/** Safe metadata; never contains the key or its ciphertext. */
export interface CredentialInfo {
  provider: CredentialProvider;
  /** Where this org's calls get their key: its own credential, the deployment key (explicitly allowed), or none. */
  source: "organization" | "deployment" | "none";
  keyHint: string | null;
  status: "unverified" | "valid" | "invalid" | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  kekId: string | null;
  updatedAt: string | null;
}

export class CredentialsUnavailableError extends Error {
  constructor() {
    super("Credential storage is not configured on this server (set AGENTOS_DEV_KMS_KEYS or a managed KMS)");
  }
}

type Actor = { userId: string | null };

const aadFor = (orgId: string, provider: string, id: string) => `agentos-credential|v1|${orgId}|${provider}|${id}`;
const hint = (key: string) => (key.length > 8 ? key.slice(-4) : "");

/**
 * Per-organization provider credentials, envelope-encrypted at rest. Every method is
 * scoped by organization id and the plaintext key only leaves this class through
 * `resolve` (for a model call made on that organization's behalf).
 */
export class CredentialService implements CredentialResolver {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly kms: KeyManagementService | null,
    private readonly opts: { allowDeploymentKeys: boolean; deploymentSecrets?: { get(name: string): string | undefined } },
  ) {}

  get enabled(): boolean {
    return this.kms !== null;
  }

  get kmsName(): string | null {
    return this.kms?.name ?? null;
  }

  get kmsDevelopmentOnly(): boolean {
    return this.kms?.developmentOnly ?? false;
  }

  /** The key a model call for `orgId` must use. Never another organization's key. */
  async resolve(orgId: string, provider: string): Promise<string | null> {
    if (!isCredentialProvider(provider)) return null;
    const own = await this.getOwnKey(orgId, provider);
    if (own) return own;
    return this.deploymentKey(provider);
  }

  async list(orgId: string): Promise<CredentialInfo[]> {
    const rows = await this.prisma.providerCredential.findMany({
      where: { organizationId: orgId },
      select: { provider: true, keyHint: true, status: true, lastVerifiedAt: true, lastVerifyError: true, kekId: true, updatedAt: true },
    });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return CREDENTIAL_PROVIDERS.map((provider): CredentialInfo => {
      const r = byProvider.get(provider);
      if (r) {
        return {
          provider,
          source: "organization",
          keyHint: r.keyHint || null,
          status: r.status as CredentialInfo["status"],
          lastVerifiedAt: r.lastVerifiedAt?.toISOString() ?? null,
          lastVerifyError: r.lastVerifyError,
          kekId: r.kekId,
          updatedAt: r.updatedAt.toISOString(),
        };
      }
      const deployment = this.deploymentKey(provider) !== null;
      return {
        provider,
        source: deployment ? "deployment" : "none",
        keyHint: null,
        status: null,
        lastVerifiedAt: null,
        lastVerifyError: null,
        kekId: null,
        updatedAt: null,
      };
    });
  }

  /** Create or replace the org's key. A fresh data key and nonce are used every time. */
  async put(orgId: string, provider: CredentialProvider, apiKey: string, actor: Actor): Promise<{ created: boolean }> {
    const kms = this.requireKms();
    const existing = await this.prisma.providerCredential.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider } }, select: { id: true } });
    const id = existing?.id ?? randomUUID();
    const env = await sealSecret(kms, apiKey, aadFor(orgId, provider, id));
    const data = { ...env, keyHint: hint(apiKey), status: "unverified", lastVerifiedAt: null, lastVerifyError: null, updatedById: actor.userId };
    if (existing) {
      await this.prisma.providerCredential.update({ where: { id }, data });
    } else {
      await this.prisma.providerCredential.create({ data: { id, organizationId: orgId, provider, createdById: actor.userId, ...data } });
    }
    await this.audit(orgId, actor, existing ? "credential.updated" : "credential.created", provider, { keyHint: data.keyHint, kekId: env.kekId });
    return { created: !existing };
  }

  async delete(orgId: string, provider: CredentialProvider, actor: Actor): Promise<boolean> {
    const r = await this.prisma.providerCredential.deleteMany({ where: { organizationId: orgId, provider } });
    if (r.count > 0) await this.audit(orgId, actor, "credential.deleted", provider, {});
    return r.count > 0;
  }

  /**
   * Check the key the org would use against the provider's Models API (read-only, free).
   * Updates the stored status for an org-owned credential.
   */
  async verify(orgId: string, provider: CredentialProvider, providers: ProviderRegistry, actor: Actor, signal?: AbortSignal) {
    const p = providers.get(provider);
    const key = await this.resolve(orgId, provider);
    if (!p?.listModels || !key) return { ok: false as const, source: "none" as const, error: "No key configured for this organization" };
    const source = (await this.getOwnKey(orgId, provider)) ? ("organization" as const) : ("deployment" as const);
    let ok = false;
    let error: string | null = null;
    let models = 0;
    try {
      models = (await p.listModels(signal ?? AbortSignal.timeout(15_000), key)).length;
      ok = true;
    } catch (err) {
      error = err instanceof ProviderError ? `${err.code}${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}` : "Connection check failed";
    }
    if (source === "organization") {
      await this.prisma.providerCredential.updateMany({
        where: { organizationId: orgId, provider },
        data: { status: ok ? "valid" : "invalid", lastVerifiedAt: new Date(), lastVerifyError: error },
      });
    }
    await this.audit(orgId, actor, "credential.verified", provider, { ok, source, error });
    return ok ? { ok: true as const, source, models } : { ok: false as const, source, error: error ?? "failed" };
  }

  /**
   * Re-wrap every data key that is not under the KMS's active key. Ciphertexts are
   * unchanged, so this is safe to run while workers use the credentials. Returns
   * the number of credentials re-wrapped. Run it after adding a new active KEK and
   * before removing the old one.
   */
  async rotate(actor: Actor = { userId: null }): Promise<{ rewrapped: number; activeKeyId: string }> {
    const kms = this.requireKms();
    const active = kms.activeKeyId();
    const rows = await this.prisma.providerCredential.findMany({ where: { kekId: { not: active } } });
    let n = 0;
    for (const r of rows) {
      const next = await rewrapSecret(kms, r, aadFor(r.organizationId, r.provider, r.id));
      // Compare-and-set on the old wrapping so a concurrent update is never overwritten.
      const u = await this.prisma.providerCredential.updateMany({
        where: { id: r.id, kekId: r.kekId, updatedAt: r.updatedAt },
        data: { ...next, rotatedAt: new Date() },
      });
      if (u.count === 1) {
        n++;
        await this.audit(r.organizationId, actor, "credential.rotated", r.provider, { fromKekId: r.kekId, toKekId: next.kekId });
      }
    }
    return { rewrapped: n, activeKeyId: active };
  }

  private async getOwnKey(orgId: string, provider: CredentialProvider): Promise<string | null> {
    if (!this.kms) return null;
    const r = await this.prisma.providerCredential.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider } } });
    if (!r || r.organizationId !== orgId) return null;
    return openSecret(this.kms, r, aadFor(orgId, provider, r.id));
  }

  private deploymentKey(provider: CredentialProvider): string | null {
    if (!this.opts.allowDeploymentKeys) return null;
    return this.opts.deploymentSecrets?.get(DEPLOYMENT_KEY_ENV[provider]) ?? null;
  }

  private requireKms(): KeyManagementService {
    if (!this.kms) throw new CredentialsUnavailableError();
    return this.kms;
  }

  private async audit(orgId: string, actor: Actor, action: string, provider: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        actorType: actor.userId ? "user" : "system",
        actorId: actor.userId,
        action,
        targetType: "provider_credential",
        targetId: provider,
        metadata: JSON.parse(JSON.stringify(metadata)),
      },
    });
  }
}
