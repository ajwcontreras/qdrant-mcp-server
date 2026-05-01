// POC 31C: Indexing on scaffold patterns.
//
// Applies cfpubsub-scaffold DeliveryShardDO + fanOutToShards patterns
// to our indexing pipeline. Key patterns stolen:
//   1. Fire-and-forget via DO alarm (TopicLedgerDO → OrchestratorDO)
//   2. Promise.allSettled at BOTH levels: across shards + within shard
//   3. Aggregate delivered/errors per shard, then sum
//   4. DO storage only for config (artifact_key, not artifact text)
//   5. R2-pull per shard: each shard reads artifact, filters own records
//
// Deploy: standalone worker cfcode-poc-31c-scaffold
// Smoke: node cloudflare-mcp/scripts/poc-31c-scaffold-indexer-bench.mjs

import { DurableObject } from "cloudflare:workers";

type R2Body = { text(): Promise<string> };
type R2Like = {
  put(key: string, value: string, opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2Body | null>;
};
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | boolean | number> };
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
  ORCHESTRATOR_DO: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  GEMINI_SERVICE_ACCOUNT_B64_3?: string;
  GEMINI_SERVICE_ACCOUNT_B64_4?: string;
  DEEPSEEK_API_KEY?: string;
  CODE_SHARD_COUNT?: string; HYDE_SHARD_COUNT?: string;
  CODE_BATCH_SIZE?: string; HYDE_BATCH_SIZE?: string;
  NUM_SAS?: string;
  HYDE_QUESTIONS?: string; HYDE_MODEL?: string; HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type OrchestratorConfig = {
  artifact_key: string; job_id: string; repo_slug: string; indexed_path: string; active_commit: string;
  total: number; code_shard_count: number; hyde_shard_count: number;
  code_batch_size: number; hyde_batch_size: number; num_sas: number; hyde: boolean; t_start: number;
};
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number; sa_index: number; batch_size: number };
type ShardResult = { shard_index: number; done: number; calls: number; errors: number; wall_ms: number };
type CodeShardResult = ShardResult & { sa_index: number; vertex_ms: number; vectorize_ms: number; d1_ms: number };
type HydeShardResult = ShardResult & {
  sa_index: number; deepseek_calls: number; deepseek_ms: number;
  vertex_ms: number; vectorize_ms: number; d1_ms: number;
};
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

// ── Helpers ──

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).then(r => { clearTimeout(timer); return r; }, e => { clearTimeout(timer); throw e; });
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, indexed_path TEXT NOT NULL,
    active_commit TEXT NOT NULL, artifact_key TEXT NOT NULL, total INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    code_status TEXT NOT NULL DEFAULT 'pending', hyde_status TEXT NOT NULL DEFAULT 'pending',
    code_wall_ms INTEGER, hyde_wall_ms INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    snippet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'code',
    parent_chunk_id TEXT, hyde_version TEXT, hyde_model TEXT,
    model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_repo_kind ON chunks(repo_slug, kind, active)`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord)
    .filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

// ── OAuth + Vertex embedding ──

const tokenCacheBySA: Map<string, { token: string; expiresAt: number }> = new Map();

function parseSAByIndex(env: Env, saIndex: number): GoogleSA {
  let b64: string | undefined;
  if (saIndex === 0) b64 = env.GEMINI_SERVICE_ACCOUNT_B64;
  else if (saIndex === 1) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_2;
  else if (saIndex === 2) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_3;
  else if (saIndex === 3) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_4;
  if (!b64) throw new Error(`SA secret for index ${saIndex} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid SA");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const b64url = (v: string | ArrayBuffer) => {
    const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(pem); const keyBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", keyBytes.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

