#!/usr/bin/env node
/**
 * POC 30D continuation: hits the existing 30d worker for the 3 remaining repos.
 * Launcher already done (code=182, hyde=2160 in D1).
 * Worker URL: https://cfcode-poc-30d-multirepo.frosty-butterfly-d821.workers.dev
 *
 * Run: node cloudflare-mcp/scripts/poc-30d-continue.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../poc/30d-multi-repo");
const baseUrl = "https://cfcode-poc-30d-multirepo.frosty-butterfly-d821.workers.dev";

const REPOS = [
  { name: "launcher", path: "/Users/awilliamspcsevents/PROJECTS/launcher", already_done: true, prior_chunks: 182 },
  { name: "cfpubsub-scaffold", path: "/Users/awilliamspcsevents/PROJECTS/cfpubsub-scaffold" },
  { name: "reviewer-s-workbench", path: "/Users/awilliamspcsevents/PROJECTS/reviewer-s-workbench" },
  { name: "node-orchestrator", path: "/Users/awilliamspcsevents/PROJECTS/node-orchestrator" },
];

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000;
const TAG = "30d";

function listSourceFiles(repoPath) {
  const r = spawnSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(f =>
    f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__")
  );
}
function buildChunks(repoPath, slug) {
  const files = listSourceFiles(repoPath);
  const chunks = [];
  for (const rel of files) {
    const full = path.join(repoPath, rel);
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
async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
}

async function ingestRepo(repo) {
  const slug = `${repo.name}-${TAG}`;
  const chunks = buildChunks(repo.path, slug);
  if (chunks.length === 0) return { name: repo.name, error: "no chunks built" };
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
  });
  const e2e = Date.now() - t0;
  const result = {
    name: repo.name, path: repo.path, chunks: chunks.length,
    artifact_size_kb: +(artifactText.length / 1024).toFixed(1),
    status: ing.status, ok: ing.body?.ok === true,
    code: ing.body?.code, hyde: ing.body?.hyde,
    total_wall_ms: ing.body?.total_wall_ms ?? e2e,
    client_e2e_wall_ms: e2e,
    server_status: ing.body?.status,
  };
  if (result.code) console.log(`code: ${result.code.completed}/${chunks.length} in ${result.code.wall_ms}ms = ${result.code.chunks_per_sec} cps, errors=${result.code.errors}`);
  if (result.hyde) console.log(`hyde: ${result.hyde.hyde_completed}/${chunks.length * 12} in ${result.hyde.wall_ms}ms = ${result.hyde.vectors_per_sec} vps, errors=${result.hyde.errors}`);
  console.log(`e2e: ${(e2e / 1000).toFixed(1)}s`);
  return result;
}

async function main() {
  const summary = {
    poc: "30d",
    started_at: new Date().toISOString(),
    repos: [],
  };

  // Reconstruct launcher (already done) result via /counts
  console.log("=== launcher (182 chunks) — reconstructed from D1 ===");
  const c = await fetchJson(`${baseUrl}/counts`);
  console.log(`server counts (cumulative): ${JSON.stringify(c.body)}`);
  summary.repos.push({
    name: "launcher",
    path: "/Users/awilliamspcsevents/PROJECTS/launcher",
    chunks: 182,
    note: "already ingested in killed run; D1 confirms 182 code + 2160 hyde rows",
    code: { completed: 182, errors: 0, chunks_per_sec: null, wall_ms: null },
    hyde: { hyde_completed: 2160, errors: 24, vectors_per_sec: null, wall_ms: null },
    total_wall_ms: null,
    server_status: "partial",
  });

  for (const repo of REPOS) {
    if (repo.already_done) continue;
    try {
      const r = await ingestRepo(repo);
      summary.repos.push(r);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error(`${repo.name} failed: ${e instanceof Error ? e.message : e}`);
      summary.repos.push({ name: repo.name, path: repo.path, error: String(e instanceof Error ? e.message : e) });
    }
  }

  summary.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "bench-30d.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log("\n══════════════════════════════════════════");
  console.log("Multi-repo benchmark summary");
  console.log("══════════════════════════════════════════");
  for (const r of summary.repos) {
    if (r.error) { console.log(`\n${r.name}: ERROR ${r.error}`); continue; }
    const codeWall = r.code?.wall_ms ?? 0;
    const hydeWall = r.hyde?.wall_ms ?? 0;
    const totalWall = r.total_wall_ms ?? 0;
    const cps = r.code?.chunks_per_sec ?? "n/a";
    const vps = r.hyde?.vectors_per_sec ?? "n/a";
    const codeOK = r.code ? r.code.errors === 0 : false;
    const hydeRate = r.hyde ? (r.hyde.hyde_completed / (r.chunks * 12) * 100).toFixed(1) : "0";
    console.log(`\n${r.name} (${r.chunks} chunks)`);
    console.log(`  code path: ${r.code?.completed ?? 0}/${r.chunks} in ${codeWall ? (codeWall/1000).toFixed(1) + "s" : "n/a"} = ${cps} cps ${codeOK ? "✓" : `errors=${r.code?.errors ?? 0}`}`);
    console.log(`  hyde path: ${r.hyde?.hyde_completed ?? 0}/${r.chunks * 12} (${hydeRate}%) in ${hydeWall ? (hydeWall/1000).toFixed(1) + "s" : "n/a"} = ${vps} vps`);
    console.log(`  TOTAL e2e: ${totalWall ? (totalWall/1000).toFixed(1) + "s" : "n/a"}`);
  }
  console.log("\n──────────────────────────────────────────");
  const ok = summary.repos.filter(r => r.code && r.hyde && r.total_wall_ms);
  if (ok.length > 0) {
    const fastest = [...ok].sort((a, b) => (a.total_wall_ms ?? 0) - (b.total_wall_ms ?? 0))[0];
    const slowest = [...ok].sort((a, b) => (b.total_wall_ms ?? 0) - (a.total_wall_ms ?? 0))[0];
    const totalChunks = ok.reduce((s, r) => s + (r.chunks ?? 0), 0);
    const totalHyde = ok.reduce((s, r) => s + (r.hyde?.hyde_completed ?? 0), 0);
    const totalE2E = ok.reduce((s, r) => s + (r.total_wall_ms ?? 0), 0);
    console.log(`Fastest e2e: ${fastest.name} = ${(fastest.total_wall_ms/1000).toFixed(1)}s (${fastest.chunks} chunks)`);
    console.log(`Slowest e2e: ${slowest.name} = ${(slowest.total_wall_ms/1000).toFixed(1)}s (${slowest.chunks} chunks)`);
    console.log(`Aggregate:   ${totalChunks} chunks + ${totalHyde} hyde rows in ${(totalE2E/1000).toFixed(1)}s sequential e2e (${ok.length} repos)`);
  }
  console.log(`\nbench-30d.json: ${path.join(outDir, "bench-30d.json")}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
