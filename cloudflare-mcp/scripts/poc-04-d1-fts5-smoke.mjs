#!/usr/bin/env node
/**
 * POC 04: D1 FTS5 Smoke
 *
 * Proves:
 *   D1 FTS5 can provide lexical/symbol candidates for code chunks.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/04-d1-fts5-smoke");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-04-d1-fts5";
const dbName = "cfcode-poc-04-d1-fts5";
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");

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

function extractDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuid) throw new Error(`Could not find D1 database UUID in output:\n${output}`);
  return uuid[0];
}

function writeGeneratedConfig(databaseId) {
  const template = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  fs.writeFileSync(generatedConfig, template.replace("__DATABASE_ID__", databaseId), "utf8");
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
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function main() {
  console.log("POC 04: D1 FTS5 Smoke\n");

  const checks = {
    dbCreate: false,
    configGenerated: false,
    install: false,
    typecheck: false,
    deploy: false,
    seed: false,
    symbolSearch: false,
    bodySearch: false,
    cleanupWorker: false,
    cleanupDb: false,
  };

  let baseUrl = "";

  try {
    const create = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    const databaseId = extractDatabaseId(`${create.stdout}\n${create.stderr}`);
    checks.dbCreate = true;
    writeGeneratedConfig(databaseId);
    checks.configGenerated = fs.existsSync(generatedConfig);

    run("npm", ["install"]);
    checks.install = true;
    run("npm", ["run", "check"]);
    checks.typecheck = true;

    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const deployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    const match = deployOutput.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${deployOutput}`);
    baseUrl = match[0].replace(/\/$/, "");
    checks.deploy = true;
    console.log(`Deployed FTS Worker: ${baseUrl}`);
    await waitForHealth(baseUrl);

    const seed = await fetchJson(`${baseUrl}/seed`, { method: "POST" });
    checks.seed = seed.ok === true;

    const symbol = await fetchJson(`${baseUrl}/search?q=${encodeURIComponent("handle_upload borrower_file")}`);
    checks.symbolSearch = symbol.ok === true && symbol.rows?.[0]?.chunk_identity === "upload-handler";

    const body = await fetchJson(`${baseUrl}/search?q=${encodeURIComponent("mortgage FRED rates")}`);
    checks.bodySearch = body.ok === true && body.rows?.[0]?.chunk_identity === "market-rates";
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--config", "wrangler.generated.jsonc", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not exist") || message.includes("code: 10090")) checks.cleanupWorker = true;
      else console.error(`Worker cleanup failed: ${message}`);
    }
    try {
      run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"]);
      checks.cleanupDb = true;
    } catch (error) {
      console.error(`D1 cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
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
