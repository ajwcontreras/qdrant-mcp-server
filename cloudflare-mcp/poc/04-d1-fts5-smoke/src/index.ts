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

type Env = {
  DB: D1DatabaseLike;
};

type SearchRow = {
  chunk_identity: string;
  file_path: string;
  rank: number;
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
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbols TEXT NOT NULL,
      body TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_identity UNINDEXED,
      repo_slug UNINDEXED,
      file_path,
      symbols,
      body
    )`),
  ]);
}

async function seed(env: Env) {
  await ensureSchema(env);
  const chunks = [
    {
      id: "upload-handler",
      repo: "lumae-fresh",
      file: "app.py",
      start: 10,
      end: 30,
      symbols: "upload_document handle_upload borrower_file",
      body: "Flask route receives borrower uploaded document files and stores metadata.",
    },
    {
      id: "auth-login",
      repo: "lumae-fresh",
      file: "auth.py",
      start: 40,
      end: 70,
      symbols: "login_user validate_password session",
      body: "Authentication login flow validates a password and writes session state.",
    },
    {
      id: "market-rates",
      repo: "lumae-fresh",
      file: "update_market_rate_change.py",
      start: 1,
      end: 20,
      symbols: "update_market_rates fred_rates",
      body: "Scheduled market rate refresh imports FRED mortgage rates.",
    },
  ];
  const stmts = [];
  for (const chunk of chunks) {
    stmts.push(env.DB.prepare(`
      INSERT OR REPLACE INTO chunks (
        chunk_identity, repo_slug, file_path, start_line, end_line, symbols, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(chunk.id, chunk.repo, chunk.file, chunk.start, chunk.end, chunk.symbols, chunk.body));
    stmts.push(env.DB.prepare(`
      INSERT INTO chunks_fts (chunk_identity, repo_slug, file_path, symbols, body)
      VALUES (?, ?, ?, ?, ?)
    `).bind(chunk.id, chunk.repo, chunk.file, chunk.symbols, chunk.body));
  }
  await env.DB.batch(stmts);
}

function sanitizeFtsQuery(query: string): string {
  return query
    .split(/[^A-Za-z0-9_]+/)
    .filter((part) => part.length > 1)
    .slice(0, 8)
    .map((part) => `${part}*`)
    .join(" OR ");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-04-d1-fts5" });
    }

    if (url.pathname === "/seed" && request.method === "POST") {
      await seed(env);
      return json({ ok: true });
    }

    if (url.pathname === "/search") {
      await ensureSchema(env);
      const query = sanitizeFtsQuery(url.searchParams.get("q") || "");
      if (!query) return json({ ok: false, error: "empty query" }, 400);
      const result = await env.DB.prepare(`
        SELECT chunk_identity, file_path, bm25(chunks_fts, 1.0, 3.0, 1.0) AS rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT 5
      `).bind(query).run<SearchRow>();
      return json({ ok: result.success, query, rows: result.results || [] });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
