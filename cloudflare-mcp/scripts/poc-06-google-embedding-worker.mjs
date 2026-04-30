#!/usr/bin/env node
/**
 * POC 06: Google Embedding Worker Binding
 *
 * Proves:
 *   A Cloudflare Worker can mint a Google access token from a service account
 *   secret and call Vertex embeddings for a Vectorize-compatible 1536d vector.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/06-google-embedding-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/Users/awilliamspcsevents/Downloads/team (1).json";
const workerName = "cfcode-poc-06-google-embedding";

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
    throw new Error(`${init?.method || "GET"} ${url} failed ${response.status}: ${text.slice(0, 500)}`);
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
      if (health.ok === true && health.dimensions === 1536) return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function main() {
  console.log("POC 06: Google Embedding Worker Binding\n");

  const checks = {
    serviceAccountPresent: false,
    install: false,
    typecheck: false,
    deploy: false,
    secretPut: false,
    health: false,
    embed: false,
    cleanupWorker: false,
  };

  let baseUrl = "";

  try {
    const serviceAccountJson = fs.readFileSync(serviceAccountPath, "utf8");
    const parsed = JSON.parse(serviceAccountJson);
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error(`Service account missing client_email/private_key/project_id: ${serviceAccountPath}`);
    }
    checks.serviceAccountPresent = true;

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

    const secretValue = Buffer.from(serviceAccountJson, "utf8").toString("base64");
    run("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64"], {
      input: `${secretValue}\n`,
      capture: true,
    });
    checks.secretPut = true;

    const health = await waitForHealth(baseUrl);
    checks.health = health.ok === true;

    const embed = await fetchJson(`${baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Find code that embeds a search query for a Cloudflare MCP code search Worker." }),
    });
    checks.embed = embed.ok === true
      && embed.length === 1536
      && Array.isArray(embed.sample)
      && embed.sample.length === 5
      && Number.isFinite(embed.norm)
      && embed.norm > 0;
    console.log(`Embedding length=${embed.length} norm=${embed.norm}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.deploy || message.includes("does not exist") || message.includes("This Worker does not exist") || message.includes("10090")) checks.cleanupWorker = true;
      else console.error(`Worker cleanup failed: ${message}`);
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
