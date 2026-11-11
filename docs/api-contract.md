# API contract (v1)

Base path `/api/v1`. JSON in and out. All request bodies are validated with the Zod
schemas exported from `@agentos/contracts`; the same schemas type the web client.
Errors use one shape: `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
Status codes: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found (also for
other organizations' resources), 409 conflict/state, 422 not runnable (e.g. provider not
configured), 429 rate limited.

Side-effecting POSTs accept `Idempotency-Key`. A repeated key with the same body returns the
stored response; with a different body returns 409.

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /auth/signup | `{ email, password, name, organizationName }` | creates org + owner, sets cookie |
| POST | /auth/login | `{ email, password }` | sets cookie, rate limited 10/min/IP |
| POST | /auth/logout | – | revokes session |
| GET | /auth/me | – | `{ user, organization, role }` |

## Providers & usage
| GET | /providers | list providers: `{ id, label, configured, isMock, models[] }` — never keys |
| GET | /usage/summary | totals per provider/model/agent, cost, tokens, run counts |
| GET | /workspace | workspace preferences · PATCH /workspace updates them (owner) |

## Agents
| GET | /agents | list |
| POST | /agents | `AgentCreate` → 201 Agent |
| GET | /agents/:id | detail incl. skills, recent tasks |
| PATCH | /agents/:id | `AgentUpdate` (partial) |
| GET | /tools | registry listing: name, description, risk, requiresApproval, input JSON schema |

`AgentCreate = { name, role, instructions, provider, model, allowedTools: string[],
maxIterations (1–50), maxRunCostUsd (0–100), maxRunTokens?, status: "active"|"paused",
skillIds?: string[] }`. Unknown tools or unconfigured-but-unknown models are rejected (400).

## Conversations (agent chat)
| GET | /agents/:id/conversations | list |
| POST | /agents/:id/conversations | create |
| GET | /conversations/:id | messages (user/assistant/tool) |
| POST | /conversations/:id/messages | `{ content }` → `{ taskId }` — starts a `chat` task; stream with task events |

## Tasks
| GET | /tasks?status=&agentId= | list |
| POST | /tasks | `{ kind: "single", agentId, title, instruction }` or `{ kind: "pipeline", title, instruction, steps: [{ agentId, instruction }] (2) }` → 201 Task |
| GET | /tasks/:id | task + runs + tool calls + approvals + children |
| GET | /tasks/:id/events?after= | persisted events (JSON) |
| GET | /tasks/:id/events/stream | SSE; honours `Last-Event-ID` / `?after=` |
| POST | /tasks/:id/cancel | 202; idempotent |
| POST | /tasks/:id/retry | only `failed` tasks whose failure is retryable → new Task linked via `retryOfId` |

## Approvals
| GET | /approvals?status=pending | list with tool name, arguments, reason, agent, task |
| POST | /approvals/:id/decision | `{ decision: "approve"|"reject", note? }` — idempotent; 409 if already decided differently |
| GET | /audit | audit log (most recent first) |

## Skills
| GET | /skills | list (latest versions) |
| POST | /skills | new skill or new version `{ name, description, instructions }` (version auto-increments) |

## Org-wide stream
| GET | /events/stream | SSE of all task events in the org (dashboard) |

## Run event types (`RunEventType`)
`task.created`, `task.status`, `run.started`, `model.delta` (live only), `model.output`,
`tool.requested`, `tool.rejected`, `approval.required`, `approval.decided`, `tool.completed`,
`tool.failed`, `agent.handoff`, `run.completed`, `run.failed`, `run.cancelled`, `usage.recorded`.
Payloads are defined in `packages/contracts/src/events.ts`.
