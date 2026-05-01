#!/usr/bin/env node
/**
 * POC 27B: Stateful MCP server via McpAgent
 *
 * Proves: McpAgent on a Durable Object persists session state across MCP
 * tool calls. set_value("foo") then get_value() returns "foo" on the same
 * session (same Mcp-Session-Id).
 *
 * Uses streamable-http transport directly (no SDK client needed):
 *   - POST /mcp with `initialize` → server returns `Mcp-Session-Id` header
 *   - Subsequent POSTs include that header for session continuity
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/27b-mcp-stateful");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-27b-mcp-stateful";

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

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL in:\n${out}`); })();
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { const j = await r.json(); if (j.ok) return; } } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("worker not healthy");
}

// Minimal MCP streamable-http client
async function mcpCall(baseUrl, sessionId, body) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const newSession = res.headers.get("mcp-session-id");
  const text = await res.text();
  // Streamable HTTP response is either JSON or SSE (text/event-stream).
  let parsed;
  if (text.startsWith("event:") || text.startsWith("data:")) {
    // Find the data: line and parse it
    const dataLine = text.split("\n").find(l => l.startsWith("data:"));
    if (!dataLine) throw new Error(`no data in SSE response: ${text.slice(0, 200)}`);
    parsed = JSON.parse(dataLine.slice(5).trim());
  } else {
    try { parsed = JSON.parse(text); } catch { throw new Error(`non-JSON response ${res.status}: ${text.slice(0, 300)}`); }
  }
  return { sessionId: newSession || sessionId, status: res.status, body: parsed };
}

function cleanup() {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 27B: Stateful MCP server via McpAgent\n");
  const checks = {
    deployed: false,
    initializeReturnedSessionId: false,
    listToolsHasSetValueGetValue: false,
    setValueReturnsOk: false,
    getValueReturnsFoo: false,
    cleanedUp: false,
  };

  try {
    cleanup();

    console.log("--- Deploy worker ---");
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    console.log(`Worker: ${baseUrl}`);
    checks.deployed = !!baseUrl;
    await waitHealth(baseUrl);

    // Initialize: server should return Mcp-Session-Id header.
    console.log("\n--- mcp initialize ---");
    const init = await mcpCall(baseUrl, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "27b-smoke", version: "0.1" } },
    });
    console.log(`session=${init.sessionId} status=${init.status} server=${init.body?.result?.serverInfo?.name}`);
    checks.initializeReturnedSessionId = !!init.sessionId;
    const sessionId = init.sessionId;

    // Send the notifications/initialized notification (required after initialize)
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    console.log("\n--- tools/list ---");
    const list = await mcpCall(baseUrl, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolNames = (list.body?.result?.tools || []).map(t => t.name);
    console.log(`tools: ${JSON.stringify(toolNames)}`);
    checks.listToolsHasSetValueGetValue = toolNames.includes("set_value") && toolNames.includes("get_value");

    console.log("\n--- set_value('foo') ---");
    const set = await mcpCall(baseUrl, sessionId, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "set_value", arguments: { value: "foo" } },
    });
    const setText = set.body?.result?.content?.[0]?.text || "";
    console.log(`set: ${setText}`);
    checks.setValueReturnsOk = /value set to: foo/i.test(setText);

    console.log("\n--- get_value (same session) ---");
    const get = await mcpCall(baseUrl, sessionId, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "get_value", arguments: {} },
    });
    const getText = get.body?.result?.content?.[0]?.text || "";
    console.log(`get: ${getText}`);
    checks.getValueReturnsFoo = /current value: foo/i.test(getText);
  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27B: PASS" : "❌ POC 27B: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
