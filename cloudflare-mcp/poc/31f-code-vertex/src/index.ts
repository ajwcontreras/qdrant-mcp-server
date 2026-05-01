// POC 31F: Code-only Vertex + Vectorize + D1 on alarm fan-out + R2-pull.
// Proves: Vertex embedding inside shard DO works with the alarm fan-out pattern.

import { DurableObject } from "cloudflare:workers";

type R2Body = { text(): Promise<string> };
type R2Like = { put(key: string, value: string, opts?: Record<string, unknown>): Promise<unknown>; get(key: string): Promise<R2Body | null> };
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null>; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type D1Like = { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = { upsert(v: VecEntry[]): Promise<unknown> };
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DOStubLike };

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike;
  SHARD_DO: DONamespaceLike; ORCHESTRATOR_DO: DONamespaceLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string; GEMINI_SERVICE_ACCOUNT_B64_2?: string;
  SHARD_COUNT?: string; BATCH_SIZE?: string; NUM_SAS?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type SourceRecord = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type JobConfig = { job_id: string; artifact_key: string; repo_slug: string; shard_count: number; batch_size: number; num_sas: number; t_start: number };
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number; sa_index: number; batch_size: number };
type ShardResult = { shard_index: number; done: number; calls: number; errors: number; vertex_ms: number; vectorize_ms: number; d1_ms: number; wall_ms: number };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function intEnv(v: string | undefined, d: number) { const n = parseInt(v || "", 10); return isFinite(n) ? n : d; }

function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...init, signal: c.signal }).then(r => { clearTimeout(t); return r; }, e => { clearTimeout(t); throw e; });
}

