#!/usr/bin/env node
/**
 * POC 31C: Scaffold-pattern indexer — fire-and-forget orchestrator DO,
 * R2-pull per shard, explicit DeepSeek concurrency batching, Promise.allSettled at both levels.
 *
 * Run: node cloudflare-mcp/scripts/poc-31c-scaffold-indexer-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/31c-scaffold-indexer");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/.config/cfcode/sas/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "31c";
const workerName = `cfcode-poc-${TAG}-scaffold`;
const dbName = `cfcode-poc-${TAG}-scaffold`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;
const repoSlug = `lumae-bench-${TAG}`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;

function loadCfEnv() {
  const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
  for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("="); const v = rest.join("=").trim();
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    if (k.trim() === "DEEPSEEK_API_KEY") env._DEEPSEEK_API_KEY = v;
  }
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(), encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", input: opts.input });
  if (r.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL: ${out.slice(0, 200)}`); })();
}

function ensureD1() {
  const c = run("npx", ["wrangler", "d1", "create", dbName], { capture: true, allowFailure: true });
  let m = `${c.stdout}\n${c.stderr}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const dbs = JSON.parse(list.stdout || "[]");
  const f = dbs.find(d => d.name === dbName);
  if (!f) throw new Error(`could not find d1 ${dbName}`);
  return f.uuid;
}

function writeWranglerConfig(d1Id) {
  let tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  tpl = tpl.replace("__WORKER_NAME__", workerName).replace("__R2_BUCKET__", r2Bucket).replace(/__D1_NAME__/g, dbName).replace("__D1_ID__", d1Id).replace("__VECTORIZE_INDEX__", vecIndex);
  const out = path.join(pocDir, "wrangler.generated.jsonc");
  fs.writeFileSync(out, tpl, "utf8");
  return out;
}

async function fetchJson(url, init, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { const r = await fetch(url, init); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: { _raw: t.slice(0, 500) } }; } }
    catch (e) { lastErr = e; if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
  throw lastErr;
}

async function waitHealth(b) {
  const dl = Date.now() + 60000;
  while (Date.now() < dl) { try { const r = await fetch(`${b}/health`); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 1500)); }
  throw new Error("not healthy");
}

function buildChunks() {
  const r = spawnSync("git", ["ls-files"], { cwd: lumaePath, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(f => f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules")).map(rel => {
    const full = path.join(lumaePath, rel);
    let stat; try { stat = fs.statSync(full); } catch { return null; }
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) return null;
    let text; try { text = fs.readFileSync(full, "utf8"); } catch { return null; }
    if (!text.trim()) return null;
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    return { chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`, repo_slug: repoSlug, file_path: rel, source_sha256: crypto.createHash("sha256").update(truncated).digest("hex"), text: truncated };
  }).filter(Boolean);
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
  console.log("POC 31C: scaffold-pattern indexer\n");
  let configPath;
  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true, allowFailure: true });
    const d1Id = ensureD1();
    configPath = writeWranglerConfig(d1Id);
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    console.log(`Worker: ${baseUrl}`);

    const env = loadCfEnv();
    const sa1B64 = Buffer.from(fs.readFileSync(sa1Path, "utf8")).toString("base64");
    const sa2B64 = Buffer.from(fs.readFileSync(sa2Path, "utf8")).toString("base64");
    if (!env._DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not in .cfapikeys");
    for (const [name, val] of [["GEMINI_SERVICE_ACCOUNT_B64", sa1B64], ["GEMINI_SERVICE_ACCOUNT_B64_2", sa2B64], ["DEEPSEEK_API_KEY", env._DEEPSEEK_API_KEY]]) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", configPath], { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks();
    console.log(`${chunks.length} chunks`);
    const artifactKey = `${TAG}/${Date.now()}.jsonl`;
    const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    const jobId = `j${TAG}-${Date.now()}`;

    console.log("\n--- POST /ingest-sharded (fire-and-forget) ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest-sharded`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, repo_slug: repoSlug, indexed_path: lumaePath, active_commit: TAG, artifact_key: artifactKey, artifact_text: artifactText, code_shard_count: 4, hyde_shard_count: 16, code_batch_size: 500, hyde_batch_size: 500, hyde: true }) }, 1);
    const responseMs = Date.now() - t0;
    console.log(`response_ms=${responseMs}  status=${ing.status}  body.status=${ing.body?.status || ing.body?._raw || "(empty)"}`);
    if (ing.status !== 200) console.error(`Producer failed. Body: ${JSON.stringify(ing.body).slice(0, 400)}`);

    console.log("\n--- Poll /jobs/:id/status ---");
    let codeLive = null, hydeLive = null, published = null, lastJob = null;
    const dl = Date.now() + 300000;
    while (Date.now() < dl) {
      const r = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
      if (r.status === 200 && r.body?.job) {
        lastJob = r.body.job;
        const elapsed = Date.now() - t0;
        if (codeLive == null && (lastJob.code_status === "live" || lastJob.code_status === "partial")) codeLive = elapsed;
        if (hydeLive == null && (lastJob.hyde_status === "live" || lastJob.hyde_status === "partial" || lastJob.hyde_status === "skipped")) hydeLive = elapsed;
        if (published == null && (lastJob.status === "published" || lastJob.status === "partial" || lastJob.status === "failed")) published = elapsed;
        process.stdout.write(`\r  poll t=${(elapsed/1000).toFixed(1)}s  code=${lastJob.code_status}/${lastJob.completed}  hyde=${lastJob.hyde_status}/${lastJob.hyde_completed}  status=${lastJob.status}     `);
        if (published != null) break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log("");

    const bench = { poc: "31c", note: "scaffold-pattern: fire-and-forget via DO alarm, R2-pull, explicit DS concurrency (6), Promise.allSettled at both levels", started_at: new Date(t0).toISOString(), chunks: chunks.length, response_ms: responseMs, time_to_code_live: codeLive, time_to_hyde_live: hydeLive, time_to_published: published, final_job: lastJob, finished_at: new Date().toISOString() };
    fs.writeFileSync(path.join(pocDir, "bench-31c.json"), JSON.stringify(bench, null, 2), "utf8");
    console.log(`bench written: ${path.join(pocDir, "bench-31c.json")}`);

    console.log("\n══ Summary ══");
    console.log(`  response_ms         : ${responseMs}`);
    console.log(`  time_to_code_live   : ${codeLive}ms`);
    console.log(`  time_to_hyde_live   : ${hydeLive}ms`);
    console.log(`  time_to_published   : ${published}ms`);
    if (codeLive && hydeLive) console.log(`  decouple gap        : ${((hydeLive - codeLive)/1000).toFixed(1)}s`);

    const hydeComplete = (lastJob?.hyde_completed ?? 0) >= chunks.length * 12 * 0.95;
    const pass = responseMs <= 3000 && codeLive != null && hydeLive != null && hydeComplete;
    console.log(`\n${pass ? "PASS" : "FAIL"} POC 31C`);
    if (!pass) process.exit(1);
  } finally { cleanup(configPath); }
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
