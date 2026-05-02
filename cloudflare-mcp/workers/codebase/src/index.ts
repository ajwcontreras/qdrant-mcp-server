// Canonical per-codebase MCP Worker.
// Merges proven endpoints from 26D1 (full job) + 26E4 (incremental + git state).
// Endpoints:
//   GET  /health
//   POST /ingest                — full job: store artifact, queue chunks (legacy queue path)
//   POST /ingest-sharded        — full job via sharded DO fan-out (29D/29E proven, 15.6× faster)
//   POST /incremental-ingest    — diff job: deactivate stale, queue changed, advance git on completion
//   GET  /jobs/:job_id/status
//   GET  /metrics
//   GET  /collection_info       — active publication metadata
//   POST /search                — Vectorize query, D1 active filter
//   POST /search-active         — diagnostic: D1 active rows by repo_slug + optional file_path
//   GET  /git-state/:repo_slug
//   POST /chunks/:chunk_id/deactivate

import { DurableObject } from "cloudflare:workers";

// ── Type stubs ──
type R2BodyLike = { text(): Promise<string> };
type R2Like = {
  put(key: string, value: string, opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2BodyLike | null>;
};
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type QueueLike = { send(msg: unknown): Promise<void> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = {
  upsert(v: VecEntry[]): Promise<unknown>;
  query(v: number[], opts?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};
type KVLike = {
  get(key: string, opts?: { type?: "text" | "json" }): Promise<string | null | Record<string, unknown>>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DOStubLike;
};

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike; WORK_QUEUE: QueueLike;
  VERTEX_TOKEN_CACHE?: KVLike;
  INDEXING_SHARD_DO?: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  SHARD_COUNT?: string;
  BATCH_SIZE?: string;
  NUM_SAS?: string;
  DEEPSEEK_API_KEY?: string;
  HYDE_SHARD_DO?: DONamespaceLike;
  HYDE_MODEL?: string;
  HYDE_VERSION?: string;
  HYDE_QUESTIONS?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

// ── Domain types ──
type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type IncrementalRecord = SourceRecord & { manifest_id?: string; action?: "added" | "modified" | "renamed"; previous_path?: string | null };
type Tombstone = { action: "tombstone"; file_path: string; manifest_id: string; repo_slug: string };
type IngestReq = { job_id?: string; repo_slug?: string; indexed_path?: string; active_commit?: string; artifact_key?: string; artifact_text?: string };
type IncrementalReq = {
  job_id: string; repo_slug: string; manifest_id: string;
  base_commit: string; target_commit: string;
  artifact_key: string; artifact_text: string;
};
type QueueMsg = { job_id: string; chunk_id: string; artifact_key: string; ordinal: number; target_commit?: string; repo_slug?: string };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }
async function doFetch(s: DOStubLike, url: string, init: RequestInit, ms = 120_000): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shard timeout")), ms);
    s.fetch(url, init).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

// ── Schema ──
async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, indexed_path TEXT NOT NULL,
    active_commit TEXT NOT NULL, artifact_key TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'full',
    manifest_id TEXT, base_commit TEXT, target_commit TEXT,
    manifest_files INTEGER NOT NULL DEFAULT 0,
    changed_files INTEGER NOT NULL DEFAULT 0,
    deleted_files INTEGER NOT NULL DEFAULT 0,
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
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_repo_path ON chunks(repo_slug, file_path)`).run();
  // Migrations for jobs (idempotent — ignore "duplicate column name" errors)
  for (const alter of [
    "ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'full'",
    "ALTER TABLE jobs ADD COLUMN manifest_id TEXT",
    "ALTER TABLE jobs ADD COLUMN base_commit TEXT",
    "ALTER TABLE jobs ADD COLUMN target_commit TEXT",
    "ALTER TABLE jobs ADD COLUMN manifest_files INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN changed_files INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN deleted_files INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await db.prepare(alter).run(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column/i.test(msg)) throw e;
    }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS active_publication (
    repo_slug TEXT PRIMARY KEY, indexed_path TEXT NOT NULL,
    job_id TEXT NOT NULL, active_commit TEXT NOT NULL,
    vectorize_index TEXT NOT NULL, active_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS git_state (
    repo_slug TEXT PRIMARY KEY, active_commit TEXT NOT NULL,
    last_manifest_id TEXT, updated_at TEXT NOT NULL
  )`).run();
  for (const alter of [
    "ALTER TABLE chunks ADD COLUMN kind TEXT DEFAULT 'code'",
    "ALTER TABLE chunks ADD COLUMN parent_chunk_id TEXT",
    "ALTER TABLE chunks ADD COLUMN hyde_version TEXT",
    "ALTER TABLE chunks ADD COLUMN hyde_model TEXT",
    "ALTER TABLE jobs ADD COLUMN code_status TEXT DEFAULT 'pending'",
    "ALTER TABLE jobs ADD COLUMN hyde_status TEXT DEFAULT 'pending'",
    "ALTER TABLE jobs ADD COLUMN hyde_completed INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await db.prepare(alter).run(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column/i.test(msg)) throw e;
    }
  }
}

