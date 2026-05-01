// POC 31J: Three-population fan-out — separate shard populations per API provider.
// Pop1 (CodeShardDO): Vertex embed → Vectorize + D1
// Pop2 (QuestionGenDO): DeepSeek generate → D1 questions
// Pop3 (HydeEmbedDO): poll D1 → Vertex embed → Vectorize + D1
// Stitch point: D1 `hyde_questions` table. All populations stateless, properly tagged.

import { DurableObject } from "cloudflare:workers";

type R2Body = { text(): Promise<string> };
type R2Like = { put(key: string, value: string, opts?: Record<string, unknown>): Promise<unknown>; get(key: string): Promise<R2Body | null> };
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = { upsert(v: VecEntry[]): Promise<unknown> };
type DOStub = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONs = { idFromName(name: string): unknown; get(id: unknown): DOStub };

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike;
  CODE_DO: DONs; QGEN_DO: DONs; HEMB_DO: DONs; ORCH_DO: DONs;
  GEMINI_SERVICE_ACCOUNT_B64?: string; GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  GEMINI_SERVICE_ACCOUNT_B64_3?: string; GEMINI_SERVICE_ACCOUNT_B64_4?: string;
  DEEPSEEK_API_KEY?: string;
  CODE_SHARD_COUNT?: string; QGEN_SHARD_COUNT?: string; HEMB_SHARD_COUNT?: string;
  CODE_BATCH_SIZE?: string; QGEN_BATCH_SIZE?: string; HEMB_BATCH_SIZE?: string;
  NUM_SAS?: string; HYDE_QUESTIONS?: string; HYDE_MODEL?: string; HYDE_VERSION?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type JobConfig = { job_id: string; artifact_key: string; repo_slug: string; code_shards: number; qgen_shards: number; hemb_shards: number; code_batch: number; qgen_batch: number; hemb_batch: number; num_sas: number; hyde: boolean; t_start: number };
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number; sa_index: number; batch_size: number };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = parseInt(v || "", 10); return isFinite(n) ? n : d; }

async function doFetch(s: DOStub, url: string, init: RequestInit, ms = 120_000): Promise<Response> {
  return Promise.race([
    s.fetch(url, init),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("shard timeout")), ms)),
  ]);
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, hyde_completed INTEGER NOT NULL DEFAULT 0, questions_generated INTEGER NOT NULL DEFAULT 0, code_status TEXT DEFAULT 'pending', hyde_status TEXT DEFAULT 'pending', status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, snippet TEXT NOT NULL, active INTEGER DEFAULT 1, kind TEXT DEFAULT 'code', parent_chunk_id TEXT, hyde_version TEXT, hyde_model TEXT, model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hyde_questions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, chunk_id TEXT NOT NULL, q_index INTEGER NOT NULL, question TEXT NOT NULL, embedded INTEGER DEFAULT 0, created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_hq_embedded ON hyde_questions(job_id, embedded)`).run();
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord).filter(r => r.chunk_id && r.text);
}

// ── OAuth + Vertex ──
const tokenCache = new Map<string, { token: string; exp: number }>();

function parseSA(idx: number, env: Env): GoogleSA {
  let b64: string | undefined;
  if (idx === 0) b64 = env.GEMINI_SERVICE_ACCOUNT_B64; else if (idx === 1) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_2;
  else if (idx === 2) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_3; else if (idx === 3) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_4;
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
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const d = JSON.parse(await r.text()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("no token");
  tokenCache.set(sa.client_email, { token: d.access_token, exp: now + Math.max(60, d.expires_in || 3600) * 1000 });
  return d.access_token;
}

async function embed(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
  const proj = env.GOOGLE_PROJECT_ID || sa.project_id; if (!proj) throw new Error("project_id");
  const loc = env.GOOGLE_LOCATION || "us-central1", model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await saToken(sa);
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  for (let a = 0; a < 3; a++) {
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })), parameters: { autoTruncate: true, outputDimensionality: dims } }) });
    const raw = await r.text(); if (r.ok) {
      const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
      return (d.predictions || []).map(p => { const v = p.embeddings?.values as number[]; const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return { values: v, norm }; });
    }
    if (r.status >= 500 || r.status === 429) { await new Promise(r => setTimeout(r, 500 * (a + 1))); continue; }
    throw new Error(`Vertex ${r.status}`);
  }
  throw new Error("Vertex retries exhausted");
}

// ── DeepSeek ──
async function deepseek(env: Env, text: string, n: number): Promise<string[]> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DS key missing");
  const sys = `You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {"questions": ["q1", ..., "q12"]}. No prose, no markdown, no extra keys.`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }, body: JSON.stringify({ model: env.HYDE_MODEL || "deepseek-v4-flash", messages: [{ role: "system", content: sys }, { role: "user", content: text }], response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 1500 }) });
    const raw = await r.text();
    if (r.ok) {
      const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
      const c = j.choices?.[0]?.message?.content; if (!c) throw new Error("DS empty");
      const p = JSON.parse(c) as { questions?: unknown };
      return (Array.isArray(p.questions) ? p.questions : []).filter((q: unknown): q is string => typeof q === "string").slice(0, n);
    }
    console.error("DS fail", { status: r.status, body: raw.slice(0, 300) });
    if (r.status >= 500 || r.status === 429) { await new Promise(r => setTimeout(r, 300 * (a + 1))); continue; }
    throw new Error(`DS ${r.status}`);
  }
  throw new Error("DS retries exhausted");
}

// ── POPULATION 1: CodeShardDO — Vertex embed code → Vectorize + D1 ──
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
    const now = new Date().toISOString();
    for (const group of groups) {
      let embs: { values: number[]; norm: number }[];
      try { embs = await embed(this.env, sa, group.map(r => r.text)); } catch { errs += group.length; continue; }
      try { await this.env.VECTORIZE.upsert(group.map((r, i) => ({ id: r.chunk_id, values: embs[i].values, metadata: { repo_slug: r.repo_slug, file_path: r.file_path, kind: "code" } }))); } catch { errs += group.length; continue; }
      try {
        const stmts = group.map((r, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,model,dimensions,norm,published_at) VALUES (?,?,?,1,'code',?,?,?,?)`).bind(r.chunk_id, req.job_id, r.text.slice(0, 500), model, dims, embs[i].norm, now));
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

