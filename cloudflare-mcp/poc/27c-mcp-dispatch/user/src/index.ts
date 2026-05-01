// POC 27C user worker — same idea as 27A, lives in the dispatch namespace.
// Adds an /echo endpoint so the gateway has something interesting to call.
type Env = { CFCODE_SLUG?: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/echo" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json({ ok: true, slug: env.CFCODE_SLUG, echoed: body });
    }
    return Response.json({ ok: true, slug: env.CFCODE_SLUG, path: url.pathname });
  },
};
