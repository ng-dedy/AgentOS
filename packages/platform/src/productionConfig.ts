import { accessSync, constants } from "node:fs";
import { isProductionEnv } from "./credentials/kms";

export type ProcessRole = "api" | "worker" | "script";

export interface ConfigReport {
  production: boolean;
  /** Each one blocks startup in production. */
  problems: string[];
  /** Logged at startup; never block. */
  warnings: string[];
}

/** Production startup refused. The message lists every problem at once. */
export class UnsafeConfigurationError extends Error {
  constructor(
    readonly role: ProcessRole,
    readonly problems: string[],
  ) {
    super(
      `Refusing to start the ${role} in production with an unsafe configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "See docs/deployment-runbook.md (Configuration reference).",
    );
    this.name = "UnsafeConfigurationError";
  }
}

const on = (v: string | undefined) => v === "true" || v === "1";
const AWS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/;
const LOCAL_HOST = /^(localhost|127\.|\[::1\]|::1)/;

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a process environment against the production rules. Outside production every
 * check is skipped except obvious misconfiguration that would fail later anyway.
 * Pure (reads only `env` and the file system), so it is unit-tested rule by rule.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv, role: ProcessRole): ConfigReport {
  const production = isProductionEnv(env);
  const problems: string[] = [];
  const warnings: string[] = [];
  const problem = (m: string) => problems.push(m);

  // Temporal client certificate: both halves or neither, in every environment.
  if (Boolean(env.TEMPORAL_TLS_CERT_PATH) !== Boolean(env.TEMPORAL_TLS_KEY_PATH)) {
    problem("TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be set together (mTLS client certificate and key)");
  }
  for (const k of ["TEMPORAL_TLS_CA_PATH", "TEMPORAL_TLS_CERT_PATH", "TEMPORAL_TLS_KEY_PATH"] as const) {
    if (env[k] && !readable(env[k])) problem(`${k} points to a file that does not exist or is not readable: ${env[k]}`);
  }
  if (env.AGENTOS_DEV_KMS_ALLOW_PRODUCTION) problem("AGENTOS_DEV_KMS_ALLOW_PRODUCTION was removed in milestone 2C; unset it");

  if (!production) return { production, problems, warnings };

  if (env.AGENTOS_ENV !== "production") warnings.push("NODE_ENV=production without AGENTOS_ENV=production; treating this process as production");

  // Execution engine.
  if ((env.AGENTOS_WORKFLOW_ENGINE ?? "inprocess") !== "temporal") {
    problem("AGENTOS_WORKFLOW_ENGINE must be 'temporal' in production (the in-process engine is not durable)");
  }

  // Key management: managed KMS only; nothing development-only may even be present.
  const kmsProvider = env.AGENTOS_KMS_PROVIDER ?? "";
  if (kmsProvider !== "aws") problem(`AGENTOS_KMS_PROVIDER must be 'aws' in production (got '${kmsProvider || "unset"}')`);
  if (env.AGENTOS_DEV_KMS_KEYS) problem("AGENTOS_DEV_KMS_KEYS must not be set in production (development key-encryption keys)");
  if (env.AGENTOS_DEV_KMS_ACTIVE_KEY) problem("AGENTOS_DEV_KMS_ACTIVE_KEY must not be set in production");
  if (kmsProvider === "aws") {
    const keyId = env.AGENTOS_AWS_KMS_KEY_ID ?? "";
    if (!AWS_KEY_ARN.test(keyId)) problem("AGENTOS_AWS_KMS_KEY_ID must be a full KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>); aliases can be re-pointed");
    for (const prev of (env.AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!AWS_KEY_ARN.test(prev)) problem(`AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS entry is not a KMS key ARN: ${prev}`);
    }
    if (!env.AGENTOS_AWS_KMS_REGION && !env.AWS_REGION) problem("AWS_REGION (or AGENTOS_AWS_KMS_REGION) is required for AWS KMS");
    if (env.AGENTOS_AWS_KMS_ENDPOINT && !env.AGENTOS_AWS_KMS_ENDPOINT.startsWith("https://")) problem("AGENTOS_AWS_KMS_ENDPOINT must be https in production");
    if (env.AWS_ACCESS_KEY_ID) warnings.push("Static AWS access keys are set; prefer an IAM role (instance profile, IRSA or ECS task role)");
  }

  // Test doubles.
  if (on(env.AGENTOS_ENABLE_MOCK_PROVIDER)) problem("AGENTOS_ENABLE_MOCK_PROVIDER must be false in production (the MOCK provider is a test double)");

  // Temporal connectivity.
  const tls = on(env.TEMPORAL_TLS) || Boolean(env.TEMPORAL_API_KEY) || Boolean(env.TEMPORAL_TLS_CERT_PATH);
  if (!tls) {
    if (on(env.TEMPORAL_ALLOW_PLAINTEXT_IN_PRODUCTION)) {
      warnings.push("Temporal connection is plaintext (TEMPORAL_ALLOW_PLAINTEXT_IN_PRODUCTION=true); only acceptable on a network that encrypts in transit");
    } else {
      problem("Temporal must use TLS in production: set TEMPORAL_TLS=true with TEMPORAL_API_KEY or TEMPORAL_TLS_CERT_PATH/KEY_PATH");
    }
  } else if (!env.TEMPORAL_API_KEY && !env.TEMPORAL_TLS_CERT_PATH) {
    warnings.push("Temporal uses TLS without client authentication (no API key or client certificate)");
  }
  if (LOCAL_HOST.test(env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233")) problem("TEMPORAL_ADDRESS points at localhost; production needs the Temporal cluster or Temporal Cloud endpoint");
  if ((env.TEMPORAL_NAMESPACE ?? "default") === "default") warnings.push("TEMPORAL_NAMESPACE is 'default'; use a dedicated namespace per environment");

  // Database.
  const db = env.DATABASE_URL ?? "";
  if (!db) problem("DATABASE_URL is required");
  else if (!/sslmode=(require|verify-ca|verify-full)/.test(db)) warnings.push("DATABASE_URL has no sslmode=require/verify-full; make sure the database connection is encrypted");

  // Credentials policy.
  if (on(env.AGENTOS_ALLOW_DEPLOYMENT_KEYS)) warnings.push("AGENTOS_ALLOW_DEPLOYMENT_KEYS=true: organizations without their own key use the deployment's provider keys");
  if (["debug", "trace"].includes(env.LOG_LEVEL ?? "")) warnings.push(`LOG_LEVEL=${env.LOG_LEVEL} in production`);

  if (role === "api") {
    if (!on(env.SESSION_COOKIE_SECURE)) problem("SESSION_COOKIE_SECURE must be true in production");
    const origin = env.WEB_ORIGIN ?? "";
    if (!origin.startsWith("https://")) problem(`WEB_ORIGIN must be an https origin in production (got '${origin || "unset"}')`);
    const token = env.AGENTOS_METRICS_TOKEN;
    if (token !== undefined && token.length < 32) problem("AGENTOS_METRICS_TOKEN must be at least 32 characters");
    if (token === undefined) warnings.push("AGENTOS_METRICS_TOKEN is not set; /metrics is disabled");
  }
  if (role === "worker" && on(env.TEMPORAL_WORKER_VERSIONING) && !env.TEMPORAL_WORKER_BUILD_ID) {
    problem("TEMPORAL_WORKER_VERSIONING=true needs TEMPORAL_WORKER_BUILD_ID (for example the git commit)");
  }

  return { production, problems, warnings };
}

/** Validate and either return the warnings or throw `UnsafeConfigurationError`. */
export function assertSafeConfiguration(env: NodeJS.ProcessEnv, role: ProcessRole): ConfigReport {
  const report = validateProductionConfig(env, role);
  if (report.problems.length > 0) throw new UnsafeConfigurationError(role, report.problems);
  return report;
}
