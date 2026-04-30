#!/usr/bin/env node
/**
 * POC 08: Chunk Artifact Builder
 *
 * Proves:
 *   Chunking can write stable, embedding-agnostic JSON artifacts from a
 *   snapshot manifest.
 *
 * Input:
 *   cloudflare-mcp/sessions/poc-07/snapshot-manifest.json
 *
 * Output:
 *   cloudflare-mcp/sessions/poc-08/chunks/*.json
 *   cloudflare-mcp/sessions/poc-08/chunk-manifest.json
 *
 * Pass criteria:
 *   - Chunk JSON includes chunk_identity, content_hash, line span, and text.
 *   - Rerun over the same snapshot produces the same identities.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const snapshotPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-07", "snapshot-manifest.json");
const outputDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08");
const chunksDir = path.join(outputDir, "chunks");
const chunkManifestPath = path.join(outputDir, "chunk-manifest.json");
const chunkerVersion = "line-window-v1";
const maxFiles = Number.parseInt(process.env.POC08_MAX_FILES || "8", 10);
const linesPerChunk = Number.parseInt(process.env.POC08_LINES_PER_CHUNK || "80", 10);

const preferredPaths = [
  "app.py",
  "auth.py",
  "chat_documents_api.py",
  "update_market_rate_change.py",
  "utils/rag_tool.py",
  "utils/pipeline_semantic_search.py",
  "README.md",
  "workflow.py",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function identityFor({ repoSlug, filePath, chunkIndex, sourceSha256 }) {
  return sha256(stableJson({
    repo_slug: repoSlug,
    file_path: filePath,
    chunker_version: chunkerVersion,
    chunk_index: chunkIndex,
    source_sha256: sourceSha256,
  })).slice(0, 32);
}

function selectFiles(snapshot) {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const selected = [];
  for (const filePath of preferredPaths) {
    const entry = byPath.get(filePath);
    if (entry) selected.push(entry);
  }
  if (selected.length >= maxFiles) return selected.slice(0, maxFiles);

  const sourceLike = snapshot.files
    .filter((entry) => /\.(py|js|ts|tsx|md|html|css|json)$/i.test(entry.path))
    .filter((entry) => !selected.some((existing) => existing.path === entry.path))
    .slice(0, maxFiles - selected.length);
  return [...selected, ...sourceLike];
}

async function buildChunks() {
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const files = selectFiles(snapshot);
  const chunks = [];

  for (const file of files) {
    const absolutePath = path.join(snapshot.repo_root, file.path);
    const text = await fs.readFile(absolutePath, "utf8");
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    for (let start = 0; start < lines.length; start += linesPerChunk) {
      const endExclusive = Math.min(lines.length, start + linesPerChunk);
      const chunkText = lines.slice(start, endExclusive).join("\n");
      if (!chunkText.trim()) continue;

      const chunkIndex = Math.floor(start / linesPerChunk);
      const contentHash = sha256(chunkText);
      const chunkIdentity = identityFor({
        repoSlug: snapshot.repo_slug,
        filePath: file.path,
        chunkIndex,
        sourceSha256: file.sha256,
      });

      chunks.push({
        schema_version: "cfcode.chunk.v1",
        repo_slug: snapshot.repo_slug,
        snapshot_id: snapshot.snapshot_id,
        chunker_version: chunkerVersion,
        chunk_identity: chunkIdentity,
        content_hash: contentHash,
        source_file_sha256: file.sha256,
        file_path: file.path,
        chunk_index: chunkIndex,
        start_line: start + 1,
        end_line: endExclusive,
        text: chunkText,
        embedding_agnostic: true,
      });
    }
  }

  chunks.sort((a, b) => a.chunk_identity.localeCompare(b.chunk_identity));
  return { snapshot, files, chunks };
}

async function writeArtifacts(chunks) {
  await fs.rm(chunksDir, { recursive: true, force: true });
  await fs.mkdir(chunksDir, { recursive: true });
  for (const chunk of chunks) {
    await fs.writeFile(path.join(chunksDir, `${chunk.chunk_identity}.json`), stableJson(chunk), "utf8");
  }
}

async function writeManifest(snapshot, files, chunks) {
  const manifest = {
    schema_version: "cfcode.chunk_manifest.v1",
    repo_slug: snapshot.repo_slug,
    snapshot_id: snapshot.snapshot_id,
    chunker_version: chunkerVersion,
    input_file_count: files.length,
    chunk_count: chunks.length,
    chunk_identities_hash: sha256(stableJson(chunks.map((chunk) => chunk.chunk_identity))),
    chunks: chunks.map((chunk) => ({
      chunk_identity: chunk.chunk_identity,
      content_hash: chunk.content_hash,
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    })),
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(chunkManifestPath, stableJson(manifest), "utf8");
  return manifest;
}

async function main() {
  console.log("POC 08: Chunk Artifact Builder\n");

  const first = await buildChunks();
  const second = await buildChunks();
  await writeArtifacts(first.chunks);
  const manifest = await writeManifest(first.snapshot, first.files, first.chunks);

  const firstIdentities = first.chunks.map((chunk) => chunk.chunk_identity).join("\n");
  const secondIdentities = second.chunks.map((chunk) => chunk.chunk_identity).join("\n");
  const sample = first.chunks[0];
  const artifactPath = path.join(chunksDir, `${sample.chunk_identity}.json`);
  const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));

  const checks = {
    inputSnapshot: first.snapshot.snapshot_id === "23c63e09629087a9681963d2600c55c2",
    chunksCreated: first.chunks.length > first.files.length,
    requiredFields: Boolean(
      artifact.chunk_identity
      && artifact.content_hash
      && artifact.start_line > 0
      && artifact.end_line >= artifact.start_line
      && artifact.text,
    ),
    embeddingAgnostic: artifact.embedding_agnostic === true && !("embedding" in artifact),
    stableIdentities: firstIdentities === secondIdentities,
    manifestWritten: manifest.chunk_count === first.chunks.length,
  };

  console.log(`Snapshot ID: ${first.snapshot.snapshot_id}`);
  console.log(`Input files: ${first.files.length}`);
  console.log(`Chunks: ${first.chunks.length}`);
  console.log(`Chunk identities hash: ${manifest.chunk_identities_hash}`);
  console.log(`Sample artifact: ${artifactPath}`);
  console.log(`Chunk manifest: ${chunkManifestPath}`);

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
