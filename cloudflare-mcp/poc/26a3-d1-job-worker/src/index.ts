type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ results?: unknown[] }>;
  first(): Promise<Record<string, unknown> | null>;
};

type D1Like = {
  prepare(sql: string): D1StatementLike;
};

type Env = {
  DB: D1Like;
};

type StartRequest = {
  repo_slug?: string;
  indexed_path?: string;
  artifact_key?: string;
  file_count?: number;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

async function schema(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      indexed_path TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
}

async function start(env: Env, input: StartRequest): Promise<Response> {
  await schema(env);
  if (!input.repo_slug || !input.indexed_path || !input.artifact_key || !Number.isInteger(input.file_count)) {
    return json({ ok: false, error: "repo_slug, indexed_path, artifact_key, and file_count are required" }, 400);
  }
  const jobId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO jobs (job_id, repo_slug, indexed_path, artifact_key, file_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(jobId, input.repo_slug, input.indexed_path, input.artifact_key, input.file_count, "uploaded", new Date().toISOString()).run();
  return json({ ok: true, job_id: jobId, status: "uploaded" });
}

async function status(env: Env, jobId: string): Promise<Response> {
  await schema(env);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "job not found" }, 404);
  return json({ ok: true, job });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26a3-d1-job" });
    if (url.pathname === "/jobs/start" && request.method === "POST") {
      return start(env, await request.json().catch(() => ({})) as StartRequest);
    }
    const match = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (match) return status(env, match[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
};