// ── Artifact parsing (handles full job records OR incremental records + tombstones) ──
function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}
function parseArtifact(text: string): { records: IncrementalRecord[]; tombstones: Tombstone[] } {
  const records: IncrementalRecord[] = [];
  const tombstones: Tombstone[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.action === "tombstone") tombstones.push(obj as unknown as Tombstone);
    else if (typeof obj.chunk_id === "string" && typeof obj.text === "string") records.push(obj as unknown as IncrementalRecord);
  }
  return { records, tombstones };
}

// ── Google OAuth ──
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
async function bumpMetric(env: Env, key: string) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`INSERT INTO metrics (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`).bind(key).run();
  } catch { /* metrics are best-effort */ }
}
async function googleToken(env: Env): Promise<string> {
  const now = Date.now();
  // Fast path: per-isolate cache
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  const sa = parseSA(env);
  const cacheKey = `vertex_token:${sa.client_email}`;
  // KV path: shared across isolates if binding present
  if (env.VERTEX_TOKEN_CACHE) {
    try {
      const cached = await env.VERTEX_TOKEN_CACHE.get(cacheKey, { type: "json" }) as { token?: string; expiresAt?: number } | null;
      if (cached && cached.token && typeof cached.expiresAt === "number" && cached.expiresAt - 60_000 > now) {
        tokenCache = { token: cached.token, expiresAt: cached.expiresAt };
        await bumpMetric(env, "oauth_kv_hit");
        return cached.token;
      }
    } catch { /* fall through to refresh */ }
  }
  // Slow path: full JWT exchange
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
  const ttl = Math.max(60, d.expires_in || 3600);
  const expiresAt = now + ttl * 1000;
  tokenCache = { token: d.access_token, expiresAt };
  await bumpMetric(env, "oauth_refresh");
  if (env.VERTEX_TOKEN_CACHE) {
    try {
      // KV TTL must be ≥60s; cache for token lifetime minus 5min buffer.
      await env.VERTEX_TOKEN_CACHE.put(cacheKey, JSON.stringify({ token: d.access_token, expiresAt }), { expirationTtl: Math.max(60, ttl - 300) });
    } catch { /* best-effort */ }
  }
  return d.access_token;
}

