# Providers

How AgentOS talks to model providers, what has been verified against the live APIs, and how to re-verify.

## Adapters

| Provider | Adapter | API | Endpoint (default) | Live status |
|---|---|---|---|---|
| OpenAI | `OpenAIResponsesProvider` | Responses API, streaming, `store: false`, `include: ["reasoning.encrypted_content"]` | `https://api.openai.com/v1` | **Verified 2026-11-11** on `gpt-6-luna` |
| Anthropic | `AnthropicProvider` | Messages API, streaming + `finalMessage()` | `https://api.anthropic.com` | **Verified 2026-11-11** on `claude-haiku-5-5` |
| xAI | `OpenAICompatibleProvider` | Chat Completions (OpenAI-compatible) | `https://api.x.ai/v1` | **Not verified**: no key was available |
| MOCK | `MockProvider` | none (scripted test double) | none | Not an AI model. Labelled MOCK everywhere |

### Why OpenAI uses the Responses API

A live call on 2026-11-11 showed that current OpenAI models reject function tools on Chat Completions:

> Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.

Turning reasoning off would have degraded the model, so the OpenAI adapter now uses the Responses API. Requests are stateless (`store: false`). Reasoning items come back encrypted and are replayed unchanged on the next turn through `providerState`, so the model keeps its reasoning across tool calls without OpenAI storing the conversation.

### Endpoint pinning

Both SDKs read their base URL from the process environment by default (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`). A hosting environment that sets these for its own tooling would silently receive the organization's keys. Every adapter therefore passes an explicit `baseURL`, configurable only through `AGENTOS_OPENAI_BASE_URL`, `AGENTOS_ANTHROPIC_BASE_URL` and `AGENTOS_XAI_BASE_URL`. These must be https URLs. A unit test sets the SDK variables to an attacker host and asserts that no request goes there.

## Model catalog

Source: `packages/providers/src/catalog.ts`. Every non-mock entry has `priceSource: "published"`, a `priceSourceUrl` (where available) and a `priceCheckedAt` date. No model id or price was invented.

| Provider | Model id | Input / Output per 1M tokens (USD) | Cached input | Source | On the test account |
|---|---|---|---|---|---|
| Anthropic | `claude-opus-5-5` | 4 / 20 | not modelled (charged at full input) | Anthropic pricing, as of 2026-11-03 | Yes (Models API) |
| Anthropic | `claude-sonnet-5-5` | 2 / 10 | not modelled | Anthropic pricing, as of 2026-11-03 | Yes |
| Anthropic | `claude-haiku-5-5` | 0.10 / 0.50 | not modelled | Anthropic pricing, as of 2026-11-03 | Yes |
| OpenAI | `gpt-6.1-sol` | 2.00 / 10.00 | 0.10 | developers.openai.com/api/docs/pricing, 2026-11-11 | Yes |
| OpenAI | `gpt-6.1-terra` | 1.00 / 5.00 | 0.05 | same | Yes |
| OpenAI | `gpt-6-luna` | 0.10 / 0.50 | 0.01 | same | Yes |
| xAI | `grok-4.7` | 2.00 / 6.00 | n/a | docs.x.ai/developers/pricing, 2026-11-11 | **Unknown** (no key) |

Removed in 2A because they were placeholders: `gpt-5`, `gpt-5-mini` (they exist on the account but are not on OpenAI's current price list, so there is no published price to use), `grok-4`, `grok-4-fast` (not on xAI's current model or price list).

Costs shown in AgentOS are **estimates**: provider-reported tokens × catalog price. Providers bill from their own meters. Anthropic cache-read discounts are not modelled, so Anthropic estimates err high when prompt caching applies.

Settings → **Check account** calls each provider's Models API with the server's key and marks every catalog model as "on account" or "not on account" (`GET /api/v1/providers/:id/models`).

## Error model

Every provider failure becomes a `ProviderError` with a stable `code` (`PROVIDER_<KIND>`), `kind`, `retryable`, and when available `status`, `providerCode`, `requestId` and `retryAfterMs`. The message is fixed text and never contains the provider's response body.

| Kind | Typical cause | Retried | Run failure code |
|---|---|---|---|
| `rate_limit` | HTTP 429, `rate_limit_error` | yes, honours `Retry-After` | `provider_retryable_error` |
| `overloaded` | HTTP 529, `overloaded_error` | yes | `provider_retryable_error` |
| `server` | HTTP 5xx, `server_error` | yes | `provider_retryable_error` |
| `timeout` | client timeout, HTTP 408 | yes | `provider_retryable_error` |
| `network` | connection failed before any data | yes | `provider_retryable_error` |
| `stream_interrupted` | stream ended or dropped before completion | yes | `provider_retryable_error` |
| `quota_exceeded` | `insufficient_quota`, `billing_error` (HTTP 429/400) | **no** | `provider_quota` |
| `auth` | HTTP 401/403 | no | `provider_auth` |
| `model_not_found` | HTTP 404 / `model_not_found` / `not_found_error` | no | `model_not_found` |
| `context_length` | prompt too long | no | `context_length` |
| `refusal` | refusal stop reason or policy error | no | `provider_refusal` |
| `bad_request` | other 4xx | no | `provider_error` |

Retry policy (`AgentEngine`): up to `PROVIDER_MAX_RETRIES` retries (default 2), delay `min(8 s, base × 2^attempt)` with 50–100 % jitter, never shorter than the provider's `Retry-After`. If `Retry-After` exceeds 30 s the run fails as retryable instead of holding the run open. Each retry emits a persisted `model.retry` event so the UI drops partial streamed text from the failed attempt.

## Running the live checks

```bash
# Real provider calls through the real runtime, tools and workflow engine (≈ $0.001 per full run)
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm test:live

# Real browser + real API + real model
AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm test:e2e:live
```

Behind an HTTP proxy, also set `NODE_USE_ENV_PROXY=1` (Node's fetch ignores `HTTPS_PROXY` otherwise). Each provider's suite is skipped when its key is absent, and a skipped suite is not a verification.
