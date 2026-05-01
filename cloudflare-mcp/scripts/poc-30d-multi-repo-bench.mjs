#!/usr/bin/env node
/**
 * POC 30D: 4-codebase multi-repo bench against 30c dual-fanout worker.
 *
 * Deploys 30c-dual-fanout worker once with throwaway resources, then runs
 * /ingest-sharded against four codebases sequentially. Captures per-repo
 * bench + a summary. Cleans up at end.
 *
 * Repos:
 *   - launcher
 *   - cfpubsub-scaffold
 *   - reviewer-s-workbench
 *   - node-orchestrator
 *
 * Run: node cloudflare-mcp/scripts/poc-30d-multi-repo-bench.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerDir = path.resolve(__dirname, "../poc/30c-dual-fanout");
const outDir = path.resolve(__dirname, "../poc/30d-multi-repo");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const sa1Path = "/Users/awilliamspcsevents/Downloads/team (1).json";
const sa2Path = "/Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json";

const TARGET_REPOS = [
  { name: "launcher", path: "/Users/awilliamspcsevents/PROJECTS/launcher" },
  { name: "cfpubsub-scaffold", path: "/Users/awilliamspcsevents/PROJECTS/cfpubsub-scaffold" },
  { name: "reviewer-s-workbench", path: "/Users/awilliamspcsevents/PROJECTS/reviewer-s-workbench" },
  { name: "node-orchestrator", path: "/Users/awilliamspcsevents/PROJECTS/node-orchestrator" },
];

const TAG = "30d";
const workerName = `cfcode-poc-${TAG}-multirepo`;
const dbName = `cfcode-poc-${TAG}-multirepo`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;
const BASELINE_CPS = 6.041;

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
    cwd: opts.cwd || workerDir, env: opts.env || loadCfEnv(), encoding: "utf8",
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
function listSourceFiles(repoPath) {
  const r = spawnSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(f =>
    f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__")
  );
}
function buildChunks(repoPath, slug) {
  const files = listSourceFiles(repoPath);
  const chunks = [];
  let skippedTooBig = 0; let skippedEmpty = 0;
  for (const rel of files) {
    const full = path.join(repoPath, rel);
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) continue;
    if (stat.size > MAX_FILE_BYTES) { skippedTooBig++; continue; }
    let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.trim()) { skippedEmpty++; continue; }
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: slug, file_path: rel,
      source_sha256: crypto.createHash("sha256").update(truncated).digest("hex"),
      text: truncated,
    });
  }
  return { chunks, files_total: files.length, skippedTooBig, skippedEmpty };
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

async function ingestRepo(baseUrl, repo) {
  const slug = `${repo.name}-${TAG}`;
  const { chunks, files_total, skippedTooBig, skippedEmpty } = buildChunks(repo.path, slug);
  if (chunks.length === 0) {
    return { name: repo.name, path: repo.path, error: "no chunks built" };
  }
  const artifactKey = `${TAG}/${slug}/${Date.now()}.jsonl`;
  const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
  const jobId = `j${TAG}-${slug}-${Date.now()}`;

  console.log(`\n=== ${repo.name} (${chunks.length} chunks, ${(artifactText.length / 1024).toFixed(0)}KB) ===`);
  const t0 = Date.now();
  const ing = await fetchJson(`${baseUrl}/ingest-sharded`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: slug, indexed_path: repo.path, active_commit: TAG,
      artifact_key: artifactKey, artifact_text: artifactText,
      code_shard_count: 4, hyde_shard_count: 16,
      code_batch_size: 100, hyde_batch_size: 100,
      hyde: true,
    }),
  }, 1);
  const e2e = Date.now() - t0;

  const result = {
    name: repo.name,
    path: repo.path,
    files_total, files_skipped_too_big: skippedTooBig, files_skipped_empty: skippedEmpty,
    chunks: chunks.length,
    artifact_size_kb: +(artifactText.length / 1024).toFixed(1),
    status: ing.status,
    ok: ing.body?.ok === true,
    code: ing.body?.code,
    hyde: ing.body?.hyde,
    total_wall_ms: ing.body?.total_wall_ms ?? e2e,
    client_e2e_wall_ms: e2e,
    server_status: ing.body?.status,
    error_excerpt: ing.body?.ok ? null : JSON.stringify(ing.body).slice(0, 300),
  };
  if (result.code) {
    console.log(`code: ${result.code.completed}/${chunks.length} in ${result.code.wall_ms}ms = ${result.code.chunks_per_sec} cps, errors=${result.code.errors}`);
  }
  if (result.hyde) {
    console.log(`hyde: ${result.hyde.hyde_completed}/${chunks.length * 12} in ${result.hyde.wall_ms}ms = ${result.hyde.vectors_per_sec} vps, errors=${result.hyde.errors}`);
  }
  console.log(`e2e: ${e2e}ms (${(e2e / 1000).toFixed(1)}s)`);
  return result;
}

async function main() {
  console.log("POC 30D: 4-codebase multi-repo bench\n");
  const summary = {
    poc: "30d",
    note: "4 codebases through 30c dual-fanout worker (one shared deploy)",
    baseline_chunks_per_sec: BASELINE_CPS,
    started_at: new Date().toISOString(),
    repos: [],
  };
  let configPath;

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true, allowFailure: true });
    const d1Id = ensureD1();
    configPath = writeWranglerConfig(d1Id);

    run("npm", ["install"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
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
    await waitHealth(baseUrl);

    for (const repo of TARGET_REPOS) {
      try {
        const r = await ingestRepo(baseUrl, repo);
        summary.repos.push(r);
        // small pause to settle
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.error(`${repo.name} bench failed: ${e instanceof Error ? e.message : e}`);
        summary.repos.push({ name: repo.name, path: repo.path, error: String(e instanceof Error ? e.message : e) });
      }
    }

    summary.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "bench-30d.json"), JSON.stringify(summary, null, 2), "utf8");
  } finally {
    cleanup(configPath);
  }

  // Pretty per-repo + summary report
  console.log("\n══════════════════════════════════════════");
  console.log("Multi-repo benchmark summary");
  console.log("══════════════════════════════════════════");
  for (const r of summary.repos) {
    if (r.error && !r.code) {
      console.log(`\n${r.name}: ERROR ${r.error}`);
      continue;
    }
    const codeWall = r.code?.wall_ms ?? 0;
    const hydeWall = r.hyde?.wall_ms ?? 0;
    const totalWall = r.total_wall_ms ?? 0;
    const cps = r.code?.chunks_per_sec ?? 0;
    const vps = r.hyde?.vectors_per_sec ?? 0;
    const codeOK = r.code ? r.code.completed === r.chunks && r.code.errors === 0 : false;
    const hydeRate = r.hyde ? (r.hyde.hyde_completed / (r.chunks * 12) * 100).toFixed(1) : "0";
    console.log(`\n${r.name} (${r.chunks} chunks, ${r.artifact_size_kb}KB)`);
    console.log(`  code path: ${r.code?.completed ?? 0}/${r.chunks} in ${(codeWall/1000).toFixed(1)}s = ${cps} cps ${codeOK ? "✓" : `errors=${r.code?.errors ?? 0}`}`);
    console.log(`  hyde path: ${r.hyde?.hyde_completed ?? 0}/${r.chunks * 12} (${hydeRate}%) in ${(hydeWall/1000).toFixed(1)}s = ${vps} vps`);
    console.log(`  TOTAL e2e: ${(totalWall/1000).toFixed(1)}s`);
  }
  console.log("\n──────────────────────────────────────────");
  // Find fastest e2e
  const ok = summary.repos.filter(r => r.code && r.hyde);
  if (ok.length > 0) {
    const fastest = [...ok].sort((a, b) => (a.total_wall_ms ?? 0) - (b.total_wall_ms ?? 0))[0];
    const slowest = [...ok].sort((a, b) => (b.total_wall_ms ?? 0) - (a.total_wall_ms ?? 0))[0];
    const totalChunks = ok.reduce((s, r) => s + (r.chunks ?? 0), 0);
    const totalHyde = ok.reduce((s, r) => s + (r.hyde?.hyde_completed ?? 0), 0);
    const totalE2E = ok.reduce((s, r) => s + (r.total_wall_ms ?? 0), 0);
    console.log(`Fastest e2e:  ${fastest.name} = ${(fastest.total_wall_ms/1000).toFixed(1)}s (${fastest.chunks} chunks)`);
    console.log(`Slowest e2e:  ${slowest.name} = ${(slowest.total_wall_ms/1000).toFixed(1)}s (${slowest.chunks} chunks)`);
    console.log(`Aggregate:    ${totalChunks} chunks + ${totalHyde} hyde rows in ${(totalE2E/1000).toFixed(1)}s sequential e2e`);
  }
  console.log(`\nbench-30d.json: ${path.join(outDir, "bench-30d.json")}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
