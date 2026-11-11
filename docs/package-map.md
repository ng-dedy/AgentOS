# Package dependency map

Arrows point from a package to what it imports. Nothing imports `apps/*`.
`apps/web` imports only `contracts` (types + Zod schemas), never server code.

```
apps/web ──────────────────────────────────────────────▶ packages/contracts
apps/api ──▶ packages/runtime ──▶ packages/providers ──▶ packages/contracts
   │               │            └▶ packages/tools ─────▶ packages/contracts
   ├──▶ packages/db ──────────────────────────────────▶ (generated Prisma client)
   ├──▶ packages/providers
   └──▶ packages/tools
```

Rules (enforced by review and by `scripts/check-boundaries.mjs`, run in `pnpm lint`):

* `packages/runtime` must not import `@prisma/client`, `fastify`, or any provider SDK.
* `packages/contracts` must not import any other workspace package.
* `apps/web` must not import `@agentos/db`, `@agentos/providers`, `@agentos/runtime` or `@agentos/tools`.
* Provider SDKs (`openai`, `@anthropic-ai/sdk`) may only be imported in `packages/providers/src/adapters/`.
