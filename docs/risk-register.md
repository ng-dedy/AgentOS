# Risk register

| # | Risk | Likelihood | Impact | Mitigation in M1 | Residual |
|---|---|---|---|---|---|
| R1 | No provider API keys in the build environment, so real adapters cannot be exercised end to end | Certain | High | Adapters unit-tested against SDK-shaped fixtures; E2E uses a clearly labelled mock provider; UI shows providers as "Not configured" | Real-provider behaviour (tool-call formats, streaming quirks) unverified until keys are supplied |
| R2 | Prompt injection via tool output, handoffs or skills changes agent behaviour | High | High | Tool allowlist enforced in code, not prompt; approval gates; untrusted content fenced and labelled; agents cannot change config | Model may still produce wrong answers; no content classifier yet |
| R3 | Runaway cost | Medium | High | Per-run cost/token/iteration limits checked after every model call; max output tokens per call | Budget is checked after a call, so one call can overshoot by at most that call's cost |
| R4 | In-process execution lost on API restart | Medium | Medium | All state persisted; on boot, runs left `running` are marked `failed (interrupted)` and are retryable | No automatic resume until Temporal |
| R5 | In-memory event bus does not span multiple API instances | Certain at scale | Medium | SSE replays from DB, so correctness holds; only liveness is per-instance | Need LISTEN/NOTIFY or Redis before horizontal scale |
| R6 | Custom session auth has bugs | Low | High | Small surface, hashed tokens, scrypt, constant-time compare, rate-limited login, integration tests | Needs external review; OIDC later |
| R7 | Pricing data goes stale | High | Low | Catalog is data and overridable by env | Cost figures are estimates; marked so in UI |
| R8 | Fast-moving dependency majors (Next 16, Prisma 7, Zod 4) | Medium | Medium | Exact versions pinned via lockfile | Upgrade work later |
| R9 | Cross-tenant data leakage | Low | Critical | Org id required by every repository function; isolation integration tests | Postgres RLS would be defence in depth (later) |

## Milestone 2C updates

| # | Risk | Status after 2C | Residual |
|---|---|---|---|
| R3 | Runaway cost | Pre-call reservation per request, per-run and per-tree limits, attempt ledger | Costs are estimates (token counts × static prices); a provider may bill a request whose reply is lost, which is flagged, not prevented |
| R5 | Events missed across instances | Commit-safe xid8 watermark cursor plus periodic reconciliation, verified with two instances | At-least-once: clients must drop repeats by seq |
| R10 | Production key management | AWS KMS adapter with encryption context, startup refuses dev KMS | Verified only against moto and a fake client, not real AWS |
| R11 | Unsafe production configuration | Startup validation in API, worker and scripts | Rules cover known pitfalls only; review on each new setting |
| R12 | Workflow code change breaks running histories | Replay test against exported 2B histories, Worker Deployment versioning | Version promotion and draining not exercised on a real cluster |
| R13 | Temporal Cloud / mTLS differences | TLS and mTLS verified through a local proxy | Temporal Cloud and real certificates unverified |
