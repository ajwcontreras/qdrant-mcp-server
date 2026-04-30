#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const defaultServiceAccountPath = "/Users/awilliamspcsevents/Downloads/team (1).json";
const chunkerVersion = "line-window-v2";
const hydeVersion = "template-hyde-v1";
const hydeModel = "deterministic-template";
let googleTokenCache;
let googleTokenRequestCount = 0;

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

function intArg(name, fallback) {
  const parsed = Number.parseInt(arg(name, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function runGit(repo, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

function changedPathFromStatus(line) {
  const value = line.slice(3).trim();
  if (!value.includes(" -> ")) return value;
  return value.split(" -> ").pop().trim();
}

function selectFiles({ repo, mode, diffBase, tracked }) {
  if (mode === "full") return { changedPaths: new Set(tracked), pathsForIndex: tracked };
  const status = runGit(repo, ["status", "--short"]).stdout.trim().split("\n").filter(Boolean);
  const diff = runGit(repo, ["diff", "--name-status", `${diffBase}...HEAD`], true).stdout.trim().split("\n").filter(Boolean);
  const changedPaths = new Set([
    ...status.map(changedPathFromStatus).filter(Boolean),
    ...diff.map((line) => line.split(/\t+/).pop()).filter(Boolean),
  ]);
  return { changedPaths, pathsForIndex: tracked.filter((file) => changedPaths.has(file)) };
}

function chunkIdentity({ repoSlug, filePath, chunkIndex, sourceHash }) {
  return sha256(stableJson({ repo_slug: repoSlug, file_path: filePath, chunker_version: chunkerVersion, chunk_index: chunkIndex, source_sha256: sourceHash })).slice(0, 32);
}

function hydeKey(contentHash) {
  return sha256(stableJson({ content_hash: contentHash, hyde_version: hydeVersion, hyde_model: hydeModel }));
}

function keywords(text) {
  const stop = new Set(["from", "import", "return", "const", "let", "var", "this", "that", "with", "then", "else", "true", "false", "none", "null", "self"]);
  const counts = new Map();
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []) {
    const lower = token.toLowerCase();
    if (stop.has(lower)) continue;
    counts.set(lower, (counts.get(lower) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([token]) => token);
}

function hydeQuestions(chunk) {
  const terms = keywords(chunk.text);
  const joined = terms.length ? terms.join(" ") : path.basename(chunk.file_path);
  return [
    `Where is ${joined} handled in ${chunk.file_path}?`,
    `What code around lines ${chunk.start_line}-${chunk.end_line} implements ${terms[0] || path.basename(chunk.file_path)}?`,
    `How does ${chunk.file_path} use ${terms.slice(0, 3).join(", ") || "this logic"}?`,
  ];
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function googleToken(account) {
  const nowMs = Date.now();
  if (googleTokenCache && googleTokenCache.expiresAt - 60_000 > nowMs) return googleTokenCache.token;

  googleTokenRequestCount += 1;
  const now = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), account.private_key);
  const assertion = `${input}.${base64Url(signature)}`;
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Google token request failed ${response.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error("Google token response did not include access_token");
  googleTokenCache = {
    token: data.access_token,
    expiresAt: nowMs + Math.max(60, data.expires_in || 3600) * 1000,
  };
  return googleTokenCache.token;
}

async function embedGoogle({ account, text, dimension, model, location, taskType }) {
  const project = account.project_id;
  const token = await googleToken(account);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ content: text, task_type: taskType }],
      parameters: { autoTruncate: true, outputDimensionality: dimension },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Vertex embedding request failed ${response.status}: ${raw.slice(0, 500)}`);
  const values = JSON.parse(raw).predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || values.length !== dimension) throw new Error(`Vertex returned invalid embedding length for ${model}`);
  return values;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stableJson(value), "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function buildChunks({ repo, repoSlug, files, sessionDir, linesPerChunk, maxChars, resume }) {
  const chunks = [];
  let written = 0;
  let skipped = 0;
  for (const filePath of files) {
    const absolute = path.join(repo, filePath);
    let text;
    try {
      text = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const normalized = text.replace(/\r\n/g, "\n");
    const sourceHash = sha256(normalized);
    const lines = normalized.split("\n");
    for (let start = 0; start < lines.length; start += linesPerChunk) {
      const endExclusive = Math.min(lines.length, start + linesPerChunk);
      const chunkText = lines.slice(start, endExclusive).join("\n").slice(0, maxChars);
      if (!chunkText.trim()) continue;
      const chunkIndex = Math.floor(start / linesPerChunk);
      const contentHash = sha256(chunkText);
      const chunk = {
        schema_version: "cfcode.chunk.v2",
        repo_slug: repoSlug,
        chunker_version: chunkerVersion,
        chunk_identity: chunkIdentity({ repoSlug, filePath, chunkIndex, sourceHash }),
        content_hash: contentHash,
        source_file_sha256: sourceHash,
        file_path: filePath,
        chunk_index: chunkIndex,
        start_line: start + 1,
        end_line: endExclusive,
        text: chunkText,
        embedding_agnostic: true,
      };
      const artifactPath = path.join(sessionDir, "chunks", `${chunk.chunk_identity}.json`);
      if (resume && await readJsonIfExists(artifactPath)) skipped += 1;
      else {
        await writeJson(artifactPath, chunk);
        written += 1;
      }
      chunks.push(chunk);
    }
  }
  return { chunks, written, skipped };
}

async function buildHyde({ chunks, sessionDir, resume }) {
  let written = 0;
  let skipped = 0;
  const records = [];
  for (const chunk of chunks) {
    const key = hydeKey(chunk.content_hash);
    const artifactPath = path.join(sessionDir, "hyde", `${key}.json`);
    let artifact = resume ? await readJsonIfExists(artifactPath) : null;
    if (artifact) skipped += 1;
    else {
      artifact = {
        schema_version: "cfcode.hyde.v1",
        repo_slug: chunk.repo_slug,
        source_chunk_identity: chunk.chunk_identity,
        content_hash: chunk.content_hash,
        hyde_version: hydeVersion,
        hyde_model: hydeModel,
        hyde_key: key,
        questions: hydeQuestions(chunk),
        embedding_agnostic: true,
      };
      await writeJson(artifactPath, artifact);
      written += 1;
    }
    records.push({ ...artifact, chunk });
  }
  return { records, written, skipped };
}

async function buildEmbeddings({ records, sessionDir, resume, account, dimension, model, location, taskType }) {
  const inputHash = sha256(stableJson(records.map((record) => ({ hyde_key: record.hyde_key, content_hash: record.content_hash }))));
  const embeddingRunId = sha256(stableJson({ model, dimension, location, taskType, inputHash })).slice(0, 32);
  const runDir = path.join(sessionDir, "embeddings", embeddingRunId);
  const vectors = [];
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    const vectorId = sha256(stableJson({ embeddingRunId, hyde_key: record.hyde_key, chunk_identity: record.source_chunk_identity })).slice(0, 32);
    const artifactPath = path.join(runDir, `${vectorId}.json`);
    let artifact = resume ? await readJsonIfExists(artifactPath) : null;
    if (artifact) skipped += 1;
    else {
      const text = record.questions.join("\n");
      artifact = {
        schema_version: "cfcode.embedding.v1",
        vector_id: vectorId,
        embedding_run_id: embeddingRunId,
        embedding_model: model,
        dimension,
        input_hash: sha256(text),
        source_hyde_key: record.hyde_key,
        source_chunk_identity: record.source_chunk_identity,
        values: await embedGoogle({ account, text, dimension, model, location, taskType }),
      };
      await writeJson(artifactPath, artifact);
      written += 1;
    }
    vectors.push({ artifact, record });
  }
  await writeJson(path.join(runDir, "embedding-manifest.json"), {
    schema_version: "cfcode.embedding_run.v1",
    embedding_run_id: embeddingRunId,
    embedding_model: model,
    dimension,
    input_hash: inputHash,
    vector_count: vectors.length,
  });
  return { embeddingRunId, vectors, written, skipped };
}

async function publish({ publishUrl, vectors }) {
  if (!publishUrl || vectors.length === 0) return { published: 0, skipped: true };
  let published = 0;
  for (let i = 0; i < vectors.length; i += 50) {
    const batch = vectors.slice(i, i + 50).map(({ artifact, record }) => ({
      vector_id: artifact.vector_id,
      chunk_identity: record.source_chunk_identity,
      file_path: record.chunk.file_path,
      start_line: record.chunk.start_line,
      end_line: record.chunk.end_line,
      snippet: record.chunk.text.slice(0, 800),
      match_reason: "google-embedding: hyde question vector",
      values: artifact.values,
    }));
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunks: batch }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Publish failed ${response.status}: ${text.slice(0, 500)}`);
    published += batch.length;
  }
  return { published, skipped: false };
}

async function writeDocs({ sessionDir, repo, repoSlug, mcpUrl, mode, diffBase }) {
  if (!mcpUrl) return null;
  const docPath = path.join(sessionDir, `${repoSlug}-MCP.md`);
  const doc = `# ${repoSlug} MCP Code Search

Indexed path: \`${repo}\`

MCP URL: \`${mcpUrl}\`

\`\`\`bash
claude mcp add --transport http ${repoSlug}-code ${mcpUrl} -s user
\`\`\`

\`\`\`json
{"mcpServers":{"${repoSlug}-code":{"url":"${mcpUrl}"}}}
\`\`\`

Incremental resumable reindex:

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs --repo "${repo}" --repo-slug ${repoSlug} --mode incremental --diff-base ${diffBase} --resume --publish-url "${mcpUrl.replace(/\/mcp$/, "/ingest")}" --mcp-url "${mcpUrl}"
\`\`\`

Full redo with the same Google 1536d embedding target:

\`\`\`bash
node cloudflare-mcp/scripts/index-codebase.mjs --repo "${repo}" --repo-slug ${repoSlug} --mode full --resume --publish-url "${mcpUrl.replace(/\/mcp$/, "/ingest")}" --mcp-url "${mcpUrl}"
\`\`\`

Artifacts are stored under \`cloudflare-mcp/sessions/index-codebase/${repoSlug}\`. Chunk and HyDE files are embedding-agnostic; changing the embedding model or dimension creates a new embedding run without regenerating those artifacts.
`;
  await writeJson(path.join(sessionDir, "doc-manifest.json"), { schema_version: "cfcode.doc_manifest.v1", repo_slug: repoSlug, doc_path: docPath, mcp_url: mcpUrl, mode, diff_base: diffBase });
  await fs.writeFile(docPath, doc, "utf8");
  return docPath;
}

async function main() {
  const repo = arg("--repo");
  const repoSlug = arg("--repo-slug", repo ? path.basename(repo) : undefined);
  const mode = arg("--mode", "incremental");
  const diffBase = arg("--diff-base", "HEAD");
  const resume = has("--resume");
  const dryRun = has("--dry-run");
  const publishUrl = arg("--publish-url");
  const mcpUrl = arg("--mcp-url");
  const dimension = intArg("--dimension", 1536);
  const model = arg("--embedding-model", "gemini-embedding-001");
  const location = arg("--google-location", "us-central1");
  const taskType = arg("--task-type", "CODE_RETRIEVAL_QUERY");
  const linesPerChunk = intArg("--lines-per-chunk", 120);
  const maxChars = intArg("--max-chars", 12000);
  const limit = intArg("--limit", 0);
  const serviceAccountPath = arg("--service-account", process.env.GOOGLE_APPLICATION_CREDENTIALS || defaultServiceAccountPath);
  if (!repo || !repoSlug) throw new Error("--repo and --repo-slug are required");
  if (!["incremental", "full"].includes(mode)) throw new Error("--mode must be incremental or full");

  const tracked = runGit(repo, ["ls-files"]).stdout.trim().split("\n").filter(Boolean);
  const { changedPaths, pathsForIndex } = selectFiles({ repo, mode, diffBase, tracked });
  const selected = limit > 0 ? pathsForIndex.slice(0, limit) : pathsForIndex;
  const sessionDir = path.resolve("cloudflare-mcp/sessions/index-codebase", repoSlug);
  const manifest = {
    schema_version: "cfcode.index_plan.v2",
    repo,
    repo_slug: repoSlug,
    mode,
    diff_base: diffBase,
    resume,
    dry_run: dryRun,
    tracked_file_count: tracked.length,
    changed_file_count: changedPaths.size,
    files_to_index_count: selected.length,
    files_to_index: selected,
    stages: ["snapshot", "chunk", "hyde", "embedding", "publication", "docs"],
    resumable_keys: {
      chunks: "chunk_identity",
      hyde: "content_hash + hyde_version + hyde_model",
      embeddings: "embedding_run_id + input_hash",
    },
  };
  await writeJson(path.join(sessionDir, "last-plan.json"), manifest);
  if (dryRun || selected.length === 0) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const account = JSON.parse(await fs.readFile(serviceAccountPath, "utf8"));
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error(`Invalid service account: ${serviceAccountPath}`);

  const chunkResult = await buildChunks({ repo, repoSlug, files: selected, sessionDir, linesPerChunk, maxChars, resume });
  const hydeResult = await buildHyde({ chunks: chunkResult.chunks, sessionDir, resume });
  const embeddingResult = await buildEmbeddings({ records: hydeResult.records, sessionDir, resume, account, dimension, model, location, taskType });
  const publishResult = await publish({ publishUrl, vectors: embeddingResult.vectors });
  const docPath = await writeDocs({ sessionDir, repo, repoSlug, mcpUrl, mode, diffBase });
  const summary = {
    ...manifest,
    schema_version: "cfcode.index_summary.v1",
    chunk_count: chunkResult.chunks.length,
    chunks_written: chunkResult.written,
    chunks_skipped: chunkResult.skipped,
    hyde_count: hydeResult.records.length,
    hyde_written: hydeResult.written,
    hyde_skipped: hydeResult.skipped,
    embedding_run_id: embeddingResult.embeddingRunId,
    embeddings_written: embeddingResult.written,
    embeddings_skipped: embeddingResult.skipped,
    google_token_requests: googleTokenRequestCount,
    published: publishResult.published,
    publish_skipped: publishResult.skipped,
    doc_path: docPath,
  };
  await writeJson(path.join(sessionDir, "last-summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
