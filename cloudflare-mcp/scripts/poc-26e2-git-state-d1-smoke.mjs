#!/usr/bin/env node
/**
 * POC 26E2: Cloudflare Stores Git History State
 *
 * Proves: A Worker stores/retrieves per-codebase git state in D1 —
 * manifest rows, file rows, and active commit tracking. Throwaway resources.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26e2-git-state-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const manifestPath = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e1/diff-manifest.json");

const workerName = "cfcode-poc-26e2-git-state";
const dbName = "cfcode-poc-26e2-git-state";

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

function extractDbId(out) {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`no D1 UUID in:\n${out}`);
  return m[0];
}

function writeConfig(dbId) {
  fs.writeFileSync(
    path.join(pocDir, "wrangler.generated.jsonc"),
    fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8").replace("__DATABASE_ID__", dbId),
    "utf8"
  );
}

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL in:\n${out}`); })();
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!(res.headers.get("content-type") || "").includes("application/json")) throw new Error(`${url} non-JSON ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function waitHealth(base) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { const h = await fetchJson(`${base}/health`); if (h.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("Worker not healthy");
}

function cleanup() {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26E2: Cloudflare Stores Git History State\n");
  const checks = { manifestStored: false, filesStored: false, currentState: false, manifestRetrieved: false, cleanedUp: false };

  if (!fs.existsSync(manifestPath)) throw new Error(`POC 26E1 manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`Input manifest: ${manifest.manifest_id} (${manifest.summary.total} files)`);

  try {
    cleanup();

    console.log("\n--- Create D1 + deploy ---");
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeConfig(extractDbId(`${createDb.stdout}\n${createDb.stderr}`));
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitHealth(baseUrl);
    console.log(`Worker: ${baseUrl}`);

    // Import manifest
    console.log("\n--- Import manifest ---");
    const importResult = await fetchJson(`${baseUrl}/git-state/import`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    checks.manifestStored = importResult.ok === true;
    checks.filesStored = importResult.files_stored === manifest.files.length;
    console.log(`Manifest stored: ${checks.manifestStored ? "PASS" : "FAIL"}`);
    console.log(`Files stored: ${importResult.files_stored}/${manifest.files.length} (${checks.filesStored ? "PASS" : "FAIL"})`);

    // Get current state
    console.log("\n--- Current state ---");
    const state = await fetchJson(`${baseUrl}/git-state/current/${manifest.repo_slug}`);
    checks.currentState = state.ok === true &&
      state.state?.active_commit === manifest.target_commit &&
      state.state?.last_manifest_id === manifest.manifest_id &&
      state.state?.repo_slug === manifest.repo_slug;
    console.log(`Active commit: ${state.state?.active_commit?.slice(0, 8)}`);
    console.log(`Last manifest: ${state.state?.last_manifest_id}`);
    console.log(`Current state: ${checks.currentState ? "PASS" : "FAIL"}`);

    // Retrieve manifest
    console.log("\n--- Retrieve manifest ---");
    const retrieved = await fetchJson(`${baseUrl}/git-state/manifests/${manifest.manifest_id}`);
    const storedManifest = retrieved.manifest;
    const storedFiles = retrieved.files || [];
    checks.manifestRetrieved = retrieved.ok === true &&
      storedManifest?.base_commit === manifest.base_commit &&
      storedManifest?.target_commit === manifest.target_commit &&
      Number(storedManifest?.total) === manifest.summary.total &&
      storedFiles.length === manifest.files.length;
    console.log(`Retrieved: ${storedFiles.length} files, base=${storedManifest?.base_commit?.slice(0, 8)}, target=${storedManifest?.target_commit?.slice(0, 8)}`);
    console.log(`Manifest retrieved: ${checks.manifestRetrieved ? "PASS" : "FAIL"}`);

  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26E2: PASS" : "❌ POC 26E2: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
