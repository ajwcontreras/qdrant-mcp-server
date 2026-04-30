#!/usr/bin/env node
/**
 * POC 01: Authless Worker MCP Hello
 *
 * Proves:
 *   A Cloudflare Worker can expose an unauthenticated remote MCP endpoint at
 *   /mcp with createMcpHandler, list tools, execute a tool, and then be deleted.
 *
 * Pass criteria:
 *   - dependencies install
 *   - TypeScript check passes
 *   - wrangler deploy returns a workers.dev URL
 *   - MCP client lists ping
 *   - ping returns pong
 *   - wrangler delete succeeds
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocDir = path.resolve(__dirname, "../poc/01-authless-mcp-worker");
const repoRoot = path.resolve(__dirname, "../..");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-01-authless-mcp";

function loadCloudflareEnv() {
  const env = { ...process.env };
  if (fs.existsSync(cfKeysPath)) {
    const lines = fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
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

async function listToolsAndPing(mcpUrl) {
  const { Client } = await import(
    pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href
  );
  const client = new Client({ name: "cfcode-poc-01-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = (tools.tools || []).map((tool) => tool.name);
    const ping = await client.callTool({ name: "ping", arguments: {} });
    const text = (ping.content || []).map((item) => item.text || "").join("\n");
    return { toolNames, text };
  } finally {
    await client.close();
  }
}

async function main() {
  console.log("POC 01: Authless Worker MCP Hello\n");

  const checks = {
    install: false,
    typecheck: false,
    deploy: false,
    listTools: false,
    ping: false,
    cleanup: false,
  };
  let mcpUrl = "";

  try {
    run("npm", ["install"]);
    checks.install = true;

    run("npm", ["run", "check"]);
    checks.typecheck = true;

    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const deployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    const match = deployOutput.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${deployOutput}`);
    mcpUrl = `${match[0].replace(/\/$/, "")}/mcp`;
    checks.deploy = true;
    console.log(`Deployed MCP URL: ${mcpUrl}`);

    const { toolNames, text } = await listToolsAndPing(mcpUrl);
    checks.listTools = toolNames.includes("ping");
    checks.ping = text.includes("pong");
    console.log(`Tools: ${toolNames.join(", ")}`);
    console.log(`ping: ${text}`);
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
      checks.cleanup = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not exist") || message.includes("code: 10090")) {
        checks.cleanup = true;
      } else {
        console.error(`Cleanup failed: ${message}`);
      }
    }
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }

  if (!Object.values(checks).every(Boolean)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
