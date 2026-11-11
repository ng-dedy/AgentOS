# Package dependency map

Arrows point from a package to what it imports. Nothing imports `apps/*`.
`apps/web` imports only `contracts` (types + Zod schemas), never server code.

```
apps/web ──────────────────────────────────────────────────────────▶ packages/contracts
apps/api ────┬─▶ packages/workflows (client) ─▶ packages/runtime (types)
apps/worker ─┤                                  
             └─▶ packages/platform ─▶ packages/runtime ─▶ packages/providers ─▶ packages/contracts
                       │                     └──────────▶ packages/tools ─────▶ packages/contracts
                       └─▶ packages/db ─────────────────▶ (generated Prisma client)
apps/worker ───▶ packages/workflows (worker, activities, workflows)
```

`packages/workflows/src/workflows/` is bundled into Temporal's deterministic sandbox and may
import only `@temporalio/workflow` plus type-only imports.

Rules (enforced by review and by `scripts/check-boundaries.mjs`, run in `pnpm lint`):

* `packages/runtime` must not import `@prisma/client`, `fastify`, or any provider SDK.
* `packages/contracts` must not import any other workspace package.
* `apps/web` must not import `@agentos/db`, `@agentos/providers`, `@agentos/runtime` or `@agentos/tools`.
* Provider SDKs (`openai`, `@anthropic-ai/sdk`) may only be imported in `packages/providers/src/adapters/`.
* `packages/runtime` must not import `@temporalio/*`.
* `packages/workflows/src/workflows` must not import Node APIs, `@agentos/db|platform|providers|tools`, or the Temporal client/worker/activity packages.
* `packages/platform` must not import Fastify, Temporal or provider SDKs.
