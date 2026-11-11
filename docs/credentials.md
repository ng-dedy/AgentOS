# Organization provider credentials

Each workspace stores its own OpenAI, Anthropic and xAI keys. A model call, a connection check or a model discovery made for a workspace uses that workspace's key. There is no fallback to another workspace's key. The deployment's environment keys are used only when `AGENTOS_ALLOW_DEPLOYMENT_KEYS=true`, which is off by default and labelled "Deployment key" in the UI.

## Encryption at rest

The design is standard envelope encryption (`packages/platform/src/credentials/`). It uses only Node's `crypto` module and no custom cryptography.

1. Each write generates a fresh random 256-bit **data key** and a 96-bit nonce.
2. The key is encrypted with **AES-256-GCM** using the data key. The AAD is `agentos-credential|v1|<orgId>|<provider>|<credentialId>`.
3. The data key is **wrapped** by the `KeyManagementService` under the active key-encryption key (KEK), with the same AAD as context. The plaintext data key is then zeroed.
4. The database stores the ciphertext, nonce, tag, wrapped key and KEK id, plus a 4-character hint for display.

Because the AAD names the owner, a ciphertext copied to another workspace's row fails authentication. A test checks this.

## Key management

`KeyManagementService` (`packages/platform/src/credentials/kms.ts`) has `generateDataKey`, `wrap`, `unwrap`, `activeKeyId` and `selfTest`. `AGENTOS_KMS_PROVIDER` picks the implementation; there is no silent fallback between them.

* **`aws` (production, Milestone 2C).** `AwsKms` calls `GenerateDataKey` (AES_256) on write and `Decrypt` on read, with `KeyId` pinned to `AGENTOS_AWS_KMS_KEY_ID` or one of `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS`. A row naming any other key is refused before a KMS call. Every call carries the encryption context `{scheme, purpose, organizationId, provider, credentialId}`, so AWS itself refuses a wrapped key moved to another organization's row, and CloudTrail records the organization for each decrypt. The AES-GCM AAD on the secret is unchanged from 2B. AWS errors are classified: `AccessDenied`, `Disabled`, `KMSInvalidState`, `NotFound` are configuration errors (not retried); `InvalidCiphertext`/`IncorrectKey` are integrity errors (audited as `credential.decrypt_failed`); throttling, internal and network errors are retryable. Messages never contain payloads. The IAM and key policies are in `deploy/aws/`.
* **`local-dev` (development and tests).** KEKs come from `AGENTOS_DEV_KMS_KEYS` (`id:base64key,...`). It refuses to start in production, and the old `AGENTOS_DEV_KMS_ALLOW_PRODUCTION` override was removed: setting it is a startup error.
* **Unset.** Credential storage is disabled outside production (writes return 503). In production, startup fails.

Workers cache a decrypted key in memory for `AGENTOS_CREDENTIAL_CACHE_TTL_MS` (60 s default, 0 disables), keyed by credential id, `updatedAt` and KEK id, so an update or rotation is never served stale. The cache is cleared on delete and on shutdown. A non-retryable decrypt failure stops the run with `credential_unavailable` instead of retrying.

Verified against moto's KMS emulator (`AGENTOS_TEST_KMS_ENDPOINT`) and a fake client; **not verified against real AWS KMS**.

## Rotation

**AWS KMS.** Automatic key rotation on the CMK needs nothing from AgentOS: old ciphertexts keep decrypting under the same key id. To move to a different CMK, set `AGENTOS_AWS_KMS_KEY_ID=<new>` and `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS=<old>`, restart, run `pnpm --filter @agentos/api credentials:rotate`, and when `remaining` is 0 remove the old id. See `docs/deployment-runbook.md`.

**Development KMS.** Re-wrap every data key; the ciphertexts do not change, so this is safe while tasks run.

```bash
AGENTOS_DEV_KMS_KEYS="k1:<old>,k2:<new>"   # new key last = active
pnpm --filter @agentos/api credentials:rotate
# when remaining is 0, remove k1
```

Replacing a provider key is a separate operation: the owner saves a new key in Settings.

## API

All endpoints are scoped to the session's organization. Every change is written to the audit log.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/credentials` | any member | Storage status and per-provider metadata (source, hint, status, KEK id). Never the key. |
| PUT | `/credentials/:provider` | owner | `{ apiKey, verify? }`. Checks the key against the provider's Models API first. A key the provider rejects (auth) gets 422 and is **not saved**. |
| POST | `/credentials/:provider/verify` | owner | Re-check the stored key. Updates status and last error. |
| DELETE | `/credentials/:provider` | owner | Remove the key. Agents on that provider stop being runnable. |

## What is guaranteed, and tested

`apps/api/test/credentials.test.ts` runs against real Postgres and a fake provider that echoes keys back, as some providers do. The live check is in `apps/worker/test/live-credentials.test.ts`.

* Stored rows contain no plaintext. Responses, logs, audit records, events, tasks and tool calls contain no key.
* Org A's calls carry org A's key, and org B's calls carry org B's key. Org C, with no key, is refused before any provider call, including discovery.
* A row copied to another organization does not decrypt.
* Members get 403 on every write.
* After rotation, the data decrypts with only the new KEK and fails with only the old one.
* The dev KMS refuses production and wrong-size keys.
* Live, 2026-11-11: an OpenAI and an Anthropic key were stored through the API and verified against each provider's Models API. A tool-using task then ran on the worker with each decrypted org key. Neither key appeared in the API or worker logs, or in any event.

Agents never see credentials. Keys are resolved inside the engine at call time and passed straight to the adapter, and no tool can read them.
