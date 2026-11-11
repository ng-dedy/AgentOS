# Implementation plan

Milestone 1 is one vertical slice, built in this order. Each step ends with tests.

1. **Scaffold**: pnpm workspace, Turborepo, strict tsconfig base, ESLint flat config,
   Vitest workspace, Docker Compose (Postgres 16), `.env.example`, AGENTS.md.
2. **Contracts**: Zod schemas for agents, tasks, events, approvals, providers.
3. **Database**: Prisma schema (see `packages/db/prisma/schema.prisma`), migration, seed
   (demo org/user, verification skill).
4. **Tools**: registry + 4 safe tools + mock approval tool. Unit tests for parsing,
   validation, timeouts.
5. **Providers**: interface, error normalization, catalog/pricing, mock, OpenAI,
   Anthropic, xAI adapters. Unit tests for mapping and error classification using
   SDK-shaped fixtures (no network).
6. **Runtime**: engine with in-memory store; tests for lifecycle, invalid args,
   unauthorized tools, approvals, iteration/budget limits, cancellation, handoff.
7. **API**: auth, org scoping, routes, Prisma store, event bus + SSE replay, idempotency,
   rate limits, in-process workflow engine. Integration tests against a real Postgres.
8. **Web**: shell + dashboard, agents (list/create/edit/detail), chat, tasks (create,
   timeline, cancel, retry), approvals, settings.
9. **E2E**: Playwright: sign in → create Atlas (mock provider) → task → calculator tool →
   final answer → live events → reload shows everything; plus a two-agent pipeline.
10. **Report**.

## Milestone 2 candidates
Real-provider smoke tests behind keys; encrypted per-org credentials; Temporal-backed
`WorkflowEngine`; OIDC login; Postgres LISTEN/NOTIFY event bus for multi-instance API;
artifacts storage; per-tool rate limits; richer RBAC.
