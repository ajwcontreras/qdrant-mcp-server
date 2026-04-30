type R2ObjectLike = { size: number; customMetadata?: Record<string, string> };
type R2Like = {
  put(key: string, value: string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>;
  head(key: string): Promise<R2ObjectLike | null>;
};

type Env = {
  ARTIFACTS: R2Like;
};

type StartRequest = {
  artifact_key?: string;
  artifact_text?: string;
  repo_slug?: string;
  publication_id?: string;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26c2-r2-publication" });
    if (url.pathname === "/publication/artifact/start" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as StartRequest;
      if (!input.artifact_key || !input.artifact_text || !input.repo_slug || !input.publication_id) {
        return json({ ok: false, error: "artifact_key, artifact_text, repo_slug, and publication_id are required" }, 400);
      }
      const bytes = new TextEncoder().encode(input.artifact_text).byteLength;
      await env.ARTIFACTS.put(input.artifact_key, input.artifact_text, {
        httpMetadata: { contentType: "application/jsonl" },
        customMetadata: {
          repo_slug: input.repo_slug,
          publication_id: input.publication_id,
          byte_count: String(bytes),
        },
      });
      return json({ ok: true, key: input.artifact_key, bytes });
    }
    if (url.pathname === "/artifact/head") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "key is required" }, 400);
      const object = await env.ARTIFACTS.head(key);
      return json({ ok: true, key, exists: Boolean(object), size: object?.size || 0, metadata: object?.customMetadata || {} });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
