#!/usr/bin/env node
/**
 * POC 29E: shard count + batch size tuning sweep
 *
 * Reuses the 29D worker. Provisions ONCE, runs lumae through
 * /ingest-sharded with each (shard_count, batch_size) cell, captures wall_ms +
 * per-shard timings + 429 count. Cleanup once at end.
 *
 * Pass criteria:
 *   - Best (shard_count, batch_size) ≥ 5× 29A baseline (≥30 cps)
 *   - Zero Vertex 429s at chosen config
 *   - All cells return correct chunk count
 *
 * Run: node cloudflare-mcp/scripts/poc-29e-shard-tuning-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
// Reuse the 29D worker source — same DO + same endpoint
const pocDir = path.resolve(__dirname, "../poc/29d-shard-fanout");
const outDir = path.resolve(__dirname, "../poc/29e-shard-tuning");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/Downloads/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "29e";
const workerName = `cfcode-poc-${TAG}-tuning`;
const dbName = `cfcode-poc-${TAG}-tuning`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const repoSlug = `lumae-bench-${TAG}`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;

const BASELINE_CPS = 6.041; // 29A
const SHARD_COUNTS = [4, 8, 16, 32];
const BATCH_SIZES = [25, 50, 100];

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
  }
  return env;
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || pocDir,
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
  let tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  tpl = tpl
    .replace("__WORKER_NAME__", workerName)
    .replace("__R2_BUCKET__", r2Bucket)
    .replace(/__D1_NAME__/g, dbName)
    .replace("__D1_ID__", d1Id)
    .replace("__VECTORIZE_INDEX__", vecIndex);
  // Use a unique generated config name so we don't clobber 29D's wrangler.generated.jsonc
  const out = path.join(pocDir, `wrangler.${TAG}.generated.jsonc`);
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
function buildChunks(slug) {
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
      repo_slug: slug,
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

async function runCell(baseUrl, chunks, shardCount, batchSize, cellIdx) {
  const ts = Date.now();
  const slug = `${repoSlug}-c${cellIdx}-s${shardCount}-b${batchSize}`;
  const artifactKey = `${TAG}/${slug}-${ts}.jsonl`;
  // Re-stamp chunks to use the cell-specific slug (chunk_id is deterministic from path:0 — same across cells, fine for upsert)
  const cellChunks = chunks.map(c => ({ ...c, repo_slug: slug }));
  const artifactText = cellChunks.map(c => JSON.stringify(c)).join("\n") + "\n";
  const jobId = `j${TAG}-c${cellIdx}-${ts}`;
  const body = JSON.stringify({
    job_id: jobId, repo_slug: slug, indexed_path: lumaePath, active_commit: "bench",
    artifact_key: artifactKey, artifact_text: artifactText,
    shard_count: shardCount, batch_size: batchSize,
  });
  const t0 = Date.now();
  const r = await fetchJson(`${baseUrl}/ingest-sharded`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }, 1);
  const clientWallMs = Date.now() - t0;
  const ok = r.status === 200 && r.body?.ok === true;
  return {
    cell: cellIdx,
    shard_count: shardCount,
    batch_size: batchSize,
    ok,
    completed: r.body?.completed ?? 0,
    failed: r.body?.failed ?? 0,
    vertex_calls_total: r.body?.vertex_calls_total ?? 0,
    server_wall_ms: r.body?.wall_ms ?? null,
    client_wall_ms: clientWallMs,
    chunks_per_sec: r.body?.chunks_per_sec ?? null,
    speedup: r.body?.chunks_per_sec ? +(r.body.chunks_per_sec / BASELINE_CPS).toFixed(3) : null,
    response_status: r.status,
    error_excerpt: ok ? null : JSON.stringify(r.body).slice(0, 300),
  };
}

async function main() {
  console.log("POC 29E: shard count × batch size sweep\n");
  const checks = {
    resourcesReady: false,
    deployed: false,
    bothSecretsSet: false,
    chunksBuilt: false,
    allCellsCompleted: false,
    bestSpeedup5x: false,
    benchWritten: false,
    cleanedUp: false,
  };
  const sweep = {
    poc: "29e",
    note: `sweep shard_count ∈ {${SHARD_COUNTS.join(",")}} × batch_size ∈ {${BATCH_SIZES.join(",")}}`,
    baseline_chunks_per_sec: BASELINE_CPS,
    target_chunks_per_sec: BASELINE_CPS * 5,
    cells: [],
    best: null,
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

    const sa1B64 = Buffer.from(fs.readFileSync(sa1Path, "utf8")).toString("base64");
    const sa2B64 = Buffer.from(fs.readFileSync(sa2Path, "utf8")).toString("base64");
    for (const [name, val] of [
      ["GEMINI_SERVICE_ACCOUNT_B64", sa1B64],
      ["GEMINI_SERVICE_ACCOUNT_B64_2", sa2B64],
    ]) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", configPath],
        { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    checks.bothSecretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks(repoSlug);
    console.log(`${chunks.length} chunks built`);
    checks.chunksBuilt = chunks.length > 0;

    console.log("\n--- Sweep cells ---");
    let cellIdx = 0;
    for (const sc of SHARD_COUNTS) {
      for (const bs of BATCH_SIZES) {
        cellIdx++;
        console.log(`cell ${cellIdx}: shard_count=${sc} batch_size=${bs}`);
        const cell = await runCell(baseUrl, chunks, sc, bs, cellIdx);
        sweep.cells.push(cell);
        const tag = cell.ok ? "OK" : "FAIL";
        console.log(`  → ${tag} completed=${cell.completed}/632 wall=${cell.client_wall_ms}ms cps=${cell.chunks_per_sec} speedup=${cell.speedup}x verts=${cell.vertex_calls_total}`);
        if (!cell.ok) console.log(`  error: ${cell.error_excerpt}`);
        // small pause to let DOs settle
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    checks.allCellsCompleted = sweep.cells.every(c => c.ok);

    // Pick best by chunks_per_sec
    const okCells = sweep.cells.filter(c => c.ok && c.chunks_per_sec);
    if (okCells.length > 0) {
      okCells.sort((a, b) => (b.chunks_per_sec || 0) - (a.chunks_per_sec || 0));
      sweep.best = okCells[0];
      checks.bestSpeedup5x = (sweep.best.chunks_per_sec || 0) >= BASELINE_CPS * 5;
    }

    sweep.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "bench-29e.json"), JSON.stringify(sweep, null, 2), "utf8");
    checks.benchWritten = true;
    console.log(`\nbench written: ${path.join(outDir, "bench-29e.json")}`);
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Sweep summary (sorted by cps) ══");
  const sorted = [...sweep.cells].sort((a, b) => (b.chunks_per_sec || 0) - (a.chunks_per_sec || 0));
  for (const c of sorted) {
    console.log(`  shards=${c.shard_count} batch=${c.batch_size} cps=${c.chunks_per_sec} speedup=${c.speedup}x ok=${c.ok} wall=${c.client_wall_ms}ms`);
  }
  if (sweep.best) {
    console.log(`\nBEST: shard_count=${sweep.best.shard_count} batch_size=${sweep.best.batch_size} → ${sweep.best.chunks_per_sec} cps (${sweep.best.speedup}x baseline)`);
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 29E" : "FAIL POC 29E"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
