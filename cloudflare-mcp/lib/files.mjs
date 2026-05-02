// File discovery, chunking, manifests, and incremental artifact packaging.
// Pulled from poc-26d3 (full-job), poc-26e1 (manifest), poc-26e3 (incremental packager).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git } from "./exec.mjs";

const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 1_000_000; // 1MB hard cap per file

export function sha256(v) { return crypto.createHash("sha256").update(v).digest("hex"); }
export function chunkIdFor(filePath, chunkIndex = 0) {
  return `chunk-${sha256(`${filePath}:${chunkIndex}`).slice(0, 16)}`;
}

// Filter git-tracked files to source files only.
export function listSourceFiles(repoPath) {
  const r = git(repoPath, ["ls-files"]);
  return r.stdout.trim().split("\n").filter(f =>
    f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__")
  );
}

// Read file safely; return null if unreadable, too large, or a directory.
export function readFileText(repoPath, relPath) {
  const fullPath = path.join(repoPath, relPath);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(fullPath, "utf8");
  } catch { return null; }
}

// Build full-job chunk records. Tries AST-aware chunking first; falls back to 4KB truncation.
export async function buildFullChunks(repoPath, repoSlug) {
  let astChunk = () => null;
  try { const mod = await import("./ast-chunk.mjs"); astChunk = mod.astChunk; } catch { /* optional */ }

  const files = listSourceFiles(repoPath);
  const chunks = [];
  for (const relPath of files) {
    const text = readFileText(repoPath, relPath);
    if (text === null) continue;

    // Try AST-aware chunking
    const astChunks = astChunk(text, relPath);
    if (astChunks && astChunks.length > 1) {
      for (let i = 0; i < astChunks.length; i++) {
        const c = astChunks[i];
        if (!c.text) continue;
        chunks.push({
          chunk_id: chunkIdFor(relPath, i),
          repo_slug: repoSlug,
          file_path: relPath,
          source_sha256: sha256(c.text),
          text: c.text,
        });
      }
    } else {
      // Fallback: one chunk per file, truncated
      const truncated = text.slice(0, MAX_CHUNK_CHARS);
      chunks.push({
        chunk_id: chunkIdFor(relPath, 0),
        repo_slug: repoSlug,
        file_path: relPath,
        source_sha256: sha256(truncated),
        text: truncated,
      });
    }
  }
  return chunks;
}

// Resolve a git ref to its commit SHA.
export function resolveCommit(repoPath, ref) {
  return git(repoPath, ["rev-parse", ref]).stdout.trim();
}

// Build a diff manifest between two refs (mirrors POC 26E1).
// Skips directory entries from porcelain output.
export function buildDiffManifest(repoPath, repoSlug, baseRef, targetRef) {
  const baseCommit = resolveCommit(repoPath, baseRef);
  const targetCommit = resolveCommit(repoPath, targetRef);
  const diff = git(repoPath, ["diff", "--name-status", `${baseCommit}..${targetCommit}`]).stdout.trim();
  const files = [];
  let added = 0, modified = 0, deleted = 0, renamed = 0;
  for (const line of diff.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (code === "A") {
      const p = parts[1];
      if (!isDir(repoPath, p)) { files.push({ action: "added", file_path: p }); added++; }
    } else if (code === "M") {
      const p = parts[1];
      if (!isDir(repoPath, p)) { files.push({ action: "modified", file_path: p }); modified++; }
    } else if (code === "D") {
      files.push({ action: "deleted", file_path: parts[1] }); deleted++;
    } else if (code.startsWith("R")) {
      const oldP = parts[1], newP = parts[2];
      if (!isDir(repoPath, newP)) { files.push({ action: "renamed", file_path: newP, previous_path: oldP }); renamed++; }
    }
  }
  const summary = { total: files.length, added, modified, deleted, renamed };
  const manifestId = sha256(`${repoSlug}:${baseCommit}:${targetCommit}`).slice(0, 16);
  return { manifest_id: manifestId, repo_slug: repoSlug, base_commit: baseCommit, target_commit: targetCommit, summary, files };
}

function isDir(repoPath, relPath) {
  try { return fs.statSync(path.join(repoPath, relPath)).isDirectory(); } catch { return false; }
}

// Package an incremental artifact: tombstones for deleted files, full-text records for changed.
// Mirrors POC 26E3 output format.
export function buildIncrementalArtifact(repoPath, manifest) {
  const records = [];
  const tombstones = [];
  for (const file of manifest.files) {
    if (file.action === "deleted") {
      tombstones.push({ action: "tombstone", file_path: file.file_path, manifest_id: manifest.manifest_id, repo_slug: manifest.repo_slug });
      continue;
    }
    if (file.action === "renamed" && file.previous_path) {
      tombstones.push({ action: "tombstone", file_path: file.previous_path, manifest_id: manifest.manifest_id, repo_slug: manifest.repo_slug });
    }
    const text = readFileText(repoPath, file.file_path);
    if (text === null) continue;
    const truncated = text.slice(0, MAX_CHUNK_CHARS);
    records.push({
      chunk_id: chunkIdFor(file.file_path, 0),
      repo_slug: manifest.repo_slug,
      file_path: file.file_path,
      source_sha256: sha256(truncated),
      text: truncated,
      manifest_id: manifest.manifest_id,
      action: file.action,
      previous_path: file.previous_path || null,
    });
  }
  return { records, tombstones };
}

export function artifactToJsonl({ records, tombstones }) {
  const lines = [...records.map(r => JSON.stringify(r)), ...tombstones.map(t => JSON.stringify(t))];
  return lines.join("\n") + "\n";
}

export function fullChunksToJsonl(chunks) {
  return chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
}
