# AgentOS

An operating system for an AI workforce: create agents, give them models, tools and limits, run tasks, watch execution live, approve sensitive actions, and track cost.

This is **milestone 1**: the foundation plus one verified vertical slice. See `docs/` for the architecture, API contract, plan and risk register, and `AGENTS.md` for engineering standards.

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
| OpenAI | `OPENAI_API_KEY` | Official `openai` SDK, Chat Completions + tools |
| Anthropic | `ANTHROPIC_API_KEY` | Official `@anthropic-ai/sdk`, Messages API streaming |
| xAI Grok | `XAI_API_KEY` | Official `openai` SDK with `https://api.x.ai/v1` |
| MOCK | `AGENTOS_ENABLE_MOCK_PROVIDER=true` | Scripted test double, **not an AI model**, always labelled in the UI |

A provider without a key is shown as "Not configured" and cannot run tasks. Models and prices live in `packages/providers/src/catalog.ts` and can be overridden with `AGENTOS_MODEL_CATALOG_JSON`.

## Verify

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## Layout

```
apps/api   apps/web   packages/{contracts,db,providers,tools,runtime}   docs/
```
