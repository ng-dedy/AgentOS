# Milestone 2C completion report: production infrastructure hardening

Date: 2026-11-11. Branch `claude/project-thread-3yxaiu`, stacked on `claude/milestone-2b-durable` (PR #2). Nothing was deployed and no cloud resource was created.

## Summary

All 14 findings in `docs/milestone-2c-plan.md` are addressed in code, tests or docs. Everything below was run in the build environment against real Postgres 16 and a real Temporal dev server. **Real AWS KMS, Temporal Cloud and a real mTLS cluster were not available and are unverified.** No live provider calls were made, and no provider keys were used.

## What changed

| Plan # | Area | Change | Evidence |
|---|---|---|---|
| 1, 2 | KMS | `AwsKms` adapter: `GenerateDataKey` AES_256 + `Decrypt`, encryption context `{scheme, purpose, organizationId, provider, credentialId}`, KeyId pinned to active/previous allowlist, classified errors (config / integrity / retryable), metrics. `AGENTOS_KMS_PROVIDER=aws\|local-dev`. Production without a managed KMS fails startup; the dev-KMS production override was removed (setting it is an error). | `packages/platform/test/kms.test.ts` (fake client + moto), `apps/api/test/kms-integration.test.ts` (moto + Postgres: org isolation refused by the KMS and audited, rotation to a new CMK, credential replacement, deletion, cache) |
| 9 | KMS | Short in-memory cache of decrypted keys (60 s default, keyed by id, `updatedAt`, KEK id), cleared on delete and shutdown. A non-retryable decrypt failure stops the run with `credential_unavailable`. | cache test makes 1 Decrypt for 5 resolves |
| 3, 5 | Config | `validateProductionConfig` / `assertSafeConfiguration` for API, worker and scripts. Refuses: in-process engine, dev KMS, mock provider, plaintext or localhost Temporal, missing/unreadable certs, insecure cookie, non-https origin, short metrics token, versioning without build id. Lists every problem. | `packages/platform/test/productionConfig.test.ts`; real-process refusal in `apps/api/test/ops.test.ts` and worker refusal in `temporal-production.test.ts` |
| 4, 13 | Temporal | TLS, mTLS, server name, API key; bounded connect retry with backoff and a clear startup error; `ping()` for readiness. | TLS and mTLS through a local Node TLS proxy with generated v3 certs; connection failure tests |
| 12 | Temporal | Configurable step timeout and attempts, optional workflow run timeout, Worker Deployment versioning (`workerDeploymentOptions`), bundle script with sha256. | Replay of 9 exported 2B histories against current code and the bundle; a deliberately incompatible workflow fails replay (the test has teeth); a deployment version registers on the dev server |
| 10, 11 | Ops | API and worker `/livez`, `/readyz` (booleans only), `/metrics` (Prometheus, bearer token, 404 when unset). SIGTERM withdraws readiness, closes SSE streams, drains, exits 0; force-exit backstop. Worker drains in-flight activities. | `ops.test.ts` (real process SIGTERM), worker SIGTERM drain and SIGKILL orphan detection tests |
| 6 | Events | `RunEvent.txid xid8` + snapshot-xmin watermark cursor (`<watermark>.<seq>` SSE ids), REPEATABLE READ reads, periodic reconciliation every 2 s even without notifications. Legacy numeric cursors keep their 2B meaning. At-least-once, deduped by seq. | `apps/api/test/events.test.ts`: two API instances, a late-committing transaction (the 2B race, shown to be missed by the legacy cursor and delivered by the new one), 8 writers × 25 events with random commit delays and a mid-stream reconnect, listener backend killed with a transaction open |
| 7, 8 | Budget | `ModelCallAttempt` ledger: worst-case reservation before every provider request under a per-tree advisory lock, per-run and per-tree limits, settlement at actual cost, `budget.exceeded` (before_call / after_call backstop), orphaned reservations counted as spent and flagged `billing.possible_duplicate`. | `packages/runtime/test/budget.test.ts` (10), engine tests; durability tests with process kills |
| 14 | Docs | `docs/deployment-runbook.md`, `docs/operations/backup-recovery.md` (pg_dump/restore verified locally, events and a credential readable after restore), `docs/operations/incident-response.md`, `docs/migrations.md`, `deploy/` (production env template, KMS key policy, IAM policy, Kubernetes manifest). Architecture, credentials, durable-execution, risk register, AGENTS.md and `.env.example` updated. | — |

## Verification run

| Command | Result |
|---|---|
| `pnpm typecheck` | 10/10 packages |
| `pnpm lint` | clean, package boundaries OK |
| `AGENTOS_TEST_KMS_ENDPOINT=http://127.0.0.1:5055 pnpm test` | 192 passed (tools 25, providers 32, runtime 48, platform 37, API 50), 0 skipped |
| `pnpm test:durability` | 26/26 (13 from 2B + Temporal production suite) |
| `pnpm test:e2e` | 6/6 Playwright (desktop + mobile) on Temporal + worker |

Baseline before 2C: 126 unit/API tests and 13 durability tests, all passing. No existing test was skipped or loosened; tests whose expectations changed with the new behaviour are listed below.

## Behaviour changes to know before merging

* Production (`AGENTOS_ENV=production` or `NODE_ENV=production`) now refuses to start unless it has Temporal over TLS, AWS KMS, secure cookies, an https origin and no mock provider.
* `AGENTOS_DEV_KMS_ALLOW_PRODUCTION` no longer exists; setting it stops startup everywhere.
* SSE event ids are now `<watermark>.<seq>`. Clients that parse ids as integers must take the part after the dot (the web app does not parse them). Old numeric `Last-Event-ID` values still work.
* A model call is refused before it is sent if its worst-case cost would exceed the remaining budget. Previously a run could overshoot by one call; now a call that would fit after the fact but not in the worst case is refused. Tests updated: the old "records the spend" engine test became a pre-call refusal test plus an after-call backstop test.
* Migration `20261111090000_production_hardening` adds a nullable `txid` column (no table rewrite) and the `ModelCallAttempt` table.

## Not verified

* Real AWS KMS (IAM, key policy, CloudTrail, multi-Region keys). moto does not enforce `DisableKey` on Decrypt; that path is covered only by the fake client.
* Temporal Cloud, API key auth against a real namespace, and a real mTLS cluster.
* Promoting and draining Worker Deployment versions on a real cluster (only registration was exercised).
* RDS point-in-time recovery and cross-Region restore.
* The Kubernetes manifest was not applied to any cluster.
* Live provider tests were not re-run in 2C (no keys were used, per instruction).

## Known limitations

* Costs remain estimates from token counts and a static price list. A provider can bill a request whose reply was lost; AgentOS flags it as a possible duplicate but cannot prevent or reconcile it against an invoice.
* Event delivery is at-least-once: clients must drop repeats by seq.
* Unpriced models reserve a flat `AGENTOS_UNPRICED_CALL_RESERVE_USD` per call.
