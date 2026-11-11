# Milestone 2B report: durable execution, approvals, org credentials

Date: 2026-11-11. Branch `claude/milestone-2b-durable`, stacked on the milestone 1 + 2A branch (PR #1).

## What changed

| Area | Result |
|---|---|
| Execution | Agent tasks and pipelines run as Temporal workflows on dedicated worker processes (`apps/worker`). The API never calls a model or runs a tool when `AGENTOS_WORKFLOW_ENGINE=temporal`. The in-process engine is still available behind the same `WorkflowEngine` interface and is used by unit and API tests. |
| Determinism | Workflow code (`packages/workflows/src/workflows/`) only orchestrates. Every side effect is in an activity. The boundary checker forbids Node APIs and I/O packages in workflow code, and the test suite replays every recorded history against the current code. |
| Idempotent steps | The engine was split into steps (`beginRun`, `modelTurn`, `toolStep`, `pauseForApproval`, `resumeAfterApproval`, `failRun`, `cancelTask`). Each one is safe to retry: a stored model turn is reused, and a tool runs only after a compare-and-set to `running`. An interrupted side-effecting tool is marked "Outcome unknown" and never re-run. See `docs/durable-execution.md`. |
| Approvals | Approvals are durable (Postgres plus a workflow signal, with a database re-check on a backoff timer). They are scoped to the org, require the owner role, and are decided by compare-and-set. Stale and duplicate decisions get 409, and other orgs get 404. |
| Credentials | Per-org OpenAI, Anthropic and xAI keys use envelope encryption (AES-256-GCM, a fresh data key per write, AAD bound to org, provider and id) behind a `KeyManagementService` interface. The only KMS is `LocalDevKms`, which is dev-only and refuses production. The milestone includes KEK rotation (`credentials:rotate`), verify, delete, audit and an owner-only settings UI. There is no fallback to another org's key. Deployment env keys are used only when `AGENTOS_ALLOW_DEPLOYMENT_KEYS=true`. See `docs/credentials.md`. |
| Realtime | `RunEvent` inserts trigger `pg_notify`, and each API instance listens and re-reads the rows from Postgres, which stays the source of truth. Model deltas cross processes on a transient channel. The listener reconnects and catches up. Redis was not needed. |
| Observability | New endpoints `/system/health`, `/system/metrics`, `/system/diagnostics` and `/tasks/:id/workflow`. Also new: worker heartbeats plus a worker `/health`, `activity.retry` events, latency and attempt per model call, structured logs with redaction, and a `maxCostUsd` spending limit per task tree. |
| Dashboard | New execution panel (engine, Temporal, workers, listener, latency, stuck tasks), a workflow panel on the task page (status, attempts, child workflows, retries), and a credential management section in Settings. The dark design is unchanged. |

## Test evidence (all run in this environment on 2026-11-11)

| Suite | Infrastructure | Result |
|---|---|---|
| Typecheck | | 10/10 packages |
| Lint and package boundaries | | pass |
| tools / providers / runtime unit tests | | 25 / 32 / 37 pass (runtime includes 7 new step-idempotency tests) |
| API integration (`apps/api`) | real Postgres | 32 pass, including 9 new credential tests |
| Durability (`pnpm --filter @agentos/worker test:durability`) | real Temporal dev server 1.29.1 and Postgres 16, real OS processes killed with SIGKILL | 13/13 pass |
| Browser (Playwright) | Temporal engine with a separate worker process | 6/6 pass (4 milestone 1 regressions, 2 new) |
| Live, org credentials through the durable stack | real OpenAI and Anthropic | 2/2 pass |
| Live 2A provider suite (re-run) | real OpenAI and Anthropic | 21 pass, 10 skipped (no xAI key) |

The durability and recovery tests use the mock AI so they are deterministic. Live runs are a separate, optional check.

### The 14 scenarios

| # | Scenario | Where |
|---|---|---|
| 1 | API restart during a running task | durability test 1 |
| 2 | Worker killed mid model call, step moves to another worker, `activity.retry` recorded | durability test 2 |
| 3 | Approval survives an API and worker restart | durability test 3 + 4 |
| 4 | Approve after restart resumes the run | durability test 3 + 4 |
| 5 | Reject: tool never runs, and a stale second decision gets 409 | durability test 5 |
| 6 | Multi-agent pipeline as child workflows with a handoff | durability test 6 |
| 7 | Cancel a running model call (under 4 s), a waiting approval and a running pipeline | durability test 7 |
| 8 | Recoverable provider failure retried | durability test 8 |
| 9 | Side-effecting tool interrupted by a crash runs exactly once (counted by an external ledger) | durability test 9 |
| 10 | Org credential isolation: A uses A's key, B uses B's, C has none and is refused, a copied row fails to decrypt | `apps/api/test/credentials.test.ts` |
| 11 | KEK rotation, update, delete, owner-only, no key in logs, audit or events | `apps/api/test/credentials.test.ts` |
| 12 | A second API instance streams live events (including model deltas) produced by the worker | durability test 12 + 13 |
| 13 | Reconnect: `Last-Event-ID` replay, and the listener recovers after `pg_terminate_backend` | durability test 12 + 13 |
| 14 | Every recorded workflow history replays deterministically against the current code | durability replay test |

Also covered: the per-task spending limit, and health, metrics and diagnostics (durability suite). The browser tests cover the durable task view and the credential UI.

### Live evidence

`docs/evidence/milestone-2b-live-org-credentials.txt`. Each key was stored through the API as the org's encrypted credential, not given to the worker's environment. The provider's Models API verified it, and then a calculator-tool task ran on the worker.

* anthropic / claude-haiku-5-5: completed, result 395, est. $0.000195
* openai / gpt-6-luna: completed, result 395, est. $0.000084
* The test asserts that neither key appears in the API logs, worker logs or events.

## Behaviour changes to know about

* Deciding an approval now requires the **owner** role. Members get 403.
* Deployment environment keys are **off by default** (`AGENTOS_ALLOW_DEPLOYMENT_KEYS`). An org with no stored key cannot run agents on that provider.
* Credential storage needs `AGENTOS_DEV_KMS_KEYS` (dev) or a real KMS implementation. Without either, writes return 503.
* `AGENTOS_WORKFLOW_ENGINE` defaults to `inprocess`. Set it to `temporal` and run `apps/worker` to get durability.

## Known limitations (not hidden)

1. **A model call can be billed twice.** If a worker dies after the provider responds but before the message is stored, the retry calls the provider again. The window is milliseconds long and bounded by 5 attempts.
2. **No managed KMS is implemented or verified.** Only the dev KMS exists. AWS KMS, GCP KMS or Vault Transit must be added behind `KeyManagementService` before production.
3. **The spend limit is checked before each call,** so a task can overshoot by one call's cost.
4. **Live catch-up after a listener reconnect uses `seq > lastSeen`.** An event that commits late with a lower seq can be missed on the live stream. A reload or `Last-Event-ID` replay recovers it.
5. **No `continueAsNew` for very long approval waits.** History grows slowly (timer backoff up to 30 min), but a wait lasting months would need it.
6. **Temporal mTLS / Temporal Cloud is not wired.** Only the address and namespace are configurable.
7. **xAI is still unverified live.** There was no key.
8. **Minor milestone 1 quirk:** the handoff feed can read "Atlas handed off from Atlas".

## Infrastructure used

Temporal dev server 1.29.1 (SQLite, local), PostgreSQL 16, Node 22. `docker-compose.yml` now includes a `temporal` service for local use. Redis is not used. No deployment tooling, terminal execution or auto-merge was added.
