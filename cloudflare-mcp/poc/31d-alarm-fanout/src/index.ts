// POC 31D: Prove alarm-driven fan-out with synthetic payloads.
// No Vertex, no DeepSeek, no Vectorize, no R2.
// One hypothesis: DO alarm → N shards → aggregate results → update D1 works.

import { DurableObject } from "cloudflare:workers";

type D1Stmt = { bind(...v: unknown[]): D1Stmt; run(): Promise<unknown>; first<T = Record<string, unknown>>(): Promise<T | null> };
type D1Like = { prepare(sql: string): D1Stmt };
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DOStubLike };

type Env = { DB: D1Like; SHARD_DO: DONamespaceLike; ORCHESTRATOR_DO: DONamespaceLike; SHARD_COUNT?: string };
type JobConfig = { job_id: string; shard_count: number; items_per_shard: number; t_start: number };
type ShardReq = { job_id: string; shard_index: number; count: number };
type ShardResult = { shard_index: number; done: number; wall_ms: number; errors: number };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }

async function schema(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
}

export class ShardDO extends DurableObject<Env> {
  async process(req: ShardReq): Promise<ShardResult> {
    const t0 = Date.now();
    console.log(`shard ${req.shard_index}: processing ${req.count} items`);
    for (let i = 0; i < req.count; i++) {
      await this.env.DB.prepare(`UPDATE jobs SET completed = completed + 1 WHERE job_id = ?`).bind(req.job_id).run();
    }
    const wall = Date.now() - t0;
    console.log(`shard ${req.shard_index}: done ${req.count} items in ${wall}ms`);
    return { shard_index: req.shard_index, done: req.count, wall_ms: wall, errors: 0 };
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
    console.log(`orch: fan-out ${cfg.shard_count} shards × ${cfg.items_per_shard}`);

    const outcomes = await Promise.allSettled(
      Array.from({ length: cfg.shard_count }, (_, idx) => idx).map(async idx => {
        const stub = this.env.SHARD_DO.get(this.env.SHARD_DO.idFromName(`shard:${idx}`));
        const r = await stub.fetch("https://s/process", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ job_id: cfg.job_id, shard_index: idx, count: cfg.items_per_shard } satisfies ShardReq),
        });
        if (!r.ok) throw new Error(`shard ${idx}: ${r.status}`);
        return await r.json() as ShardResult;
      })
    );

    let done = 0, errs = 0;
    for (const o of outcomes) {
      if (o.status === "fulfilled") { done += o.value.done; errs += o.value.errors; }
      else { errs += cfg.items_per_shard; console.log(`orch: shard rejected`); }
    }
    console.log(`orch: fan-out done. ${done} items, ${errs} errors`);
    await this.env.DB.prepare(`UPDATE jobs SET status = ? WHERE job_id = ?`).bind(errs === 0 ? "published" : "partial", cfg.job_id).run();
    await this.ctx.storage.delete("config");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true, service: "poc-31d-alarm-fanout" });

    if (u.pathname === "/fanout" && request.method === "POST") {
      await schema(env.DB);
      const input = await request.json() as { shard_count?: number; items_per_shard?: number };
      const shardCount = input.shard_count ?? parseInt(env.SHARD_COUNT || "4", 10);
      const itemsPerShard = input.items_per_shard ?? 100;
      const jobId = `j31d-${Date.now()}`;
      const total = shardCount * itemsPerShard;
      const now = new Date().toISOString();

      await env.DB.prepare(`INSERT OR REPLACE INTO jobs (job_id,total,completed,status,created_at) VALUES (?,?,0,'running',?)`).bind(jobId, total, now).run();

      const cfg: JobConfig = { job_id: jobId, shard_count: shardCount, items_per_shard: itemsPerShard, t_start: Date.now() };
      const stub = env.ORCHESTRATOR_DO.get(env.ORCHESTRATOR_DO.idFromName(`orch:${jobId}`));
      await stub.fetch("https://o/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });

      return json({ ok: true, job_id: jobId, total, status: "running" });
    }

    if (u.pathname === "/status") {
      const jobId = u.searchParams.get("job_id");
      if (!jobId) return json({ error: "missing job_id" }, 400);
      await schema(env.DB);
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
      return json({ ok: true, job });
    }

    return json({ error: "not_found" }, 404);
  },
};
