#!/usr/bin/env node
import { buildFullChunks } from "../cloudflare-mcp/lib/files.mjs";

const targets = [
  ["agent-council", "/Users/awilliamspcsevents/PROJECTS/agent-council"],
  ["income-scout-bun", "/Users/awilliamspcsevents/PROJECTS/income-scout-bun"],
  ["lumae-upload-api", "/Users/awilliamspcsevents/PROJECTS/lumae-upload-api"],
  ["mortgage-rag", "/Users/awilliamspcsevents/mortgage-rag"],
  ["reviewer-s-workbench", "/Users/awilliamspcsevents/PROJECTS/reviewer-s-workbench"],
];

for (const [slug, repoPath] of targets) {
  const chunks = await buildFullChunks(repoPath, slug);
  console.log(`${slug}\t${chunks.length}`);
}
