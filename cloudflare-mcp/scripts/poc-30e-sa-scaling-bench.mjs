#!/usr/bin/env node
/**
 * POC 30E: SA scaling — does adding 3rd / 4th SA actually buy us more
 * Vertex headroom?
 *
 * SA1 (evrylo)               — billing acct A
 * SA2 (underwriter-agent)    — billing acct B
 * SA3 (big-maxim-331514)     — billing acct C
 * SA4 (embedding-code-495015) — billing acct C (same as SA3)
 *
 * Three benches on lumae 632 chunks (decoupled fan-out, code+hyde):
 *   Run A: NUM_SAS=2, hyde_shard_count=16 (baseline = 30C result)
 *   Run B: NUM_SAS=3, hyde_shard_count=24 (adds SA3 — different billing)
 *   Run C: NUM_SAS=4, hyde_shard_count=32 (adds SA4 — SAME billing as SA3)
 *
 * If Run B faster than A → adding more SAs/projects helps (consistent w/ project-level quota)
 * If Run C faster than B → quota IS per-project even within shared billing
 * If Run C ≈ Run B → billing-account cap dominates, more projects in same billing don't help
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/30c-dual-fanout");
const outDir = path.resolve(__dirname, "../poc/30e-sa-scaling");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const SA_DIR = "/Users/awilliamspcsevents/.config/cfcode/sas";
const SA_PATHS = {
  1: path.join(SA_DIR, "team (1).json"),
  2: path.join(SA_DIR, "underwriter-agent-479920-af2b45745dac.json"),
  3: path.join(SA_DIR, "big-maxim-331514-b90fae4428bc.json"),
  4: path.join(SA_DIR, "embedding-code-495015-2fa24eece6fa.json"),
};
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const TAG = "30e";
const workerName = `cfcode-poc-${TAG}-sascaling`;
const dbName = `cfcode-poc-${TAG}-sascaling`;
const r2Bucket = `cfcode-poc-${TAG}-artifacts`;
const vecIndex = `cfcode-poc-${TAG}-vec`;

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
    } catch (e) { lastErr = e; if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
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
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) continue;
    let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: slug, file_path: rel,
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
async function runBench(baseUrl, label, numSAs, hydeShards, chunks) {
  const slug = `lumae-${label.toLowerCase().replace(/\s+/g, "-")}-${TAG}`;
  const cellChunks = chunks.map(c => ({ ...c, repo_slug: slug }));
  const artifactKey = `${TAG}/${slug}/${Date.now()}.jsonl`;
  const artifactText = cellChunks.map(c => JSON.stringify(c)).join("\n") + "\n";
  const jobId = `j${TAG}-${slug}-${Date.now()}`;
  console.log(`\n=== ${label} (NUM_SAS=${numSAs}, hyde_shard_count=${hydeShards}) ===`);
  const t0 = Date.now();
  const ing = await fetchJson(`${baseUrl}/ingest-sharded`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: slug, indexed_path: lumaePath, active_commit: TAG,
      artifact_key: artifactKey, artifact_text: artifactText,
      code_shard_count: 4, hyde_shard_count: hydeShards,
      code_batch_size: 100, hyde_batch_size: 100,
      num_sas: numSAs, hyde: true,
    }),
  });
  const e2e = Date.now() - t0;
  console.log(`status=${ing.status} client_e2e=${e2e}ms server_total=${ing.body?.total_wall_ms}ms`);
  if (ing.body?.code) console.log(`code: ${ing.body.code.completed}/${chunks.length} in ${ing.body.code.wall_ms}ms`);
  if (ing.body?.hyde) console.log(`hyde: ${ing.body.hyde.hyde_completed}/${chunks.length * 12} (${(ing.body.hyde.hyde_completed/(chunks.length*12)*100).toFixed(1)}%) in ${ing.body.hyde.wall_ms}ms, errors=${ing.body.hyde.errors}`);
  return {
    label, num_sas: numSAs, hyde_shard_count: hydeShards,
    status: ing.status, ok: ing.body?.ok === true,
    code: ing.body?.code, hyde: ing.body?.hyde,
    total_wall_ms: ing.body?.total_wall_ms ?? e2e,
    client_e2e_wall_ms: e2e,
  };
}

async function main() {
  console.log("POC 30E: SA scaling test\n");
  const summary = {
    poc: "30e",
    note: "compare 2-SA, 3-SA, 4-SA configs; SA3+SA4 share billing account",
    sas: {
      1: "evrylo (billing A)",
      2: "underwriter-agent-479920 (billing B)",
      3: "big-maxim-331514 (billing C)",
      4: "embedding-code-495015 (billing C, same as SA3)",
    },
    runs: [],
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

    run("npm", ["install"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    console.log(`Worker: ${baseUrl}`);

    const env = loadCfEnv();
    if (!env._DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing in .cfapikeys");
    const secrets = [
      ["GEMINI_SERVICE_ACCOUNT_B64", Buffer.from(fs.readFileSync(SA_PATHS[1], "utf8")).toString("base64")],
      ["GEMINI_SERVICE_ACCOUNT_B64_2", Buffer.from(fs.readFileSync(SA_PATHS[2], "utf8")).toString("base64")],
      ["GEMINI_SERVICE_ACCOUNT_B64_3", Buffer.from(fs.readFileSync(SA_PATHS[3], "utf8")).toString("base64")],
      ["GEMINI_SERVICE_ACCOUNT_B64_4", Buffer.from(fs.readFileSync(SA_PATHS[4], "utf8")).toString("base64")],
      ["DEEPSEEK_API_KEY", env._DEEPSEEK_API_KEY],
    ];
    for (const [name, val] of secrets) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", configPath],
        { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const chunks = buildChunks("lumae");
    console.log(`${chunks.length} chunks`);

    // Run A: 2 SAs, 16 hyde shards (baseline)
    summary.runs.push(await runBench(baseUrl, "A_2sas_16shards", 2, 16, chunks));
    await new Promise(r => setTimeout(r, 5000));

    // Run B: 3 SAs, 24 hyde shards (adds SA3 — different billing)
    summary.runs.push(await runBench(baseUrl, "B_3sas_24shards", 3, 24, chunks));
    await new Promise(r => setTimeout(r, 5000));

    // Run C: 4 SAs, 32 hyde shards (adds SA4 — same billing as SA3)
    summary.runs.push(await runBench(baseUrl, "C_4sas_32shards", 4, 32, chunks));

    summary.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "bench-30e.json"), JSON.stringify(summary, null, 2), "utf8");
  } finally {
    cleanup(configPath);
  }

  console.log("\n══════════════════════════════════════════");
  console.log("SA scaling comparison");
  console.log("══════════════════════════════════════════");
  for (const r of summary.runs) {
    if (!r.code || !r.hyde) { console.log(`\n${r.label}: ERROR`); continue; }
    const codeWall = r.code.wall_ms;
    const hydeWall = r.hyde.wall_ms;
    const total = r.total_wall_ms;
    const hydePct = (r.hyde.hyde_completed / (632 * 12) * 100).toFixed(1);
    console.log(`\n${r.label}: NUM_SAS=${r.num_sas} hyde_shards=${r.hyde_shard_count}`);
    console.log(`  code: ${r.code.completed}/632 in ${(codeWall/1000).toFixed(1)}s (${r.code.errors} err)`);
    console.log(`  hyde: ${r.hyde.hyde_completed}/${632*12} (${hydePct}%) in ${(hydeWall/1000).toFixed(1)}s (${r.hyde.errors} err)`);
    console.log(`  TOTAL e2e: ${(total/1000).toFixed(1)}s`);
  }
  console.log("\n──────────────────────────────────────────");
  const A = summary.runs.find(r => r.label === "A_2sas_16shards");
  const B = summary.runs.find(r => r.label === "B_3sas_24shards");
  const C = summary.runs.find(r => r.label === "C_4sas_32shards");
  if (A?.total_wall_ms && B?.total_wall_ms && C?.total_wall_ms) {
    const aTotal = A.total_wall_ms, bTotal = B.total_wall_ms, cTotal = C.total_wall_ms;
    console.log(`A → B: ${aTotal}ms → ${bTotal}ms (${((1 - bTotal/aTotal) * 100).toFixed(1)}% reduction)`);
    console.log(`B → C: ${bTotal}ms → ${cTotal}ms (${((1 - cTotal/bTotal) * 100).toFixed(1)}% reduction)`);
    console.log("");
    console.log("Interpretation:");
    if (bTotal < aTotal * 0.9) {
      console.log("  ✓ Run B was meaningfully faster than Run A — adding 3rd SA helped");
      if (cTotal < bTotal * 0.9) {
        console.log("  ✓ Run C was meaningfully faster than Run B — quota appears PROJECT-LEVEL even within shared billing");
      } else if (cTotal < bTotal * 1.1) {
        console.log("  ~ Run C ≈ Run B — billing-account cap dominates; SA4 did not add headroom");
      } else {
        console.log("  ✗ Run C SLOWER than B — SA4's project may be hitting independent throttle");
      }
    } else {
      console.log("  ~ Run B did not improve materially — billing-account cap may be binding from the start");
    }
  }
  console.log(`\nbench-30e.json: ${path.join(outDir, "bench-30e.json")}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
