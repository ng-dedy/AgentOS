# Deployment runbook

Status: written for Milestone 2C, 2026-11-11. **Nothing has been deployed.** This runbook has been checked against local infrastructure only: Postgres 16, a Temporal dev server, a TLS/mTLS proxy, and the moto KMS emulator. Every step that touches AWS or Temporal Cloud is marked *unverified*.

Do not deploy to production without explicit authorization from the owner.

Related: [migrations.md](migrations.md), [operations/backup-recovery.md](operations/backup-recovery.md), [operations/incident-response.md](operations/incident-response.md), [credentials.md](credentials.md), [durable-execution.md](durable-execution.md).

## 1. What runs in production

| Process | Command | Replicas | Probes |
|---|---|---|---|
| API (`apps/api`) | `pnpm --filter @agentos/api start` | 2 or more behind a load balancer | `GET /livez`, `GET /readyz` on the API port |
| Worker (`apps/worker`) | `pnpm --filter @agentos/worker start` | 2 or more | `GET /livez`, `GET /readyz` on `WORKER_HEALTH_PORT` |
| Web (`apps/web`) | `pnpm --filter @agentos/web start` | 2 or more | `GET /` |
| PostgreSQL 16 | managed (RDS/Aurora, Cloud SQL, ...) | primary + standby | |
| Temporal | Temporal Cloud or a self-hosted cluster | | |
| AWS KMS | one symmetric key per environment | | |

Redis is not used. Postgres is the source of truth for every task, run, event and credential. Temporal holds only orchestration state.

## 2. Configuration reference (production)

With `AGENTOS_ENV=production` (or `NODE_ENV=production`), the API and the worker run `validateProductionConfig` at startup (`packages/platform/src/productionConfig.ts`). If any **required** rule fails, the process exits with code 1 and a single message that lists every problem. A **warning** is logged and does not block startup.

| Variable | Rule | Notes |
|---|---|---|
| `AGENTOS_ENV` | `production` | Enables the checks. |
| `DATABASE_URL` | required | Warning unless it contains `sslmode=require`, `verify-ca` or `verify-full`. |
| `AGENTOS_WORKFLOW_ENGINE` | **must be `temporal`** | The in-process engine is not durable. The default is `inprocess`, so an unset value is rejected. |
| `AGENTOS_KMS_PROVIDER` | **must be `aws`** | |
| `AGENTOS_AWS_KMS_KEY_ID` | **full key ARN** | Aliases are rejected because they can be re-pointed. |
| `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS` | ARNs, comma-separated | Only during a key change (section 6). |
| `AWS_REGION` or `AGENTOS_AWS_KMS_REGION` | required | |
| `AGENTOS_AWS_KMS_ENDPOINT` | https only | Only for a VPC endpoint. |
| `AGENTOS_DEV_KMS_KEYS`, `AGENTOS_DEV_KMS_ACTIVE_KEY` | **must be unset** | Development keys are refused even next to AWS KMS. |
| `AGENTOS_DEV_KMS_ALLOW_PRODUCTION` | **must be unset (any environment)** | Removed in 2C. |
| `AGENTOS_ENABLE_MOCK_PROVIDER` | **must be false** | |
| `TEMPORAL_ADDRESS` | **not localhost** | e.g. `<ns>.<acct>.tmprl.cloud:7233` |
| `TEMPORAL_NAMESPACE` | warning if `default` | Use one namespace per environment. |
| `TEMPORAL_TLS` + (`TEMPORAL_API_KEY` or `TEMPORAL_TLS_CERT_PATH`/`TEMPORAL_TLS_KEY_PATH`) | **TLS required** | `TEMPORAL_TLS_CA_PATH` for a private CA, `TEMPORAL_TLS_SERVER_NAME` for SNI. Certificate files must exist and be readable. |
| `TEMPORAL_ALLOW_PLAINTEXT_IN_PRODUCTION` | avoid | Logged opt-out, only for a network that already encrypts (service mesh). |
| `TEMPORAL_CONNECT_ATTEMPTS`, `TEMPORAL_CONNECT_TIMEOUT_MS` | default 5 attempts, 10 s | Startup fails clearly after the last attempt. |
| `AGENTOS_STEP_TIMEOUT_MS`, `AGENTOS_STEP_MAX_ATTEMPTS`, `AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS`, `AGENTOS_WORKFLOW_RUN_TIMEOUT_MS` | defaults 15 min, 5, 30 s, none | Recorded per workflow at start, so a change affects new tasks only. |
| `SESSION_COOKIE_SECURE` (API) | **must be true** | |
| `WEB_ORIGIN` (API) | **https** | |
| `AGENTOS_METRICS_TOKEN` | at least 32 chars | Unset disables `/metrics` (warning). |
| `AGENTOS_ALLOW_DEPLOYMENT_KEYS` | warning if true | |
| `AGENTOS_CREDENTIAL_CACHE_TTL_MS` | default 60 000, max 900 000 | How long a process keeps a decrypted provider key. |
| `AGENTOS_UNPRICED_CALL_RESERVE_USD` | default 0 | Budget reservation for models without a catalog price. |
| `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_FORCE_MS` (API) | 5 000 / 30 000 | |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST` | e.g. 9464, `0.0.0.0` in a pod | |
| `WORKER_SHUTDOWN_GRACE_MS`, `WORKER_SHUTDOWN_FORCE_MS` | 30 000 / 60 000 | |
| `TEMPORAL_WORKER_VERSIONING`, `TEMPORAL_WORKER_DEPLOYMENT_NAME`, `TEMPORAL_WORKER_BUILD_ID`, `TEMPORAL_WORKER_DEFAULT_VERSIONING` | see section 7 | A build id is required when versioning is on. |
| `TEMPORAL_WORKFLOW_BUNDLE_PATH` | recommended | Pre-built bundle (section 7). |

A complete template is in `deploy/production.env.example`.

Check a configuration without starting anything:

```bash
AGENTOS_ENV=production node --import tsx -e '
  import("@agentos/platform").then(({ validateProductionConfig }) =>
    console.log(JSON.stringify(validateProductionConfig(process.env, "api"), null, 2)))'
