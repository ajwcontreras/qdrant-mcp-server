#!/usr/bin/env node
/**
 * POC 19.5: Generated Codebase MCP Docs
 *
 * Proves:
 *   An indexed codebase receives a generated README-style install/reindex doc
 *   containing the indexed path, unique MCP URL, client snippets, and
 *   resumable incremental reindex commands.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const outputDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-19_5");
const outputPath = path.join(outputDir, "lumae-fresh-MCP.md");

const metadata = {
  repoName: "lumae-fresh",
  indexedPath: "/Users/awilliamspcsevents/PROJECTS/lumae-fresh",
  mcpUrl: "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp",
  activePublicationId: "pub-19e2c2bf4fdc8521e63af051f55d75a8",
  activeEmbeddingRunId: "19e2c2bf4fdc8521e63af051f55d75a8",
  vectorizeIndex: "cfcode-lumae-hyde-1536-redo-b",
  generatedAt: "2026-04-30",
};

function renderDoc() {
  return `# ${metadata.repoName} MCP Code Search

Remote MCP code search for the indexed codebase at:

\`${metadata.indexedPath}\`

MCP URL:

\`${metadata.mcpUrl}\`

Active publication: \`${metadata.activePublicationId}\`  
Active embedding run: \`${metadata.activeEmbeddingRunId}\`  
Vectorize index: \`${metadata.vectorizeIndex}\`  
Generated: ${metadata.generatedAt}

## Try It In 30 Seconds

Claude Code:

\`\`\`bash
claude mcp add --transport http ${metadata.repoName}-code ${metadata.mcpUrl} -s user
\`\`\`

Then ask:

> Where is borrower document upload handled?

## Connect Your Client

All configs point to:

\`${metadata.mcpUrl}\`

### Claude Code

\`\`\`bash
claude mcp add --transport http ${metadata.repoName}-code ${metadata.mcpUrl} -s user
\`\`\`

### Claude Desktop

File: \`~/Library/Application Support/Claude/claude_desktop_config.json\`

\`\`\`json
{
  "mcpServers": {
    "${metadata.repoName}-code": {
      "url": "${metadata.mcpUrl}"
    }
  }
}
\`\`\`

### Cursor

File: \`~/.cursor/mcp.json\`

\`\`\`json
{
  "mcpServers": {
    "${metadata.repoName}-code": {
      "url": "${metadata.mcpUrl}"
    }
  }
}
\`\`\`

### Any MCP Client

\`\`\`bash
curl -X POST ${metadata.mcpUrl} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"collection_info","arguments":{}}}'
\`\`\`

## Incremental Reindex

Run from this repository:

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs \\
  --repo "${metadata.indexedPath}" \\
  --repo-slug "${metadata.repoName}" \\
  --mode incremental \\
  --diff-base origin/main \\
  --resume
\`\`\`

This command must:

- detect changed, added, renamed, and deleted files from Git diffs;
- reuse unchanged chunk artifacts by \`chunk_identity\`;
- reuse HyDE artifacts by \`content_hash + hyde_version + hyde_model\`;
- create a new embedding run only for changed embedding inputs;
- publish to a new Vectorize index and switch active publication only after verification.

## Resume A Failed Index

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs \\
  --repo "${metadata.indexedPath}" \\
  --repo-slug "${metadata.repoName}" \\
  --resume
\`\`\`

## Full Rebuild

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs \\
  --repo "${metadata.indexedPath}" \\
  --repo-slug "${metadata.repoName}" \\
  --mode full \\
  --embedding-model gemini-embedding-001 \\
  --dimensions 1536 \\
  --resume
\`\`\`

## Tools

- \`search\`: hybrid code search with snippets, line spans, scores, and match reasons.
- \`collection_info\`: active backend, indexed path, publication, and embedding metadata.
- \`get_chunk\`: fetch a chunk by identity.
- \`suggest_queries\`: generate follow-up search queries.
`;
}

async function main() {
  console.log("POC 19.5: Generated Codebase MCP Docs\n");
  await fs.mkdir(outputDir, { recursive: true });
  const doc = renderDoc();
  await fs.writeFile(outputPath, doc, "utf8");
  const checks = {
    indexedPath: doc.includes(metadata.indexedPath),
    mcpUrl: doc.includes(metadata.mcpUrl) && doc.includes("/mcp"),
    claudeCode: doc.includes("claude mcp add --transport http"),
    clientConfigs: doc.includes("Claude Desktop") && doc.includes("Cursor") && doc.includes("mcpServers"),
    incrementalCommand: doc.includes("--mode incremental") && doc.includes("--diff-base origin/main") && doc.includes("--resume"),
    resumableSemantics: doc.includes("content_hash + hyde_version + hyde_model") && doc.includes("switch active publication only after verification"),
  };
  console.log(`Generated: ${outputPath}`);
  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
