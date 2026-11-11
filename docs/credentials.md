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

`KeyManagementService` has three operations: `wrap`, `unwrap` and `activeKeyId`.

* **`LocalDevKms` (development only).** KEKs come from `AGENTOS_DEV_KMS_KEYS` (`id:base64key,...`, 32-byte keys, the last one is active). It refuses to start when `NODE_ENV=production` unless `AGENTOS_DEV_KMS_ALLOW_PRODUCTION=true` is set deliberately. The UI and the logs say it is a development KMS. Generate a key with `openssl rand -base64 32`.
* **Production.** Implement the same interface on AWS KMS (`Encrypt`/`Decrypt` with `EncryptionContext`), GCP Cloud KMS (`additionalAuthenticatedData`) or Vault Transit (`context`). None of these could be reached from the build environment, so none is implemented or verified yet.

Without a KMS configured, credential storage is disabled. The API returns 503 for writes and the UI says so.

## Rotation

To rotate the KEK, re-wrap every data key. The ciphertexts do not change, so this is safe while tasks are running.

```bash
# 1. add the new KEK and make it active (last entry, or AGENTOS_DEV_KMS_ACTIVE_KEY)
AGENTOS_DEV_KMS_KEYS="k1:<old>,k2:<new>"
# 2. restart API and workers with that value
# 3. re-wrap (audited per credential; prints {"activeKeyId","rewrapped","remaining"})
pnpm --filter @agentos/api credentials:rotate
# 4. when remaining is 0, remove k1
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
