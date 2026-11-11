# AgentOS

An operating system for an AI workforce: create agents, give them models, tools and limits, run tasks, watch execution live, approve sensitive actions, and track cost.

Milestones: **1** (foundation and first vertical slice), **2A** (real provider integration, live-verified on OpenAI and Anthropic) and **2B** (durable execution on Temporal with dedicated workers, encrypted per-workspace provider keys, multi-instance realtime events). See `docs/` for the architecture, API contract, plan and risk register, and `AGENTS.md` for engineering standards.

## What works

* Sign-up / sign-in with server-side sessions, organization-scoped data.
* Agents: create, edit, model selection (OpenAI, Anthropic, xAI Grok, MOCK), instructions, tool allowlist, iteration/cost/token limits, skills.
* Tasks: single-agent tasks and two-agent sequential pipelines with a validated handoff; cancel; retry eligible failures.
* Agent runtime: model → tool → model loop with argument validation, allowlist enforcement, approval gates, budgets, cancellation and full persistence.
* Chat with an agent, with streaming output, tool activity and a stop button.
* Live execution timeline over Server-Sent Events with replay after reconnect or reload.
* Approvals inbox with audit log; usage and cost by model and agent; provider connection status.
* Durable execution (2B): tasks run as Temporal workflows on separate worker processes. They survive API restarts, worker crashes and restarts during approvals, without repeating side effects. See `docs/durable-execution.md`.
* Per-workspace provider keys (2B): envelope-encrypted, write-only, owner-managed, verified against the provider, never shared across workspaces. See `docs/credentials.md`.
* Operations (2B): worker health, workflow inspection with retry history, latency and failure metrics, recovery diagnostics, per-task spending limits.

## Quick start

Requirements: Node 22+, pnpm 10, Docker (or a local PostgreSQL 16 and the Temporal CLI).

```bash
docker compose up -d                 # PostgreSQL :5432 (agentos, agentos_test) + Temporal dev server :7233
cp .env.example .env                 # set AGENTOS_DEV_KMS_KEYS=dev1:$(openssl rand -base64 32)
pnpm install
pnpm db:deploy                       # migrations
pnpm db:seed                         # demo user: demo@agentos.local / agentos-demo-password
pnpm dev                             # API :4000, worker, web :3000
```

Add provider keys per workspace in Settings → AI providers.

Open http://localhost:3000.

### Providers

| Provider | Key | Notes |
|---|---|---|
| OpenAI | workspace key (or `OPENAI_API_KEY` with `AGENTOS_ALLOW_DEPLOYMENT_KEYS=true`) | Official `openai` SDK, **Responses API** (stateless, encrypted reasoning replay). Live-verified 2026-11-11 |
| Anthropic | workspace key (or `ANTHROPIC_API_KEY`) | Official `@anthropic-ai/sdk`, Messages API streaming. Live-verified 2026-11-11 |
| xAI Grok | workspace key (or `XAI_API_KEY`) | Official `openai` SDK, Chat Completions at `https://api.x.ai/v1`. **Not live-verified** (no key) |
| MOCK | `AGENTOS_ENABLE_MOCK_PROVIDER=true` | Scripted test double, **not an AI model**, always labelled in the UI |

A provider without a key for the workspace is shown as "Not configured" and cannot run tasks. Settings → **Check account** asks the provider's Models API which catalog models your key can use. Models and published prices live in `packages/providers/src/catalog.ts` and can be overridden with `AGENTOS_MODEL_CATALOG_JSON`. Costs are estimates. See `docs/providers.md`.

## Verify

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:durability && pnpm test:e2e

# Live provider checks (real API calls, fractions of a cent per run)
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm test:live
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… pnpm test:e2e:live
# Live call through the durable stack with keys stored as encrypted workspace credentials
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm test:live:durable
```

## Layout

```
apps/{api,worker,web}   packages/{contracts,db,providers,tools,runtime,platform,workflows}   docs/
```
