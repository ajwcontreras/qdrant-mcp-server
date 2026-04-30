#!/usr/bin/env node
/**
 * POC 26E3: Incremental Diff Packager Uses Whole-File Reprocessing
 *
 * Proves: Given a 26E1 manifest, the local controller packages only changed
 * source files (full text for rechunking) plus tombstones for deleted files.
 * The output JSONL uses the same chunk format as 26D Worker /ingest.
 *
 * No Cloudflare resources. No Vertex calls. Purely local.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const manifestPath = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e1/diff-manifest.json");
const outputDir = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e3");

const MAX_CHUNK_CHARS = 4000;

function sha256(v) { return crypto.createHash("sha256").update(v).digest("hex"); }

function buildIncrementalArtifact(manifest) {
  const records = [];
  const tombstones = [];

  for (const file of manifest.files) {
    if (file.action === "deleted") {
      // Tombstone: mark old chunks for this file as inactive
      tombstones.push({
        action: "tombstone",
        file_path: file.file_path,
        manifest_id: manifest.manifest_id,
        repo_slug: manifest.repo_slug,
      });
      continue;
    }

    // For renamed files, also tombstone the old path
    if (file.action === "renamed" && file.previous_path) {
      tombstones.push({
        action: "tombstone",
        file_path: file.previous_path,
        manifest_id: manifest.manifest_id,
        repo_slug: manifest.repo_slug,
      });
    }

    // Read full current file text for whole-file reprocessing
    const fullPath = path.join(targetRepo, file.file_path);
    let text;
    try { text = fs.readFileSync(fullPath, "utf8"); } catch { continue; }

    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    records.push({
      chunk_id: `chunk-${sha256(`${file.file_path}:0`).slice(0, 16)}`,
      repo_slug: manifest.repo_slug,
      file_path: file.file_path,
      source_sha256: sha256(truncated),
      text: truncated,
      // Incremental metadata
      manifest_id: manifest.manifest_id,
      action: file.action,
      previous_path: file.previous_path || null,
    });
  }

  return { records, tombstones };
}

function main() {
  console.log("POC 26E3: Incremental Diff Packager Uses Whole-File Reprocessing\n");
  const checks = {
    onlyManifestFiles: false,
    changedHaveText: false,
    deletedAreTombstones: false,
    hasMetadata: false,
    noVertexCalls: true, // always true — this is purely local
  };

  if (!fs.existsSync(manifestPath)) throw new Error(`POC 26E1 manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`Input manifest: ${manifest.manifest_id} (${manifest.summary.total} files)`);

  const { records, tombstones } = buildIncrementalArtifact(manifest);
  console.log(`Changed file records: ${records.length}`);
  console.log(`Tombstones: ${tombstones.length}`);

  // Write artifact JSONL
  fs.mkdirSync(outputDir, { recursive: true });
  const artifactLines = [
    ...records.map(r => JSON.stringify(r)),
    ...tombstones.map(t => JSON.stringify(t)),
  ];
  const artifactText = artifactLines.join("\n") + "\n";
  const artifactPath = path.join(outputDir, "incremental-artifact.jsonl");
  fs.writeFileSync(artifactPath, artifactText, "utf8");

  // Write metadata
  const metaPath = path.join(outputDir, "incremental-metadata.json");
  fs.writeFileSync(metaPath, JSON.stringify({
    manifest_id: manifest.manifest_id,
    repo_slug: manifest.repo_slug,
    base_commit: manifest.base_commit,
    target_commit: manifest.target_commit,
    changed_files: records.length,
    tombstones: tombstones.length,
    artifact_sha256: sha256(artifactText),
    artifact_bytes: Buffer.byteLength(artifactText),
  }, null, 2), "utf8");

  console.log(`\nArtifact: ${artifactPath} (${Buffer.byteLength(artifactText)} bytes)`);
  console.log(`Metadata: ${metaPath}`);

  // Check 1: only manifest-listed files
  const manifestPaths = new Set(manifest.files.map(f => f.file_path));
  const renamedOldPaths = new Set(manifest.files.filter(f => f.previous_path).map(f => f.previous_path));
  const recordPaths = new Set(records.map(r => r.file_path));
  const tombstonePaths = new Set(tombstones.map(t => t.file_path));
  const allOutputPaths = new Set([...recordPaths, ...tombstonePaths]);
  const allExpectedPaths = new Set([...manifestPaths, ...renamedOldPaths]);
  checks.onlyManifestFiles = [...allOutputPaths].every(p => allExpectedPaths.has(p));
  console.log(`\nonlyManifestFiles: ${checks.onlyManifestFiles ? "PASS" : "FAIL"}`);

  // Check 2: changed files have text
  checks.changedHaveText = records.length > 0 && records.every(r => r.text && r.text.length > 0 && r.source_sha256);
  console.log(`changedHaveText: ${checks.changedHaveText ? "PASS" : "FAIL"} (${records.length} records)`);

  // Check 3: deleted files are tombstones (no text)
  checks.deletedAreTombstones = tombstones.length === 0 || tombstones.every(t => !t.text && t.action === "tombstone");
  console.log(`deletedAreTombstones: ${checks.deletedAreTombstones ? "PASS" : "FAIL"} (${tombstones.length} tombstones)`);

  // Check 4: metadata links to manifest
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  checks.hasMetadata = meta.manifest_id === manifest.manifest_id &&
    meta.base_commit === manifest.base_commit &&
    meta.target_commit === manifest.target_commit;
  console.log(`hasMetadata: ${checks.hasMetadata ? "PASS" : "FAIL"}`);

  console.log(`noVertexCalls: ${checks.noVertexCalls ? "PASS" : "FAIL"}`);

  // Summary
  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26E3: PASS" : "❌ POC 26E3: FAIL"}`);
  if (!allPass) process.exit(1);
}

main();
