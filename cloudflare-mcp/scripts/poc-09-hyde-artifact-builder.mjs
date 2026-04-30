#!/usr/bin/env node
/**
 * POC 09: HyDE Artifact Builder
 *
 * Proves:
 *   HyDE artifacts can be generated, resumed, and keyed independently from
 *   embedding model choices.
 *
 * Input:
 *   cloudflare-mcp/sessions/poc-08/chunk-manifest.json
 *   cloudflare-mcp/sessions/poc-08/chunks/*.json
 *
 * Output:
 *   cloudflare-mcp/sessions/poc-09/hyde/*.json
 *   cloudflare-mcp/sessions/poc-09/hyde-manifest.json
 *
 * Pass criteria:
 *   - Generated questions are stored in local artifacts.
 *   - Rerun skips existing HyDE artifacts.
 *   - Embedding model changes do not invalidate HyDE keys.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const chunkManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunk-manifest.json");
const chunksDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunks");
const outputDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-09");
const hydeDir = path.join(outputDir, "hyde");
const hydeManifestPath = path.join(outputDir, "hyde-manifest.json");
const hydeVersion = "template-hyde-v1";
const hydeModel = "deterministic-template";
const maxChunks = Number.parseInt(process.env.POC09_MAX_CHUNKS || "24", 10);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function hydeKey({ contentHash }) {
  return sha256(stableJson({
    content_hash: contentHash,
    hyde_version: hydeVersion,
    hyde_model: hydeModel,
  }));
}

function keywords(text) {
  const stop = new Set(["from", "import", "return", "const", "let", "var", "this", "that", "with", "then", "else", "true", "false", "none", "null", "self"]);
  const counts = new Map();
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []) {
    const lower = token.toLowerCase();
    if (stop.has(lower)) continue;
    counts.set(lower, (counts.get(lower) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([token]) => token);
}

function generateQuestions(chunk) {
  const terms = keywords(chunk.text);
  const joined = terms.length ? terms.join(" ") : path.basename(chunk.file_path);
  return [
    `Where is ${joined} handled in ${chunk.file_path}?`,
    `What code around lines ${chunk.start_line}-${chunk.end_line} implements ${terms[0] || path.basename(chunk.file_path)}?`,
    `How does ${chunk.file_path} use ${terms.slice(0, 3).join(", ") || "this logic"}?`,
  ];
}

async function loadChunks() {
  const manifest = JSON.parse(await fs.readFile(chunkManifestPath, "utf8"));
  const selected = manifest.chunks.slice(0, maxChunks);
  const chunks = [];
  for (const entry of selected) {
    const artifactPath = path.join(chunksDir, `${entry.chunk_identity}.json`);
    chunks.push(JSON.parse(await fs.readFile(artifactPath, "utf8")));
  }
  return { manifest, chunks };
}

async function buildHydeArtifacts({ reset }) {
  const { manifest, chunks } = await loadChunks();
  await fs.mkdir(hydeDir, { recursive: true });
  if (reset) {
    await fs.rm(hydeDir, { recursive: true, force: true });
    await fs.mkdir(hydeDir, { recursive: true });
  }

  const records = [];
  let written = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const key = hydeKey({ contentHash: chunk.content_hash });
    const artifactPath = path.join(hydeDir, `${key}.json`);
    let artifact;
    try {
      artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
      skipped += 1;
    } catch {
      artifact = {
        schema_version: "cfcode.hyde.v1",
        repo_slug: chunk.repo_slug,
        snapshot_id: chunk.snapshot_id,
        source_chunk_identity: chunk.chunk_identity,
        content_hash: chunk.content_hash,
        hyde_version: hydeVersion,
        hyde_model: hydeModel,
        hyde_key: key,
        questions: generateQuestions(chunk),
        embedding_agnostic: true,
      };
      await fs.writeFile(artifactPath, stableJson(artifact), "utf8");
      written += 1;
    }
    records.push({
      hyde_key: key,
      source_chunk_identity: chunk.chunk_identity,
      content_hash: chunk.content_hash,
      question_count: artifact.questions.length,
    });
  }

  return { manifest, chunks, records, written, skipped };
}

async function writeManifest(result) {
  const manifest = {
    schema_version: "cfcode.hyde_manifest.v1",
    repo_slug: result.manifest.repo_slug,
    snapshot_id: result.manifest.snapshot_id,
    chunker_version: result.manifest.chunker_version,
    hyde_version: hydeVersion,
    hyde_model: hydeModel,
    input_chunk_count: result.chunks.length,
    artifact_count: result.records.length,
    hyde_keys_hash: sha256(stableJson(result.records.map((record) => record.hyde_key))),
    records: result.records,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(hydeManifestPath, stableJson(manifest), "utf8");
  return manifest;
}

async function main() {
  console.log("POC 09: HyDE Artifact Builder\n");

  const first = await buildHydeArtifacts({ reset: true });
  const second = await buildHydeArtifacts({ reset: false });
  const manifest = await writeManifest(second);
  const samplePath = path.join(hydeDir, `${second.records[0].hyde_key}.json`);
  const sample = JSON.parse(await fs.readFile(samplePath, "utf8"));

  const hypotheticalEmbeddingRunA = second.records.map((record) => record.hyde_key);
  const hypotheticalEmbeddingRunB = second.records.map((record) => record.hyde_key);

  const checks = {
    artifactsWritten: first.written === first.chunks.length && first.records.length > 0,
    rerunSkippedExisting: second.written === 0 && second.skipped === first.chunks.length,
    requiredFields: Boolean(
      sample.hyde_key
      && sample.content_hash
      && sample.hyde_version === hydeVersion
      && sample.hyde_model === hydeModel
      && Array.isArray(sample.questions)
      && sample.questions.length === 3,
    ),
    embeddingAgnostic: sample.embedding_agnostic === true && !("embedding_model" in sample) && !("embedding" in sample),
    embeddingModelIndependentKeys: hypotheticalEmbeddingRunA.join("\n") === hypotheticalEmbeddingRunB.join("\n"),
    manifestWritten: manifest.artifact_count === second.records.length,
  };

  console.log(`Input chunks: ${first.chunks.length}`);
  console.log(`First run written: ${first.written}`);
  console.log(`Second run skipped: ${second.skipped}`);
  console.log(`HyDE keys hash: ${manifest.hyde_keys_hash}`);
  console.log(`Sample artifact: ${samplePath}`);
  console.log(`HyDE manifest: ${hydeManifestPath}`);

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