// ── Vertex embedding ──
async function embed(env: Env, content: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<{ values: number[]; model: string; dimensions: number; norm: number }> {
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
    body: JSON.stringify({ instances: [{ content, task_type: taskType }], parameters: { autoTruncate: true, outputDimensionality: dims } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Vertex embed failed ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = d.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every(v => typeof v === "number")) throw new Error("bad Vertex response");
  const norm = Math.sqrt(values.reduce((s: number, v: number) => s + v * v, 0));
  return { values, model, dimensions: values.length, norm };
}

// ── Sharded fan-out: per-SA OAuth + batched Vertex embed (29D/29E pattern) ──
// Per-isolate token cache keyed by SA email so multiple SAs (round-robin) coexist.
const tokenCacheBySA: Map<string, { token: string; expiresAt: number }> = new Map();
function parseSAByIndex(env: Env, saIndex: number): GoogleSA {
  const keys = [env.GEMINI_SERVICE_ACCOUNT_B64, env.GEMINI_SERVICE_ACCOUNT_B64_2, undefined as string | undefined, undefined as string | undefined];
  const b64 = keys[saIndex] || env.GEMINI_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error(`SA secret for index ${saIndex} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid service account");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}
async function tokenForSA(sa: GoogleSA): Promise<string> {
  const now = Date.now();
  const cached = tokenCacheBySA.get(sa.client_email);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
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
  tokenCacheBySA.set(sa.client_email, { token: d.access_token, expiresAt: now + Math.max(60, d.expires_in || 3600) * 1000 });
  return d.access_token;
}
async function embedBatch(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  if (!project) throw new Error("project_id required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await tokenForSA(sa);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
      parameters: { autoTruncate: true, outputDimensionality: dims },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Vertex embed failed ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const preds = d.predictions || [];
  if (preds.length !== texts.length) throw new Error(`Vertex returned ${preds.length} preds for ${texts.length} inputs`);
  return preds.map(p => {
    const values = p.embeddings?.values;
    if (!Array.isArray(values) || !values.every(v => typeof v === "number")) throw new Error("bad Vertex response");
    const norm = Math.sqrt(values.reduce((s: number, v: number) => s + v * v, 0));
    return { values: values as number[], norm };
  });
}

const HYDE_SYS = "You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {\"questions\": [\"q1\", ..., \"q12\"]}. No prose, no markdown.";

async function deepseek(env: Env, text: string): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DS key missing");
  for (let a = 0; a < 4; a++) {
    const r = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }, body: JSON.stringify({ model: env.HYDE_MODEL || "deepseek-v4-flash", messages: [{ role: "system", content: HYDE_SYS }, { role: "user", content: text }], response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 1500 }) });
    const raw = await r.text(); if (r.ok) {
      const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
      const c = j.choices?.[0]?.message?.content; if (!c) throw new Error("DS empty");
      const p = JSON.parse(c) as { questions?: unknown };
      return (Array.isArray(p.questions) ? p.questions : []).filter((q): q is string => typeof q === "string").slice(0, 12);
    }
    if (r.status >= 500 || r.status === 429) { await new Promise(r => setTimeout(r, 300 * (a + 1))); continue; }
    throw new Error(`DS ${r.status}`);
  }
  throw new Error("DS retries exhausted");
}

type ShardBatchReq = {
  job_id: string; repo_slug: string; shard_index: number; sa_index: number; batch_size: number;
  records?: SourceRecord[];
};
type ShardResult = {
  shard_index: number; sa_index: number; chunks_done: number; vertex_calls: number;
  vertex_ms: number; vectorize_ms: number; d1_ms: number; errors: number;
};

export class IndexingShardDO extends DurableObject<Env> {
  async processBatch(req: ShardBatchReq): Promise<ShardResult> {
    const result: ShardResult = {
      shard_index: req.shard_index, sa_index: req.sa_index,
      chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0,
    };
    if (!req.records?.length) return result;
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);

    const groups: SourceRecord[][] = [];
    for (let i = 0; i < req.records!.length; i += req.batch_size) {
      groups.push(req.records!.slice(i, i + req.batch_size));
    }

    for (const group of groups) {
      const texts = group.map(r => r.text);
      const tV = Date.now();
      let embeddings: { values: number[]; norm: number }[];
      try {
        embeddings = await embedBatch(this.env, sa, texts);
        result.vertex_calls += 1;
        result.vertex_ms += Date.now() - tV;
      } catch (e) {
        console.error(`shard ${req.shard_index} sa ${req.sa_index} embed failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
        continue;
      }

      const tVec = Date.now();
      try {
        const entries: VecEntry[] = group.map((r, i) => ({
          id: r.chunk_id,
          values: embeddings[i].values,
          metadata: {
            repo_slug: r.repo_slug,
            file_path: r.file_path,
            source_sha256: r.source_sha256,
            shard_index: req.shard_index,
          },
        }));
        await this.env.VECTORIZE.upsert(entries);
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) {
        console.error(`shard ${req.shard_index} vectorize failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
        continue;
      }

      const tD = Date.now();
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks
            (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, model, dimensions, norm, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        ).bind(
          r.chunk_id, req.job_id, r.repo_slug, r.file_path, r.source_sha256,
          r.text.slice(0, 500), model, dims, embeddings[i].norm, now,
        ));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD;
        result.chunks_done += group.length;
      } catch (e) {
        console.error(`shard ${req.shard_index} d1 batch failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
      }
    }

    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/process-batch" && request.method === "POST") {
      const body = await request.json() as ShardBatchReq;
      return json(await this.processBatch(body));
    }
    return json({ error: "not_found" }, 404);
  }
}

