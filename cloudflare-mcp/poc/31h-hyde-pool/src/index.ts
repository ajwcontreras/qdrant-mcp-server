// POC 31H: Decoupled DeepSeek (unlimited shards) from Vertex (bounded pool).
// Proves: hyde questions can be generated at full DeepSeek concurrency,
// while Vertex embedding calls are serialized through a shared pool.
// Uses all 4 SAs with round-robin to maximize Vertex quota distribution.

import { DurableObject } from "cloudflare:workers";

type R2Body = { text(): Promise<string> };
type R2Like = { put(key: string, value: string, opts?: Record<string, unknown>): Promise<unknown>; get(key: string): Promise<R2Body | null> };
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = { upsert(v: VecEntry[]): Promise<unknown> };
type DOStub = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONs = { idFromName(name: string): unknown; get(id: unknown): DOStub };

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike;
  CODE_DO: DONs; HYDE_DO: DONs; ORCHESTRATOR_DO: DONs; EMBED_POOL_DO: DONs;
  GEMINI_SERVICE_ACCOUNT_B64?: string; GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  GEMINI_SERVICE_ACCOUNT_B64_3?: string; GEMINI_SERVICE_ACCOUNT_B64_4?: string;
  DEEPSEEK_API_KEY?: string;
  CODE_SHARD_COUNT?: string; HYDE_SHARD_COUNT?: string; NUM_SAS?: string;
  CODE_BATCH_SIZE?: string; HYDE_BATCH_SIZE?: string; EMBED_BATCH_SIZE?: string;
  HYDE_QUESTIONS?: string; HYDE_MODEL?: string; HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type JobConfig = { job_id: string; artifact_key: string; repo_slug: string; code_shards: number; hyde_shards: number; code_batch: number; hyde_batch: number; embed_batch: number; num_sas: number; hyde: boolean; t_start: number };
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number; sa_index: number; batch_size: number };
type EmbedReq = { sa_index: number; texts: string[] };
type EmbedResp = { values: number[]; norm: number }[];
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = parseInt(v || "", 10); return isFinite(n) ? n : d; }

function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...init, signal: c.signal }).then(r => { clearTimeout(t); return r; }, e => { clearTimeout(t); throw e; });
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord).filter(r => r.chunk_id && r.text);
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0, code_status TEXT DEFAULT 'pending', hyde_status TEXT DEFAULT 'pending', status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, snippet TEXT NOT NULL, active INTEGER DEFAULT 1, kind TEXT DEFAULT 'code', parent_chunk_id TEXT, hyde_version TEXT, hyde_model TEXT, model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL)`).run();
}

// ── Embedding Pool DO: serializes Vertex calls per SA ──
const tokenCache = new Map<string, { token: string; exp: number }>();

function parseSA(idx: number, env: Env): GoogleSA {
  let b64: string | undefined;
  if (idx === 0) b64 = env.GEMINI_SERVICE_ACCOUNT_B64;
  else if (idx === 1) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_2;
  else if (idx === 2) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_3;
  else if (idx === 3) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_4;
  if (!b64) throw new Error(`SA ${idx} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid SA");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const b64u = (v: string | ArrayBuffer) => { const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v); let b = ""; for (const x of bytes) b += String.fromCharCode(x); return btoa(b).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(pem); const kb = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", kb.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

