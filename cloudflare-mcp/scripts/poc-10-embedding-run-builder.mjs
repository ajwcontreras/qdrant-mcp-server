#!/usr/bin/env node
/**
 * POC 10: Embedding Run Builder
 *
 * Proves:
 *   Embeddings can be regenerated for the same chunk/HyDE artifacts with
 *   different model/dimension choices without changing upstream artifacts.
 *
 * Input:
 *   cloudflare-mcp/sessions/poc-08/chunk-manifest.json
 *   cloudflare-mcp/sessions/poc-09/hyde-manifest.json
 *
 * Output:
 *   cloudflare-mcp/sessions/poc-10/runs/{embeddingRunId}/manifest.json
 *   cloudflare-mcp/sessions/poc-10/runs/{embeddingRunId}/vectors/*.json
 *
 * Pass criteria:
 *   - Two embedding runs over the same inputs produce separate manifests.
 *   - Vectors include embedding_model, dimension, input_hash, source_artifact.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const chunkManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunk-manifest.json");
const hydeManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-09", "hyde-manifest.json");
const chunksDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunks");
const hydeDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-09", "hyde");
const outputRoot = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-10", "runs");
const maxPairs = Number.parseInt(process.env.POC10_MAX_PAIRS || "12", 10);

const runs = [
  { embedding_model: "poc-hash-embed-768", dimension: 768, channel: "code" },
  { embedding_model: "poc-hash-embed-1536", dimension: 1536, channel: "hyde" },
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function embeddingRunId(config, inputHash) {
  return sha256(stableJson({
    embedding_model: config.embedding_model,
    dimension: config.dimension,
    channel: config.channel,
    input_hash: inputHash,
  })).slice(0, 32);
}

function deterministicVector(seed, dimension) {
  const values = [];
  let counter = 0;
  while (values.length < dimension) {
    const digest = crypto.createHash("sha256").update(`${seed}:${counter}`).digest();
    for (let i = 0; i < digest.length && values.length < dimension; i += 2) {
      const raw = digest.readInt16BE(i);
      values.push(Number((raw / 32768).toFixed(6)));
    }
    counter += 1;
  }
  return values;
}

async function loadInputs() {
  const chunkManifest = JSON.parse(await fs.readFile(chunkManifestPath, "utf8"));
  const hydeManifest = JSON.parse(await fs.readFile(hydeManifestPath, "utf8"));
  const chunkRecords = chunkManifest.chunks.slice(0, maxPairs);
  const hydeRecords = hydeManifest.records.slice(0, maxPairs);
  const chunks = [];
  const hydes = [];

  for (const record of chunkRecords) {
    const artifactPath = path.join(chunksDir, `${record.chunk_identity}.json`);
    chunks.push({
      source_artifact: `chunks/${record.chunk_identity}.json`,
      artifact: JSON.parse(await fs.readFile(artifactPath, "utf8")),
    });
  }

  for (const record of hydeRecords) {
    const artifactPath = path.join(hydeDir, `${record.hyde_key}.json`);
    hydes.push({
      source_artifact: `hyde/${record.hyde_key}.json`,
      artifact: JSON.parse(await fs.readFile(artifactPath, "utf8")),
    });
  }

  return { chunkManifest, hydeManifest, chunks, hydes };
}

function recordsForRun(config, inputs) {
  const source = config.channel === "code" ? inputs.chunks : inputs.hydes;
  return source.map(({ source_artifact, artifact }) => {
    const inputText = config.channel === "code" ? artifact.text : artifact.questions.join("\n");
    const inputHash = sha256(inputText);
    const vectorId = sha256(stableJson({
      source_artifact,
      embedding_model: config.embedding_model,
      dimension: config.dimension,
      input_hash: inputHash,
    })).slice(0, 32);
    return {
      vector_id: vectorId,
      source_artifact,
      source_kind: config.channel,
      source_identity: artifact.chunk_identity || artifact.hyde_key,
      input_hash: inputHash,
      embedding_model: config.embedding_model,
      dimension: config.dimension,
      values: deterministicVector(`${vectorId}:${inputHash}`, config.dimension),
    };
  });
}

async function writeRun(config, inputs) {
  const records = recordsForRun(config, inputs);
  const inputHash = sha256(stableJson(records.map((record) => ({
    source_artifact: record.source_artifact,
    input_hash: record.input_hash,
  }))));
  const runId = embeddingRunId(config, inputHash);
  const runDir = path.join(outputRoot, runId);
  const vectorsDir = path.join(runDir, "vectors");
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(vectorsDir, { recursive: true });

  for (const record of records) {
    await fs.writeFile(path.join(vectorsDir, `${record.vector_id}.json`), stableJson(record), "utf8");
  }

  const manifest = {
    schema_version: "cfcode.embedding_run.v1",
    embedding_run_id: runId,
    embedding_model: config.embedding_model,
    dimension: config.dimension,
    channel: config.channel,
    input_hash: inputHash,
    input_snapshot_id: inputs.chunkManifest.snapshot_id,
    input_chunk_manifest_hash: inputs.chunkManifest.chunk_identities_hash,
    input_hyde_manifest_hash: inputs.hydeManifest.hyde_keys_hash,
    vector_count: records.length,
    vectors_hash: sha256(stableJson(records.map((record) => record.vector_id))),
    vectors: records.map((record) => ({
      vector_id: record.vector_id,
      source_artifact: record.source_artifact,
      source_kind: record.source_kind,
      source_identity: record.source_identity,
      input_hash: record.input_hash,
      embedding_model: record.embedding_model,
      dimension: record.dimension,
    })),
  };
  await fs.writeFile(path.join(runDir, "manifest.json"), stableJson(manifest), "utf8");
  return { runDir, manifest, records };
}

async function main() {
  console.log("POC 10: Embedding Run Builder\n");

  const inputs = await loadInputs();
  const results = [];
  for (const config of runs) {
    results.push(await writeRun(config, inputs));
  }

  const [first, second] = results;
  const firstVector = first.records[0];
  const secondVector = second.records[0];
  const upstreamBefore = {
    chunkManifest: inputs.chunkManifest.chunk_identities_hash,
    hydeManifest: inputs.hydeManifest.hyde_keys_hash,
  };
  const reloadedInputs = await loadInputs();
  const upstreamAfter = {
    chunkManifest: reloadedInputs.chunkManifest.chunk_identities_hash,
    hydeManifest: reloadedInputs.hydeManifest.hyde_keys_hash,
  };

  const checks = {
    separateManifests: first.manifest.embedding_run_id !== second.manifest.embedding_run_id,
    sameUpstreamInputs: first.manifest.input_snapshot_id === second.manifest.input_snapshot_id,
    vectorMetadata: Boolean(
      firstVector.embedding_model
      && firstVector.dimension === 768
      && firstVector.input_hash
      && firstVector.source_artifact,
    ),
    dimensionsDiffer: firstVector.values.length === 768 && secondVector.values.length === 1536,
    upstreamUnchanged: stableJson(upstreamBefore) === stableJson(upstreamAfter),
    manifestsWritten: first.manifest.vector_count === maxPairs && second.manifest.vector_count === maxPairs,
  };

  console.log(`Run A: ${first.manifest.embedding_run_id} ${first.manifest.embedding_model}/${first.manifest.dimension} vectors=${first.manifest.vector_count}`);
  console.log(`Run B: ${second.manifest.embedding_run_id} ${second.manifest.embedding_model}/${second.manifest.dimension} vectors=${second.manifest.vector_count}`);
  console.log(`Run A dir: ${first.runDir}`);
  console.log(`Run B dir: ${second.runDir}`);

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
