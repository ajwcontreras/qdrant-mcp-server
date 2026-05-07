#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "../lib");
const POLL_INTERVAL = 3000;
const POLL_DEADLINE = 600_000;

// ── SA file resolution ──
function saDir() { return path.join(process.env.HOME || "/tmp", ".config/cfcode/sas"); }
function resolveSAFiles() {
  const dir = saDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  return files.length ? files.map(f => path.join(dir, f)) : [];
}
function saFilesB64(files) { return files.map(f => fs.readFileSync(f, "utf8")); }

// ── Imports ──
const { loadCfEnv, repoSlugFromPath, r2BucketForSlug, d1NameForSlug, vectorizeIndexForSlug, queueNameForSlug, dlqNameForSlug } = await import(`${LIB}/env.mjs`);
const { buildFullChunks, buildDiffManifest, buildIncrementalArtifact, fullChunksToJsonl, artifactToJsonl, resolveCommit } = await import(`${LIB}/files.mjs`);
const { provisionResources, writeNamespaceWranglerConfig, deployToNamespace, teardownResources } = await import(`${LIB}/cf.mjs`);
const { setNamespaceWorkerSecret } = await import(`${LIB}/wfp-secret.mjs`);
const { GATEWAY_URL, NAMESPACE_NAME, userWorkerNameFor, listCodebases: gatewayList, registerCodebase, unregisterCodebase, proxyToCodebase } = await import(`${LIB}/gateway.mjs`);

function log(m) { console.log(m); }
function namesForSlug(slug) { return { workerName: userWorkerNameFor(slug), namespaceName: NAMESPACE_NAME, r2Bucket: r2BucketForSlug(slug), d1Name: d1NameForSlug(slug), vectorizeIndex: vectorizeIndexForSlug(slug), queueName: queueNameForSlug(slug), dlqName: dlqNameForSlug(slug) }; }
function configPathFor(slug) { return path.resolve(__dirname, `../workers/codebase/wrangler.${slug}.namespace.jsonc`); }

function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const key = a.slice(2); const next = argv[i + 1]; flags[key] = (!next || next.startsWith("--")) ? true : (i++, next); }
    else positional.push(a);
  }
  return { positional, flags };
}

// ── Shared helpers ──

async function setupSecrets(names, saFiles, env) {
  log("→ Refreshing secrets...");
  for (let i = 0; i < saFiles.length && i < 4; i++) {
    const b64 = Buffer.from(fs.readFileSync(saFiles[i], "utf8")).toString("base64");
    const name = `GEMINI_SERVICE_ACCOUNT_B64${i === 0 ? "" : `_${i + 1}`}`;
    try { await setNamespaceWorkerSecret({ namespaceName: NAMESPACE_NAME, scriptName: names.workerName, secretName: name, secretValue: b64 }); }
    catch (e) { log(`   ${name} FAILED: ${e.message}`); }
  }
  if (env.DEEPSEEK_API_KEY) {
    try { await setNamespaceWorkerSecret({ namespaceName: NAMESPACE_NAME, scriptName: names.workerName, secretName: "DEEPSEEK_API_KEY", secretValue: env.DEEPSEEK_API_KEY }); }
    catch (e) { log(`   DEEPSEEK_API_KEY FAILED: ${e.message}`); }
  }
  log("   OK");
}

