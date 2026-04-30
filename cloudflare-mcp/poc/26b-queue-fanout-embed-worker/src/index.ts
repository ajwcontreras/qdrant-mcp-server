type R2ObjectBodyLike = { text(): Promise<string> };
type R2ObjectLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ results?: unknown[] }>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
};

type D1Like = {
  prepare(sql: string): D1StatementLike;
};

type QueueLike = {
  send(message: QueueMessageBody): Promise<void>;
};

type Env = {
  ARTIFACTS: R2Like;
  DB: D1Like;
  EMBED_QUEUE: QueueLike;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
  GOOGLE_EMBEDDING_TASK_TYPE?: string;
};

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
};

type QueueMessageBody = {
  job_id: string;
  artifact_key: string;
  ordinal: number;
};

type StartRequest = {
  repo_slug?: string;
  indexed_path?: string;
  artifact_key?: string;
  artifact_text?: string;
};

type SourceRecord = {
  path: string;
  sha256: string;
  bytes: number;
  text: string;
};

let tokenCache: { token: string; expiresAt: number } | undefined;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function schema(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      indexed_path TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      total INTEGER NOT NULL,
      queued INTEGER NOT NULL DEFAULT 0,
      processing INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS embedding_results (
      job_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      path TEXT NOT NULL,
      result_key TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      norm REAL NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, ordinal)
    )
  `).run();
}

function parseRecords(artifactText: string): SourceRecord[] {
  return artifactText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceRecord)
    .filter((record) => record.path && record.sha256 && typeof record.text === "string");
}

async function start(env: Env, input: StartRequest): Promise<Response> {
  await schema(env);
  if (!input.repo_slug || !input.indexed_path || !input.artifact_key || !input.artifact_text) {
    return json({ ok: false, error: "repo_slug, indexed_path, artifact_key, and artifact_text are required" }, 400);
  }
  const records = parseRecords(input.artifact_text);
  if (records.length === 0) return json({ ok: false, error: "artifact_text had no records" }, 400);

  const jobId = crypto.randomUUID();
  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: { repo_slug: input.repo_slug, job_id: jobId, file_count: String(records.length) },
  });
  await env.DB.prepare(`
    INSERT INTO jobs (job_id, repo_slug, indexed_path, artifact_key, total, queued, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(jobId, input.repo_slug, input.indexed_path, input.artifact_key, records.length, records.length, "queued", new Date().toISOString()).run();
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    await env.EMBED_QUEUE.send({ job_id: jobId, artifact_key: input.artifact_key, ordinal });
  }
  return json({ ok: true, job_id: jobId, status: "queued", queued: records.length, artifact_key: input.artifact_key });
}

async function status(env: Env, jobId: string): Promise<Response> {
  await schema(env);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "job not found" }, 404);
  const results = await env.DB.prepare("SELECT * FROM embedding_results WHERE job_id = ? ORDER BY ordinal").bind(jobId).all();
  return json({ ok: true, job, results: results.results || [] });
}

async function artifactHead(env: Env, key: string): Promise<Response> {
  const object = await env.ARTIFACTS.head(key);
  return json({ ok: true, key, exists: Boolean(object), size: object?.size || 0, metadata: object?.customMetadata || {} });
}

function parseServiceAccount(env: Env): GoogleServiceAccount {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) throw new Error("GEMINI_SERVICE_ACCOUNT_B64 secret is required");
  const account = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleServiceAccount>;
  if (!account.client_email || !account.private_key) throw new Error("GEMINI_SERVICE_ACCOUNT_B64 did not decode to a service account");
  return {
    client_email: account.client_email,
    private_key: account.private_key,
    project_id: account.project_id,
    token_uri: account.token_uri,
  };
}

async function googleAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  const account = parseServiceAccount(env);
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 3600;
  const assertion = await signJwt(account, {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: expiresAt,
  });
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Google token request failed ${response.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token response did not include access_token");
  tokenCache = { token: data.access_token, expiresAt: now + Math.max(60, data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function signJwt(account: GoogleServiceAccount, claims: Record<string, string | number>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function embed(env: Env, content: string): Promise<number[]> {
  const account = parseServiceAccount(env);
  const project = env.GOOGLE_PROJECT_ID || account.project_id;
  if (!project) throw new Error("GOOGLE_PROJECT_ID or service account project_id is required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dimensions = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const taskType = env.GOOGLE_EMBEDDING_TASK_TYPE || "RETRIEVAL_DOCUMENT";
  const token = await googleAccessToken(env);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ instances: [{ content, task_type: taskType }], parameters: { autoTruncate: true, outputDimensionality: dimensions } }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Vertex embedding request failed ${response.status}: ${raw.slice(0, 500)}`);
  const data = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = data.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) throw new Error("Vertex response did not include numeric embedding values");
  return values;
}

async function processMessage(env: Env, message: QueueMessageBody) {
  await schema(env);
  await env.DB.prepare("UPDATE jobs SET processing = processing + 1 WHERE job_id = ?").bind(message.job_id).run();
  try {
    const artifact = await env.ARTIFACTS.get(message.artifact_key);
    if (!artifact) throw new Error(`missing artifact ${message.artifact_key}`);
    const records = parseRecords(await artifact.text());
    const record = records[message.ordinal];
    if (!record) throw new Error(`missing record ordinal ${message.ordinal}`);
    const values = await embed(env, record.text.slice(0, 8000));
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    const resultKey = `embeddings/${message.job_id}/${message.ordinal}-${record.sha256.slice(0, 12)}.json`;
    await env.ARTIFACTS.put(resultKey, JSON.stringify({
      job_id: message.job_id,
      ordinal: message.ordinal,
      path: record.path,
      source_sha256: record.sha256,
      model: env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001",
      dimensions: values.length,
      norm,
      sample: values.slice(0, 8),
    }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { job_id: message.job_id, ordinal: String(message.ordinal), path: record.path },
    });
    await env.DB.prepare(`
      INSERT OR REPLACE INTO embedding_results (job_id, ordinal, path, result_key, dimensions, norm, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(message.job_id, message.ordinal, record.path, resultKey, values.length, norm, new Date().toISOString()).run();
    await env.DB.prepare(`
      UPDATE jobs
      SET processing = CASE WHEN processing > 0 THEN processing - 1 ELSE 0 END,
          completed = completed + 1,
          status = CASE WHEN completed + 1 >= total THEN 'embedded' ELSE 'processing' END
      WHERE job_id = ?
    `).bind(message.job_id).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE jobs
      SET processing = CASE WHEN processing > 0 THEN processing - 1 ELSE 0 END,
          failed = failed + 1,
          status = 'failed'
      WHERE job_id = ?
    `).bind(message.job_id).run();
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26b-queue-embed" });
    if (url.pathname === "/jobs/start" && request.method === "POST") {
      return start(env, await request.json().catch(() => ({})) as StartRequest);
    }
    const statusMatch = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (statusMatch) return status(env, statusMatch[1]);
    if (url.pathname === "/artifact/head") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "key is required" }, 400);
      return artifactHead(env, key);
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(batch: { messages: Array<{ body: QueueMessageBody }> }, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => processMessage(env, message.body)));
  },
};
