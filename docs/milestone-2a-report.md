# Milestone 2A report: real provider integration

Date: 2026-11-11. Builds on milestone 1 without replacing its architecture.

## Verdict

**OpenAI and Anthropic are verified live.** Real models completed tool-assisted tasks, streamed output, had a disallowed tool call blocked, paused for human approval, and finished a structured two-agent handoff, including one handoff that crossed providers (OpenAI → Anthropic). That evidence comes from 21 passing live tests that call the real APIs, plus one passing browser test against a real model.

**xAI is not verified.** No xAI key was available. The adapter compiles, passes mapping tests and points at the right endpoint, but no request has reached xAI. Its catalog entry (`grok-4.7`) has a published price, but whether the model is available on an account is unknown.

Two defects in milestone 1 would have broken real use, and only live calls exposed them:

1. **OpenAI tool calling did not work on current models.** Chat Completions rejects function tools for `gpt-6-luna` unless reasoning is disabled. The OpenAI adapter now uses the Responses API.
2. **The Anthropic key could have gone to the wrong host.** The Anthropic SDK silently reads `ANTHROPIC_BASE_URL`, and this hosting environment sets that variable for its own tooling. Every adapter now pins its endpoint explicitly.

## Phase 1: gap analysis (state at the start of 2A)

| Area | Gap found | Resolution |
|---|---|---|
| Endpoints | Anthropic and OpenAI SDKs read base URLs from the process environment | Explicit `baseURL` per adapter. `AGENTOS_*_BASE_URL` config, https only. Test with an attacker URL in the SDK variables |
| OpenAI API | Chat Completions + tools fails on current models (live 400) | New `OpenAIResponsesProvider`: stateless Responses API with encrypted reasoning replay |
| Catalog | OpenAI/xAI ids and prices were placeholders | Re-sourced from published price pages. Placeholders removed. Account availability checked through the Models APIs |
| Model discovery | None | `listModels()` on every real adapter. `GET /providers/:id/models`. "Check account" in Settings |
| Error handling | Kinds only. 429 quota looked like a rate limit (would retry pointlessly). 404 was a generic bad request | Structured `ProviderError` with `code`, `status`, `providerCode`, `requestId` and `retryAfterMs`. New kinds: `quota_exceeded`, `model_not_found`, `context_length`, `overloaded` and `stream_interrupted` |
| Refusals | Generic failure, no explanation | Anthropic `stop_details`, OpenAI refusal parts and deltas. Failure code `provider_refusal` carries the explanation |
| Interrupted streams | A truncated OpenAI stream could be returned as a complete answer | No finish reason, missing `response.completed` or `message_stop`, or a mid-stream drop now raise `stream_interrupted` (retryable) |
| Retries | Fixed doubling, no jitter, no cap, `Retry-After` ignored | Bounded exponential backoff with jitter. Never earlier than `Retry-After`. A long `Retry-After` fails fast as retryable. `model.retry` events |
| Loop guard | A model retrying a failing tool was bounded only by `maxIterations` | `tool_failure_limit` after 3 consecutive turns in which every tool call failed or was rejected |
| Logging | Crash logs only | Structured `model_call`, `model_call_failed` and `run_failed` log records with latency, tokens, served model and request id. Redaction paths for credential-bearing fields |
| Usage | Reasoning and cached tokens not shown; cached input billed at full price | Reasoning and cached tokens recorded. Cached input priced at the published cached rate where one exists |
| Dashboard | "Connected" shown when a key merely existed | "Key set, not checked", then "Live: account verified" after a Models API check. Shows LIVE or MOCK per run, served model, request ids, retries, failure codes and estimated cost |

## What changed

* `packages/providers`
  * `errors.ts`: structured errors, retry-after parsing.
  * `adapters/openaiResponses.ts`: new.
  * `adapters/anthropic.ts`: pinned endpoint, model discovery, refusal details, interruption.
  * `adapters/openaiCompatible.ts`: xAI; pinned endpoint, refusal, interruption, reasoning tokens.
  * `catalog.ts`: published prices, cached pricing, provenance fields.
  * `registry.ts`: explicit endpoints.
* `packages/runtime`
  * `engine.ts`: retry policy, `model.retry`, failure-code mapping, tool-failure loop guard, structured logging, richer `model.output`, `usage.recorded` and `run.failed` payloads.
* `packages/contracts`: new failure codes, the `model.retry` event, and `ProviderInfo.endpoint` and `priceSource`.
* `apps/api`
  * endpoint, timeout and retry config
  * `ModelDiscoveryService` and `GET /providers/:id/models`
  * live/mock usage split on `/dashboard`
  * log redaction paths
* `apps/web`
  * provider account check
  * LIVE/MOCK badges
  * timeline metadata, retry and failure details
  * the chat and task views drop partial text from a failed attempt

## Live verification (real API calls)

Command: `AGENTOS_LIVE_TESTS=1 pnpm test:live` (runtime) and `pnpm test:e2e:live` (browser). Raw output (request ids and token counts, no secrets): `docs/evidence/milestone-2a-live-run.txt`.

