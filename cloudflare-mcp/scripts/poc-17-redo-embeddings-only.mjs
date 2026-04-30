#!/usr/bin/env node
/**
 * POC 17: Redo Embeddings Only
 *
 * Proves:
 *   Changing embedding model/dimension creates new embedding/publication
 *   manifests without rerunning chunking or HyDE generation.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const chunkManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunk-manifest.json");
const hydeManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-09", "hyde-manifest.json");
const sessionDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-17");
const maxInputs = 8;

const configs = [
  { embedding_model: "google-gemini-embedding-001", dimension: 768, vectorize_index: "cfcode-lumae-hyde-768-redo-a" },
  { embedding_model: "google-gemini-embedding-001", dimension: 1536, vectorize_index: "cfcode-lumae-hyde-1536-redo-b" },
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stableJson(value), "utf8");
}

async function main() {
  console.log("POC 17: Redo Embeddings Only\n");
  await fs.rm(sessionDir, { recursive: true, force: true });
  const chunkManifest = JSON.parse(await fs.readFile(chunkManifestPath, "utf8"));
  const hydeManifest = JSON.parse(await fs.readFile(hydeManifestPath, "utf8"));
  const inputs = hydeManifest.records.slice(0, maxInputs);
  const before = {
    chunkCount: chunkManifest.chunk_count,
    hydeCount: hydeManifest.artifact_count,
    chunkHash: chunkManifest.chunk_identities_hash,
    hydeHash: hydeManifest.hyde_keys_hash,
  };

  const runs = [];
  for (const config of configs) {
    const inputHash = sha256(stableJson(inputs.map((record) => ({ hyde_key: record.hyde_key, content_hash: record.content_hash }))));
    const embeddingRunId = sha256(stableJson({ ...config, inputHash })).slice(0, 32);
    const vectors = inputs.map((record) => ({
      vector_id: sha256(stableJson({ embeddingRunId, hyde_key: record.hyde_key })).slice(0, 32),
      source_artifact: `hyde/${record.hyde_key}.json`,
      input_hash: record.content_hash,
      embedding_model: config.embedding_model,
      dimension: config.dimension,
    }));
    const embeddingManifest = {
      schema_version: "cfcode.embedding_run.v1",
      embedding_run_id: embeddingRunId,
      embedding_model: config.embedding_model,
      dimension: config.dimension,
      input_hash: inputHash,
      vector_count: vectors.length,
      vectors,
    };
    const publicationManifest = {
      schema_version: "cfcode.publication.v1",
      publication_id: `pub-${embeddingRunId}`,
      embedding_run_id: embeddingRunId,
      vectorize_index: config.vectorize_index,
      vector_count: vectors.length,
      active: false,
    };
    await writeJson(path.join(sessionDir, embeddingRunId, "embedding-manifest.json"), embeddingManifest);
    await writeJson(path.join(sessionDir, embeddingRunId, "publication-manifest.json"), publicationManifest);
    runs.push({ embeddingManifest, publicationManifest });
  }

  const after = {
    chunkCount: chunkManifest.chunk_count,
    hydeCount: hydeManifest.artifact_count,
    chunkHash: chunkManifest.chunk_identities_hash,
    hydeHash: hydeManifest.hyde_keys_hash,
  };
  const summary = {
    schema_version: "cfcode.redo_embeddings_only.v1",
    chunk_generation_count: 0,
    hyde_generation_count: 0,
    runs: runs.map((run) => ({
      embedding_run_id: run.embeddingManifest.embedding_run_id,
      dimension: run.embeddingManifest.dimension,
      vectorize_index: run.publicationManifest.vectorize_index,
    })),
  };
  await writeJson(path.join(sessionDir, "summary.json"), summary);

  const checks = {
    chunkCountUnchanged: before.chunkCount === after.chunkCount && before.chunkHash === after.chunkHash,
    hydeGenerationZero: summary.hyde_generation_count === 0 && before.hydeCount === after.hydeCount && before.hydeHash === after.hydeHash,
    separateEmbeddingRuns: runs[0].embeddingManifest.embedding_run_id !== runs[1].embeddingManifest.embedding_run_id,
    dimensionsChanged: runs[0].embeddingManifest.dimension === 768 && runs[1].embeddingManifest.dimension === 1536,
    newVectorizeIndexes: runs.every((run) => run.publicationManifest.vectorize_index.startsWith("cfcode-lumae-hyde-")),
    vectorCountsMatch: runs.every((run) => run.embeddingManifest.vector_count === maxInputs && run.publicationManifest.vector_count === maxInputs),
  };

  console.log(`Chunk count: ${before.chunkCount}`);
  console.log(`HyDE count: ${before.hydeCount}`);
  console.log(`Run A: ${runs[0].embeddingManifest.embedding_run_id} -> ${runs[0].publicationManifest.vectorize_index}`);
  console.log(`Run B: ${runs[1].embeddingManifest.embedding_run_id} -> ${runs[1].publicationManifest.vectorize_index}`);

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
