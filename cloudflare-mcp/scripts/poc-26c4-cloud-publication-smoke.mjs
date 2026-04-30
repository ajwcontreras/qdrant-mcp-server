#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26c4-cloud-publication-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const workerName = "cfcode-poc-26c4-publication";
const bucketName = "cfcode-poc-26c4-artifacts";
const dbName = "cfcode-poc-26c4-jobs";
const indexName = "cfcode-poc-26c4-vectorize";
const queueName = "cfcode-poc-26c4-publication";
const dlqName = "cfcode-poc-26c4-publication-dlq";

function loadCloudflareEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
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
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
  fs.writeFileSync(generatedConfig, fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8").replace("__DATABASE_ID__", databaseId), "utf8");
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

async function waitForPublished(baseUrl, publicationId) {
  const deadline = Date.now() + 90_000;
  let status;
  while (Date.now() < deadline) {
    status = await fetchJson(`${baseUrl}/publication/${publicationId}/status`);
    if (status.job?.status === "published" && status.chunks?.length === status.job?.total) return status;
    if (status.job?.status === "failed") throw new Error(`Publication failed: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Publication did not finish: ${JSON.stringify(status)}`);
}

async function waitForSearch(baseUrl, values, expectedId) {
  const deadline = Date.now() + 90_000;
  let search;
  while (Date.now() < deadline) {
    search = await fetchJson(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, topK: 3 }),
    });
    if (search.matches?.some((match) => match.id === expectedId && match.chunk?.path)) return search;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Search did not return ${expectedId}: ${JSON.stringify(search)?.slice(0, 800)}`);
}

function deterministicVector(seed, dimensions = 1536) {
  const values = [];
  let state = crypto.createHash("sha256").update(seed).digest();
  while (values.length < dimensions) {
    state = crypto.createHash("sha256").update(state).digest();
    for (const byte of state) {
      values.push((byte / 255) * 2 - 1);
      if (values.length === dimensions) break;
    }
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function buildArtifact() {
  const rows = [
    { path: "app/routes.py", text: "FastAPI routes for lumae chat and retrieval.", seed: "routes" },
    { path: "app/embeddings.py", text: "Google Gemini embedding helpers for code search.", seed: "embeddings" },
    { path: "app/mcp.py", text: "Unauthenticated MCP search endpoint for indexed codebase.", seed: "mcp" },
  ].map((row) => ({
    vector_id: `vec-${sha256(row.seed).slice(0, 16)}`,
    chunk_identity: `lumae-fresh:${row.path}`,
    path: row.path,
    text: row.text,
    values: deterministicVector(row.seed),
    model: "gemini-embedding-001",
    dimensions: 1536,
  }));
  const artifactText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return {
    rows,
    artifactText,
    artifactKey: `publication/lumae-fresh-poc-26c4/${sha256(artifactText).slice(0, 16)}.jsonl`,
    publicationId: `pub-${sha256(artifactText).slice(0, 16)}`,
  };
}

function cleanup(artifactKey) {
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName], { allowFailure: true, capture: true });
  if (artifactKey) run("npx", ["wrangler", "r2", "object", "delete", `${bucketName}/${artifactKey}`, "--remote"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26C4: Combined Queue Publication To Vectorize And D1\n");
  const checks = {
    publicationQueued: false,
    vectorizeSearch: false,
    d1Chunks: false,
    collectionInfo: false,
    cleanup: false,
  };
  const artifact = buildArtifact();
  try {
    cleanup(artifact.artifactKey);
    run("npx", ["wrangler", "queues", "create", queueName]);
    run("npx", ["wrangler", "queues", "create", dlqName]);
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeGeneratedConfig(extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`));
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitForHealth(baseUrl);
    const start = await fetchJson(`${baseUrl}/publication/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_slug: "lumae-fresh",
        indexed_path: targetRepo,
        publication_id: artifact.publicationId,
        artifact_key: artifact.artifactKey,
        artifact_text: artifact.artifactText,
      }),
    });
    checks.publicationQueued = start.queued === artifact.rows.length;
    const done = await waitForPublished(baseUrl, artifact.publicationId);
    checks.d1Chunks = done.chunks.length === artifact.rows.length && done.job.completed === artifact.rows.length;
    const info = await fetchJson(`${baseUrl}/collection_info`);
    checks.collectionInfo = info.active?.publication_id === artifact.publicationId && info.active?.indexed_path === targetRepo;
    const search = await waitForSearch(baseUrl, artifact.rows[0].values, artifact.rows[0].vector_id);
    checks.vectorizeSearch = search.matches.some((match) => match.id === artifact.rows[0].vector_id && match.chunk?.path === artifact.rows[0].path);
    console.log(`Worker: ${baseUrl}`);
    console.log(`Publication ID: ${artifact.publicationId}`);
    console.log(`Published vectors: ${done.job.completed}`);
    console.log(`Search matches: ${search.matches.map((match) => match.id).join(", ")}`);
  } finally {
    cleanup(artifact.artifactKey);
    checks.cleanup = true;
  }
  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
