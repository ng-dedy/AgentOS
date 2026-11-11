# AgentOS

An operating system for an AI workforce: create agents, give them models, tools and limits, run tasks, watch execution live, approve sensitive actions, and track cost.

Milestones: **1** (foundation and first vertical slice) and **2A** (real provider integration, live-verified on OpenAI and Anthropic). See `docs/` for the architecture, API contract, plan and risk register, and `AGENTS.md` for engineering standards.

## What works

* Sign-up / sign-in with server-side sessions, organization-scoped data.
* Agents: create, edit, model selection (OpenAI, Anthropic, xAI Grok, MOCK), instructions, tool allowlist, iteration/cost/token limits, skills.
* Tasks: single-agent tasks and two-agent sequential pipelines with a validated handoff; cancel; retry eligible failures.
* Agent runtime: model → tool → model loop with argument validation, allowlist enforcement, approval gates, budgets, cancellation and full persistence.
* Chat with an agent, with streaming output, tool activity and a stop button.
* Live execution timeline over Server-Sent Events with replay after reconnect or reload.
* Approvals inbox with audit log; usage and cost by model and agent; provider connection status.

## Quick start

Requirements: Node 22+, pnpm 10, Docker (or a local PostgreSQL 16).

```bash
docker compose up -d                 # PostgreSQL on :5432 (creates agentos and agentos_test)
cp .env.example .env                 # add provider keys if you have them
pnpm install
pnpm db:deploy                       # migrations
pnpm db:seed                         # demo user: demo@agentos.local / agentos-demo-password
pnpm dev                             # API on :4000, web on :3000
```

Open http://localhost:3000.

### Providers

| Provider | Env var | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | Official `openai` SDK, **Responses API** (stateless, encrypted reasoning replay). Live-verified 2026-11-11 |
| Anthropic | `ANTHROPIC_API_KEY` | Official `@anthropic-ai/sdk`, Messages API streaming. Live-verified 2026-11-11 |
| xAI Grok | `XAI_API_KEY` | Official `openai` SDK, Chat Completions at `https://api.x.ai/v1`. **Not live-verified** (no key) |
| MOCK | `AGENTOS_ENABLE_MOCK_PROVIDER=true` | Scripted test double, **not an AI model**, always labelled in the UI |

A provider without a key is shown as "Not configured" and cannot run tasks. Settings → **Check account** asks the provider's Models API which catalog models your key can use. Models and published prices live in `packages/providers/src/catalog.ts` and can be overridden with `AGENTOS_MODEL_CATALOG_JSON`. Costs are estimates. See `docs/providers.md`.

## Verify

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e

# Live provider checks (real API calls, fractions of a cent per run)
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm test:live
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… pnpm test:e2e:live
```

## Layout

```
apps/api   apps/web   packages/{contracts,db,providers,tools,runtime}   docs/
```
