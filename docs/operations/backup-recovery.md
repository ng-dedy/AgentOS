# Database backup and recovery

Status: procedure for Milestone 2C (2026-11-11). It has not been run against a production database. The local checks in section 5 have been run.

## 1. What must be backed up

| Store | Holds | Backup |
|---|---|---|
| PostgreSQL | Everything durable: organizations, users, sessions, agents, tasks, runs, messages, tool calls, approvals, run events, usage, budget ledger (`ModelCallAttempt`), audit log, encrypted provider credentials | **Required.** Continuous PITR plus daily snapshots. |
| AWS KMS key(s) | The key that wraps every credential's data key | KMS keys cannot be exported. Never schedule deletion of a key while any backup inside the retention window may still reference it. |
| Temporal | Workflow histories and timers (orchestration only) | Temporal Cloud handles its own. Postgres alone is enough to recover task state (section 4). |

Credentials in a backup stay encrypted. A restored database can only decrypt them with the same KMS key and encryption context, so a stolen backup does not expose provider keys.

## 2. Policy (recommended)

* Point-in-time recovery: 7 to 35 days (RDS automated backups or equivalent). RPO is 5 minutes or less.
* A daily snapshot, kept 30 days, copied to a second region or account.
* A manual snapshot before every migration (runbook section 4, step 3).
* `pg_dump` logical export weekly, encrypted, for long-term retention and restore testing:

```bash
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > agentos-$(date +%F).dump
```

## 3. KMS key retention rule

Backups hold data keys wrapped under whichever KMS key was active then. After a KMS key change (runbook section 6), keep the old key enabled, or at least not scheduled for deletion, until the oldest backup that references it has expired. Disabling it is enough to stop use. To see which keys a restored database references:

```sql
SELECT "kekId", count(*) FROM "ProviderCredential" GROUP BY 1;
```

## 4. Restore procedures

### 4.1 Point-in-time restore (bad migration, data corruption, accidental delete)

1. Declare an incident (incident-response). Stop the workers first (SIGTERM), then the API, so nothing writes to the old database.
2. Restore to a new instance at a time `T` just before the fault.
3. Run `pnpm db:deploy` against it. It must report no pending migrations, or only ones that are safe to re-apply.
4. Point `DATABASE_URL` at the restored instance and start the API and the workers.
5. Reconcile with Temporal:
   * Tasks created after `T` are gone from Postgres. Their workflows fail at `beginRun` with "Task not found" and stop (business failure, no retry storm). Terminate them in bulk: `temporal workflow terminate --query 'StartTime > "<T>"' --reason "db restore"`.
   * Tasks that existed at `T` and are still `queued`, `running` or `awaiting_approval` continue. A step whose result was lost is re-executed. A side-effecting tool that was `running` at `T` is marked "Outcome unknown" and **not** re-run (the idempotency rules in durable-execution.md).
   * A model call whose result was lost is called again. The ledger flags it as possible duplicate billing.
   * `/system/diagnostics` lists `workflow_mismatch` and `not_dispatched` tasks. Retry or cancel them from the UI. The API's dispatcher starts workflows for tasks that have none.
6. Clients reconnect. Event cursors from before the restore point at transaction ids the restored database may not have reached yet. Replay then returns fewer events and the UI reloads from the API. Nothing breaks, but a reload is recommended after a restore.

### 4.2 Full region loss

Restore the latest cross-region snapshot in the recovery region. The KMS key must be available there: use a multi-Region key (`mrk-...`) with a replica, set `AGENTOS_AWS_KMS_KEY_ID` to the replica ARN and `AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS` to the primary ARN, then run `credentials:rotate` once (it re-wraps under the replica). Point Temporal to the recovery namespace (Temporal Cloud multi-region namespaces fail over themselves). Then follow 4.1 from step 3. *Unverified: multi-Region KMS and Temporal failover were not available in the build environment.*

## 5. Restore testing

Run quarterly, and after any schema change that touches credentials or events:

1. Restore the latest snapshot into an isolated environment with the **same** KMS key (read-only grant: `Decrypt` only).
2. `pnpm db:deploy` reports nothing to apply.
3. Count rows per table against production, which should be within the snapshot window.
4. Pick one credential per provider and run the Settings "Verify" action. It decrypts through the KMS and calls the provider's read-only models endpoint.
5. Open a completed task in the UI. Its event history replays.
6. Record the time taken (the RTO).

Locally verified on 2026-11-11 (Postgres 16, same cluster): `pg_dump --format=custom` of the test database and `pg_restore` into a new database. Both copies returned the same 10 events through a `<watermark>.<seq>` cursor read. The stored credential decrypted from the restored copy through the AWS KMS adapter (moto emulator), because the wrapped key and encryption context survive a logical dump. Not verified: RDS PITR, cross-region copy, multi-Region KMS.

### Logical restore into a different cluster

`RunEvent.txid` holds transaction ids of the source cluster. A physical restore (PITR, snapshot) keeps the transaction counter, so nothing changes. After a logical `pg_restore` into a different cluster, the new counter can be lower than the stored ids. Every reconciliation pass would then re-read those rows until the counter catches up, which is correct but wasteful. Clear the column once after such a restore. The rows are committed history, below any watermark:

```sql
UPDATE "RunEvent" SET "txid" = NULL WHERE "txid" IS NOT NULL;
```
