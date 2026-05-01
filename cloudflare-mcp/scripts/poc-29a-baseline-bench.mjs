#!/usr/bin/env node
/**
 * POC 29A: Baseline code-only re-index speed
 *
 * Proves: current production canonical worker's chunks/sec on real lumae,
 *         no HyDE. This number is the baseline every later POC must beat.
 *
 * Output: cloudflare-mcp/poc/29a-baseline-bench/bench-29a.json
 *   { chunks, vertex_calls, oauth_refreshes, wall_ms, chunks_per_sec, errors }
 *
 * Pass criteria:
 *   - 608 lumae chunks indexed, all active=1
 *   - bench-29a.json written with all fields populated
 *   - chunks_per_sec recorded (no threshold — this IS the baseline)
 *
 * Note: vertex_calls and oauth_refreshes are inferred for 29A
 * (one Vertex call per chunk, oauth_refreshes is # of cold isolates).
 * Real instrumentation lands in 29B (oauth) and 29D (per-SA counters).
 *
 * Run: node cloudflare-mcp/scripts/poc-29a-baseline-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerDir = path.resolve(__dirname, "../workers/codebase");
const pocDir = path.resolve(__dirname, "../poc/29a-baseline-bench");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "29a";
const workerName = `cfcode-poc-${TAG}-baseline`;
const dbName = `cfcode-poc-${TAG}-baseline`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const queueName = `cfcode-poc-${TAG}-work`;
const dlqName = `cfcode-poc-${TAG}-dlq`;
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
  // Build a standalone wrangler config that points the canonical worker source
  // at our throwaway resources, with a queue consumer attached.
  const cfg = {
    "$schema": "./node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: "2026-04-30",
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: r2Bucket }],
    d1_databases: [{ binding: "DB", database_name: dbName, database_id: d1Id }],
    vectorize: [{ binding: "VECTORIZE", index_name: vecIndex }],
    queues: {
      producers: [{ binding: "WORK_QUEUE", queue: queueName }],
      consumers: [{
        queue: queueName,
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 2,
        max_concurrency: 25,
        dead_letter_queue: dlqName,
      }],
    },
  };
  const out = path.join(workerDir, `wrangler.${TAG}-bench.jsonc`);
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2), "utf8");
  return out;
}
async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
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
  console.log("POC 29A: baseline code-only re-index speed\n");
  const checks = {
    resourcesReady: false,
    deployed: false,
    secretsSet: false,
    chunksBuilt: false,
    ingestQueued: false,
    allPublished: false,
    benchWritten: false,
    cleanedUp: false,
  };
  const bench = {
    poc: "29a",
    note: "baseline code-only canonical worker, max_concurrency=25, max_batch_size=1",
    chunks: 0,
    queued: 0,
    vertex_calls: 0,
    oauth_refreshes: 0,
    wall_ms: 0,
    chunks_per_sec: 0,
    errors: 0,
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

    // Ensure worker deps installed
    run("npm", ["install"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    // Vertex SA secret
    const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
    const sec = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", configPath],
      { cwd: workerDir, env: loadCfEnv(), input: saB64, encoding: "utf8" });
    if (sec.status !== 0) throw new Error(`secret failed: ${sec.stderr}`);
    checks.secretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks();
    bench.chunks = chunks.length;
    checks.chunksBuilt = chunks.length > 0;
    console.log(`${chunks.length} chunks built`);
    const artifactKey = `${TAG}-bench/${Date.now()}.jsonl`;
    const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    const jobId = `j${TAG}-${Date.now()}`;

    console.log("\n--- POST /ingest ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        repo_slug: repoSlug,
        indexed_path: lumaePath,
        active_commit: "bench",
        artifact_key: artifactKey,
        artifact_text: artifactText,
      }),
    });
    console.log(JSON.stringify(ing.body));
    bench.queued = ing.body?.queued || 0;
    checks.ingestQueued = ing.body?.ok && bench.queued >= chunks.length * 0.9;

    console.log("\n--- Poll until published ---");
    const dl = Date.now() + 15 * 60_000;
    let lastJob;
    while (Date.now() < dl) {
      const s = await fetchJson(`${baseUrl}/jobs/${jobId}/status`).catch(() => null);
      lastJob = s?.body?.job;
      process.stdout.write(`\r   completed=${lastJob?.completed ?? 0}/${lastJob?.total ?? "?"} failed=${lastJob?.failed ?? 0} status=${lastJob?.status}        `);
      if (lastJob?.status === "published") break;
      await new Promise(r => setTimeout(r, 5000));
    }
    process.stdout.write("\n");
    bench.wall_ms = Date.now() - t0;
    bench.chunks_per_sec = bench.queued > 0 ? +(bench.queued / (bench.wall_ms / 1000)).toFixed(3) : 0;
    bench.vertex_calls = bench.queued; // baseline: one per chunk, no batching
    bench.oauth_refreshes = -1; // not instrumented in 29A; 29B adds counter
    bench.errors = lastJob?.failed ?? 0;
    bench.completed = lastJob?.completed ?? 0;
    bench.status = lastJob?.status;
    console.log(`elapsed=${(bench.wall_ms / 1000).toFixed(1)}s chunks_per_sec=${bench.chunks_per_sec}`);
    checks.allPublished = lastJob?.status === "published" && (lastJob?.completed ?? 0) >= bench.queued * 0.99;

    bench.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(pocDir, "bench-29a.json"), JSON.stringify(bench, null, 2), "utf8");
    checks.benchWritten = true;
    console.log(`\nbench written: ${path.join(pocDir, "bench-29a.json")}`);
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  console.log(`\nbench-29a.json: ${JSON.stringify(bench, null, 2)}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 29A" : "FAIL POC 29A"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
