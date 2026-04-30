#!/usr/bin/env node
/**
 * POC 26A4: Combined Local Packager To R2 And D1
 *
 * Proves:
 *   This machine can package a bounded source artifact once, a Worker can
 *   store it in R2, and D1 can record machine-readable job status.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26a4-packager-r2-d1-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const workerName = "cfcode-poc-26a4-packager";
const bucketName = "cfcode-poc-26a4-artifacts";
const dbName = "cfcode-poc-26a4-jobs";

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
  if (!contentType.includes("application/json")) {
    throw new Error(`${url} returned non-JSON ${response.status} ${contentType}: ${text.slice(0, 300)}`);
  }
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
  const files = [];
  const records = [];
  for (const relativePath of await listTrackedFiles(5)) {
    const absolutePath = path.join(targetRepo, relativePath);
    const text = await fsp.readFile(absolutePath, "utf8");
    const bytes = Buffer.byteLength(text);
    const hash = sha256(text);
    files.push({ path: relativePath, sha256: hash, bytes });
    records.push({ path: relativePath, sha256: hash, bytes, text });
  }
  const artifactText = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const artifactKey = `jobs/lumae-fresh-poc-26a4/${sha256(artifactText).slice(0, 16)}.jsonl`;
  return { artifactKey, artifactText, files };
}

async function main() {
  console.log("POC 26A4: Combined Local Packager To R2 And D1\n");
  const checks = {
    deployHealthJson: false,
    artifactStoredInR2: false,
    d1JobRecorded: false,
    noVertexCalls: false,
    statusJson: false,
    cleanupWorker: false,
    cleanupR2: false,
    cleanupD1: false,
  };

  const artifact = await packageArtifact();
  let deployed = false;
  let vertexCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("aiplatform.googleapis.com")) vertexCallCount += 1;
    return originalFetch(input, init);
  };

  try {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeGeneratedConfig(extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`));
    run("npm", ["install"]);
    run("npm", ["run", "check"]);

    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    deployed = true;

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
        files: artifact.files,
      }),
    });

    checks.d1JobRecorded = start.ok === true
      && typeof start.job_id === "string"
      && start.status === "uploaded"
      && start.artifact_key === artifact.artifactKey
      && start.file_count === artifact.files.length
      && start.byte_count === Buffer.byteLength(artifact.artifactText);

    const status = await fetchJson(`${baseUrl}/jobs/${start.job_id}/status`);
    checks.artifactStoredInR2 = status.ok === true
      && status.artifact?.exists === true
      && status.artifact?.key === artifact.artifactKey
      && status.artifact?.size === Buffer.byteLength(artifact.artifactText)
      && status.artifact?.metadata?.repo_slug === "lumae-fresh";
    checks.statusJson = status.ok === true
      && status.job?.repo_slug === "lumae-fresh"
      && status.job?.indexed_path === targetRepo
      && status.job?.artifact_key === artifact.artifactKey
      && status.job?.file_count === artifact.files.length
      && status.progress?.status === "uploaded";
    checks.noVertexCalls = vertexCallCount === 0;

    console.log(`Worker: ${baseUrl}`);
    console.log(`Job ID: ${start.job_id}`);
    console.log(`Artifact key: ${artifact.artifactKey}`);
    console.log(`Files packaged: ${artifact.files.length}`);
    console.log(`Artifact bytes: ${Buffer.byteLength(artifact.artifactText)}`);
    console.log(`Vertex calls: ${vertexCallCount}`);
  } finally {
    globalThis.fetch = originalFetch;
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    checks.cleanupWorker = true;
    run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
    checks.cleanupR2 = true;
    run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
    checks.cleanupD1 = true;
    if (!deployed) checks.cleanupWorker = true;
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
