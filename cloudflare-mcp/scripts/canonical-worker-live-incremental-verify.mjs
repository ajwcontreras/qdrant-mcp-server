#!/usr/bin/env node
/**
 * Live verification: send the existing 26E3 incremental artifact to the
 * persistent lumae worker's /incremental-ingest endpoint, poll to publish,
 * verify counters, git_state advance, and that searched chunks reflect the
 * new state.
 *
 * Idempotent: re-running uses INSERT OR REPLACE — safe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const baseUrl = "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev";
const repoSlug = "lumae-fresh";

const manifestPath = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e1/diff-manifest.json");
const artifactPath = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e3/incremental-artifact.jsonl");

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!(res.headers.get("content-type") || "").includes("application/json")) throw new Error(`${url} non-JSON ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function pollPublished(jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
    if (last.ok && last.job?.status === "published") return last;
    if (last.ok && last.job?.failed > 0) throw new Error(`failed: ${JSON.stringify(last.job)}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`not published in ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

async function main() {
  console.log("Live incremental verify against canonical worker\n");
  const checks = { ingestOk: false, jobPublished: false, gitAdvanced: false, searchActiveReflects: false };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const artifactText = fs.readFileSync(artifactPath, "utf8");
  console.log(`Manifest: ${manifest.manifest_id} (${manifest.summary.total} files)`);
  console.log(`Artifact: ${artifactText.length} bytes\n`);

  const jobId = `inc-live-${Date.now()}`;

  console.log("--- /incremental-ingest ---");
  const res = await fetchJson(`${baseUrl}/incremental-ingest`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId, repo_slug: repoSlug, manifest_id: manifest.manifest_id,
      base_commit: manifest.base_commit, target_commit: manifest.target_commit,
      artifact_key: `live-incremental/${manifest.manifest_id}.jsonl`, artifact_text: artifactText,
    }),
  });
  console.log(JSON.stringify(res, null, 2));
  checks.ingestOk = res.ok && res.queued === 14 && res.changed_files === 14 && res.deleted_files === 0;
  console.log(`ingestOk: ${checks.ingestOk ? "PASS" : "FAIL"}`);

  console.log("\n--- Wait for publish ---");
  const final = await pollPublished(jobId);
  console.log(`status=${final.job.status}, completed=${final.job.completed}, total=${final.job.total}, failed=${final.job.failed}`);
  checks.jobPublished = final.job.status === "published" && final.job.completed === 14 && final.job.failed === 0;
  console.log(`jobPublished: ${checks.jobPublished ? "PASS" : "FAIL"}`);

  console.log("\n--- /git-state ---");
  const gs = await fetchJson(`${baseUrl}/git-state/${repoSlug}`);
  console.log(JSON.stringify(gs, null, 2));
  checks.gitAdvanced = gs.ok && gs.state?.active_commit === manifest.target_commit && gs.state?.last_manifest_id === manifest.manifest_id;
  console.log(`gitAdvanced: ${checks.gitAdvanced ? "PASS" : "FAIL"}`);

  console.log("\n--- /search-active for one of the changed files ---");
  const probeFile = manifest.files[0].file_path;
  const sa = await fetchJson(`${baseUrl}/search-active`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo_slug: repoSlug, file_path: probeFile }),
  });
  console.log(`Active rows for ${probeFile}: ${sa.matches.length}`);
  checks.searchActiveReflects = sa.matches.length >= 1;
  console.log(`searchActiveReflects: ${checks.searchActiveReflects ? "PASS" : "FAIL"}`);

  console.log("\n══ Verification ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ Canonical worker live incremental: PASS" : "❌ FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
