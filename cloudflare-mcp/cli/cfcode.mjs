#!/usr/bin/env node
/**
 * cfcode — global CLI for per-codebase Cloudflare MCP indexing.
 *
 * Commands:
 *   cfcode index <repo-path>           Full-index a codebase (provisions + deploys)
 *   cfcode reindex <repo-path> [--base <ref>] [--target <ref>]
 *                                      Incremental diff reindex (default base = git_state.active_commit)
 *   cfcode status [<repo-path>]        Show indexed state for a repo (or all)
 *   cfcode list                        List all indexed codebases
 *   cfcode uninstall <repo-path>       Tear down all CF resources + clear local state
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "../lib");
const SA_PATH = "/Users/awilliamspcsevents/Downloads/team (1).json";

const {
  loadCfEnv, repoSlugFromPath,
  workerNameForSlug, r2BucketForSlug, d1NameForSlug, vectorizeIndexForSlug, queueNameForSlug, dlqNameForSlug,
} = await import(`${LIB}/env.mjs`);
const { fetchJson, fetchJsonOptional, waitHealth, pollPublished } = await import(`${LIB}/http.mjs`);
const {
  buildFullChunks, buildDiffManifest, buildIncrementalArtifact,
  fullChunksToJsonl, artifactToJsonl, resolveCommit,
} = await import(`${LIB}/files.mjs`);
const { provisionResources, writeWranglerConfig, deployWorker, setVertexSecret, teardownResources } = await import(`${LIB}/cf.mjs`);
const { readState, writeState, deleteState, listIndexedRepos } = await import(`${LIB}/state.mjs`);

function namesForSlug(slug) {
  return {
    workerName: workerNameForSlug(slug),
    r2Bucket: r2BucketForSlug(slug),
    d1Name: d1NameForSlug(slug),
    vectorizeIndex: vectorizeIndexForSlug(slug),
    queueName: queueNameForSlug(slug),
    dlqName: dlqNameForSlug(slug),
  };
}

function configPathFor(slug) {
  return path.resolve(__dirname, `../worker/wrangler.${slug}.jsonc`);
}

function log(msg) { console.log(msg); }
function err(msg) { console.error(msg); }

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function cmdIndex(repoPath) {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(path.join(abs, ".git"))) throw new Error(`${abs} is not a git repo`);
  if (!fs.existsSync(SA_PATH)) throw new Error(`Vertex service account not found at ${SA_PATH}`);

  const slug = repoSlugFromPath(abs);
  const names = namesForSlug(slug);
  log(`\n📦 cfcode index ${abs}`);
  log(`   slug:   ${slug}`);
  log(`   worker: ${names.workerName}\n`);

  log("→ Provisioning Cloudflare resources (idempotent)...");
  const { d1Id } = provisionResources(names, { log: m => log(`  ${m}`) });

  log("→ Writing wrangler config...");
  const configPath = configPathFor(slug);
  writeWranglerConfig(configPath, { ...names, d1Id });

  log("→ Deploying Worker...");
  const workerUrl = deployWorker(configPath);
  log(`   ${workerUrl}`);

  log("→ Setting Vertex SA secret...");
  const saB64 = Buffer.from(fs.readFileSync(SA_PATH, "utf8")).toString("base64");
  setVertexSecret(configPath, saB64);

  log("→ Waiting for Worker health...");
  await waitHealth(workerUrl);

  log("→ Building chunks from repo...");
  const chunks = buildFullChunks(abs, slug);
  log(`   ${chunks.length} chunks`);
  if (!chunks.length) throw new Error("no source files found");

  const activeCommit = resolveCommit(abs, "HEAD");
  const jobId = `job-${slug}-${Date.now().toString(36)}`;
  const artifactKey = `full/${jobId}.jsonl`;
  const artifactText = fullChunksToJsonl(chunks);

  log("→ POST /ingest...");
  const ingestRes = await fetchJson(`${workerUrl}/ingest`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: slug, indexed_path: abs,
      active_commit: activeCommit, artifact_key: artifactKey, artifact_text: artifactText,
    }),
  });
  if (!ingestRes.ok) throw new Error(`ingest failed: ${JSON.stringify(ingestRes)}`);
  log(`   queued: ${ingestRes.queued}`);

  log("→ Polling job until published...");
  const final = await pollPublished(workerUrl, jobId, {
    onProgress: j => process.stdout.write(`\r   ${j.completed}/${j.total} (failed=${j.failed})    `),
  });
  process.stdout.write("\n");
  log(`   status=${final.job.status}, completed=${final.job.completed}/${final.job.total}`);

  writeState(slug, {
    indexed_path: abs,
    worker_url: workerUrl,
    mcp_url: `${workerUrl}/mcp`,
    last_full_job_id: jobId,
    last_full_at: new Date().toISOString(),
    active_commit: activeCommit,
    last_manifest_id: null,
  });
  log(`\n✅ Indexed ${slug}`);
  log(`   MCP URL: ${workerUrl}/mcp`);
  log(`   Status:  cfcode status ${abs}`);
}

async function cmdReindex(repoPath, flags) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);
  const state = readState(slug);
  if (!state) throw new Error(`No indexed state for ${slug}. Run 'cfcode index ${abs}' first.`);

  const workerUrl = state.worker_url;
  const baseRef = flags.base || state.active_commit || "HEAD~1";
  const targetRef = flags.target || "HEAD";
  log(`\n🔁 cfcode reindex ${abs}`);
  log(`   base:   ${baseRef}`);
  log(`   target: ${targetRef}\n`);

  log("→ Building diff manifest...");
  const manifest = buildDiffManifest(abs, slug, baseRef, targetRef);
  log(`   manifest_id: ${manifest.manifest_id}`);
  log(`   files: ${manifest.summary.total} (added=${manifest.summary.added}, modified=${manifest.summary.modified}, deleted=${manifest.summary.deleted}, renamed=${manifest.summary.renamed})`);

  if (manifest.summary.total === 0) {
    log("→ No changes between base and target. Nothing to do.");
    return;
  }

  log("→ Packaging incremental artifact...");
  const { records, tombstones } = buildIncrementalArtifact(abs, manifest);
  const artifactText = artifactToJsonl({ records, tombstones });
  log(`   records: ${records.length}, tombstones: ${tombstones.length}`);

  const jobId = `inc-${slug}-${Date.now().toString(36)}`;
  log("→ POST /incremental-ingest...");
  const res = await fetchJson(`${workerUrl}/incremental-ingest`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: slug, manifest_id: manifest.manifest_id,
      base_commit: manifest.base_commit, target_commit: manifest.target_commit,
      artifact_key: `incremental/${manifest.manifest_id}.jsonl`, artifact_text: artifactText,
    }),
  });
  if (!res.ok) throw new Error(`incremental-ingest failed: ${JSON.stringify(res)}`);
  log(`   queued=${res.queued}, deactivated=${res.deactivated}, git_advanced=${res.git_advanced}`);

  if (records.length > 0) {
    log("→ Polling job until published...");
    const final = await pollPublished(workerUrl, jobId, {
      onProgress: j => process.stdout.write(`\r   ${j.completed}/${j.total} (failed=${j.failed})    `),
    });
    process.stdout.write("\n");
    log(`   status=${final.job.status}, completed=${final.job.completed}/${final.job.total}`);
  }

  writeState(slug, {
    ...state,
    active_commit: manifest.target_commit,
    last_manifest_id: manifest.manifest_id,
    last_reindex_at: new Date().toISOString(),
  });
  log(`\n✅ Reindex complete`);
}

async function cmdStatus(repoPath) {
  const slug = repoSlugFromPath(repoPath || process.cwd());
  const state = readState(slug);
  if (!state) {
    log(`Not indexed: ${slug}`);
    return;
  }
  log(`\n📊 ${slug}`);
  log(`   indexed path:    ${state.indexed_path}`);
  log(`   MCP URL:         ${state.mcp_url}`);
  log(`   active commit:   ${state.active_commit}`);
  log(`   last manifest:   ${state.last_manifest_id || "(none)"}`);
  log(`   last full at:    ${state.last_full_at}`);
  log(`   last reindex at: ${state.last_reindex_at || "(never)"}`);

  log("\n→ Live worker state:");
  const live = await fetchJsonOptional(`${state.worker_url}/collection_info`);
  log(`   collection_info: ${live ? JSON.stringify(live.active) : "(unreachable)"}`);
  const gs = await fetchJsonOptional(`${state.worker_url}/git-state/${slug}`);
  log(`   git_state:       ${gs?.state ? `active=${gs.state.active_commit?.slice(0, 8)}, manifest=${gs.state.last_manifest_id}` : "(none)"}`);
}

async function cmdList() {
  const repos = listIndexedRepos();
  if (!repos.length) {
    log("No indexed codebases.");
    return;
  }
  for (const r of repos) {
    log(`${r.slug}\t${r.indexed_path}\t${r.mcp_url}`);
  }
}

async function cmdUninstall(repoPath) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);
  const state = readState(slug);
  if (!state) {
    err(`No state for ${slug}. Resources may already be gone.`);
  }
  log(`\n🗑  cfcode uninstall ${slug}`);
  const names = namesForSlug(slug);
  teardownResources(names, { log: m => log(`  ${m}`) });
  deleteState(slug);
  // Also remove the per-slug wrangler config
  const configPath = configPathFor(slug);
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  log(`✅ Uninstalled ${slug}`);
}

const HELP = `cfcode — Cloudflare per-codebase MCP indexer

Usage:
  cfcode index <repo-path>                          Full-index a codebase
  cfcode reindex <repo-path> [--base R] [--target R]  Diff reindex
  cfcode status [<repo-path>]                       Show indexed state
  cfcode list                                       List all indexed codebases
  cfcode uninstall <repo-path>                      Tear down resources

State cache: ~/.config/cfcode/<slug>.json
Repo:        ${path.resolve(__dirname, "../..")}`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { console.log(HELP); return; }
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));

  // Ensure CF env vars are set for child wrangler calls.
  Object.assign(process.env, loadCfEnv());

  switch (cmd) {
    case "index":     if (!positional[0]) throw new Error("repo-path required"); return cmdIndex(positional[0]);
    case "reindex":   if (!positional[0]) throw new Error("repo-path required"); return cmdReindex(positional[0], flags);
    case "status":    return cmdStatus(positional[0]);
    case "list":      return cmdList();
    case "uninstall": if (!positional[0]) throw new Error("repo-path required"); return cmdUninstall(positional[0]);
    case "help": case "-h": case "--help": console.log(HELP); return;
    default: throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { err(e instanceof Error ? e.message : String(e)); process.exit(1); });
