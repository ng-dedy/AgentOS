# Safe database migrations

Prisma migrations live in `packages/db/prisma/migrations/`. Production applies them with `pnpm db:deploy` (`prisma migrate deploy`), using a migration role, **before** new application code starts.

## Rules

1. **Expand, then contract.** A migration must work with both the running release and the next one. Add nullable columns and new tables first and ship code that writes them. Backfill in batches. Only in a later release drop the old column or add `NOT NULL`.
2. **No table rewrites on hot tables.** On `RunEvent`, `Message`, `ToolCall` and `UsageRecord`, avoid `ADD COLUMN ... DEFAULT <volatile>`, type changes and `NOT NULL` additions without a validated `CHECK`. The 2C `txid` column shows the pattern: add it without a default, then `SET DEFAULT` (both metadata-only).
3. **Indexes on large tables:** Prisma runs each migration in a transaction, so `CREATE INDEX CONCURRENTLY` cannot be used inside it. Before deploying, create the index by hand with `CREATE INDEX CONCURRENTLY IF NOT EXISTS <same name> ...`. The migration uses `IF NOT EXISTS` and becomes a no-op.
4. **Lock timeouts:** run migrations with `SET lock_timeout = '5s'` (for example `PGOPTIONS='-c lock_timeout=5s' pnpm db:deploy`). A blocked migration then fails fast instead of queueing every query behind it, and is retried.
5. **Never edit a migration that has shipped.** Fix forward with a new migration.
6. **Never roll back a shipped migration with down SQL.** Roll back the code. The schema is backward compatible by rule 1.
7. **Check for drift before merging:** `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against a database migrated from scratch must print an empty migration.
8. **Test on a copy:** apply to a restored snapshot (backup-recovery section 5) and time it.

## Procedure

```bash
# 1. Snapshot (or confirm PITR) — backup-recovery §2
# 2. Pre-create big indexes concurrently if the migration adds any (rule 3)
# 3. Apply
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min' DATABASE_URL=$MIGRATION_DATABASE_URL pnpm db:deploy
# 4. Confirm
DATABASE_URL=$MIGRATION_DATABASE_URL npx --prefix packages/db prisma migrate status
```

## A failed migration

`prisma migrate deploy` records a failed migration and refuses to apply more (`P3009`). Do this:

1. Find out which statements ran. Postgres DDL is transactional, so normally none did.
2. If nothing was applied: `npx prisma migrate resolve --rolled-back <name>`, fix the cause, then deploy again.
3. If the migration was applied by hand: `npx prisma migrate resolve --applied <name>`.

This happened during 2C development (a stray line in the SQL file) and was resolved exactly this way. The application never ran against a half-applied schema.

## Milestone 2C migration (`20261111090000_production_hardening`)

* `RunEvent.txid xid8` added nullable with no rewrite, then a default of `pg_current_xact_id()`. Existing rows stay NULL, which is correct: they sit below every watermark.
* `RunEvent_txid_idx`: on a large `RunEvent` table, pre-create it concurrently (rule 3).
* New table `ModelCallAttempt` with its indexes and an FK to `Organization`.
* Backward compatible: 2B code ignores both.
