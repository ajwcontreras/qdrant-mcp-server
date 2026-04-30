type VectorizeVector = {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
};

type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};

type Env = {
  VECTORIZE: VectorizeIndexLike;
};

type PublishRequest = {
  vectors?: VectorizeVector[];
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

function validVector(vector: VectorizeVector): boolean {
  return typeof vector.id === "string"
    && Array.isArray(vector.values)
    && vector.values.length === 1536
    && vector.values.every((value) => typeof value === "number" && Number.isFinite(value));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26c3-vectorize" });
    if (url.pathname === "/publish" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as PublishRequest;
      if (!Array.isArray(input.vectors) || input.vectors.length === 0 || !input.vectors.every(validVector)) {
        return json({ ok: false, error: "1536-dimensional vectors are required" }, 400);
      }
      const result = await env.VECTORIZE.upsert(input.vectors);
      return json({ ok: true, vector_count: input.vectors.length, result });
    }
    if (url.pathname === "/search" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as { values?: number[]; topK?: number };
      if (!Array.isArray(input.values) || input.values.length !== 1536) return json({ ok: false, error: "1536-dimensional values are required" }, 400);
      const result = await env.VECTORIZE.query(input.values, { topK: input.topK || 3, returnMetadata: "all" });
      return json({ ok: true, matches: result.matches || [] });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
