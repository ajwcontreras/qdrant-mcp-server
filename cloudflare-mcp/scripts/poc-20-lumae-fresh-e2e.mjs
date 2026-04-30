#!/usr/bin/env node
/**
 * POC 20: Lumae Fresh End-to-End
 *
 * Proves:
 *   lumae-fresh has a public authless Cloudflare MCP URL, generated docs, and
 *   an incremental/resumable indexing entrypoint.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/20-lumae-fresh-mcp-worker");
const sessionDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-20");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-lumae-fresh";
const indexName = "cfcode-lumae-fresh-hyde-1536";
const dbName = "cfcode-lumae-fresh";
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

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Worker did not become healthy");
}

async function mcpCall(mcpUrl, name, args = {}) {
  const { Client } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(pocDir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href);
  const client = new Client({ name: "cfcode-poc-20-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content || []).map((item) => item.text || "").join("\n");
    return { toolNames: (tools.tools || []).map((tool) => tool.name), payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

async function writeDocs(mcpUrl) {
  await fsp.mkdir(sessionDir, { recursive: true });
  const doc = `# lumae-fresh MCP Code Search

Indexed path: \`/Users/awilliamspcsevents/PROJECTS/lumae-fresh\`

MCP URL: \`${mcpUrl}\`

\`\`\`bash
claude mcp add --transport http lumae-fresh-code ${mcpUrl} -s user
\`\`\`

\`\`\`json
{"mcpServers":{"lumae-fresh-code":{"url":"${mcpUrl}"}}}
\`\`\`

Incremental resumable reindex:

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" --repo-slug lumae-fresh --mode incremental --diff-base origin/main --resume
\`\`\`
`;
  const docPath = path.join(sessionDir, "lumae-fresh-MCP.md");
  await fsp.writeFile(docPath, doc, "utf8");
  return { doc, docPath };
}

async function searchUntil(mcpUrl) {
  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    const result = await mcpCall(mcpUrl, "search", { query: "borrower upload document handler" });
    last = result;
    if (result.payload.results?.[0]?.file_path === "app.py") return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Search did not return app.py: ${JSON.stringify(last)?.slice(0, 800)}`);
}

async function main() {
  console.log("POC 20: Lumae Fresh End-to-End\n");
  const checks = {
    incrementalPlan: false,
    resourcesCreated: false,
    deploy: false,
    seed: false,
    toolsListed: false,
    search: false,
    collectionInfo: false,
    docs: false,
  };

  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });

  const plan = run("node", [
    "cloudflare-mcp/scripts/index-codebase.mjs",
    "--repo", "/Users/awilliamspcsevents/PROJECTS/lumae-fresh",
    "--repo-slug", "lumae-fresh",
    "--mode", "incremental",
    "--diff-base", "HEAD",
    "--resume",
    "--dry-run",
  ], { cwd: repoRoot, capture: true });
  const planJson = JSON.parse(plan.stdout);
  checks.incrementalPlan = planJson.mode === "incremental" && planJson.resume === true && Array.isArray(planJson.files_to_index);

  run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);
  const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
  writeGeneratedConfig(extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`));
  checks.resourcesCreated = true;
  run("npm", ["install"]);
  run("npm", ["run", "check"]);
  const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
  const match = `${deploy.stdout}\n${deploy.stderr}`.match(/https:\/\/[^\s]+workers\.dev/);
  if (!match) throw new Error("Missing deploy URL");
  const baseUrl = match[0].replace(/\/$/, "");
  const mcpUrl = `${baseUrl}/mcp`;
  checks.deploy = true;
  await waitForHealth(baseUrl);
  const seed = await fetchJson(`${baseUrl}/seed`, { method: "POST" });
  checks.seed = seed.ok === true;

  const search = await searchUntil(mcpUrl);
  checks.toolsListed = ["search", "collection_info", "get_chunk", "suggest_queries"].every((tool) => search.toolNames.includes(tool));
  const first = search.payload.results?.[0];
  checks.search = first?.file_path === "app.py" && first.snippet?.includes("borrower files") && Number.isFinite(first.score);
  const info = await mcpCall(mcpUrl, "collection_info");
  checks.collectionInfo = info.payload.backend === "cloudflare" && info.payload.repo_slug === "lumae-fresh" && info.payload.active_embedding_run_id === "19e2c2bf4fdc8521e63af051f55d75a8";
  const { doc, docPath } = await writeDocs(mcpUrl);
  checks.docs = doc.includes(mcpUrl) && doc.includes("--mode incremental") && doc.includes("--resume") && doc.includes("/Users/awilliamspcsevents/PROJECTS/lumae-fresh");

  console.log(`MCP URL: ${mcpUrl}`);
  console.log(`Docs: ${docPath}`);
  console.log(`Top result: ${first.file_path}:${first.start_line}-${first.end_line}`);
  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
