#!/usr/bin/env node
/**
 * POC 30G: synthetic Vectorize bench (no Vertex / DeepSeek / D1).
 *
 * Hypothesis: Vectorize per-index write throughput is the actual bottleneck
 * in the dual fan-out pipeline. 30C reported peak ~120 vps end-to-end. If
 * pure Vectorize can do >>120 vps, then the producer / network / Vertex /
 * DeepSeek path is the cap. If pure Vectorize maxes ≈ 120 vps, then no
 * amount of SA scaling helps and we need sharded indexes / better batching.
 *
 * Sweep:
 *   - shards: 1, 4, 8, 16, 32
 *   - vectors_per_shard: 1000
 *   - batch_size: 100, 200, 1000
 *   - dim: 1536 (matches gemini-embedding-001)
 *
 * Run: node cloudflare-mcp/scripts/poc-30g-vectorize-bench.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/30g-vectorize-bench");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");

const TAG = "30g";
const workerName = `cfcode-poc-${TAG}-vecbench`;
const vecIndex = `cfcode-poc-${TAG}-vec`;

// Sweep matrix — keep small enough to finish in one session
const SWEEP = [
  { shards: 1,  vectors_per_shard: 1000, batch_size: 100,  dim: 1536 },
  { shards: 4,  vectors_per_shard: 1000, batch_size: 100,  dim: 1536 },
  { shards: 8,  vectors_per_shard: 1000, batch_size: 100,  dim: 1536 },
  { shards: 16, vectors_per_shard: 1000, batch_size: 100,  dim: 1536 },
  { shards: 32, vectors_per_shard: 1000, batch_size: 100,  dim: 1536 },
  // Batch-size variations at the best shard count (we'll re-pick after first pass)
  { shards: 16, vectors_per_shard: 1000, batch_size: 200,  dim: 1536 },
  { shards: 16, vectors_per_shard: 1000, batch_size: 1000, dim: 1536 },
];

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
    cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(), encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", input: opts.input,
  });
  if (r.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL: ${out}`); })();
}
function writeWranglerConfig() {
  let tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  tpl = tpl
    .replace("__WORKER_NAME__", workerName)
    .replace("__VECTORIZE_INDEX__", vecIndex);
  const out = path.join(pocDir, "wrangler.generated.jsonc");
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
function cleanup(configPath) {
  console.log("--- Cleanup ---");
  const c = (cmd, args) => run(cmd, args, { allowFailure: true, capture: true });
  c("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
  c("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"]);
  if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

async function main() {
  console.log("POC 30G: synthetic Vectorize-only bench\n");
  const checks = {
    resourcesReady: false, deployed: false, healthOk: false,
    sweepCompleted: false, benchWritten: false, cleanedUp: false,
  };
  const bench = {
    poc: "30g",
    note: "synthetic Vectorize-only bench (random 1536d vectors, no embed/D1/DeepSeek)",
    started_at: new Date().toISOString(),
    runs: [],
  };
  let configPath;

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true, allowFailure: true });
    configPath = writeWranglerConfig();
    checks.resourcesReady = true;

    run("npm", ["install"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);
    await waitHealth(baseUrl);
    checks.healthOk = true;

    console.log("\n--- Sweep ---");
    for (const cfg of SWEEP) {
      const run_id = `${TAG}-s${cfg.shards}-b${cfg.batch_size}-${Date.now()}`;
      const expected = cfg.shards * cfg.vectors_per_shard;
      console.log(`\nshards=${cfg.shards} vps=${cfg.vectors_per_shard} batch=${cfg.batch_size} (target=${expected} vectors)`);
      const t0 = Date.now();
      const r = await fetchJson(`${baseUrl}/bench`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id, ...cfg }),
      }, 1);
      const client_ms = Date.now() - t0;
      if (r.status !== 200) {
        console.log(`  FAIL status=${r.status} body=${JSON.stringify(r.body).slice(0, 300)}`);
        bench.runs.push({ config: cfg, run_id, status: r.status, error: r.body, client_ms });
        continue;
      }
      const b = r.body;
      console.log(`  done=${b.vectors_done}/${expected} wall=${b.wall_ms}ms vps=${b.vectors_per_sec} errors=${b.errors} shard_p50=${b.summary.shard_p50_avg_ms}ms shard_p95=${b.summary.worst_shard_p95_ms}ms`);
      bench.runs.push({
        config: cfg,
        run_id,
        wall_ms: b.wall_ms,
        client_ms,
        vectors_done: b.vectors_done,
        vectors_per_sec: b.vectors_per_sec,
        errors: b.errors,
        producer_errors: b.producer_errors,
        shard_p50_avg_ms: b.summary.shard_p50_avg_ms,
        worst_shard_p95_ms: b.summary.worst_shard_p95_ms,
        per_shard: b.per_shard,
      });
      // Settle between runs so Vectorize sees a clean state
      await new Promise(r => setTimeout(r, 3000));
    }
    checks.sweepCompleted = bench.runs.length === SWEEP.length && bench.runs.every(r => !r.error);

    bench.finished_at = new Date().toISOString();
    bench.summary = bench.runs
      .filter(r => !r.error)
      .map(r => ({ shards: r.config.shards, batch: r.config.batch_size, vps: r.vectors_per_sec, wall_ms: r.wall_ms, errors: r.errors }));
    fs.writeFileSync(path.join(pocDir, "bench-30g.json"), JSON.stringify(bench, null, 2), "utf8");
    checks.benchWritten = true;
    console.log(`\nbench written: ${path.join(pocDir, "bench-30g.json")}`);

    console.log("\n══ Sweep summary ══");
    for (const s of bench.summary) {
      console.log(`  shards=${s.shards} batch=${s.batch} → ${s.vps} vps in ${s.wall_ms}ms (errors=${s.errors})`);
    }
    const peak = bench.summary.reduce((a, b) => (b.vps > a.vps ? b : a), bench.summary[0] || { vps: 0 });
    console.log(`\nPEAK: shards=${peak.shards} batch=${peak.batch} → ${peak.vps} vps`);
    console.log(`Compare: 30C lumae end-to-end peak ≈ 120 vps`);
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 30G" : "FAIL POC 30G"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
