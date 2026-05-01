#!/usr/bin/env node
/**
 * POC 29G: real-world codebase end-to-end (income-scout-bun)
 *
 * Same harness as 29F but targets /Users/awilliamspcsevents/PROJECTS/income-scout-bun.
 * Standalone throwaway deploy — proves the full canonical worker path
 * (DO + /ingest-sharded + Vectorize + D1 + /search) on a non-lumae repo.
 *
 * Pass criteria:
 *   - Canonical worker deploys cleanly
 *   - All chunks indexed, 0 errors
 *   - /search returns matches after Vectorize propagation
 *   - chunks_per_sec ≥ 10× 29A baseline (≥60 cps)
 *   - Wall time scales reasonably (no super-linear blowup)
 *
 * Run: node cloudflare-mcp/scripts/poc-29g-income-scout-bun-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerDir = path.resolve(__dirname, "../workers/codebase");
const outDir = path.resolve(__dirname, "../poc/29g-income-scout-bun");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/Downloads/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json";
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/income-scout-bun";

const TAG = "29g";
const workerName = `cfcode-poc-${TAG}-isbun`;
const dbName = `cfcode-poc-${TAG}-isbun`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const queueName = `cfcode-poc-${TAG}-work`;
const dlqName = `cfcode-poc-${TAG}-dlq`;
const repoSlug = `income-scout-bun-${TAG}`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;

const BASELINE_CPS = 6.041; // 29A

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
  const cfg = {
    "$schema": "./node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: "2026-04-30",
    compatibility_flags: ["nodejs_compat"],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: r2Bucket }],
    d1_databases: [{ binding: "DB", database_name: dbName, database_id: d1Id }],
    vectorize: [{ binding: "VECTORIZE", index_name: vecIndex }],
    durable_objects: { bindings: [{ name: "INDEXING_SHARD_DO", class_name: "IndexingShardDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["IndexingShardDO"] }],
    vars: { SHARD_COUNT: "4", BATCH_SIZE: "100", NUM_SAS: "2" },
    queues: {
      producers: [{ binding: "WORK_QUEUE", queue: queueName }],
      consumers: [{ queue: queueName, max_batch_size: 1, max_batch_timeout: 1, max_retries: 2, max_concurrency: 25, dead_letter_queue: dlqName }],
    },
  };
  const out = path.join(workerDir, `wrangler.${TAG}.generated.jsonc`);
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2), "utf8");
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
  const r = spawnSync("git", ["ls-files"], { cwd: targetRepo, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(f =>
    f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__")
  );
}
function buildChunks(slug) {
  const files = listSourceFiles();
  const chunks = [];
  let skippedTooBig = 0;
  let skippedEmpty = 0;
  for (const rel of files) {
    const full = path.join(targetRepo, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) continue;
    if (stat.size > MAX_FILE_BYTES) { skippedTooBig++; continue; }
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.trim()) { skippedEmpty++; continue; }
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: slug,
      file_path: rel,
      source_sha256: crypto.createHash("sha256").update(truncated).digest("hex"),
      text: truncated,
    });
  }
  console.log(`  files=${files.length} chunks=${chunks.length} skipped_too_big=${skippedTooBig} skipped_empty=${skippedEmpty}`);
  return chunks;
}
function cleanup(configPath) {
  console.log("--- Cleanup ---");
  const c = (cmd, args) => run(cmd, args, { allowFailure: true, capture: true });
  c("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName]);
  c("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
  c("npx", ["wrangler", "queues", "delete", queueName, "--force"]);
  c("npx", ["wrangler", "queues", "delete", dlqName, "--force"]);
  c("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"]);
  c("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket]);
  c("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"]);
  if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

async function main() {
  console.log(`POC 29G: real-world codebase bench — ${targetRepo}\n`);
  const checks = {
    resourcesReady: false,
    deployed: false,
    bothSecretsSet: false,
    chunksBuilt: false,
    ingestShardedOK: false,
    allChunksCompleted: false,
    searchOK: false,
    speedup10x: false,
    benchWritten: false,
    cleanedUp: false,
  };
  const bench = {
    poc: "29g",
    target_repo: targetRepo,
    note: "real-world codebase end-to-end via canonical worker /ingest-sharded",
    baseline_chunks_per_sec: BASELINE_CPS,
    target_chunks_per_sec: BASELINE_CPS * 10,
    chunks: 0,
    completed: 0,
    failed: 0,
    vertex_calls_total: 0,
    wall_ms: 0,
    chunks_per_sec: 0,
    speedup_vs_baseline: 0,
    search_top_match: null,
    started_at: new Date().toISOString(),
  };
  let configPath;

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "queues", "create", dlqName], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "queues", "create", queueName], { capture: true, allowFailure: true });
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
        { cwd: workerDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    checks.bothSecretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks(repoSlug);
    bench.chunks = chunks.length;
    checks.chunksBuilt = chunks.length > 0;
    if (chunks.length === 0) throw new Error("no chunks built — repo filter excluded everything?");

    const artifactKey = `${TAG}-bench/${Date.now()}.jsonl`;
    const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    const jobId = `j${TAG}-${Date.now()}`;
    console.log(`artifact size: ${(artifactText.length / 1024).toFixed(1)}KB`);

    console.log("\n--- POST /ingest-sharded ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest-sharded`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId, repo_slug: repoSlug, indexed_path: targetRepo, active_commit: "29g",
        artifact_key: artifactKey, artifact_text: artifactText,
        shard_count: 4, batch_size: 100,
      }),
    }, 1);
    const clientWallMs = Date.now() - t0;
    console.log(`status=${ing.status} clientWall=${clientWallMs}ms`);
    if (ing.status !== 200) console.log(`body: ${JSON.stringify(ing.body).slice(0, 500)}`);
    checks.ingestShardedOK = ing.status === 200 && ing.body?.ok === true;
    bench.completed = ing.body?.completed ?? 0;
    bench.failed = ing.body?.failed ?? 0;
    bench.vertex_calls_total = ing.body?.vertex_calls_total ?? 0;
    bench.wall_ms = ing.body?.wall_ms ?? clientWallMs;
    bench.chunks_per_sec = ing.body?.chunks_per_sec ?? +(bench.completed / (bench.wall_ms / 1000)).toFixed(3);
    bench.speedup_vs_baseline = +(bench.chunks_per_sec / BASELINE_CPS).toFixed(3);
    bench.shard_breakdown = ing.body?.shards ?? [];
    checks.allChunksCompleted = bench.completed === chunks.length && bench.failed === 0;
    checks.speedup10x = bench.chunks_per_sec >= BASELINE_CPS * 10;
    console.log(`completed=${bench.completed}/${chunks.length} failed=${bench.failed} cps=${bench.chunks_per_sec} speedup=${bench.speedup_vs_baseline}x verts=${bench.vertex_calls_total}`);

    console.log("\n--- POST /search (60s eventual-consistency window) ---");
    let sq;
    const dl = Date.now() + 60_000;
    while (Date.now() < dl) {
      sq = await fetchJson(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_slug: repoSlug, query: "income calculation", topK: 5 }),
      });
      const matches = sq.body?.matches?.length ?? 0;
      const vec = sq.body?.vectorize_returned ?? 0;
      console.log(`/search status=${sq.status} vec=${vec} d1=${matches}`);
      if (matches > 0) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    checks.searchOK = sq?.status === 200 && Array.isArray(sq?.body?.matches) && sq.body.matches.length > 0;
    bench.search_top_match = sq?.body?.matches?.[0]?.chunk?.file_path ?? null;
    if (sq?.body?.matches) {
      console.log(`top matches:`);
      for (const m of sq.body.matches.slice(0, 5)) {
        console.log(`  ${m.score?.toFixed(3) ?? "?"}  ${m.chunk?.file_path ?? "?"}`);
      }
    }

    bench.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "bench-29g.json"), JSON.stringify(bench, null, 2), "utf8");
    checks.benchWritten = true;
    console.log(`\nbench written: ${path.join(outDir, "bench-29g.json")}`);
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  console.log(`\nbench-29g.json: ${JSON.stringify(bench, null, 2)}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 29G" : "FAIL POC 29G"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
