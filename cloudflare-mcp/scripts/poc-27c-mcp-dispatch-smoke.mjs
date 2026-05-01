#!/usr/bin/env node
/**
 * POC 27C: McpAgent gateway proxies into dispatch namespace
 *
 * Proves: A stateful MCP gateway can route a tool call to a user Worker
 * deployed in a dispatch namespace, using session-bound state to remember
 * which codebase was selected.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/27c-mcp-dispatch");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");

const namespaceName = "cfcode-poc-27c-codebases";
const userWorkerName = "cfcode-poc-27c-user-alpha";
const gatewayName = "cfcode-poc-27c-gateway";

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
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(),
    encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !opts.allowFailure) {
    const out = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${cmd} ${args.join(" ")} failed${out ? `:\n${out}` : ""}`);
  }
  return result;
}

function deployUrl(out, name) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(name)) || (() => { throw new Error(`no URL for ${name} in:\n${out}`); })();
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { const j = await r.json(); if (j.ok) return; } } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("gateway not healthy");
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
    if (!dataLine) throw new Error(`no data in SSE response: ${text.slice(0, 300)}`);
    parsed = JSON.parse(dataLine.slice(5).trim());
  } else {
    try { parsed = JSON.parse(text); } catch { throw new Error(`non-JSON ${res.status}: ${text.slice(0, 300)}`); }
  }
  return { sessionId: newSession || sessionId, status: res.status, body: parsed };
}

async function callTool(baseUrl, sessionId, name, args = {}) {
  const r = await mcpCall(baseUrl, sessionId, {
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args },
  });
  return r.body?.result?.content?.[0]?.text || "";
}

function cleanup() {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", gatewayName, "--force"], { allowFailure: true, capture: true, cwd: path.join(pocDir, "gateway") });
  run("npx", ["wrangler", "delete", "--name", userWorkerName, "--dispatch-namespace", namespaceName, "--force"], { allowFailure: true, capture: true, cwd: path.join(pocDir, "user") });
  run("npx", ["wrangler", "dispatch-namespace", "delete", namespaceName], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 27C: McpAgent gateway proxies into dispatch namespace\n");
  const checks = {
    namespaceCreated: false,
    userDeployed: false,
    gatewayDeployed: false,
    initOk: false,
    proxyWithoutSelectErrors: false,
    selectCodebaseOk: false,
    proxyCallSucceeds: false,
    cleanedUp: false,
  };

  try {
    cleanup();

    console.log("--- Setup resources ---");
    const ns = run("npx", ["wrangler", "dispatch-namespace", "create", namespaceName], { capture: true });
    checks.namespaceCreated = /created|already exists/i.test(`${ns.stdout}\n${ns.stderr}`);
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const u = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc", "--dispatch-namespace", namespaceName], { cwd: path.join(pocDir, "user"), capture: true });
    checks.userDeployed = /Uploaded/i.test(`${u.stdout}\n${u.stderr}`);

    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc"], { cwd: path.join(pocDir, "gateway"), capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`, gatewayName);
    checks.gatewayDeployed = !!baseUrl;
    console.log(`Gateway: ${baseUrl}`);
    await waitHealth(baseUrl);

    console.log("\n--- mcp initialize ---");
    const init = await mcpCall(baseUrl, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "27c-smoke", version: "0.1" } },
    });
    checks.initOk = init.status === 200 && !!init.sessionId;
    const sessionId = init.sessionId;
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    console.log(`session=${sessionId}`);

    console.log("\n--- proxy_call without select_codebase (should error) ---");
    const noSel = await callTool(baseUrl, sessionId, "proxy_call", { method: "GET", path: "/" });
    console.log(`-> ${noSel}`);
    checks.proxyWithoutSelectErrors = /no codebase selected/i.test(noSel);

    console.log("\n--- select_codebase('alpha') ---");
    const sel = await callTool(baseUrl, sessionId, "select_codebase", { slug: "alpha" });
    console.log(`-> ${sel}`);
    checks.selectCodebaseOk = /selected codebase: alpha/i.test(sel);

    console.log("\n--- proxy_call POST /echo {hello:'world'} ---");
    const proxy = await callTool(baseUrl, sessionId, "proxy_call", { method: "POST", path: "/echo", body: { hello: "world" } });
    console.log(`-> ${proxy}`);
    checks.proxyCallSucceeds = /200:.*"slug":"alpha".*"echoed":\{"hello":"world"\}/.test(proxy);

  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27C: PASS" : "❌ POC 27C: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
