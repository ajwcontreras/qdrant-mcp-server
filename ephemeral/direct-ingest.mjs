// Direct ingest bypassing redeploy cycle. Sends chunks to already-deployed workers.
// Usage: node ephemeral/direct-ingest.mjs <repo-path>
import { buildFullChunks, fullChunksToJsonl, resolveCommit, chunkIdFor } from "../cloudflare-mcp/lib/files.mjs";
import fs from "node:fs";
import path from "node:path";

const GATEWAY = "https://cfcode-gateway.frosty-butterfly-d821.workers.dev";
const repoPath = process.argv[2];
if (!repoPath) { console.error("Usage: node ephemeral/direct-ingest.mjs <repo-path>"); process.exit(1); }

const abs = path.resolve(repoPath);
const slug = path.basename(abs);

const chunks = await buildFullChunks(abs, slug);
console.log(`${chunks.length} chunks built`);

const jobId = `job-${slug}-${Date.now().toString(36)}`;
const activeCommit = resolveCommit(abs, "HEAD");
const artifactKey = `full/${jobId}.jsonl`;
const artifactText = fullChunksToJsonl(chunks);

const body = {
  job_id: jobId,
  repo_slug: slug,
  indexed_path: abs,
  active_commit: activeCommit,
  artifact_key: artifactKey,
  artifact_text: artifactText,
  shard_count: 4,
  batch_size: 100,
};

console.log(`→ POST /admin/codebases/${slug}/ingest-sharded`);
const res = await fetch(`${GATEWAY}/admin/codebases/${slug}/ingest-sharded`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));

if (data.ok || data.status === "partial") {
  const jobId = data.job_id;
  console.log(`→ Polling ${jobId}...`);
  const dead = Date.now() + 600_000;
  while (Date.now() < dead) {
    await new Promise(r => setTimeout(r, 3000));
    const sr = await fetch(`${GATEWAY}/admin/codebases/${slug}/jobs/${jobId}/status`);
    const sj = await sr.json();
    if (sj.ok) {
      process.stdout.write(`\r   ${sj.job.completed}/${sj.job.total} (failed=${sj.job.failed})    `);
      if (sj.job.status === "published") { process.stdout.write("\n"); console.log(" DONE"); break; }
    }
  }
}
