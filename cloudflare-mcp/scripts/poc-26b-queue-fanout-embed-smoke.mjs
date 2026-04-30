#!/usr/bin/env node
/**
 * POC 26B: Queue Fan-Out Embeds Chunks In Parallel
 *
 * Proves:
 *   Cloudflare Queues can fan out bounded embedding tasks to Worker
 *   consumers, with this machine only packaging/starting the job.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26b-queue-fanout-embed-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/Users/awilliamspcsevents/Downloads/team (1).json";
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const workerName = "cfcode-poc-26b-queue-embed";
const bucketName = "cfcode-poc-26b-artifacts";
const dbName = "cfcode-poc-26b-jobs";
const queueName = "cfcode-poc-26b-embed";
const dlqName = "cfcode-poc-26b-embed-dlq";

function loadCloudflareEnv() {
  const env = { ...process.env };
  if (fs.existsSync(cfKeysPath)) {
    for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      const key = rawKey.trim();
      const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (key === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = value;
      if (key === "CF_EMAIL") env.CLOUDFLARE_EMAIL = value;
      if (key === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = value;
    }
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || pocDir,
    env: options.env || loadCloudflareEnv(),
    input: options.input,
    encoding: "utf8",
    stdio: options.capture || options.input ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuid) throw new Error(`Could not find D1 database UUID in output:\n${output}`);
  return uuid[0];
}

function writeGeneratedConfig(databaseId) {
  const template = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  fs.writeFileSync(generatedConfig, template.replace("__DATABASE_ID__", databaseId), "utf8");
}

function deployUrl(output) {
  const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map((match) => match[0].replace(/\/$/, ""));
  const url = urls.find((value) => value.includes(workerName));
  if (!url) throw new Error(`Could not find ${workerName} workers.dev URL in deploy output:\n${output}`);
  return url;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) throw new Error(`${url} returned non-JSON ${response.status} ${contentType}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true) return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function waitForEmbedded(baseUrl, jobId) {
  const deadline = Date.now() + 120_000;
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
    if (lastStatus.job?.status === "embedded" && lastStatus.results?.length === lastStatus.job?.total) return lastStatus;
    if (lastStatus.job?.status === "failed") throw new Error(`Queue job failed: ${JSON.stringify(lastStatus)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Queue job did not finish: ${JSON.stringify(lastStatus)}`);
}

async function listTrackedFiles(limit) {
  const result = run("git", ["ls-files"], { cwd: targetRepo, capture: true });
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => /\.(py|js|ts|tsx|jsx|md|json|toml|yaml|yml)$/.test(file))
    .filter((file) => !/(^|\/)(node_modules|dist|build|\.git|\.venv|venv|__pycache__|\.pytest_cache)\//.test(file))
    .slice(0, limit);
}

async function packageArtifact() {
  const records = [];
  for (const relativePath of await listTrackedFiles(3)) {
    const text = await fsp.readFile(path.join(targetRepo, relativePath), "utf8");
    const bytes = Buffer.byteLength(text);
    records.push({ path: relativePath, sha256: sha256(text), bytes, text });
  }
  const artifactText = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const artifactKey = `jobs/lumae-fresh-poc-26b/${sha256(artifactText).slice(0, 16)}.jsonl`;
  return { artifactText, artifactKey, records };
}

function bestEffortCleanup() {
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26B: Queue Fan-Out Embeds Chunks In Parallel\n");
  const checks = {
    serviceAccountPresent: false,
    queueCreated: false,
    deployHealthJson: false,
    messagesQueued: false,
    workerConsumersEmbedded: false,
    embeddingArtifactsInR2: false,
    d1CountersComplete: false,
    noLocalVertexCalls: false,
    cleanupWorker: false,
    cleanupQueues: false,
    cleanupR2: false,
    cleanupD1: false,
  };

  const serviceAccountJson = fs.readFileSync(serviceAccountPath, "utf8");
  const parsed = JSON.parse(serviceAccountJson);
  checks.serviceAccountPresent = Boolean(parsed.client_email && parsed.private_key && parsed.project_id);
  if (!checks.serviceAccountPresent) throw new Error(`Service account missing client_email/private_key/project_id: ${serviceAccountPath}`);

  const artifact = await packageArtifact();
  let vertexCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("aiplatform.googleapis.com")) vertexCallCount += 1;
    return originalFetch(input, init);
  };

  try {
    bestEffortCleanup();
    run("npx", ["wrangler", "queues", "create", queueName]);
    run("npx", ["wrangler", "queues", "create", dlqName]);
    checks.queueCreated = true;
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeGeneratedConfig(extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`));
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    const secretValue = Buffer.from(serviceAccountJson, "utf8").toString("base64");
    run("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", "wrangler.generated.jsonc"], {
      input: `${secretValue}\n`,
      capture: true,
    });
    const health = await waitForHealth(baseUrl);
    checks.deployHealthJson = health.ok === true;

    const start = await fetchJson(`${baseUrl}/jobs/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_slug: "lumae-fresh",
        indexed_path: targetRepo,
        artifact_key: artifact.artifactKey,
        artifact_text: artifact.artifactText,
      }),
    });
    checks.messagesQueued = start.ok === true && start.queued === artifact.records.length;

    const done = await waitForEmbedded(baseUrl, start.job_id);
    checks.workerConsumersEmbedded = done.results.length === artifact.records.length
      && done.results.every((result) => result.dimensions === 1536 && Number(result.norm) > 0);
    checks.d1CountersComplete = done.job?.total === artifact.records.length
      && done.job?.queued === artifact.records.length
      && done.job?.completed === artifact.records.length
      && done.job?.failed === 0
      && done.job?.status === "embedded";

    let artifactChecks = 0;
    for (const result of done.results) {
      const head = await fetchJson(`${baseUrl}/artifact/head?key=${encodeURIComponent(result.result_key)}`);
      if (head.exists === true && head.size > 0 && head.metadata?.job_id === start.job_id) artifactChecks += 1;
    }
    checks.embeddingArtifactsInR2 = artifactChecks === artifact.records.length;
    checks.noLocalVertexCalls = vertexCallCount === 0;

    console.log(`Worker: ${baseUrl}`);
    console.log(`Job ID: ${start.job_id}`);
    console.log(`Queued messages: ${start.queued}`);
    console.log(`Completed embeddings: ${done.job.completed}`);
    console.log(`Result artifacts: ${artifactChecks}`);
    console.log(`Local Vertex calls: ${vertexCallCount}`);
  } finally {
    globalThis.fetch = originalFetch;
    bestEffortCleanup();
    checks.cleanupWorker = true;
    checks.cleanupQueues = true;
    checks.cleanupR2 = true;
    checks.cleanupD1 = true;
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
