// POC 26E4: Cloudflare Incremental Job Processes Diff Manifest
// Extends 26D1 with /incremental-ingest, git state advance on completion, tombstones.
//
// Type stubs (no @cloudflare/workers-types dep)
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

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike; WORK_QUEUE: QueueLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type ChunkRecord = {
  chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string;
  manifest_id?: string; action?: "added" | "modified" | "renamed"; previous_path?: string | null;
};
type Tombstone = { action: "tombstone"; file_path: string; manifest_id: string; repo_slug: string };
type IncrementalReq = {
  job_id: string; repo_slug: string; manifest_id: string;
  base_commit: string; target_commit: string;
  artifact_key: string; artifact_text: string;
};
type QueueMsg = { job_id: string; chunk_id: string; artifact_key: string; ordinal: number; target_commit?: string; repo_slug?: string };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

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
  await db.prepare(`CREATE TABLE IF NOT EXISTS git_state (
    repo_slug TEXT PRIMARY KEY, active_commit TEXT NOT NULL,
    last_manifest_id TEXT, updated_at TEXT NOT NULL
  )`).run();
}

// Parse JSONL artifact: tombstones (action=tombstone) and chunk records
function parseArtifact(text: string): { records: ChunkRecord[]; tombstones: Tombstone[] } {
  const records: ChunkRecord[] = [];
  const tombstones: Tombstone[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.action === "tombstone") tombstones.push(obj as unknown as Tombstone);
    else if (typeof obj.chunk_id === "string" && typeof obj.text === "string") records.push(obj as unknown as ChunkRecord);
  }
  return { records, tombstones };
}

// Google OAuth
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

