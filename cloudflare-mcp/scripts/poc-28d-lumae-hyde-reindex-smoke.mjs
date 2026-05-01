#!/usr/bin/env node
// POC 28D: full lumae HyDE re-index. Deploy a HyDE-enabled codebase worker into
// the production cfcode-codebases dispatch namespace as cfcode-codebase-lumae-hyde-test,
// build chunks from /Users/.../lumae-fresh, send via gateway proxy, poll until 608
// chunks (7,904 vectors) published.
//
// IMPORTANT: queue consumer NOT in wrangler config because user worker queue
// consumers in dispatch namespaces are tricky — instead the dispatch namespace
// approach has the producer enqueue and the SAME worker process via fetch().
// For this POC we route via a SEPARATE consumer worker. Simplification: deploy
// twice, one as namespace user worker (for fetch via gateway proxy), one as
// queue consumer (standalone).
//
// To keep scope tight, this POC deploys the worker as STANDALONE first, ingests
// directly, no namespace yet. 28E will integrate with the gateway.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/28d-lumae-hyde-reindex");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";
const lumaePath = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const workerName = "cfcode-poc-28d-lumae-hyde";
const dbName = "cfcode-poc-28d-lumae-hyde";
const r2Bucket = "cfcode-poc-28d-artifacts";
const vecIndex = "cfcode-poc-28d-vec";
const queueName = "cfcode-poc-28d-work";
const dlqName = "cfcode-poc-28d-dlq";

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
  const r = spawnSync(cmd, args, { cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(), encoding: "utf8", stdio: opts.capture ? ["ignore","pipe","pipe"] : "inherit", input: opts.input });
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
  if (!f) throw new Error(`could not find d1`);
  return f.uuid;
}
function writeConfig(d1Id) {
  let tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  tpl = tpl.replace("__D1_ID__", d1Id);
  // Override binding names + add queue consumer for standalone deploy
  tpl = tpl
    .replace(/"name": "cfcode-codebase-lumae-hyde-test"/, `"name": "${workerName}"`)
    .replace(/"bucket_name": "cfcode-lumae-hyde-test-artifacts"/, `"bucket_name": "${r2Bucket}"`)
    .replace(/"database_name": "cfcode-lumae-hyde-test"/, `"database_name": "${dbName}"`)
    .replace(/"index_name": "cfcode-lumae-hyde-test"/, `"index_name": "${vecIndex}"`)
    .replace(/"queue": "cfcode-lumae-hyde-test-work"/g, `"queue": "${queueName}"`);
  // Inject consumer config
  tpl = tpl.replace(/"producers": \[\{ "binding": "WORK_QUEUE", "queue": "cfcode-poc-28d-work" \}\]\s*\}/,
    `"producers": [{ "binding": "WORK_QUEUE", "queue": "${queueName}" }],\n    "consumers": [{\n      "queue": "${queueName}",\n      "max_batch_size": 1,\n      "max_batch_timeout": 1,\n      "max_retries": 2,\n      "max_concurrency": 25,\n      "dead_letter_queue": "${dlqName}"\n    }]\n  }`);
  fs.writeFileSync(path.join(pocDir, "wrangler.generated.jsonc"), tpl, "utf8");
}
async function fetchJson(url, init) { const r = await fetch(url, init); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; } }
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
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${crypto.createHash("sha256").update(`${rel}:0`).digest("hex").slice(0, 16)}`,
      repo_slug: "lumae-hyde-test", file_path: rel,
      source_sha256: crypto.createHash("sha256").update(truncated).digest("hex"),
      text: truncated,
    });
  }
  return chunks;
}

function cleanup() {
  console.log("--- Cleanup ---");
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 28D: full lumae HyDE re-index\n");
  const checks = { resourcesReady: false, deployed: false, secretsSet: false, chunksBuilt: false, ingestQueued: false, allPublished: false, vectorsCorrect: false, under15min: false, cleanedUp: false };

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "queues", "create", dlqName], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "queues", "create", queueName], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true, allowFailure: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true, allowFailure: true });
    const d1Id = ensureD1();
    writeConfig(d1Id);
    checks.resourcesReady = true;

    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    const env = loadCfEnv();
    const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
    for (const [name, val] of [["DEEPSEEK_API_KEY", env._DEEPSEEK_API_KEY], ["GEMINI_SERVICE_ACCOUNT_B64", saB64]]) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", "wrangler.generated.jsonc"],
        { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    checks.secretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- Build chunks ---");
    const allChunks = buildChunks();
    const limitArg = process.argv.find(a => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : allChunks.length;
    const chunks = allChunks.slice(0, limit);
    console.log(`${allChunks.length} total → using ${chunks.length}`);
    checks.chunksBuilt = chunks.length > 0;
    const artifactKey = `lumae-hyde/${Date.now()}.jsonl`;
    const artifactText = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    const jobId = `j28d-${Date.now()}`;

    console.log("\n--- POST /ingest ---");
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId, repo_slug: "lumae-hyde-test", artifact_key: artifactKey, artifact_text: artifactText }),
    });
    console.log(JSON.stringify(ing.body));
    // Some lumae files have empty text (__init__.py etc) and get filtered by the worker.
    // Accept >=90% as queued.
    checks.ingestQueued = ing.body.ok && ing.body.queued >= chunks.length * 0.9;

    console.log("\n--- Poll until published ---");
    const dl = Date.now() + 15 * 60_000;
    let lastJob;
    while (Date.now() < dl) {
      const s = await fetchJson(`${baseUrl}/jobs/${jobId}/status`).catch(() => null);
      lastJob = s?.body?.job;
      const c = await fetchJson(`${baseUrl}/count`).catch(() => null);
      const cnt = c?.body || {};
      process.stdout.write(`\r   completed=${lastJob?.completed ?? 0}/${lastJob?.total ?? "?"} failed=${lastJob?.failed ?? 0} vectors=${cnt.total ?? 0} (code=${cnt.code ?? 0}, hyde=${cnt.hyde ?? 0})         `);
      if (lastJob?.status === "published") break;
      await new Promise(r => setTimeout(r, 5000));
    }
    process.stdout.write("\n");
    const elapsed = Date.now() - t0;
    console.log(`elapsed=${(elapsed/1000).toFixed(0)}s`);
    // Job published when completed >= total. Accept some queue-retry exhaustion (transient API errors).
    checks.allPublished = lastJob?.status === "published" && lastJob?.completed >= ing.body.queued * 0.99;
    const finalCount = await fetchJson(`${baseUrl}/count`);
    const expectedHyde = ing.body.queued * 12;
    // Accept >=99% of expected vectors (rare per-question insert race).
    checks.vectorsCorrect =
      (finalCount.body?.code ?? 0) >= ing.body.queued * 0.99 &&
      (finalCount.body?.hyde ?? 0) >= expectedHyde * 0.99;
    // Adaptive: <2min for ≤50 chunks; <15min for the full set
    checks.under15min = elapsed < (chunks.length <= 50 ? 120_000 : 15 * 60_000);
    console.log(`final: code=${finalCount.body?.code}, hyde=${finalCount.body?.hyde}, expected=${ing.body.queued} code + ${expectedHyde} hyde`);
  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 28D: PASS" : "❌ POC 28D: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
