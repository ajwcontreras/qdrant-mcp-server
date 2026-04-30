type R2ObjectBodyLike = { text(): Promise<string> };
type R2ObjectLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
};
type D1StatementLike = { bind(...values: unknown[]): D1StatementLike; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1StatementLike };
type QueueLike = { send(message: QueueMessageBody): Promise<void> };
type VectorizeVector = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};
type Env = { ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VectorizeIndexLike; PUBLICATION_QUEUE: QueueLike };
type QueueMessageBody = { publication_id: string; artifact_key: string; ordinal: number };
type EmbeddingRecord = { vector_id: string; chunk_identity: string; path: string; text: string; values: number[]; model: string; dimensions: number };
type StartRequest = { repo_slug?: string; indexed_path?: string; publication_id?: string; artifact_key?: string; artifact_text?: string };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

async function schema(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS publication_jobs (
    publication_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, indexed_path TEXT NOT NULL,
    artifact_key TEXT NOT NULL, total INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    vector_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, chunk_identity TEXT NOT NULL,
    path TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL,
    dimensions INTEGER NOT NULL, published_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS active_publication (
    repo_slug TEXT PRIMARY KEY, indexed_path TEXT NOT NULL, publication_id TEXT NOT NULL,
    vectorize_index TEXT NOT NULL, active_at TEXT NOT NULL
  )`).run();
}

function parseRecords(artifactText: string): EmbeddingRecord[] {
  return artifactText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as EmbeddingRecord)
    .filter((record) => record.vector_id && Array.isArray(record.values) && record.values.length === 1536);
}

async function start(env: Env, input: StartRequest): Promise<Response> {
  await schema(env);
  if (!input.repo_slug || !input.indexed_path || !input.publication_id || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "repo_slug, indexed_path, publication_id, artifact_key, and artifact_text are required" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "artifact_text had no 1536-dimensional records" }, 400);
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, publication_id: input.publication_id, record_count: String(records.length) },
  });
  await env.DB.prepare(`INSERT OR REPLACE INTO publication_jobs
    (publication_id, repo_slug, indexed_path, artifact_key, total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .bind(input.publication_id, input.repo_slug, input.indexed_path, input.artifact_key, records.length, records.length, "queued", new Date().toISOString()).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO active_publication
    (repo_slug, indexed_path, publication_id, vectorize_index, active_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.repo_slug, input.indexed_path, input.publication_id, "cfcode-poc-26c4-vectorize", new Date().toISOString()).run();
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    await env.PUBLICATION_QUEUE.send({ publication_id: input.publication_id, artifact_key: input.artifact_key, ordinal });
  }
  return json({ ok: true, publication_id: input.publication_id, queued: records.length });
}

async function status(env: Env, publicationId: string): Promise<Response> {
  await schema(env);
  const job = await env.DB.prepare("SELECT * FROM publication_jobs WHERE publication_id = ?").bind(publicationId).first();
  if (!job) return json({ ok: false, error: "publication not found" }, 404);
  const chunks = await env.DB.prepare("SELECT vector_id, path, dimensions FROM chunks WHERE publication_id = ? ORDER BY vector_id").bind(publicationId).all();
  return json({ ok: true, job, chunks: chunks.results || [] });
}

async function collectionInfo(env: Env): Promise<Response> {
  await schema(env);
  const active = await env.DB.prepare("SELECT * FROM active_publication ORDER BY active_at DESC LIMIT 1").first();
  return json({ ok: true, active, capabilities: { vectorize: true, d1_chunks: true, mcp_style_search: true } });
}

async function search(env: Env, request: Request): Promise<Response> {
  await schema(env);
  const input = await request.json().catch(() => ({})) as { values?: number[]; topK?: number };
  if (!Array.isArray(input.values) || input.values.length !== 1536) return json({ ok: false, error: "1536-dimensional values are required" }, 400);
  const result = await env.VECTORIZE.query(input.values, { topK: input.topK || 3, returnMetadata: "all" });
  const matches = [];
  for (const match of result.matches || []) {
    const chunk = await env.DB.prepare("SELECT * FROM chunks WHERE vector_id = ?").bind(match.id).first();
    matches.push({ ...match, chunk });
  }
  return json({ ok: true, matches });
}

async function publishRecord(env: Env, message: QueueMessageBody) {
  await schema(env);
  try {
    const artifact = await env.ARTIFACTS.get(message.artifact_key);
    if (!artifact) throw new Error(`missing artifact ${message.artifact_key}`);
    const record = parseRecords(await artifact.text())[message.ordinal];
    if (!record) throw new Error(`missing record ${message.ordinal}`);
    await env.VECTORIZE.upsert([{ id: record.vector_id, values: record.values, metadata: { publication_id: message.publication_id, path: record.path, model: record.model, dimensions: record.dimensions } }]);
    await env.DB.prepare(`INSERT OR REPLACE INTO chunks
      (vector_id, publication_id, chunk_identity, path, text, model, dimensions, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.vector_id, message.publication_id, record.chunk_identity, record.path, record.text, record.model, record.dimensions, new Date().toISOString()).run();
    await env.DB.prepare(`UPDATE publication_jobs
      SET completed = completed + 1, status = CASE WHEN completed + 1 >= total THEN 'published' ELSE 'publishing' END
      WHERE publication_id = ?`).bind(message.publication_id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE publication_jobs SET failed = failed + 1, status = 'failed' WHERE publication_id = ?").bind(message.publication_id).run();
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26c4-publication" });
    if (url.pathname === "/publication/start" && request.method === "POST") return start(env, await request.json().catch(() => ({})) as StartRequest);
    const statusMatch = url.pathname.match(/^\/publication\/([^/]+)\/status$/);
    if (statusMatch) return status(env, statusMatch[1]);
    if (url.pathname === "/collection_info") return collectionInfo(env);
    if (url.pathname === "/search" && request.method === "POST") return search(env, request);
    if (url.pathname === "/artifact/head") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "key is required" }, 400);
      const object = await env.ARTIFACTS.head(key);
      return json({ ok: true, key, exists: Boolean(object), size: object?.size || 0, metadata: object?.customMetadata || {} });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMessageBody }> }, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => publishRecord(env, message.body)));
  },
};
