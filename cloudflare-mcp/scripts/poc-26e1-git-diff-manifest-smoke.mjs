#!/usr/bin/env node
/**
 * POC 26E1: Git Diff Manifest JSON Export
 *
 * Proves: This machine can export a deterministic, machine-readable git diff
 * manifest from lumae-fresh that Cloudflare can later store and process.
 *
 * No Cloudflare resources. Purely local git + file operations.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const targetRepo = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh";
const outputDir = path.join(repoRoot, "cloudflare-mcp/sessions/poc-26e1");

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;

function sha256(v) { return crypto.createHash("sha256").update(v).digest("hex"); }

function git(args) {
  const result = spawnSync("git", args, { cwd: targetRepo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function isIndexable(filePath) {
  return !SKIP_PATTERN.test(filePath) && !SKIP_EXT.test(filePath) &&
    !filePath.includes("node_modules") && !filePath.includes("__pycache__");
}

function buildManifest(baseRef, targetRef) {
  const repoSlug = "lumae-fresh";
  const indexedPath = targetRepo;
  const baseCommit = git(["rev-parse", baseRef]);
  const targetCommit = git(["rev-parse", targetRef || "HEAD"]);
  const workingTreeClean = git(["status", "--porcelain"]).length === 0;

  // Get diff between base and target
  const diffOutput = git(["diff", "--name-status", "--no-renames", baseRef, targetRef || "HEAD"]);
  // Also get renames separately
  const renameOutput = git(["diff", "--name-status", "-M", baseRef, targetRef || "HEAD"]);

  const files = [];
  const seen = new Set();

  // Parse renames first (they show as R<pct>\told\tnew)
  for (const line of renameOutput.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts[0].startsWith("R")) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!isIndexable(newPath) && !isIndexable(oldPath)) continue;
      seen.add(oldPath);
      seen.add(newPath);
      // Tombstone old path
      files.push({
        action: "renamed",
        file_path: newPath,
        previous_path: oldPath,
        ...getFileInfo(newPath),
      });
    }
  }

  // Parse adds/modifies/deletes
  for (const line of diffOutput.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0];
    const filePath = parts[1];
    if (seen.has(filePath)) continue; // already handled as rename
    if (!isIndexable(filePath)) continue;

    if (status === "A") {
      files.push({ action: "added", file_path: filePath, ...getFileInfo(filePath) });
    } else if (status === "M") {
      files.push({ action: "modified", file_path: filePath, ...getFileInfo(filePath) });
    } else if (status === "D") {
      files.push({ action: "deleted", file_path: filePath, sha256: null, bytes: null, blob_sha: null });
    }
  }

  // Also check working tree changes (unstaged/staged but uncommitted)
  if (!workingTreeClean) {
    const porcelain = git(["status", "--porcelain=v1"]);
    for (const line of porcelain.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      const filePath = line.slice(3);
      if (seen.has(filePath) || !isIndexable(filePath)) continue;
      if (xy.includes("?")) {
        // Untracked — treat as added (skip directories)
        const fullPath = path.join(targetRepo, filePath);
        try { if (fs.statSync(fullPath).isDirectory()) continue; } catch { continue; }
        files.push({ action: "added_untracked", file_path: filePath, ...getFileInfo(filePath) });
        seen.add(filePath);
      } else if (xy.includes("M") || xy.includes("A")) {
        if (!files.some(f => f.file_path === filePath)) {
          const fullPath2 = path.join(targetRepo, filePath);
          try { if (!fs.statSync(fullPath2).isFile()) continue; } catch { continue; }
          files.push({ action: "modified_working", file_path: filePath, ...getFileInfo(filePath) });
          seen.add(filePath);
        }
      }
    }
  }

  const manifestId = sha256(`${repoSlug}:${baseCommit}:${targetCommit}:${new Date().toISOString()}`).slice(0, 16);

  return {
    manifest_id: manifestId,
    repo_slug: repoSlug,
    repo_path: indexedPath,
    base_commit: baseCommit,
    target_commit: targetCommit,
    generated_at: new Date().toISOString(),
    working_tree_clean: workingTreeClean,
    summary: {
      added: files.filter(f => f.action === "added" || f.action === "added_untracked").length,
      modified: files.filter(f => f.action === "modified" || f.action === "modified_working").length,
      deleted: files.filter(f => f.action === "deleted").length,
      renamed: files.filter(f => f.action === "renamed").length,
      total: files.length,
    },
    files,
  };
}

function getFileInfo(relPath) {
  const fullPath = path.join(targetRepo, relPath);
  try {
    const content = fs.readFileSync(fullPath);
    const hash = sha256(content);
    let blobSha = null;
    try { blobSha = git(["hash-object", fullPath]); } catch { /* not tracked yet */ }
    return {
      sha256: hash,
      bytes: content.length,
      blob_sha: blobSha,
      artifact_key: `sources/${hash.slice(0, 16)}/${relPath}`,
    };
  } catch {
    return { sha256: null, bytes: null, blob_sha: null, artifact_key: null };
  }
}

