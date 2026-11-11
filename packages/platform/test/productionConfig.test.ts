import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeConfiguration, createKms, KmsConfigError, LocalDevKms, UnsafeConfigurationError, validateProductionConfig } from "../src";

const ARN = "arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const dir = mkdtempSync(join(tmpdir(), "agentos-cfg-"));
const CERT = join(dir, "client.pem");
const KEY = join(dir, "client.key");
writeFileSync(CERT, "cert");
writeFileSync(KEY, "key");

/** A production environment that passes every rule. Each test breaks exactly one. */
const SAFE: NodeJS.ProcessEnv = {
  AGENTOS_ENV: "production",
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app@db.internal:5432/agentos?sslmode=verify-full",
  AGENTOS_WORKFLOW_ENGINE: "temporal",
  AGENTOS_KMS_PROVIDER: "aws",
  AGENTOS_AWS_KMS_KEY_ID: ARN,
  AWS_REGION: "eu-west-1",
  AGENTOS_ENABLE_MOCK_PROVIDER: "false",
  TEMPORAL_ADDRESS: "agentos.abcde.tmprl.cloud:7233",
  TEMPORAL_NAMESPACE: "agentos-prod.abcde",
  TEMPORAL_TLS: "true",
  TEMPORAL_TLS_CERT_PATH: CERT,
  TEMPORAL_TLS_KEY_PATH: KEY,
  SESSION_COOKIE_SECURE: "true",
  WEB_ORIGIN: "https://app.example.com",
  AGENTOS_METRICS_TOKEN: "m".repeat(40),
};

const problemsFor = (patch: NodeJS.ProcessEnv, role: "api" | "worker" = "api") => validateProductionConfig({ ...SAFE, ...patch }, role).problems;

describe("production configuration validation", () => {
  it("accepts a complete production configuration with no problems and no warnings", () => {
    expect(validateProductionConfig(SAFE, "api")).toEqual({ production: true, problems: [], warnings: [] });
    expect(validateProductionConfig(SAFE, "worker").problems).toEqual([]);
  });

  it("skips production rules in development", () => {
    expect(validateProductionConfig({ AGENTOS_WORKFLOW_ENGINE: "inprocess", AGENTOS_ENABLE_MOCK_PROVIDER: "true" }, "api")).toMatchObject({ production: false, problems: [] });
  });

  it("treats NODE_ENV=production as production even without AGENTOS_ENV", () => {
    const r = validateProductionConfig({ ...SAFE, AGENTOS_ENV: undefined }, "api");
    expect(r.production).toBe(true);
    expect(r.warnings.join()).toMatch(/AGENTOS_ENV=production/);
    expect(validateProductionConfig({ NODE_ENV: "production" }, "api").problems.length).toBeGreaterThan(5);
  });

  const rules: [string, NodeJS.ProcessEnv, RegExp, ("api" | "worker")?][] = [
    ["the in-process engine", { AGENTOS_WORKFLOW_ENGINE: "inprocess" }, /AGENTOS_WORKFLOW_ENGINE must be 'temporal'/],
    ["an unset engine (the default is in-process)", { AGENTOS_WORKFLOW_ENGINE: undefined }, /AGENTOS_WORKFLOW_ENGINE/],
    ["the development KMS", { AGENTOS_KMS_PROVIDER: "local-dev", AGENTOS_DEV_KMS_KEYS: "k:AAAA" }, /AGENTOS_KMS_PROVIDER must be 'aws'/],
    ["no KMS at all", { AGENTOS_KMS_PROVIDER: undefined }, /AGENTOS_KMS_PROVIDER must be 'aws'.*unset/],
    ["leftover development KEKs next to AWS KMS", { AGENTOS_DEV_KMS_KEYS: "k1:AAAA" }, /AGENTOS_DEV_KMS_KEYS must not be set/],
    ["the removed production override", { AGENTOS_DEV_KMS_ALLOW_PRODUCTION: "true" }, /AGENTOS_DEV_KMS_ALLOW_PRODUCTION was removed/],
    ["a KMS alias instead of a key ARN", { AGENTOS_AWS_KMS_KEY_ID: "alias/agentos" }, /full KMS key ARN/],
    ["a malformed previous key", { AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS: `${ARN},alias/old` }, /PREVIOUS_KEY_IDS entry is not a KMS key ARN: alias\/old/],
    ["no AWS region", { AWS_REGION: undefined }, /AWS_REGION/],
    ["a plaintext KMS endpoint", { AGENTOS_AWS_KMS_ENDPOINT: "http://localhost:5000" }, /AGENTOS_AWS_KMS_ENDPOINT must be https/],
    ["the MOCK provider", { AGENTOS_ENABLE_MOCK_PROVIDER: "true" }, /MOCK provider/],
    ["plaintext Temporal", { TEMPORAL_TLS: undefined, TEMPORAL_TLS_CERT_PATH: undefined, TEMPORAL_TLS_KEY_PATH: undefined }, /Temporal must use TLS/],
    ["a local Temporal address", { TEMPORAL_ADDRESS: "127.0.0.1:7233" }, /localhost/],
    ["half an mTLS pair", { TEMPORAL_TLS_KEY_PATH: undefined }, /must be set together/],
    ["a missing certificate file", { TEMPORAL_TLS_CERT_PATH: join(dir, "nope.pem") }, /does not exist or is not readable/],
    ["insecure session cookies", { SESSION_COOKIE_SECURE: "false" }, /SESSION_COOKIE_SECURE must be true/],
    ["an http web origin", { WEB_ORIGIN: "http://app.example.com" }, /WEB_ORIGIN must be an https origin/],
    ["a weak metrics token", { AGENTOS_METRICS_TOKEN: "short" }, /at least 32 characters/],
    ["worker versioning without a build id", { TEMPORAL_WORKER_VERSIONING: "true" }, /TEMPORAL_WORKER_BUILD_ID/, "worker"],
  ];
  for (const [what, patch, message, role] of rules) {
    it(`rejects ${what}`, () => {
      const p = problemsFor(patch, role ?? "api");
      expect(p.some((m) => message.test(m)), p.join("\n")).toBe(true);
    });
  }

  it("allows plaintext Temporal only with the explicit opt-out, and warns", () => {
    const r = validateProductionConfig({ ...SAFE, TEMPORAL_TLS: undefined, TEMPORAL_TLS_CERT_PATH: undefined, TEMPORAL_TLS_KEY_PATH: undefined, TEMPORAL_ALLOW_PLAINTEXT_IN_PRODUCTION: "true" }, "api");
    expect(r.problems).toEqual([]);
    expect(r.warnings.join()).toMatch(/plaintext/);
  });

  it("warns (does not block) on softer risks", () => {
    const r = validateProductionConfig({ ...SAFE, TEMPORAL_NAMESPACE: "default", DATABASE_URL: "postgresql://db/agentos", AGENTOS_ALLOW_DEPLOYMENT_KEYS: "true", AWS_ACCESS_KEY_ID: "AKIA..." }, "api");
    expect(r.problems).toEqual([]);
    expect(r.warnings.length).toBe(4);
  });

  it("reports every problem at once in one clear error", () => {
    let err: unknown;
    try {
      assertSafeConfiguration({ AGENTOS_ENV: "production", DATABASE_URL: "postgresql://x/y", AGENTOS_WORKFLOW_ENGINE: "inprocess", AGENTOS_ENABLE_MOCK_PROVIDER: "true", AGENTOS_DEV_KMS_KEYS: "k:AAAA" }, "worker");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsafeConfigurationError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/Refusing to start the worker in production/);
    for (const m of [/AGENTOS_WORKFLOW_ENGINE/, /AGENTOS_KMS_PROVIDER/, /AGENTOS_DEV_KMS_KEYS/, /MOCK/, /TLS/]) expect(msg).toMatch(m);
  });
});

