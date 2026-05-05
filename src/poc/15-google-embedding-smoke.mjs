#!/usr/bin/env node
/**
 * POC 15: Google Embedding Smoke Benchmark
 *
 * Proves: Google Vertex embedding models can be called with the local service
 * account and compared on a small labeled code-search workload.
 *
 * Input: Local repo files and GOOGLE_APPLICATION_CREDENTIALS.
 * Output: Retrieval metrics by model/dimension/query task type.
 *
 * Pass criteria:
 *   - Auth token is minted from the service account
 *   - At least two embedding configurations return numeric vectors
 *   - Ranked retrieval metrics are printed and the process exits 0
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const DEFAULT_CREDENTIALS = "/Users/awilliamspcsevents/Downloads/team (1).json";
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_CREDENTIALS;
const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GEMINI_LOCATION || "us-central1";
const maxChars = Number.parseInt(process.env.POC_EMBED_SNIPPET_CHARS || "2600", 10);

const configs = [
  { model: "gemini-embedding-001", dimensionality: 256, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 768, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 1536, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 3072, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 256, queryTask: "RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 768, queryTask: "RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 1536, queryTask: "RETRIEVAL_QUERY" },
  { model: "gemini-embedding-001", dimensionality: 3072, queryTask: "RETRIEVAL_QUERY" },
  { model: "text-embedding-005", dimensionality: 256, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "text-embedding-005", dimensionality: 768, queryTask: "CODE_RETRIEVAL_QUERY" },
  { model: "text-embedding-005", dimensionality: 256, queryTask: "RETRIEVAL_QUERY" },
  { model: "text-embedding-005", dimensionality: 768, queryTask: "RETRIEVAL_QUERY" },
];

const snippets = [
  {
    id: "mcp-hybrid-prefetch",
    file: "src/mcp-qdrant-openai-wrapper.py",
    anchor: "Prefetch(query=query_embedding, using=DENSE_VECTOR_HYDE",
    label: "MCP hybrid Qdrant prefetch over named dense and sparse vectors",
  },
  {
    id: "indexer-worker-embed",
    file: "src/qdrant-openai-indexer.py",
    anchor: "def _request_embeddings_via_worker",
    label: "Indexer embedding Worker /embed-batch delegation",
  },
  {
    id: "worker-embed-route",
    file: "openai-batch-worker/src/index.ts",
    anchor: "if (url.pathname === \"/embed-batch\")",
    label: "Cloudflare Worker embed-batch route",
  },
  {
    id: "metadata-extraction",
    file: "src/qdrant-openai-indexer.py",
    anchor: "def _build_chunk_metadata",
    label: "Chunk metadata language role symbols imports extraction",
  },
  {
    id: "exact-candidate-injection",
    file: "src/mcp-qdrant-openai-wrapper.py",
    anchor: "symbols_defined",
    label: "Exact symbol and path candidate injection for reranking",
  },
  {
    id: "sparse-vector",
    file: "src/qdrant-openai-indexer.py",
    anchor: "def _make_sparse_vector",
    label: "Local lexical sparse vector hashing",
  },
  {
    id: "hyde-gemini-worker",
    file: "openai-batch-worker/src/index.ts",
    anchor: "async function requestGeminiHyDEQuestions",
    label: "Gemini Vertex HyDE generation path",
  },
  {
    id: "benchmark-worker-install",
    file: "benchmarks/evaluate_retrieval.py",
    anchor: "def install_worker_embeddings",
    label: "Benchmark harness embedding Worker monkeypatch",
  },
  {
    id: "digest-sidecar",
    file: "scripts/generate_digest_sidecar.py",
    anchor: "def ",
    label: "Digest sidecar generation script",
  },
  {
    id: "test-agentic-retrieval",
    file: "tests/test_agentic_retrieval.py",
    anchor: "def ",
    label: "Agentic retrieval tests",
  },
];

const queries = [
  {
    text: "Where does the MCP server query Qdrant with RRF prefetch across hyde_dense, code_dense, summary_dense, and lexical_sparse?",
    target: "mcp-hybrid-prefetch",
  },
  {
    text: "How are embedding batches sent from the Python indexer to the Cloudflare Worker /embed-batch endpoint?",
    target: "indexer-worker-embed",
  },
  {
    text: "Where does the Worker route POST /embed-batch and call the embedding provider?",
    target: "worker-embed-route",
  },
  {
    text: "Which code builds chunk metadata such as language, file_role, chunk_type, symbols_defined, imports, and line spans?",
    target: "metadata-extraction",
  },
  {
    text: "Where are exact symbol or path matches injected into MCP search candidates before deterministic reranking?",
    target: "exact-candidate-injection",
  },
];

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function readServiceAccount() {
  const raw = await fs.readFile(credentialsPath, "utf8");
  const sa = JSON.parse(raw);
  for (const key of ["client_email", "private_key", "project_id"]) {
    if (!sa[key]) throw new Error(`Service account JSON is missing ${key}`);
  }
  return sa;
}

async function mintAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  const assertion = `${signingInput}.${base64url(signature)}`;
  const response = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("Token response did not include access_token");
  return data.access_token;
}

async function snippetAround(spec) {
  const absolute = path.join(repoRoot, spec.file);
  const content = await fs.readFile(absolute, "utf8");
  const index = content.indexOf(spec.anchor);
  if (index < 0) throw new Error(`Anchor not found in ${spec.file}: ${spec.anchor}`);
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(content.length, index + Math.floor((maxChars * 2) / 3));
  return [
    `File: ${spec.file}`,
    `Label: ${spec.label}`,
    "",
    content.slice(start, end),
  ].join("\n");
}

async function loadCorpus() {
  return Promise.all(snippets.map(async (spec) => ({
    ...spec,
    text: await snippetAround(spec),
  })));
}

async function embedOne({ projectId, token, model, dimensionality, taskType, text }) {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const body = {
    instances: [{ content: text, task_type: taskType }],
    parameters: { autoTruncate: true, outputDimensionality: dimensionality },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${model}/${dimensionality}/${taskType} failed ${response.status}: ${raw.slice(0, 300)}`);
  }
  const data = JSON.parse(raw);
  const values = data?.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
    throw new Error(`${model}/${dimensionality}/${taskType} returned no numeric embedding`);
  }
  return values;
}

async function embedMany(params, texts, taskType) {
  const vectors = [];
  for (const text of texts) {
    vectors.push(await embedOne({ ...params, taskType, text }));
  }
  return vectors;
}

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(aa) * Math.sqrt(bb)) || 1);
}

function evaluate(corpus, queryVectors, docVectors) {
  const ranks = queries.map((query, queryIndex) => {
    const ranked = corpus
      .map((doc, docIndex) => ({
        id: doc.id,
        file: doc.file,
        score: cosine(queryVectors[queryIndex], docVectors[docIndex]),
      }))
      .sort((a, b) => b.score - a.score);
    const rank = ranked.findIndex((item) => item.id === query.target) + 1;
    return { query: query.text, target: query.target, rank, top: ranked.slice(0, 3) };
  });
  const recallAt = (k) => ranks.filter((item) => item.rank > 0 && item.rank <= k).length / ranks.length;
  const mrr = ranks.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / ranks.length;
  return { recall1: recallAt(1), recall3: recallAt(3), recall5: recallAt(5), mrr, ranks };
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

async function runConfig(sa, token, corpus, config) {
  const startedAt = Date.now();
  const params = {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || sa.project_id,
    token,
    model: config.model,
    dimensionality: config.dimensionality,
  };
  const docVectors = await embedMany(params, corpus.map((item) => item.text), "RETRIEVAL_DOCUMENT");
  const queryVectors = await embedMany(params, queries.map((item) => item.text), config.queryTask);
  const metrics = evaluate(corpus, queryVectors, docVectors);
  return {
    ...config,
    vectorDimensions: docVectors[0]?.length || 0,
    elapsedMs: Date.now() - startedAt,
    ...metrics,
  };
}

async function run() {
  console.log("POC 15: Google Embedding Smoke Benchmark\n");
  console.log(`Credentials: ${credentialsPath}`);
  console.log(`Location: ${location}`);
  console.log(`Snippet chars: ${maxChars}`);

  const sa = await readServiceAccount();
  const token = await mintAccessToken(sa);
  const corpus = await loadCorpus();
  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT || sa.project_id}`);
  console.log(`Corpus: ${corpus.length} snippets, ${queries.length} queries\n`);

  const results = [];
  const failures = [];
  for (const config of configs) {
    const label = `${config.model} dim=${config.dimensionality} query=${config.queryTask}`;
    process.stdout.write(`Testing ${label} ... `);
    try {
      const result = await runConfig(sa, token, corpus, config);
      results.push(result);
      console.log(`R@3=${formatNumber(result.recall3)} MRR=${formatNumber(result.mrr)} ${result.elapsedMs}ms`);
    } catch (error) {
      failures.push({ config, error: error instanceof Error ? error.message : String(error) });
      console.log(`FAILED: ${failures.at(-1).error}`);
    }
  }

  results.sort((a, b) => (b.mrr - a.mrr) || (b.recall3 - a.recall3) || (a.elapsedMs - b.elapsedMs));

  console.log("\nResults");
  console.log("model\tdim\tquery_task\tR@1\tR@3\tR@5\tMRR\tms");
  for (const result of results) {
    console.log([
      result.model,
      result.vectorDimensions,
      result.queryTask,
      formatNumber(result.recall1),
      formatNumber(result.recall3),
      formatNumber(result.recall5),
      formatNumber(result.mrr),
      result.elapsedMs,
    ].join("\t"));
  }

  if (results[0]) {
    console.log("\nBest config");
    console.log(JSON.stringify({
      model: results[0].model,
      dimensionality: results[0].vectorDimensions,
      query_task: results[0].queryTask,
      document_task: "RETRIEVAL_DOCUMENT",
      recall_at_3: results[0].recall3,
      mrr: results[0].mrr,
    }, null, 2));
    console.log("\nBest config per-query ranks");
    for (const item of results[0].ranks) {
      console.log(`- rank ${item.rank}: ${item.target}`);
      console.log(`  top3: ${item.top.map((hit) => `${hit.id}:${hit.score.toFixed(3)}`).join(", ")}`);
    }
  }

  if (failures.length) {
    console.log("\nFailures");
    for (const failure of failures) {
      console.log(`- ${failure.config.model} dim=${failure.config.dimensionality} query=${failure.config.queryTask}: ${failure.error}`);
    }
  }

  console.log("\nPass Criteria");
  const tokenMinted = Boolean(token);
  const twoConfigs = results.length >= 2;
  const printedMetrics = results.length > 0 && results.every((item) => Number.isFinite(item.mrr));
  console.log(`  Auth token minted: ${tokenMinted ? "PASS" : "FAIL"}`);
  console.log(`  At least two configs returned vectors: ${twoConfigs ? "PASS" : "FAIL"} (${results.length})`);
  console.log(`  Metrics printed: ${printedMetrics ? "PASS" : "FAIL"}`);

  if (!(tokenMinted && twoConfigs && printedMetrics)) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
