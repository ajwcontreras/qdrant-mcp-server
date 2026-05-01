// Cloudflare resource provisioning + worker deploy.
// Idempotent: existing resources are reused.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./exec.mjs";
import { loadCfEnv } from "./env.mjs";
import { setNamespaceWorkerSecret } from "./wfp-secret.mjs";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const WORKER_DIR = path.join(REPO_ROOT, "cloudflare-mcp/workers/codebase");

// Per-codebase queue concurrency. v1: producer-only (no consumer in namespace deploys
// because a queue can only have one consumer worker — left to the standalone path
// for the indexing pipeline if/when needed).
export { WORKER_DIR };

// Ensure all CF resources exist for a given repo slug. Idempotent.
// Returns the d1_id for the database (needed for wrangler config).
export function provisionResources({ workerName, r2Bucket, d1Name, vectorizeIndex, queueName, dlqName }, opts = {}) {
  const log = opts.log || (() => {});

  log("Creating DLQ...");
  run("npx", ["wrangler", "queues", "create", dlqName], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Creating queue...");
  run("npx", ["wrangler", "queues", "create", queueName], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Creating R2 bucket...");
  run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Creating Vectorize index...");
  run("npx", ["wrangler", "vectorize", "create", vectorizeIndex, "--dimensions=1536", "--metric=cosine"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  for (const prop of ["repo_slug", "file_path", "active_commit"]) {
    run("npx", ["wrangler", "vectorize", "create-metadata-index", vectorizeIndex, "--property-name", prop, "--type=string"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  }

  // D1 needs special handling — get id whether existing or new
  log("Resolving D1 database...");
  const d1Id = ensureD1(d1Name);

  return { d1Id };
}

function ensureD1(d1Name) {
  // Try create first; capture output to extract ID
  const create = run("npx", ["wrangler", "d1", "create", d1Name], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  const out = `${create.stdout || ""}\n${create.stderr || ""}`;
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];

  // Already exists — list and find by name
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { cwd: WORKER_DIR, capture: true });
  const dbs = JSON.parse(list.stdout || "[]");
  const found = dbs.find(d => d.name === d1Name);
  if (!found) throw new Error(`Could not create or find D1 database ${d1Name}:\n${out}`);
  return found.uuid;
}

// Write a wrangler config for a namespace user worker (no queue consumer).
export function writeNamespaceWranglerConfig(configPath, { workerName, r2Bucket, d1Name, d1Id, vectorizeIndex, queueName }) {
  const tplPath = path.join(WORKER_DIR, "wrangler.namespace.template.jsonc");
  const tpl = fs.readFileSync(tplPath, "utf8");
  const filled = tpl
    .replace("__WORKER_NAME__", workerName)
    .replace("__R2_BUCKET__", r2Bucket)
    .replace("__D1_NAME__", d1Name)
    .replace("__D1_ID__", d1Id)
    .replace("__VECTORIZE_INDEX__", vectorizeIndex)
    .replace("__QUEUE_NAME__", queueName);
  fs.writeFileSync(configPath, filled, "utf8");
}

// Deploy a worker into a dispatch namespace. Returns nothing — namespace workers
// have no public URL.
export function deployToNamespace(configPath, namespaceName) {
  run("npx", ["wrangler", "deploy", "--config", configPath, "--dispatch-namespace", namespaceName], { cwd: WORKER_DIR, capture: true });
}

// Set the Vertex SA secret on a namespace user worker via the multipart upload
// API (wrangler `secret put` does not support `--dispatch-namespace`).
export async function setNamespaceVertexSecret({ namespaceName, scriptName, saB64 }) {
  return setNamespaceWorkerSecret({
    namespaceName, scriptName,
    secretName: "GEMINI_SERVICE_ACCOUNT_B64", secretValue: saB64,
  });
}

// Tear down all resources for a slug, including the namespace user worker. Best-effort.
export function teardownResources({ workerName, r2Bucket, d1Name, vectorizeIndex, queueName, dlqName, namespaceName }, opts = {}) {
  const log = opts.log || (() => {});
  log("Deleting namespace user worker...");
  run("npx", ["wrangler", "delete", "--name", workerName, "--dispatch-namespace", namespaceName, "--force"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Deleting queue + DLQ...");
  run("npx", ["wrangler", "queues", "delete", queueName, "--force"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  run("npx", ["wrangler", "queues", "delete", dlqName, "--force"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Deleting Vectorize index...");
  run("npx", ["wrangler", "vectorize", "delete", vectorizeIndex, "--force"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Deleting R2 bucket...");
  run("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Deleting D1...");
  run("npx", ["wrangler", "d1", "delete", d1Name, "--skip-confirmation"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
}
