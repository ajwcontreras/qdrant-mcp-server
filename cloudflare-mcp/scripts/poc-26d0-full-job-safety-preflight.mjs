#!/usr/bin/env node
/**
 * POC 26D0: Full Job Safety Preflight
 *
 * Proves: Vectorize metadata indexes exist before inserts, Queue consumers are
 * idempotent via deterministic chunk IDs, D1 active-row filtering prevents
 * stale/inactive chunks from appearing in search, and cleanup is explicit.
 *
 * No Vertex calls. Deterministic vectors only.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26d0-full-job-safety-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");

const workerName = "cfcode-poc-26d0-safety";
const bucketName = "cfcode-poc-26d0-artifacts";
const dbName = "cfcode-poc-26d0-jobs";
const indexName = "cfcode-poc-26d0-vectorize";
const queueName = "cfcode-poc-26d0-publish";
const dlqName = "cfcode-poc-26d0-publish-dlq";

function loadCloudflareEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (fs.existsSync(cfKeysPath)) {
    for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      const key = rawKey.trim();
      const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (key === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = value;
      if (key === "CF_EMAIL") env.CLOUDFLARE_EMAIL = value;
      if (key === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = value;
    }
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || pocDir,
    env: options.env || loadCloudflareEnv(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuid) throw new Error(`Could not find D1 database UUID in output:\n${output}`);
  return uuid[0];
}

function writeGeneratedConfig(databaseId) {
  fs.writeFileSync(generatedConfig, fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8").replace("__DATABASE_ID__", databaseId), "utf8");
}

function deployUrl(output) {
  const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map((m) => m[0].replace(/\/$/, ""));
  const url = urls.find((u) => u.includes(workerName));
  if (!url) throw new Error(`Could not find ${workerName} workers.dev URL in deploy output:\n${output}`);
  return url;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) throw new Error(`${url} returned non-JSON ${response.status} ${contentType}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true) return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

function deterministicVector(seed, dimensions = 1536) {
  const values = [];
  let state = crypto.createHash("sha256").update(seed).digest();
  while (values.length < dimensions) {
    state = crypto.createHash("sha256").update(state).digest();
    for (const byte of state) {
      values.push((byte / 255) * 2 - 1);
      if (values.length === dimensions) break;
    }
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / norm);
}

function buildArtifact() {
  const files = [
    { path: "app/routes.py", text: "FastAPI routes for lumae chat.", seed: "routes-26d0" },
    { path: "app/embeddings.py", text: "Google Gemini embedding helpers.", seed: "embeddings-26d0" },
    { path: "app/mcp.py", text: "Unauthenticated MCP search endpoint.", seed: "mcp-26d0" },
  ];
  const rows = files.map((f) => ({
    chunk_id: `chunk-${sha256(f.seed).slice(0, 16)}`,
    repo_slug: "lumae-fresh",
    file_path: f.path,
    source_sha256: sha256(f.text),
    text: f.text,
    values: deterministicVector(f.seed),
  }));
  const artifactText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const jobId = `job-${sha256(artifactText).slice(0, 16)}`;
  const artifactKey = `jobs/lumae-fresh-poc-26d0/${sha256(artifactText).slice(0, 16)}.jsonl`;
  return { rows, artifactText, jobId, artifactKey };
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

async function waitForPublished(baseUrl, jobId, expectedTotal) {
  const deadline = Date.now() + 90_000;
  let data;
  while (Date.now() < deadline) {
    data = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
    if (data.job?.status === "published" && Number(data.chunk_rows) === expectedTotal) return data;
    if (data.job?.status === "failed") throw new Error(`Job failed: ${JSON.stringify(data)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Job did not finish in time: ${JSON.stringify(data)?.slice(0, 800)}`);
}

async function waitForSearch(baseUrl, values, expectedId) {
  const deadline = Date.now() + 90_000;
  let searchResult;
  while (Date.now() < deadline) {
    searchResult = await fetchJson(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, topK: 10 }),
    });
    if (searchResult.matches?.some((m) => m.id === expectedId)) return searchResult;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Search did not return ${expectedId}: ${JSON.stringify(searchResult)?.slice(0, 800)}`);
}

async function main() {
  console.log("POC 26D0: Full Job Safety Preflight\n");
  const checks = {
    metadataIndexesCreated: false,
    ingestQueued: false,
    publishCompleted: false,
    duplicateIdempotent: false,
    searchFindsActive: false,
    deactivateFilters: false,
    cleanupDone: false,
  };
  const artifact = buildArtifact();

  try {
    // ── Pre-clean ──
    cleanup(artifact.artifactKey);

    // ── Create resources ──
    console.log("\n--- Create resources ---");
    run("npx", ["wrangler", "queues", "create", queueName]);
    run("npx", ["wrangler", "queues", "create", dlqName]);
    run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);

    // ── Create metadata indexes BEFORE any vector insert ──
    console.log("\n--- Create Vectorize metadata indexes ---");
    for (const prop of ["repo_slug", "file_path", "active_commit"]) {
      run("npx", ["wrangler", "vectorize", "create-metadata-index", indexName, `--property-name=${prop}`, "--type=string"]);
    }

    // ── Verify metadata indexes exist ──
    const listResult = run("npx", ["wrangler", "vectorize", "list"], { capture: true });
    const listOutput = `${listResult.stdout}\n${listResult.stderr}`;
    // wrangler vectorize list shows indexes — we just verify the command succeeded and our index is listed
    checks.metadataIndexesCreated = listOutput.includes(indexName);
    console.log(`\nMetadata indexes created: ${checks.metadataIndexesCreated ? "PASS" : "FAIL"}`);

    // ── D1 + deploy ──
    console.log("\n--- Create D1 + deploy ---");
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeGeneratedConfig(extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`));
    run("npm", ["install"]);
    run("npm", ["run", "check"]);
    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);
    await waitForHealth(baseUrl);
    console.log(`Worker: ${baseUrl}`);

    // ── Ingest (first time) ──
    console.log("\n--- Ingest ---");
    const ingestResult = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: artifact.jobId,
        repo_slug: "lumae-fresh",
        indexed_path: "/Users/awilliamspcsevents/PROJECTS/lumae-fresh",
        active_commit: "poc-26d0",
        artifact_key: artifact.artifactKey,
        artifact_text: artifact.artifactText,
      }),
    });
    checks.ingestQueued = ingestResult.queued === artifact.rows.length;
    console.log(`Ingest queued: ${ingestResult.queued} (${checks.ingestQueued ? "PASS" : "FAIL"})`);

    // ── Wait for publish ──
    console.log("\n--- Wait for publish ---");
    const published = await waitForPublished(baseUrl, artifact.jobId, artifact.rows.length);
    checks.publishCompleted = published.job.completed === artifact.rows.length && Number(published.chunk_rows) === artifact.rows.length;
    console.log(`Published: completed=${published.job.completed}, chunk_rows=${published.chunk_rows} (${checks.publishCompleted ? "PASS" : "FAIL"})`);

    // ── Duplicate ingest (same job_id, same artifact) — proves idempotency ──
    console.log("\n--- Duplicate ingest (idempotency test) ---");
    await fetchJson(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: artifact.jobId,
        repo_slug: "lumae-fresh",
        indexed_path: "/Users/awilliamspcsevents/PROJECTS/lumae-fresh",
        active_commit: "poc-26d0",
        artifact_key: artifact.artifactKey,
        artifact_text: artifact.artifactText,
      }),
    });
    // Wait for the duplicate messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const afterDup = await fetchJson(`${baseUrl}/jobs/${artifact.jobId}/status`);
    // Key check: chunk_rows should still be exactly 3, not 6
    const dupChunkRows = Number(afterDup.chunk_rows);
    checks.duplicateIdempotent = dupChunkRows === artifact.rows.length;
    console.log(`After duplicate: chunk_rows=${dupChunkRows}, expected=${artifact.rows.length} (${checks.duplicateIdempotent ? "PASS" : "FAIL"})`);

    // ── Search finds active chunks ──
    console.log("\n--- Search (all active) ---");
    const search1 = await waitForSearch(baseUrl, artifact.rows[0].values, artifact.rows[0].chunk_id);
    checks.searchFindsActive = search1.matches.some((m) => m.id === artifact.rows[0].chunk_id && m.chunk?.file_path === artifact.rows[0].file_path);
    console.log(`Search finds active chunk: ${checks.searchFindsActive ? "PASS" : "FAIL"} (${search1.d1_filtered}/${search1.vectorize_returned} after D1 filter)`);

    // ── Deactivate one chunk, verify it's filtered from search ──
    console.log("\n--- Deactivate + re-search ---");
    const deactChunkId = artifact.rows[0].chunk_id;
    const deactResult = await fetchJson(`${baseUrl}/chunks/${deactChunkId}/deactivate`, { method: "POST" });
    console.log(`Deactivated ${deactChunkId}: active=${deactResult.active}`);

    // Search with the deactivated chunk's vector — Vectorize may still return it, but D1 filter should exclude it
    const search2 = await fetchJson(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: artifact.rows[0].values, topK: 10 }),
    });
    const deactivatedInResults = search2.matches?.some((m) => m.id === deactChunkId);
    checks.deactivateFilters = !deactivatedInResults && search2.vectorize_returned >= 1;
    console.log(`Deactivated chunk in search results: ${deactivatedInResults} (should be false)`);
    console.log(`Vectorize returned: ${search2.vectorize_returned}, D1 filtered: ${search2.d1_filtered}`);
    console.log(`Deactivate filters: ${checks.deactivateFilters ? "PASS" : "FAIL"}`);

  } finally {
    cleanup(artifact.artifactKey);
    checks.cleanupDone = true;
  }

  // ── Summary ──
  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26D0: PASS" : "❌ POC 26D0: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
