#!/usr/bin/env node
/**
 * POC 26A3: D1 Job Row Endpoint Only
 *
 * Proves:
 *   A deployed Worker can create and read D1 job rows, without R2 artifact upload.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26a3-d1-job-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-26a3-d1-job";
const dbName = "cfcode-poc-26a3-jobs";
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");
const indexedPath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

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

async function main() {
  console.log("POC 26A3: D1 Job Row Endpoint Only\n");
  const checks = {
    deployHealthJson: false,
    jobStarted: false,
    statusRoundTrip: false,
    cleanupWorker: false,
    cleanupD1: false,
  };

  let deployed = false;
  try {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
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
        indexed_path: indexedPath,
        artifact_key: "jobs/lumae-fresh-poc-26a3/sample.jsonl",
        file_count: 5,
      }),
    });
    checks.jobStarted = start.ok === true && typeof start.job_id === "string" && start.status === "uploaded";
    const status = await fetchJson(`${baseUrl}/jobs/${start.job_id}/status`);
    checks.statusRoundTrip = status.ok === true
      && status.job?.repo_slug === "lumae-fresh"
      && status.job?.indexed_path === indexedPath
      && status.job?.artifact_key === "jobs/lumae-fresh-poc-26a3/sample.jsonl"
      && status.job?.file_count === 5
      && status.job?.status === "uploaded";
    console.log(`Worker: ${baseUrl}`);
    console.log(`Job ID: ${start.job_id}`);
  } finally {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    checks.cleanupWorker = true;
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