export class HydeShardDO extends DurableObject<Env> {
  async process(req: ShardBatchReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const records = req.records || [];
    if (!records.length) return { done, errors: errs };
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const hydeVer = this.env.HYDE_VERSION || "v1", hydeMdl = this.env.HYDE_MODEL || "deepseek-v4-flash";
    const nowStr = new Date().toISOString();

    const collected: { record: SourceRecord; questions: string[] }[] = [];
    for (let i = 0; i < records.length; i += 6) {
      const batch = records.slice(i, i + 6);
      const outcomes = await Promise.allSettled(batch.map(async r => ({ record: r, questions: await deepseek(this.env, r.text) })));
      for (const o of outcomes) { if (o.status === "fulfilled") collected.push(o.value); else errs++; }
    }
    if (!collected.length) return { done, errors: errs };

    const flat: { parentId: string; qIndex: number; text: string }[] = [];
    for (const { record, questions } of collected) for (let i = 0; i < questions.length; i++) flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i] });
    const groups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += req.batch_size) groups.push(flat.slice(i, i + req.batch_size));

    for (const group of groups) {
      let embs: { values: number[]; norm: number }[];
      try { embs = await embedBatch(this.env, sa, group.map(g => g.text)); } catch { errs += group.length; continue; }
      try { await this.env.VECTORIZE.upsert(group.map((g, i) => ({ id: `${g.parentId}-h${g.qIndex}`, values: embs[i].values, metadata: { kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex } }))); } catch { errs += group.length; continue; }
      try {
        const stmts = group.map((g, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,repo_slug,file_path,source_sha256,snippet,active,kind,parent_chunk_id,hyde_version,hyde_model,model,dimensions,norm,published_at) VALUES (?,?,?,?,?,?,1,'hyde',?,?,?,?,?,?,?)`).bind(`${g.parentId}-h${g.qIndex}`, req.job_id, req.repo_slug || "", g.parentId, g.parentId, g.text.slice(0, 500), g.parentId, hydeVer, hydeMdl, model, dims, embs[i].norm, nowStr));
        await this.env.DB.batch(stmts); done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_completed=hyde_completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch { errs += group.length; }
    }
    return { done, errors: errs };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/process-batch" && request.method === "POST") {
      const body = await request.json() as ShardBatchReq;
      return json(await this.process(body));
    }
    return json({ error: "not_found" }, 404);
  }
}

type IngestShardedReq = IngestReq & { shard_count?: number; batch_size?: number };

async function ingestSharded(env: Env, input: IngestShardedReq): Promise<Response> {
  await schema(env.DB);
  if (!env.INDEXING_SHARD_DO) {
    return json({ ok: false, error: "INDEXING_SHARD_DO binding not configured" }, 501);
  }
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.active_commit || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "missing required fields" }, 400);
  }
  const job_id = input.job_id;
  const repo_slug = input.repo_slug;
  const indexed_path = input.indexed_path;
  const active_commit = input.active_commit;
  const artifact_key = input.artifact_key;
  const artifact_text = input.artifact_text;
  const records = parseRecords(artifact_text);
  if (records.length === 0) return json({ ok: false, error: "no valid records" }, 400);

  const SHARD_COUNT = Math.max(1, input.shard_count ?? intEnv(env.SHARD_COUNT, 4));
  const BATCH_SIZE = Math.max(1, input.batch_size ?? intEnv(env.BATCH_SIZE, 100));
  const NUM_SAS = Math.max(1, intEnv(env.NUM_SAS, env.GEMINI_SERVICE_ACCOUNT_B64_2 ? 2 : 1));

  await env.ARTIFACTS.put(artifact_key, artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug, job_id, record_count: String(records.length) },
  });
  const created = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO jobs
      (job_id, repo_slug, indexed_path, active_commit, artifact_key, job_type, total, queued, completed, failed, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'full', ?, ?, 0, 0, 'running', ?)`
  ).bind(job_id, repo_slug, indexed_path, active_commit, artifact_key,
    records.length, records.length, created).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO active_publication
      (repo_slug, indexed_path, job_id, active_commit, vectorize_index, active_at)
      VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(repo_slug, indexed_path, job_id, active_commit, "live", created).run();

  const shards: SourceRecord[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (let i = 0; i < records.length; i++) shards[i % SHARD_COUNT].push(records[i]);

  const tStart = Date.now();
  const doNs = env.INDEXING_SHARD_DO!;
  const responses = await Promise.allSettled(shards.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % NUM_SAS, chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as ShardResult;
    const stub = doNs.get(doNs.idFromName(`cfcode:shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id, repo_slug,
        shard_index: idx, sa_index: idx % NUM_SAS, batch_size: BATCH_SIZE, records: recs,
      } satisfies ShardBatchReq),
    });
    if (!r.ok) throw new Error(`shard ${idx} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json() as ShardResult;
  }));

  const wallMs = Date.now() - tStart;
  const shardResults: ShardResult[] = [];
  let totalDone = 0; let totalErr = 0; let totalVertex = 0;
  for (const r of responses) {
    if (r.status === "fulfilled") {
      shardResults.push(r.value);
      totalDone += r.value.chunks_done;
      totalErr += r.value.errors;
      totalVertex += r.value.vertex_calls;
    } else {
      console.error(`shard rejected:`, r.reason);
      totalErr += 1;
    }
  }
  const status = totalErr === 0 ? "published" : (totalDone > 0 ? "partial" : "failed");
  await env.DB.prepare(
    `UPDATE jobs SET completed = ?, failed = ?, status = ? WHERE job_id = ?`
  ).bind(totalDone, totalErr, status, job_id).run();

  return json({
    ok: totalErr === 0, job_id,
    chunks: records.length, completed: totalDone, failed: totalErr,
    vertex_calls_total: totalVertex,
    wall_ms: wallMs, chunks_per_sec: +(totalDone / (wallMs / 1000)).toFixed(3),
    shard_count: SHARD_COUNT, batch_size: BATCH_SIZE, num_sas: NUM_SAS,
    shards: shardResults, status,
  });
}

// ── Full job ingest ──
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
    (job_id, repo_slug, indexed_path, active_commit, artifact_key, job_type, total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'full', ?, ?, 0, 0, ?, ?)`)
    .bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit,
      input.artifact_key, records.length, records.length, "queued", new Date().toISOString()).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO active_publication
    (repo_slug, indexed_path, job_id, active_commit, vectorize_index, active_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(input.repo_slug, input.indexed_path, input.job_id, input.active_commit,
      "live", new Date().toISOString()).run();
  for (let i = 0; i < records.length; i++) {
    await env.WORK_QUEUE.send({ job_id: input.job_id, chunk_id: records[i].chunk_id, artifact_key: input.artifact_key, ordinal: i, repo_slug: input.repo_slug } satisfies QueueMsg);
  }
  return json({ ok: true, job_id: input.job_id, queued: records.length });
}

// ── Incremental ingest ──
async function incrementalIngest(env: Env, input: IncrementalReq): Promise<Response> {
  await schema(env.DB);
  for (const k of ["job_id", "repo_slug", "manifest_id", "base_commit", "target_commit", "artifact_key", "artifact_text"] as const) {
    if (!input[k]) return json({ ok: false, error: `${k} required` }, 400);
  }
  const { records, tombstones } = parseArtifact(input.artifact_text);
  if (records.length === 0 && tombstones.length === 0) return json({ ok: false, error: "no records or tombstones" }, 400);

  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, manifest_id: input.manifest_id },
  });

  const deactivatePaths = new Set<string>();
  for (const t of tombstones) deactivatePaths.add(t.file_path);
  for (const r of records) {
    deactivatePaths.add(r.file_path);
    if (r.previous_path) deactivatePaths.add(r.previous_path);
  }
  let deactivatedCount = 0;
  for (const fp of deactivatePaths) {
    const result = await env.DB.prepare(`UPDATE chunks SET active = 0 WHERE repo_slug = ? AND file_path = ? AND active = 1`)
      .bind(input.repo_slug, fp).run() as { meta?: { changes?: number } };
    deactivatedCount += result?.meta?.changes || 0;
  }

  const manifestFiles = records.length + tombstones.length;
  const initialStatus = records.length === 0 ? "published" : "queued";
  await env.DB.prepare(`INSERT OR REPLACE INTO jobs
    (job_id, repo_slug, indexed_path, active_commit, artifact_key, job_type,
     manifest_id, base_commit, target_commit,
     manifest_files, changed_files, deleted_files,
     total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'incremental', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .bind(
      input.job_id, input.repo_slug, "/incremental", input.target_commit, input.artifact_key,
      input.manifest_id, input.base_commit, input.target_commit,
      manifestFiles, records.length, tombstones.length,
      records.length, records.length, initialStatus, new Date().toISOString()
    ).run();

  if (records.length === 0) {
    await env.DB.prepare(`INSERT OR REPLACE INTO git_state (repo_slug, active_commit, last_manifest_id, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(input.repo_slug, input.target_commit, input.manifest_id, new Date().toISOString()).run();
  }

  for (let i = 0; i < records.length; i++) {
    await env.WORK_QUEUE.send({
      job_id: input.job_id, chunk_id: records[i].chunk_id, artifact_key: input.artifact_key,
      ordinal: i, target_commit: input.target_commit, repo_slug: input.repo_slug,
    } satisfies QueueMsg);
  }

  return json({
    ok: true, job_id: input.job_id,
    manifest_files: manifestFiles, changed_files: records.length, deleted_files: tombstones.length,
    queued: records.length, deactivated: deactivatedCount,
    git_advanced: records.length === 0,
  });
}

// ── Queue consumer (handles both full and incremental jobs) ──
async function processChunk(env: Env, msg: QueueMsg) {
  await schema(env.DB);
  try {
    const artifact = await env.ARTIFACTS.get(msg.artifact_key);
    if (!artifact) throw new Error(`missing artifact ${msg.artifact_key}`);
    const { records } = parseArtifact(await artifact.text());
    const record = records[msg.ordinal];
    if (!record) throw new Error(`missing record at ordinal ${msg.ordinal}`);

    const embedding = await embed(env, record.text.slice(0, 8000), "RETRIEVAL_DOCUMENT");
    await env.VECTORIZE.upsert([{
      id: record.chunk_id, values: embedding.values,
      metadata: { repo_slug: record.repo_slug, file_path: record.file_path, active_commit: msg.target_commit || "live" },
    }]);
    await env.DB.prepare(`INSERT OR REPLACE INTO chunks
      (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, model, dimensions, norm, published_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(record.chunk_id, msg.job_id, record.repo_slug, record.file_path, record.source_sha256,
        record.text.slice(0, 500), embedding.model, embedding.dimensions, embedding.norm,
        new Date().toISOString()).run();

    await env.DB.prepare(`UPDATE jobs SET
      completed = (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1),
      status = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1) >= total THEN 'published' ELSE 'publishing' END
      WHERE job_id = ?`).bind(msg.job_id, msg.job_id, msg.job_id).run();

    const job = await env.DB.prepare(`SELECT job_type, status, target_commit, manifest_id, repo_slug FROM jobs WHERE job_id = ?`).bind(msg.job_id).first();
    if (job && job.job_type === "incremental" && job.status === "published" && job.target_commit) {
      await env.DB.prepare(`INSERT OR REPLACE INTO git_state (repo_slug, active_commit, last_manifest_id, updated_at) VALUES (?, ?, ?, ?)`)
        .bind(job.repo_slug, job.target_commit, job.manifest_id, new Date().toISOString()).run();
    }
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
  const input = await request.json().catch(() => ({})) as { query?: string; values?: number[]; topK?: number; repo_slug?: string };
  let queryValues: number[];
  if (Array.isArray(input.values) && input.values.length > 0) {
    queryValues = input.values;
  } else if (input.query) {
    const q = await embed(env, input.query, "RETRIEVAL_QUERY");
    queryValues = q.values;
  } else {
    return json({ ok: false, error: "query (text) or values (vector) required" }, 400);
  }
  const result = await env.VECTORIZE.query(queryValues, { topK: input.topK || 10, returnMetadata: "all" });
  const matches = [];
  for (const m of result.matches || []) {
    const stmt = input.repo_slug
      ? env.DB.prepare("SELECT * FROM chunks WHERE chunk_id = ? AND repo_slug = ? AND active = 1").bind(m.id, input.repo_slug)
      : env.DB.prepare("SELECT * FROM chunks WHERE chunk_id = ? AND active = 1").bind(m.id);
    const chunk = await stmt.first();
    if (chunk) matches.push({ ...m, chunk });
  }
  return json({ ok: true, matches, vectorize_returned: (result.matches || []).length, d1_filtered: matches.length });
}

async function searchActive(env: Env, request: Request): Promise<Response> {
  await schema(env.DB);
  const input = await request.json().catch(() => ({})) as { repo_slug?: string; file_path?: string };
  if (!input.repo_slug) return json({ ok: false, error: "repo_slug required" }, 400);
  const stmt = input.file_path
    ? env.DB.prepare("SELECT chunk_id, file_path, active FROM chunks WHERE repo_slug = ? AND file_path = ? AND active = 1").bind(input.repo_slug, input.file_path)
    : env.DB.prepare("SELECT chunk_id, file_path, active FROM chunks WHERE repo_slug = ? AND active = 1").bind(input.repo_slug);
  const rows = await stmt.all();
  return json({ ok: true, matches: rows.results || [] });
}

async function hydeEnrich(env: Env, request: Request): Promise<Response> {
  await schema(env.DB);
  if (!env.HYDE_SHARD_DO) return json({ ok: false, error: "HYDE_SHARD_DO binding missing" }, 501);
  if (!env.DEEPSEEK_API_KEY) return json({ ok: false, error: "DEEPSEEK_API_KEY missing" }, 501);
  const inp = await request.json() as { job_id?: string; repo_slug?: string; batch_size?: number };
  if (!inp.job_id) return json({ ok: false, error: "job_id required" }, 400);
  const jobId = inp.job_id;

  const missing = (await env.DB.prepare(`SELECT c.chunk_id, c.snippet FROM chunks c WHERE c.job_id=? AND (c.kind='code' OR c.kind IS NULL) AND c.active=1 AND c.chunk_id NOT IN (SELECT DISTINCT parent_chunk_id FROM chunks WHERE job_id=? AND kind='hyde' AND parent_chunk_id IS NOT NULL)`).bind(jobId, jobId).all()).results || [];
  if (!missing.length) return json({ ok: true, enriched: 0, message: "nothing to enrich" });

  const rows = missing.map((r: any) => ({ chunk_id: r.chunk_id as string, text: r.snippet as string, repo_slug: inp.repo_slug as string || "", file_path: r.chunk_id as string, source_sha256: "" }));
  const sas = intEnv(env.NUM_SAS, 2);
  const bs = inp.batch_size || intEnv(env.BATCH_SIZE, 500);
  const numShards = Math.min(64, Math.max(1, Math.ceil(rows.length / Math.max(1, bs))));
  const buckets: SourceRecord[][] = Array.from({ length: numShards }, () => []);
  rows.forEach((r: SourceRecord, i: number) => buckets[i % numShards].push(r));

  const outcomes = await Promise.allSettled(buckets.map((bucket, idx) => {
    if (!bucket.length) return Promise.resolve({ done: 0, errors: 0 });
    const stub = env.HYDE_SHARD_DO!.get(env.HYDE_SHARD_DO!.idFromName(`h-enrich:${jobId}:${idx}`));
    return doFetch(stub, "https://s/process-batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, repo_slug: inp.repo_slug || "", shard_index: idx, shard_count: numShards, sa_index: idx % sas, batch_size: bs, records: bucket }) }, 300_000).then(r => r.json() as Promise<{ done: number; errors: number }>);
  }));

  let enriched = 0, errs = 0;
  for (const o of outcomes) { if (o.status === "fulfilled") { enriched += o.value.done; errs += o.value.errors; } else errs++; }
  return json({ ok: true, scanned: rows.length, enriched, errors: errs });
}

async function gitState(env: Env, slug: string): Promise<Response> {
  await schema(env.DB);
  const state = await env.DB.prepare("SELECT * FROM git_state WHERE repo_slug = ?").bind(slug).first();
  return json({ ok: true, state });
}

async function deactivate(env: Env, chunkId: string): Promise<Response> {
  await schema(env.DB);
  await env.DB.prepare("UPDATE chunks SET active = 0 WHERE chunk_id = ?").bind(chunkId).run();
  return json({ ok: true, chunk_id: chunkId });
}

async function metrics(env: Env): Promise<Response> {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`).run();
    const r = await env.DB.prepare("SELECT key, value FROM metrics").all();
    const out: Record<string, number> = {};
    for (const row of r.results || []) out[row.key as string] = Number(row.value);
    return json({ ok: true, metrics: out, kv_bound: !!env.VERTEX_TOKEN_CACHE });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-canonical" });
    if (url.pathname === "/metrics") return metrics(env);
    if (url.pathname === "/ingest" && request.method === "POST") return ingest(env, await request.json().catch(() => ({})) as IngestReq);
    if (url.pathname === "/ingest-sharded" && request.method === "POST") return ingestSharded(env, await request.json().catch(() => ({})) as IngestShardedReq);
    if (url.pathname === "/incremental-ingest" && request.method === "POST") return incrementalIngest(env, await request.json().catch(() => ({})) as IncrementalReq);
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    if (url.pathname === "/collection_info") return collectionInfo(env);
    if (url.pathname === "/search" && request.method === "POST") return search(env, request);
    if (url.pathname === "/search-active" && request.method === "POST") return searchActive(env, request);
    if (url.pathname === "/hyde-enrich" && request.method === "POST") return hydeEnrich(env, request);
    const gm = url.pathname.match(/^\/git-state\/([^/]+)$/);
    if (gm) return gitState(env, gm[1]);
    const dm = url.pathname.match(/^\/chunks\/([^/]+)\/deactivate$/);
    if (dm && request.method === "POST") return deactivate(env, dm[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMsg }> }, env: Env): Promise<void> {
    for (const message of batch.messages) await processChunk(env, message.body);
  },
};
