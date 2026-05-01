// POC 27A dispatcher worker — routes /<slug>/<path> to user workers
// in the configured dispatch namespace.
type Fetcher = { fetch(req: Request): Promise<Response> };
type DispatchNamespace = { get(name: string): Fetcher };
type Env = { DISPATCHER: DispatchNamespace };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "27a-dispatcher" });

    const m = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
    if (!m) return Response.json({ ok: false, error: "expected /<slug>/<path>" }, { status: 400 });
    const [, slug, rest = "/"] = m;

    let userWorker: Fetcher;
    try { userWorker = env.DISPATCHER.get(`cfcode-poc-27a-user-${slug}`); }
    catch { return Response.json({ ok: false, error: `unknown slug: ${slug}` }, { status: 404 }); }

    const downstreamUrl = new URL(rest, url.origin);
    const downstream = new Request(downstreamUrl, request);
    try {
      return await userWorker.fetch(downstream);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Workers for Platforms throws if the script doesn't exist
      if (/not found|does not exist/i.test(msg)) return Response.json({ ok: false, error: `unknown slug: ${slug}` }, { status: 404 });
      throw e;
    }
  },
};
