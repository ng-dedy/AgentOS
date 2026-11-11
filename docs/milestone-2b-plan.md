# Milestone 2B: architecture review and migration plan

Date: 2026-11-11. Starting point: the milestone 2A codebase (PR #1).

## 1. Review of the current system

| Area | Today | What blocks durability |
|---|---|---|
| Runtime (`packages/runtime/src/engine.ts`) | `AgentEngine.execute()` runs a whole task in one async call: model, then tools, then model, in a loop. All state is persisted to the `RunStore` | The loop is one long unit, so a crash means rerunning everything. Steps are not individually idempotent: model turns are not keyed and tool execution has no CAS (compare-and-set) guard |
| Orchestration (`workflow.ts`) | `InProcessWorkflowEngine` inside the API process. Pipelines advance through `advancePipeline()` (already idempotent) | Execution lives in the API request process, so an API restart kills runs. `recoverInterruptedTasks` marks them failed |
| Task state | Postgres: Task, AgentRun, ToolCall, Approval, Message, RunEvent | No workflow/execution id; nothing owns a running task |
| Provider gateway | `ProviderRegistry` with deployment-wide env keys (`EnvSecretsProvider`), clients cached per process | No per-organization credentials; a configured key is shared by every organization |
| Tools | Registry + Zod validation + allowlist; `mock_external_action` gated by approval | Re-execution after a crash would repeat side effects |
| Events | Persist-then-publish to an in-memory `EventBus`; SSE replays from Postgres | A worker process cannot reach the API's bus; multiple API instances do not share live events |
| Approvals | Compare-and-set decision on `pending`; any org member can decide | A decision on a terminal or cancelled task is accepted; members (not only owners) can approve |
| Auth | Opaque DB sessions; owner/member roles | Fine. Approvals and credential management need role checks |
| Tests | 110 unit/integration, 4 browser, live provider suites | No real-infrastructure durability tests |

## 2. Target architecture

```
browser ──HTTP/SSE──> API instances (N) ──start/signal/cancel──> Temporal ──tasks──> Worker processes (M)
                          │  ▲                                                        │
                          │  └──── LISTEN agentos_events ◄── pg_notify ◄─────────────┤ (events)
                          └──────────────── PostgreSQL (source of truth) ◄────────────┘ (state, usage, events)
```

* **`packages/workflows`** (new): Temporal workflow definitions (deterministic: they import only `@temporalio/workflow` and types), the activity implementations, and `TemporalWorkflowEngine` (the client-side `WorkflowEngine`).
* **`apps/worker`** (new): a dedicated worker process. It hosts the workflows and activities, owns provider calls and tool execution, sends heartbeats and reports health.
* **API**: no longer executes agents in Temporal mode. It creates tasks, then starts, signals and cancels workflows, and serves SSE from Postgres plus LISTEN/NOTIFY.
* **`AGENTOS_WORKFLOW_ENGINE`** is `temporal` (default for dev and the browser tests) or `inprocess` (kept for unit tests and as a fallback). Both run the same step functions, so behaviour cannot drift.

### Workflow design

`agentTaskWorkflow({orgId, taskId})`, workflow id `task-<taskId>` (persistent execution id, stored on the task):

1. Activity `beginRun`: create or resume the run. Returns the already completed turn count and any tool calls still unresolved.
2. Loop:
   * Activity `modelTurn(turn n)`: one model call. **Idempotent per (run, turn)**: if the assistant message for turn n is already persisted, it returns the stored result without calling the model again.
   * For each tool call, activity `toolStep(toolCallId)`: authorization, validation, then either the approval request or execution. A status CAS `requested → running` guarantees at most one execution. If a worker dies while a *side-effecting* tool is `running`, the retry marks it `failed: outcome unknown` and does not run it again. Safe (read-only) tools may be re-run.
   * When an approval is pending: a durable wait on the `approvalDecided` signal, with a periodic re-check of the database as a fallback so a lost signal cannot hang the task. Then activity `approvalStep` executes the tool or records the rejection, using the same CAS.
   * Loop guard: consecutive turns in which every tool failed lead to a `tool_failure_limit` failure.
3. Cancellation: the API sets `cancelRequestedAt` and cancels the workflow. Running activities see it through heartbeats and an AbortSignal. The workflow finalizes as `cancelled` in a non-cancellable scope.

`pipelineWorkflow({orgId, taskId})`: loops over activity `advancePipeline`, which is idempotent and returns the next child to run, and runs each step as a child `agentTaskWorkflow`. Cancelling the parent cancels the child.

Activity policies:
* Bounded retries: at most 5 attempts with exponential backoff.
* Heartbeat timeout of 30 s, so a dead worker's activity moves to another worker.
* Start-to-close timeouts sized from the provider timeout and the retry budget.

Business failures such as budget, refusal or auth are returned as results, not thrown, so Temporal does not retry them.

### Credentials (Phase 5)

* `ProviderCredential` table: org, provider, AES-256-GCM ciphertext, nonce, tag, wrapped data key, KEK id, a hint (last 4 characters), verification status, and audit fields. Unique per (org, provider).
* Envelope encryption with Node `crypto`, no custom algorithm. Each credential gets a random 256-bit data key and is encrypted with AAD = `org|provider|credentialId`, so moving ciphertext to another org fails to decrypt. The data key is wrapped by a `KeyManagementService`.
* `KeyManagementService` implementations:
  * **`LocalDevKms`** (development only, clearly labelled): KEKs from `AGENTOS_DEV_KMS_KEYS`. It refuses to start when `NODE_ENV=production` unless explicitly overridden.
  * A documented seam for AWS KMS, GCP KMS or Vault Transit. No managed KMS is reachable from this environment, so none can be verified here.
* Rotation: a new active KEK id, then `rotate` re-wraps the data keys (the ciphertext stays as is). Replacing the credential value is a separate update.
* `OrgSecretsProvider.getProviderKey(orgId, provider)`: an organization's own key. The deployment env key is used only when `AGENTOS_ALLOW_DEPLOYMENT_KEYS=true`, and is then labelled "deployment key" in the UI. There is no fallback to another org.
* Adapters take the key per call (client cache keyed by a key fingerprint). Discovery and connection checks use the calling org's key.
* API: list, put, delete and verify credentials, owner only, audited. The UI is a credential form per provider in Settings.

### Events (Phase 6)

* The sink inserts the RunEvent row and then runs `pg_notify('agentos_events', {o, s})` (ids only, well under the 8 KB payload limit). Transient deltas are sent as notify payloads, chunked.
* Each API instance holds one dedicated `LISTEN` connection, fetches notified rows by seq and publishes to its local bus. After a reconnect it catches up with `seq > lastSeen`.
* SSE de-duplicates by seq set (not only by a monotonic cursor), so slightly out-of-order commits across different tasks are still delivered. Replay (`Last-Event-ID`) is unchanged.

### Observability (Phase 7)

* `WorkerHeartbeat` rows: worker id, host, pid, queue, version, active activities, last seen. Workers are reported healthy within 30 s of a heartbeat.
* Temporal task-queue poller check.
* `GET /tasks/:id/workflow`: Temporal describe, with status, history length and pending activities including attempt counts and last failures.
* `activity.retry` events (retry history). Model-call latency and attempt recorded on usage records.
* `GET /system/metrics`: queue latency, run duration and model latency percentiles, and failures by code.
* `GET /system/diagnostics`: DB/workflow mismatches, stale running tool calls, stale workers.
* Per-task spending limit (`maxCostUsd` on the task, summed across runs and pipeline steps).

## 3. Migration risks

| # | Risk | Mitigation |
|---|---|---|
| M1 | Non-deterministic workflow code breaks replay | Workflows only orchestrate; all I/O is in activities. Workflows are bundled by the Temporal bundler, which rejects Node APIs. A replay test runs recorded histories against the current workflow code |
| M2 | Duplicate side effects on activity retry | Per-turn idempotency for model calls; status CAS for tools; "outcome unknown" for interrupted side-effecting tools; unique (run, providerCallId) |
| M3 | Duplicate model spend after a crash mid-call | Unavoidable: the provider already billed the call. Recorded as a retry; bounded by attempts; documented |
| M4 | Existing API contract changes | Endpoints unchanged. New fields are additive. Approval decisions now need owner role and are rejected (409) when stale |
| M5 | Event ordering across tasks with LISTEN/NOTIFY | Per-task ordering is guaranteed by a single writer; org-wide de-duplication by seq set; replay from Postgres remains the source of truth |
| M6 | API restart logic (`recoverInterruptedTasks`) would kill durable tasks | Runs only in `inprocess` mode |
| M7 | Credential migration from env keys | Deployment keys stay usable only behind an explicit flag; orgs add their own keys in Settings |
| M8 | Infrastructure availability | Temporal dev server 1.5.1 (Server 1.29.1) and Redis are available locally. Managed KMS is not, so the dev KMS is the only verified implementation |
| M9 | Temporal SDK on Node 22 + ESM + tsx | Worker runs with tsx; workflow bundle built by `@temporalio/worker` bundler; verified early (step 1 below) |

## 4. Implementation order (each step verified before the next)

1. Temporal spike: worker plus a trivial workflow round-trip on the local dev server (de-risks M9).
2. Engine step API (`beginRun`, `modelTurn`, `toolStep`, `approvalStep`, `finalize`), with `execute()` reimplemented on top of it. The existing 30 runtime tests must stay green.
3. Workflows, activities, `TemporalWorkflowEngine`, `apps/worker`. Schema: `Task.workflowId`, `ToolCall` CAS.
4. Events over LISTEN/NOTIFY.
5. Approval hardening: owner role, stale/duplicate rejection, signal plus fallback.
6. Encrypted org credentials: schema, KMS, API, UI, and per-org provider resolution.
7. Observability endpoints, worker heartbeats, dashboard.
8. Durability test suite on real Temporal and Postgres (the 14 scenarios), browser tests switched to Temporal and a separate worker, live-provider check with org credentials.
9. Docs and milestone report.
