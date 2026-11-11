# Durable execution

From milestone 2B, agent tasks run as Temporal workflows on dedicated worker processes. The API creates tasks and starts, signals, cancels and describes workflows, but it never calls a model or runs a tool. Postgres is still the source of truth for every task, run, tool call, approval, message and event.

```
browser ──HTTP/SSE──▶ API instances (N) ──start / signal / cancel──▶ Temporal ──▶ worker processes (M)
                          ▲                                                         │
                          └── LISTEN agentos_events ◀── trigger on RunEvent ◀───────┤  events
                          └───────────────── PostgreSQL (source of truth) ◀─────────┘  state, usage
```

## Running it

```bash
docker compose up -d                        # Postgres :5432 and Temporal dev server :7233 (UI :8233)
pnpm db:deploy
pnpm --filter @agentos/worker start         # one or more workers
pnpm --filter @agentos/api dev              # AGENTOS_WORKFLOW_ENGINE=temporal (see .env.example)
pnpm --filter @agentos/web dev
```

`AGENTOS_WORKFLOW_ENGINE=inprocess` keeps the milestone 1 behaviour (execution inside the API, not durable). It is used by the unit and API tests.

## Workflows

**`agentTaskWorkflow`**, workflow id `task-<taskId>` (stored on `Task.workflowId`):

1. `beginRun`: validate the task, then create a run or resume the latest unfinished one.
2. Loop: `modelTurn(n)`, then `toolStep` for each tool call. While an approval is pending it waits on the `approvalDecided` signal. It also re-checks Postgres on a timer that starts at 30 s and doubles up to 30 min, so a lost signal delays a resume but cannot hang it.
3. Ends with a `TerminalOutcome` (completed, failed or cancelled), which is the same value the database holds.

**`pipelineWorkflow`** loops over the `advancePipeline` activity, which is idempotent and returns the next step or "done". Each step runs as a child `agentTaskWorkflow`. Cancelling the pipeline cancels the running child first, then settles the remaining steps as skipped.

Workflow code lives in `packages/workflows/src/workflows/`. It is bundled into Temporal's deterministic sandbox, and the boundary checker forbids Node APIs and I/O packages there. The durability suite replays every recorded history against the current code.

## Why retries do not repeat side effects

| Step | Guarantee |
|---|---|
| `beginRun` | Resumes the latest `running` or `awaiting_approval` run. It never creates a second run for the same execution. |
| `modelTurn(n)` | If run `r` already has a stored assistant message for turn `n`, that message is reused and the provider is **not** called again. The message is persisted before usage, events or limit checks. |
| `toolStep` | A tool runs only after a compare-and-set moves it from `requested` (or `awaiting_approval` once approved) to `running`, done as a single conditional `UPDATE`. A tool already in a terminal state is not run again; the step only re-appends its stored result if that is missing. |
| Interrupted tool | If a worker dies while a **side-effecting** tool is `running`, the retry marks it `failed` with "Outcome unknown" and does not run it again. The model sees that error. A **safe** (read-only) tool is re-run. |
| Approval | One approval per tool call (unique `toolCallId`, created by upsert). Deciding is a compare-and-set on `pending`. |
| Finalizers | `cancelTask` and `failRun` do nothing on a task that is already terminal. |

**Remaining exposure (documented, not hidden):** if a worker dies after the provider has produced a response but before the assistant message is stored, the retry calls the provider again. The provider bills both calls. This window is milliseconds long and bounded by the 5-attempt limit.

## Activity policy

| Setting | Value | Why |
|---|---|---|
| Retries | 5 attempts, backoff 1 s × 2, maximum 30 s | Infrastructure faults only. Business failures are returned as values. |
| Heartbeat timeout | 30 s (`AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS`) | A dead worker's step moves to another worker within this time. The tests use 3 s. |
| Heartbeat interval | min(5 s, timeout / 3) | Also carries cancellation to running activities. |
| Start-to-close | 15 min (steps), 1 min (finalizers) | A model turn includes the engine's own provider retries. |
| Cancellation | `WAIT_CANCELLATION_COMPLETED` | The workflow waits until the step has recorded the cancellation. |

When the retries run out, the task fails with `execution_failed`. The failure records which step failed and the last error, and the task stays retryable from the UI.

## Cancellation

The API first sets `Task.cancelRequestedAt`, so running steps see it even if the RPC is lost, and then cancels the workflow. A running model call is aborted through the activity's AbortSignal. In the test, a cancelled 4 s mock call ended in under 4 s. A waiting approval is closed as rejected. If no workflow is running, the API finalizes the task directly.

## API restarts and dispatch

