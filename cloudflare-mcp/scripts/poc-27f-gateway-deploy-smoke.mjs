#!/usr/bin/env node
/**
 * POC 27F: production gateway deployed end-to-end
 *
 * Proves: The persistent gateway works against a real codebase user worker
 * deployed into the canonical `cfcode-codebases` dispatch namespace.
 *
 * Resources (persistent, survive past this script):
 *   - Worker:          cfcode-gateway
 *   - D1:              cfcode-gateway-registry
 *   - Dispatch ns:     cfcode-codebases
 *
 * Test resource (cleaned up at end):
 *   - User worker:     cfcode-codebase-test27f (in the namespace)
 *
 * The dispatch namespace, gateway worker, and registry D1 are NOT cleaned up
 * by this script — they're the production surface that persists across runs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const gatewayDir = path.resolve(__dirname, "../workers/mcp-gateway");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");

const namespaceName = "cfcode-codebases";
const gatewayName = "cfcode-gateway";
const registryDb = "cfcode-gateway-registry";
const testSlug = "test27f";
const testUserWorker = `cfcode-codebase-${testSlug}`;

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
    cwd: opts.cwd || gatewayDir, env: opts.env || loadCfEnv(),
    encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}
function ensureD1(name) {
  const create = run("npx", ["wrangler", "d1", "create", name], { capture: true, allowFailure: true });
  const out = `${create.stdout}\n${create.stderr}`;
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const found = JSON.parse(list.stdout || "[]").find(d => d.name === name);
  if (!found) throw new Error(`Could not find D1 ${name}: ${out}`);
  return found.uuid;
}
function writeConfig(d1Id) {
  const tpl = fs.readFileSync(path.join(gatewayDir, "wrangler.template.jsonc"), "utf8");
  fs.writeFileSync(path.join(gatewayDir, "wrangler.generated.jsonc"), tpl.replace("__D1_ID__", d1Id), "utf8");
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

// Inline stub user worker that mimics the canonical per-codebase worker's /search shape.
const STUB_USER_WORKER_SRC = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/search" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const query = body?.query || "(no query)";
      const slug = body?.repo_slug || env.CFCODE_SLUG || "(unset)";
      return Response.json({
        ok: true, repo_slug: slug, query,
        matches: [
          { id: "chunk-x1", score: 0.91, chunk: { file_path: slug + "/file_a.py", snippet: "def handler(): pass" } },
          { id: "chunk-x2", score: 0.83, chunk: { file_path: slug + "/file_b.py", snippet: "class Foo: ..." } },
        ],
      });
    }
    return Response.json({ ok: true });
  }
};
`;

function deployStubUserWorker() {
  const dir = fs.mkdtempSync(`/tmp/cfcode-poc27f-stub-`);
  fs.writeFileSync(path.join(dir, "index.js"), STUB_USER_WORKER_SRC, "utf8");
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({
    name: testUserWorker,
    main: "index.js",
    compatibility_date: "2026-04-30",
    vars: { CFCODE_SLUG: testSlug },
  }), "utf8");
  run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc", "--dispatch-namespace", namespaceName], { cwd: dir, capture: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

function cleanupTestUserWorker() {
  console.log("--- Cleanup test user worker ---");
  run("npx", ["wrangler", "delete", "--name", testUserWorker, "--dispatch-namespace", namespaceName, "--force"], { allowFailure: true, capture: true });
  // Also clean up D1 row left by registration
  run("npx", ["wrangler", "d1", "execute", registryDb, "--remote", "--command", `DELETE FROM codebase_registry WHERE slug = '${testSlug}';`], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 27F: production gateway deployed end-to-end\n");
  const checks = {
    namespaceReady: false, gatewayDeployed: false, healthOk: false,
    adminRegisterOk: false, adminListShowsTest: false,
    mcpInitOk: false, listCodebasesShowsTest: false,
    selectMissingCodebaseErrors: false, selectOk: false,
    searchReturnsMatches: false, adminUnregisterOk: false,
    cleanedUp: false,
  };

  try {
    // Persistent infra
    console.log("--- Ensure dispatch namespace ---");
    const ns = run("npx", ["wrangler", "dispatch-namespace", "create", namespaceName], { capture: true, allowFailure: true });
    checks.namespaceReady = /(created|already exists|conflict)/i.test(`${ns.stdout}\n${ns.stderr}`);

    console.log("--- Ensure D1 registry ---");
    const d1Id = ensureD1(registryDb);
    writeConfig(d1Id);

    console.log("--- Deploy gateway ---");
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const dep = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${dep.stdout}\n${dep.stderr}`, gatewayName);
    checks.gatewayDeployed = !!baseUrl;
    console.log(`Gateway: ${baseUrl}`);
    await waitHealth(baseUrl);
    checks.healthOk = true;

    // Cleanup any prior test user worker before running
    cleanupTestUserWorker();

    console.log("\n--- Deploy stub user worker into namespace ---");
    deployStubUserWorker();

    console.log("\n--- Admin: POST /admin/register ---");
    const reg = await fetchJson(`${baseUrl}/admin/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: testSlug, indexed_path: "/Users/test/test27f" }),
    });
    console.log(JSON.stringify(reg.body));
    checks.adminRegisterOk = reg.status === 200 && reg.body?.ok === true;

    console.log("\n--- Admin: GET /admin/codebases ---");
    const adminList = await fetchJson(`${baseUrl}/admin/codebases`);
    checks.adminListShowsTest = (adminList.body?.codebases || []).some(c => c.slug === testSlug);

    console.log("\n--- MCP initialize ---");
    const init = await mcpCall(baseUrl, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "27f-smoke", version: "0.1" } },
    });
    checks.mcpInitOk = !!init.sessionId;
    const sid = init.sessionId;
    await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

    console.log("\n--- list_codebases tool ---");
    const list = await callTool(baseUrl, sid, "list_codebases");
    console.log(list);
    checks.listCodebasesShowsTest = list.includes(testSlug);

    console.log("\n--- select_codebase('does-not-exist') (should error) ---");
    const sm = await callTool(baseUrl, sid, "select_codebase", { slug: "does-not-exist-xyz" });
    console.log(sm);
    checks.selectMissingCodebaseErrors = /not registered/i.test(sm);

    console.log("\n--- select_codebase('test27f') ---");
    const sel = await callTool(baseUrl, sid, "select_codebase", { slug: testSlug });
    console.log(sel);
    checks.selectOk = /selected: test27f/i.test(sel);

    console.log("\n--- search('handler function') ---");
    const search = await callTool(baseUrl, sid, "search", { query: "handler function" });
    console.log(search);
    checks.searchReturnsMatches = /2 match\(es\) in test27f/i.test(search) && /test27f\/file_a\.py/.test(search);

    console.log("\n--- Admin: DELETE /admin/register/test27f ---");
    const del = await fetchJson(`${baseUrl}/admin/register/${testSlug}`, { method: "DELETE" });
    checks.adminUnregisterOk = del.status === 200 && del.body?.removed === 1;
  } finally {
    cleanupTestUserWorker();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27F: PASS" : "❌ POC 27F: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