async function pollJob(slug, jobId) {
  const deadline = Date.now() + POLL_DEADLINE;
  let last;
  while (Date.now() < deadline) {
    const r = await proxyToCodebase(slug, `/jobs/${jobId}/status`).catch(() => null);
    if (r?.ok) {
      last = r.job;
      process.stdout.write(`\r   ${last.completed}/${last.total} (failed=${last.failed})    `);
      if (last.status === "published") break;
      if (last.failed > 0 && last.completed + last.failed >= last.total) { process.stdout.write("\n"); throw new Error(`job has ${last.failed} failures: ${JSON.stringify(last)}`); }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  process.stdout.write("\n");
  if (!last || last.status !== "published") throw new Error(`job did not publish: ${JSON.stringify(last)}`);
}

// ── Commands ──

async function cmdIndex(repoPath, flags) {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(path.join(abs, ".git"))) throw new Error(`not a git repo: ${abs}`);
  const slug = repoSlugFromPath(abs);

  // Already registered? Delegate to incremental.
  const reg = (await gatewayList()).find(c => c.slug === slug);
  if (reg && !flags.full) {
    log(`ℹ ${slug} already registered — using incremental (--full to force)`);
    return cmdReindex(repoPath, flags);
  }

  const names = namesForSlug(slug);
  const saFiles = resolveSAFiles();
  const env = loadCfEnv();
  log(`\n📦 cfcode index ${abs}\n   slug: ${slug}   sa: ${saFiles.length}   worker: ${names.workerName}`);

  if (flags.deploy) {
    log("→ Provisioning + deploying...");
    const { d1Id } = provisionResources(names, { log: m => log(`  ${m}`) });
    writeNamespaceWranglerConfig(configPathFor(slug), { ...names, d1Id });
    deployToNamespace(configPathFor(slug), NAMESPACE_NAME);
    await setupSecrets(names, saFiles, env);
    log("→ Registering with gateway...");
    await registerCodebase(slug, abs);
  } else {
    await setupSecrets(names, saFiles, env);
  }

  log("→ Building chunks...");
  const chunks = await buildFullChunks(abs, slug);
  if (!chunks.length) throw new Error("no source files found");
  log(`   ${chunks.length} chunks`);

  const body = {
    job_id: `job-${slug}-${Date.now().toString(36)}`, repo_slug: slug, indexed_path: abs,
    active_commit: resolveCommit(abs, "HEAD"), artifact_key: `full/${Date.now().toString(36)}.jsonl`,
    artifact_text: fullChunksToJsonl(chunks),
    deepseek_api_key: env.DEEPSEEK_API_KEY || "", gemini_sas: saFilesB64(saFiles), num_sas: String(saFiles.length),
  };
  if (flags.shards) body.shard_count = Number(flags.shards);
  if (flags.batch) body.batch_size = Number(flags.batch);

  const endpoint = flags.queue ? "/ingest" : "/ingest-sharded";
  log(`→ POST ${endpoint}`);
  const res = await proxyToCodebase(slug, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok && res.status !== "partial") throw new Error(`ingest failed: ${JSON.stringify(res)}`);

  if (res.status === "published") { log(`✅ Indexed ${slug} — ${res.completed}/${res.chunks}`); }
  else { log("→ Polling..."); await pollJob(slug, body.job_id); log(`✅ Indexed ${slug}`); }
  log(`   MCP URL: ${GATEWAY_URL}/mcp`);
}

async function cmdReindex(repoPath, flags) {
  const abs = path.resolve(repoPath);
  const slug = repoSlugFromPath(abs);
  const reg = (await gatewayList()).find(c => c.slug === slug);
  if (!reg) throw new Error(`${slug} not registered. Run \`cfcode index ${abs} --deploy\` first.`);

  const gs = await proxyToCodebase(slug, `/git-state/${slug}`).catch(() => null);
  const baseRef = flags.base || gs?.state?.active_commit || "HEAD~1";
  const targetRef = flags.target || "HEAD";
  log(`\n🔁 cfcode reindex ${slug}\n   base: ${baseRef}   target: ${targetRef}`);

  log("→ Building diff...");
  const manifest = buildDiffManifest(abs, slug, baseRef, targetRef);
  log(`   ${manifest.summary.total} files (+${manifest.summary.added} ~${manifest.summary.modified} -${manifest.summary.deleted} ≫${manifest.summary.renamed})`);
  if (!manifest.summary.total) { log("→ No changes. Nothing to do."); return; }

  const names = namesForSlug(slug);
  const saFiles = resolveSAFiles();
  const env = loadCfEnv();
  await setupSecrets(names, saFiles, env);

  const { records, tombstones } = buildIncrementalArtifact(abs, manifest);
  const artifactText = artifactToJsonl({ records, tombstones });
  log(`   ${records.length} records, ${tombstones.length} tombstones`);

  const jobId = `inc-${slug}-${Date.now().toString(36)}`;
  log("→ POST /incremental-ingest-sharded");
  const res = await proxyToCodebase(slug, "/incremental-ingest-sharded", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: slug, manifest_id: manifest.manifest_id,
      base_commit: manifest.base_commit, target_commit: manifest.target_commit,
      artifact_key: `incremental/${manifest.manifest_id}.jsonl`, artifact_text: artifactText,
      deepseek_api_key: env.DEEPSEEK_API_KEY || "", num_sas: String(saFiles.length),
    }),
  });
  if (!res.ok) throw new Error(`incremental-ingest failed: ${JSON.stringify(res)}`);
  log(`   ${res.completed}/${res.chunks || "?"} (deactivated ${res.deactivated || 0})`);

  if (records.length) { log("→ Polling..."); await pollJob(slug, jobId); }
  log(`✅ Reindex complete`);
}

