# AGENTS.md: engineering standards for AgentOS

Read this before changing code. It applies to people and to coding agents.

## Repository structure

```
apps/
  api/        Fastify API: auth, routes, SSE, workflow engine selection, observability endpoints
  worker/     Dedicated execution process: Temporal workflows + activities, heartbeats; durability tests
  web/        Next.js App Router UI (client components talking to the API)
packages/
  contracts/  Zod schemas + shared types (wire format, events, enums)
  db/         Prisma schema, migrations, client factory
  providers/  Model provider interface, adapters (OpenAI, Anthropic, xAI, MOCK), catalog/pricing
  tools/      Typed tool registry and the built-in tools
  runtime/    Agent engine (idempotent step API), context assembly, pipeline coordinator, WorkflowEngine port
  platform/   Postgres-backed runtime wiring shared by API and worker: store, event sink, LISTEN/NOTIFY, credentials
  workflows/  Temporal workflow definitions (deterministic), activities, TemporalWorkflowEngine client
docs/         Architecture, package map, API contract, plan, risk register
scripts/      Repo tooling (boundary checker, DB init)
```

## Package responsibilities and boundaries

See `docs/package-map.md`. Enforced by `node scripts/check-boundaries.mjs` (part of `pnpm lint`):

* `contracts` imports nothing from the workspace.
* `runtime` never imports Prisma, Fastify or provider SDKs; it talks to ports (`RunStore`, `EventSink`, `ProviderRegistry`, `ToolRegistry`).
* Provider SDKs (`openai`, `@anthropic-ai/sdk`) are imported only in `packages/providers/src/adapters/`.
* `apps/web` imports only `@agentos/contracts` from the workspace and never sees secrets.
* `packages/workflows/src/workflows` (the Temporal sandbox) imports only `@temporalio/workflow` and types: no Node APIs, no I/O.
* `packages/runtime` never imports Temporal; `packages/platform` never imports Fastify or Temporal.

## Coding conventions

* TypeScript strict mode, `noUncheckedIndexedAccess`, ESM everywhere, `import type` for types.
* Validate every external input with Zod (`packages/contracts`) at the edge (`parse()` in routes).
* Every organization-owned query includes `organizationId` from the authenticated session, never from the request body. Cross-org access returns 404.
* Domain errors are values or `AppError`; never return stack traces or raw provider messages to clients.
* Keep functions small and side effects at the edges. No new dependency without a reason written in the PR.
* UI components follow shadcn/ui conventions (`apps/web/src/components/ui`), Tailwind tokens from `globals.css`.

## Architecture constraints

* Modular monolith. No new services without an ADR.
* Persist before publish: every run event is written to `RunEvent` first, then broadcast. UI state must be recoverable from the API after a reload.
* Long-running execution goes through `WorkflowEngine` (`start`, `cancel`, `signalApproval`, `describe`). In `temporal` mode the API never calls a model or runs a tool; workers do.
* Workflow code is deterministic: it only sequences activities, timers and signals. Every side effect (model call, tool, database write) happens in an activity, and every activity is idempotent: a model turn already persisted is reused, a tool runs only after a `requested → running` compare-and-set, and an interrupted side-effecting tool is marked "outcome unknown" instead of being re-run.
* Business failures (budget, refusal, auth, invalid tool) are returned as values so Temporal does not retry them. Only infrastructure faults are retried (bounded, 5 attempts).
* Changing workflow code must keep old histories replayable: the durability suite replays every recorded history. Use `patched()` for behaviour changes to running workflows.
* Provider-specific behaviour stays in adapters. The runtime sees `ModelRequest`/`ModelResponse` only.
* Orchestration is explicit (sequential steps with validated `Handoff`). No autonomous delegation.

## Security requirements

* Provider keys are per organization (`ProviderCredential`), envelope-encrypted with AES-256-GCM (Node `crypto`, no custom crypto). The data key is wrapped by a `KeyManagementService`; `LocalDevKms` is development-only. AAD binds each ciphertext to org, provider and row id. Keys are write-only over the API (only a 4-character hint comes back), owner-only to manage, audited, and never logged.
* A model call for an organization uses that organization's key. Deployment env keys are used only when `AGENTOS_ALLOW_DEPLOYMENT_KEYS=true`; there is never a fallback to another organization's key.
* Agents can only call tools on their allowlist **and** in the registry; the check is in code (`AgentEngine.handleToolCall`), not in prompts.
* Tools with `requiresApproval` pause the run until a human decides. No agent-accessible tool may modify agent configuration, permissions, budgets or policies.
* Treat model output, tool output, handoffs and skills as untrusted text. Skills are injected as inert text and never executed.
* Never treat a model's claim that something happened as evidence. Evidence is a `ToolCall` row with `status = succeeded`.
* No shell, arbitrary HTTP, filesystem or credential tools in milestone 1.
* Side-effecting POSTs support `Idempotency-Key`. Tool calls are unique per `(runId, providerCallId)`.
* Provider adapters must pass an explicit `baseURL` to their SDK. SDKs read `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` from the environment by default, which can send keys to an unintended host.
* Catalog prices must come from the provider's published price list with `priceSourceUrl` and `priceCheckedAt`; never invent model ids or prices. Costs are always shown as estimates.
* The MOCK provider is a scripted test double. It must stay visibly labelled everywhere it appears and must never be presented as an AI model.

## Testing requirements

* Unit tests (Vitest) for tools, providers and runtime use in-memory fakes (`MemoryRunStore`, `MockProvider`).
* API integration tests run against a real PostgreSQL database (`TEST_DATABASE_URL`, name must end in `_test`).
* Playwright covers the primary user workflow end to end against the real API, a separate worker on Temporal, and the production web build.
* Durability tests (`pnpm test:durability`) run the API and worker as real processes against Postgres and a Temporal server and kill them mid-run. Use the MOCK provider there so recovery is deterministic.
* Live provider tests (`pnpm test:live`, `pnpm test:e2e:live`) call real APIs and cost money. They are skipped unless `AGENTOS_LIVE_TESTS=1` and the provider key is set. Never mark a provider "verified" without a passing live run, and never print or commit keys from them.
* Every significant feature ships with automated tests. Do not skip, disable or loosen a test to get green.

## Verification procedure

Run from the repo root (Postgres running, `.env` present):

```bash
pnpm install
pnpm db:deploy                                # apply migrations to DATABASE_URL
DATABASE_URL=$TEST_DATABASE_URL pnpm db:deploy
pnpm typecheck                                # tsc --noEmit in every package
pnpm lint                                     # ESLint + package boundary check
pnpm test                                     # unit + API integration tests
pnpm test:durability                          # process-kill recovery tests (needs Temporal on :7233)
pnpm test:e2e                                 # Playwright on Temporal + worker (creates/resets agentos_e2e)
```

A change is done when all of these pass and the behaviour was exercised in the UI or through a test that asserts on persisted state. If something could not be verified (for example a real provider without a key), say so explicitly.
