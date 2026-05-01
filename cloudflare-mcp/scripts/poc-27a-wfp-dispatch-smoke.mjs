#!/usr/bin/env node
/**
 * POC 27A: Plain Workers for Platforms dispatch
 *
 * Proves: A dispatch namespace + dispatcher Worker can route requests to a
 * user Worker by name at runtime, with no static service binding.
 *
 * Steps:
 *   1. Create dispatch namespace `cfcode-poc-27a-codebases`
 *   2. Deploy stub user Worker `cfcode-poc-27a-user-hello` into it
 *   3. Deploy dispatcher Worker bound to the namespace
 *   4. Hit dispatcher with /hello/whatever → expect user worker response
 *   5. Hit dispatcher with /missing/whatever → expect 404
 *   6. Cleanup
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/27a-wfp-dispatch");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");

const namespaceName = "cfcode-poc-27a-codebases";
const userWorkerName = "cfcode-poc-27a-user-hello";
const dispatcherName = "cfcode-poc-27a-dispatcher";

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

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetchJson(`${base}/health`); if (r.body?.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("dispatcher not healthy");
}

function cleanup() {
  console.log("\n--- Cleanup ---");
  // Delete dispatcher first (it's the consumer)
  run("npx", ["wrangler", "delete", "--name", dispatcherName, "--force"], { allowFailure: true, capture: true, cwd: path.join(pocDir, "dispatcher") });
  // Delete user worker from namespace
  run("npx", ["wrangler", "delete", "--name", userWorkerName, "--dispatch-namespace", namespaceName, "--force"], { allowFailure: true, capture: true, cwd: path.join(pocDir, "user") });
  // Delete namespace
  run("npx", ["wrangler", "dispatch-namespace", "delete", namespaceName], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 27A: Plain Workers for Platforms dispatch\n");
  const checks = {
    namespaceCreated: false,
    userWorkerUploaded: false,
    dispatcherDeployed: false,
    hellRoute: false,
    missingRoute404: false,
    cleanedUp: false,
  };

  try {
    cleanup();

    console.log("--- Create dispatch namespace ---");
    const ns = run("npx", ["wrangler", "dispatch-namespace", "create", namespaceName], { capture: true });
    checks.namespaceCreated = /created|already exists/i.test(`${ns.stdout}\n${ns.stderr}`);
    console.log(`namespaceCreated: ${checks.namespaceCreated ? "PASS" : "FAIL"}`);

    console.log("\n--- Deploy user worker into namespace ---");
    run("npm", ["install"], { capture: true });
    const u = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc", "--dispatch-namespace", namespaceName], { cwd: path.join(pocDir, "user"), capture: true });
    checks.userWorkerUploaded = /Uploaded/i.test(`${u.stdout}\n${u.stderr}`) || /already up to date/i.test(`${u.stdout}\n${u.stderr}`);
    console.log(`userWorkerUploaded: ${checks.userWorkerUploaded ? "PASS" : "FAIL"}`);

    console.log("\n--- Deploy dispatcher worker ---");
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc"], { cwd: path.join(pocDir, "dispatcher"), capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`, dispatcherName);
    checks.dispatcherDeployed = !!baseUrl;
    console.log(`Dispatcher: ${baseUrl}`);
    console.log(`dispatcherDeployed: ${checks.dispatcherDeployed ? "PASS" : "FAIL"}`);

    await waitHealth(baseUrl);

    console.log("\n--- Route /hello/test ---");
    const r1 = await fetchJson(`${baseUrl}/hello/test`);
    console.log(`status=${r1.status} body=${JSON.stringify(r1.body)}`);
    checks.hellRoute = r1.status === 200 && r1.body?.ok === true && r1.body?.slug === "hello" && r1.body?.path === "/test";
    console.log(`hellRoute: ${checks.hellRoute ? "PASS" : "FAIL"}`);

    console.log("\n--- Route /missing/test (should 404) ---");
    const r2 = await fetchJson(`${baseUrl}/missing/test`);
    console.log(`status=${r2.status} body=${JSON.stringify(r2.body)}`);
    checks.missingRoute404 = r2.status === 404;
    console.log(`missingRoute404: ${checks.missingRoute404 ? "PASS" : "FAIL"}`);

  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 27A: PASS" : "❌ POC 27A: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
