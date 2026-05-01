#!/usr/bin/env node
/**
 * POC 26E5: Generated Docs Include Diff Reindex Commands
 *
 * Proves: The doc generator produces a per-codebase MCP doc that includes
 * full redo, incremental diff, resume/retry, status commands, active commit,
 * last manifest ID, and a clear statement that v1 incremental reprocesses
 * whole changed files.
 *
 * Reads live state from the persistent lumae Worker (POC 26D3/26D4); writes
 * the doc to `cloudflare-mcp/sessions/index-codebase/lumae-fresh/`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const baseUrl = "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev";
const repoSlug = "lumae-fresh";
const docsDir = path.join(repoRoot, "cloudflare-mcp/sessions/index-codebase", repoSlug);

async function fetchJsonOptional(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function generateDoc({ mcpUrl, indexedPath, repoSlug, activeCommit, lastManifestId }) {
  const ac = activeCommit || "(unknown)";
  const lm = lastManifestId || "(none — no incremental job has run on this codebase yet)";
  return `# ${repoSlug} — Cloudflare MCP Code Search

## Indexed Path

\`${indexedPath}\`

## MCP URL

\`\`\`
${mcpUrl}
\`\`\`

## Current State

- **Active commit:** \`${ac}\`
- **Last manifest ID:** \`${lm}\`

## Install — Claude Code

Add to \`~/.claude/settings.json\` or project \`.claude/settings.json\`:

\`\`\`json
{
  "mcpServers": {
    "${repoSlug}-code-search": {
      "type": "url",
      "url": "${mcpUrl}"
    }
  }
}
\`\`\`

## Install — Claude Desktop

Add to \`~/Library/Application Support/Claude/claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "${repoSlug}-code-search": {
      "type": "url",
      "url": "${mcpUrl}"
    }
  }
}
\`\`\`

## Install — Cursor

Add to \`.cursor/mcp.json\`:

\`\`\`json
{
  "mcpServers": {
    "${repoSlug}-code-search": {
      "url": "${mcpUrl}"
    }
  }
}
\`\`\`

## Verify — curl

\`\`\`bash
curl -s ${baseUrl}/collection_info | jq .
curl -s -X POST ${baseUrl}/search \\
  -H "content-type: application/json" \\
  -d '{"query": "flask routes chat", "topK": 5}' | jq .matches[].chunk.file_path
\`\`\`

## Full Redo

Re-index the entire codebase from scratch (overwrites all chunks idempotently via deterministic IDs):

\`\`\`bash
node cloudflare-mcp/scripts/poc-26d3-full-lumae-job.mjs
\`\`\`

## Incremental Diff Reindex

Reindex only files that changed between two git refs. v1 reprocesses **whole changed files** (no sub-file chunk diffing) and tombstones deleted/renamed paths.

\`\`\`bash
# 1. Generate diff manifest between two refs
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs --diff-base <base-ref> --diff-target HEAD

# 2. Package changed files (whole-file) + tombstones into a JSONL artifact
node cloudflare-mcp/scripts/poc-26e3-incremental-packager-smoke.mjs

# 3. Apply the artifact via /incremental-ingest (deactivates stale chunks,
#    queues re-embedding, advances stored git state on completion)
node cloudflare-mcp/scripts/poc-26e4-cloud-incremental-diff-smoke.mjs
\`\`\`

Example with explicit refs:

\`\`\`bash
# Reindex everything that changed since main
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs --diff-base main --diff-target HEAD
\`\`\`

## Resume / Retry

Re-running any of the above commands is safe — the Worker uses deterministic chunk IDs and \`INSERT OR REPLACE\`, so already-published chunks are overwritten idempotently. Cloudflare Queues are at-least-once; the consumer is idempotent.

## Status Polling

\`\`\`bash
# Per-job status (replace JOB_ID)
curl -s ${baseUrl}/jobs/JOB_ID/status | jq .

# Active publication metadata (active commit, vectorize index, etc.)
curl -s ${baseUrl}/collection_info | jq .

# Git state for this codebase (active commit, last applied manifest)
curl -s ${baseUrl}/git-state/${repoSlug} | jq .
\`\`\`

## Architecture

- **Embeddings:** Google Vertex \`gemini-embedding-001\` at 1536 dimensions
- **Vector store:** Cloudflare Vectorize
- **Metadata:** Cloudflare D1 (authoritative for active rows / search filtering)
- **Artifacts:** Cloudflare R2
- **Fan-out:** Cloudflare Queues (at-least-once; consumer is idempotent)
- **Auth:** None (unauthenticated MCP endpoint)

## Important Notes for Agents

- **v1 incremental reprocesses whole changed files**, not sub-file chunks. A 1-line edit re-embeds the entire file.
- **Renames** are handled as tombstone(old path) + whole-file add(new path).
- **Deletes** are handled as tombstones — old chunks are soft-deleted (\`active = 0\`) in D1; Vectorize \`deleteByIds\` is async and may lag for seconds.
- **D1 \`active = 1\` rows are the authoritative source of truth.** The Worker cross-checks every Vectorize match against D1 before returning search results, so stale Vectorize entries do not appear.
- **Vectorize is eventually consistent** — newly indexed chunks may take up to ~60s to appear in search after publication.

Generated: ${new Date().toISOString()}
`;
}

async function main() {
  console.log("POC 26E5: Generated Docs Include Diff Reindex Commands\n");
  const checks = {
    workerReachable: false,
    docHasMcpUrl: false,
    docHasIndexedPath: false,
    docHasFullRedo: false,
    docHasIncrementalDiff: false,
    docHasResumeRetry: false,
    docHasStatus: false,
    docHasActiveCommit: false,
    docHasLastManifestId: false,
    docStatesWholeFile: false,
    docInRepoSessionsDir: false,
  };

  // Fetch live state
  console.log("--- Fetch live state from persistent Worker ---");
  const collection = await fetchJsonOptional(`${baseUrl}/collection_info`);
  checks.workerReachable = !!collection?.ok;
  const activeCommit = collection?.active?.active_commit || null;
  console.log(`Worker reachable: ${checks.workerReachable ? "PASS" : "FAIL"}`);
  console.log(`Active commit: ${activeCommit || "(unknown)"}`);

  const gitState = await fetchJsonOptional(`${baseUrl}/git-state/${repoSlug}`);
  const lastManifestId = gitState?.state?.last_manifest_id || null;
  console.log(`Last manifest ID: ${lastManifestId || "(none)"}`);

  // Generate doc
  const mcpUrl = `${baseUrl}/mcp`;
  const doc = generateDoc({ mcpUrl, indexedPath: targetRepo, repoSlug, activeCommit, lastManifestId });

  // Write to sessions dir
  fs.mkdirSync(docsDir, { recursive: true });
  const docPath = path.join(docsDir, `${repoSlug}-MCP.md`);
  fs.writeFileSync(docPath, doc, "utf8");
  console.log(`\nWrote doc: ${docPath} (${doc.length} chars)`);

  // Verify all required strings/sections present
  checks.docHasMcpUrl = doc.includes(mcpUrl);
  checks.docHasIndexedPath = doc.includes(targetRepo);
  checks.docHasFullRedo = /## Full Redo/i.test(doc) && doc.includes("poc-26d3-full-lumae-job.mjs");
  checks.docHasIncrementalDiff = /## Incremental Diff Reindex/i.test(doc)
    && doc.includes("--diff-base")
    && doc.includes("--diff-target HEAD")
    && doc.includes("poc-26e1-git-diff-manifest-smoke.mjs")
    && doc.includes("poc-26e4-cloud-incremental-diff-smoke.mjs");
  checks.docHasResumeRetry = /## Resume \/ Retry/i.test(doc)
    && /idempotent/i.test(doc)
    && /deterministic chunk ids/i.test(doc);
  checks.docHasStatus = /## Status Polling/i.test(doc) && doc.includes("/jobs/JOB_ID/status");
  checks.docHasActiveCommit = doc.includes("Active commit:");
  checks.docHasLastManifestId = doc.includes("Last manifest ID:");
  checks.docStatesWholeFile = /v1 incremental reprocesses whole changed files/i.test(doc);

  // Verify path is under cloudflare-mcp/sessions/index-codebase/<repo-slug>/
  const expectedPrefix = path.join(repoRoot, "cloudflare-mcp/sessions/index-codebase", repoSlug);
  checks.docInRepoSessionsDir = docPath.startsWith(expectedPrefix);

  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26E5: PASS" : "❌ POC 26E5: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
