// ── Type stubs (no @cloudflare/workers-types dependency) ──
type R2BodyLike = { text(): Promise<string> };
type R2HeadLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2BodyLike | null>;
  head(key: string): Promise<R2HeadLike | null>;
};
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type QueueLike = { send(msg: unknown): Promise<void> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = {
  upsert(v: VecEntry[]): Promise<unknown>;
  query(v: number[], opts?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike; WORK_QUEUE: QueueLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

// ── Domain types ──
type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type IngestReq = { job_id?: string; repo_slug?: string; indexed_path?: string; active_commit?: string; artifact_key?: string; artifact_text?: string };
type QueueMsg = { job_id: string; chunk_id: string; artifact_key: string; ordinal: number };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

// ── Helpers ──
function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

// ── Schema (26D0 safety contracts) ──
async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, indexed_path TEXT NOT NULL,
    active_commit TEXT NOT NULL, artifact_key TEXT NOT NULL,
    total INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    snippet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    model TEXT, dimensions INTEGER, norm REAL,
    published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS active_publication (
    repo_slug TEXT PRIMARY KEY, indexed_path TEXT NOT NULL,
    job_id TEXT NOT NULL, active_commit TEXT NOT NULL,
    vectorize_index TEXT NOT NULL, active_at TEXT NOT NULL
  )`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

// ── Google OAuth (from 26B) ──
let tokenCache: { token: string; expiresAt: number } | undefined;

function parseSA(env: Env): GoogleSA {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) throw new Error("GEMINI_SERVICE_ACCOUNT_B64 required");
  const a = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid service account");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}

function pemToAB(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64url(v: string | ArrayBuffer): string {
  const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToAB(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

async function googleToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  const sa = parseSA(env);
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google token failed ${res.status}: ${raw.slice(0, 300)}`);
  const d = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("no access_token in Google response");
  tokenCache = { token: d.access_token, expiresAt: now + Math.max(60, d.expires_in || 3600) * 1000 };
  return d.access_token;
}

// ── Vertex embedding (from 26B) ──
async function embed(env: Env, content: string): Promise<{ values: number[]; model: string; dimensions: number; norm: number }> {
  const sa = parseSA(env);
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  if (!project) throw new Error("GOOGLE_PROJECT_ID required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await googleToken(env);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ instances: [{ content, task_type: "RETRIEVAL_DOCUMENT" }], parameters: { autoTruncate: true, outputDimensionality: dims } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Vertex embed failed ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = d.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every(v => typeof v === "number")) throw new Error("bad Vertex embedding response");
  const norm = Math.sqrt(values.reduce((s: number, v: number) => s + v * v, 0));
  return { values, model, dimensions: values.length, norm };
}

async function embedQuery(env: Env, content: string): Promise<number[]> {
  const sa = parseSA(env);
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  if (!project) throw new Error("GOOGLE_PROJECT_ID required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await googleToken(env);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ instances: [{ content, task_type: "RETRIEVAL_QUERY" }], parameters: { autoTruncate: true, outputDimensionality: dims } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Vertex query embed failed ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = d.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every(v => typeof v === "number")) throw new Error("bad Vertex query response");
  return values;
}

// ── Ingest: local packager uploads source artifact, Worker queues chunks ──
async function ingest(env: Env, input: IngestReq): Promise<Response> {
  await schema(env.DB);
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.active_commit || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "job_id, repo_slug, indexed_path, active_commit, artifact_key, artifact_text required" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "no valid records in artifact_text" }, 400);
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, record_count: String(records.length) },
  });
  await env.DB.prepare(`INSERT OR REPLACE INTO jobs
    (job_id, repo_slug, indexed_path, active_commit, artifact_key, total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit,
      input.artifact_key, records.length, records.length, "queued", new Date().toISOString()).run();
  // Set active publication
  await env.DB.prepare(`INSERT OR REPLACE INTO active_publication
    (repo_slug, indexed_path, job_id, active_commit, vectorize_index, active_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(input.repo_slug, input.indexed_path, input.job_id, input.active_commit,
      "__VECTORIZE_INDEX__", new Date().toISOString()).run();
  for (let i = 0; i < records.length; i++) {
    await env.WORK_QUEUE.send({ job_id: input.job_id, chunk_id: records[i].chunk_id, artifact_key: input.artifact_key, ordinal: i } satisfies QueueMsg);
  }
  return json({ ok: true, job_id: input.job_id, queued: records.length });
}

// ── Queue consumer: embed + publish each chunk ──
async function processChunk(env: Env, msg: QueueMsg) {
  await schema(env.DB);
  try {
    const artifact = await env.ARTIFACTS.get(msg.artifact_key);
    if (!artifact) throw new Error(`missing artifact ${msg.artifact_key}`);
    const record = parseRecords(await artifact.text())[msg.ordinal];
    if (!record) throw new Error(`missing record at ordinal ${msg.ordinal}`);
    // Embed with real Vertex
    const embedding = await embed(env, record.text.slice(0, 8000));
    // Publish to Vectorize
    await env.VECTORIZE.upsert([{
      id: record.chunk_id, values: embedding.values,
      metadata: { repo_slug: record.repo_slug, file_path: record.file_path, active_commit: "live" },
    }]);
    // Idempotent D1 write (INSERT OR REPLACE)
    await env.DB.prepare(`INSERT OR REPLACE INTO chunks
      (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, model, dimensions, norm, published_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(record.chunk_id, msg.job_id, record.repo_slug, record.file_path, record.source_sha256,
        record.text.slice(0, 500), embedding.model, embedding.dimensions, embedding.norm,
        new Date().toISOString()).run();
    // Update counter using COUNT(*) for idempotency (26D0 pattern)
    await env.DB.prepare(`UPDATE jobs SET
      completed = (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1),
      status = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1) >= total THEN 'published' ELSE 'publishing' END
      WHERE job_id = ?`).bind(msg.job_id, msg.job_id, msg.job_id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE jobs SET failed = failed + 1 WHERE job_id = ?").bind(msg.job_id).run();
    throw error;
  }
}

// ── Endpoints ──
async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env.DB);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "not found" }, 404);
  const cnt = await env.DB.prepare("SELECT COUNT(*) as c FROM chunks WHERE job_id = ? AND active = 1").bind(jobId).first();
  return json({ ok: true, job, chunk_rows: (cnt as Record<string, unknown>)?.c ?? 0 });
}

async function collectionInfo(env: Env): Promise<Response> {
  await schema(env.DB);
  const active = await env.DB.prepare("SELECT * FROM active_publication ORDER BY active_at DESC LIMIT 1").first();
  return json({ ok: true, active });
}

async function search(env: Env, request: Request): Promise<Response> {
  await schema(env.DB);
  const input = await request.json().catch(() => ({})) as { query?: string; values?: number[]; topK?: number };
  let queryValues: number[];
  if (Array.isArray(input.values) && input.values.length > 0) {
    queryValues = input.values;
  } else if (input.query) {
    queryValues = await embedQuery(env, input.query);
  } else {
    return json({ ok: false, error: "query (text) or values (vector) required" }, 400);
  }
  const result = await env.VECTORIZE.query(queryValues, { topK: input.topK || 10, returnMetadata: "all" });
  // D1 active filtering (26D0 safety contract)
  const matches = [];
  for (const m of result.matches || []) {
    const chunk = await env.DB.prepare("SELECT * FROM chunks WHERE chunk_id = ? AND active = 1").bind(m.id).first();
    if (chunk) matches.push({ ...m, chunk });
  }
  return json({ ok: true, matches, vectorize_returned: (result.matches || []).length, d1_filtered: matches.length });
}

async function deactivate(env: Env, chunkId: string): Promise<Response> {
  await schema(env.DB);
  await env.DB.prepare("UPDATE chunks SET active = 0 WHERE chunk_id = ?").bind(chunkId).run();
  return json({ ok: true, chunk_id: chunkId });
}

// ── Export ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-full-job" });
    if (url.pathname === "/ingest" && request.method === "POST") return ingest(env, await request.json().catch(() => ({})) as IngestReq);
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    if (url.pathname === "/collection_info") return collectionInfo(env);
    if (url.pathname === "/search" && request.method === "POST") return search(env, request);
    const dm = url.pathname.match(/^\/chunks\/([^/]+)\/deactivate$/);
    if (dm && request.method === "POST") return deactivate(env, dm[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMsg }> }, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processChunk(env, message.body);
    }
  },
};
