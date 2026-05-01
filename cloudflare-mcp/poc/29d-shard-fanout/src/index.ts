// POC 29D: sharded Durable Object fan-out for code indexing.
// Pattern from /Users/awilliamspcsevents/PROJECTS/cfpubsub-scaffold
//   (DeliveryShardDO + fanOutToShards in packages/core/src/internal/engine.ts).
// Producer chunks input into N shards, dispatches via Promise.allSettled to
// IndexingShardDO instances by deterministic name. Each shard does one batched
// Vertex :predict per BATCH_SIZE chunks, then Vectorize+D1 in parallel.

import { DurableObject } from "cloudflare:workers";

// ── Type stubs ──
type R2Like = {
  put(key: string, value: string, opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = {
  upsert(v: VecEntry[]): Promise<unknown>;
  query(v: number[], opts?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DOStubLike;
};

type Env = {
  ARTIFACTS: R2Like;
  DB: D1Like;
  VECTORIZE: VecLike;
  INDEXING_SHARD_DO: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  SHARD_COUNT?: string;
  BATCH_SIZE?: string;
  NUM_SAS?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type IngestShardedReq = {
  job_id: string; repo_slug: string; indexed_path: string; active_commit: string;
  artifact_key: string; artifact_text: string;
  shard_count?: number; batch_size?: number;
};
type ShardBatchReq = {
  job_id: string; repo_slug: string; shard_index: number; sa_index: number; batch_size: number;
  records: SourceRecord[];
};
type ShardResult = {
  shard_index: number; sa_index: number; chunks_done: number; vertex_calls: number;
  vertex_ms: number; vectorize_ms: number; d1_ms: number; errors: number;
};
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

// ── D1 schema (jobs + chunks) ──
async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL,
    indexed_path TEXT NOT NULL, active_commit TEXT NOT NULL,
    artifact_key TEXT NOT NULL, total INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL,
    shards_total INTEGER NOT NULL DEFAULT 0, shards_done INTEGER NOT NULL DEFAULT 0
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    snippet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    model TEXT, dimensions INTEGER, norm REAL, sa_index INTEGER, shard_index INTEGER,
    published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_repo_path ON chunks(repo_slug, file_path)`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

// ── Google OAuth (per-isolate cache, keyed by SA email) ──
const tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
function parseSAByIndex(env: Env, saIndex: number): GoogleSA {
  const b64 = saIndex === 1 ? env.GEMINI_SERVICE_ACCOUNT_B64_2 : env.GEMINI_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error(`SA secret for index ${saIndex} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
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
async function tokenForSA(sa: GoogleSA): Promise<string> {
  const now = Date.now();
  const k = sa.client_email;
  const cached = tokenCache.get(k);
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
  tokenCache.set(k, { token: d.access_token, expiresAt: now + Math.max(60, d.expires_in || 3600) * 1000 });
  return d.access_token;
}

// ── Vertex batch embed ──
async function embedBatch(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  if (!project) throw new Error("project_id required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await tokenForSA(sa);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const body = {
    instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
    parameters: { autoTruncate: true, outputDimensionality: dims },
  };
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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

// ── Indexing shard DO: receives a batch, embeds + upserts + writes D1 ──
export class IndexingShardDO extends DurableObject<Env> {
  async processBatch(req: ShardBatchReq): Promise<ShardResult> {
    const result: ShardResult = {
      shard_index: req.shard_index, sa_index: req.sa_index,
      chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0,
    };
    if (!req.records.length) return result;
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);

    // Split this shard's records into batch_size groups for Vertex
    const groups: SourceRecord[][] = [];
    for (let i = 0; i < req.records.length; i += req.batch_size) {
      groups.push(req.records.slice(i, i + req.batch_size));
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

      // Vectorize upsert (one batch call per group)
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

      // D1 batch insert chunks
      const tD = Date.now();
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks
            (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, model, dimensions, norm, sa_index, shard_index, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
        ).bind(
          r.chunk_id, req.job_id, r.repo_slug, r.file_path, r.source_sha256,
          r.text.slice(0, 500), model, dims, embeddings[i].norm, req.sa_index, req.shard_index, now,
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

// ── Producer: receive ingest, distribute across shards ──
async function ingestSharded(env: Env, input: IngestShardedReq): Promise<Response> {
  await schema(env.DB);
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "missing required fields" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "no valid records" }, 400);

  const SHARD_COUNT = Math.max(1, input.shard_count ?? intEnv(env.SHARD_COUNT, 8));
  const BATCH_SIZE = Math.max(1, input.batch_size ?? intEnv(env.BATCH_SIZE, 50));
  const NUM_SAS = Math.max(1, intEnv(env.NUM_SAS, 2));

  // Persist artifact + job metadata once
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, record_count: String(records.length) },
  });
  const created = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO jobs
      (job_id, repo_slug, indexed_path, active_commit, artifact_key, total, queued, completed, failed, status, created_at, shards_total, shards_done)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'running', ?, ?, 0)`
  ).bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit,
    input.artifact_key, records.length, records.length, created, SHARD_COUNT).run();

  // Distribute records across shards (round-robin by index for even balance)
  const shards: SourceRecord[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (let i = 0; i < records.length; i++) shards[i % SHARD_COUNT].push(records[i]);

  // Fan out to shard DOs in parallel
  const tStart = Date.now();
  const responses = await Promise.allSettled(shards.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % NUM_SAS, chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as ShardResult;
    const stub = env.INDEXING_SHARD_DO.get(env.INDEXING_SHARD_DO.idFromName(`cfcode:shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: input.job_id, repo_slug: input.repo_slug,
        shard_index: idx, sa_index: idx % NUM_SAS, batch_size: BATCH_SIZE,
        records: recs,
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
    `UPDATE jobs SET completed = ?, failed = ?, status = ?, shards_done = ? WHERE job_id = ?`
  ).bind(totalDone, totalErr, status, shardResults.length, input.job_id).run();

  return json({
    ok: totalErr === 0,
    job_id: input.job_id,
    chunks: records.length,
    completed: totalDone,
    failed: totalErr,
    vertex_calls_total: totalVertex,
    wall_ms: wallMs,
    chunks_per_sec: +(totalDone / (wallMs / 1000)).toFixed(3),
    shard_count: SHARD_COUNT,
    batch_size: BATCH_SIZE,
    num_sas: NUM_SAS,
    shards: shardResults,
    status,
  });
}

async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env.DB);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  return json({ ok: true, job });
}

async function count(env: Env): Promise<Response> {
  await schema(env.DB);
  const r = await env.DB.prepare("SELECT COUNT(*) as n FROM chunks WHERE active = 1").first();
  return json({ ok: true, total: Number(r?.n ?? 0) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-29d-shard-fanout" });
    if (url.pathname === "/ingest-sharded" && request.method === "POST") {
      return ingestSharded(env, await request.json().catch(() => ({})) as IngestShardedReq);
    }
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    if (url.pathname === "/count") return count(env);
    return json({ error: "not_found" }, 404);
  },
};
