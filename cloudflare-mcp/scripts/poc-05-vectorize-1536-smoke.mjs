#!/usr/bin/env node
/**
 * POC 05: Vectorize 1536d Smoke
 *
 * Proves:
 *   A throwaway Vectorize index can be created, bound to a Worker, upserted,
 *   queried, and deleted for 1536-dimensional embeddings.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/05-vectorize-1536-smoke");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-05-vectorize-1536";
const indexName = "cfcode-poc-05-vectorize-1536";

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
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed ${response.status}: ${text.slice(0, 300)}`);
  }
  if (data && typeof data === "object" && "raw" in data) {
    throw new Error(`${init?.method || "GET"} ${url} returned non-JSON: ${String(data.raw).slice(0, 300)}`);
  }
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true && health.dimensions === 1536) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function queryUntilVisible(baseUrl) {
  const deadline = Date.now() + 60_000;
  let lastResult = null;
  while (Date.now() < deadline) {
    const query = await fetchJson(`${baseUrl}/query?seed=11`);
    lastResult = query;
    const first = query.result?.matches?.[0];
    if (query.ok === true && first?.id === "chunk-upload-handler" && first.score > 0.9) {
      return query;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Vectorize query did not return expected first match: ${JSON.stringify(lastResult)?.slice(0, 800)}`);
}

async function main() {
  console.log("POC 05: Vectorize 1536d Smoke\n");

  const checks = {
    indexCreate: false,
    install: false,
    typecheck: false,
    deploy: false,
    upsert: false,
    query: false,
    cleanupWorker: false,
    cleanupIndex: false,
  };

  let baseUrl = "";

  try {
    run("npx", [
      "wrangler",
      "vectorize",
      "create",
      indexName,
      "--dimensions=1536",
      "--metric=cosine",
    ]);
    checks.indexCreate = true;

    run("npm", ["install"]);
    checks.install = true;
    run("npm", ["run", "check"]);
    checks.typecheck = true;

    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const deployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    const match = deployOutput.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${deployOutput}`);
    baseUrl = match[0].replace(/\/$/, "");
    checks.deploy = true;
    console.log(`Deployed Vectorize Worker: ${baseUrl}`);
    await waitForHealth(baseUrl);

    const upsert = await fetchJson(`${baseUrl}/upsert`, { method: "POST" });
    checks.upsert = upsert.ok === true;

    const query = await queryUntilVisible(baseUrl);
    checks.query = query.ok === true && query.result?.matches?.[0]?.id === "chunk-upload-handler";
    console.log(`Top match: ${query.result.matches[0].id} score=${query.result.matches[0].score}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.deploy || message.includes("does not exist") || message.includes("This Worker does not exist") || message.includes("10090")) checks.cleanupWorker = true;
      else console.error(`Worker cleanup failed: ${message}`);
    }
    try {
      run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"]);
      checks.cleanupIndex = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not_found") || message.includes("code: 3000")) checks.cleanupIndex = true;
      else console.error(`Vectorize cleanup failed: ${message}`);
    }
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