describe("no silent fallback to development encryption", () => {
  const devKeys = `k1:${Buffer.alloc(32, 7).toString("base64")}`;

  it("refuses LocalDevKms in production with no override", () => {
    expect(() => new LocalDevKms(devKeys, { env: { NODE_ENV: "production" } })).toThrow(KmsConfigError);
    expect(() => new LocalDevKms(devKeys, { env: { AGENTOS_ENV: "production" } })).toThrow(KmsConfigError);
  });

  it("createKms never returns the dev KMS in production, and never returns null there", async () => {
    await expect(createKms({ AGENTOS_ENV: "production", AGENTOS_DEV_KMS_KEYS: devKeys })).rejects.toThrow(KmsConfigError);
    await expect(createKms({ AGENTOS_ENV: "production" })).rejects.toThrow(/Production requires a managed KMS/);
    await expect(createKms({ AGENTOS_ENV: "production", AGENTOS_KMS_PROVIDER: "local-dev", AGENTOS_DEV_KMS_KEYS: devKeys })).rejects.toThrow(KmsConfigError);
    await expect(createKms({ AGENTOS_DEV_KMS_ALLOW_PRODUCTION: "true", AGENTOS_DEV_KMS_KEYS: devKeys })).rejects.toThrow(/removed/);
  });

  it("selects AWS KMS when asked and still works locally with the dev KMS", async () => {
    const aws = await createKms({ AGENTOS_KMS_PROVIDER: "aws", AGENTOS_AWS_KMS_KEY_ID: ARN, AWS_REGION: "eu-west-1" });
    expect(aws).toMatchObject({ name: "aws-kms", developmentOnly: false });
    expect(aws!.activeKeyId()).toBe(ARN);
    expect(await createKms({ AGENTOS_DEV_KMS_KEYS: devKeys })).toMatchObject({ name: "local-dev", developmentOnly: true });
    expect(await createKms({})).toBeNull();
    await expect(createKms({ AGENTOS_KMS_PROVIDER: "vault" })).rejects.toThrow(/Unknown AGENTOS_KMS_PROVIDER/);
  });
});