```

## 3. One-time setup

### 3.1 AWS KMS (unverified against real AWS)

1. Create a symmetric encryption key (`SYMMETRIC_DEFAULT`) in the deployment region and turn on automatic rotation. Automatic rotation keeps the key ARN, so AgentOS needs no change for it.
2. Key policy: use `deploy/aws/kms-key-policy.json`. Only the application role may call `GenerateDataKey`, `Encrypt` and `Decrypt`. The condition requires `kms:EncryptionContext:scheme = agentos-envelope-v1`, so the key cannot decrypt data from other systems.
3. IAM role for the API and worker (IRSA, ECS task role or instance profile): `deploy/aws/app-iam-policy.json`. Do not use static access keys. They trigger a warning.
4. CloudTrail data events for KMS record every decrypt with its encryption context, `organizationId` included. That is the per-organization audit trail of key use.

### 3.2 Temporal (unverified against Temporal Cloud)

1. Create a namespace per environment, e.g. `agentos-prod.<account>`.
2. Authenticate with either an API key (`TEMPORAL_API_KEY`) or mTLS (`TEMPORAL_TLS_CERT_PATH`/`TEMPORAL_TLS_KEY_PATH`, plus `TEMPORAL_TLS_CA_PATH` for a private CA). Store them in the secret manager and mount the certificates as files.
3. Verified locally: TLS with a private CA and SNI override, a rejected server certificate from the wrong CA, an mTLS refusal without a client certificate, and mTLS success with one, for both the API client and the worker's native connection (`apps/worker/test/temporal-production.test.ts`).

### 3.3 PostgreSQL

* PostgreSQL 13 or newer (the event cursor needs `xid8`). Developed and tested on 16.
* Set `idle_in_transaction_session_timeout` (e.g. `60s`) on the application role. A long-open write transaction holds the event watermark back (section 9).
* Turn on point-in-time recovery (see [backup-recovery.md](operations/backup-recovery.md)).
* Use a separate migration role with DDL rights. The application role needs DML only.

## 4. Release procedure

Each release is one immutable build (git commit `C`) of the API, worker and web, all from the same commit.

1. **Build:** `pnpm install --frozen-lockfile`, `pnpm --filter @agentos/workflows bundle`. Record the printed sha256 with the release.
2. **Verify:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:durability && pnpm test:e2e` (see AGENTS.md). A release with a failing suite does not ship.
3. **Back up:** take a manual snapshot or confirm PITR is healthy (backup-recovery section 2).
4. **Migrate:** `pnpm db:deploy` with the migration role, before any new code runs. Every migration must be backward compatible with the running release ([migrations.md](migrations.md)).
5. **Roll out workers:** start the new workers with `TEMPORAL_WORKER_BUILD_ID=C` and the new bundle, wait for `/readyz`, then stop the old workers (SIGTERM, which drains). With versioning on, also follow section 7.
6. **Roll out the API:** a rolling restart. Each instance reports not-ready, drains for `SHUTDOWN_DRAIN_MS` and ends its SSE streams. Clients resume on another instance from their cursor without losing events.
7. **Roll out web.**
8. **Smoke check:** `/readyz` on every instance. `/system/health` as an owner shows healthy workers, Temporal reachable, `kms: aws-kms` and `developmentOnly: false`. Run one task on a cheap model.
9. **Watch** for 30 minutes: error rate, `agentos_kms_operations_total{outcome!="ok"}`, activity retries, `agentos_possible_duplicate_billing_total`.

