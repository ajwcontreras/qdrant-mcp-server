// POC 28D: codebase worker with HyDE-enabled queue consumer.
// Same pipeline as 28C but exposes more endpoints (status, count) for the smoke
// to track progress against ~600 lumae chunks ingested via gateway proxy.
type R2BodyLike = { text(): Promise<string> };
type R2Like = {
  put(key: string, value: string, opts?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2BodyLike | null>;
};
type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt };
type QueueLike = { send(msg: unknown): Promise<void> };
type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = { upsert(v: VecEntry[]): Promise<unknown> };

type Env = {
  ARTIFACTS: R2Like; DB: D1Like; VECTORIZE: VecLike; WORK_QUEUE: QueueLike;
  DEEPSEEK_API_KEY: string;
  GEMINI_SERVICE_ACCOUNT_B64: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
};

type Chunk = { chunk_id: string; repo_slug: string; file_path: string; source_sha256: string; text: string };
type QMsg = { job_id: string; chunk_id: string; artifact_key: string; ordinal: number };
type IngestReq = { job_id: string; repo_slug: string; artifact_key: string; artifact_text: string };
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

let tokenCache: { token: string; expiresAt: number } | undefined;

const HYDE_SYSTEM = `You are a senior software engineer generating hypothetical questions a developer would ask to find a specific code chunk.

Given a chunk of source code, output exactly 12 short, varied questions a developer might type into a code search box to find this chunk. Questions should:

- Span symbol queries ("how is X implemented"), behavior queries ("how do we handle Y"), pattern queries ("where do we Z"), and bug-style queries ("what catches edge case W").
- Be 5-15 words each.
- NOT quote the code or use the exact identifiers as the only signal.
- Be a mix of natural-language and snake_case/camelCase styles when relevant.

Return ONLY a JSON object: {"questions": [string × 12]}`;

function parseSA(env: Env): GoogleSA {
  const a = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleSA>;
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
  if (!res.ok) throw new Error(`google token ${res.status}: ${raw.slice(0, 200)}`);
  const d = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  tokenCache = { token: d.access_token!, expiresAt: now + Math.max(60, d.expires_in || 3600) * 1000 };
  return d.access_token!;
}
async function vertexEmbed(env: Env, texts: string[]): Promise<number[][]> {
  const sa = parseSA(env);
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  const location = env.GOOGLE_LOCATION || "us-central1";
  const token = await googleToken(env);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project!)}/locations/${encodeURIComponent(location)}/publishers/google/models/gemini-embedding-001:predict`;
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: texts.map(t => ({ content: t.slice(0, 8000), task_type: "RETRIEVAL_DOCUMENT" })),
      parameters: { autoTruncate: true, outputDimensionality: 1536 },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`vertex ${res.status}: ${raw.slice(0, 300)}`);
  const d = JSON.parse(raw) as { predictions: Array<{ embeddings: { values: number[] } }> };
  return d.predictions.map(p => p.embeddings.values);
}
async function deepseekHyde(env: Env, text: string): Promise<string[]> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: HYDE_SYSTEM },
        { role: "user", content: `Source code chunk:\n\n${text}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(body.choices[0].message.content) as { questions?: string[] };
  const qs = (parsed.questions || []).filter(q => typeof q === "string" && q.length > 0);
  if (qs.length !== 12) throw new Error(`expected 12 questions, got ${qs.length}`);
  return qs;
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL,
    total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
    file_path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'code',
    parent_chunk_id TEXT, question_index INTEGER,
    source_sha256 TEXT, snippet TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, dimensions INTEGER,
    published_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_job ON chunks(job_id)`).run();
}

function parseRecords(text: string): Chunk[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as Chunk).filter(r => r.chunk_id && r.text);
}

async function ingest(env: Env, input: IngestReq): Promise<Response> {
  await schema(env.DB);
  const records = parseRecords(input.artifact_text);
  if (!records.length) return Response.json({ ok: false, error: "no records" }, { status: 400 });
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, { httpMetadata: { contentType: "application/jsonl" } });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO jobs (job_id, repo_slug, total, completed, failed, status, created_at) VALUES (?, ?, ?, 0, 0, 'queued', ?)`
  ).bind(input.job_id, input.repo_slug, records.length, new Date().toISOString()).run();
  for (let i = 0; i < records.length; i++) {
    await env.WORK_QUEUE.send({ job_id: input.job_id, chunk_id: records[i].chunk_id, artifact_key: input.artifact_key, ordinal: i } satisfies QMsg);
  }
  return Response.json({ ok: true, queued: records.length });
}

