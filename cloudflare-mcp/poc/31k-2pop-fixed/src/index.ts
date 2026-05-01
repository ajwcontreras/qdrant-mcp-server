// POC 31K: Proven 30C dual-fanout (CodeShardDO + HydeShardDO) + all Phase 31 fixes.
// Fixes applied: atob, fire-and-forget alarm, R2-pull, DS batching, DO timeouts.

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
  CODE_DO: DONs; HYDE_DO: DONs; ORCH_DO: DONs;
  GEMINI_SERVICE_ACCOUNT_B64?: string; GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  GEMINI_SERVICE_ACCOUNT_B64_3?: string; GEMINI_SERVICE_ACCOUNT_B64_4?: string;
  DEEPSEEK_API_KEY?: string;
  CODE_SHARD_COUNT?: string; HYDE_SHARD_COUNT?: string;
  CODE_BATCH_SIZE?: string; HYDE_BATCH_SIZE?: string;
  NUM_SAS?: string; HYDE_QUESTIONS?: string; HYDE_MODEL?: string; HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type JobConfig = { job_id: string; artifact_key: string; repo_slug: string; code_shards: number; hyde_shards: number; code_batch: number; hyde_batch: number; num_sas: number; hyde: boolean; t_start: number };
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number; sa_index: number; batch_size: number };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = parseInt(v || "", 10); return isFinite(n) ? n : d; }

