# Database schema (milestone 1)

Source of truth: `packages/db/prisma/schema.prisma`; initial migration in `packages/db/prisma/migrations/`.

| Model | Purpose | Key constraints |
|---|---|---|
| Organization | Tenant boundary. Workspace preferences. | Parent of every org-owned row (cascade delete) |
| User | Identity. `passwordHash` is scrypt. | `email` unique |
| Membership | User ↔ Organization with `role` (`owner`/`member`) | unique (organizationId, userId) |
| Session | Opaque session; only SHA-256 of the token is stored | `tokenHash` unique, `expiresAt`, `revokedAt` |
| Agent | Name, role, instructions, provider/model, `allowedTools[]`, limits, status | unique (organizationId, name) |
| Skill | Versioned instructions (immutable versions) | unique (organizationId, name, version) |
| SkillAssignment | Agent ↔ Skill version | PK (agentId, skillId) |
| Conversation | Transcript container for chats and for each task | index (organizationId, agentId) |
| Message | user / assistant / tool turns; assistant `toolCalls` + `providerState` (raw provider blocks for faithful replay) | ordered by `seq` |
| Task | single, pipeline, pipeline_step or chat; status, result, failure, `cancelRequestedAt`, `handoffInput`, `pipelineSpec`, `retryOfId` | index (organizationId, status/createdAt), parentTaskId |
| AgentRun | One execution of one agent for one task; iterations, tokens, cost, failure | index (organizationId, status), taskId |
| RunEvent | Append-only event log; global `seq` is the SSE id | index (rootTaskId, seq), (organizationId, seq) |
| ToolCall | Every tool request and its outcome | **unique (runId, providerCallId)**: a provider call executes at most once |
| Approval | Human gate for a ToolCall | unique toolCallId; compare-and-set on `status = pending` |
| Artifact | Text artifacts attached to tasks (table ready, not yet produced by tools in M1) | index (organizationId, taskId) |
| UsageRecord | One row per model call with tokens and cost | index (organizationId, createdAt) |
| AuditLog | Security-relevant actions (login, agent changes, approvals, cancellations) | index (organizationId, createdAt) |
| IdempotencyKey | Stored responses for `Idempotency-Key` | unique (organizationId, route, key) |

No table stores provider credentials. Monetary values use `Decimal(12,6)`.