async function cmdStatus(repoPath) {
  const slug = repoSlugFromPath(repoPath || process.cwd());
  const reg = (await gatewayList()).find(c => c.slug === slug);
  if (!reg) { log(`Not registered: ${slug}`); return; }
  log(`\n📊 ${slug}\n   indexed: ${reg.indexed_path}\n   registered: ${reg.registered_at}\n   MCP: ${GATEWAY_URL}/mcp`);
  const ci = await proxyToCodebase(slug, "/collection_info").catch(() => null);
  log(`   collection: ${ci ? JSON.stringify(ci.active) : "(unreachable)"}`);
  const gs = await proxyToCodebase(slug, `/git-state/${slug}`).catch(() => null);
  if (gs?.state) log(`   git: ${gs.state.active_commit?.slice(0, 8)}, manifest=${gs.state.last_manifest_id}`);
}

async function cmdSearch(repoPath, query, flags) {
  const slug = repoSlugFromPath(path.resolve(repoPath));
  if (!(await gatewayList()).find(c => c.slug === slug)) { log(`Not registered: ${slug}`); return; }
  const topK = Number(flags.topK || flags.top) || 10;
  const endpoint = flags.rerank ? "/search-rerank" : flags.hybrid ? "/search-hybrid" : "/search";
  const res = await proxyToCodebase(slug, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, repo_slug: slug, topK }) });
  if (!res?.ok) { log(`search failed: ${res?.error || JSON.stringify(res)}`); return; }
  const matches = res.matches || [];
  if (!matches.length) { log("No results"); return; }
  for (const m of matches) log(`  ${m.score.toFixed(3)}  ${m.chunk?.file_path || ""}`);
  log(`${matches.length} results (${res.vectorize_returned} returned, ${res.d1_filtered} filtered)`);
}

async function cmdSearchActive(repoPath, flags) {
  const slug = repoSlugFromPath(path.resolve(repoPath));
  if (!(await gatewayList()).find(c => c.slug === slug)) { log(`Not registered: ${slug}`); return; }
  const res = await proxyToCodebase(slug, "/search-active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo_slug: slug, file_path: flags.file || flags.path || undefined }) });
  if (!res?.ok) { log(`failed: ${res?.error}`); return; }
  const rows = res.matches || []; if (!rows.length) { log("No active chunks"); return; }
  for (const r of rows) log(`  ${r.chunk_id}  ${r.file_path}`);
  log(`${rows.length} active chunks`);
}

async function cmdHydeEnrich(repoPath) {
  const slug = repoSlugFromPath(path.resolve(repoPath));
  if (!(await gatewayList()).find(c => c.slug === slug)) { log(`Not registered: ${slug}`); return; }
  const ci = await proxyToCodebase(slug, "/collection_info").catch(() => null);
  const jobId = ci?.active?.job_id;
  if (!jobId) { log("No active publication — index first"); return; }
  log(`\n🧠 hyde-enrich ${slug}   job: ${jobId}`);
  const dsKey = loadCfEnv().DEEPSEEK_API_KEY || "";
  const saFiles = resolveSAFiles();
  const saRaw = saFilesB64(saFiles);
  const res = await proxyToCodebase(slug, "/hyde-enrich", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, repo_slug: slug, deepseek_api_key: dsKey, gemini_sas: saRaw, num_sas: String(saFiles.length) }) });
  if (!res?.ok) { log(`failed: ${res?.error || JSON.stringify(res)}`); return; }
  log(`   ${res.scanned} scanned, ${res.enriched} enriched, ${res.errors || 0} errors\n✅ HyDE complete`);
}

async function cmdSetup() {
  log("\n⚙️  cfcode setup");
  const gw = await fetch(`${GATEWAY_URL}/health`).then(r => r.json()).catch(() => null);
  log(`   gateway: ${gw?.ok ? "✓" : "✗"}`);
  if (!gw?.ok) throw new Error(`gateway unreachable. Deploy it first.`);
  const repos = await gatewayList().catch(() => []);
  log(`   registry: ${repos.length} codebases`);
  log(`   namespace: ${NAMESPACE_NAME}`);
  log(`   MCP: ${GATEWAY_URL}/mcp`);
  log("✅ Ready");
}

async function cmdList() {
  const repos = await gatewayList();
  if (!repos.length) { log("No codebases registered."); return; }
  for (const r of repos) log(`${r.slug}\t${r.indexed_path}`);
}

