// Cloudflare resource provisioning + worker deploy.
// Idempotent: existing resources are reused.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./exec.mjs";
import { loadCfEnv } from "./env.mjs";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const WORKER_DIR = path.join(REPO_ROOT, "cloudflare-mcp/workers/codebase");

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

export function writeWranglerConfig(configPath, { workerName, r2Bucket, d1Name, d1Id, vectorizeIndex, queueName, dlqName }) {
  const tplPath = path.join(WORKER_DIR, "wrangler.template.jsonc");
  const tpl = fs.readFileSync(tplPath, "utf8");
  const filled = tpl
    .replace("__WORKER_NAME__", workerName)
    .replace("__R2_BUCKET__", r2Bucket)
    .replace("__D1_NAME__", d1Name)
    .replace("__D1_ID__", d1Id)
    .replace("__VECTORIZE_INDEX__", vectorizeIndex)
    .replaceAll("__QUEUE_NAME__", queueName)
    .replace("__DLQ_NAME__", dlqName);
  fs.writeFileSync(configPath, filled, "utf8");
}

export function deployWorker(configPath) {
  const r = run("npx", ["wrangler", "deploy", "--config", configPath], { cwd: WORKER_DIR, capture: true });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  if (!urls.length) throw new Error(`no Worker URL in deploy output:\n${out}`);
  return urls[0];
}

// Set the Vertex SA secret on the deployed worker. Idempotent (overwrites).
export function setVertexSecret(configPath, saB64) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", configPath], {
    cwd: WORKER_DIR, env: loadCfEnv(), input: saB64, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`secret put failed:\n${result.stdout}\n${result.stderr}`);
}

// Tear down all resources for a slug. Best-effort.
export function teardownResources({ workerName, r2Bucket, d1Name, vectorizeIndex, queueName, dlqName }, opts = {}) {
  const log = opts.log || (() => {});
  log("Removing queue consumer...");
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { cwd: WORKER_DIR, capture: true, allowFailure: true });
  log("Deleting worker...");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { cwd: WORKER_DIR, capture: true, allowFailure: true });
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