**Rollback:** redeploy the previous build. Migrations are additive, so the old code keeps working. Never roll back a migration that has already shipped (see migrations.md). Workflows that started on the new build either stay on it (versioning PINNED) or must be replay-compatible with the old code. Section 7 covers this.

## 5. Health, probes and monitoring

| Endpoint | Auth | Meaning |
|---|---|---|
| API `GET /livez` | none | Process serving. Restart on failure. |
| API `GET /readyz` | none | Database, Temporal (health RPC), event listener and KMS self-test (cached 60 s) all pass, and the instance is not draining. Booleans only; details go to the log as `not_ready`. |
| API `GET /metrics` | `Authorization: Bearer $AGENTOS_METRICS_TOKEN` | Prometheus text. |
| API `GET /api/v1/system/health`, `/system/metrics`, `/system/diagnostics` | session (owner sees hosts) | Product-level view, per organization. |
| Worker `GET /livez` | none | Not failed. |
| Worker `GET /readyz` | none | Polling Temporal, database reachable, not draining. |
| Worker `GET /metrics` | bearer token when set | Prometheus text. |

Alert on (suggested):

* Any instance not ready for 2 minutes or more.
* No healthy worker (`/system/diagnostics` `no_healthy_worker`) for 1 minute or more.
* `rate(agentos_kms_operations_total{outcome=~"config|integrity"}[5m]) > 0` (page). Integrity failures mean tampering or a copied row.
* `rate(agentos_kms_operations_total{outcome="unavailable"}[5m])` sustained.
* `increase(agentos_possible_duplicate_billing_total[1h]) > 0` (ticket).
* `agentos_event_listener_connected == 0` for 1 minute or more.
* `agentos_event_window_rows` growing steadily (a long transaction is holding the watermark).
* Temporal: schedule-to-start latency on `TEMPORAL_TASK_QUEUE`, workflow task failures (non-determinism).

Logs are pino JSON. Keys, cookies and authorization headers are redacted. Every lifecycle event has an `event` field: `startup_refused`, `config_warning`, `api_draining`, `worker_stopping`, `worker_shutdown_forced`, `temporal_connect_failed`, `event_listener_disconnected`, `event_reconcile_failed`, `budget_exceeded`, `possible_duplicate_billing`, `activity_retry`.

## 6. Key management operations