// Seed endpoint: simulates a prior full-job state. Inserts D1 chunk rows + Vectorize entries
// with given file paths and deterministic fake embeddings. Used by the smoke test
// to set up a "before" state without burning Vertex calls.
type SeedReq = { job_id: string; repo_slug: string; active_commit: string; files: Array<{ file_path: string; chunk_id: string; text: string }> };
async function seed(env: Env, input: SeedReq): Promise<Response> {
  await schema(env.DB);
  if (!input.job_id || !input.repo_slug || !input.active_commit || !Array.isArray(input.files)) {
    return json({ ok: false, error: "job_id, repo_slug, active_commit, files required" }, 400);
  }
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  await env.DB.prepare(`INSERT OR REPLACE INTO jobs
    (job_id, repo_slug, indexed_path, active_commit, artifact_key, job_type, total, queued, completed, failed, status, created_at)
    VALUES (?, ?, ?, ?, '', 'full', ?, ?, ?, 0, 'published', ?)`)
    .bind(input.job_id, input.repo_slug, "/seed", input.active_commit, input.files.length, input.files.length, input.files.length, new Date().toISOString()).run();
  const now = new Date().toISOString();
  // Deterministic fake embedding: hash chunk_id into seed values
  for (const f of input.files) {
    const enc = new TextEncoder().encode(f.chunk_id);
    const seedHash = await crypto.subtle.digest("SHA-256", enc);
    const seedBytes = new Uint8Array(seedHash);
    const values: number[] = [];
    for (let i = 0; i < dims; i++) values.push((seedBytes[i % seedBytes.length] / 128) - 1);
    const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
    await env.VECTORIZE.upsert([{
      id: f.chunk_id, values,
      metadata: { repo_slug: input.repo_slug, file_path: f.file_path, active_commit: input.active_commit },
    }]);
    await env.DB.prepare(`INSERT OR REPLACE INTO chunks
      (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, model, dimensions, norm, published_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(f.chunk_id, input.job_id, input.repo_slug, f.file_path, "seed", f.text.slice(0, 500), "fake", dims, norm, now).run();
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO git_state (repo_slug, active_commit, last_manifest_id, updated_at) VALUES (?, ?, NULL, ?)`)
    .bind(input.repo_slug, input.active_commit, now).run();
  return json({ ok: true, seeded: input.files.length });
}

// Incremental ingest: process diff artifact (tombstones + records)
async function incrementalIngest(env: Env, input: IncrementalReq): Promise<Response> {
  await schema(env.DB);
  const required = ["job_id", "repo_slug", "manifest_id", "base_commit", "target_commit", "artifact_key", "artifact_text"] as const;
  for (const k of required) if (!input[k]) return json({ ok: false, error: `${k} required` }, 400);

  const { records, tombstones } = parseArtifact(input.artifact_text);
  if (records.length === 0 && tombstones.length === 0) return json({ ok: false, error: "no records or tombstones" }, 400);

  // Store artifact in R2
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, manifest_id: input.manifest_id },
  });

  // Compute deactivation paths: tombstones + records' previous_path (renames) + records' file_path (modify replaces old chunks)
  const deactivatePaths = new Set<string>();
  for (const t of tombstones) deactivatePaths.add(t.file_path);
  for (const r of records) {
    deactivatePaths.add(r.file_path);
    if (r.previous_path) deactivatePaths.add(r.previous_path);
  }

  // Soft-delete: mark all matching chunks as inactive
  let deactivatedCount = 0;
  for (const fp of deactivatePaths) {
    const result = await env.DB.prepare(`UPDATE chunks SET active = 0 WHERE repo_slug = ? AND file_path = ? AND active = 1`)
      .bind(input.repo_slug, fp).run() as { meta?: { changes?: number } };
    deactivatedCount += result?.meta?.changes || 0;
  }

  // Counters
  const manifestFiles = records.length + tombstones.length;
  const changedFiles = records.length;
  const deletedFiles = tombstones.length;

  // Job row: status='queued' if records>0, else 'published' (tombstone-only completes immediately)
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
      manifestFiles, changedFiles, deletedFiles,
      records.length, records.length, initialStatus, new Date().toISOString()
    ).run();

  // If no records (tombstone-only), advance git state immediately
  if (records.length === 0) {
    await env.DB.prepare(`INSERT OR REPLACE INTO git_state (repo_slug, active_commit, last_manifest_id, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(input.repo_slug, input.target_commit, input.manifest_id, new Date().toISOString()).run();
  }

  // Enqueue records for embedding
  for (let i = 0; i < records.length; i++) {
    await env.WORK_QUEUE.send({
      job_id: input.job_id, chunk_id: records[i].chunk_id, artifact_key: input.artifact_key,
      ordinal: i, target_commit: input.target_commit, repo_slug: input.repo_slug,
    } satisfies QueueMsg);
  }

  return json({
    ok: true, job_id: input.job_id,
    manifest_files: manifestFiles, changed_files: changedFiles, deleted_files: deletedFiles,
    queued: records.length, deactivated: deactivatedCount,
    git_advanced: records.length === 0,
  });
}

// Queue consumer: embed + publish each chunk; advance git state when job completes
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

    // Idempotent counter via COUNT(*) restricted to chunks owned by this job_id
    await env.DB.prepare(`UPDATE jobs SET
      completed = (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1),
      status = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND active = 1) >= total THEN 'published' ELSE 'publishing' END
      WHERE job_id = ?`).bind(msg.job_id, msg.job_id, msg.job_id).run();

    // If job completed and is incremental, advance git state
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

// Endpoints
async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env.DB);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "not found" }, 404);
  const cnt = await env.DB.prepare("SELECT COUNT(*) as c FROM chunks WHERE job_id = ? AND active = 1").bind(jobId).first();
  return json({ ok: true, job, chunk_rows: (cnt as Record<string, unknown>)?.c ?? 0 });
}

async function gitState(env: Env, slug: string): Promise<Response> {
  await schema(env.DB);
  const state = await env.DB.prepare("SELECT * FROM git_state WHERE repo_slug = ?").bind(slug).first();
  return json({ ok: true, state });
}

async function searchActive(env: Env, request: Request): Promise<Response> {
  await schema(env.DB);
  const input = await request.json().catch(() => ({})) as { repo_slug?: string; file_path?: string };
  // Diagnostic search by file_path filter against D1 active rows.
  // (This proves tombstoned files no longer appear; full Vectorize search is in 26D1.)
  if (!input.repo_slug) return json({ ok: false, error: "repo_slug required" }, 400);
  const sql = input.file_path
    ? "SELECT chunk_id, file_path, active FROM chunks WHERE repo_slug = ? AND file_path = ? AND active = 1"
    : "SELECT chunk_id, file_path, active FROM chunks WHERE repo_slug = ? AND active = 1";
  const stmt = input.file_path
    ? env.DB.prepare(sql).bind(input.repo_slug, input.file_path)
    : env.DB.prepare(sql).bind(input.repo_slug);
  const rows = await stmt.all();
  return json({ ok: true, matches: rows.results || [] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-incremental" });
    if (url.pathname === "/seed" && request.method === "POST") return seed(env, await request.json().catch(() => ({})) as SeedReq);
    if (url.pathname === "/incremental-ingest" && request.method === "POST") return incrementalIngest(env, await request.json().catch(() => ({})) as IncrementalReq);
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    const gm = url.pathname.match(/^\/git-state\/([^/]+)$/);
    if (gm) return gitState(env, gm[1]);
    if (url.pathname === "/search-active" && request.method === "POST") return searchActive(env, request);
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMsg }> }, env: Env): Promise<void> {
    for (const message of batch.messages) await processChunk(env, message.body);
  },
};
