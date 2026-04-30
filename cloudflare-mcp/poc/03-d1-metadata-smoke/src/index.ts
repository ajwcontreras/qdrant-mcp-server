type D1Result<T = unknown> = {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
};

type D1DatabaseLike = {
  prepare(sql: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
};

type Env = {
  DB: D1DatabaseLike;
};

type ChunkRecord = {
  chunk_identity: string;
  repo_slug: string;
  file_path: string;
  content_hash: string;
  chunker_version: string;
  start_line: number;
  end_line: number;
  text: string;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
      chunk_identity TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chunker_version TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chunks_repo_path ON chunks(repo_slug, file_path)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)"),
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-03-d1-metadata" });
    }

    if (url.pathname === "/init" && request.method === "POST") {
      await ensureSchema(env);
      return json({ ok: true });
    }

    if (url.pathname === "/chunk" && request.method === "POST") {
      await ensureSchema(env);
      const record = await request.json() as ChunkRecord;
      const result = await env.DB.prepare(`
        INSERT OR REPLACE INTO chunks (
          chunk_identity, repo_slug, file_path, content_hash, chunker_version,
          start_line, end_line, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        record.chunk_identity,
        record.repo_slug,
        record.file_path,
        record.content_hash,
        record.chunker_version,
        record.start_line,
        record.end_line,
        record.text,
      ).run();
      return json({ ok: result.success, chunk_identity: record.chunk_identity });
    }

    if (url.pathname === "/chunk" && request.method === "GET") {
      await ensureSchema(env);
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "missing id" }, 400);
      const row = await env.DB.prepare("SELECT * FROM chunks WHERE chunk_identity = ?").bind(id).first();
      if (!row) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, row });
    }

    if (url.pathname === "/chunks" && request.method === "GET") {
      await ensureSchema(env);
      const repo = url.searchParams.get("repo");
      if (!repo) return json({ ok: false, error: "missing repo" }, 400);
      const result = await env.DB.prepare(
        "SELECT chunk_identity, file_path, start_line, end_line FROM chunks WHERE repo_slug = ? ORDER BY file_path, start_line LIMIT 20",
      ).bind(repo).run();
      return json({ ok: result.success, rows: result.results || [] });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
