// POC 30C: dual fan-out — code shards + hyde shards as TWO independent
// Promise.allSettled populations at the producer level. Single-purpose DOs.
// No combined mode in any DO. Code search becomes available the moment code
// fan-out commits, HyDE arrives shortly after.

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
  CODE_SHARD_DO: DONamespaceLike;
  HYDE_SHARD_DO: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  DEEPSEEK_API_KEY?: string;
  CODE_SHARD_COUNT?: string; HYDE_SHARD_COUNT?: string;
  CODE_BATCH_SIZE?: string; HYDE_BATCH_SIZE?: string;
  NUM_SAS?: string;
  HYDE_QUESTIONS?: string; HYDE_MODEL?: string; HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type IngestReq = {
  job_id: string; repo_slug: string; indexed_path: string; active_commit: string;
  artifact_key: string; artifact_text: string;
  code_shard_count?: number; hyde_shard_count?: number;
  code_batch_size?: number; hyde_batch_size?: number;
  hyde?: boolean;
};
type CodeBatchReq = {
  job_id: string; shard_index: number; sa_index: number; batch_size: number;
  records: SourceRecord[];
};
type HydeBatchReq = CodeBatchReq;
type CodeShardResult = {
  shard_index: number; sa_index: number;
  chunks_done: number; vertex_calls: number;
  vertex_ms: number; vectorize_ms: number; d1_ms: number; errors: number;
};
type HydeShardResult = {
  shard_index: number; sa_index: number;
  hyde_done: number; vertex_calls: number; deepseek_calls: number;
  deepseek_ms: number; vertex_ms: number; vectorize_ms: number; d1_ms: number; errors: number;
};
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL,
    indexed_path TEXT NOT NULL, active_commit TEXT NOT NULL,
    artifact_key TEXT NOT NULL, total INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    code_status TEXT NOT NULL DEFAULT 'pending',
    hyde_status TEXT NOT NULL DEFAULT 'pending',
    code_wall_ms INTEGER, hyde_wall_ms INTEGER,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    snippet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'code',
    parent_chunk_id TEXT, hyde_version TEXT, hyde_model TEXT,
    model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_repo_kind ON chunks(repo_slug, kind, active)`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

const tokenCacheBySA: Map<string, { token: string; expiresAt: number }> = new Map();
function parseSAByIndex(env: Env, saIndex: number): GoogleSA {
  const b64 = saIndex === 1 ? env.GEMINI_SERVICE_ACCOUNT_B64_2 : env.GEMINI_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error(`SA secret for index ${saIndex} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid SA");
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
  let raw = ""; let res: Response | undefined;
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
    if (res.status !== 429 && res.status < 500) throw new Error(`Vertex ${res.status}: ${raw.slice(0, 500)}`);
    if (attempt === 4) throw new Error(`Vertex retries exhausted ${res.status}: ${raw.slice(0, 500)}`);
    await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt) + Math.random() * 200));
  }
  if (!res || !res.ok) throw new Error(`Vertex failed: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const preds = d.predictions || [];
  if (preds.length !== texts.length) throw new Error(`Vertex returned ${preds.length} preds for ${texts.length}`);
  return preds.map(p => {
    const values = p.embeddings?.values;
    if (!Array.isArray(values) || !values.every(v => typeof v === "number")) throw new Error("bad Vertex response");
    const norm = Math.sqrt(values.reduce((s: number, v: number) => s + v * v, 0));
    return { values: values as number[], norm };
  });
}

const HYDE_SYSTEM = `You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {"questions": ["q1", ..., "q12"]}. No prose, no markdown, no extra keys. Questions should cover: what the code does, when to use it, edge cases, related concepts, debugging, and integration. Diverse phrasings.`;

async function deepseekHyde(env: Env, chunkText: string, n: number): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
  let raw = ""; let res: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: env.HYDE_MODEL || "deepseek-v4-flash",
        messages: [{ role: "system", content: HYDE_SYSTEM }, { role: "user", content: chunkText }],
        response_format: { type: "json_object" },
        temperature: 0.4, max_tokens: 1500,
      }),
    });
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`DeepSeek ${res.status}: ${raw.slice(0, 300)}`);
    if (attempt === 3) throw new Error(`DeepSeek retries exhausted ${res.status}: ${raw.slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 200 * Math.pow(3, attempt) + Math.random() * 100));
  }
  if (!res || !res.ok) throw new Error(`DeepSeek failed: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek empty");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`DeepSeek non-JSON: ${content.slice(0, 200)}`); }
  const arr = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(arr)) throw new Error("DeepSeek missing questions[]");
  return arr.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, n);
}

// ── CODE shard: pure code path ──
export class CodeShardDO extends DurableObject<Env> {
  async processBatch(req: CodeBatchReq): Promise<CodeShardResult> {
    const result: CodeShardResult = {
      shard_index: req.shard_index, sa_index: req.sa_index,
      chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0,
    };
    if (!req.records.length) return result;
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);

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
      } catch (e) { result.errors += group.length; console.error(`code shard ${req.shard_index} embed:`, e instanceof Error ? e.message : e); continue; }
      const tVec = Date.now();
      try {
        const entries: VecEntry[] = group.map((r, i) => ({
          id: r.chunk_id, values: embeddings[i].values,
          metadata: { repo_slug: r.repo_slug, file_path: r.file_path, source_sha256: r.source_sha256, kind: "code", shard_index: req.shard_index },
        }));
        await this.env.VECTORIZE.upsert(entries);
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) { result.errors += group.length; console.error(`code shard ${req.shard_index} vectorize:`, e instanceof Error ? e.message : e); continue; }
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
      } catch (e) { result.errors += group.length; console.error(`code shard ${req.shard_index} d1:`, e instanceof Error ? e.message : e); }
    }
    return result;
  }
  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/process-batch" && request.method === "POST") {
      return json(await this.processBatch(await request.json() as CodeBatchReq));
    }
    return json({ error: "not_found" }, 404);
  }
}

// ── HYDE shard: pure HyDE path ──
export class HydeShardDO extends DurableObject<Env> {
  async processBatch(req: HydeBatchReq): Promise<HydeShardResult> {
    const result: HydeShardResult = {
      shard_index: req.shard_index, sa_index: req.sa_index,
      hyde_done: 0, vertex_calls: 0, deepseek_calls: 0,
      deepseek_ms: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0,
    };
    if (!req.records.length) return result;
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const numHyde = intEnv(this.env.HYDE_QUESTIONS, 12);
    const hydeVersion = this.env.HYDE_VERSION || "v1";
    const hydeModel = this.env.HYDE_MODEL || "deepseek-v4-flash";

    const tDS = Date.now();
    const hydeResults = await Promise.allSettled(req.records.map(async r => {
      result.deepseek_calls += 1;
      const questions = await deepseekHyde(this.env, r.text, numHyde);
      return { record: r, questions };
    }));
    result.deepseek_ms += Date.now() - tDS;

    const collected: { record: SourceRecord; questions: string[] }[] = [];
    for (const r of hydeResults) {
      if (r.status === "fulfilled") collected.push(r.value);
      else { result.errors += 1; console.error("deepseek failed:", r.reason instanceof Error ? r.reason.message : r.reason); }
    }
    if (!collected.length) return result;

    const flat: { parentId: string; qIndex: number; text: string; record: SourceRecord }[] = [];
    for (const { record, questions } of collected) {
      for (let i = 0; i < questions.length; i++) flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i], record });
    }
    const groups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += req.batch_size) groups.push(flat.slice(i, i + req.batch_size));

    const tV = Date.now();
    const embedResults = await Promise.allSettled(groups.map(async group => {
      const embs = await embedBatch(this.env, sa, group.map(g => g.text));
      result.vertex_calls += 1;
      return { group, embs };
    }));
    result.vertex_ms += Date.now() - tV;

    const now = new Date().toISOString();
    for (const er of embedResults) {
      if (er.status !== "fulfilled") { result.errors += 1; console.error("hyde embed:", er.reason instanceof Error ? er.reason.message : er.reason); continue; }
      const { group, embs } = er.value;
      const tVec = Date.now();
      try {
        const entries: VecEntry[] = group.map((g, i) => ({
          id: `${g.parentId}-h${g.qIndex}`, values: embs[i].values,
          metadata: { repo_slug: g.record.repo_slug, file_path: g.record.file_path, kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex, shard_index: req.shard_index },
        }));
        await this.env.VECTORIZE.upsert(entries);
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) { result.errors += group.length; console.error("hyde vectorize:", e instanceof Error ? e.message : e); continue; }
      const tD = Date.now();
      try {
        const stmts = group.map((g, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks
            (chunk_id, job_id, repo_slug, file_path, source_sha256, snippet, active, kind, parent_chunk_id, hyde_version, hyde_model, model, dimensions, norm, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, 'hyde', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(`${g.parentId}-h${g.qIndex}`, req.job_id, g.record.repo_slug, g.record.file_path, g.record.source_sha256, g.text.slice(0, 500), g.parentId, hydeVersion, hydeModel, model, dims, embs[i].norm, now));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD;
        result.hyde_done += group.length;
      } catch (e) { result.errors += group.length; console.error("hyde d1:", e instanceof Error ? e.message : e); }
    }
    return result;
  }
  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/process-batch" && request.method === "POST") {
      return json(await this.processBatch(await request.json() as HydeBatchReq));
    }
    return json({ error: "not_found" }, 404);
  }
}

// ── Producer: dual fan-out ──
async function ingestSharded(env: Env, input: IngestReq): Promise<Response> {
  await schema(env.DB);
  if (!input.job_id || !input.repo_slug || !input.indexed_path || !input.active_commit || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "missing required fields" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (!records.length) return json({ ok: false, error: "no records" }, 400);

  const codeShards = Math.max(1, input.code_shard_count ?? intEnv(env.CODE_SHARD_COUNT, 4));
  const hydeShards = Math.max(1, input.hyde_shard_count ?? intEnv(env.HYDE_SHARD_COUNT, 16));
  const codeBatch = Math.max(1, input.code_batch_size ?? intEnv(env.CODE_BATCH_SIZE, 100));
  const hydeBatch = Math.max(1, input.hyde_batch_size ?? intEnv(env.HYDE_BATCH_SIZE, 100));
  const numSAs = Math.max(1, intEnv(env.NUM_SAS, env.GEMINI_SERVICE_ACCOUNT_B64_2 ? 2 : 1));
  const includeHyde = input.hyde !== false;

  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: input.job_id, record_count: String(records.length) },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO jobs (job_id, repo_slug, indexed_path, active_commit, artifact_key, total, completed, hyde_completed, failed, code_status, hyde_status, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'running', ?, 'running', ?)`
  ).bind(input.job_id, input.repo_slug, input.indexed_path, input.active_commit, input.artifact_key, records.length, includeHyde ? "running" : "skipped", new Date().toISOString()).run();

  // Distribute records into code-shard buckets and hyde-shard buckets
  const codeBuckets: SourceRecord[][] = Array.from({ length: codeShards }, () => []);
  for (let i = 0; i < records.length; i++) codeBuckets[i % codeShards].push(records[i]);
  const hydeBuckets: SourceRecord[][] = Array.from({ length: hydeShards }, () => []);
  for (let i = 0; i < records.length; i++) hydeBuckets[i % hydeShards].push(records[i]);

  const tStart = Date.now();

  // Two independent fan-outs as Promise.allSettled populations
  const codeFanout = Promise.allSettled(codeBuckets.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % numSAs, chunks_done: 0, vertex_calls: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as CodeShardResult;
    const stub = env.CODE_SHARD_DO.get(env.CODE_SHARD_DO.idFromName(`cfcode:code-shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: input.job_id, shard_index: idx, sa_index: idx % numSAs, batch_size: codeBatch, records: recs } satisfies CodeBatchReq),
    });
    if (!r.ok) throw new Error(`code shard ${idx}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json() as CodeShardResult;
  })).then(async results => {
    const tEnd = Date.now();
    const ok: CodeShardResult[] = []; let done = 0; let errs = 0;
    for (const r of results) { if (r.status === "fulfilled") { ok.push(r.value); done += r.value.chunks_done; errs += r.value.errors; } else errs += 1; }
    await env.DB.prepare(`UPDATE jobs SET completed = ?, code_status = ?, code_wall_ms = ? WHERE job_id = ?`)
      .bind(done, errs === 0 ? "live" : "partial", tEnd - tStart, input.job_id).run();
    return { results: ok, completed: done, errors: errs, wall_ms: tEnd - tStart };
  });

  const hydeFanout = !includeHyde ? Promise.resolve({ results: [] as HydeShardResult[], hyde_completed: 0, errors: 0, wall_ms: 0 }) : Promise.allSettled(hydeBuckets.map(async (recs, idx) => {
    if (!recs.length) return { shard_index: idx, sa_index: idx % numSAs, hyde_done: 0, vertex_calls: 0, deepseek_calls: 0, deepseek_ms: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, errors: 0 } as HydeShardResult;
    const stub = env.HYDE_SHARD_DO.get(env.HYDE_SHARD_DO.idFromName(`cfcode:hyde-shard:${idx}`));
    const r = await stub.fetch("https://shard.internal/process-batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: input.job_id, shard_index: idx, sa_index: idx % numSAs, batch_size: hydeBatch, records: recs } satisfies HydeBatchReq),
    });
    if (!r.ok) throw new Error(`hyde shard ${idx}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json() as HydeShardResult;
  })).then(async results => {
    const tEnd = Date.now();
    const ok: HydeShardResult[] = []; let done = 0; let errs = 0;
    for (const r of results) { if (r.status === "fulfilled") { ok.push(r.value); done += r.value.hyde_done; errs += r.value.errors; } else errs += 1; }
    await env.DB.prepare(`UPDATE jobs SET hyde_completed = ?, hyde_status = ?, hyde_wall_ms = ? WHERE job_id = ?`)
      .bind(done, errs === 0 ? "live" : "partial", tEnd - tStart, input.job_id).run();
    return { results: ok, hyde_completed: done, errors: errs, wall_ms: tEnd - tStart };
  });

  // Wait for both
  const [codeRes, hydeRes] = await Promise.all([codeFanout, hydeFanout]);
  const totalErrs = codeRes.errors + hydeRes.errors;
  const status = totalErrs === 0 ? "published" : (codeRes.completed > 0 ? "partial" : "failed");
  await env.DB.prepare(`UPDATE jobs SET failed = ?, status = ? WHERE job_id = ?`)
    .bind(totalErrs, status, input.job_id).run();

  return json({
    ok: totalErrs === 0,
    job_id: input.job_id,
    chunks: records.length,
    code: { shard_count: codeShards, batch_size: codeBatch, completed: codeRes.completed, wall_ms: codeRes.wall_ms, errors: codeRes.errors, shards: codeRes.results, chunks_per_sec: +(codeRes.completed / (codeRes.wall_ms / 1000)).toFixed(3) },
    hyde: { shard_count: hydeShards, batch_size: hydeBatch, hyde_completed: hydeRes.hyde_completed, wall_ms: hydeRes.wall_ms, errors: hydeRes.errors, shards: hydeRes.results, vectors_per_sec: +(hydeRes.hyde_completed / Math.max(1, hydeRes.wall_ms / 1000)).toFixed(3) },
    total_wall_ms: Date.now() - tStart,
    status,
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "cfcode-poc-30c-dual-fanout" });
    if (u.pathname === "/ingest-sharded" && request.method === "POST") {
      return ingestSharded(env, await request.json().catch(() => ({})) as IngestReq);
    }
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    if (u.pathname === "/counts") return counts(env);
    return json({ error: "not_found" }, 404);
  },
};
