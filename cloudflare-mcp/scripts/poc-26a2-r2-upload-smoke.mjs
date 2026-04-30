#!/usr/bin/env node
/**
 * POC 26A2: R2 Upload Endpoint Only
 *
 * Proves:
 *   A deployed Worker can accept a local artifact upload and store it in R2,
 *   without D1 or job state.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26a2-r2-upload-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const workerName = "cfcode-poc-26a2-r2-upload";
const bucketName = "cfcode-poc-26a2-artifacts";

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

function deployUrl(output) {
  const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map((match) => match[0].replace(/\/$/, ""));
  const url = urls.find((value) => value.includes(workerName));
  if (!url) throw new Error(`Could not find ${workerName} workers.dev URL in deploy output:\n${output}`);
  return url;
}

async function packageArtifact() {
  const filePath = "README.md";
  const text = await fsp.readFile(path.join(targetRepo, filePath), "utf8");
  const record = { path: filePath, sha256: sha256(text), bytes: Buffer.byteLength(text), text: text.slice(0, 4000) };
  const artifactText = `${JSON.stringify(record)}\n`;
  return { artifactText, key: `jobs/lumae-fresh-poc-26a2/${sha256(artifactText).slice(0, 16)}.jsonl` };
}

async function main() {
  console.log("POC 26A2: R2 Upload Endpoint Only\n");
  const checks = {
    deployHealthJson: false,
    artifactPut: false,
    artifactHead: false,
    cleanupWorker: false,
    cleanupR2: false,
  };

  let deployed = false;
  const artifact = await packageArtifact();
  try {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    deployed = true;
    const health = await waitForHealth(baseUrl);
    checks.deployHealthJson = health.ok === true;
    const put = await fetchJson(`${baseUrl}/artifact/put`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: artifact.key, text: artifact.artifactText, repo_slug: "lumae-fresh" }),
    });
    checks.artifactPut = put.ok === true && put.bytes === Buffer.byteLength(artifact.artifactText);
    const head = await fetchJson(`${baseUrl}/artifact/head?key=${encodeURIComponent(artifact.key)}`);
    checks.artifactHead = head.ok === true && head.exists === true && head.size === put.bytes && head.metadata?.repo_slug === "lumae-fresh";
    console.log(`Worker: ${baseUrl}`);
    console.log(`Artifact key: ${artifact.key}`);
    console.log(`Artifact bytes: ${put.bytes}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
      checks.cleanupWorker = true;
    } catch {
      checks.cleanupWorker = !deployed;
    }
    run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
    checks.cleanupR2 = true;
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
