type Env = {
  ARTIFACTS: {
    put(key: string, value: string | ReadableStream | ArrayBuffer, options?: unknown): Promise<unknown>;
    get(key: string): Promise<{
      body: ReadableStream | null;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    } | null>;
    delete(key: string): Promise<void>;
  };
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "cfcode-poc-02-r2-artifact" });
    }

    if (url.pathname === "/artifact" && request.method === "PUT") {
      const body = await request.text();
      const hash = await sha256Hex(body);
      const key = url.searchParams.get("key") || `chunks/${hash}.json`;
      await env.ARTIFACTS.put(key, body, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sha256: hash },
      });
      return json({ ok: true, key, sha256: hash });
    }

    if (url.pathname === "/artifact" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "missing key" }, 400);
      const object = await env.ARTIFACTS.get(key);
      if (!object) return json({ ok: false, error: "not found" }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/json",
          "x-artifact-sha256": object.customMetadata?.sha256 || "",
        },
      });
    }

    if (url.pathname === "/artifact" && request.method === "DELETE") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "missing key" }, 400);
      await env.ARTIFACTS.delete(key);
      return json({ ok: true, deleted: key });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