async function tokenForSA(sa: GoogleSA): Promise<string> {
  const now = Date.now();
  const cached = tokenCacheBySA.get(sa.client_email);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const res = await fetchWithTimeout(sa.token_uri || "https://oauth2.googleapis.com/token", {
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
    res = await fetchWithTimeout(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })), parameters: { autoTruncate: true, outputDimensionality: dims } }),
    });
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`Vertex ${res.status}: ${raw.slice(0, 500)}`);
    if (attempt === 4) throw new Error(`Vertex retries exhausted: ${raw.slice(0, 300)}`);
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

// ── DeepSeek HyDE ──

const HYDE_SYSTEM = `You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {"questions": ["q1", ..., "q12"]}. No prose, no markdown, no extra keys.`;

async function deepseekHyde(env: Env, chunkText: string, n: number): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
  let raw = ""; let res: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetchWithTimeout("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: env.HYDE_MODEL || "deepseek-v4-flash", messages: [{ role: "system", content: HYDE_SYSTEM }, { role: "user", content: chunkText }], response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 1500 }),
    }, 60_000);
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`DeepSeek ${res.status}: ${raw.slice(0, 300)}`);
    if (attempt === 3) throw new Error(`DeepSeek retries exhausted`);
    await new Promise(r => setTimeout(r, 200 * Math.pow(3, attempt) + Math.random() * 100));
  }
  if (!res || !res.ok) throw new Error(`DeepSeek failed`);
  const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek empty");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`DeepSeek non-JSON`); }
  const arr = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(arr)) throw new Error("DeepSeek missing questions[]");
  return arr.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, n);
}

// ── R2-pull: shared ──

async function pullAndFilter(env: Env, artifactKey: string, shardIndex: number, shardCount: number): Promise<SourceRecord[]> {
  const obj = await env.ARTIFACTS.get(artifactKey);
  if (!obj) throw new Error(`artifact ${artifactKey} not found`);
  const text = await obj.text();
  return parseRecords(text).filter((_, i) => i % shardCount === shardIndex);
}

// ── CODE shard ──

export class CodeShardDO extends DurableObject<Env> {
  async processBatch(req: ShardReq): Promise<CodeShardResult> {
    const t0 = Date.now();
    console.log("code shard start", { idx: req.shard_index, artifact: req.artifact_key.slice(0, 40) });
    const result: CodeShardResult = { shard_index: req.shard_index, sa_index: req.sa_index, done: 0, calls: 0, errors: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, wall_ms: 0 };
    const records = await pullAndFilter(this.env, req.artifact_key, req.shard_index, req.shard_count);
    console.log("code shard records", { idx: req.shard_index, count: records.length });
    if (!records.length) { result.wall_ms = Date.now() - t0; return result; }
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);

    const groups: SourceRecord[][] = [];
    for (let i = 0; i < records.length; i += req.batch_size) groups.push(records.slice(i, i + req.batch_size));

    for (const group of groups) {
      const tV = Date.now();
      let embeddings: { values: number[]; norm: number }[];
      try {
        embeddings = await embedBatch(this.env, sa, group.map(r => r.text));
        result.calls += 1; result.vertex_ms += Date.now() - tV;
      } catch (e) { result.errors += group.length; continue; }

      const tVec = Date.now();
      try {
        await this.env.VECTORIZE.upsert(group.map((r, i) => ({
          id: r.chunk_id, values: embeddings[i].values,
          metadata: { repo_slug: r.repo_slug, file_path: r.file_path, kind: "code", shard_index: req.shard_index },
        })));
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) { result.errors += group.length; continue; }

      const tD = Date.now();
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks (chunk_id,job_id,repo_slug,file_path,source_sha256,snippet,active,kind,parent_chunk_id,model,dimensions,norm,published_at) VALUES (?,?,?,?,?,?,1,'code',NULL,?,?,?,?)`
        ).bind(r.chunk_id, req.job_id, r.repo_slug, r.file_path, r.source_sha256, r.text.slice(0, 500), model, dims, embeddings[i].norm, now));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD;
        result.done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET completed = completed + ? WHERE job_id = ?`).bind(group.length, req.job_id).run();
      } catch (e) { result.errors += group.length; }
    }
    result.wall_ms = Date.now() - t0;
    return result;
  }
  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/process-batch" && request.method === "POST") return json(await this.processBatch(await request.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── HYDE shard ──