async function doFetch(s: DOStub, url: string, init: RequestInit, ms = 120_000): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shard timeout")), ms);
    s.fetch(url, init).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0, code_status TEXT DEFAULT 'pending', hyde_status TEXT DEFAULT 'pending', status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, snippet TEXT NOT NULL, active INTEGER DEFAULT 1, kind TEXT DEFAULT 'code', parent_chunk_id TEXT, hyde_version TEXT, hyde_model TEXT, model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL)`).run();
}

function parseRecords(text: string): SourceRecord[] { return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord).filter(r => r.chunk_id && r.text); }

// ── OAuth + Vertex (atob fix applied) ──
const tokenCache = new Map<string, { token: string; exp: number }>();

function parseSA(idx: number, env: Env): GoogleSA {
  const keys = [env.GEMINI_SERVICE_ACCOUNT_B64, env.GEMINI_SERVICE_ACCOUNT_B64_2, env.GEMINI_SERVICE_ACCOUNT_B64_3, env.GEMINI_SERVICE_ACCOUNT_B64_4];
  const b64 = keys[idx];
  if (!b64) throw new Error(`SA ${idx} missing`);
  const a = JSON.parse(atob(b64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid SA");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const b64u = (v: string | ArrayBuffer) => { const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v); let b = ""; for (const x of bytes) b += String.fromCharCode(x); return btoa(b).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(pem); const kb = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i); // <-- ATOB FIX
  const key = await crypto.subtle.importKey("pkcs8", kb.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

async function saToken(sa: GoogleSA): Promise<string> {
  const now = Date.now(), c = tokenCache.get(sa.client_email);
  if (c && c.exp - 60_000 > now) return c.token;
  const iat = Math.floor(now / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const d = JSON.parse(await r.text()) as { access_token?: string };
  if (!d.access_token) throw new Error("no token");
  tokenCache.set(sa.client_email, { token: d.access_token, exp: now + Math.max(60, (d as any).expires_in || 3600) * 1000 });
  return d.access_token;
}

async function embed(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
  const proj = env.GOOGLE_PROJECT_ID || sa.project_id; if (!proj) throw new Error("project_id required");
  const loc = env.GOOGLE_LOCATION || "us-central1", model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await saToken(sa);
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  for (let a = 0; a < 3; a++) {
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })), parameters: { autoTruncate: true, outputDimensionality: dims } }) });
    const raw = await r.text(); if (r.ok) {
      const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
      return (d.predictions || []).map(p => { const v = p.embeddings?.values as number[]; return { values: v, norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)) }; });
    }
    if (r.status >= 500 || r.status === 429) { await new Promise(r => setTimeout(r, 500 * (a + 1))); continue; }
    throw new Error(`Vertex ${r.status}`);
  }
  throw new Error("Vertex retries exhausted");
}

// ── DeepSeek ──
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

// ── CODE shard: R2-pull → Vertex embed → Vectorize + D1 ──
export class CodeShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const obj = await this.env.ARTIFACTS.get(req.artifact_key); if (!obj) return { done, errors: errs };
    const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
    if (!records.length) return { done, errors: errs };
    const sa = parseSA(req.sa_index, this.env);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const groups: SourceRecord[][] = [];
    for (let i = 0; i < records.length; i += req.batch_size) groups.push(records.slice(i, i + req.batch_size));
    const nowStr = new Date().toISOString();
    for (const group of groups) {
      let embs: { values: number[]; norm: number }[];
      try { embs = await embed(this.env, sa, group.map(r => r.text)); } catch { errs += group.length; continue; }
      try { await this.env.VECTORIZE.upsert(group.map((r, i) => ({ id: r.chunk_id, values: embs[i].values, metadata: { kind: "code" } }))); } catch { errs += group.length; continue; }
      try {
        const stmts = group.map((r, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,model,dimensions,norm,published_at) VALUES (?,?,?,1,'code',?,?,?,?)`).bind(r.chunk_id, req.job_id, r.text.slice(0, 500), model, dims, embs[i].norm, nowStr));
        await this.env.DB.batch(stmts); done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET completed=completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch { errs += group.length; }
    }
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── HYDE shard: R2-pull → DeepSeek → Vertex embed → Vectorize + D1 ──
export class HydeShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const obj = await this.env.ARTIFACTS.get(req.artifact_key); if (!obj) return { done, errors: errs };
    const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
    if (!records.length) return { done, errors: errs };
    const sa = parseSA(req.sa_index, this.env);
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

    const flat: { parentId: string; qIndex: number; text: string; record: SourceRecord }[] = [];
    for (const { record, questions } of collected) for (let i = 0; i < questions.length; i++) flat.push({ parentId: record.chunk_id, qIndex: i, text: questions[i], record });
    const groups: typeof flat[] = [];
    for (let i = 0; i < flat.length; i += req.batch_size) groups.push(flat.slice(i, i + req.batch_size));

    for (const group of groups) {
      let embs: { values: number[]; norm: number }[];
      try { embs = await embed(this.env, sa, group.map(g => g.text)); } catch { errs += group.length; continue; }
      try { await this.env.VECTORIZE.upsert(group.map((g, i) => ({ id: `${g.parentId}-h${g.qIndex}`, values: embs[i].values, metadata: { kind: "hyde", parent_chunk_id: g.parentId, hyde_index: g.qIndex } }))); } catch { errs += group.length; continue; }
      try {
        const stmts = group.map((g, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,parent_chunk_id,hyde_version,hyde_model,model,dimensions,norm,published_at) VALUES (?,?,?,1,'hyde',?,?,?,?,?,?,?)`).bind(`${g.parentId}-h${g.qIndex}`, req.job_id, g.text.slice(0, 500), g.parentId, hydeVer, hydeMdl, model, dims, embs[i].norm, nowStr));
        await this.env.DB.batch(stmts); done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_completed=hyde_completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch { errs += group.length; }
    }
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── Orchestrator: fire both populations, alarm-driven ──
export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/start" && req.method === "POST") { await this.ctx.storage.put("config", await req.json() as JobConfig); await this.ctx.storage.setAlarm(Date.now() + 100); return json({ ok: true }); }
    return json({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<JobConfig>("config"); if (!cfg) return;
    const codeReq = (i: number): ShardReq => ({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: i, shard_count: cfg.code_shards, sa_index: i % cfg.num_sas, batch_size: cfg.code_batch });
    const hydeReq = (i: number): ShardReq => ({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: i, shard_count: cfg.hyde_shards, sa_index: i % cfg.num_sas, batch_size: cfg.hyde_batch });

    const [codeR, hydeR] = await Promise.all([
      Promise.allSettled(Array.from({ length: cfg.code_shards }, (_, i) => i).map(async idx => {
        const r = await doFetch(this.env.CODE_DO.get(this.env.CODE_DO.idFromName(`c:${cfg.job_id}:${idx}`)), "https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(codeReq(idx)) });
        if (!r.ok) throw new Error(`code ${idx}: ${r.status}`);
        return await r.json() as { done: number; errors: number };
      })),
      Promise.allSettled(Array.from({ length: cfg.hyde_shards }, (_, i) => i).map(async idx => {
        const r = await doFetch(this.env.HYDE_DO.get(this.env.HYDE_DO.idFromName(`h:${cfg.job_id}:${idx}`)), "https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hydeReq(idx)) });
        if (!r.ok) throw new Error(`hyde ${idx}: ${r.status}`);
        return await r.json() as { done: number; errors: number };
      })),
    ]);

    const cd = codeR.reduce((s: number, o: any) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
    const ce = codeR.reduce((s: number, o: any) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
    await this.env.DB.prepare(`UPDATE jobs SET code_status=?,completed=? WHERE job_id=?`).bind(ce === 0 ? "live" : "partial", cd, cfg.job_id).run();

    const hd = hydeR.reduce((s: number, o: any) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
    const he = hydeR.reduce((s: number, o: any) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
    await this.env.DB.prepare(`UPDATE jobs SET hyde_status=?,hyde_completed=? WHERE job_id=?`).bind(he === 0 ? "live" : "partial", hd, cfg.job_id).run();

    const allOk = ce === 0 && he === 0;
    await this.env.DB.prepare(`UPDATE jobs SET status=? WHERE job_id=?`).bind(allOk ? "published" : "partial", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

// ── Producer ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31k" });
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
      const sas = Number(inp.num_sas) || intEnv(env.NUM_SAS, 2);
      const hyde = inp.hyde !== false;
      await env.ARTIFACTS.put(ak, at, { httpMetadata: { contentType: "application/jsonl" } });
      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,hyde_completed,code_status,hyde_status,status,created_at) VALUES (?,?,0,0,'running',?,'running',?)`).bind(jobId, recs.length, hyde ? "running" : "skipped", new Date().toISOString()).run();
      const cfg: JobConfig = { job_id: jobId, artifact_key: ak, repo_slug: String(inp.repo_slug || ""), code_shards: cs, hyde_shards: hs, code_batch: cb, hyde_batch: hb, num_sas: sas, hyde, t_start: Date.now() };
      const r = await env.ORCH_DO.get(env.ORCH_DO.idFromName(`orch:${jobId}`)).fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      if (!r.ok) return json({ ok: false, error: "orch: " + r.status }, 500);
      return json({ ok: true, job_id: jobId, chunks: recs.length, status: "running", response_ms: Date.now() - cfg.t_start });
    }
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) { await schema(env.DB); const j = await env.DB.prepare("SELECT * FROM jobs WHERE job_id=?").bind(sm[1]).first(); return json({ ok: true, job: j }); }
    if (u.pathname === "/hyde-enrich" && request.method === "POST") {
      await schema(env.DB);
      const inp = await request.json() as Record<string, unknown>;
      const jobId = String(inp.job_id || ""), ak = String(inp.artifact_key || "");
      if (!jobId || !ak) return json({ ok: false, error: "missing job_id/artifact_key" }, 400);
      // Find code chunks that lack hyde entries
      const missing = (await (env.DB.prepare(`SELECT DISTINCT c.chunk_id, c.snippet FROM chunks c WHERE c.job_id=? AND c.kind='code' AND c.chunk_id NOT IN (SELECT DISTINCT parent_chunk_id FROM chunks WHERE job_id=? AND kind='hyde') LIMIT 500`).bind(jobId, jobId) as any).all()).results || [];
      if (!missing.length) return json({ ok: true, enriched: 0, message: "nothing to enrich" });
      const sas = intEnv(env.NUM_SAS, 2);
      const hb = intEnv(env.HYDE_BATCH_SIZE, 500);
      const hs = intEnv(env.HYDE_SHARD_COUNT, 16);
      const records = missing.map((r: any) => ({ chunk_id: r.chunk_id as string, text: r.snippet as string }));
      const buckets: { chunk_id: string; text: string }[][] = Array.from({ length: hs }, () => []);
      records.forEach((r: any, i: number) => buckets[i % hs].push(r));
      const enrichOutcomes = await Promise.allSettled(buckets.map((bucket, idx) => {
        if (!bucket.length) return Promise.resolve({ done: 0, errors: 0 });
        const stub = env.HYDE_DO.get(env.HYDE_DO.idFromName(`h:enrich-${jobId}:${idx}`));
        return doFetch(stub, "https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, artifact_key: ak, shard_index: idx, shard_count: hs, sa_index: idx % sas, batch_size: hb } satisfies ShardReq) }, 300_000).then(r => r.json() as Promise<{ done: number; errors: number }>);
      }));
      let enriched = 0, errs = 0;
      for (const o of enrichOutcomes) { if (o.status === "fulfilled") { enriched += o.value.done; errs += o.value.errors; } else errs++; }
      return json({ ok: true, scanned: records.length, enriched, errors: errs });
    }
    return json({ error: "not_found" }, 404);
  },
};
