// POC 27E user worker — stub codebase worker that returns canned search results.
// In production this would be the canonical per-codebase Worker that searches
// its Vectorize+D1. Here we just echo the query and return fake matches with
// the slug embedded so we can prove routing.
type Env = { CFCODE_SLUG?: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/search" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { query?: string };
      const query = body?.query || "(no query)";
      const slug = env.CFCODE_SLUG || "(unset)";
      return Response.json({
        ok: true,
        repo_slug: slug,
        query,
        matches: [
          { chunk_id: `chunk-${slug}-1`, score: 0.91, file_path: `${slug}/file_a.py`, snippet: `// match for: ${query}` },
          { chunk_id: `chunk-${slug}-2`, score: 0.83, file_path: `${slug}/file_b.py`, snippet: `// another match` },
        ],
      });
    }
    return Response.json({ ok: true, slug: env.CFCODE_SLUG, path: url.pathname });
  },
};
