// POC 27A user worker — deployed into a dispatch namespace.
// Returns its own slug + path so the dispatcher can prove routing worked.
type Env = { CFCODE_SLUG?: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      slug: env.CFCODE_SLUG || "(unset)",
      path: url.pathname,
      method: request.method,
    });
  },
};
