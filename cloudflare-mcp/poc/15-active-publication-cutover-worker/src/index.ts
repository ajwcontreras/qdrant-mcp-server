import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

type D1Result<T = unknown> = { success: boolean; results?: T[] };
type D1Statement = { bind(...values: unknown[]): D1Statement; run<T = unknown>(): Promise<D1Result<T>> };
type D1DatabaseLike = { prepare(sql: string): D1Statement; batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> };
type VectorizeVector = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number }> }>;
};
type Env = { DB: D1DatabaseLike; PUB_A: VectorizeIndexLike; PUB_B: VectorizeIndexLike };
type ActiveRow = { publication_id: string };
type ChunkRow = { vector_id: string; publication_id: string; file_path: string; start_line: number; end_line: number; snippet: string };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function makeVector(seed: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < 1536; i += 1) values.push(Number((Math.sin((i + 1) * seed) * 0.5).toFixed(6)));
  return values;
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS active_publication (codebase TEXT PRIMARY KEY, publication_id TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
      vector_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      snippet TEXT NOT NULL
    )`),
  ]);
}

async function activePublication(env: Env): Promise<string> {
  await ensureSchema(env);
  const result = await env.DB.prepare(`SELECT publication_id FROM active_publication WHERE codebase = ?`)
    .bind("lumae-fresh").run<ActiveRow>();
  return result.results?.[0]?.publication_id || "pub-a";
}

async function seed(env: Env) {
  await ensureSchema(env);
  await env.PUB_A.upsert([{ id: "pub-a-upload", values: makeVector(11), metadata: { publication_id: "pub-a" } }]);
  await env.PUB_B.upsert([{ id: "pub-b-rates", values: makeVector(11), metadata: { publication_id: "pub-b" } }]);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO active_publication (codebase, publication_id) VALUES (?, ?)`)
      .bind("lumae-fresh", "pub-a"),
    env.DB.prepare(`INSERT OR REPLACE INTO chunks (vector_id, publication_id, file_path, start_line, end_line, snippet) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind("pub-a-upload", "pub-a", "app.py", 10, 30, "Publication A upload-handler result."),
    env.DB.prepare(`INSERT OR REPLACE INTO chunks (vector_id, publication_id, file_path, start_line, end_line, snippet) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind("pub-b-rates", "pub-b", "update_market_rate_change.py", 1, 20, "Publication B market-rate result."),
  ]);
}

async function setActive(env: Env, publicationId: string) {
  await ensureSchema(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO active_publication (codebase, publication_id) VALUES (?, ?)`)
    .bind("lumae-fresh", publicationId).run();
}

async function search(env: Env, query: string) {
  const publicationId = await activePublication(env);
  const index = publicationId === "pub-b" ? env.PUB_B : env.PUB_A;
  const result = await index.query(makeVector(11), { topK: 1, returnMetadata: "all" });
  const match = result.matches?.[0];
  if (!match) return [];
  const row = await env.DB.prepare(`
    SELECT vector_id, publication_id, file_path, start_line, end_line, snippet
    FROM chunks WHERE vector_id = ? AND publication_id = ?
  `).bind(match.id, publicationId).run<ChunkRow>();
  const chunk = row.results?.[0];
  if (!chunk) return [];
  return [{
    publication_id: publicationId,
    file_path: chunk.file_path,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    snippet: chunk.snippet,
    score: match.score,
    match_reasons: [`active publication: ${publicationId}`, `query: ${query}`],
  }];
}

function createServer(env: Env) {
  const server = new McpServer({ name: "cfcode-poc-15-active-publication", version: "0.1.0" });
  server.tool(
    "search",
    "Search the currently active publication.",
    { query: z.string().min(1).max(500) },
    async ({ query }) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, query, results: await search(env, query) }, null, 2) }],
    }),
  );
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-15-active-publication" });
    if (url.pathname === "/seed" && request.method === "POST") {
      await seed(env);
      return json({ ok: true });
    }
    if (url.pathname === "/activate" && request.method === "POST") {
      const body = await request.json() as { publication_id?: string };
      if (body.publication_id !== "pub-a" && body.publication_id !== "pub-b") return json({ ok: false, error: "bad publication" }, 400);
      await setActive(env, body.publication_id);
      return json({ ok: true, publication_id: body.publication_id });
    }
    return createMcpHandler(createServer(env), { route: "/mcp" })(request, env, ctx);
  },
};
