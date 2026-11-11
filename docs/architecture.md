# AgentOS architecture (milestone 1)

Status: implemented for milestone 1. Sections marked **Later** are deliberate
non-goals for this milestone.

## 1. Shape of the system

AgentOS is a modular monolith: one Next.js web app, one Fastify API process,
one PostgreSQL database, and a set of internal TypeScript packages that hold the
domain logic. There are no microservices. Everything that is a candidate for
being split out later (task execution, provider calls) sits behind an interface
so that it can be moved without rewriting callers.

```
 Browser ──HTTPS──▶ apps/web (Next.js, UI only, no secrets)
    │
    └─────HTTPS (cookie session, CORS w/ credentials)─────▶ apps/api (Fastify)
                                                             │
          ┌──────────────────────────────────────────────────┤
          │                 │                 │              │
   packages/runtime   packages/providers  packages/tools   packages/db (Prisma)
   (engine, context,  (OpenAI, Anthropic, (typed registry,       │
    orchestrator,      xAI, mock adapters)  builtin tools)        ▼
    interfaces)                                              PostgreSQL
          └────────── packages/contracts (Zod schemas + types shared by all) ──┘
```

Design rules:

* **The API is the only authority.** The web app never talks to the database,
  never holds provider keys, and never decides authorization. Every request,
  including every SSE stream, is authenticated and organization-scoped in the
  API.
* **Domain logic does not import Fastify or Prisma.** `packages/runtime` depends
  on interfaces (`RunStore`, `EventSink`, `ModelProviderRegistry`,
  `ToolRegistry`, `ApprovalGate`). `apps/api` supplies Prisma-backed
  implementations; unit tests supply in-memory ones.
* **Provider-specific code stays in adapters.** The runtime speaks a normalized
  message/tool/usage format (`packages/providers/src/types.ts`).
* **Persistence before broadcast.** Every meaningful run event is written to
  `RunEvent` first, then published to live subscribers with its database
  sequence number. A client that reconnects replays from the database, so the
  UI never depends on transient memory.

## 2. Packages and responsibilities

| Package | Responsibility | May depend on |
|---|---|---|
| `packages/contracts` | Zod schemas for API requests/responses, run event types, tool risk levels, shared enums. The single source of truth for wire shapes. | `zod` |
| `packages/db` | Prisma schema, migrations, generated client, seed script. | `@prisma/client`, `contracts` |
| `packages/providers` | `ModelProvider` interface, adapters (OpenAI, Anthropic, xAI, mock), model catalog with pricing, error normalization, timeouts, retry classification. | `contracts`, provider SDKs |
| `packages/tools` | `ToolDefinition` type, `ToolRegistry`, builtin tools, safe expression evaluator, JSON-schema export for providers. | `contracts`, `zod` |
| `packages/runtime` | Agent execution engine, context assembly, budget/iteration enforcement, cancellation, approval pause/resume, sequential orchestrator, `WorkflowEngine` interface. | `contracts`, `providers` (types + registry), `tools` |
| `apps/api` | HTTP/SSE surface, auth, rate limiting, idempotency, Prisma implementations of runtime interfaces, in-process workflow engine, event bus. | everything above |
| `apps/web` | Next.js App Router UI. Calls the API with `fetch` + `EventSource`. | `contracts` only |

See `docs/package-map.md` for the dependency graph.

## 3. Authentication and tenancy

* Sessions are opaque random tokens (32 bytes), stored **hashed** (SHA-256) in
  `Session`, delivered as an `HttpOnly; SameSite=Lax` cookie (`Secure` in
  production). Passwords are hashed with Node's `scrypt` (N=2^15) with a
  per-user salt and compared in constant time.
* Why not Auth.js: Auth.js runs inside Next.js. That would put the session
  authority in the web process while authorization (and SSE) lives in Fastify,
  so every API call would need to decode Next.js-owned JWE cookies. For a
  system whose central security property is "the API authorizes everything", a
  single session authority in the API is simpler and easier to audit. The auth
  module is isolated (`apps/api/src/auth/`) behind `SessionService`, so an OIDC
  provider (Auth.js, WorkOS, Clerk, etc.) can be added later as an identity
  source that mints the same API session. **This is a deviation from the brief
  and is called out in the report.**
* Every organization-owned row carries `organizationId`. Repository helpers in
  `apps/api/src/repo/` take the caller's `organizationId` as a required argument
  and include it in every `where` clause; a resource from another org returns
  `404` (not `403`) to avoid confirming existence.
* Membership is `User ↔ Organization` via `Membership(role)`. Milestone 1 roles:
  `owner`, `member`. Approvals require `owner` or `member`; provider settings
  require `owner`.

## 4. Provider architecture

```ts
interface ModelProvider {
  id: ProviderId;                       // "openai" | "anthropic" | "xai" | "mock"
  isConfigured(): boolean;              // key present (never returns the key)
  generate(req: ModelRequest, opts: { signal: AbortSignal; onDelta?: (t: string) => void }): Promise<ModelResponse>;
}
```

* `ModelRequest` carries normalized messages (`system`, `user`, `assistant`
  with optional tool calls, `tool` results), tool specs (name, description,
  JSON Schema), `maxOutputTokens`, and an optional structured-output schema.
* `ModelResponse` carries text, tool calls, a normalized `stopReason`, `usage`
  (input/output/cached tokens) and an opaque `providerState` that the adapter
  needs to replay the assistant turn verbatim (Anthropic thinking blocks must be
  passed back unchanged).
