#!/usr/bin/env node
/**
 * POC 16: Resume Interrupted Index
 *
 * Proves:
 *   A staged indexing pipeline can resume after interruption without
 *   recomputing completed chunk, HyDE, or embedding artifacts.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const sourceChunkManifestPath = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunk-manifest.json");
const sourceChunksDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-08", "chunks");
const sessionDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-16");
const chunkDir = path.join(sessionDir, "chunks");
const hydeDir = path.join(sessionDir, "hyde");
const embeddingDir = path.join(sessionDir, "embeddings");
const stageManifestPath = path.join(sessionDir, "stage-manifest.json");
const maxChunks = 10;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

async function readSourceChunks() {
  const manifest = JSON.parse(await fs.readFile(sourceChunkManifestPath, "utf8"));
  const records = manifest.chunks.slice(0, maxChunks);
  const chunks = [];
  for (const record of records) {
    chunks.push(JSON.parse(await fs.readFile(path.join(sourceChunksDir, `${record.chunk_identity}.json`), "utf8")));
  }
  return chunks;
}

async function maybeWriteJson(filePath, value) {
  try {
    await fs.access(filePath);
    return "skipped";
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, stableJson(value), "utf8");
    return "written";
  }
}

async function runPipeline({ interruptAfterHydeCount = Infinity } = {}) {
  const chunks = await readSourceChunks();
  const counts = {
    chunkWritten: 0,
    chunkSkipped: 0,
    hydeWritten: 0,
    hydeSkipped: 0,
    embeddingWritten: 0,
    embeddingSkipped: 0,
    interrupted: false,
  };

  for (const chunk of chunks) {
    const status = await maybeWriteJson(path.join(chunkDir, `${chunk.chunk_identity}.json`), chunk);
    counts[status === "written" ? "chunkWritten" : "chunkSkipped"] += 1;
  }

  for (const chunk of chunks) {
    if (counts.hydeWritten >= interruptAfterHydeCount) {
      counts.interrupted = true;
      break;
    }
    const hydeKey = sha256(stableJson({ content_hash: chunk.content_hash, hyde_version: "resume-hyde-v1", hyde_model: "template" }));
    const hyde = {
      hyde_key: hydeKey,
      source_chunk_identity: chunk.chunk_identity,
      content_hash: chunk.content_hash,
      questions: [`Where is ${path.basename(chunk.file_path)} used?`],
      embedding_agnostic: true,
    };
    const status = await maybeWriteJson(path.join(hydeDir, `${hydeKey}.json`), hyde);
    counts[status === "written" ? "hydeWritten" : "hydeSkipped"] += 1;
  }

  if (!counts.interrupted) {
    const hydeFiles = (await fs.readdir(hydeDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const hydeFile of hydeFiles) {
      const hyde = JSON.parse(await fs.readFile(path.join(hydeDir, hydeFile), "utf8"));
      const embedding = {
        vector_id: sha256(hyde.hyde_key).slice(0, 32),
        source_artifact: `hyde/${hydeFile}`,
        input_hash: sha256(hyde.questions.join("\n")),
        embedding_model: "resume-poc-hash-1536",
        dimension: 1536,
      };
      const status = await maybeWriteJson(path.join(embeddingDir, `${embedding.vector_id}.json`), embedding);
      counts[status === "written" ? "embeddingWritten" : "embeddingSkipped"] += 1;
    }
  }

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(stageManifestPath, stableJson({
    schema_version: "cfcode.resume_poc.v1",
    chunk_target: chunks.length,
    ...counts,
  }), "utf8");
  return counts;
}

async function countFiles(dir) {
  return (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).length;
}

async function main() {
  console.log("POC 16: Resume Interrupted Index\n");
  await fs.rm(sessionDir, { recursive: true, force: true });
  const first = await runPipeline({ interruptAfterHydeCount: 4 });
  const second = await runPipeline();
  const third = await runPipeline();
  const chunkCount = await countFiles(chunkDir);
  const hydeCount = await countFiles(hydeDir);
  const embeddingCount = await countFiles(embeddingDir);

  const checks = {
    interruptedFirstRun: first.interrupted === true && first.hydeWritten === 4 && first.embeddingWritten === 0,
    rerunSkippedChunks: second.chunkSkipped === maxChunks && second.chunkWritten === 0,
    rerunCompletedHyde: second.hydeSkipped === 4 && second.hydeWritten === maxChunks - 4,
    rerunCompletedEmbeddings: second.embeddingWritten === maxChunks,
    thirdRunNoRecompute: third.chunkSkipped === maxChunks && third.hydeSkipped === maxChunks && third.embeddingSkipped === maxChunks,
    finalCounts: chunkCount === maxChunks && hydeCount === maxChunks && embeddingCount === maxChunks,
  };

  console.log(`First run: ${JSON.stringify(first)}`);
  console.log(`Second run: ${JSON.stringify(second)}`);
  console.log(`Third run: ${JSON.stringify(third)}`);
  console.log(`Final counts: chunks=${chunkCount} hyde=${hydeCount} embeddings=${embeddingCount}`);

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
