# Milestone 1 report

Date: 2026-11-11. Commit: first commit on `main` in the local workspace (not yet pushed).

## Verdict

The first end-to-end workflow works and is covered by automated tests, **with one material caveat: every model call in testing went to the MOCK provider**, because no OpenAI, Anthropic or xAI key was available. The MOCK provider is a scripted test double, labelled as such in every screen, API response and event where it appears. Its answers are built from the tool results the backend actually returned, so the tests prove the tool loop, persistence and streaming are real. They do not prove that any real model behaves correctly with these adapters.

## Features implemented

| Area | Status | Evidence |
|---|---|---|
| Sign-up, sign-in, sign-out, sessions | Done | API integration tests; Playwright |
| Org-scoped data isolation | Done | Cross-org tests for agents, tasks, events, SSE, conversations, approvals, skills, usage |
| Agents: create, edit, detail, model selection, instructions, tools, limits, status, skills | Done | API tests; Playwright |
| Agent chat with streaming, tool activity, stop, history | Done | API test; Playwright (reload keeps history) |
| Tasks: create, assign, status, timeline, events, result, cancel, retry | Done | API + runtime tests; Playwright |
| Approvals: pending list, tool + args + reason, approve/reject with note, audit history | Done | Runtime + API tests; Playwright |
| Settings: provider status, usage/cost by model, workspace preferences | Done | API tests; Playwright checks unconfigured providers |
| Provider abstraction: OpenAI, Anthropic, xAI adapters (official SDKs), streaming, tool calls, usage, error normalization, timeouts, retry classification | Built; **unverified against live APIs** | Unit tests with SDK-shaped fixtures and SDK error classes |
| Agent runtime loop (context → model → validate → authorize → approve → execute → loop) | Done | 20 runtime tests |
| Tool registry + calculator, datetime, text, JSON transform, mock approval tool | Done | 25 tool tests |
| Sequential two-agent orchestration with validated structured handoff, failure and cancellation | Done | Runtime + API tests; Playwright |
| SSE with persisted replay (Last-Event-ID) and live streaming | Done | API test reads a real SSE stream; Playwright watches the dashboard live |
| Versioned skills + seeded verification skill | Done (API + assignment UI; no skill editor UI yet) | API tests |
| Rate limiting, idempotency keys, budgets, iteration limits, audit log | Done | API + runtime tests |

## Verification results (last full run)

| Check | Command | Result |
|---|---|---|
| Type checking | `pnpm typecheck` | 7/7 packages pass |
| Lint + package boundaries | `pnpm lint` | 0 problems; boundaries OK |
| Unit tests | `pnpm test` (tools, providers, runtime) | 58 passed |
| Integration tests | `pnpm test` (api, real PostgreSQL 16) | 20 passed |
| Browser tests | `pnpm test:e2e` (production Next build + real API + Postgres) | 4 passed (3 desktop, 1 mobile) |

Requirement coverage from the brief: agent creation/update, provider configuration, execution lifecycle, tool-call validation, unauthorized tool rejection, approval request and rejection, two-agent handoff, iteration limits, budget enforcement (cost and token), run cancellation, organization isolation and SSE replay all have dedicated tests.

## Known limitations

* **Real providers unverified.** Adapters compile against the current SDKs and pass mapping tests, but no live call has been made. OpenAI and xAI model ids and prices in the catalog are placeholders (`priceSource: "unverified"`); Anthropic prices come from Anthropic's published table.
* **Anthropic refusal fallback** (server-side `fallbacks`) is not enabled; a refusal fails the run with a clear message.
* **Authentication is API-owned sessions, not Auth.js.** See the architecture doc for the reasoning. No OAuth/SSO, password reset, email verification or invitations yet; one organization per user.
* **Execution is in-process.** A restart marks running tasks `failed (interrupted)` and they can be retried; runs waiting for approval survive restarts. The live event bus is per process, so horizontal scaling needs Postgres LISTEN/NOTIFY or Redis (replay from the database stays correct).
* Token deltas are live-only. After a reload, a model turn that is still generating shows once it completes.
* Budgets are checked after each model call, so one call can overshoot by that call's cost.
* Artifacts table exists but no tool produces artifacts yet. No skill editor UI (skills are created via API).
* UI components follow shadcn/ui conventions but were written by hand because the shadcn registry was unreachable from the build environment; `components.json` is present so the CLI works later.
* Next.js 16, Prisma 7, Zod 4, Vitest 5 are recent majors and pinned exactly.

## Security considerations

* The API is the only authority; the web app holds no secrets and makes no authorization decisions.
* Session tokens are 256-bit random, stored as SHA-256 hashes, HttpOnly + SameSite=Lax cookies (Secure via `SESSION_COOKIE_SECURE`). Passwords use scrypt with constant-time comparison; login timing is equalised for unknown emails; login/signup are rate limited.
* CSRF exposure is limited by SameSite=Lax, a single allowed CORS origin, and JSON-only bodies. A CSRF token should be added before cross-site embedding or non-JSON endpoints.
* Tool authorization is enforced in code (registry + agent allowlist), arguments are Zod-validated, every tool runs with a timeout, and every request (including rejected ones) is recorded.
* Content from models, tools, handoffs and skills is fenced as untrusted data in the system prompt; delimiter-closing tags are neutralised. This reduces but does not eliminate prompt-injection risk.
* Provider errors are normalised to safe messages; responses never include stack traces.
* Postgres row-level security is not enabled; isolation relies on repository-level `organizationId` filters (tested).

## Setup

```bash
docker compose up -d
cp .env.example .env          # add OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY when available
pnpm install
pnpm db:deploy && pnpm db:seed
pnpm dev                      # http://localhost:3000, demo@agentos.local / agentos-demo-password
```

## Recommended next milestone

1. Run the slice against real providers with keys (a smoke test per adapter, gated on env vars) and fix the catalog prices.
2. Encrypted per-organization provider credentials behind `SecretsProvider` (KMS envelope encryption) and a settings UI to manage them.
3. Temporal-backed `WorkflowEngine` for durable execution and multi-instance SSE via Postgres LISTEN/NOTIFY.
4. OIDC sign-in, invitations and roles beyond owner/member; Postgres RLS as defence in depth.
5. Artifacts produced by tools, a skill editor, and per-tool rate limits.