An API restart does not affect workflows. `recoverInterruptedTasks`, which marks in-flight tasks failed, runs only in `inprocess` mode. If Temporal is unreachable when a task is created, the task stays `queued`. A dispatcher in each API instance (every `DISPATCH_RECONCILE_MS`, default 15 s, and once at boot) then starts workflows for top-level tasks that have none. This is idempotent because the workflow id is derived from the task id.

## Realtime events across processes

* Each `RunEvent` insert fires a trigger that runs `pg_notify('agentos_events', {o, r, s})` with ids only, delivered after commit.
* **Commit-safe cursor (2C).** `seq` comes from a sequence, so a transaction can commit after a later seq is already visible; 2B's `seq > lastSeen` catch-up could skip such an event forever. Each row now also records `txid xid8 DEFAULT pg_current_xact_id()`. A reader takes, in one REPEATABLE READ transaction, the watermark `pg_snapshot_xmin(pg_current_snapshot())` and the rows with `txid >= previous watermark`. Every transaction below the watermark had finished when the snapshot was taken, so nothing below it can appear later. SSE ids are `<watermark>.<seq>`; a bare number is still accepted as a 2B cursor with its old meaning.
* Each API instance holds one `LISTEN` connection (`PgEventListener`). Notifications trigger a debounced pass, and a pass also runs every `EVENT_RECONCILE_MS` (2 s) regardless, so a dropped notification or listener connection only delays delivery. Passes are serialized; the watermark starts at the current xmin.
* Delivery is **at-least-once**. Overlapping windows return some rows again; the bus and SSE drop them by seq, and a client reconnecting with its cursor may see repeats it must drop by seq. Postgres stays the source of truth.
* Live-only `model.delta` chunks travel on `agentos_transient` and are never replayed.

Verified with two API instances on real Postgres: delayed commits, 8 concurrent writers × 25 events with random commit delays, a mid-stream reconnect, and the listener's backend killed while a transaction was open (`apps/api/test/events.test.ts`).

## Observability

| Endpoint | What it shows |
|---|---|
| `GET /system/health` | Engine, Temporal reachability and pollers, worker heartbeats (healthy = seen within 30 s), event listener state, KMS |
| `GET /tasks/:id/workflow` | Temporal describe (status, history length, pending activities with attempt and last failure), child workflows, retry history |
| `GET /system/metrics` | Queue latency, run duration and model latency (p50/p95), failures by code, model and worker-step retries (7 days, per organization) |
| `GET /system/diagnostics` | Tasks without a workflow, DB/workflow mismatches, activities on attempt > 2, tool calls `running` > 10 min, no healthy worker, stale workers |

Workers write a `WorkerHeartbeat` row every 5 s and can expose `GET /health` on `WORKER_HEALTH_PORT`. Logs are structured JSON with `event` names (`model_call`, `model_call_failed`, `activity_retry`, `activity_failed`, `run_failed`, `worker_started`, ...). Credential-bearing fields are redacted. Usage records store latency and attempt per model call.

**Spending limits (2C).** Before every provider request the engine reserves the worst-case cost of that request (input estimate plus `maxOutputTokens`, priced from the catalog, or `AGENTOS_UNPRICED_CALL_RESERVE_USD` when unpriced) in `ModelCallAttempt`, under a per-tree advisory lock. The request is refused with `budget.exceeded` (phase `before_call`) when committed spend plus open reservations plus this reservation would pass the run's or the tree's `maxCostUsd`. After the reply the reservation is settled at the reported cost. A reservation left open by a dead worker, or a reply that was never stored, is counted as spent and flagged `billing.possible_duplicate`. All figures are estimates from token counts and a static price list, not provider invoices.

## Production notes

Production requires `AGENTOS_WORKFLOW_ENGINE=temporal`; the in-process engine is refused. The connection supports TLS and mTLS (`TEMPORAL_TLS`, `TEMPORAL_TLS_CA_FILE`, `TEMPORAL_TLS_CERT_FILE`/`KEY_FILE`, `TEMPORAL_TLS_SERVER_NAME`) or a Temporal Cloud API key (`TEMPORAL_API_KEY`), retries connection with backoff (`TEMPORAL_CONNECT_ATTEMPTS`), and fails startup with a clear message. Step activities take `AGENTOS_STEP_TIMEOUT_MS` and `AGENTOS_STEP_MAX_ATTEMPTS`; `AGENTOS_WORKFLOW_RUN_TIMEOUT_MS` bounds a workflow run. Workers can register as Worker Deployment versions (`TEMPORAL_WORKER_VERSIONING=true` with `TEMPORAL_WORKER_BUILD_ID`), expose `/livez`, `/readyz` and `/metrics`, and drain on SIGTERM. Workflow code changes must pass the replay test against `apps/worker/test/fixtures/histories-2b/`. TLS was verified through a local TLS proxy in front of the dev server; **Temporal Cloud and a real mTLS cluster are not verified**. See `docs/deployment-runbook.md`.
