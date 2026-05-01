// POC 31E: Prove alarm fan-out + R2-pull per shard works together.
// Producer writes JSONL to R2, orchestrator alarm fires, each shard pulls from R2,
// filters own records (i % shardCount === shardIndex), inserts to D1.

import { DurableObject } from "cloudflare:workers";

type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null> };
type D1Like = { prepare(sql: string): D1Stmt };
type R2Like = { put(key: string, value: string, opts?: Record<string, unknown>): Promise<unknown>; get(key: string): Promise<{ text(): Promise<string> } | null> };
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DOStubLike };
type Env = { ARTIFACTS: R2Like; DB: D1Like; SHARD_DO: DONamespaceLike; ORCHESTRATOR_DO: DONamespaceLike };

type JobConfig = { job_id: string; artifact_key: string; shard_count: number; t_start: number };
type ShardReq = { job_id: string; artifact_key: string; shard_index: number; shard_count: number };
type ShardResult = { shard_index: number; done: number; errors: number; wall_ms: number };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }
function parseRecords(text: string): { id: string }[] {
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as { id: string }).filter(r => r.id);
}

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
}

export class ShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<ShardResult> {
    const t0 = Date.now();
    console.log(`shard ${req.shard_index}: pulling from R2`);
    const obj = await this.env.ARTIFACTS.get(req.artifact_key);
    if (!obj) return { shard_index: req.shard_index, done: 0, errors: 0, wall_ms: Date.now() - t0 };
    const text = await obj.text();
    const mine = parseRecords(text).filter((_, i) => i % req.shard_count === req.shard_index);
    console.log(`shard ${req.shard_index}: processing ${mine.length} records`);
    for (const r of mine) {
      await this.env.DB.prepare(`UPDATE jobs SET completed = completed + 1 WHERE job_id = ?`).bind(req.job_id).run();
    }
    const wall = Date.now() - t0;
    console.log(`shard ${req.shard_index}: done ${mine.length} in ${wall}ms`);
    return { shard_index: req.shard_index, done: mine.length, errors: 0, wall_ms: wall };
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/process" && req.method === "POST") return json(await this.process(await req.json() as ShardReq));
    return json({ error: "not_found" }, 404);
  }
}

export class OrchestratorDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/start" && req.method === "POST") {
      const cfg = await req.json() as JobConfig;
      await this.ctx.storage.put("config", cfg);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<JobConfig>("config");
    if (!cfg) { console.log("orch: no config"); return; }
    console.log(`orch: fan-out ${cfg.shard_count} shards, artifact=${cfg.artifact_key}`);

    const outcomes = await Promise.allSettled(
      Array.from({ length: cfg.shard_count }, (_, idx) => idx).map(async idx => {
        const stub = this.env.SHARD_DO.get(this.env.SHARD_DO.idFromName(`shard:${cfg.job_id}:${idx}`));
        const r = await stub.fetch("https://s/process", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: cfg.job_id, artifact_key: cfg.artifact_key, shard_index: idx, shard_count: cfg.shard_count } satisfies ShardReq) });
        if (!r.ok) throw new Error(`shard ${idx}: ${r.status}`);
        return await r.json() as ShardResult;
      })
    );

    let done = 0, errs = 0;
    for (const o of outcomes) {
      if (o.status === "fulfilled") { done += o.value.done; errs += o.value.errors; } else errs += 1;
    }
    console.log(`orch: done ${done}, errs ${errs}`);
    await this.env.DB.prepare(`UPDATE jobs SET status=? WHERE job_id=?`).bind(errs === 0 ? "published" : "partial", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31e" });
    if (u.pathname === "/fanout" && request.method === "POST") {
      await schema(env.DB);
      const input = await request.json() as { shard_count?: number; record_count?: number };
      const shards = input.shard_count ?? 4, count = input.record_count ?? 100;
      const jobId = `j31e-${Date.now()}`;
      const artifactKey = `31e/${jobId}.jsonl`;
      const records = Array.from({ length: count }, (_, i) => ({ id: `r${i}` }));
      const text = records.map(r => JSON.stringify(r)).join("\n") + "\n";

      await env.ARTIFACTS.put(artifactKey, text, { httpMetadata: { contentType: "application/jsonl" } });
      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,status,created_at) VALUES (?,?,0,'running',?)`).bind(jobId, count, new Date().toISOString()).run();

      const cfg: JobConfig = { job_id: jobId, artifact_key: artifactKey, shard_count: shards, t_start: Date.now() };
      await env.ORCHESTRATOR_DO.get(env.ORCHESTRATOR_DO.idFromName(`orch:${jobId}`)).fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });

      return json({ ok: true, job_id: jobId, total: count, status: "running" });
    }
    if (u.pathname === "/status") {
      const jobId = u.searchParams.get("job_id"); if (!jobId) return json({ error: "missing job_id" }, 400);
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
      return json({ ok: true, job });
    }
    return json({ error: "not_found" }, 404);
  },
};
