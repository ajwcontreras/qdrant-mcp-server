// POC 30A: HyDE + code parallel inside IndexingShardDO.
// Per chunk: Promise.all([deepseek_hyde -> 12 questions, code embed]).
// Per shard: gather all HyDE questions across chunks, batch via Vertex, upsert.
// Schema: chunks table now has kind ('code' | 'hyde'), parent_chunk_id,
// hyde_version, hyde_model columns. HyDE row id = `${parent}-h${i}`.

import { DurableObject } from "cloudflare:workers";

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
type DONamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DOStubLike };

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike;
  INDEXING_SHARD_DO: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  DEEPSEEK_API_KEY?: string;
  SHARD_COUNT?: string;
  BATCH_SIZE?: string;
  NUM_SAS?: string;
  HYDE_QUESTIONS?: string;
  HYDE_MODEL?: string;
  HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type IngestShardedHydeReq = {
  job_id: string; repo_slug: string; indexed_path: string; active_commit: string;
  artifact_key: string; artifact_text: string;
  shard_count?: number; batch_size?: number; hyde?: boolean;
};
type ShardBatchReq = {
  job_id: string; repo_slug: string; shard_index: number; sa_index: number;
  batch_size: number; hyde: boolean; hyde_only?: boolean; records: SourceRecord[];
};
type ShardResult = {
  shard_index: number; sa_index: number;
  chunks_done: number; hyde_done: number;
  vertex_calls: number; deepseek_calls: number;
  vertex_ms: number; deepseek_ms: number; vectorize_ms: number; d1_ms: number;
  errors: number;
};
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL,
    indexed_path TEXT NOT NULL, active_commit TEXT NOT NULL,
    artifact_key TEXT NOT NULL, total INTEGER NOT NULL,
    queued INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    snippet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'code',
    parent_chunk_id TEXT,
    hyde_version TEXT,
    hyde_model TEXT,
    model TEXT, dimensions INTEGER, norm REAL,
    published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_repo_kind ON chunks(repo_slug, kind, active)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_chunk_id)`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

// ── OAuth: per-isolate cache keyed by SA email ──
const tokenCacheBySA: Map<string, { token: string; expiresAt: number }> = new Map();
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
  if (!d.access_token) throw new Error("no access_token");
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
  // Retry 429/5xx with exponential backoff
  let raw = "";
  let res: Response | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
        parameters: { autoTruncate: true, outputDimensionality: dims },
      }),
    });
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`Vertex embed failed ${res.status}: ${raw.slice(0, 500)}`);
    if (attempt === 4) throw new Error(`Vertex embed failed after retries ${res.status}: ${raw.slice(0, 500)}`);
    await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt) + Math.random() * 200));
  }
  if (!res || !res.ok) throw new Error(`Vertex embed failed: ${raw.slice(0, 500)}`);
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

// ── DeepSeek HyDE: 12 hypothetical questions per code chunk ──
const HYDE_SYSTEM = `You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {"questions": ["q1", ..., "q12"]}. No prose, no markdown, no extra keys. Questions should cover: what the code does, when to use it, edge cases, related concepts, debugging, and integration. Diverse phrasings.`;

async function deepseekHyde(env: Env, chunkText: string, n: number): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
  // Retry on 429/5xx with exponential backoff (200ms, 800ms, 2.4s)
  let raw = "";
  let res: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: env.HYDE_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: HYDE_SYSTEM },
          { role: "user", content: chunkText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 1500,
      }),
    });
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`DeepSeek failed ${res.status}: ${raw.slice(0, 300)}`);
    if (attempt === 3) throw new Error(`DeepSeek failed after retries ${res.status}: ${raw.slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 200 * Math.pow(3, attempt) + Math.random() * 100));
  }
  if (!res || !res.ok) throw new Error(`DeepSeek failed: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek empty content");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`DeepSeek non-JSON: ${content.slice(0, 200)}`); }
  const arr = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(arr)) throw new Error("DeepSeek missing questions[]");
  const filtered = arr.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  return filtered.slice(0, n);
}

// ── Indexing shard DO: HyDE+code in parallel ──
export class IndexingShardDO extends DurableObject<Env> {
  async processBatch(req: ShardBatchReq): Promise<ShardResult> {
    const result: ShardResult = {
      shard_index: req.shard_index, sa_index: req.sa_index,
      chunks_done: 0, hyde_done: 0,
      vertex_calls: 0, deepseek_calls: 0,
      vertex_ms: 0, deepseek_ms: 0, vectorize_ms: 0, d1_ms: 0,
      errors: 0,
    };
    if (!req.records.length) return result;
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const hydeVersion = this.env.HYDE_VERSION || "v1";
    const hydeModel = this.env.HYDE_MODEL || "deepseek-v4-flash";
    const numHyde = intEnv(this.env.HYDE_QUESTIONS, 12);

    // Run HyDE path and code path in parallel (skip code if hyde_only)
    const codePromise = req.hyde_only ? Promise.resolve() : this.processCode(req, sa, model, dims, result);
    const hydePromise = req.hyde ? this.processHyde(req, sa, model, dims, hydeVersion, hydeModel, numHyde, result) : Promise.resolve();
    await Promise.allSettled([codePromise, hydePromise]);
    return result;
  }

  private async processCode(req: ShardBatchReq, sa: GoogleSA, model: string, dims: number, result: ShardResult): Promise<void> {
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
        console.error(`shard ${req.shard_index} code embed failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
        continue;
      }

      const tVec = Date.now();
      try {
        const entries: VecEntry[] = group.map((r, i) => ({
          id: r.chunk_id,
          values: embeddings[i].values,
          metadata: { repo_slug: r.repo_slug, file_path: r.file_path, source_sha256: r.source_sha256, kind: "code", shard_index: req.shard_index },
        }));
        await this.env.VECTORIZE.upsert(entries);
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) {
        console.error(`shard ${req.shard_index} code vectorize failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
        continue;
      }

      const tD = Date.now();
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks
            (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, kind, parent_chunk_id, hyde_version, hyde_model, model, dimensions, norm, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, 'code', NULL, NULL, NULL, ?, ?, ?, ?)`
        ).bind(r.chunk_id, req.job_id, r.repo_slug, r.file_path, r.source_sha256, r.text.slice(0, 500), model, dims, embeddings[i].norm, now));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD;
        result.chunks_done += group.length;
      } catch (e) {
        console.error(`shard ${req.shard_index} code d1 failed:`, e instanceof Error ? e.message : e);
        result.errors += group.length;
      }
    }
  }

  private async processHyde(req: ShardBatchReq, sa: GoogleSA, model: string, dims: number, hydeVersion: string, hydeModel: string, numHyde: number, result: ShardResult): Promise<void> {
    // Step 1: fan out DeepSeek calls in parallel across all chunks
    const tDS = Date.now();
    const hydeResults = await Promise.allSettled(req.records.map(async r => {
      result.deepseek_calls += 1;
      const questions = await deepseekHyde(this.env, r.text, numHyde);
      return { record: r, questions };
    }));
    result.deepseek_ms += Date.now() - tDS;

    // Collect successful HyDE (chunk + 12 questions each)
    const collected: { record: SourceRecord; questions: string[] }[] = [];
    for (const r of hydeResults) {
      if (r.status === "fulfilled") collected.push(r.value);
      else { result.errors += 1; console.error("deepseek failed:", r.reason instanceof Error ? r.reason.message : r.reason); }
    }
    if (!collected.length) return;

    // Step 2: flatten ALL questions across this shard's chunks, batch via Vertex
    const flat: { parentId: string; qIndex: number; text: string; record: SourceRecord }[] = [];
    for (const { record, questions } of collected) {
      for (let i = 0; i < questions.length; i++) {
        flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i], record });
      }
    }

    // Vertex batch up to req.batch_size instances per call, in parallel
    const groups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += req.batch_size) {
      groups.push(flat.slice(i, i + req.batch_size));
    }
    const tVQ = Date.now();
    const embedResults = await Promise.allSettled(groups.map(async group => {
      const embs = await embedBatch(this.env, sa, group.map(g => g.text));
      result.vertex_calls += 1;
      return { group, embs };
    }));
    result.vertex_ms += Date.now() - tVQ;

    // Step 3: Vectorize upsert + D1 insert per successful batch
    const now = new Date().toISOString();
    for (const er of embedResults) {
      if (er.status !== "fulfilled") {
        console.error("hyde embed batch failed:", er.reason instanceof Error ? er.reason.message : er.reason);
        result.errors += 1;
        continue;
      }
      const { group, embs } = er.value;

      const tVec = Date.now();
      try {
        const entries: VecEntry[] = group.map((g, i) => ({
          id: `${g.parentId}-h${g.qIndex}`,
          values: embs[i].values,
          metadata: {
            repo_slug: g.record.repo_slug, file_path: g.record.file_path,
            kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex,
            shard_index: req.shard_index,
          },
        }));
        await this.env.VECTORIZE.upsert(entries);
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) {
        console.error("hyde vectorize failed:", e instanceof Error ? e.message : e);
        result.errors += group.length;
        continue;
      }

      const tD = Date.now();
      try {
        const stmts = group.map((g, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks
            (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, kind, parent_chunk_id, hyde_version, hyde_model, model, dimensions, norm, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, 'hyde', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          `${g.parentId}-h${g.qIndex}`, req.job_id, g.record.repo_slug, g.record.file_path,
          g.record.source_sha256, g.text.slice(0, 500),
          g.parentId, hydeVersion, hydeModel, model, dims, embs[i].norm, now,
        ));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD;
        result.hyde_done += group.length;
      } catch (e) {
        console.error("hyde d1 failed:", e instanceof Error ? e.message : e);
        result.errors += group.length;
      }
    }
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

async function ingestShardedHyde(env: Env, input: IngestShardedHydeReq): Promise<Response> {
  await schema(env.DB);
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.active_commit || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "missing required fields" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "no valid records" }, 400);

  const SHARD_COUNT = Math.max(1, input.shard_count ?? intEnv(env.SHARD_COUNT, 4));
  const BATCH_SIZE = Math.max(1, input.batch_size ?? intEnv(env.BATCH_SIZE, 100));
  const NUM_SAS = Math.max(1, intEnv(env.NUM_SAS, env.GEMINI_SERVICE_ACCOUNT_B64_2 ? 2 : 1));
  const HYDE = input.hyde !== false; // default ON for this POC

  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, record_count: String(records.length) },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO jobs (job_id, repo_slug, indexed_path, active_commit, artifact_key, total, queued, completed, failed, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'running', ?)`
  ).bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit, input.artifact_key, records.length, records.length, new Date().toISOString()).run();

  const shards: SourceRecord[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (let i = 0; i < records.length; i++) shards[i % SHARD_COUNT].push(records[i]);

  const tStart = Date.now();
  const responses = await Promise.allSettled(shards.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % NUM_SAS, chunks_done: 0, hyde_done: 0, vertex_calls: 0, deepseek_calls: 0, vertex_ms: 0, deepseek_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as ShardResult;
    const stub = env.INDEXING_SHARD_DO.get(env.INDEXING_SHARD_DO.idFromName(`cfcode:hyde-shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: input.job_id, repo_slug: input.repo_slug,
        shard_index: idx, sa_index: idx % NUM_SAS, batch_size: BATCH_SIZE, hyde: HYDE, records: recs,
      } satisfies ShardBatchReq),
    });
    if (!r.ok) throw new Error(`shard ${idx} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json() as ShardResult;
  }));

  const wallMs = Date.now() - tStart;
  const shardResults: ShardResult[] = [];
  let chunksDone = 0, hydeDone = 0, errs = 0, vertCalls = 0, dsCalls = 0;
  for (const r of responses) {
    if (r.status === "fulfilled") {
      shardResults.push(r.value);
      chunksDone += r.value.chunks_done;
      hydeDone += r.value.hyde_done;
      errs += r.value.errors;
      vertCalls += r.value.vertex_calls;
      dsCalls += r.value.deepseek_calls;
    } else {
      console.error("shard rejected:", r.reason);
      errs += 1;
    }
  }
  const status = errs === 0 ? "published" : (chunksDone > 0 ? "partial" : "failed");
  await env.DB.prepare(`UPDATE jobs SET completed = ?, hyde_completed = ?, failed = ?, status = ? WHERE job_id = ?`)
    .bind(chunksDone, hydeDone, errs, status, input.job_id).run();

  return json({
    ok: errs === 0, job_id: input.job_id,
    chunks: records.length, completed: chunksDone, hyde_completed: hydeDone,
    failed: errs,
    vertex_calls_total: vertCalls, deepseek_calls_total: dsCalls,
    wall_ms: wallMs,
    chunks_per_sec: +(chunksDone / (wallMs / 1000)).toFixed(3),
    vectors_per_sec: +((chunksDone + hydeDone) / (wallMs / 1000)).toFixed(3),
    shard_count: SHARD_COUNT, batch_size: BATCH_SIZE, num_sas: NUM_SAS, hyde: HYDE,
    shards: shardResults, status,
  });
}

async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env.DB);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  return json({ ok: true, job });
}
async function counts(env: Env): Promise<Response> {
  await schema(env.DB);
  const code = await env.DB.prepare("SELECT COUNT(*) as n FROM chunks WHERE active = 1 AND kind = 'code'").first();
  const hyde = await env.DB.prepare("SELECT COUNT(*) as n FROM chunks WHERE active = 1 AND kind = 'hyde'").first();
  return json({ ok: true, code: Number(code?.n ?? 0), hyde: Number(hyde?.n ?? 0) });
}

// ── /hyde-enrich: find code chunks lacking HyDE, generate only those ──
type HydeEnrichReq = { repo_slug: string; target_hyde_version?: string; shard_count?: number; batch_size?: number; scan_limit?: number };

async function hydeEnrich(env: Env, input: HydeEnrichReq): Promise<Response> {
  await schema(env.DB);
  if (!env.INDEXING_SHARD_DO) return json({ ok: false, error: "INDEXING_SHARD_DO binding missing" }, 501);
  if (!input.repo_slug) return json({ ok: false, error: "repo_slug required" }, 400);

  const SHARD_COUNT = Math.max(1, input.shard_count ?? intEnv(env.SHARD_COUNT, 16));
  const BATCH_SIZE = Math.max(1, input.batch_size ?? intEnv(env.BATCH_SIZE, 100));
  const NUM_SAS = Math.max(1, intEnv(env.NUM_SAS, env.GEMINI_SERVICE_ACCOUNT_B64_2 ? 2 : 1));
  const targetVersion = input.target_hyde_version ?? env.HYDE_VERSION ?? "v1";
  const scanLimit = input.scan_limit ?? 100000;

  // Pull artifact for the latest published job — gives us full chunk text.
  const latestJob = await env.DB.prepare(
    `SELECT job_id, artifact_key FROM jobs WHERE repo_slug = ? AND status IN ('published','partial') ORDER BY created_at DESC LIMIT 1`
  ).bind(input.repo_slug).first();
  if (!latestJob) return json({ ok: false, error: "no published job for repo_slug" }, 404);
  const artifact = await env.ARTIFACTS.get(latestJob.artifact_key as string);
  if (!artifact) return json({ ok: false, error: "artifact not found in R2" }, 404);
  const records = parseRecords(await artifact.text());
  const recordById = new Map<string, SourceRecord>();
  for (const r of records) recordById.set(r.chunk_id, r);

  // Find code chunks lacking HyDE at the target version.
  const missingRows = await env.DB.prepare(
    `SELECT c.chunk_id FROM chunks c
     WHERE c.active = 1 AND c.kind = 'code' AND c.repo_slug = ?
     AND NOT EXISTS (
       SELECT 1 FROM chunks h
       WHERE h.parent_chunk_id = c.chunk_id AND h.kind = 'hyde' AND h.active = 1
       AND (h.hyde_version = ? OR ? = '')
     )
     LIMIT ?`
  ).bind(input.repo_slug, targetVersion, "", scanLimit).all();
  const missingIds = (missingRows.results || []).map(r => r.chunk_id as string);
  const missingRecords = missingIds.map(id => recordById.get(id)).filter((r): r is SourceRecord => !!r);

  if (missingRecords.length === 0) {
    return json({
      ok: true, repo_slug: input.repo_slug, target_hyde_version: targetVersion,
      code_scanned: records.length, missing_hyde: 0, processed: 0, hyde_added: 0,
      wall_ms: 0, vectors_per_sec: 0,
      shards: [], note: "all code chunks already have HyDE at target version",
    });
  }

  const enrichJobId = `hyde-enrich-${Date.now()}`;
  // Distribute missing records across shards
  const shards: SourceRecord[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (let i = 0; i < missingRecords.length; i++) shards[i % SHARD_COUNT].push(missingRecords[i]);

  const tStart = Date.now();
  const responses = await Promise.allSettled(shards.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % NUM_SAS, chunks_done: 0, hyde_done: 0, vertex_calls: 0, deepseek_calls: 0, vertex_ms: 0, deepseek_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as ShardResult;
    const stub = env.INDEXING_SHARD_DO!.get(env.INDEXING_SHARD_DO!.idFromName(`cfcode:hyde-enrich-shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: enrichJobId, repo_slug: input.repo_slug,
        shard_index: idx, sa_index: idx % NUM_SAS, batch_size: BATCH_SIZE,
        hyde: true,
        // hyde_only: skip code path. Force by sending records but flag in DO.
        hyde_only: true,
        records: recs,
      } satisfies ShardBatchReq & { hyde_only?: boolean }),
    });
    if (!r.ok) throw new Error(`shard ${idx}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json() as ShardResult;
  }));
  const wallMs = Date.now() - tStart;

  const shardResults: ShardResult[] = [];
  let hydeDone = 0; let errs = 0; let vCalls = 0; let dsCalls = 0;
  for (const r of responses) {
    if (r.status === "fulfilled") {
      shardResults.push(r.value);
      hydeDone += r.value.hyde_done;
      errs += r.value.errors;
      vCalls += r.value.vertex_calls;
      dsCalls += r.value.deepseek_calls;
    } else {
      console.error("hyde-enrich shard rejected:", r.reason);
      errs += 1;
    }
  }

  return json({
    ok: errs === 0,
    repo_slug: input.repo_slug,
    target_hyde_version: targetVersion,
    code_scanned: records.length,
    missing_hyde: missingRecords.length,
    processed: missingRecords.length,
    hyde_added: hydeDone,
    failed: errs,
    deepseek_calls_total: dsCalls,
    vertex_calls_total: vCalls,
    wall_ms: wallMs,
    vectors_per_sec: +(hydeDone / (wallMs / 1000)).toFixed(3),
    shard_count: SHARD_COUNT, batch_size: BATCH_SIZE,
    shards: shardResults,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-30a-hyde-shard" });
    if (url.pathname === "/ingest-sharded-hyde" && request.method === "POST") {
      return ingestShardedHyde(env, await request.json().catch(() => ({})) as IngestShardedHydeReq);
    }
    if (url.pathname === "/hyde-enrich" && request.method === "POST") {
      return hydeEnrich(env, await request.json().catch(() => ({})) as HydeEnrichReq);
    }
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    if (url.pathname === "/counts") return counts(env);
    return json({ error: "not_found" }, 404);
  },
};