async function cmdResources() {
  const d = path.resolve(__dirname, "../workers/codebase");
  const { run } = await import(`${LIB}/exec.mjs`);
  const j = cmd => { try { return JSON.parse(run("npx", cmd, { cwd: d, capture: true, allowFailure: true }).stdout || "[]"); } catch { return []; } };
  log("\n📦 cfcode resources");
  log("── D1 ──"); j(["wrangler", "d1", "list", "--json"]).forEach(b => b.name?.startsWith("cfcode-") && log(`  ${b.name}`));
  log("── R2 ──"); j(["wrangler", "r2", "bucket", "list", "--json"]).forEach(b => b.name?.startsWith("cfcode-") && log(`  ${b.name}`));
  log("── Vectorize ──"); j(["wrangler", "vectorize", "list", "--json"]).forEach(i => i.name?.startsWith("cfcode-") && log(`  ${i.name}`));
  log("── Queues ──"); j(["wrangler", "queues", "list", "--json"]).forEach(q => q.queue_name?.startsWith("cfcode-") && log(`  ${q.queue_name}`));
  log(`── Gateway ──\n  ${GATEWAY_URL}  (${NAMESPACE_NAME})`);
}

async function cmdUninstall(repoPath) {
  const slug = repoSlugFromPath(path.resolve(repoPath));
  log(`\n🗑  uninstall ${slug}`);
  await unregisterCodebase(slug).catch(() => {});
  const names = namesForSlug(slug);
  log("→ Tearing down resources...");
  teardownResources(names, { log: m => log(`  ${m}`) });
  const cp = configPathFor(slug);
  if (fs.existsSync(cp)) fs.unlinkSync(cp);
  log("✅ Done");
}

async function cmdLogs(repoPath, flags) {
  const slug = repoSlugFromPath(path.resolve(repoPath));
  const cp = configPathFor(slug);
  if (!fs.existsSync(cp)) throw new Error(`not indexed: ${slug}`);
  const { run } = await import(`${LIB}/exec.mjs`);
  const args = ["wrangler", "tail", "--config", cp];
  if (flags.errors) args.push("--search", "error");
  run("npx", args, { cwd: path.resolve(__dirname, "../workers/codebase") });
}

function cmdMcpUrl() { console.log(`${GATEWAY_URL}/mcp`); }

// ── Main ──

const HELP = `cfcode — Cloudflare per-codebase MCP code search

ONE MCP URL: ${GATEWAY_URL}/mcp

Usage:
  cfcode index <repo-path> [--deploy] [--full] [--queue] [--shards N] [--batch N]
      Smart: auto-delegates to incremental if registered. --deploy for first-time setup.
      --full forces complete re-index. --queue uses legacy path.
  cfcode reindex <repo-path> [--base <ref>] [--target <ref>]
      Incremental: git diff since last indexed commit.
  cfcode search <repo-path> "query" [--topK N] [--hybrid] [--rerank]
  cfcode search-active <repo-path> [--file <path>]
  cfcode hyde-enrich <repo-path>
  cfcode status [<repo-path>]
  cfcode list
  cfcode resources
  cfcode logs <repo-path> [--errors]
  cfcode uninstall <repo-path>
  cfcode mcp-url

MCP tools in agent: list_codebases, select_codebase("slug"), search("query", topK?)`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { console.log(HELP); return; }
  const cmd = argv[0]; const { positional: p, flags: f } = parseArgs(argv.slice(1));
  Object.assign(process.env, loadCfEnv());

  switch (cmd) {
    case "index":         if (!p[0]) throw new Error("repo-path required"); await cmdIndex(p[0], f); break;
    case "reindex":       if (!p[0]) throw new Error("repo-path required"); await cmdReindex(p[0], f); break;
    case "search":        if (!p[0] || !p[1]) throw new Error("repo-path and query required"); await cmdSearch(p[0], p[1], f); break;
    case "search-active": if (!p[0]) throw new Error("repo-path required"); await cmdSearchActive(p[0], f); break;
    case "hyde-enrich":   if (!p[0]) throw new Error("repo-path required"); await cmdHydeEnrich(p[0]); break;
    case "status":        await cmdStatus(p[0]); break;
    case "list":          await cmdList(); break;
    case "resources":     await cmdResources(); break;
    case "logs":          if (!p[0]) throw new Error("repo-path required"); await cmdLogs(p[0], f); break;
    case "uninstall":     if (!p[0]) throw new Error("repo-path required"); await cmdUninstall(p[0]); break;
    case "setup":         await cmdSetup(); break;
    case "mcp-url":       cmdMcpUrl(); break;
    case "help": case "-h": case "--help": console.log(HELP); break;
    default: throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