| # | Scenario | OpenAI `gpt-6-luna` | Anthropic `claude-haiku-5-5` | xAI |
|---|---|---|---|---|
| 1 | Basic conversation, streamed deltas, usage, served model | Pass (191 in / 8 out tokens) | Pass (278 / 9) | Not run |
| 2 | Calculator tool call → server execution → answer uses result (189,076,273) | Pass, 2 iterations | Pass, 2 iterations | Not run |
| 3 | Model told about a `shell_exec` tool it is not allowed to use | Pass: it called the tool, the engine rejected it, the model recovered | Pass: same | Not run |
| 4 | Two-agent pipeline, JSON handoff validated, verifier confirms (829,348,951) | Pass | Pass | Not run |
| 4b | Sensitive tool pauses for approval; rejection respected, tool never runs | Pass | Pass | Not run |
| 5a | Invalid model id → `model_not_found`, no retry | Pass (HTTP 404, `model_not_found`) | Pass (HTTP 404, `not_found_error`) | Not run |
| 5b | Invalid key → `provider_auth`, no retry, key not echoed | Pass | Pass | Not run |
| 5c | Timeout → `PROVIDER_TIMEOUT`, one backoff retry, then retryable failure | Pass | Pass | Not run |
| 5d | Cancel mid-stream | Pass (stopped 10 ms after abort) | Pass (2 ms) | Not run |
| 6 | Usage records sum to run totals; cost recomputes from published price | Pass ($0.000087 est.) | Pass ($0.000199 est.) | Not run |
| X | Cross-provider handoff OpenAI → Anthropic, verified JSON | Pass | Pass | n/a |
| UI | Browser: Settings "Check account" → "Live: account verified"; real task shows LIVE run, tool result, request ids | Pass | Account check pass | Not run |

Total spend for all live runs in this milestone: well under $0.01 (estimated from the catalog).

Not verified live, and why:
* **Real rate limits (429) and overload (529).** These can't be triggered safely on a personal account. The classification and `Retry-After` handling are covered by unit tests that use the SDKs' own error classes and real HTTP responses from a fake server.
* **Server-side interrupted streams.** A provider can't be made to drop a stream on demand. Covered by unit tests that feed the real SDK truncated and broken SSE bodies.
* **Refusals.** Not provoked live, since that would mean deliberately requesting harmful content. Mapping is covered by unit tests for both providers.
* **Timeouts.** Verified by forcing a 5 ms client timeout against the live API, not by a slow provider response.

## Test results (full run)

| Check | Command | Result |
|---|---|---|
| Type checking | `pnpm typecheck` | 7/7 packages pass |
| Lint + boundaries | `pnpm lint` | 0 problems; boundaries OK |
| Tools | `pnpm test` | 25 passed |
| Providers | `pnpm test` | 32 passed (13 existing + 19 new) |
| Runtime | `pnpm test` | 30 passed (20 existing + 10 new) |
| API integration (PostgreSQL 16) | `pnpm test` | 23 passed (20 existing + 3 new security tests) |
| Browser (mock) | `pnpm test:e2e` | 4 passed: no regressions |
| Live runtime | `pnpm test:live` | 21 passed, 10 skipped (xAI, no key) |
| Live browser | `pnpm test:e2e:live` | 1 passed |

Three existing assertions changed on purpose:
* Anthropic 529 is now `overloaded` rather than `server`.
* Usage now includes `reasoningTokens`.
* An auth failure now fails with `provider_auth` rather than `provider_error`.

## Security (Phase 6)

* **Keys stay server-side.** `/providers` returns the endpoint and status, never a key (API test). No database table stores credentials.
* **Keys never reach logs.** A canary-key integration test has a fake provider echo the key in its error body. It then checks that the key appears nowhere in debug-level logs, events, tasks, runs, messages, audit logs or API responses. It also confirms the key went only to the configured endpoint. The live runs also assert that no key appears in events, logs, tasks or runs.
* **Agents cannot reach credentials.** The registered tools are calculator, datetime, text, JSON transform and the approval-gated mock action. None of them can read environment variables, files or the network, or run commands. Creating an agent with an unknown tool such as `shell_exec` or `read_env` is rejected. When a live model was tricked into calling `shell_exec`, the call was blocked.
* **Tools are permission-checked and validated.** Allowlist and Zod validation are unchanged and exercised live (scenario 3).
* **Sensitive actions require approval.** Verified live (scenario 4b).
* **Endpoint pinning** stops the host environment from redirecting keys.
* No terminal execution or browser automation tools were added.

## Known limitations

* **xAI unverified.** The adapter still uses Chat Completions. If xAI models have the same tools-plus-reasoning restriction as OpenAI, a Responses-based xAI adapter will be needed.
* **Anthropic costs err high when prompt caching applies,** because cache-read prices are not modelled. They are charged at the full input price.
* **The OpenAI Responses adapter sends `strict: false` function schemas,** because AgentOS tool schemas allow optional fields. Arguments are still validated server-side before any tool runs.
* **Model discovery is per deployment key and cached for 5 minutes.** It is not per organization, since keys are still deployment-wide; per-org encrypted credentials are the next step.
* **Retries restart the whole model call.** Usage is recorded only for completed calls. Tokens a provider bills for a failed or interrupted attempt are not counted, so estimates can undercount after retries.
* **Behind an HTTP proxy, Node needs `NODE_USE_ENV_PROXY=1`.** This is documented in `.env.example`.
* **The keys used for this milestone were pasted into chat.** They should be rotated and supplied as environment secrets.

## Success criteria

| Criterion | Status |
|---|---|
| At least one real provider completes a tool-assisted task | Met (two providers) |
| Streaming works with a real provider | Met |
| Tool calls and results processed correctly | Met |
| Unauthorized tool calls blocked | Met (real model attempted, engine rejected) |
| Real multi-agent handoff verified | Met (same-provider and cross-provider) |
| Existing tests still pass | Met |
| Unverified providers clearly documented | Met (xAI, here and in `docs/providers.md`) |