function parseRecords(text: string): SourceRecord[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as SourceRecord).filter(r => r.chunk_id && r.text && r.repo_slug && r.file_path);
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, code_status TEXT DEFAULT 'pending', status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL, file_path TEXT NOT NULL, snippet TEXT NOT NULL, active INTEGER DEFAULT 1, kind TEXT DEFAULT 'code', model TEXT, dimensions INTEGER, norm REAL, published_at TEXT NOT NULL)`).run();
}

// ── OAuth + Vertex ──
const tokenCache = new Map<string, { token: string; exp: number }>();

function parseSA(idx: number, env: Env): GoogleSA {
  let b64: string | undefined;
  if (idx === 0) b64 = env.GEMINI_SERVICE_ACCOUNT_B64; else if (idx === 1) b64 = env.GEMINI_SERVICE_ACCOUNT_B64_2;
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

async function embedBatch(env: Env, sa: GoogleSA, texts: string[]): Promise<{ values: number[]; norm: number }[]> {
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
    const v = p.embeddings?.values; if (!Array.isArray(v) || !v.every(x => typeof x === "number")) throw new Error("bad response");
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
    return { values: v as number[], norm };
  });
}

// ── Code shard ──
export class ShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<ShardResult> {
    const t0 = Date.now();
    console.log("shard process start", { idx: req.shard_index, sa: req.sa_index });
    const result: ShardResult = { shard_index: req.shard_index, done: 0, calls: 0, errors: 0, vertex_ms: 0, vectorize_ms: 0, d1_ms: 0, wall_ms: 0 };

    const obj = await this.env.ARTIFACTS.get(req.artifact_key);
    if (!obj) { console.log("shard: R2 miss", { key: req.artifact_key }); return result; }
    const text = await obj.text();
    console.log("shard: R2 read", { idx: req.shard_index, bytes: text.length });
    const records = parseRecords(text).filter((_, i) => i % req.shard_count === req.shard_index);
    console.log("shard: filtered records", { idx: req.shard_index, count: records.length });
    if (!records.length) { result.wall_ms = Date.now() - t0; return result; }

    let sa: GoogleSA;
    try { sa = parseSA(req.sa_index, this.env); console.log("shard: SA parsed", { idx: req.shard_index, email: sa.client_email }); }
    catch (e: any) { console.error("shard: SA FAILED", { idx: req.shard_index, si: req.sa_index, err: e.message }); throw e; }
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = intEnv(this.env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);

    const groups: SourceRecord[][] = [];
    for (let i = 0; i < records.length; i += req.batch_size) groups.push(records.slice(i, i + req.batch_size));

    for (const group of groups) {
      const tV = Date.now();
      let embs: { values: number[]; norm: number }[];
      try { embs = await embedBatch(this.env, sa, group.map(r => r.text)); result.calls++; result.vertex_ms += Date.now() - tV; console.log("shard: vertex done", { idx: req.shard_index, vecs: embs.length }); }
      catch (e) { result.errors += group.length; console.error("shard: vertex FAILED", { idx: req.shard_index, err: (e as Error).message || String(e) }); continue; }

      const tVec = Date.now();
      try {
        await this.env.VECTORIZE.upsert(group.map((r, i) => ({ id: r.chunk_id, values: embs[i].values, metadata: { repo_slug: r.repo_slug, file_path: r.file_path, kind: "code" } })));
        result.vectorize_ms += Date.now() - tVec;
      } catch (e) { result.errors += group.length; continue; }

      const tD = Date.now();
      try {
        const now = new Date().toISOString();
        const stmts = group.map((r, i) => this.env.DB.prepare(`INSERT OR REPLACE INTO chunks (chunk_id,job_id,repo_slug,file_path,snippet,active,kind,model,dimensions,norm,published_at) VALUES (?,?,?,?,?,1,'code',?,?,?,?)`).bind(r.chunk_id, req.job_id, r.repo_slug, r.file_path, r.text.slice(0, 500), model, dims, embs[i].norm, now));
        await this.env.DB.batch(stmts);
        result.d1_ms += Date.now() - tD; result.done += group.length;
        await this.env.DB.prepare(`UPDATE jobs SET completed=completed+? WHERE job_id=?`).bind(group.length, req.job_id).run();
      } catch (e) { result.errors += group.length; }
    }
    result.wall_ms = Date.now() - t0;
    return result;
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

// ── Orchestrator ──
export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/start" && req.method === "POST") {
      const cfg = await req.json() as JobConfig;
      await this.ctx.storage.put("config", cfg);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<JobConfig>("config");
    if (!cfg) return;
    console.log("orch: fan-out", { shards: cfg.shard_count, batch: cfg.batch_size });

    const outcomes = await Promise.allSettled(Array.from({ length: cfg.shard_count }, (_, idx) => idx).map(async idx => {
      const stub = this.env.SHARD_DO.get(this.env.SHARD_DO.idFromName(`cs:${cfg.job_id}:${idx}`));
      const r = await stub.fetch("https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.shard_count, sa_index: idx % cfg.num_sas, batch_size: cfg.batch_size } satisfies ShardReq) });
      if (!r.ok) { const bad = await r.text().catch(() => ""); console.log(`orch: shard ${idx} FAILED st=${r.status} body=${bad.slice(0, 200)}`); throw new Error(`shard ${idx}: ${r.status}`); }
      return await r.json() as ShardResult;
    }));

    let done = 0, errs = 0;
    for (const o of outcomes) {
      if (o.status === "fulfilled") { done += o.value.done; errs += o.value.errors; } else errs += 1;
    }
    console.log("orch: done", { done, errs, total: cfg.job_id });
    await this.env.DB.prepare(`UPDATE jobs SET code_status=?,status=? WHERE job_id=?`).bind(errs === 0 ? "live" : "partial", errs === 0 ? "published" : "partial", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

// ── Producer ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31f" });
    if (u.pathname === "/ingest-sharded" && request.method === "POST") {
      await schema(env.DB);
      const inp = await request.json() as Record<string, unknown>;
      const jobId = String(inp.job_id || ""), repo = String(inp.repo_slug || ""), artifactKey = String(inp.artifact_key || ""), artifactText = String(inp.artifact_text || "");
      if (!jobId || !artifactKey || !artifactText) return json({ ok: false, error: "missing fields" }, 400);
      const records = parseRecords(artifactText);
      if (!records.length) return json({ ok: false, error: "no records" }, 400);

      const shards = Number(inp.code_shard_count) || intEnv(env.SHARD_COUNT, 4);
      const batch = Number(inp.code_batch_size) || intEnv(env.BATCH_SIZE, 500);
      const sas = Number(inp.num_sas) || intEnv(env.NUM_SAS, 2);

      await env.ARTIFACTS.put(artifactKey, artifactText, { httpMetadata: { contentType: "application/jsonl" } });
      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,code_status,status,created_at) VALUES (?,?,0,'running','running',?)`).bind(jobId, records.length, new Date().toISOString()).run();

      const cfg: JobConfig = { job_id: jobId, artifact_key: artifactKey, repo_slug: repo, shard_count: shards, batch_size: batch, num_sas: sas, t_start: Date.now() };
      const stub = env.ORCHESTRATOR_DO.get(env.ORCHESTRATOR_DO.idFromName(`orch:${jobId}`));
      const r = await stub.fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
      if (!r.ok) return json({ ok: false, error: "orch: " + r.status }, 500);

      return json({ ok: true, job_id: jobId, chunks: records.length, status: "running", response_ms: Date.now() - cfg.t_start });
    }
    const sm = u.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) { await schema(env.DB); const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id=?").bind(sm[1]).first(); return json({ ok: true, job }); }
    return json({ error: "not_found" }, 404);
  },
};
