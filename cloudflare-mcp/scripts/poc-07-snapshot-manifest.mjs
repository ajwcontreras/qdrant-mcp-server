#!/usr/bin/env node
/**
 * POC 07: Snapshot Manifest Builder
 *
 * Proves:
 *   A local script can produce a deterministic repo snapshot manifest without
 *   indexing, embeddings, Qdrant, or Cloudflare writes.
 *
 * Input:
 *   Tracked files from /Users/awilliamspcsevents/PROJECTS/lumae-fresh.
 *
 * Output:
 *   cloudflare-mcp/sessions/poc-07/snapshot-manifest.json
 *
 * Pass criteria:
 *   - Manifest lists tracked files with sha256 hashes and byte sizes.
 *   - Rerun on unchanged repo produces the same snapshot ID.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const targetRepo = process.env.POC_TARGET_REPO || "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const repoSlug = process.env.POC_REPO_SLUG || path.basename(targetRepo).replace(/[^A-Za-z0-9._-]+/g, "-");
const outputDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-07");
const outputPath = path.join(outputDir, "snapshot-manifest.json");

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: targetRepo,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

async function trackedFiles() {
  return runGit(["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

async function buildManifest() {
  const files = await trackedFiles();
  const head = runGit(["rev-parse", "HEAD"]).toString("utf8").trim();
  const entries = [];

  for (const relativePath of files) {
    const absolutePath = path.join(targetRepo, relativePath);
    const bytes = await fs.readFile(absolutePath);
    entries.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const entriesHash = sha256(stableJson(entries));
  const snapshotId = sha256(stableJson({
    schema_version: "cfcode.snapshot.v1",
    repo_slug: repoSlug,
    entries_hash: entriesHash,
  })).slice(0, 32);

  return {
    schema_version: "cfcode.snapshot.v1",
    repo_slug: repoSlug,
    repo_root: targetRepo,
    git_head: head,
    snapshot_id: snapshotId,
    entries_hash: entriesHash,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
}

async function main() {
  console.log("POC 07: Snapshot Manifest Builder\n");

  const first = await buildManifest();
  const second = await buildManifest();

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, stableJson(first), "utf8");

  const checks = {
    trackedFiles: first.file_count > 0,
    fileHashes: first.files.every((entry) => entry.path && entry.bytes >= 0 && /^[0-9a-f]{64}$/.test(entry.sha256)),
    byteSizes: first.total_bytes > 0 && first.files.some((entry) => entry.bytes > 0),
    deterministicSnapshotId: first.snapshot_id === second.snapshot_id,
    outputWritten: (await fs.stat(outputPath)).size > 1000,
  };

  console.log(`Repo: ${targetRepo}`);
  console.log(`Files: ${first.file_count}`);
  console.log(`Total bytes: ${first.total_bytes}`);
  console.log(`Snapshot ID: ${first.snapshot_id}`);
  console.log(`Entries hash: ${first.entries_hash}`);
  console.log(`Manifest: ${outputPath}`);

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }

  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
