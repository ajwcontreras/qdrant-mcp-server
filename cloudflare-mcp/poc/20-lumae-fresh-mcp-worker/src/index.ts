import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

type D1Result<T = unknown> = { results?: T[] };
type D1Statement = { bind(...values: unknown[]): D1Statement; run<T = unknown>(): Promise<D1Result<T>> };
type D1DatabaseLike = { prepare(sql: string): D1Statement; batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> };
type VectorizeIndexLike = { upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string | number> }>): Promise<unknown>; query(vector: number[], options?: { topK?: number; returnMetadata?: "all" }): Promise<{ matches?: Array<{ id: string; score: number }> }> };
type Env = { DB: D1DatabaseLike; VECTORIZE: VectorizeIndexLike; REPO_SLUG: string; INDEXED_PATH: string; ACTIVE_EMBEDDING_RUN_ID: string };
type Row = { chunk_identity: string; file_path: string; start_line: number; end_line: number; snippet: string; match_reason: string };

function json(value: unknown, status = 200) { return Response.json(value, { status }); }
function vec(seed: number) { return Array.from({ length: 1536 }, (_, i) => Number((Math.sin((i + 1) * seed) * 0.5).toFixed(6))); }
function queryVec(query: string) { return /upload|borrower|document/i.test(query) ? vec(11) : vec(29); }

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

async function search(env: Env, query: string) {
  await schema(env);
  const matches = (await env.VECTORIZE.query(queryVec(query), { topK: 5, returnMetadata: "all" })).matches || [];
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
    return createMcpHandler(server(env), { route: "/mcp" })(request, env, ctx);
  },
};
