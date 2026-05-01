// POC 30G: synthetic Vectorize-only bench. Strip Vertex/DeepSeek/D1.
// Producer fans out N VecShardDOs; each upserts K random 1536-dim vectors
// in batches of B. Measures peak per-index Vectorize write throughput in
// isolation to test the hypothesis that Vectorize is the real bottleneck.

import { DurableObject } from "cloudflare:workers";

type VecEntry = { id: string; values: number[]; metadata?: Record<string, string | number | boolean> };
type VecLike = { upsert(v: VecEntry[]): Promise<unknown> };
type DOStubLike = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
type DONamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DOStubLike };

type Env = {
  VECTORIZE: VecLike;
  VEC_SHARD_DO: DONamespaceLike;
};

type ShardReq = {
  run_id: string;
  shard_index: number;
  vectors_per_shard: number;
  batch_size: number;
  dim: number;
};
type ShardResult = {
  shard_index: number;
  vectors_done: number;
  batches: number;
  upsert_ms_total: number;
  upsert_ms_min: number;
  upsert_ms_max: number;
  upsert_ms_p50: number;
  upsert_ms_p95: number;
  errors: number;
  wall_ms: number;
};

function json(v: unknown, s = 200) {
  return Response.json(v, { status: s, headers: { "content-type": "application/json" } });
}

// Cheap PRNG so vectors are deterministic per (run_id, shard_index, vector_index)
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function makeVector(rand: () => number, dim: number): number[] {
  const v = new Array<number>(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) { const x = rand() * 2 - 1; v[i] = x; sumSq += x * x; }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i] / norm;
  return v;
}
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

export class VecShardDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/process") return new Response("not found", { status: 404 });
    const body = await req.json() as ShardReq;
    const { run_id, shard_index, vectors_per_shard, batch_size, dim } = body;
    const t0 = Date.now();
    const upsertMs: number[] = [];
    let done = 0;
    let errors = 0;
    let batches = 0;

    // Seed unique per (run_id, shard_index)
    const seed = (hashStr(run_id) ^ (shard_index * 2654435761)) >>> 0;
    const rand = mulberry32(seed);

    for (let off = 0; off < vectors_per_shard; off += batch_size) {
      const n = Math.min(batch_size, vectors_per_shard - off);
      const entries: VecEntry[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const globalIdx = off + i;
        entries[i] = {
          id: `${run_id}-s${shard_index}-${globalIdx}`,
          values: makeVector(rand, dim),
          metadata: { run_id, shard_index, idx: globalIdx },
        };
      }
      const ts = Date.now();
      try {
        await this.env.VECTORIZE.upsert(entries);
        upsertMs.push(Date.now() - ts);
        done += n;
      } catch (e) {
        errors += 1;
        upsertMs.push(Date.now() - ts);
      }
      batches += 1;
    }

    const total = upsertMs.reduce((s, x) => s + x, 0);
    const result: ShardResult = {
      shard_index,
      vectors_done: done,
      batches,
      upsert_ms_total: total,
      upsert_ms_min: upsertMs.length ? Math.min(...upsertMs) : 0,
      upsert_ms_max: upsertMs.length ? Math.max(...upsertMs) : 0,
      upsert_ms_p50: pct(upsertMs, 50),
      upsert_ms_p95: pct(upsertMs, 95),
      errors,
      wall_ms: Date.now() - t0,
    };
    return json(result);
  }
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/bench" && req.method === "POST") {
      const body = await req.json() as {
        run_id?: string;
        shards?: number;
        vectors_per_shard?: number;
        batch_size?: number;
        dim?: number;
      };
      const run_id = body.run_id || `run-${Date.now()}`;
      const shards = body.shards ?? 4;
      const vectors_per_shard = body.vectors_per_shard ?? 1000;
      const batch_size = body.batch_size ?? 100;
      const dim = body.dim ?? 1536;
      const total_target = shards * vectors_per_shard;

      const t0 = Date.now();
      const settled = await Promise.allSettled(
        Array.from({ length: shards }, (_, i) => {
          const stub = env.VEC_SHARD_DO.get(env.VEC_SHARD_DO.idFromName(`vec-bench:shard:${i}`));
          return stub.fetch("https://shard.internal/process", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ run_id, shard_index: i, vectors_per_shard, batch_size, dim } satisfies ShardReq),
          }).then(async (r) => ({ ok: r.ok, status: r.status, body: r.ok ? await r.json() as ShardResult : await r.text() }));
        }),
      );
      const wall_ms = Date.now() - t0;

      const shardResults: ShardResult[] = [];
      const errors: Array<{ shard: number; reason: string }> = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled" && (s.value as { ok: boolean }).ok) {
          shardResults.push((s.value as { body: ShardResult }).body);
        } else {
          const reason = s.status === "rejected"
            ? String((s as PromiseRejectedResult).reason)
            : `status=${(s.value as { status: number }).status} body=${String((s.value as { body: unknown }).body).slice(0, 200)}`;
          errors.push({ shard: i, reason });
        }
      });

      const vectors_done = shardResults.reduce((s, r) => s + r.vectors_done, 0);
      const total_errors = shardResults.reduce((s, r) => s + r.errors, 0) + errors.length;
      const vectors_per_sec = wall_ms > 0 ? +(vectors_done / (wall_ms / 1000)).toFixed(2) : 0;
      const all_p95 = shardResults.length ? Math.max(...shardResults.map(r => r.upsert_ms_p95)) : 0;
      const all_p50_avg = shardResults.length ? +(shardResults.reduce((s, r) => s + r.upsert_ms_p50, 0) / shardResults.length).toFixed(0) : 0;

      return json({
        run_id,
        config: { shards, vectors_per_shard, batch_size, dim, total_target },
        wall_ms,
        vectors_done,
        vectors_per_sec,
        errors: total_errors,
        producer_errors: errors,
        per_shard: shardResults,
        summary: {
          shard_p50_avg_ms: all_p50_avg,
          worst_shard_p95_ms: all_p95,
        },
      });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