function main() {
  console.log("POC 26E1: Git Diff Manifest JSON Export\n");
  const checks = {
    hasMetadata: false,
    classifiesFiles: false,
    changedHaveHashes: false,
    deletedAreTombstones: false,
    stableOnRerun: false,
  };

  // Use HEAD~5 as base to get some meaningful diffs
  // If not enough commits, fall back to HEAD~1
  let baseRef = "HEAD~5";
  try { git(["rev-parse", baseRef]); } catch { baseRef = "HEAD~1"; }

  const manifest1 = buildManifest(baseRef, "HEAD");

  // Write manifest
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "diff-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest1, null, 2), "utf8");

  console.log(`Base: ${manifest1.base_commit.slice(0, 8)}`);
  console.log(`Target: ${manifest1.target_commit.slice(0, 8)}`);
  console.log(`Working tree clean: ${manifest1.working_tree_clean}`);
  console.log(`Files: added=${manifest1.summary.added} modified=${manifest1.summary.modified} deleted=${manifest1.summary.deleted} renamed=${manifest1.summary.renamed} total=${manifest1.summary.total}`);
  console.log(`Manifest: ${manifestPath}`);

  // Check 1: metadata
  checks.hasMetadata = Boolean(
    manifest1.manifest_id && manifest1.base_commit && manifest1.target_commit &&
    manifest1.repo_path && manifest1.repo_slug && manifest1.generated_at
  );
  console.log(`\nhasMetadata: ${checks.hasMetadata ? "PASS" : "FAIL"}`);

  // Check 2: classifies files
  const actions = new Set(manifest1.files.map(f => f.action));
  checks.classifiesFiles = manifest1.files.length > 0 && actions.size > 0;
  console.log(`classifiesFiles: ${checks.classifiesFiles ? "PASS" : "FAIL"} (actions: ${[...actions].join(", ")})`);

  // Check 3: changed files have hashes
  const changedFiles = manifest1.files.filter(f => f.action !== "deleted");
  const allHaveHashes = changedFiles.every(f => f.sha256 && f.bytes !== null);
  checks.changedHaveHashes = changedFiles.length > 0 ? allHaveHashes : true;
  console.log(`changedHaveHashes: ${checks.changedHaveHashes ? "PASS" : "FAIL"} (${changedFiles.length} changed files)`);

  // Check 4: deleted files are tombstones (no text/hash)
  const deletedFiles = manifest1.files.filter(f => f.action === "deleted");
  checks.deletedAreTombstones = deletedFiles.length === 0 || deletedFiles.every(f => f.sha256 === null && f.bytes === null);
  console.log(`deletedAreTombstones: ${checks.deletedAreTombstones ? "PASS" : "FAIL"} (${deletedFiles.length} deleted)`);

  // Check 5: stable on rerun
  const manifest2 = buildManifest(baseRef, "HEAD");
  checks.stableOnRerun =
    manifest2.base_commit === manifest1.base_commit &&
    manifest2.target_commit === manifest1.target_commit &&
    manifest2.summary.total === manifest1.summary.total &&
    manifest2.files.length === manifest1.files.length &&
    manifest2.files.every((f, i) => f.file_path === manifest1.files[i].file_path && f.action === manifest1.files[i].action);
  console.log(`stableOnRerun: ${checks.stableOnRerun ? "PASS" : "FAIL"}`);

  // Summary
  console.log("\n══ Pass Criteria ══");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 26E1: PASS" : "❌ POC 26E1: FAIL"}`);
  if (!allPass) process.exit(1);
}

main();