export class HydeShardDO extends DurableObject<Env> {
  async processBatch(req: ShardReq): Promise<HydeShardResult> {
    const t0 = Date.now();
    console.log("hyde shard start", { idx: req.shard_index, artifact: req.artifact_key.slice(0, 40) });
    const result: HydeShardResult = { shard_index: req.shard_index, sa_index: req.sa_index, done: 0, calls: 0, errors: 0, deepseek_calls: 0, deepseek_ms: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, wall_ms: 0 };
    const records = await pullAndFilter(this.env, req.artifact_key, req.shard_index, req.shard_count);
    console.log("hyde shard records", { idx: req.shard_index, count: records.length });
    if (!records.length) { result.wall_ms = Date.now() - t0; return result; }
    const sa = parseSAByIndex(this.env, req.sa_index);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const numHyde = intEnv(this.env.HYDE_QUESTIONS, 12);
    const hydeVersion = this.env.HYDE_VERSION || "v1";
    const hydeModel = this.env.HYDE_MODEL || "deepseek-v4-flash";
    const collected: { record: SourceRecord; questions: string[] }[] = [];

    // Scaffold pattern: explicit concurrency batching (6 at a time)
    const DS_CONCURRENCY = 6;
    const tDS = Date.now();
    for (let i = 0; i < records.length; i += DS_CONCURRENCY) {
      const batch = records.slice(i, i + DS_CONCURRENCY);
      const outcomes = await Promise.allSettled(batch.map(async r => {
        result.deepseek_calls += 1;
        return { record: r, questions: await deepseekHyde(this.env, r.text, numHyde) };
      }));
      // Scaffold pattern: aggregate successes, count failures — never bail on first error
      for (const o of outcomes) {
        if (o.status === "fulfilled") collected.push(o.value);
        else result.errors += 1;
      }
    }
    result.deepseek_ms += Date.now() - tDS;
    if (!collected.length) { result.wall_ms = Date.now() - t0; return result; }

    const flat: { parentId: string; qIndex: number; text: string; record: SourceRecord }[] = [];
    for (const { record, questions } of collected) {
      for (let i = 0; i < questions.length; i++) flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i], record });
    }
    const groups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += req.batch_size) groups.push(flat.slice(i, i + req.batch_size));

    const tV = Date.now();
    const embedOutcomes = await Promise.allSettled(groups.map(async group => {
      const embs = await embedBatch(this.env, sa, group.map(g => g.text));
      result.calls += 1;
      return { group, embs };
    }));
    result.vertex_ms += Date.now() - tV;

    const now = new Date().toISOString();
    for (const o of embedOutcomes) {
      if (o.status !== "fulfilled") { result.errors += 1; continue; }
      const { group, embs } = o.value;
      try {
        await this.env.VECTORIZE.upsert(group.map((g, i) => ({
          id: `${g.parentId}-h${g.qIndex}`, values: embs[i].values,
          metadata: { repo_slug: g.record.repo_slug, file_path: g.record.file_path, kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex },
        })));
        result.vectorize_ms += Date.now() - tV;
      } catch (e) { result.errors += group.length; continue; }
      try {
        const stmts = group.map((g, i) => this.env.DB.prepare(
          `INSERT OR REPLACE INTO chunks (chunk_id,job_id,repo_slug,file_path,source_sha256,snippet,active,kind,parent_chunk_id,hyde_version,hyde_model,model,dimensions,norm,published_at) VALUES (?,?,?,?,?,?,1,'hyde',?,?,?,?,?,?,?)`
        ).bind(`${g.parentId}-h${g.qIndex}`, req.job_id, g.record.repo_slug, g.record.file_path, g.record.source_sha256, g.text.slice(0, 500), g.parentId, hydeVersion, hydeModel, model, dims, embs[i].norm, now));
        await this.env.DB.batch(stmts);
        result.done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_completed = hyde_completed + ? WHERE job_id = ?`).bind(group.length, req.job_id).run();
      } catch (e) { result.errors += group.length; }
    }
    result.wall_ms = Date.now() - t0;
    console.log("hyde shard done", { idx: req.shard_index, done: result.done, errs: result.errors, deepseek_calls: result.deepseek_calls, wall: result.wall_ms });
    return result;
  }
  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/process-batch" && request.method === "POST") return json(await this.processBatch(await request.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── OrchestratorDO: scaffold-pattern alarm-driven fan-out ──

export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/start" && req.method === "POST") {
      const cfg = await req.json() as OrchestratorConfig;
      await this.ctx.storage.put("config", cfg);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<OrchestratorConfig>("config");
    if (!cfg) { console.log("orch alarm: no config"); return; }
    console.log("orch alarm: starting fan-out", { job_id: cfg.job_id, total: cfg.total, code_shards: cfg.code_shard_count, hyde_shards: cfg.hyde_shard_count });

    try {
      // Scaffold pattern: fanOutToShards via Promise.allSettled over all indices
      const codeOutcomes = await Promise.allSettled(
        Array.from({ length: cfg.code_shard_count }, (_, idx) => idx).map(async idx => {
          const stub = this.env.CODE_SHARD_DO.get(this.env.CODE_SHARD_DO.idFromName(`c:${idx}`));
          const r = await stub.fetch("https://s/process-batch", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.code_shard_count, sa_index: idx % cfg.num_sas, batch_size: cfg.code_batch_size } satisfies ShardReq),
          });
          if (!r.ok) throw new Error(`code ${idx}: ${r.status}`);
          return await r.json() as CodeShardResult;
        })
      );

      // Scaffold pattern: aggregate successes and errors
      let codeDone = 0, codeErrs = 0;
      for (const o of codeOutcomes) {
        if (o.status === "fulfilled") { codeDone += o.value.done; codeErrs += o.value.errors; }
        else { codeErrs += 1; console.log("code shard rejected", { idx: codeOutcomes.indexOf(o) }); }
      }
      console.log("orch code fan-out done", { codeDone, codeErrs, shards: codeOutcomes.length });
      const codeWall = Date.now() - cfg.t_start;
      await this.env.DB.prepare(`UPDATE jobs SET code_status=?,code_wall_ms=?,completed=? WHERE job_id=?`)
        .bind(codeErrs === 0 ? "live" : "partial", codeWall, codeDone, cfg.job_id).run();

      // HyDE fan-out
      const hydeOutcomes = cfg.hyde === false ? [] : await Promise.allSettled(
        Array.from({ length: cfg.hyde_shard_count }, (_, idx) => idx).map(async idx => {
          const stub = this.env.HYDE_SHARD_DO.get(this.env.HYDE_SHARD_DO.idFromName(`h:${idx}`));
          const r = await stub.fetch("https://s/process-batch", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.hyde_shard_count, sa_index: idx % cfg.num_sas, batch_size: cfg.hyde_batch_size } satisfies ShardReq),
          });
          if (!r.ok) throw new Error(`hyde ${idx}: ${r.status}`);
          return await r.json() as HydeShardResult;
        })
      );

      let hydeDone = 0, hydeErrs = 0;
      for (const o of hydeOutcomes) {
        if (o.status === "fulfilled") { hydeDone += o.value.done; hydeErrs += o.value.errors; }
        else { hydeErrs += 1; console.log("hyde shard rejected"); }
      }
      console.log("orch hyde fan-out done", { hydeDone, hydeErrs, shards: hydeOutcomes.length });
      if (cfg.hyde !== false) {
        const hydeWall = Date.now() - cfg.t_start;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_status=?,hyde_wall_ms=?,hyde_completed=? WHERE job_id=?`)
          .bind(hydeErrs === 0 ? "live" : "partial", hydeWall, hydeDone, cfg.job_id).run();
      }

      // Final status
      const allOk = (codeErrs === 0) && (cfg.hyde === false || hydeErrs === 0);
      await this.env.DB.prepare(`UPDATE jobs SET status=?,failed=? WHERE job_id=?`)
        .bind(allOk ? "published" : "partial", codeErrs + hydeErrs, cfg.job_id).run();
    } catch (e) {
      console.error("orch alarm failed:", e instanceof Error ? e.message : e);
      await this.env.DB.prepare(`UPDATE jobs SET status='failed',failed=failed+1 WHERE job_id=?`).bind(cfg.job_id).run();
    } finally {
      await this.ctx.storage.delete("config");
    }
  }
}