* Errors are normalized to `ProviderError { kind: "auth" | "rate_limit" |
  "timeout" | "bad_request" | "server" | "network" | "refusal" | "unknown",
  retryable }`. The engine retries `retryable` errors with bounded backoff.
* Adapters: OpenAI (official `openai` SDK, Chat Completions with tools), Anthropic
  (official `@anthropic-ai/sdk`, Messages API streaming + `finalMessage()`), xAI
  Grok (official `openai` SDK pointed at `https://api.x.ai/v1`, which xAI
  documents as OpenAI-compatible). Keys come from a `SecretsProvider`
  interface; the default implementation reads environment variables. Keys are
  never stored in the database and never sent to the browser.
* An adapter whose key is absent reports `configured: false`; the API refuses to
  start a run on it and the UI marks it "Not configured".
* `MockProvider` is a deterministic, scripted provider. It is only registered
  when `AGENTOS_ENABLE_MOCK_PROVIDER=true`, and every surface that shows it
  labels it **MOCK — scripted, not an AI model**. Its outputs are derived
  from the actual tool results it receives, so tests prove the tool really ran.
* Model catalog (`packages/providers/src/catalog.ts`) holds model ids, display
  names and per-million-token prices. It is data, overridable with
  `AGENTOS_MODEL_CATALOG_JSON`, not hardcoded into agents.

## 5. Agent runtime

`AgentEngine.runTask(taskId)` / `resumeRun(runId)` executes the loop:

1. Load task and agent (org-scoped) and the agent's assigned skill versions.
2. Assemble context: platform policy preamble → agent role/instructions →
   skills (as inert text) → handoff input (fenced as untrusted data) →
   conversation history → task instruction.
3. Call the provider with only the tools on the agent's allowlist **and** in
   the registry.
4. For each tool call in the response:
   * unknown or not allowlisted → record `ToolCall(status=rejected)`, return
     an error result to the model;
   * input fails Zod validation → `ToolCall(status=invalid)`, error result;
   * tool requires approval → `ToolCall(status=awaiting_approval)`,
     `Approval(pending)`, run status `awaiting_approval`, loop exits; it
     resumes when a human decides;
   * otherwise execute with a per-tool timeout, validate output against the
     output schema, record `ToolCall(status=succeeded|failed)`.
5. Append tool results and loop.
6. Stop on: final answer, `maxIterations`, cost budget, token budget,
   cancellation, non-retryable provider error.
7. Persist result, usage records, and events.

Facts the engine treats as evidence are only rows it wrote itself
(`ToolCall` with `status=succeeded`). A model message claiming a tool ran is
just text.

Cancellation uses an `AbortController` per active run plus a persisted
`cancelRequestedAt`; the engine checks both between steps, and provider calls
receive the abort signal.

## 6. Tools

`ToolDefinition<I, O>` = `{ name, description, inputSchema: ZodType<I>,
outputSchema: ZodType<O>, permission, risk: "safe" | "sensitive" | "dangerous",
requiresApproval, timeoutMs, handler(input, ctx) }`. Milestone 1 tools:
`calculator` (own recursive-descent parser, no `eval`), `current_datetime`,
`text_transform`, `json_transform` (whitelisted operations only), and
`mock_external_action` (sensitive, approval required, side-effect free and
labelled as a mock). There is no shell, HTTP, filesystem or credential tool.

## 7. Orchestration

A `pipeline` task has an ordered list of steps (agent + instruction). The
in-process `WorkflowEngine` runs each step as a child task, then builds a
validated `Handoff { fromAgentId, fromTaskId, summary, data }` (data is the
step's final answer parsed as JSON when possible) and passes it into the next
step's context as untrusted data. A failed or cancelled step ends the parent
with the same status; later steps are marked `skipped`. Cancelling the parent
cancels the active child. `WorkflowEngine` (`start`, `cancel`,
`signalApproval`) is the seam where Temporal plugs in later.

## 8. Realtime

* `GET /api/v1/tasks/:id/events` — SSE for one task (and its child tasks).
* `GET /api/v1/events` — SSE for the whole organization (dashboard feed).
* Each persisted event has a global monotonically increasing `seq` used as the
  SSE `id`. On (re)connect the server subscribes to the live bus first, then
  replays rows with `seq > Last-Event-ID` (header or `?after=` query), then
  flushes live events, de-duplicating by `seq`. Heartbeat comments every 15s.
* Token deltas (`model.delta`) are live-only and carry no id; the full text of
  each model turn is persisted as `model.output`. After a reload, the UI shows
  everything except the partial text of an in-flight model call.

## 9. Security controls (milestone 1)

Input validation with Zod at every route; `@fastify/rate-limit` (global and
stricter on auth and run-start routes); `Idempotency-Key` support on
side-effecting POSTs (stored with request hash and response); approval gates;
per-run cost, token and iteration budgets; audit log rows for logins, agent
changes, approvals, cancellations and provider-config reads; error responses
never include stack traces or provider messages verbatim; content from models,
tools and handoffs is wrapped and labelled as untrusted in context; agents have
no tool that can change agent config, allowlists or policies.

## 10. Later (explicitly not in milestone 1)

Temporal workers, OAuth/OIDC sign-in, encrypted per-org provider credentials
(KMS), RAG/retrieval, artifacts beyond text, parallel/conditional workflows,
autonomous delegation, horizontal scaling of the SSE bus (Postgres
LISTEN/NOTIFY or Redis), billing.