async function saToken(sa: GoogleSA): Promise<string> {
  const now = Date.now(), c = tokenCache.get(sa.client_email);
  if (c && c.exp - 60_000 > now) return c.token;
  const iat = Math.floor(now / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const r = await fetchWithTimeout(sa.token_uri || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const d = JSON.parse(await r.text()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("no token");
  tokenCache.set(sa.client_email, { token: d.access_token, exp: now + Math.max(60, d.expires_in || 3600) * 1000 });
  return d.access_token;
}

async function embedBatchRaw(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
  const project = env.GOOGLE_PROJECT_ID || sa.project_id; if (!project) throw new Error("project_id");
  const loc = env.GOOGLE_LOCATION || "us-central1", model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await saToken(sa);
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  let raw = ""; let res: Response | undefined;
  for (let a = 0; a < 5; a++) {
    res = await fetchWithTimeout(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })), parameters: { autoTruncate: true, outputDimensionality: dims } }) });
    raw = await res.text(); if (res.ok) break;
    if (res.status !== 429 && res.status < 500) throw new Error(`Vertex ${res.status}: ${raw.slice(0, 300)}`);
    if (a === 4) throw new Error("Vertex retries exhausted");
    await new Promise(r => setTimeout(r, 300 * Math.pow(2, a) + Math.random() * 200));
  }
  if (!res || !res.ok) throw new Error("Vertex failed");
  const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  return (d.predictions || []).map(p => {
    const v = p.embeddings?.values; if (!Array.isArray(v) || !v.every(x => typeof x === "number")) throw new Error("bad Vertex response");
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
    return { values: v as number[], norm };
  });
}

// EmbeddingPoolDO: serializes Vertex calls per SA, shared across all hyde shards.
// Each SA gets its own queue. Multiple shards call in parallel; pool serializes.
export class EmbedPoolDO extends DurableObject<Env> {
  async embed(req: Request): Promise<Response> {
    const input = await req.json() as EmbedReq;
    const sa = parseSA(input.sa_index, this.env);
    console.log(`pool: embed START sa=${input.sa_index} texts=${input.texts.length}`);
    const t0 = Date.now();
    const result = await embedBatchRaw(this.env, sa, input.texts);
    console.log(`pool: embed DONE sa=${input.sa_index} ms=${Date.now() - t0}`);
    return json(result);
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/embed" && req.method === "POST") return this.embed(req);
    return json({ error: "not_found" }, 404);
  }
}

// ── DeepSeek (no rate limit) ──
const HYDE_SYS = `You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY: {"questions":["q1",...,"q12"]}. No prose, no markdown.`;

async function deepseekHyde(env: Env, text: string, n: number): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
  let raw = ""; let res: Response | undefined;
  for (let a = 0; a < 4; a++) {
    res = await fetchWithTimeout("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }, body: JSON.stringify({ model: env.HYDE_MODEL || "deepseek-v4-flash", messages: [{ role: "system", content: HYDE_SYS }, { role: "user", content: text }], response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 1500 }) }, 60_000);
    raw = await res.text(); if (res.ok) break;
    if (res.status >= 500 || res.status === 429) { await new Promise(r => setTimeout(r, 300 * (a + 1))); continue; }
    throw new Error(`DeepSeek ${res.status}`);
  }
  if (!res || !res.ok) throw new Error("DeepSeek failed");
  const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content; if (!content) throw new Error("DeepSeek empty");
  let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new Error("DS non-JSON"); }
  const arr = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(arr)) throw new Error("DS missing questions");
  return arr.filter((q): q is string => typeof q === "string").slice(0, n);
}

