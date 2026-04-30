#!/usr/bin/env node
/**
 * POC 14: Multi-Channel Search
 *
 * Proves:
 *   Separate code and HyDE Vectorize indexes can be searched and merged by
 *   chunk identity through an authless MCP Worker.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/14-multi-channel-search-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-14-multi-channel-search";
const codeIndexName = "cfcode-poc-14-code";
const hydeIndexName = "cfcode-poc-14-hyde";
const dbName = "cfcode-poc-14-multi-channel-search";
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

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
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
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${url} failed ${response.status}: ${text.slice(0, 500)}`);
  if (data && typeof data === "object" && "raw" in data) throw new Error(`${init?.method || "GET"} ${url} returned non-JSON`);
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
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

async function callSearch(mcpUrl) {
  const { Client } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href);
  const client = new Client({ name: "cfcode-poc-14-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const response = await client.callTool({ name: "search", arguments: { query: "borrower upload document handler" } });
    const text = (response.content || []).map((item) => item.text || "").join("\n");
    return { toolNames: (tools.tools || []).map((tool) => tool.name), payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

async function searchUntilVisible(mcpUrl) {
  const deadline = Date.now() + 60_000;
  let lastPayload = null;
  while (Date.now() < deadline) {
    const result = await callSearch(mcpUrl);
    lastPayload = result.payload;
    const first = result.payload.results?.[0];
    if (first?.chunk_identity === "chunk-upload-handler" && first.channels?.includes("code") && first.channels?.includes("hyde")) return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`MCP search did not return merged multi-channel result: ${JSON.stringify(lastPayload)?.slice(0, 800)}`);
}

async function main() {
  console.log("POC 14: Multi-Channel Search\n");
  const checks = {
    codeIndexCreate: false,
    hydeIndexCreate: false,
    dbCreate: false,
    configGenerated: false,
    install: false,
    typecheck: false,
    deploy: false,
    seed: false,
    listTools: false,
    multiChannelHit: false,
    dedupe: false,
    cleanupWorker: false,
    cleanupCodeIndex: false,
    cleanupHydeIndex: false,
    cleanupDb: false,
  };
  let baseUrl = "";
  try {
    run("npx", ["wrangler", "vectorize", "create", codeIndexName, "--dimensions=1536", "--metric=cosine"]);
    checks.codeIndexCreate = true;
    run("npx", ["wrangler", "vectorize", "create", hydeIndexName, "--dimensions=1536", "--metric=cosine"]);
    checks.hydeIndexCreate = true;
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    const databaseId = extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`);
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
    await waitForHealth(baseUrl);
    const seed = await fetchJson(`${baseUrl}/seed`, { method: "POST" });
    checks.seed = seed.ok === true;
    const { toolNames, payload } = await searchUntilVisible(`${baseUrl}/mcp`);
    checks.listTools = toolNames.includes("search");
    const first = payload.results?.[0];
    checks.multiChannelHit = first?.channels?.includes("code") && first?.channels?.includes("hyde");
    checks.dedupe = payload.results.filter((result) => result.chunk_identity === "chunk-upload-handler").length === 1;
    console.log(`Top result: ${first?.chunk_identity} channels=${first?.channels?.join(",")} score=${first?.score}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--config", "wrangler.generated.jsonc", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.deploy || message.includes("does not exist") || message.includes("10090")) checks.cleanupWorker = true;
      else console.error(`Worker cleanup failed: ${message}`);
    }
    for (const [name, indexName] of [["cleanupCodeIndex", codeIndexName], ["cleanupHydeIndex", hydeIndexName]]) {
      try {
        run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"]);
        checks[name] = true;
      } catch (error) {
        const message = stripAnsi(error instanceof Error ? error.message : String(error));
        if (message.includes("not_found") || message.includes("3000")) checks[name] = true;
        else console.error(`Vectorize cleanup failed: ${message}`);
      }
    }
    try {
      run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"]);
      checks.cleanupDb = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.dbCreate || message.includes("not found")) checks.cleanupDb = true;
      else console.error(`D1 cleanup failed: ${message}`);
    }
  }
  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
