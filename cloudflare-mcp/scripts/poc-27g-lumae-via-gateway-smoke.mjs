#!/usr/bin/env node
/**
 * POC 27G: lumae searchable via gateway end-to-end
 *
 * Deploys the canonical per-codebase Worker as `cfcode-codebase-lumae-fresh`
 * into the `cfcode-codebases` dispatch namespace, sharing the existing
 * lumae R2/D1/Vectorize bindings. No queue consumer (to avoid conflict
 * with the standalone `cfcode-lumae-fresh` Worker). Registers lumae-fresh
 * in the gateway, then connects via MCP and proves search through the
 * gateway returns real lumae chunks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const codebaseDir = path.resolve(__dirname, "../workers/codebase");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";

const namespaceName = "cfcode-codebases";
const userWorkerName = "cfcode-codebase-lumae-fresh";
const gatewayUrl = "https://cfcode-gateway.frosty-butterfly-d821.workers.dev";
const slug = "lumae-fresh";

function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (fs.existsSync(cfKeysPath)) {
    for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...rest] = t.split("=");
      const v = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
      if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
      if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    }
  }
  return env;
}
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: opts.cwd || codebaseDir, env: opts.env || loadCfEnv(), encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", input: opts.input });
  if (result.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}
async function mcpCall(baseUrl, sessionId, body) {
  const headers = { "content-type": "application/json", "accept": "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const newSession = res.headers.get("mcp-session-id");
  const text = await res.text();
  let parsed;
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const dataLine = text.split("\n").find(l => l.startsWith("data:"));
    parsed = JSON.parse(dataLine.slice(5).trim());
  } else parsed = JSON.parse(text);
  return { sessionId: newSession || sessionId, status: res.status, body: parsed };
}
async function callTool(baseUrl, sessionId, name, args = {}) {
  const r = await mcpCall(baseUrl, sessionId, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });
  return r.body?.result?.content?.[0]?.text || "";
}

async function main() {
  console.log("POC 27G: lumae searchable via gateway end-to-end\n");
  const checks = {
    namespaceWorkerDeployed: false,
    secretSet: false,
    namespaceWorkerHasData: false,
    registeredInGateway: false,
    listCodebasesShowsLumae: false,
    selectLumaeOk: false,
    searchReturnsRealLumaeChunks: false,
  };

  // 1. Deploy canonical worker into the namespace
  console.log("--- Deploy canonical worker into cfcode-codebases namespace ---");
  const dep = run("npx", ["wrangler", "deploy", "--config", "wrangler.lumae-namespace.jsonc", "--dispatch-namespace", namespaceName], { capture: true });
  checks.namespaceWorkerDeployed = /Uploaded/i.test(`${dep.stdout}\n${dep.stderr}`);
  console.log(`namespaceWorkerDeployed: ${checks.namespaceWorkerDeployed ? "PASS" : "FAIL"}`);

  // 2. Set Vertex SA secret on the namespace worker via multipart upload API
  // (wrangler secret put doesn't support --dispatch-namespace).
  if (!fs.existsSync(saPath)) throw new Error(`Vertex SA not found at ${saPath}`);
  const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
  const { setNamespaceWorkerSecret } = await import(path.resolve(__dirname, "../lib/wfp-secret.mjs"));
  const secResult = await setNamespaceWorkerSecret({
    namespaceName, scriptName: userWorkerName,
    secretName: "GEMINI_SERVICE_ACCOUNT_B64", secretValue: saB64,
  });
  checks.secretSet = secResult?.success === true;
  console.log(`secretSet: ${checks.secretSet ? "PASS" : "FAIL"}`);

  // 3. Sanity check: namespace worker can serve traffic via dispatch — call it through gateway with no slug bound,
  //    we'll verify by registering and searching below.

  // 4. Register lumae in gateway
  console.log("\n--- Register lumae-fresh in gateway ---");
  const reg = await fetchJson(`${gatewayUrl}/admin/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, indexed_path: "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" }),
  });
  console.log(JSON.stringify(reg.body));
  checks.registeredInGateway = reg.status === 200 && reg.body?.ok === true;

  // 5. MCP init + initialized notification
  console.log("\n--- MCP initialize against gateway ---");
  const init = await mcpCall(gatewayUrl, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "27g-smoke", version: "0.1" } },
  });
  const sid = init.sessionId;
  await fetch(`${gatewayUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  console.log(`session=${sid}`);

  // 6. list_codebases
  console.log("\n--- list_codebases ---");
  const list = await callTool(gatewayUrl, sid, "list_codebases");
  console.log(list);
  checks.listCodebasesShowsLumae = list.includes("lumae-fresh");

  // 7. select_codebase("lumae-fresh")
  console.log("\n--- select_codebase('lumae-fresh') ---");
  const sel = await callTool(gatewayUrl, sid, "select_codebase", { slug });
  console.log(sel);
  checks.selectLumaeOk = /selected: lumae-fresh/i.test(sel);

  // 8. search through gateway — must return real lumae chunks
  console.log("\n--- search('flask routes chat') ---");
  const search = await callTool(gatewayUrl, sid, "search", { query: "flask routes chat", topK: 5 });
  console.log(search);
  // Real lumae has many chunks under chat_history.py, app.py, etc. — accept any plausible py file.
  checks.namespaceWorkerHasData = /\.py/i.test(search);
  checks.searchReturnsRealLumaeChunks = /match\(es\) in lumae-fresh/i.test(search) && /\.py/.test(search);

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27G: PASS" : "❌ POC 27G: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