* **Provider key rotation (an organization's own key):** the owner enters the new key in Settings. A fresh data key is generated (`GenerateDataKey`), the old ciphertext is replaced, and the change is audited (`credential.updated`). Caches are keyed by row version, so every process uses the new key on its next call.
* **KMS key change (new CMK):**
  1. Create the new key and grant it the same policies.
  2. Deploy with `AGENTOS_AWS_KMS_KEY_ID=<new ARN>` and `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS=<old ARN>`.
  3. Run `pnpm --filter @agentos/api credentials:rotate`. It re-wraps data keys only; ciphertexts are unchanged and it is safe while tasks run. It prints `remaining`, which must be 0. Each row is audited as `credential.rotated`.
  4. Deploy without `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS`.
  5. Schedule deletion of the old key only after the backup retention window has passed (section 3 of backup-recovery). Backups still hold data keys wrapped by it.
* **Deletion:** removing a credential deletes the ciphertext and wrapped key (`credential.deleted`). It takes effect at once in every process. Deleting an organization cascades.
* **Suspected compromise:** see incident-response, scenario "Credential or KMS".

Verified against moto: envelope round-trip, a context mismatch refused by the KMS (cross-organization copy), re-wrap between two keys, deletion, audit, and the cache. moto does not enforce `DisableKey` on decrypt, so the disabled-key path is covered by unit tests with a fake client only.

## 7. Temporal workers: versions and compatibility

Workflow code must stay replay-compatible with every running workflow. Guard rails:

1. **CI replay check.** `apps/worker/test/temporal-production.test.ts` replays the committed milestone 2B histories (`apps/worker/test/fixtures/histories-2b/`) against the current code, and replays them again through the pre-built bundle. It also proves that an incompatible change fails. When you change workflow code, add histories from the release you are replacing.
2. **`patched()`** for every behaviour change to running workflows (AGENTS.md).
3. **Worker deployment versioning** (optional, recommended for large changes): set `TEMPORAL_WORKER_VERSIONING=true`, `TEMPORAL_WORKER_DEPLOYMENT_NAME=agentos-worker`, `TEMPORAL_WORKER_BUILD_ID=<commit>`, `TEMPORAL_WORKER_DEFAULT_VERSIONING=PINNED`. With PINNED, a workflow finishes on the build it started on. Keep old-build workers running until their workflows close, then retire them. Promote the new version with `temporal worker deployment set-current-version`. Locally verified: a versioned worker registers its deployment version with the dev server. Promotion and draining were not exercised.
4. **Workflow options** (timeouts, attempts) are stored in each workflow's input. Changing the environment affects new tasks only, and old histories replay unchanged.

## 8. Shutdown behaviour

* **API, SIGTERM:** `/readyz` returns 503 at once, the process waits `SHUTDOWN_DRAIN_MS` for the load balancer, then ends SSE streams and closes. It exits 0, or exits 1 after `SHUTDOWN_FORCE_MS`. Verified by `apps/api/test/ops.test.ts`.
* **Worker, SIGTERM:** `/readyz` returns 503 and the heartbeat says `stopping` at once. Polling stops, and in-flight activities get `WORKER_SHUTDOWN_GRACE_MS` to finish. Exit 0, or exit 1 after `WORKER_SHUTDOWN_FORCE_MS`. Steps still running when the deadline hits are retried on another worker after the heartbeat timeout, and every step is idempotent. Verified with a real process.
* **SIGKILL or a crash:** no drain. Temporal retries the step elsewhere. A model request that was in flight is flagged as possible duplicate billing (section 10).

## 9. Event streaming in production

* Each API instance holds one dedicated `LISTEN` connection. It does not go through a transaction-mode pooler such as PgBouncer, because LISTEN needs a session. Point `DATABASE_URL` at a session-mode endpoint, or at the database directly.
* Delivery is at-least-once. SSE ids are `<watermark>.<seq>` cursors, and clients de-duplicate by `seq` (the web client does).
* A long-running write transaction anywhere in the cluster holds the watermark back. Rows behind it are re-read on every pass, and `agentos_event_window_rows` grows. `idle_in_transaction_session_timeout` bounds this.

## 10. Spending controls

* Before every provider request, AgentOS reserves a conservative maximum: `maxOutputTokens` at the output price, plus the input estimated at 3 characters per token plus 20%. The reservation is checked against the agent's per-run budget and the task tree's `maxCostUsd`, together with recorded spend and other open reservations. Reservations are serialized per task tree with a Postgres advisory lock.
* `ModelCallAttempt` keeps one row per request. A request left open by a dead worker becomes `orphaned`. It is counted at its reserved maximum and reported as `billing.possible_duplicate`.
* All figures are estimates from catalog prices. Providers do not return a billed amount, so reconcile against the provider invoice monthly.
