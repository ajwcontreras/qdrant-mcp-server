#!/usr/bin/env node
/**
 * POC 26E4: Cloudflare Incremental Job Processes Diff Manifest
 *
 * Proves: Worker accepts a diff artifact (records + tombstones), deactivates
 * stale per-file chunks, queues whole-file re-embedding, advances git state on
 * completion, and search results no longer surface tombstoned files.
 *
 * Strategy:
 * 1. Throwaway resources (Worker, D1, R2, Vectorize, Queue, DLQ).
 * 2. SEED a "before" state with deterministic fake embeddings (5 files).
 * 3. APPLY incremental artifact: 1 modified + 1 renamed + 1 deleted (tombstone).
 * 4. Verify all 6 pass criteria.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/26e4-incremental-worker");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";

const workerName = "cfcode-poc-26e4-incremental";
const dbName = "cfcode-poc-26e4-incremental";
const r2Bucket = "cfcode-poc-26e4-artifacts";
const vecIndex = "cfcode-poc-26e4-vec";
const queueName = "cfcode-poc-26e4-work";
const dlqName = "cfcode-poc-26e4-dlq";

const repoSlug = "test-incremental-repo";
const baseCommit = "aaaaaaaa00000000";
const targetCommit = "bbbbbbbb11111111";
const manifestId = "manifest-26e4-test";

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

function extractDbId(out) {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`no D1 UUID in:\n${out}`);
  return m[0];
}

function writeConfig(dbId) {
  const tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  const filled = tpl
    .replace("__R2_BUCKET__", r2Bucket)
    .replace("__D1_NAME__", dbName)
    .replace("__D1_ID__", dbId)
    .replace("__VECTORIZE_INDEX__", vecIndex)
    .replaceAll("__QUEUE_NAME__", queueName)
    .replace("__DLQ_NAME__", dlqName);
  fs.writeFileSync(path.join(pocDir, "wrangler.generated.jsonc"), filled, "utf8");
}

function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL in:\n${out}`); })();
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    throw new Error(`${url} non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const h = await fetchJson(`${base}/health`); if (h.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("Worker not healthy");
}

async function pollPublished(base, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetchJson(`${base}/jobs/${jobId}/status`);
    if (last.ok && last.job?.status === "published") return last;
    if (last.ok && last.job?.failed > 0) throw new Error(`job failed: ${JSON.stringify(last.job)}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`job not published in ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

function sha16(v) { return crypto.createHash("sha256").update(v).digest("hex").slice(0, 16); }
function chunkId(filePath) { return `chunk-${sha16(`${filePath}:0`)}`; }

function cleanup() {
  console.log("\n--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

async function main() {
  console.log("POC 26E4: Cloudflare Incremental Job Processes Diff Manifest\n");
  const checks = {
    queuesOnlyChanged: false,
    deletedTombstoned: false,
    modifiedReplaced: false,
    countersDistinct: false,
    gitAdvanced: false,
    renameTombstonePlusAdd: false,
    cleanedUp: false,
  };

  // Pre-state files (seeded "before"):
  const SEED_FILES = [
    { file_path: "src/keep.py",      text: "def keep(): pass" },         // untouched
    { file_path: "src/modify.py",    text: "def old_modify(): pass" },   // will be modified
    { file_path: "src/delete.py",    text: "def to_delete(): pass" },    // will be tombstoned
    { file_path: "src/rename_old.py",text: "def renamed_body(): pass" }, // will be renamed (old path tombstoned)
    { file_path: "src/untouched.py", text: "def untouched(): pass" },    // untouched
  ].map(f => ({ ...f, chunk_id: chunkId(f.file_path) }));

  // Incremental artifact:
  // - modified: src/modify.py (record with action=modified)
  // - renamed:  src/rename_new.py (record with action=renamed, previous_path=src/rename_old.py)
  // - deleted:  src/delete.py (tombstone)
  const MODIFY_NEW = { file_path: "src/modify.py",     text: "def new_modify_body(): return 1" };
  const RENAME_NEW = { file_path: "src/rename_new.py", text: "def renamed_body(): pass",         previous_path: "src/rename_old.py" };
  const DELETE_PATH = "src/delete.py";

  if (!fs.existsSync(saPath)) throw new Error(`Service account not found: ${saPath}`);
  const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");

  try {
    cleanup();

    console.log("--- Create resources ---");
    run("npx", ["wrangler", "queues", "create", dlqName], { capture: true });
    run("npx", ["wrangler", "queues", "create", queueName], { capture: true });
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true });
    // Metadata indexes BEFORE inserts (26D0 contract)
    for (const prop of ["repo_slug", "file_path", "active_commit"]) {
      run("npx", ["wrangler", "vectorize", "create-metadata-index", vecIndex, "--property-name", prop, "--type=string"], { allowFailure: true, capture: true });
    }
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    writeConfig(extractDbId(`${createDb.stdout}\n${createDb.stderr}`));

    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });

    console.log("--- Deploy Worker ---");
    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${deploy.stdout}\n${deploy.stderr}`);

    // Set secret (wrangler secret put reads value from stdin)
    const sec = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", "wrangler.generated.jsonc"], {
      cwd: pocDir, env: loadCfEnv(), input: saB64, encoding: "utf8",
    });
    if (sec.status !== 0) throw new Error(`secret put failed:\n${sec.stdout}\n${sec.stderr}`);

    await waitHealth(baseUrl);
    console.log(`Worker: ${baseUrl}`);

    // SEED
    console.log("\n--- Seed prior state (5 files) ---");
    const seedRes = await fetchJson(`${baseUrl}/seed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: "seed-job", repo_slug: repoSlug, active_commit: baseCommit, files: SEED_FILES,
      }),
    });
    if (!seedRes.ok || seedRes.seeded !== 5) throw new Error(`seed failed: ${JSON.stringify(seedRes)}`);
    console.log(`Seeded: ${seedRes.seeded} files`);

    // Verify pre-state: all 5 files active in D1
    const preState = await fetchJson(`${baseUrl}/search-active`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug }),
    });
    console.log(`Pre-state active chunks: ${preState.matches.length}`);
    if (preState.matches.length !== 5) throw new Error(`expected 5 active chunks pre-incremental, got ${preState.matches.length}`);

    // Build incremental artifact (26E3 format)
    const tombstone = { action: "tombstone", file_path: DELETE_PATH, manifest_id: manifestId, repo_slug: repoSlug };
    const modifiedRecord = {
      chunk_id: chunkId(MODIFY_NEW.file_path), repo_slug: repoSlug,
      file_path: MODIFY_NEW.file_path, source_sha256: sha16(MODIFY_NEW.text),
      text: MODIFY_NEW.text, manifest_id: manifestId, action: "modified", previous_path: null,
    };
    const renameRecord = {
      chunk_id: chunkId(RENAME_NEW.file_path), repo_slug: repoSlug,
      file_path: RENAME_NEW.file_path, source_sha256: sha16(RENAME_NEW.text),
      text: RENAME_NEW.text, manifest_id: manifestId, action: "renamed", previous_path: RENAME_NEW.previous_path,
    };
    const artifactText = [JSON.stringify(modifiedRecord), JSON.stringify(renameRecord), JSON.stringify(tombstone)].join("\n") + "\n";

    // INCREMENTAL INGEST
    console.log("\n--- Incremental ingest (1 modified + 1 renamed + 1 deleted) ---");
    const jobId = `inc-job-${Date.now()}`;
    const ingestRes = await fetchJson(`${baseUrl}/incremental-ingest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId, repo_slug: repoSlug, manifest_id: manifestId,
        base_commit: baseCommit, target_commit: targetCommit,
        artifact_key: `incremental/${manifestId}.jsonl`, artifact_text: artifactText,
      }),
    });
    console.log(`Ingest: ${JSON.stringify(ingestRes)}`);

    // Check 1: queues only changed source files (2 records, not 5)
    checks.queuesOnlyChanged = ingestRes.queued === 2;
    console.log(`queuesOnlyChanged: ${checks.queuesOnlyChanged ? "PASS" : "FAIL"} (queued=${ingestRes.queued}, expected 2)`);

    // Check 4 (counters distinct): manifest_files=3, changed=2, deleted=1
    checks.countersDistinct = ingestRes.manifest_files === 3 && ingestRes.changed_files === 2 && ingestRes.deleted_files === 1;
    console.log(`countersDistinct: ${checks.countersDistinct ? "PASS" : "FAIL"} (manifest=${ingestRes.manifest_files}, changed=${ingestRes.changed_files}, deleted=${ingestRes.deleted_files})`);

    // Wait for queue processing
    console.log("\n--- Wait for job to publish ---");
    const finalJob = await pollPublished(baseUrl, jobId);
    console.log(`Job status: ${finalJob.job.status}, completed=${finalJob.job.completed}, total=${finalJob.job.total}`);

    // Check 2: deleted file is tombstoned (no active chunks for src/delete.py)
    const delRows = await fetchJson(`${baseUrl}/search-active`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, file_path: DELETE_PATH }),
    });
    checks.deletedTombstoned = delRows.matches.length === 0;
    console.log(`\ndeletedTombstoned: ${checks.deletedTombstoned ? "PASS" : "FAIL"} (active chunks for ${DELETE_PATH}: ${delRows.matches.length})`);

    // Check 3: modified file replaced — exactly 1 active chunk for src/modify.py with new chunk_id
    const modRows = await fetchJson(`${baseUrl}/search-active`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, file_path: MODIFY_NEW.file_path }),
    });
    const modActive = modRows.matches;
    checks.modifiedReplaced = modActive.length === 1 && modActive[0].chunk_id === modifiedRecord.chunk_id;
    console.log(`modifiedReplaced: ${checks.modifiedReplaced ? "PASS" : "FAIL"} (active for ${MODIFY_NEW.file_path}: ${modActive.length}, chunk_id match: ${modActive[0]?.chunk_id === modifiedRecord.chunk_id})`);

    // Check 6: rename — old path inactive, new path has 1 active chunk
    const oldPathRows = await fetchJson(`${baseUrl}/search-active`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, file_path: RENAME_NEW.previous_path }),
    });
    const newPathRows = await fetchJson(`${baseUrl}/search-active`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: repoSlug, file_path: RENAME_NEW.file_path }),
    });
    checks.renameTombstonePlusAdd = oldPathRows.matches.length === 0 && newPathRows.matches.length === 1
      && newPathRows.matches[0].chunk_id === renameRecord.chunk_id;
    console.log(`renameTombstonePlusAdd: ${checks.renameTombstonePlusAdd ? "PASS" : "FAIL"} (old=${oldPathRows.matches.length}, new=${newPathRows.matches.length})`);

    // Check 5: git state advanced to target_commit
    const gs = await fetchJson(`${baseUrl}/git-state/${repoSlug}`);
    checks.gitAdvanced = gs.ok && gs.state?.active_commit === targetCommit && gs.state?.last_manifest_id === manifestId;
    console.log(`gitAdvanced: ${checks.gitAdvanced ? "PASS" : "FAIL"} (active_commit=${gs.state?.active_commit}, last_manifest_id=${gs.state?.last_manifest_id})`);

  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26E4: PASS" : "❌ POC 26E4: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