// ── Producer: return immediately, fire orchestrator ──

async function ingestSharded(env: Env, input: Record<string, unknown>): Promise<Response> {
  await schema(env.DB);
  const jobId = String(input.job_id || ""), repoSlug = String(input.repo_slug || "");
  const indexedPath = String(input.indexed_path || ""), activeCommit = String(input.active_commit || "");
  const artifactKey = String(input.artifact_key || ""), artifactText = String(input.artifact_text || "");
  if (!jobId || !repoSlug || !indexedPath || !activeCommit || !artifactKey || !artifactText) return json({ ok: false, error: "missing required fields" }, 400);

  const records = parseRecords(artifactText);
  if (!records.length) return json({ ok: false, error: "no records" }, 400);

  const codeShards = Number(input.code_shard_count) || intEnv(env.CODE_SHARD_COUNT, 4);
  const hydeShards = Number(input.hyde_shard_count) || intEnv(env.HYDE_SHARD_COUNT, 16);
  const codeBatch = Number(input.code_batch_size) || intEnv(env.CODE_BATCH_SIZE, 500);
  const hydeBatch = Number(input.hyde_batch_size) || intEnv(env.HYDE_BATCH_SIZE, 500);
  const numSas = Number(input.num_sas) || intEnv(env.NUM_SAS, 2);
  const includeHyde = input.hyde !== false;
  const tStart = Date.now();

  await env.ARTIFACTS.put(artifactKey, artifactText, { httpMetadata: { contentType: "application/jsonl" } });
  await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,repo_slug,indexed_path,active_commit,artifact_key,total,completed,hyde_completed,failed,code_status,hyde_status,status,created_at) VALUES (?,?,?,?,?,?,0,0,0,'running',?,'running',?)`)
    .bind(jobId, repoSlug, indexedPath, activeCommit, artifactKey, records.length, includeHyde ? "running" : "skipped", new Date(tStart).toISOString()).run();

  const cfg: OrchestratorConfig = { artifact_key: artifactKey, job_id: jobId, repo_slug: repoSlug, indexed_path: indexedPath, active_commit: activeCommit, total: records.length, code_shard_count: codeShards, hyde_shard_count: hydeShards, code_batch_size: codeBatch, hyde_batch_size: hydeBatch, num_sas: numSas, hyde: includeHyde, t_start: tStart };
  const stub = env.ORCHESTRATOR_DO.get(env.ORCHESTRATOR_DO.idFromName(`orch:${jobId}`));
  const r = await stub.fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
  if (!r.ok) { const t = await r.text(); return json({ ok: false, error: `orch: ${r.status} ${t.slice(0, 300)}` }, 500); }

  return json({ ok: true, job_id: jobId, chunks: records.length, status: "running", response_ms: Date.now() - tStart });
}

async function jobStatus(env: Env, jobId: string): Promise<Response> {
  await schema(env.DB);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  return json({ ok: true, job });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "cfcode-poc-31c-scaffold" });
    if (u.pathname === "/ingest-sharded" && request.method === "POST") return ingestSharded(env, await request.json().catch(() => ({})) as Record<string, unknown>);
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) return jobStatus(env, sm[1]);
    return json({ error: "not_found" }, 404);
  },
};
