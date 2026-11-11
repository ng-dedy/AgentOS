# Incident response

Status: written for Milestone 2C (2026-11-11). AgentOS is not deployed yet. Adapt roles and on-call tooling when it is.

## Roles and severities

| Severity | Examples | Response |
|---|---|---|
| SEV1 | Credential exposure or KMS integrity failures; data loss; all tasks failing | Page immediately; incident commander (IC) + scribe; status updates every 30 min |
| SEV2 | Degraded execution (workers down, Temporal unreachable), events not streaming, sustained possible duplicate billing | Page during business hours, otherwise next morning unless customers are blocked |
| SEV3 | A single organization affected, cosmetic, a single failed task | Ticket |

The IC owns decisions. Nobody deploys, migrates or restores during an incident without the IC's approval. Production changes still need the owner's explicit authorization.

## First five minutes

1. Open the incident channel or doc and note the time.
2. Get a snapshot of the system: `/readyz` on every API and worker instance, `/api/v1/system/health` and `/system/diagnostics` as an owner, and the Temporal UI for the namespace (task queue pollers, failing workflows).
3. Check the most recent deploy and migration. If the incident started right after one, roll back the code first (runbook section 4). Never roll back a migration.
4. Grep logs for `"event":"startup_refused"`, `event_reconcile_failed`, `activity_failed`, `possible_duplicate_billing`, `budget_exceeded` and `credential.decrypt_failed` (audit).

## Playbooks

### Workers down or tasks not progressing
* Symptoms: `no_healthy_worker` in diagnostics, Temporal schedule-to-start latency rising, tasks stuck in `running`.
* Check worker `/readyz` and logs. `Cannot connect the worker to Temporal` means connectivity or credentials (see Temporal unreachable). `Refusing to start` means a configuration change; the message names the variable.
* Start more workers. Each step is idempotent, and a step lost to a crash retries on another worker after `AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS`.
* Workflow task failures with `Nondeterminism error` mean a workflow code change is not replay-compatible. Roll back the worker build at once. Under versioning PINNED, keep the old build's workers running. Then fix the change with `patched()` and add the failing history to `apps/worker/test/fixtures`.

### Temporal unreachable
* The API keeps serving reads. New tasks are created in Postgres and stay `queued`, and the dispatcher starts their workflows when Temporal returns (`DISPATCH_RECONCILE_MS`). `/readyz` reports `temporal: false`. Consider leaving that probe out of the load balancer's check during a Temporal-only outage, so reads keep working (operator decision).
* Check certificates first (expiry: `openssl x509 -enddate -in $TEMPORAL_TLS_CERT_PATH`), then the API key and namespace, then the network.

### Credential or KMS
* **`outcome="integrity"` or `credential.decrypt_failed` with `KMS_INTEGRITY`:** a ciphertext does not match its organization, provider or id. Treat this as possible tampering (SEV1). Freeze writes to `ProviderCredential` for the organization(s) involved. Compare `updatedAt` and the audit log against CloudTrail. Ask the affected owners to rotate the provider keys at the provider and re-enter them.
* **`KMS_CONFIG` (AccessDenied, Disabled, NotFound):** a key policy, IAM or key-state change. Revert it. Runs fail with `credential_unavailable` (retryable from the UI) until fixed.
* **`KMS_UNAVAILABLE` (throttling or outage):** steps retry. Raise the KMS request quota if this is sustained. The decrypted-key cache (`AGENTOS_CREDENTIAL_CACHE_TTL_MS`) cuts call volume.
* **Suspected provider key leak:** the owner revokes the key at the provider first, then replaces it in Settings. Check the provider's usage dashboard. AgentOS never logs keys (tests assert this), so look for other exposure paths: screenshots, chat, CI logs.
* **Suspected KMS key compromise:** create a new key, run the key change procedure (runbook section 6), then revoke the old key's grants and disable it once re-wrap reports 0 remaining. Provider keys are only safe if they never left the system: rotate them too.

### Events not streaming or the UI stale
* `agentos_event_listener_connected == 0`: the instance reconnects with backoff on its own. If it stays down, check the database connection limit and session-mode pooling (LISTEN does not work through transaction pooling).
* `agentos_event_window_rows` growing: a long-open write transaction is holding the watermark. Find it with `SELECT pid, xact_start, state, query FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start` and end it if it is safe to.
* Data is never lost here: Postgres is the source of truth and a reload rebuilds the UI. Delivery resumes from client cursors.

### Possible duplicate billing
* `billing.possible_duplicate` events and `ModelCallAttempt` rows with `possibleDuplicate = true` or `status = 'orphaned'` mean a request may have been billed without its result being kept. This is expected occasionally after worker crashes. A sustained rate points to crashing or OOM-killed workers, or a too-short heartbeat timeout.
* Quantify it:

```sql
SELECT date_trunc('day', "createdAt") d, count(*) FILTER (WHERE status='orphaned') orphaned,
       count(*) FILTER (WHERE "billingUnknown") billing_unknown, sum("reservedUsd") FILTER (WHERE status='orphaned') max_usd
FROM "ModelCallAttempt" GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

* Amounts are upper-bound estimates. Reconcile with the provider invoice.

### Runaway spend
* Budget stops show up as `budget.exceeded` events and failures with `failureCode = budget_exceeded`. If spend is high but nothing is stopping, check agents' `maxRunCostUsd` and tasks' `maxCostUsd`. Pause the agent (status `paused`) to stop new runs. Cancel running tasks from the UI: cancellation reaches an in-flight model call in under 4 s.

### Bad migration
* Stop and assess. If the schema is intact but data is wrong, fix forward. If data is lost, restore (backup-recovery section 4.1). Never run down SQL by hand.

## After the incident
* A blameless review within 5 working days: timeline, impact (organizations, tasks, estimated cost), root cause, what detection missed, and action items with owners.
* Add a regression test for the failure mode, the way the 2B event race got `apps/api/test/events.test.ts`.
