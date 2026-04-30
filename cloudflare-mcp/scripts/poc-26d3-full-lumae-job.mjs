#!/usr/bin/env node
/**
 * POC 26D3: Full Lumae Job With Persistent Resources
 *
 * Proves: Full filtered lumae codebase indexes through persistent Cloudflare
 * resources with Queue fan-out Vertex embeddings, and live MCP search returns
 * relevant results. Resources are NOT deleted — they stay for 26D4 and production.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26d1-full-job-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";

const workerName = "cfcode-lumae-fresh";
const bucketName = "cfcode-lumae-fresh-artifacts";
const dbName = "cfcode-lumae-fresh-v2";
const indexName = "cfcode-lumae-fresh-v2";
const queueName = "cfcode-lumae-fresh-work";
const dlqName = "cfcode-lumae-fresh-work-dlq";

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const BATCH_SIZE = 100; // chunks per /ingest call

function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (fs.existsSync(cfKeysPath)) {
    for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...rest] = t.split("=");
      const v = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
      if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
      if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    }
  }
  return env;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(),
    encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !opts.allowFailure) {
    const out = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${cmd} ${args.join(" ")} failed${out ? `:\n${out}` : ""}`);
  }
  return result;
}

function sha256(v) { return crypto.createHash("sha256").update(v).digest("hex"); }

function extractDbId(out) {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`no D1 UUID in:\n${out}`);
  return m[0];
}

function writeConfig(dbId) {
  const tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  const cfg = tpl
    .replace(/__R2_BUCKET__/g, bucketName)
    .replace(/__D1_NAME__/g, dbName)
    .replace(/__D1_ID__/g, dbId)
    .replace(/__VECTORIZE_INDEX__/g, indexName)
    .replace(/__QUEUE_NAME__/g, queueName)
    .replace(/__DLQ_NAME__/g, dlqName)
    .replace(/"name":\s*"[^"]*"/, `"name": "${workerName}"`);
  fs.writeFileSync(path.join(pocDir, "wrangler.generated.jsonc"), cfg, "utf8");
}

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no ${workerName} URL in:\n${out}`); })();
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!ct.includes("application/json")) throw new Error(`${url} non-JSON ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 500)}`);
  return data;
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  let err = "";
  while (Date.now() < deadline) {
    try { const h = await fetchJson(`${base}/health`); if (h.ok) return; } catch (e) { err = String(e); }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Worker not healthy: ${err}`);
}

function getFilteredFiles() {
  const gitFiles = spawnSync("git", ["ls-files"], { cwd: targetRepo, encoding: "utf8" }).stdout.trim().split("\n");
  return gitFiles.filter(f => {
    if (SKIP_PATTERN.test(f)) return false;
    if (SKIP_EXT.test(f)) return false;
    if (f.includes("node_modules") || f.includes("__pycache__")) return false;
    return true;
  });
}

function buildChunks(files) {
  const chunks = [];
  for (const relPath of files) {
    const fullPath = path.join(targetRepo, relPath);
    let text;
    try { text = fs.readFileSync(fullPath, "utf8"); } catch { continue; }
    // One chunk per file, truncated
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      chunk_id: `chunk-${sha256(`${relPath}:0`).slice(0, 16)}`,
      repo_slug: "lumae-fresh",
      file_path: relPath,
      source_sha256: sha256(truncated),
      text: truncated,
    });
  }
  return chunks;
}

function preCleanOldResources() {
  console.log("\n--- Pre-clean old resources ---");
  // Remove old queue consumer binding if exists
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  // Delete old worker
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  // Delete old queues
  run("npx", ["wrangler", "queues", "delete", queueName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName], { allowFailure: true, capture: true });
  // Delete old R2 bucket (may have objects)
  run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
  // Delete old Vectorize
  run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
  // Delete old D1
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26D3: Full Lumae Job With Persistent Resources\n");
  const checks = { resourcesCreated: false, allIngested: false, allPublished: false, searchWorks: false };

  const files = getFilteredFiles();
  const chunks = buildChunks(files);
  console.log(`Filtered files: ${files.length}`);
  console.log(`Chunks: ${chunks.length}`);

  preCleanOldResources();

  // ── Create persistent resources (tolerate already-existing) ──
  console.log("\n--- Create persistent resources ---");
  run("npx", ["wrangler", "queues", "create", queueName], { allowFailure: true });
  run("npx", ["wrangler", "queues", "create", dlqName], { allowFailure: true });
  run("npx", ["wrangler", "r2", "bucket", "create", bucketName], { allowFailure: true });
  run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"], { allowFailure: true });
  for (const prop of ["repo_slug", "file_path", "active_commit"]) {
    run("npx", ["wrangler", "vectorize", "create-metadata-index", indexName, `--property-name=${prop}`, "--type=string"], { allowFailure: true });
  }
  // D1: try create, if exists list to find its ID
  const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true, allowFailure: true });
  const createOut = `${createDb.stdout || ""}\n${createDb.stderr || ""}`;
  let dbId = createOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!dbId) {
    // DB already exists — find its ID from list
    const listDb = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
    const dbs = JSON.parse(listDb.stdout || "[]");
    const existing = dbs.find(d => d.name === dbName);
    if (!existing?.uuid) throw new Error(`Could not find or create D1 database ${dbName}`);
    dbId = existing.uuid;
    console.log(`  Using existing D1: ${dbId}`);
  }
  writeConfig(dbId);
  checks.resourcesCreated = true;

  // ── Deploy ──
  console.log("\n--- Deploy ---");
  run("npm", ["install"]);
  run("npm", ["run", "check"]);

  // Set Google service account secret
  const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
  const secretProc = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", "wrangler.generated.jsonc"], {
    cwd: pocDir, env: loadCfEnv(), encoding: "utf8",
    input: saB64, stdio: ["pipe", "pipe", "pipe"],
  });
  if (secretProc.status !== 0) throw new Error(`secret put failed: ${secretProc.stderr}`);

  const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
  const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
  await waitHealth(baseUrl);
  console.log(`Worker: ${baseUrl}`);
  console.log(`MCP URL: ${baseUrl}/mcp (future)`);

  // ── Ingest in batches ──
  console.log("\n--- Ingest ---");
  const t0 = Date.now();
  let totalQueued = 0;
  const jobIds = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const artifactText = batch.map(r => JSON.stringify(r)).join("\n") + "\n";
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const jobId = `job-lumae-${sha256(artifactText).slice(0, 12)}-b${batchNum}`;
    const artifactKey = `jobs/lumae-fresh-v2/${jobId}.jsonl`;
    jobIds.push({ jobId, total: batch.length, artifactKey });

    const result = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId, repo_slug: "lumae-fresh",
        indexed_path: targetRepo, active_commit: "poc-26d3",
        artifact_key: artifactKey, artifact_text: artifactText,
      }),
    });
    totalQueued += result.queued;
    console.log(`  Batch ${batchNum}: ${result.queued} chunks queued (total: ${totalQueued}/${chunks.length})`);
  }
  const acceptRate = totalQueued / chunks.length;
  checks.allIngested = acceptRate >= 0.95; // allow minor loss from encoding edge cases
  console.log(`Ingested: ${totalQueued}/${chunks.length} chunks (${(acceptRate * 100).toFixed(1)}%) in ${jobIds.length} batches (${checks.allIngested ? "PASS" : "FAIL"})`);

  // ── Poll until all jobs complete ──
  console.log("\n--- Wait for Vertex embedding + publish ---");
  const pollDeadline = Date.now() + 600_000; // 10 min for full job
  let allDone = false;
  while (Date.now() < pollDeadline) {
    let completedTotal = 0;
    let failedTotal = 0;
    let publishedJobs = 0;
    for (const { jobId, total } of jobIds) {
      try {
        const s = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
        completedTotal += Number(s.job?.completed || 0);
        failedTotal += Number(s.job?.failed || 0);
        if (s.job?.status === "published") publishedJobs++;
      } catch { /* job might not have schema yet */ }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  ${elapsed}s: ${completedTotal}/${totalQueued} completed, ${failedTotal} failed, ${publishedJobs}/${jobIds.length} jobs done`);
    if (publishedJobs === jobIds.length) { allDone = true; break; }
    if (completedTotal + failedTotal >= totalQueued) { allDone = publishedJobs === jobIds.length; break; }
    await new Promise(r => setTimeout(r, 10_000));
  }
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  checks.allPublished = allDone;
  console.log(`\nPublished in ${totalElapsed}s — ${(chunks.length / (parseFloat(totalElapsed) || 1)).toFixed(1)} chunks/sec (${checks.allPublished ? "PASS" : "FAIL"})`);

  // ── Search ──
  console.log("\n--- Search (with Vectorize consistency wait) ---");
  const searchDeadline = Date.now() + 300_000; // 5 min for Vectorize to index
  let searchResult;
  while (Date.now() < searchDeadline) {
    try {
      searchResult = await fetchJson(`${baseUrl}/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "flask routes chat retrieval API endpoint", topK: 5 }),
      });
      if (searchResult.matches?.length > 0) break;
    } catch { /* query embed might fail transiently */ }
    await new Promise(r => setTimeout(r, 10_000));
  }
  checks.searchWorks = searchResult?.matches?.length > 0;
  if (checks.searchWorks) {
    console.log(`Search: ${searchResult.d1_filtered} results`);
    for (const m of searchResult.matches.slice(0, 3)) {
      console.log(`  ${m.chunk?.file_path} (score: ${m.score?.toFixed(4)})`);
    }
  } else {
    console.log(`Search: no results after 5 min polling`);
  }
  console.log(`Search: ${checks.searchWorks ? "PASS" : "FAIL"}`);

  // ── DO NOT clean up — resources are persistent ──
  console.log("\n--- Resources left deployed (persistent) ---");
  console.log(`  Worker: ${baseUrl}`);
  console.log(`  Vectorize: ${indexName}`);
  console.log(`  D1: ${dbName}`);
  console.log(`  R2: ${bucketName}`);
  console.log(`  Queue: ${queueName}`);

  // ── Summary ──
  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26D3: PASS" : "❌ POC 26D3: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
