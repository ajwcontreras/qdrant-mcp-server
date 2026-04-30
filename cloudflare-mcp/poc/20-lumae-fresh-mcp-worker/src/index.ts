import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

type D1Result<T = unknown> = { results?: T[] };
type D1Statement = { bind(...values: unknown[]): D1Statement; run<T = unknown>(): Promise<D1Result<T>> };
type D1DatabaseLike = { prepare(sql: string): D1Statement; batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> };
type VectorizeIndexLike = { upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string | number> }>): Promise<unknown>; query(vector: number[], options?: { topK?: number; returnMetadata?: "all" }): Promise<{ matches?: Array<{ id: string; score: number }> }> };
type Env = { DB: D1DatabaseLike; VECTORIZE: VectorizeIndexLike; REPO_SLUG: string; INDEXED_PATH: string; ACTIVE_EMBEDDING_RUN_ID: string; GEMINI_SERVICE_ACCOUNT_B64?: string; GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string; GOOGLE_EMBEDDING_MODEL?: string };
type Row = { chunk_identity: string; file_path: string; start_line: number; end_line: number; snippet: string; match_reason: string };
type IngestChunk = { vector_id: string; chunk_identity: string; file_path: string; start_line: number; end_line: number; snippet: string; match_reason?: string; values: number[] };
type GoogleServiceAccount = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

let tokenCache: { token: string; expiresAt: number } | undefined;

function json(value: unknown, status = 200) { return Response.json(value, { status }); }
function vec(seed: number) { return Array.from({ length: 1536 }, (_, i) => Number((Math.sin((i + 1) * seed) * 0.5).toFixed(6))); }
function queryVec(query: string) { return /upload|borrower|document/i.test(query) ? vec(11) : vec(29); }

function parseServiceAccount(env: Env): GoogleServiceAccount | null {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) return null;
  const account = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleServiceAccount>;
  if (!account.client_email || !account.private_key) throw new Error("GEMINI_SERVICE_ACCOUNT_B64 did not decode to a service account");
  return { client_email: account.client_email, private_key: account.private_key, project_id: account.project_id, token_uri: account.token_uri };
}

async function googleAccessToken(account: GoogleServiceAccount): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
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
  return tokenCache.token;
}

async function signJwt(account: GoogleServiceAccount, claims: Record<string, string | number>): Promise<string> {
  const signingInput = `${base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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

async function embedQuery(env: Env, query: string): Promise<number[]> {
  const account = parseServiceAccount(env);
  if (!account) return queryVec(query);
  const project = env.GOOGLE_PROJECT_ID || account.project_id;
  if (!project) throw new Error("GOOGLE_PROJECT_ID or service account project_id is required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const token = await googleAccessToken(account);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ content: query, task_type: "CODE_RETRIEVAL_QUERY" }],
      parameters: { autoTruncate: true, outputDimensionality: 1536 },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Vertex query embedding failed ${response.status}: ${raw.slice(0, 500)}`);
  const values = JSON.parse(raw).predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || values.length !== 1536) throw new Error("Vertex query embedding did not return 1536 values");
  return values;
}

async function schema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (vector_id TEXT PRIMARY KEY, chunk_identity TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, snippet TEXT, match_reason TEXT)`),
  ]);
}

async function seed(env: Env) {
  await schema(env);
  const chunks = [
    ["vec-upload", "chunk-upload-handler", "app.py", 10, 30, "Flask upload handler receives borrower files and stores document metadata.", "vector: upload/document semantic match", vec(11)],
    ["vec-rates", "chunk-market-rates", "update_market_rate_change.py", 1, 20, "Scheduled market rate refresh imports FRED mortgage rates.", "vector: market-rate semantic match", vec(29)],
  ] as const;
  await env.VECTORIZE.upsert(chunks.map(([id, chunk, file, start, end, snippet, reason, values]) => ({ id, values, metadata: { chunk_identity: chunk, file_path: file, start_line: start, end_line: end } })));
  await env.DB.batch(chunks.map(([id, chunk, file, start, end, snippet, reason]) => env.DB.prepare(`INSERT OR REPLACE INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, chunk, file, start, end, snippet, reason)));
}

async function ingest(env: Env, chunks: IngestChunk[]) {
  await schema(env);
  if (!Array.isArray(chunks) || chunks.length === 0) return { ok: true, ingested: 0 };
  for (const chunk of chunks) {
    if (!chunk.vector_id || !chunk.chunk_identity || !chunk.file_path || !Array.isArray(chunk.values) || chunk.values.length !== 1536) {
      throw new Error("Each chunk requires vector_id, chunk_identity, file_path, and 1536d values");
    }
  }
  await env.VECTORIZE.upsert(chunks.map((chunk) => ({
    id: chunk.vector_id,
    values: chunk.values,
    metadata: {
      chunk_identity: chunk.chunk_identity,
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    },
  })));
  await env.DB.batch(chunks.map((chunk) => env.DB.prepare(`INSERT OR REPLACE INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
    chunk.vector_id,
    chunk.chunk_identity,
    chunk.file_path,
    chunk.start_line,
    chunk.end_line,
    chunk.snippet,
    chunk.match_reason || "google-embedding: hyde question vector",
  )));
  return { ok: true, ingested: chunks.length };
}

async function search(env: Env, query: string) {
  await schema(env);
  const matches = (await env.VECTORIZE.query(await embedQuery(env, query), { topK: 5, returnMetadata: "all" })).matches || [];
  const results = [];
  for (const match of matches) {
    const row = (await env.DB.prepare(`SELECT chunk_identity, file_path, start_line, end_line, snippet, match_reason FROM chunks WHERE vector_id = ?`).bind(match.id).run<Row>()).results?.[0];
    if (row) results.push({ ...row, score: match.score, match_reasons: [row.match_reason] });
  }
  return results;
}

function server(env: Env) {
  const mcp = new McpServer({ name: "cfcode-lumae-fresh", version: "1.0.0" });
  mcp.tool("search", "Search lumae-fresh code.", { query: z.string().min(1).max(500) }, async ({ query }) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, results: await search(env, query) }, null, 2) }] }));
  mcp.tool("collection_info", "Show active codebase publication.", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ backend: "cloudflare", repo_slug: env.REPO_SLUG, indexed_path: env.INDEXED_PATH, active_embedding_run_id: env.ACTIVE_EMBEDDING_RUN_ID, dimensions: 1536 }, null, 2) }] }));
  mcp.tool("get_chunk", "Fetch a chunk by identity.", { chunk_identity: z.string() }, async ({ chunk_identity }) => {
    const row = (await env.DB.prepare(`SELECT chunk_identity, file_path, start_line, end_line, snippet, match_reason FROM chunks WHERE chunk_identity = ?`).bind(chunk_identity).run<Row>()).results?.[0];
    return { content: [{ type: "text", text: JSON.stringify({ ok: Boolean(row), chunk: row || null }, null, 2) }] };
  });
  mcp.tool("suggest_queries", "Suggest follow-up code search queries.", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ queries: ["borrower upload document handler", "FRED mortgage rate refresh"] }, null, 2) }] }));
  return mcp;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/seed" && request.method === "POST") { await seed(env); return json({ ok: true }); }
    if (url.pathname === "/ingest" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { chunks?: IngestChunk[] };
      try {
        return json(await ingest(env, body.chunks || []));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    return createMcpHandler(server(env), { route: "/mcp" })(request, env, ctx);
  },
};