async function processChunk(env: Env, msg: QMsg) {
  await schema(env.DB);
  try {
    const artifact = await env.ARTIFACTS.get(msg.artifact_key);
    if (!artifact) throw new Error(`missing ${msg.artifact_key}`);
    const records = parseRecords(await artifact.text());
    const record = records[msg.ordinal];
    if (!record) throw new Error(`missing ordinal ${msg.ordinal}`);

    // Parallel: HyDE generation || code embedding
    const [questions, codeEmbeddings] = await Promise.all([
      deepseekHyde(env, record.text),
      vertexEmbed(env, [record.text]),
    ]);
    const codeVec = codeEmbeddings[0];
    const hydeVecs = await vertexEmbed(env, questions);

    const now = new Date().toISOString();
    const vecs: VecEntry[] = [
      { id: record.chunk_id, values: codeVec, metadata: { repo_slug: record.repo_slug, file_path: record.file_path, kind: "code" } },
      ...questions.map((_q, i) => ({
        id: `${record.chunk_id}-h${i}`, values: hydeVecs[i],
        metadata: { repo_slug: record.repo_slug, file_path: record.file_path, kind: "hyde", parent_chunk_id: record.chunk_id, question_index: i },
      })),
    ];
    await env.VECTORIZE.upsert(vecs);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO chunks (chunk_id, job_id, repo_slug, file_path, kind, parent_chunk_id, question_index, source_sha256, snippet, active, dimensions, published_at)
       VALUES (?, ?, ?, ?, 'code', NULL, NULL, ?, ?, 1, 1536, ?)`
    ).bind(record.chunk_id, msg.job_id, record.repo_slug, record.file_path, record.source_sha256, record.text.slice(0, 500), now).run();
    for (let i = 0; i < questions.length; i++) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO chunks (chunk_id, job_id, repo_slug, file_path, kind, parent_chunk_id, question_index, source_sha256, snippet, active, dimensions, published_at)
         VALUES (?, ?, ?, ?, 'hyde', ?, ?, NULL, ?, 1, 1536, ?)`
      ).bind(`${record.chunk_id}-h${i}`, msg.job_id, record.repo_slug, record.file_path, record.chunk_id, i, questions[i].slice(0, 300), now).run();
    }
    // Counter via COUNT(*) over code rows for this job (one code row = one completed chunk)
    await env.DB.prepare(
      `UPDATE jobs SET completed = (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND kind = 'code'),
       status = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE job_id = ? AND kind = 'code') >= total THEN 'published' ELSE 'publishing' END
       WHERE job_id = ?`
    ).bind(msg.job_id, msg.job_id, msg.job_id).run();
  } catch (e) {
    await env.DB.prepare(`UPDATE jobs SET failed = failed + 1 WHERE job_id = ?`).bind(msg.job_id).run();
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "28d-lumae-hyde" });
    if (url.pathname === "/ingest" && request.method === "POST") return ingest(env, await request.json() as IngestReq);
    const sm = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (sm) {
      await schema(env.DB);
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(sm[1]).first();
      if (!job) return Response.json({ ok: false, error: "not found" }, { status: 404 });
      return Response.json({ ok: true, job });
    }
    if (url.pathname === "/count") {
      await schema(env.DB);
      const total = await env.DB.prepare("SELECT COUNT(*) as c FROM chunks").first() as { c: number };
      const code = await env.DB.prepare("SELECT COUNT(*) as c FROM chunks WHERE kind='code'").first() as { c: number };
      const hyde = await env.DB.prepare("SELECT COUNT(*) as c FROM chunks WHERE kind='hyde'").first() as { c: number };
      return Response.json({ ok: true, total: total.c, code: code.c, hyde: hyde.c });
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
  async queue(batch: { messages: Array<{ body: QMsg }> }, env: Env): Promise<void> {
    for (const m of batch.messages) await processChunk(env, m.body);
  },
};
