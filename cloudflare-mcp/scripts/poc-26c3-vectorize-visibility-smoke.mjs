#!/usr/bin/env node
/**
 * POC 26C3: Vectorize Visibility After Upsert
 *
 * Proves:
 *   Deterministic 1536-dimensional vectors upserted through a Worker become
 *   query-visible through Vectorize within a bounded polling window.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26c3-vectorize-visibility-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-26c3-vectorize";
const indexName = "cfcode-poc-26c3-vectorize";

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

async function waitForVector(baseUrl, values, expectedId) {
  const deadline = Date.now() + 90_000;
  let lastSearch;
  while (Date.now() < deadline) {
    lastSearch = await fetchJson(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, topK: 3 }),
    });
    if (lastSearch.ok === true && lastSearch.matches?.some((match) => match.id === expectedId)) return lastSearch;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Vectorize did not return ${expectedId}: ${JSON.stringify(lastSearch)?.slice(0, 800)}`);
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

function buildVectors() {
  return ["routes", "embeddings", "mcp"].map((seed) => ({
    id: `vec-${sha256(seed).slice(0, 16)}`,
    values: deterministicVector(seed),
    metadata: { seed, path: `app/${seed}.py`, publication_id: "pub-poc-26c3" },
  }));
}

function cleanup() {
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26C3: Vectorize Visibility After Upsert\n");
  const checks = {
    vectorizeCreated: false,
    workerUpsertedVectors: false,
    searchReturnedExpectedId: false,
    cleanupWorker: false,
    cleanupVectorize: false,
  };
  const vectors = buildVectors();
  try {
    cleanup();
    run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);
    checks.vectorizeCreated = true;
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitForHealth(baseUrl);
    const publish = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vectors }),
    });
    checks.workerUpsertedVectors = publish.ok === true && publish.vector_count === vectors.length;
    const search = await waitForVector(baseUrl, vectors[0].values, vectors[0].id);
    checks.searchReturnedExpectedId = search.matches.some((match) => match.id === vectors[0].id);
    console.log(`Worker: ${baseUrl}`);
    console.log(`Published vectors: ${publish.vector_count}`);
    console.log(`Search matches: ${search.matches.map((match) => match.id).join(", ")}`);
  } finally {
    run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
    checks.cleanupWorker = true;
    run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
    checks.cleanupVectorize = true;
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
