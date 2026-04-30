type R2ObjectBodyLike = { text(): Promise<string> };
type R2ObjectLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
};
type D1StatementLike = { bind(...values: unknown[]): D1StatementLike; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1StatementLike; batch(stmts: D1StatementLike[]): Promise<unknown[]> };
type QueueLike = { send(message: QueueMessageBody): Promise<void> };
type VectorizeVector = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};
type Env = { ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VectorizeIndexLike; PUBLISH_QUEUE: QueueLike };
type QueueMessageBody = { job_id: string; chunk_id: string; artifact_key: string; ordinal: number };
type ChunkRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string; values: number[] };
type IngestRequest = {
  job_id?: string; repo_slug?: string; indexed_path?: string; active_commit?: string;
  artifact_key?: string; artifact_text?: string;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

async function schema(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, indexed_path TEXT NOT NULL,
    active_commit TEXT NOT NULL, artifact_key TEXT NOT NULL,
    total INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    published_at TEXT NOT NULL
  )`).run();
}

function parseRecords(artifactText: string): ChunkRecord[] {
  return artifactText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ChunkRecord)
    .filter((r) => r.chunk_id && Array.isArray(r.values) && r.values.length === 1536);
}

async function ingest(env: Env, input: IngestRequest): Promise<Response> {
  await schema(env);
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.active_commit || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "job_id, repo_slug, indexed_path, active_commit, artifact_key, and artifact_text are required" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "artifact_text had no valid 1536d records" }, 400);
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, record_count: String(records.length) },
  });
  await env.DB.prepare(`INSERT OR REPLACE INTO jobs
    (job_id, repo_slug, indexed_path, active_commit, artifact_key, total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit,
      input.artifact_key, records.length, records.length, "queued", new Date().toISOString()).run();
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    await env.PUBLISH_QUEUE.send({ job_id: input.job_id, chunk_id: records[ordinal].chunk_id, artifact_key: input.artifact_key, ordinal });
  }
  return json({ ok: true, job_id: input.job_id, queued: records.length });
}

async function publishChunk(env: Env, message: QueueMessageBody) {
  await schema(env);
  try {
    const artifact = await env.ARTIFACTS.get(message.artifact_key);
    if (!artifact) throw new Error(`missing artifact ${message.artifact_key}`);
    const record = parseRecords(await artifact.text())[message.ordinal];
    if (!record) throw new Error(`missing record at ordinal ${message.ordinal}`);
    // Idempotent: INSERT OR REPLACE — duplicate Queue messages just overwrite the same row
    await env.DB.prepare(`INSERT OR REPLACE INTO chunks
      (chunk_id, job_id, repo_slug, file_path, source_sha256, text, active, published_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(record.chunk_id, message.job_id, record.repo_slug, record.file_path,
        record.source_sha256, record.text, new Date().toISOString()).run();
    await env.VECTORIZE.upsert([{
      id: record.chunk_id,
      values: record.values,
      metadata: { repo_slug: record.repo_slug, file_path: record.file_path, active_commit: "poc-26d0" },
    }]);
    // Idempotent counter: only increment if this chunk was not already completed
    // We use a subquery to check existing chunk count before this insert
    await env.DB.prepare(`UPDATE jobs SET
      completed = (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1),
      status = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1) >= total THEN 'published' ELSE 'publishing' END
      WHERE job_id = ?`).bind(message.job_id, message.job_id, message.job_id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE jobs SET failed = failed + 1, status = 'failed' WHERE job_id = ?").bind(message.job_id).run();
    throw error;
  }
}

async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "job not found" }, 404);
  const chunkCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM chunks WHERE job_id = ?").bind(jobId).first();
  return json({ ok: true, job, chunk_rows: (chunkCount as Record<string, unknown>)?.cnt ?? 0 });
}

async function search(env: Env, request: Request): Promise<Response> {
  await schema(env);
  const input = await request.json().catch(() => ({})) as { values?: number[]; topK?: number; repo_slug?: string };
  if (!Array.isArray(input.values) || input.values.length !== 1536) return json({ ok: false, error: "1536d values required" }, 400);
  const result = await env.VECTORIZE.query(input.values, { topK: input.topK || 10, returnMetadata: "all" });
  // Cross-check against D1 active rows — this is the safety contract
  const matches = [];
  for (const match of result.matches || []) {
    const chunk = await env.DB.prepare("SELECT * FROM chunks WHERE chunk_id = ? AND active = 1").bind(match.id).first();
    if (chunk) {
      matches.push({ ...match, chunk });
    }
    // If chunk is not active=1 in D1, it is filtered out even though Vectorize returned it
  }
  return json({ ok: true, matches, vectorize_returned: (result.matches || []).length, d1_filtered: matches.length });
}

async function deactivate(env: Env, chunkId: string): Promise<Response> {
  await schema(env);
  await env.DB.prepare("UPDATE chunks SET active = 0 WHERE chunk_id = ?").bind(chunkId).run();
  const row = await env.DB.prepare("SELECT chunk_id, active FROM chunks WHERE chunk_id = ?").bind(chunkId).first();
  return json({ ok: true, chunk_id: chunkId, active: row ? (row as Record<string, unknown>).active : null });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26d0-safety" });
    if (url.pathname === "/ingest" && request.method === "POST") return ingest(env, await request.json().catch(() => ({})) as IngestRequest);
    const statusMatch = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (statusMatch) return jobStatus(env, statusMatch[1]);
    if (url.pathname === "/search" && request.method === "POST") return search(env, request);
    const deactivateMatch = url.pathname.match(/^\/chunks\/([^/]+)\/deactivate$/);
    if (deactivateMatch && request.method === "POST") return deactivate(env, deactivateMatch[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMessageBody }> }, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await publishChunk(env, message.body);
    }
  },
};
