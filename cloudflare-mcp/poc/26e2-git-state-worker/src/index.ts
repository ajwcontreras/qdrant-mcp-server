type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first(): Promise<Record<string, unknown> | null>; all(): Promise<{ results?: Array<Record<string, unknown>> }> };
type D1Like = { prepare(sql: string): D1Stmt };
type Env = { DB: D1Like };

type ManifestFile = { action: string; file_path: string; previous_path?: string; sha256?: string | null; bytes?: number | null; blob_sha?: string | null; artifact_key?: string | null };
type Manifest = {
  manifest_id: string; repo_slug: string; repo_path: string;
  base_commit: string; target_commit: string; generated_at: string;
  working_tree_clean: boolean;
  summary: { added: number; modified: number; deleted: number; renamed: number; total: number };
  files: ManifestFile[];
};

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS codebase_git_state (
    repo_slug TEXT PRIMARY KEY, repo_path TEXT NOT NULL,
    active_commit TEXT NOT NULL, last_manifest_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS diff_manifests (
    manifest_id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL,
    base_commit TEXT NOT NULL, target_commit TEXT NOT NULL,
    working_tree_clean INTEGER NOT NULL,
    added INTEGER NOT NULL, modified INTEGER NOT NULL,
    deleted INTEGER NOT NULL, renamed INTEGER NOT NULL,
    total INTEGER NOT NULL, generated_at TEXT NOT NULL, imported_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS diff_manifest_files (
    manifest_id TEXT NOT NULL, file_path TEXT NOT NULL,
    action TEXT NOT NULL, previous_path TEXT,
    sha256 TEXT, bytes INTEGER, blob_sha TEXT, artifact_key TEXT,
    PRIMARY KEY (manifest_id, file_path)
  )`).run();
}

async function importManifest(db: D1Like, manifest: Manifest): Promise<Response> {
  await schema(db);
  if (!manifest.manifest_id || !manifest.repo_slug || !manifest.base_commit || !manifest.target_commit) {
    return json({ ok: false, error: "manifest_id, repo_slug, base_commit, target_commit required" }, 400);
  }
  // Store manifest summary
  await db.prepare(`INSERT OR REPLACE INTO diff_manifests
    (manifest_id, repo_slug, base_commit, target_commit, working_tree_clean,
     added, modified, deleted, renamed, total, generated_at, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(manifest.manifest_id, manifest.repo_slug, manifest.base_commit, manifest.target_commit,
      manifest.working_tree_clean ? 1 : 0,
      manifest.summary.added, manifest.summary.modified, manifest.summary.deleted,
      manifest.summary.renamed, manifest.summary.total,
      manifest.generated_at, new Date().toISOString()).run();
  // Store each file row
  for (const f of manifest.files) {
    await db.prepare(`INSERT OR REPLACE INTO diff_manifest_files
      (manifest_id, file_path, action, previous_path, sha256, bytes, blob_sha, artifact_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(manifest.manifest_id, f.file_path, f.action, f.previous_path || null,
        f.sha256 || null, f.bytes ?? null, f.blob_sha || null, f.artifact_key || null).run();
  }
  // Update active git state
  await db.prepare(`INSERT OR REPLACE INTO codebase_git_state
    (repo_slug, repo_path, active_commit, last_manifest_id, updated_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(manifest.repo_slug, manifest.repo_path, manifest.target_commit,
      manifest.manifest_id, new Date().toISOString()).run();
  return json({ ok: true, manifest_id: manifest.manifest_id, files_stored: manifest.files.length });
}

async function currentState(db: D1Like, repoSlug: string): Promise<Response> {
  await schema(db);
  const state = await db.prepare("SELECT * FROM codebase_git_state WHERE repo_slug = ?").bind(repoSlug).first();
  if (!state) return json({ ok: false, error: "no git state for this repo" }, 404);
  return json({ ok: true, state });
}

async function getManifest(db: D1Like, manifestId: string): Promise<Response> {
  await schema(db);
  const manifest = await db.prepare("SELECT * FROM diff_manifests WHERE manifest_id = ?").bind(manifestId).first();
  if (!manifest) return json({ ok: false, error: "manifest not found" }, 404);
  const files = await db.prepare("SELECT * FROM diff_manifest_files WHERE manifest_id = ? ORDER BY file_path").bind(manifestId).all();
  return json({ ok: true, manifest, files: files.results || [] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26e2-git-state" });
    if (url.pathname === "/git-state/import" && request.method === "POST") {
      return importManifest(env.DB, await request.json().catch(() => ({})) as Manifest);
    }
    const currentMatch = url.pathname.match(/^\/git-state\/current\/([^/]+)$/);
    if (currentMatch) return currentState(env.DB, currentMatch[1]);
    const manifestMatch = url.pathname.match(/^\/git-state\/manifests\/([^/]+)$/);
    if (manifestMatch) return getManifest(env.DB, manifestMatch[1]);
    return json({ ok: false, error: "not found" }, 404);
  },
};