// ── POPULATION 2: QuestionGenDO — DeepSeek generate → D1 questions (no Vertex!) ──
export class QuestionGenDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    console.log("qgen start", { idx: req.shard_index, shards: req.shard_count });
    const obj = await this.env.ARTIFACTS.get(req.artifact_key);
    if (!obj) { console.log("qgen: R2 miss"); return { done, errors: errs }; }
    const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
    console.log("qgen records", { idx: req.shard_index, count: records.length });
    if (!records.length) return { done, errors: errs };
    const nQ = intEnv(this.env.HYDE_QUESTIONS, 12), nowStr = new Date().toISOString();
    // Concurrency batch: 6 at a time (CF cap)
    for (let i = 0; i < records.length; i += 6) {
      const batch = records.slice(i, i + 6);
      const outcomes = await Promise.allSettled(batch.map(async r => {
        const qs = await deepseek(this.env, r.text, nQ);
        const stmts = qs.map((q, qi) => this.env.DB.prepare(`INSERT OR REPLACE INTO hyde_questions (id,job_id,chunk_id,q_index,question,embedded,created_at) VALUES (?,?,?,?,?,0,?)`).bind(`${r.chunk_id}-q${qi}`, req.job_id, r.chunk_id, qi, q, nowStr));
        await this.env.DB.batch(stmts);
        return { record: r, qcount: qs.length };
      }));
      for (const o of outcomes) { if (o.status === "fulfilled") done += o.value.qcount; else { errs++; console.error("qgen DS fail", { idx: req.shard_index, err: (o as any).reason?.message?.slice(0, 100) }); } }
    }
    await this.env.DB.prepare(`UPDATE jobs SET questions_generated=questions_generated+? WHERE job_id=?`).bind(done, req.job_id).run();
    console.log("qgen done", { idx: req.shard_index, done, errs });
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/poll" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── POPULATION 3: HydeEmbedDO — poll D1 questions → Vertex embed → Vectorize + D1 ──
export class HydeEmbedDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<{ done: number; errors: number }> {
    let done = 0, errs = 0;
    const sa = parseSA(req.sa_index, this.env);
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
    const hydeVer = this.env.HYDE_VERSION || "v1", hydeMdl = this.env.HYDE_MODEL || "deepseek-v4-flash";
    const nowStr = new Date().toISOString();
    // Poll loop: grab unembedded questions in batches
    while (true) {
      const rows = (await this.env.DB.prepare(`SELECT id,chunk_id,q_index,question FROM hyde_questions WHERE job_id=? AND embedded=0 AND q_index % ? = ? LIMIT ?`).bind(req.job_id, req.shard_count, req.shard_index, req.batch_size).all()).results || [];
      if (!rows.length) {
        // Check if qgen is done producing. If so, exit. If not, backoff and retry.
        const j = await this.env.DB.prepare(`SELECT total,questions_generated FROM jobs WHERE job_id=?`).bind(req.job_id).first<{ total: number; questions_generated: number }>();
        if (!j) break;
        const expected = j.total * intEnv(this.env.HYDE_QUESTIONS, 12);
        if (j.questions_generated >= expected) break; // all done
        await new Promise(r => setTimeout(r, 2000)); // backoff and retry
        continue;
      }
      const texts = rows.map((r: any) => r.question as string);
      let embs: { values: number[]; norm: number }[];
      try { embs = await embed(this.env, sa, texts); } catch { errs += texts.length; continue; }
      try {
        await this.env.VECTORIZE.upsert(rows.map((r: any, i) => ({ id: `${r.chunk_id}-h${r.q_index}`, values: embs[i].values, metadata: { kind: "hyde", parent_chunk_id: r.chunk_id, hyde_index: r.q_index } })));
      } catch { errs += texts.length; continue; }
      try {
        const stmts: D1Stmt[] = [];
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] as any;
          stmts.push(this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,snippet,active,kind,parent_chunk_id,hyde_version,hyde_model,model,dimensions,norm,published_at) VALUES (?,?,?,1,'hyde',?,?,?,?,?,?,?)`).bind(`${r.chunk_id}-h${r.q_index}`, req.job_id, r.question.slice(0, 500), r.chunk_id, hydeVer, hydeMdl, model, dims, embs[i].norm, nowStr));
          stmts.push(this.env.DB.prepare(`UPDATE hyde_questions SET embedded=1 WHERE id=?`).bind(r.id));
        }
        await this.env.DB.batch(stmts); done += rows.length;
        await this.env.DB.prepare(`UPDATE jobs SET hyde_completed=hyde_completed+? WHERE job_id=?`).bind(rows.length, req.job_id).run();
      } catch { errs += rows.length; }
    }
    return { done, errors: errs };
  }
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── Orchestrator: fires all 3 populations ──
export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/start" && req.method === "POST") { await this.ctx.storage.put("config", await req.json() as JobConfig); await this.ctx.storage.setAlarm(Date.now() + 100); return json({ ok: true }); }
    return json({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<JobConfig>("config"); if (!cfg) return;
    console.log("orch: 3-pop fan-out", { code: cfg.code_shards, qgen: cfg.qgen_shards, hemb: cfg.hemb_shards });
    const codeReq = (idx: number): ShardReq => ({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.code_shards, sa_index: idx % cfg.num_sas, batch_size: cfg.code_batch });
    const qgenReq = (idx: number): ShardReq => ({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.qgen_shards, sa_index: 0, batch_size: 0 });
    const hembReq = (idx: number): ShardReq => ({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.hemb_shards, sa_index: idx % cfg.num_sas, batch_size: cfg.hemb_batch });

    // Fire ALL THREE populations immediately. HEMB polls D1 for questions.
    const [codeR, qgenR, hembR] = await Promise.all([
      Promise.allSettled(Array.from({ length: cfg.code_shards }, (_, i) => i).map(async idx => {
        const r = await doFetch(this.env.CODE_DO.get(this.env.CODE_DO.idFromName(`c:${cfg.job_id}:${idx}`)), "https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(codeReq(idx)) });
        if (!r.ok) { console.error(`orch: code ${idx} fail ${r.status}`); throw new Error(`code ${idx}`); }
        const v = await r.json() as { done: number; errors: number };
        console.log(`orch: code ${idx} done=${v.done} errs=${v.errors}`);
        return v;
      })),
      Promise.allSettled(Array.from({ length: cfg.qgen_shards }, (_, i) => i).map(async idx => {
        const r = await doFetch(this.env.QGEN_DO.get(this.env.QGEN_DO.idFromName(`q:${cfg.job_id}:${idx}`)), "https://s/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(qgenReq(idx)) });
        if (!r.ok) { console.error(`orch: qgen ${idx} fail ${r.status}`); throw new Error(`qgen ${idx}`); }
        const v = await r.json() as { done: number; errors: number };
        console.log(`orch: qgen ${idx} done=${v.done} errs=${v.errors}`);
        return v;
      })),
      Promise.allSettled(Array.from({ length: cfg.hemb_shards }, (_, i) => i).map(async idx => {
        const r = await doFetch(this.env.HEMB_DO.get(this.env.HEMB_DO.idFromName(`e:${cfg.job_id}:${idx}`)), "https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hembReq(idx)) });
        if (!r.ok) { console.error(`orch: hemb ${idx} fail ${r.status}`); throw new Error(`hemb ${idx}`); }
        const v = await r.json() as { done: number; errors: number };
        console.log(`orch: hemb ${idx} done=${v.done} errs=${v.errors}`);
        return v;
      })),
    ]);

    const cd = codeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
    const ce = codeR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
    await this.env.DB.prepare(`UPDATE jobs SET code_status=?,completed=? WHERE job_id=?`).bind(ce === 0 ? "live" : "partial", cd, cfg.job_id).run();

    const hd = hembR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.done : 0), 0);
    const he = hembR.reduce((s, o) => s + (o.status === "fulfilled" ? o.value.errors : 1), 0);
    await this.env.DB.prepare(`UPDATE jobs SET hyde_status=?,hyde_completed=? WHERE job_id=?`).bind(he === 0 ? "live" : "partial", hd, cfg.job_id).run();

    console.log("orch: done", { code: cd, codeErrs: ce, hyde: hd, hydeErrs: he });
    await this.env.DB.prepare(`UPDATE jobs SET status=? WHERE job_id=?`).bind("published", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

// ── Producer ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31j" });
    if (u.pathname === "/ingest-sharded" && request.method === "POST") {
      await schema(env.DB);
      const inp = await request.json() as Record<string, unknown>;
      const jobId = String(inp.job_id || ""), ak = String(inp.artifact_key || ""), at = String(inp.artifact_text || "");
      if (!jobId || !ak || !at) return json({ ok: false, error: "missing fields" }, 400);
      const recs = parseRecords(at); if (!recs.length) return json({ ok: false, error: "no records" }, 400);
      const cs = Number(inp.code_shard_count) || intEnv(env.CODE_SHARD_COUNT, 4);
      const qs = Number(inp.qgen_shard_count) || intEnv(env.QGEN_SHARD_COUNT, 32);
      const es = Number(inp.hemb_shard_count) || intEnv(env.HEMB_SHARD_COUNT, 8);
      const cb = Number(inp.code_batch_size) || intEnv(env.CODE_BATCH_SIZE, 500);
      const eb = Number(inp.hemb_batch_size) || intEnv(env.HEMB_BATCH_SIZE, 500);
      const sas = Number(inp.num_sas) || intEnv(env.NUM_SAS, 2);
      const hyde = inp.hyde !== false;
      await env.ARTIFACTS.put(ak, at, { httpMetadata: { contentType: "application/jsonl" } });
      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,hyde_completed,questions_generated,code_status,hyde_status,status,created_at) VALUES (?,?,0,0,0,'running',?,'running',?)`).bind(jobId, recs.length, hyde ? "running" : "skipped", new Date().toISOString()).run();
      const cfg: JobConfig = { job_id: jobId, artifact_key: ak, repo_slug: String(inp.repo_slug || ""), code_shards: cs, qgen_shards: qs, hemb_shards: es, code_batch: cb, qgen_batch: 0, hemb_batch: eb, num_sas: sas, hyde, t_start: Date.now() };
      const s = env.ORCH_DO.get(env.ORCH_DO.idFromName(`orch:${jobId}`));
      const r = await s.fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      if (!r.ok) return json({ ok: false, error: "orch: " + r.status }, 500);
      return json({ ok: true, job_id: jobId, chunks: recs.length, status: "running", response_ms: Date.now() - cfg.t_start });
    }
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) { await schema(env.DB); const j = await env.DB.prepare("SELECT * FROM jobs WHERE job_id=?").bind(sm[1]).first(); return json({ ok: true, job: j }); }
    return json({ error: "not_found" }, 404);
  },
};
