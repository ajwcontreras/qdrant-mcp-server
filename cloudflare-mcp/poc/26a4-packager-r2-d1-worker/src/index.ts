type R2ObjectLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  head(key: string): Promise<R2ObjectLike | null>;
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ results?: unknown[] }>;
  first(): Promise<Record<string, unknown> | null>;
};

type D1Like = {
  prepare(sql: string): D1StatementLike;
};

type Env = {
  ARTIFACTS: R2Like;
  DB: D1Like;
};

type FileManifestEntry = {
  path?: string;
  sha256?: string;
  bytes?: number;
};

type StartRequest = {
  repo_slug?: string;
  indexed_path?: string;
  artifact_key?: string;
  artifact_text?: string;
  files?: FileManifestEntry[];
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function schema(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      indexed_path TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      byte_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
}

function validateFiles(files: FileManifestEntry[] | undefined): files is Array<Required<FileManifestEntry>> {
  return Array.isArray(files) && files.every((file) => (
    typeof file.path === "string"
    && typeof file.sha256 === "string"
    && typeof file.bytes === "number"
    && Number.isInteger(file.bytes)
    && file.bytes >= 0
  ));
}

async function start(env: Env, input: StartRequest): Promise<Response> {
  await schema(env);
  if (!input.repo_slug || !input.indexed_path || !input.artifact_key || !input.artifact_text || !validateFiles(input.files)) {
    return json({ ok: false, error: "repo_slug, indexed_path, artifact_key, artifact_text, and files are required" }, 400);
  }

  const artifactBytes = byteLength(input.artifact_text);
  const manifestBytes = input.files.reduce((sum, file) => sum + file.bytes, 0);
  const jobId = crypto.randomUUID();

  await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: {
      repo_slug: input.repo_slug,
      job_id: jobId,
      file_count: String(input.files.length),
      manifest_bytes: String(manifestBytes),
    },
  });

  await env.DB.prepare(`
    INSERT INTO jobs (job_id, repo_slug, indexed_path, artifact_key, file_count, byte_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(jobId, input.repo_slug, input.indexed_path, input.artifact_key, input.files.length, artifactBytes, "uploaded", new Date().toISOString()).run();

  return json({ ok: true, job_id: jobId, status: "uploaded", artifact_key: input.artifact_key, file_count: input.files.length, byte_count: artifactBytes });
}

async function status(env: Env, jobId: string): Promise<Response> {
  await schema(env);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return json({ ok: false, error: "job not found" }, 404);
  const key = typeof job.artifact_key === "string" ? job.artifact_key : "";
  const object = key ? await env.ARTIFACTS.head(key) : null;
  return json({
    ok: true,
    job,
    artifact: {
      key,
      exists: Boolean(object),
      size: object?.size || 0,
      metadata: object?.customMetadata || {},
    },
    progress: {
      status: job.status,
      uploaded_files: job.file_count,
      uploaded_bytes: job.byte_count,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26a4-packager" });
    if (url.pathname === "/jobs/start" && request.method === "POST") {
      return start(env, await request.json().catch(() => ({})) as StartRequest);
    }
    const match = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (match) return status(env, match[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
};
