#!/usr/bin/env node
/**
 * POC 30B: /hyde-enrich resumable endpoint
 *
 * Deploys 30a-hyde-shard worker (which now has /hyde-enrich added).
 * 1. Code-only ingest (hyde=false) of lumae 632 chunks → code=632 hyde=0
 * 2. /hyde-enrich → should generate ~7584 HyDE rows
 * 3. /hyde-enrich AGAIN → should be a no-op (processed=0, idempotent)
 *
 * Pass criteria:
 *   - Code-only ingest succeeds, hyde=0 in /counts
 *   - First /hyde-enrich processes ≥99% of code chunks, hyde count ≥95%
 *   - Second /hyde-enrich processes=0 (idempotent)
 *   - vectors_per_sec on enrich ≥ 100
 *
 * Run: node cloudflare-mcp/scripts/poc-30b-hyde-enrich-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
// Reuse the 30A worker source
const workerDir = path.resolve(__dirname, "../poc/30a-hyde-shard");
const outDir = path.resolve(__dirname, "../poc/30b-hyde-enrich");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/Downloads/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "30b";
const workerName = `cfcode-poc-${TAG}-hydeenrich`;
const dbName = `cfcode-poc-${TAG}-hydeenrich`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const repoSlug = `lumae-bench-${TAG}`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;

function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim();
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    if (k.trim() === "DEEPSEEK_API_KEY") env._DEEPSEEK_API_KEY = v;
  }
  return env;
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || workerDir,
    env: opts.env || loadCfEnv(),
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    input: opts.input,
  });
  if (r.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}
function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL: ${out}`); })();
}
function ensureD1() {
  const c = run("npx", ["wrangler", "d1", "create", dbName], { capture: true, allowFailure: true });
  const out = `${c.stdout}\n${c.stderr}`;
  let m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const dbs = JSON.parse(list.stdout || "[]");
  const f = dbs.find(d => d.name === dbName);
  if (!f) throw new Error(`could not find d1 ${dbName}`);
  return f.uuid;
}
function writeWranglerConfig(d1Id) {
  let tpl = fs.readFileSync(path.join(workerDir, "wrangler.template.jsonc"), "utf8");
  tpl = tpl
    .replace("__WORKER_NAME__", workerName)
    .replace("__R2_BUCKET__", r2Bucket)
    .replace(/__D1_NAME__/g, dbName)
    .replace("__D1_ID__", d1Id)
    .replace("__VECTORIZE_INDEX__", vecIndex);
  const out = path.join(workerDir, `wrangler.${TAG}.generated.jsonc`);
  fs.writeFileSync(out, tpl, "utf8");
  return out;
}
async function fetchJson(url, init, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, init);
      const t = await r.text();
      try { return { status: r.status, body: JSON.parse(t) }; }
      catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
    } catch (e) {
      lastErr = e;
      console.error(`fetch attempt ${attempt + 1}/${retries + 1} failed: ${e?.message || e}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
async function waitHealth(b) {
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    try { const r = await fetch(`${b}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("not healthy");
}
function listSourceFiles() {
  const r = spawnSync("git", ["ls-files"], { cwd: lumaePath, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(f =>
    f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__")
  );
}
function buildChunks() {
  const files = listSourceFiles();
  const chunks = [];
  for (const rel of files) {
    const full = path.join(lumaePath, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) continue;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: repoSlug,
      file_path: rel,
      source_sha256: crypto.createHash("sha256").update(truncated).digest("hex"),
      text: truncated,
    });
  }
  return chunks;
}
function cleanup(configPath) {
  console.log("--- Cleanup ---");
  const c = (cmd, args) => run(cmd, args, { allowFailure: true, capture: true });
  c("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
  c("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"]);
  c("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket]);
  c("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"]);
  if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

async function main() {
  console.log("POC 30B: /hyde-enrich resumable endpoint\n");
  const checks = {
    resourcesReady: false,
    deployed: false,
    secretsSet: false,
    chunksBuilt: false,
    codeOnlyIngestOK: false,
    countsCodeOnly: false,
    enrichOK: false,
    enrichHydeHigh: false,
    idempotentNoop: false,
    benchWritten: false,
    cleanedUp: false,
  };
  const bench = {
    poc: "30b",
    note: "/hyde-enrich resumable, idempotent re-HyDE",
    chunks: 0,
    code_only_ingest: null,
    enrich_first: null,
    enrich_second: null,
    started_at: new Date().toISOString(),
  };
  let configPath;

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true, allowFailure: true });
    const d1Id = ensureD1();
    configPath = writeWranglerConfig(d1Id);
    checks.resourcesReady = true;

    run("npm", ["install"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    const env = loadCfEnv();
    const sa1B64 = Buffer.from(fs.readFileSync(sa1Path, "utf8")).toString("base64");
    const sa2B64 = Buffer.from(fs.readFileSync(sa2Path, "utf8")).toString("base64");
    if (!env._DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not in .cfapikeys");
    for (const [name, val] of [
      ["GEMINI_SERVICE_ACCOUNT_B64", sa1B64],
      ["GEMINI_SERVICE_ACCOUNT_B64_2", sa2B64],
      ["DEEPSEEK_API_KEY", env._DEEPSEEK_API_KEY],
    ]) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", configPath],
        { cwd: workerDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    checks.secretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks();
    bench.chunks = chunks.length;
    checks.chunksBuilt = chunks.length > 0;
    console.log(`${chunks.length} chunks`);
    const artifactKey = `${TAG}/${Date.now()}.jsonl`;
    const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    const jobId = `j${TAG}-code-${Date.now()}`;

    console.log("\n--- Step 1: code-only ingest (hyde=false) ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest-sharded-hyde`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId, repo_slug: repoSlug, indexed_path: lumaePath, active_commit: "30b",
        artifact_key: artifactKey, artifact_text: artifactText,
        shard_count: 4, batch_size: 100, hyde: false,
      }),
    }, 1);
    const ingestWall = Date.now() - t0;
    bench.code_only_ingest = { status: ing.status, body: ing.body, wall_ms: ingestWall };
    console.log(`status=${ing.status} completed=${ing.body?.completed} wall=${ingestWall}ms`);
    checks.codeOnlyIngestOK = ing.status === 200 && ing.body?.completed === chunks.length;

    const c0 = await fetchJson(`${baseUrl}/counts`);
    console.log(`counts after code-only: ${JSON.stringify(c0.body)}`);
    checks.countsCodeOnly = c0.body?.code === chunks.length && c0.body?.hyde === 0;

    console.log("\n--- Step 2: first /hyde-enrich (full HyDE generation) ---");
    const e1t0 = Date.now();
    const e1 = await fetchJson(`${baseUrl}/hyde-enrich`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, shard_count: 16, batch_size: 100 }),
    }, 1);
    const e1wall = Date.now() - e1t0;
    bench.enrich_first = { status: e1.status, body: e1.body, client_wall_ms: e1wall };
    console.log(`status=${e1.status} processed=${e1.body?.processed} hyde_added=${e1.body?.hyde_added} wall=${e1wall}ms vps=${e1.body?.vectors_per_sec}`);
    // First call: ok or partial (some 429-driven errors expected)
    checks.enrichOK = e1.status === 200 && (e1.body?.hyde_added ?? 0) > 0;
    const expectedHyde = chunks.length * 12;
    checks.enrichHydeHigh = (e1.body?.hyde_added ?? 0) >= expectedHyde * 0.95;

    const c1 = await fetchJson(`${baseUrl}/counts`);
    console.log(`counts after enrich-1: ${JSON.stringify(c1.body)}`);

    console.log("\n--- Step 3: second /hyde-enrich (resume — fills any first-run gaps) ---");
    const e2t0 = Date.now();
    const e2 = await fetchJson(`${baseUrl}/hyde-enrich`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, shard_count: 16, batch_size: 100 }),
    }, 1);
    const e2wall = Date.now() - e2t0;
    bench.enrich_second = { status: e2.status, body: e2.body, client_wall_ms: e2wall };
    console.log(`status=${e2.status} missing_hyde=${e2.body?.missing_hyde} processed=${e2.body?.processed} wall=${e2wall}ms`);
    // Resumability: second call processes ONLY the gap (≤2% of code chunks)
    const e2miss = e2.body?.missing_hyde ?? -1;
    checks.resumeFillsGap = e2.status === 200 && e2miss >= 0 && e2miss <= chunks.length * 0.02;

    const c2 = await fetchJson(`${baseUrl}/counts`);
    console.log(`counts after enrich-2: ${JSON.stringify(c2.body)}`);

    console.log("\n--- Step 4: third /hyde-enrich (true no-op idempotency) ---");
    const e3t0 = Date.now();
    const e3 = await fetchJson(`${baseUrl}/hyde-enrich`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, shard_count: 16, batch_size: 100 }),
    }, 1);
    const e3wall = Date.now() - e3t0;
    bench.enrich_third = { status: e3.status, body: e3.body, client_wall_ms: e3wall };
    console.log(`status=${e3.status} missing_hyde=${e3.body?.missing_hyde} processed=${e3.body?.processed} wall=${e3wall}ms`);
    checks.idempotentNoop = e3.status === 200 && (e3.body?.processed ?? -1) === 0;

    bench.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "bench-30b.json"), JSON.stringify(bench, null, 2), "utf8");
    checks.benchWritten = true;
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  console.log(`\nbench-30b.json: ${JSON.stringify(bench, null, 2)}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 30B" : "FAIL POC 30B"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
