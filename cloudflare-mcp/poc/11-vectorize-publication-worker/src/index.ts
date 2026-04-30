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

type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number }> }>;
};

type Env = {
  DB: D1DatabaseLike;
  VECTORIZE: VectorizeIndexLike;
};

type PublishVector = {
  vector_id: string;
  values: number[];
  source_artifact: string;
  source_identity: string;
  input_hash: string;
  embedding_model: string;
  dimension: number;
};

type PublishRequest = {
  publication_id: string;
  embedding_run_id: string;
  vectorize_index: string;
  vectors: PublishVector[];
};

type CountRow = {
  count: number;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS publications (
      publication_id TEXT PRIMARY KEY,
      embedding_run_id TEXT NOT NULL,
      vectorize_index TEXT NOT NULL,
      active INTEGER NOT NULL,
      vector_count INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS vector_records (
      vector_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      embedding_run_id TEXT NOT NULL,
      source_artifact TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      dimension INTEGER NOT NULL
    )`),
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-11-vectorize-publication" });
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      await ensureSchema(env);
      const body = await request.json() as PublishRequest;
      const vectors = body.vectors.map((vector) => ({
        id: vector.vector_id,
        values: vector.values,
        metadata: {
          publication_id: body.publication_id,
          embedding_run_id: body.embedding_run_id,
          source_artifact: vector.source_artifact,
          source_identity: vector.source_identity,
          input_hash: vector.input_hash,
          embedding_model: vector.embedding_model,
          dimension: vector.dimension,
        },
      }));
      await env.VECTORIZE.upsert(vectors);
      await env.DB.batch([
        env.DB.prepare(`
          INSERT OR REPLACE INTO publications (
            publication_id, embedding_run_id, vectorize_index, active, vector_count
          ) VALUES (?, ?, ?, 1, ?)
        `).bind(body.publication_id, body.embedding_run_id, body.vectorize_index, vectors.length),
        ...body.vectors.map((vector) => env.DB.prepare(`
          INSERT OR REPLACE INTO vector_records (
            vector_id, publication_id, embedding_run_id, source_artifact, source_identity,
            input_hash, embedding_model, dimension
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          vector.vector_id,
          body.publication_id,
          body.embedding_run_id,
          vector.source_artifact,
          vector.source_identity,
          vector.input_hash,
          vector.embedding_model,
          vector.dimension,
        )),
      ]);
      return json({ ok: true, vector_count: vectors.length });
    }

    if (url.pathname === "/records") {
      await ensureSchema(env);
      const publicationId = url.searchParams.get("publication_id") || "";
      const result = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM vector_records WHERE publication_id = ?
      `).bind(publicationId).run<CountRow>();
      return json({ ok: true, count: result.results?.[0]?.count || 0 });
    }

    if (url.pathname === "/query" && request.method === "POST") {
      const body = await request.json() as { values?: number[] };
      if (!Array.isArray(body.values)) return json({ ok: false, error: "values required" }, 400);
      const result = await env.VECTORIZE.query(body.values, { topK: 1, returnMetadata: "all" });
      return json({ ok: true, matches: result.matches || [] });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