// ── CODE shard (unchanged from 31G) ──
export class CodeShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const obj = await this.env.ARTIFACTS.get(req.artifact_key);
    if (!obj) return { done, errors: errs };
    const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
    if (!records.length) return { done, errors: errs };
    const sa = parseSA(req.sa_index, this.env);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const groups: SourceRecord[][] = [];
    for (let i = 0; i < records.length; i += req.batch_size) groups.push(records.slice(i, i + req.batch_size));

    for (const group of groups) {
      let embs: { values: number[]; norm: number }[];
      try { embs = await embedBatchRaw(this.env, sa, group.map(r => r.text)); }
      catch (e) { errs += group.length; console.error("code: vertex FAIL"); continue; }
      try { await this.env.VECTORIZE.upsert(group.map((r, i) => ({ id: r.chunk_id, values: embs[i].values, metadata: { repo_slug: r.repo_slug, file_path: r.file_path, kind: "code" } }))); }
      catch (e) { errs += group.length; continue; }
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,model,dimensions,norm,published_at) VALUES (?,?,?,1,'code',?,?,?,?)`).bind(r.chunk_id, req.job_id, r.text.slice(0, 500), model, dims, embs[i].norm, now));
        await this.env.DB.batch(stmts); done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET completed=completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch (e) { errs += group.length; }
    }
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── HYDE shard: DeepSeek (no limit) → Embedding Pool (serialized) → Vectorize + D1 ──
export class HydeShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const obj = await this.env.ARTIFACTS.get(req.artifact_key);
    if (!obj) return { done, errors: errs };
    const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
    if (!records.length) return { done, errors: errs };

    const numQ = intEnv(this.env.HYDE_QUESTIONS, 12);
    const hydeVer = this.env.HYDE_VERSION || "v1", hydeMdl = this.env.HYDE_MODEL || "deepseek-v4-flash";
    const embedBatch = intEnv(this.env.EMBED_BATCH_SIZE, 500);
    const numSas = intEnv(this.env.NUM_SAS, 4);

    // Phase 1: DeepSeek (no rate limit, CF per-origin cap ~6 per shard)
    const collected: { record: SourceRecord; questions: string[] }[] = [];
    for (let i = 0; i < records.length; i += 6) {
      const batch = records.slice(i, i + 6);
      const outcomes = await Promise.allSettled(batch.map(async r => ({ record: r, questions: await deepseekHyde(this.env, r.text, numQ) })));
      for (const o of outcomes) { if (o.status === "fulfilled") collected.push(o.value); else errs++; }
    }
    if (!collected.length) return { done, errors: errs };

    // Phase 2: Route through EMBEDDING POOL (serialized per SA, quota-safe)
    const flat: { parentId: string; qIndex: number; text: string; record: SourceRecord }[] = [];
    for (const { record, questions } of collected) for (let i = 0; i < questions.length; i++) flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i], record });

    const embedGroups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += embedBatch) embedGroups.push(flat.slice(i, i + embedBatch));

    for (let g = 0; g < embedGroups.length; g++) {
      const group = embedGroups[g];
      const saIdx = g % numSas; // round-robin across ALL 4 SAs
      const poolStub = this.env.EMBED_POOL_DO.get(this.env.EMBED_POOL_DO.idFromName(`pool:sa${saIdx}`));
      let embs: { values: number[]; norm: number }[];
      try {
        const r = await poolStub.fetch("https://p/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sa_index: saIdx, texts: group.map(g => g.text) } satisfies EmbedReq) });
        if (!r.ok) throw new Error(`pool ${r.status}`);
        embs = await r.json() as EmbedResp;
      } catch (e) { errs += group.length; console.error("hyde: pool FAIL", (e as Error).message); continue; }

      try { await this.env.VECTORIZE.upsert(group.map((g, i) => ({ id: `${g.parentId}-h${g.qIndex}`, values: embs[i].values, metadata: { repo_slug: g.record.repo_slug, file_path: g.record.file_path, kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex } }))); }
      catch (e) { errs += group.length; continue; }
      try {
        const now = new Date().toISOString();
        const stmts = group.map((g, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,parent_chunk_id,hyde_version,hyde_model,model,dimensions,norm,published_at) VALUES (?,?,?,1,'hyde',?,?,?,?,?,?,?)`).bind(`${g.parentId}-h${g.qIndex}`, req.job_id, g.text.slice(0, 500), g.parentId, hydeVer, hydeMdl, "gemini-embedding-001", 1536, embs[i].norm, now));
        await this.env.DB.batch(stmts); done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_completed=hyde_completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch (e) { errs += group.length; }
    }
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── Orchestrator ──
export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/start" && req.method === "POST") { const cfg = await req.json() as JobConfig; await this.ctx.storage.put("config", cfg); await this.ctx.storage.setAlarm(Date.now() + 100); return json({ ok: true }); }
    return json({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<JobConfig>("config"); if (!cfg) return;
    console.log(`orch: code=${cfg.code_shards} hyde=${cfg.hyde_shards} sas=${cfg.num_sas}`);

    const codeR = await Promise.allSettled(Array.from({ length: cfg.code_shards }, (_, i) => i).map(async idx => {
      const s = this.env.CODE_DO.get(this.env.CODE_DO.idFromName(`c:${cfg.job_id}:${idx}`));
      const r = await s.fetch("https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.code_shards, sa_index: idx % cfg.num_sas, batch_size: cfg.code_batch } satisfies ShardReq) });
      if (!r.ok) throw new Error(`code ${idx}: ${r.status}`);
      return await r.json() as { done: number; errors: number };
    }));
    const cd = codeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
    const ce = codeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
    await this.env.DB.prepare(`UPDATE jobs SET code_status=?,completed=? WHERE job_id=?`).bind(ce === 0 ? "live" : "partial", cd, cfg.job_id).run();

    if (cfg.hyde) {
      const hydeR = await Promise.allSettled(Array.from({ length: cfg.hyde_shards }, (_, i) => i).map(async idx => {
        const s = this.env.HYDE_DO.get(this.env.HYDE_DO.idFromName(`h:${cfg.job_id}:${idx}`));
        const r = await s.fetch("https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.hyde_shards, sa_index: 0, batch_size: cfg.hyde_batch } satisfies ShardReq) });
        if (!r.ok) throw new Error(`hyde ${idx}: ${r.status}`);
        return await r.json() as { done: number; errors: number };
      }));
      const hd = hydeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
      const he = hydeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
      await this.env.DB.prepare(`UPDATE jobs SET hyde_status=?,hyde_completed=? WHERE job_id=?`).bind(he === 0 ? "live" : "partial", hd, cfg.job_id).run();
    }
    const allOk = ce === 0 && (!cfg.hyde || 1);
    await this.env.DB.prepare(`UPDATE jobs SET status=? WHERE job_id=?`).bind("published", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

// ── Producer ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31h" });
    if (u.pathname === "/ingest-sharded" && request.method === "POST") {
      await schema(env.DB);
      const inp = await request.json() as Record<string, unknown>;
      const jobId = String(inp.job_id || ""), ak = String(inp.artifact_key || ""), at = String(inp.artifact_text || "");
      if (!jobId || !ak || !at) return json({ ok: false, error: "missing fields" }, 400);
      const recs = parseRecords(at); if (!recs.length) return json({ ok: false, error: "no records" }, 400);
      const cs = Number(inp.code_shard_count) || intEnv(env.CODE_SHARD_COUNT, 4);
      const hs = Number(inp.hyde_shard_count) || intEnv(env.HYDE_SHARD_COUNT, 16);
      const cb = Number(inp.code_batch_size) || intEnv(env.CODE_BATCH_SIZE, 500);
      const hb = Number(inp.hyde_batch_size) || intEnv(env.HYDE_BATCH_SIZE, 500);
      const eb = Number(inp.embed_batch_size) || intEnv(env.EMBED_BATCH_SIZE, 500);
      const sas = Number(inp.num_sas) || intEnv(env.NUM_SAS, 4);
      const hyde = inp.hyde !== false;

      await env.ARTIFACTS.put(ak, at, { httpMetadata: { contentType: "application/jsonl" } });
      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,hyde_completed,code_status,hyde_status,status,created_at) VALUES (?,?,0,0,'running',?,'running',?)`).bind(jobId, recs.length, hyde ? "running" : "skipped", new Date().toISOString()).run();
      const cfg: JobConfig = { job_id: jobId, artifact_key: ak, repo_slug: String(inp.repo_slug || ""), code_shards: cs, hyde_shards: hs, code_batch: cb, hyde_batch: hb, embed_batch: eb, num_sas: sas, hyde, t_start: Date.now() };
      const s = env.ORCHESTRATOR_DO.get(env.ORCHESTRATOR_DO.idFromName(`orch:${jobId}`));
      const r = await s.fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      if (!r.ok) return json({ ok: false, error: "orch: " + r.status }, 500);
      return json({ ok: true, job_id: jobId, chunks: recs.length, status: "running", response_ms: Date.now() - cfg.t_start });
    }
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) { await schema(env.DB); const j = await env.DB.prepare("SELECT * FROM jobs WHERE job_id=?").bind(sm[1]).first(); return json({ ok: true, job: j }); }
    return json({ error: "not_found" }, 404);
  },
};
