type VectorizeVector = {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
};

type VectorizeMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

type VectorizeMutation = {
  mutationId?: string;
  count?: number;
  ids?: string[];
};

type VectorizeQueryResult = {
  matches?: VectorizeMatch[];
};

type VectorizeIndexLike = {
  upsert(vectors: VectorizeVector[]): Promise<VectorizeMutation>;
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: "none" | "indexed" | "all";
      returnValues?: boolean;
    },
  ): Promise<VectorizeQueryResult>;
};

type Env = {
  VECTORIZE: VectorizeIndexLike;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function makeVector(seed: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < 1536; i += 1) {
    const angle = (i + 1) * seed;
    values.push(Number((Math.sin(angle) * 0.5 + Math.cos(angle / 7) * 0.25).toFixed(6)));
  }
  return values;
}

async function parseVector(request: Request, fallbackSeed: number): Promise<number[]> {
  if (request.method !== "POST") return makeVector(fallbackSeed);
  const body = await request.json().catch(() => ({})) as { values?: unknown };
  if (!Array.isArray(body.values)) return makeVector(fallbackSeed);
  const values = body.values.map((value) => Number(value));
  if (values.length !== 1536 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("values must be a 1536-dimensional numeric array");
  }
  return values;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-05-vectorize-1536", dimensions: 1536 });
    }

    if (url.pathname === "/upsert" && request.method === "POST") {
      const vectors: VectorizeVector[] = [
        {
          id: "chunk-upload-handler",
          values: makeVector(11),
          metadata: {
            repo_slug: "lumae-fresh",
            chunk_identity: "chunk-upload-handler",
            file_path: "app.py",
            start_line: 10,
            end_line: 30,
            embedding_model: "poc-deterministic-1536",
          },
        },
        {
          id: "chunk-market-rates",
          values: makeVector(29),
          metadata: {
            repo_slug: "lumae-fresh",
            chunk_identity: "chunk-market-rates",
            file_path: "update_market_rate_change.py",
            start_line: 1,
            end_line: 20,
            embedding_model: "poc-deterministic-1536",
          },
        },
      ];
      const result = await env.VECTORIZE.upsert(vectors);
      return json({ ok: true, result });
    }

    if (url.pathname === "/query") {
      const seed = Number(url.searchParams.get("seed") || "11");
      const vector = await parseVector(request, Number.isFinite(seed) ? seed : 11);
      const result = await env.VECTORIZE.query(vector, {
        topK: 3,
        returnMetadata: "all",
        returnValues: false,
      });
      return json({ ok: true, result });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
