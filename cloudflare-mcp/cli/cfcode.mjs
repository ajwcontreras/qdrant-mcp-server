#!/usr/bin/env node
/**
 * cfcode — global CLI for Cloudflare per-codebase MCP indexing.
 *
 * v2 architecture: per-codebase Workers live in the `cfcode-codebases`
 * dispatch namespace. A single stateful gateway (`cfcode-gateway`) routes
 * by slug. Agent puts ONE URL in settings:
 *   https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp
 *
 * Commands:
 *   cfcode index <repo-path>           Full-index a codebase
 *   cfcode reindex <repo-path>          Diff reindex (base = stored active_commit)
 *     [--base <ref>] [--target <ref>]
 *   cfcode status [<repo-path>]         Show indexed state
 *   cfcode list                          List registered codebases (from gateway)
 *   cfcode uninstall <repo-path>         Remove from namespace + registry + delete resources
 *   cfcode mcp-url                       Print the single MCP URL
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "../lib");
const SA_PATH = "/Users/awilliamspcsevents/Downloads/team (1).json";

const {
  loadCfEnv, repoSlugFromPath,
  r2BucketForSlug, d1NameForSlug, vectorizeIndexForSlug, queueNameForSlug, dlqNameForSlug,
} = await import(`${LIB}/env.mjs`);
const { fetchJson, fetchJsonOptional, pollPublished } = await import(`${LIB}/http.mjs`);
const {
  buildFullChunks, buildDiffManifest, buildIncrementalArtifact,
  fullChunksToJsonl, artifactToJsonl, resolveCommit,
} = await import(`${LIB}/files.mjs`);
const {
  provisionResources, writeNamespaceWranglerConfig, deployToNamespace,
  setNamespaceVertexSecret, teardownResources,
} = await import(`${LIB}/cf.mjs`);
const {
  GATEWAY_URL, NAMESPACE_NAME, userWorkerNameFor,
  listCodebases: gatewayList, registerCodebase, unregisterCodebase, proxyToCodebase,
} = await import(`${LIB}/gateway.mjs`);

function namesForSlug(slug) {
  return {
    workerName: userWorkerNameFor(slug),
    namespaceName: NAMESPACE_NAME,
    r2Bucket: r2BucketForSlug(slug),
    d1Name: d1NameForSlug(slug),
    vectorizeIndex: vectorizeIndexForSlug(slug),
    queueName: queueNameForSlug(slug),
    dlqName: dlqNameForSlug(slug),
  };
}

function configPathFor(slug) {
  return path.resolve(__dirname, `../workers/codebase/wrangler.${slug}.namespace.jsonc`);
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

async function cmdIndex(repoPath, flags) {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(path.join(abs, ".git"))) throw new Error(`${abs} is not a git repo`);
  if (!fs.existsSync(SA_PATH)) throw new Error(`Vertex service account not found at ${SA_PATH}`);

  const slug = repoSlugFromPath(abs);
  const names = namesForSlug(slug);
  log(`\n📦 cfcode index ${abs}`);
  log(`   slug:   ${slug}`);
  log(`   worker: ${names.workerName} (in ${NAMESPACE_NAME})\n`);

  log("→ Provisioning Cloudflare resources (idempotent)...");
  const { d1Id } = provisionResources(names, { log: m => log(`  ${m}`) });

  log("→ Writing wrangler config...");
  const configPath = configPathFor(slug);
  writeNamespaceWranglerConfig(configPath, { ...names, d1Id });

  log("→ Deploying user worker into dispatch namespace...");
  deployToNamespace(configPath, NAMESPACE_NAME);

  log("→ Setting Vertex SA secret (multipart API)...");
  const saB64 = Buffer.from(fs.readFileSync(SA_PATH, "utf8")).toString("base64");
  await setNamespaceVertexSecret({ namespaceName: NAMESPACE_NAME, scriptName: names.workerName, saB64 });

  log("→ Registering with gateway...");
  await registerCodebase(slug, abs);

  log("→ Building chunks from repo...");
  const chunks = buildFullChunks(abs, slug);
  log(`   ${chunks.length} chunks`);
  if (!chunks.length) throw new Error("no source files found");

  const activeCommit = resolveCommit(abs, "HEAD");
  const jobId = `job-${slug}-${Date.now().toString(36)}`;
  const artifactKey = `full/${jobId}.jsonl`;
  const artifactText = fullChunksToJsonl(chunks);
  const shards = typeof flags?.shards === "string" ? Number(flags.shards) : NaN;
  const batchSize = typeof flags?.batch === "string" ? Number(flags.batch) : NaN;
  const ingestPath = flags?.fast ? "/ingest-sharded" : "/ingest";
  const body = {
    job_id: jobId, repo_slug: slug, indexed_path: abs,
    active_commit: activeCommit, artifact_key: artifactKey, artifact_text: artifactText,
  };
  if (Number.isFinite(shards) && shards > 0) body.shard_count = shards;
  if (Number.isFinite(batchSize) && batchSize > 0) body.batch_size = batchSize;

  log(`→ POST ${ingestPath} via gateway proxy${flags?.fast ? " (fast path)" : ""}...`);
  const ingestRes = await proxyToCodebase(slug, ingestPath, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ingestRes.ok) throw new Error(`ingest failed: ${JSON.stringify(ingestRes)}`);
  log(`   queued: ${ingestRes.queued}`);

  log("→ Polling job until published...");
  // Note: pollPublished hits the worker URL directly; we proxy via gateway.
  // Inline a slimmer poll loop here.
  const deadline = Date.now() + 600_000;
  let lastJob;
  while (Date.now() < deadline) {
    const statusRes = await proxyToCodebase(slug, `/jobs/${jobId}/status`).catch(() => null);
    if (statusRes?.ok) {
      lastJob = statusRes.job;
      process.stdout.write(`\r   ${lastJob.completed}/${lastJob.total} (failed=${lastJob.failed})    `);
      if (lastJob.status === "published") break;
      if (lastJob.failed > 0 && lastJob.completed + lastJob.failed >= lastJob.total) {
        process.stdout.write("\n");
        throw new Error(`job has ${lastJob.failed} failures: ${JSON.stringify(lastJob)}`);
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  process.stdout.write("\n");
  if (lastJob?.status !== "published") throw new Error(`job did not publish: ${JSON.stringify(lastJob)}`);
  log(`   status=${lastJob.status}, completed=${lastJob.completed}/${lastJob.total}`);

  log(`\n✅ Indexed ${slug}`);
  log(`   MCP URL: ${GATEWAY_URL}/mcp`);
  log(`   In Claude Code, call select_codebase("${slug}"), then search.`);
}

async function cmdReindex(repoPath, flags) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);

  // Check the codebase is registered
  const all = await gatewayList();
  const reg = all.find(c => c.slug === slug);
  if (!reg) throw new Error(`${slug} not registered with gateway. Run 'cfcode index ${abs}' first.`);

  // Find the active_commit from gateway git_state (proxied)
  const gs = await proxyToCodebase(slug, `/git-state/${slug}`).catch(() => null);
  const baseRef = flags.base || gs?.state?.active_commit || "HEAD~1";
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
  log("→ POST /incremental-ingest via gateway proxy...");
  const res = await proxyToCodebase(slug, "/incremental-ingest", {
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
    const deadline = Date.now() + 600_000;
    let lastJob;
    while (Date.now() < deadline) {
      const sr = await proxyToCodebase(slug, `/jobs/${jobId}/status`).catch(() => null);
      if (sr?.ok) {
        lastJob = sr.job;
        process.stdout.write(`\r   ${lastJob.completed}/${lastJob.total} (failed=${lastJob.failed})    `);
        if (lastJob.status === "published") break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    process.stdout.write("\n");
    log(`   status=${lastJob?.status}`);
  }

  log(`\n✅ Reindex complete`);
}

async function cmdStatus(repoPath) {
  const slug = repoSlugFromPath(repoPath || process.cwd());
  const all = await gatewayList();
  const reg = all.find(c => c.slug === slug);
  if (!reg) {
    log(`Not registered: ${slug}`);
    return;
  }
  log(`\n📊 ${slug}`);
  log(`   indexed path:   ${reg.indexed_path}`);
  log(`   registered at:  ${reg.registered_at}`);
  log(`   MCP URL:        ${GATEWAY_URL}/mcp`);

  log("\n→ Live worker state (via gateway proxy):");
  const ci = await proxyToCodebase(slug, "/collection_info").catch(() => null);
  log(`   collection_info: ${ci ? JSON.stringify(ci.active) : "(unreachable)"}`);
  const gs = await proxyToCodebase(slug, `/git-state/${slug}`).catch(() => null);
  log(`   git_state:       ${gs?.state ? `active=${gs.state.active_commit?.slice(0, 8)}, manifest=${gs.state.last_manifest_id}` : "(none)"}`);
}

async function cmdSearch(repoPath, query, flags) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);

  const all = await gatewayList();
  const reg = all.find(c => c.slug === slug);
  if (!reg) {
    log(`Not registered: ${slug}`);
    return;
  }

  const topK = Number(flags.topK || flags.top) || 10;
  const searchRes = await proxyToCodebase(slug, "/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, repo_slug: slug, topK }),
  });
  if (!searchRes?.ok) {
    log(`search failed: ${searchRes?.error || JSON.stringify(searchRes)}`);
    return;
  }

  const matches = Array.isArray(searchRes.matches) ? searchRes.matches : [];
  if (!matches.length) {
    log("No results");
    return;
  }

  for (const m of matches) {
    log(`  ${m.score} ${m.chunk?.file_path || ""}`);
  }
  log(`${matches.length} results (${searchRes.vectorize_returned} returned, ${searchRes.d1_filtered} filtered)`);
}

async function cmdList() {
  const repos = await gatewayList();
  if (!repos.length) {
    log("No codebases registered with the gateway.");
    log(`Run: cfcode index <repo-path>`);
    return;
  }
  for (const r of repos) {
    log(`${r.slug}\t${r.indexed_path}`);
  }
}

async function cmdUninstall(repoPath) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);
  log(`\n🗑  cfcode uninstall ${slug}`);
  const names = namesForSlug(slug);
  log("→ Unregistering from gateway...");
  await unregisterCodebase(slug).catch(() => log("  (already not registered)"));
  log("→ Tearing down resources...");
  teardownResources(names, { log: m => log(`  ${m}`) });
  // Remove the per-slug wrangler config
  const configPath = configPathFor(slug);
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  log(`✅ Uninstalled ${slug}`);
}

function cmdMcpUrl() { console.log(`${GATEWAY_URL}/mcp`); }

const HELP = `cfcode — Cloudflare per-codebase MCP code search

ONE MCP URL: ${GATEWAY_URL}/mcp
(drop into ~/.claude/settings.json once, never edit again)

Usage:
  cfcode index <repo-path> [--fast] [--shards N] [--batch N]   Full-index a codebase
  cfcode reindex <repo-path> [--base R] [--target R]  Diff reindex
  cfcode search <repo-path> "query" [--topK N]     Semantic code search
  cfcode status [<repo-path>]                       Show indexed state
  cfcode list                                       List registered codebases
  cfcode uninstall <repo-path>                      Remove + delete resources
  cfcode mcp-url                                    Print the single MCP URL

In Claude Code:
  list_codebases                — discover available codebases
  select_codebase("slug")       — bind this session to one
  search("query", topK?)        — semantic code search`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { console.log(HELP); return; }
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));

  Object.assign(process.env, loadCfEnv());

  switch (cmd) {
    case "index":     if (!positional[0]) throw new Error("repo-path required"); return cmdIndex(positional[0], flags);
    case "reindex":   if (!positional[0]) throw new Error("repo-path required"); return cmdReindex(positional[0], flags);
    case "search":    if (!positional[0] || !positional[1]) throw new Error("repo-path and query required"); return cmdSearch(positional[0], positional[1], flags);
    case "status":    return cmdStatus(positional[0]);
    case "list":      return cmdList();
    case "uninstall": if (!positional[0]) throw new Error("repo-path required"); return cmdUninstall(positional[0]);
    case "mcp-url":   return cmdMcpUrl();
    case "help": case "-h": case "--help": console.log(HELP); return;
    default: throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { err(e instanceof Error ? e.message : String(e)); process.exit(1); });
