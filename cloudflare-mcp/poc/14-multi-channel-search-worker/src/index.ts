import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

type D1Result<T = unknown> = { success: boolean; results?: T[] };
type D1Statement = { bind(...values: unknown[]): D1Statement; run<T = unknown>(): Promise<D1Result<T>> };
type D1DatabaseLike = { prepare(sql: string): D1Statement; batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> };
type VectorizeVector = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VectorizeMatch = { id: string; score: number };
type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: VectorizeMatch[] }>;
};
type Env = { DB: D1DatabaseLike; CODE_INDEX: VectorizeIndexLike; HYDE_INDEX: VectorizeIndexLike };
type ChunkRow = {
  chunk_identity: string;
  file_path: string;
  start_line: number;
  end_line: number;
  snippet: string;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function makeVector(seed: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < 1536; i += 1) {
    values.push(Number((Math.sin((i + 1) * seed) * 0.5 + Math.cos((i + 1) / seed) * 0.25).toFixed(6)));
  }
  return values;
}

function queryVector(_query: string): number[] {
  return makeVector(11);
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
      chunk_identity TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      snippet TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS vector_channels (
      vector_id TEXT PRIMARY KEY,
      chunk_identity TEXT NOT NULL,
      channel TEXT NOT NULL
    )`),
  ]);
}

async function seed(env: Env) {
  await ensureSchema(env);
  await env.CODE_INDEX.upsert([
    {
      id: "code-upload-handler",
      values: makeVector(11),
      metadata: { chunk_identity: "chunk-upload-handler", channel: "code" },
    },
  ]);
  await env.HYDE_INDEX.upsert([
    {
      id: "hyde-upload-handler",
      values: makeVector(11),
      metadata: { chunk_identity: "chunk-upload-handler", channel: "hyde" },
    },
    {
      id: "hyde-market-rates",
      values: makeVector(29),
      metadata: { chunk_identity: "chunk-market-rates", channel: "hyde" },
    },
  ]);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR REPLACE INTO chunks (chunk_identity, file_path, start_line, end_line, snippet)
      VALUES (?, ?, ?, ?, ?)
    `).bind("chunk-upload-handler", "app.py", 10, 30, "Upload handler receives borrower files and stores document metadata."),
    env.DB.prepare(`
      INSERT OR REPLACE INTO chunks (chunk_identity, file_path, start_line, end_line, snippet)
      VALUES (?, ?, ?, ?, ?)
    `).bind("chunk-market-rates", "update_market_rate_change.py", 1, 20, "Scheduled market rate refresh imports FRED mortgage rates."),
    env.DB.prepare(`INSERT OR REPLACE INTO vector_channels (vector_id, chunk_identity, channel) VALUES (?, ?, ?)`)
      .bind("code-upload-handler", "chunk-upload-handler", "code"),
    env.DB.prepare(`INSERT OR REPLACE INTO vector_channels (vector_id, chunk_identity, channel) VALUES (?, ?, ?)`)
      .bind("hyde-upload-handler", "chunk-upload-handler", "hyde"),
    env.DB.prepare(`INSERT OR REPLACE INTO vector_channels (vector_id, chunk_identity, channel) VALUES (?, ?, ?)`)
      .bind("hyde-market-rates", "chunk-market-rates", "hyde"),
  ]);
}

async function channelChunk(env: Env, vectorId: string): Promise<{ chunk_identity: string; channel: string } | undefined> {
  const result = await env.DB.prepare(`
    SELECT chunk_identity, channel FROM vector_channels WHERE vector_id = ?
  `).bind(vectorId).run<{ chunk_identity: string; channel: string }>();
  return result.results?.[0];
}

async function hydrate(env: Env, chunkIdentity: string): Promise<ChunkRow | undefined> {
  const result = await env.DB.prepare(`
    SELECT chunk_identity, file_path, start_line, end_line, snippet FROM chunks WHERE chunk_identity = ?
  `).bind(chunkIdentity).run<ChunkRow>();
  return result.results?.[0];
}

async function multiChannelSearch(env: Env, query: string) {
  await ensureSchema(env);
  const vector = queryVector(query);
  const [code, hyde] = await Promise.all([
    env.CODE_INDEX.query(vector, { topK: 5, returnMetadata: "all" }),
    env.HYDE_INDEX.query(vector, { topK: 5, returnMetadata: "all" }),
  ]);

  const merged = new Map<string, { score: number; channels: string[]; reasons: string[] }>();
  for (const [channelName, matches] of [["code", code.matches || []], ["hyde", hyde.matches || []]] as const) {
    for (let rank = 0; rank < matches.length; rank += 1) {
      const match = matches[rank];
      const channelRecord = await channelChunk(env, match.id);
      if (!channelRecord) continue;
      const existing = merged.get(channelRecord.chunk_identity) || { score: 0, channels: [], reasons: [] };
      existing.score += 1 / (60 + rank + 1);
      existing.channels.push(channelName);
      existing.reasons.push(`${channelName}: vector rank ${rank + 1}`);
      merged.set(channelRecord.chunk_identity, existing);
    }
  }

  const results = [];
  for (const [chunkIdentity, item] of merged) {
    const chunk = await hydrate(env, chunkIdentity);
    if (!chunk) continue;
    results.push({
      chunk_identity: chunkIdentity,
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      snippet: chunk.snippet,
      score: item.score,
      channels: [...new Set(item.channels)],
      match_reasons: item.reasons,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

function createServer(env: Env) {
  const server = new McpServer({ name: "cfcode-poc-14-multi-channel-search", version: "0.1.0" });
  server.tool(
    "search",
    "Search code and HyDE vector channels, then merge by chunk identity.",
    { query: z.string().min(1).max(500) },
    async ({ query }) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, query, results: await multiChannelSearch(env, query) }, null, 2) }],
    }),
  );
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-14-multi-channel-search" });
    if (url.pathname === "/seed" && request.method === "POST") {
      await seed(env);
      return json({ ok: true });
    }
    return createMcpHandler(createServer(env), { route: "/mcp" })(request, env, ctx);
  },
};
