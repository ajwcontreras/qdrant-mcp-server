#!/usr/bin/env node
/**
 * POC 27D: list_codebases reads D1 registry
 *
 * Proves: Gateway maintains a D1 registry; register/list/unregister tools work.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/27d-registry");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");

const workerName = "cfcode-poc-27d-registry";
const dbName = "cfcode-poc-27d-registry";

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

function ensureD1(name) {
  const create = run("npx", ["wrangler", "d1", "create", name], { capture: true, allowFailure: true });
  const out = `${create.stdout}\n${create.stderr}`;
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const dbs = JSON.parse(list.stdout || "[]");
  const found = dbs.find(d => d.name === name);
  if (!found) throw new Error(`Could not find D1 ${name}: ${out}`);
  return found.uuid;
}

function writeConfig(d1Id) {
  const tpl = fs.readFileSync(path.join(pocDir, "gateway/wrangler.template.jsonc"), "utf8");
  const filled = tpl.replace("__D1_ID__", d1Id);
  fs.writeFileSync(path.join(pocDir, "gateway/wrangler.generated.jsonc"), filled, "utf8");
}

function deployUrl(out, name) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(name)) || (() => { throw new Error(`no URL for ${name}: ${out}`); })();
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { const j = await r.json(); if (j.ok) return; } } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("not healthy");
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
    if (!dataLine) throw new Error(`no data: ${text.slice(0, 200)}`);
    parsed = JSON.parse(dataLine.slice(5).trim());
  } else {
    parsed = JSON.parse(text);
  }
  return { sessionId: newSession || sessionId, status: res.status, body: parsed };
}
async function callTool(baseUrl, sessionId, name, args = {}) {
  const r = await mcpCall(baseUrl, sessionId, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });
  return r.body?.result?.content?.[0]?.text || "";
}

function cleanup() {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true, cwd: path.join(pocDir, "gateway") });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 27D: list_codebases reads D1 registry\n");
  const checks = {
    deployed: false, initOk: false, registerOk: false,
    listShowsBoth: false, unregisterOk: false, listShowsOne: false, cleanedUp: false,
  };

  try {
    cleanup();

    console.log("--- Setup ---");
    const d1Id = ensureD1(dbName);
    writeConfig(d1Id);
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { cwd: path.join(pocDir, "gateway"), capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`, workerName);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);
    await waitHealth(baseUrl);

    const init = await mcpCall(baseUrl, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "27d", version: "0.1" } },
    });
    checks.initOk = !!init.sessionId;
    const sid = init.sessionId;
    await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

    console.log("\n--- register two codebases ---");
    const r1 = await callTool(baseUrl, sid, "register_codebase", { slug: "alpha", indexed_path: "/Users/me/alpha" });
    const r2 = await callTool(baseUrl, sid, "register_codebase", { slug: "beta",  indexed_path: "/Users/me/beta" });
    console.log(`r1=${r1}\nr2=${r2}`);
    checks.registerOk = /registered: alpha/.test(r1) && /registered: beta/.test(r2);

    console.log("\n--- list_codebases ---");
    const l1 = await callTool(baseUrl, sid, "list_codebases");
    console.log(l1);
    checks.listShowsBoth = /alpha/.test(l1) && /beta/.test(l1);

    console.log("\n--- unregister beta ---");
    const u = await callTool(baseUrl, sid, "unregister_codebase", { slug: "beta" });
    console.log(u);
    checks.unregisterOk = /unregistered: beta/.test(u);

    console.log("\n--- list_codebases again ---");
    const l2 = await callTool(baseUrl, sid, "list_codebases");
    console.log(l2);
    checks.listShowsOne = /alpha/.test(l2) && !/beta/.test(l2);
  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27D: PASS" : "❌ POC 27D: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
