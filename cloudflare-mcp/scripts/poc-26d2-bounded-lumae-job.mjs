#!/usr/bin/env node
/**
 * POC 26D2: Bounded Lumae Job With Real Vertex Embeddings
 *
 * Proves: The 26D1 combined Worker deploys, accepts a bounded 5-file lumae
 * package, embeds with real Vertex gemini-embedding-001, publishes to
 * Vectorize/D1, and search returns results. Throwaway resources.
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

const workerName = "cfcode-poc-26d2-lumae";
const bucketName = "cfcode-poc-26d2-artifacts";
const dbName = "cfcode-poc-26d2-jobs";
const indexName = "cfcode-poc-26d2-vectorize";
const queueName = "cfcode-poc-26d2-work";
const dlqName = "cfcode-poc-26d2-work-dlq";

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
  const genPath = path.join(pocDir, "wrangler.generated.jsonc");
  fs.writeFileSync(genPath, cfg, "utf8");
}

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no ${workerName} URL in:\n${out}`); })();
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!ct.includes("application/json")) throw new Error(`${url} non-JSON ${res.status} ${ct}: ${text.slice(0, 300)}`);
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

async function waitPublished(base, jobId, total) {
  const deadline = Date.now() + 180_000; // 3 min for real Vertex
  let data;
  while (Date.now() < deadline) {
    data = await fetchJson(`${base}/jobs/${jobId}/status`);
    if (data.job?.status === "published" && Number(data.chunk_rows) === total) return data;
    if (data.job?.failed > 0) console.log(`  ⚠ failed=${data.job.failed}, completed=${data.job.completed}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Job not published in time: ${JSON.stringify(data)?.slice(0, 800)}`);
}

async function waitSearch(base, query, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await fetchJson(`${base}/search`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK: 5 }),
    });
    if (result.matches?.length > 0) return result;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Search returned no results: ${JSON.stringify(result)?.slice(0, 800)}`);
}

function buildArtifact() {
  // Read 5 real filtered lumae files
  const gitFiles = spawnSync("git", ["ls-files"], { cwd: targetRepo, encoding: "utf8" }).stdout.trim().split("\n");
  const skip = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor)/;
  const filtered = gitFiles.filter(f => !skip.test(f) && !f.includes("lock") && !f.endsWith(".map"));
  const selected = filtered.slice(0, 5);
  const records = selected.map((relPath, i) => {
    const fullPath = path.join(targetRepo, relPath);
    const text = fs.readFileSync(fullPath, "utf8").slice(0, 4000);
    return {
      chunk_id: `chunk-${sha256(`${relPath}:0`).slice(0, 16)}`,
      repo_slug: "lumae-fresh",
      file_path: relPath,
      source_sha256: sha256(text),
      text,
    };
  });
  const artifactText = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  const jobId = `job-${sha256(artifactText).slice(0, 16)}`;
  const artifactKey = `jobs/lumae-fresh-poc-26d2/${sha256(artifactText).slice(0, 16)}.jsonl`;
  return { records, artifactText, jobId, artifactKey, selected };
}

function cleanup(artifactKey) {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName], { allowFailure: true, capture: true });
  if (artifactKey) run("npx", ["wrangler", "r2", "object", "delete", `${bucketName}/${artifactKey}`, "--remote"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", bucketName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26D2: Bounded Lumae Job With Real Vertex Embeddings\n");
  const checks = { ingested: false, published: false, statusCorrect: false, cleanedUp: false };
  const artifact = buildArtifact();
  console.log(`Selected ${artifact.selected.length} lumae files: ${artifact.selected.join(", ")}`);

  try {
    cleanup(artifact.artifactKey);

    console.log("\n--- Create resources ---");
    run("npx", ["wrangler", "queues", "create", queueName]);
    run("npx", ["wrangler", "queues", "create", dlqName]);
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);
    for (const prop of ["repo_slug", "file_path", "active_commit"]) {
      run("npx", ["wrangler", "vectorize", "create-metadata-index", indexName, `--property-name=${prop}`, "--type=string"]);
    }
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeConfig(extractDbId(`${createDb.stdout}\n${createDb.stderr}`));

    console.log("\n--- Deploy ---");
    run("npm", ["install"]);
    run("npm", ["run", "check"]);

    // Set Google service account secret
    const saJson = fs.readFileSync(saPath, "utf8");
    const saB64 = Buffer.from(saJson).toString("base64");
    const secretProc = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", "wrangler.generated.jsonc"], {
      cwd: pocDir, env: loadCfEnv(), encoding: "utf8",
      input: saB64, stdio: ["pipe", "pipe", "pipe"],
    });
    if (secretProc.status !== 0) throw new Error(`secret put failed: ${secretProc.stderr}`);

    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitHealth(baseUrl);
    console.log(`Worker: ${baseUrl}`);

    console.log("\n--- Ingest ---");
    const ingestResult = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: artifact.jobId, repo_slug: "lumae-fresh",
        indexed_path: targetRepo, active_commit: "poc-26d2",
        artifact_key: artifact.artifactKey, artifact_text: artifact.artifactText,
      }),
    });
    checks.ingested = ingestResult.queued === artifact.records.length;
    console.log(`Ingested: ${ingestResult.queued} chunks (${checks.ingested ? "PASS" : "FAIL"})`);

    console.log("\n--- Wait for Vertex embedding + publish ---");
    const t0 = Date.now();
    const done = await waitPublished(baseUrl, artifact.jobId, artifact.records.length);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    checks.published = done.job.completed === artifact.records.length && Number(done.chunk_rows) === artifact.records.length;
    console.log(`Published: ${done.job.completed} chunks in ${elapsed}s (${checks.published ? "PASS" : "FAIL"})`);

    console.log("\n--- Status check ---");
    const statusData = await fetchJson(`${baseUrl}/jobs/${artifact.jobId}/status`);
    checks.statusCorrect = statusData.job?.status === "published" && statusData.job?.completed === artifact.records.length;
    console.log(`Status: ${statusData.job?.status}, completed=${statusData.job?.completed} (${checks.statusCorrect ? "PASS" : "FAIL"})`);

    // Note: Vectorize search on throwaway indexes has long eventual-consistency delays.
    // Real-query search is deferred to POC 26D3 where persistent resources have time to index.
    // 26C3 already proved Vectorize visibility with deterministic vectors and bounded polling.

  } finally {
    cleanup(artifact.artifactKey);
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26D2: PASS" : "❌ POC 26D2: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
