import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

type D1Result<T = unknown> = {
  success: boolean;
  results?: T[];
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
};

type D1DatabaseLike = {
  prepare(sql: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
};

type VectorizeVector = {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
};

type VectorizeMatch = {
  id: string;
  score: number;
};

type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: VectorizeMatch[] }>;
};

type Env = {
  DB: D1DatabaseLike;
  VECTORIZE: VectorizeIndexLike;
};

type ChunkRow = {
  vector_id: string;
  chunk_identity: string;
  file_path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  match_reason: string;
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

function queryVector(query: string): number[] {
  return /upload|borrower|file|document/i.test(query) ? makeVector(11) : makeVector(29);
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
      vector_id TEXT PRIMARY KEY,
      chunk_identity TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      snippet TEXT NOT NULL,
      match_reason TEXT NOT NULL
    )`),
  ]);
}

async function seed(env: Env) {
  await ensureSchema(env);
  const chunks = [
    {
      vector_id: "vec-upload-handler",
      values: makeVector(11),
      chunk_identity: "chunk-upload-handler",
      file_path: "app.py",
      start_line: 10,
      end_line: 30,
      snippet: "Flask upload handler receives borrower files and stores document metadata.",
      match_reason: "vector: deterministic upload/document query vector",
    },
    {
      vector_id: "vec-market-rates",
      values: makeVector(29),
      chunk_identity: "chunk-market-rates",
      file_path: "update_market_rate_change.py",
      start_line: 1,
      end_line: 20,
      snippet: "Scheduled market rate refresh imports FRED mortgage rates.",
      match_reason: "vector: deterministic market-rate query vector",
    },
  ];
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
  await env.DB.batch(chunks.map((chunk) => env.DB.prepare(`
    INSERT OR REPLACE INTO chunks (
      vector_id, chunk_identity, file_path, start_line, end_line, snippet, match_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    chunk.vector_id,
    chunk.chunk_identity,
    chunk.file_path,
    chunk.start_line,
    chunk.end_line,
    chunk.snippet,
    chunk.match_reason,
  )));
}

async function hydratedSearch(env: Env, query: string) {
  await ensureSchema(env);
  const vector = queryVector(query);
  const vectorResults = await env.VECTORIZE.query(vector, { topK: 3, returnMetadata: "all" });
  const results = [];
  for (const match of vectorResults.matches || []) {
    const row = await env.DB.prepare(`
      SELECT vector_id, chunk_identity, file_path, start_line, end_line, snippet, match_reason
      FROM chunks WHERE vector_id = ?
    `).bind(match.id).run<ChunkRow>();
    const chunk = row.results?.[0];
    if (!chunk) continue;
    results.push({
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      snippet: chunk.snippet,
      score: match.score,
      match_reasons: [chunk.match_reason],
      chunk_identity: chunk.chunk_identity,
    });
  }
  return results;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "cfcode-poc-12-mcp-search-vectorize",
    version: "0.1.0",
  });

  server.tool(
    "search",
    "Search code chunks through Vectorize and return hydrated snippets.",
    { query: z.string().min(1).max(500) },
    async ({ query }) => {
      const results = await hydratedSearch(env, query);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, query, results }, null, 2) }],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-12-mcp-search-vectorize" });
    }

    if (url.pathname === "/seed" && request.method === "POST") {
      await seed(env);
      return json({ ok: true });
    }

    return createMcpHandler(createServer(env), { route: "/mcp" })(request, env, ctx);
  },
};
