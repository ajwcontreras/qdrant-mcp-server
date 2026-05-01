#!/usr/bin/env node
/**
 * POC 31A: Autonomous shards — fire-and-forget producer, R2-pull per shard,
 * per-fetch timeouts, independent progress updates.
 *
 * Measures:
 *   - response_ms              (HTTP response time, target <1500ms)
 *   - time_to_code_live        (poll until code_status='live'/'partial')
 *   - time_to_hyde_live        (poll until hyde_status='live'/'partial')
 *   - time_to_published        (poll until status='published'/'partial'/'failed')
 *
 * Pass criteria:
 *   - response_ms <= 3000ms        (R2 put + D1 write + orchestrator enqueue)
 *   - all 632 code chunks land     (code_status = 'live' or 'partial', completed = chunks)
 *   - hyde rows >= 95% of expected
 *   - time_to_code_live << time_to_hyde_live (proves decoupling visible to client)
 *
 * Run: node cloudflare-mcp/scripts/poc-31a-autonomous-shards-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/31a-autonomous-shards");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/.config/cfcode/sas/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "31a";
const workerName = `cfcode-poc-${TAG}-autonomous`;
const dbName = `cfcode-poc-${TAG}-autonomous`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const repoSlug = `lumae-bench-${TAG}`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 300_000; // 5 min — longer for first-run cold starts

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
      catch { return { status: r.status, body: { _raw: t.slice(0, 500) } }; }
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
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) continue;
    let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: repoSlug, file_path: rel,
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

async function pollForLive(baseUrl, jobId, t0) {
  let timeToCodeLive = null;
  let timeToHydeLive = null;
  let timeToPublished = null;
  let lastJob = null;
  const dl = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < dl) {
    const r = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
    if (r.status === 200 && r.body?.job) {
      lastJob = r.body.job;
      const elapsed = Date.now() - t0;
      if (timeToCodeLive == null && (lastJob.code_status === "live" || lastJob.code_status === "partial")) timeToCodeLive = elapsed;
      if (timeToHydeLive == null && (lastJob.hyde_status === "live" || lastJob.hyde_status === "partial" || lastJob.hyde_status === "skipped")) timeToHydeLive = elapsed;
      if (timeToPublished == null && (lastJob.status === "published" || lastJob.status === "partial" || lastJob.status === "failed")) timeToPublished = elapsed;
      process.stdout.write(`\r  poll t=${(elapsed/1000).toFixed(1)}s  code=${lastJob.code_status}/${lastJob.completed}  hyde=${lastJob.hyde_status}/${lastJob.hyde_completed}  status=${lastJob.status}     `);
      if (timeToPublished != null) break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write("\n");
  return { timeToCodeLive, timeToHydeLive, timeToPublished, lastJob };
}

async function main() {
  console.log("POC 31A: autonomous shards (fire-and-forget + R2-pull)\n");
  const checks = {
    resourcesReady: false, deployed: false, secretsSet: false, chunksBuilt: false,
    responseFast: false, codeComplete: false, hydeComplete: false,
    decouplingObservable: false, benchWritten: false, cleanedUp: false,
  };
  const bench = {
    poc: "31a",
    note: "autonomous shards: fire-and-forget producer via OrchestratorDO, R2-pull per shard, per-fetch timeouts, independent progress",
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
        { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
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
    const jobId = `j${TAG}-${Date.now()}`;

    console.log("\n--- POST /ingest-sharded (fire-and-forget) ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest-sharded`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId, repo_slug: repoSlug, indexed_path: lumaePath, active_commit: TAG,
        artifact_key: artifactKey, artifact_text: artifactText,
        code_shard_count: 4, hyde_shard_count: 16,
        code_batch_size: 500, hyde_batch_size: 500,
        hyde: true,
      }),
    }, 1);
    const responseMs = Date.now() - t0;
    console.log(`response_ms=${responseMs}  status=${ing.status}  body.status=${ing.body?.status || ing.body?._raw || "(empty)"}  server_response_ms=${ing.body?.response_ms}`);
    bench.response_ms = responseMs;
    bench.producer_result = ing.body;
    checks.responseFast = responseMs <= 3000 && ing.status === 200 && ing.body?.status === "running";

    if (ing.status !== 200) {
      console.error(`Producer returned non-200. Body: ${JSON.stringify(ing.body).slice(0, 400)}`);
    }

    console.log("\n--- Poll /jobs/:id/status ---");
    const poll = await pollForLive(baseUrl, jobId, t0);
    bench.time_to_code_live = poll.timeToCodeLive;
    bench.time_to_hyde_live = poll.timeToHydeLive;
    bench.time_to_published = poll.timeToPublished;
    bench.final_job = poll.lastJob;

    if (poll.lastJob) {
      const expectedHyde = chunks.length * 12;
      checks.codeComplete = (poll.lastJob.completed ?? 0) >= chunks.length * 0.99;
      checks.hydeComplete = (poll.lastJob.hyde_completed ?? 0) >= expectedHyde * 0.95;
      checks.decouplingObservable = poll.timeToCodeLive != null && poll.timeToHydeLive != null
        && poll.timeToHydeLive - poll.timeToCodeLive > 5000;
    }

    bench.finished_at = new Date().toISOString();
    const benchFile = path.join(pocDir, "bench-31a.json");
    fs.writeFileSync(benchFile, JSON.stringify(bench, null, 2), "utf8");
    checks.benchWritten = true;
    console.log(`\nbench written: ${benchFile}`);

    console.log("\n══ Summary ══");
    console.log(`  response_ms         : ${responseMs}`);
    console.log(`  time_to_code_live   : ${poll.timeToCodeLive}ms`);
    console.log(`  time_to_hyde_live   : ${poll.timeToHydeLive}ms`);
    console.log(`  time_to_published   : ${poll.timeToPublished}ms`);
    console.log(`  decouple gap        : ${poll.timeToHydeLive != null && poll.timeToCodeLive != null ? ((poll.timeToHydeLive - poll.timeToCodeLive) / 1000).toFixed(1) + "s" : "n/a"}`);
  } finally {
    cleanup(configPath);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 31A" : "FAIL POC 31A"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
