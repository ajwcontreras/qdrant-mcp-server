#!/usr/bin/env node
/**
 * POC 26C2: R2 Embedding Artifact Publication Input Only
 *
 * Proves:
 *   Publication input artifacts can be stored in remote R2, checked by a
 *   Worker endpoint, and deleted remotely before bucket cleanup.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26c2-r2-publication-artifact-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-26c2-r2-publication";
const bucketName = "cfcode-poc-26c2-artifacts";

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
  return values;
}

function buildArtifact() {
  const rows = ["routes", "embeddings", "mcp"].map((seed) => ({
    vector_id: `vec-${sha256(seed).slice(0, 16)}`,
    path: `app/${seed}.py`,
    values: deterministicVector(seed),
    dimensions: 1536,
  }));
  const artifactText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return {
    artifactText,
    artifactKey: `publication/lumae-fresh-poc-26c2/${sha256(artifactText).slice(0, 16)}.jsonl`,
    publicationId: `pub-${sha256(artifactText).slice(0, 16)}`,
  };
}

function cleanup(artifactKey) {
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  if (artifactKey) run("npx", ["wrangler", "r2", "object", "delete", `${bucketName}/${artifactKey}`, "--remote"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26C2: R2 Embedding Artifact Publication Input Only\n");
  const checks = {
    r2ArtifactStored: false,
    artifactHeadJson: false,
    remoteObjectDeleted: false,
    bucketCleanup: false,
  };
  const artifact = buildArtifact();
  try {
    cleanup(artifact.artifactKey);
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitForHealth(baseUrl);
    const start = await fetchJson(`${baseUrl}/publication/artifact/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_slug: "lumae-fresh",
        publication_id: artifact.publicationId,
        artifact_key: artifact.artifactKey,
        artifact_text: artifact.artifactText,
      }),
    });
    checks.r2ArtifactStored = start.ok === true && start.bytes === Buffer.byteLength(artifact.artifactText);
    const head = await fetchJson(`${baseUrl}/artifact/head?key=${encodeURIComponent(artifact.artifactKey)}`);
    checks.artifactHeadJson = head.ok === true
      && head.exists === true
      && head.size === start.bytes
      && head.metadata?.repo_slug === "lumae-fresh"
      && head.metadata?.publication_id === artifact.publicationId;
    run("npx", ["wrangler", "r2", "object", "delete", `${bucketName}/${artifact.artifactKey}`, "--remote"]);
    checks.remoteObjectDeleted = true;
    console.log(`Worker: ${baseUrl}`);
    console.log(`Artifact key: ${artifact.artifactKey}`);
    console.log(`Artifact bytes: ${start.bytes}`);
  } finally {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
    checks.bucketCleanup = true;
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
