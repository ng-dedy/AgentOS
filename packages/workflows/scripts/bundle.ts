/**
 * Pre-build the workflow bundle for production workers:
 *   pnpm --filter @agentos/workflows bundle            -> dist/workflow-bundle.js
 * Then run workers with TEMPORAL_WORKFLOW_BUNDLE_PATH pointing at the file and
 * TEMPORAL_WORKER_BUILD_ID set to the same commit the bundle was built from, so every
 * worker in a deployment version runs byte-identical workflow code.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";
import { WORKFLOWS_PATH } from "../src/worker";

const out = resolve(process.argv[2] ?? "dist/workflow-bundle.js");
const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, code);
process.stdout.write(JSON.stringify({ out, bytes: code.length, sha256: createHash("sha256").update(code).digest("hex") }) + "\n");
