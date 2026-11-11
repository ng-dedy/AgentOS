#!/usr/bin/env node
// Enforces the package dependency rules in docs/package-map.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const RULES = [
  { dir: "packages/contracts/src", forbid: [/^@agentos\//, /^@prisma\//, /^fastify/, /^openai$/, /^@anthropic-ai\//], why: "contracts must not depend on other packages" },
  { dir: "packages/runtime/src", forbid: [/^@prisma\//, /^@agentos\/db$/, /^fastify/, /^@fastify\//, /^openai$/, /^@anthropic-ai\//], why: "runtime must stay independent of persistence, HTTP and provider SDKs" },
  { dir: "packages/tools/src", forbid: [/^@agentos\/(db|runtime|providers)$/, /^@prisma\//, /^fastify/, /^node:child_process$/, /^child_process$/], why: "tools must not reach persistence or spawn processes" },
  { dir: "packages/providers/src", forbid: [/^@agentos\/(db|runtime|tools)$/, /^@prisma\//, /^fastify/], why: "providers must not depend on runtime or persistence" },
  { dir: "apps/web/src", forbid: [/^@agentos\/(db|runtime|providers|tools)$/, /^@prisma\//, /^openai$/, /^@anthropic-ai\//], why: "web may only import @agentos/contracts" },
];
// Provider SDKs may only be imported inside the adapters folder.
const SDK_RULE = { forbid: [/^openai$/, /^@anthropic-ai\//], allowDir: "packages/providers/src/adapters" };

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "generated" || name === "test-results") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(name)) yield p;
  }
}

const errors = [];
for (const rule of RULES) {
  for (const file of walk(join(root, rule.dir))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (rule.forbid.some((re) => re.test(spec))) errors.push(`${relative(root, file)} imports '${spec}': ${rule.why}`);
    }
  }
}
for (const dir of ["packages", "apps"]) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    if (rel.includes("node_modules") || rel.includes("/generated/") || rel.includes("/.next/")) continue;
    if (rel.startsWith(SDK_RULE.allowDir) || rel.startsWith("packages/providers/test")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (SDK_RULE.forbid.some((re) => re.test(spec))) errors.push(`${rel} imports provider SDK '${spec}' outside ${SDK_RULE.allowDir}`);
    }
  }
}

if (errors.length) {
  console.error("Package boundary violations:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("Package boundaries OK");
