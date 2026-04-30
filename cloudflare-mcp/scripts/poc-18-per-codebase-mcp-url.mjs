#!/usr/bin/env node
/**
 * POC 18: Per-Codebase MCP URL
 *
 * Proves:
 *   A single codebase can have an unauthenticated MCP URL whose
 *   collection_info identifies the repo and active publication.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/18-per-codebase-mcp-url-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-18-lumae-fresh-mcp";

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

async function callCollectionInfo(mcpUrl) {
  const { Client } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href);
  const client = new Client({ name: "cfcode-poc-18-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const response = await client.callTool({ name: "collection_info", arguments: {} });
    const text = (response.content || []).map((item) => item.text || "").join("\n");
    return { toolNames: (tools.tools || []).map((tool) => tool.name), info: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

async function main() {
  console.log("POC 18: Per-Codebase MCP URL\n");
  const checks = { install: false, typecheck: false, deploy: false, listTools: false, collectionInfo: false, cleanup: false };
  let mcpUrl = "";
  try {
    run("npm", ["install"]);
    checks.install = true;
    run("npm", ["run", "check"]);
    checks.typecheck = true;
    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const output = `${deploy.stdout}\n${deploy.stderr}`;
    const match = output.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${output}`);
    mcpUrl = `${match[0].replace(/\/$/, "")}/mcp`;
    checks.deploy = true;
    const { toolNames, info } = await callCollectionInfo(mcpUrl);
    checks.listTools = toolNames.includes("collection_info");
    checks.collectionInfo = info.repo_slug === "lumae-fresh"
      && info.active_publication_id === "pub-19e2c2bf4fdc8521e63af051f55d75a8"
      && info.vectorize_index === "cfcode-lumae-hyde-1536-redo-b"
      && info.auth === "none";
    console.log(`MCP URL: ${mcpUrl}`);
    console.log(`collection_info: ${JSON.stringify(info)}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
      checks.cleanup = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!checks.deploy || message.includes("does not exist") || message.includes("10090")) checks.cleanup = true;
      else console.error(`Cleanup failed: ${message}`);
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
