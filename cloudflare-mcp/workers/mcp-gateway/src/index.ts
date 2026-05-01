// cfcode MCP gateway — production stateful MCP server.
// Combines: D1 codebase registry + dispatch namespace routing + per-session
// codebase selection + search tool that proxies to the selected codebase's
// user worker (deployed in the dispatch namespace).
//
// MCP tools:
//   list_codebases()                — read registry
//   select_codebase(slug)           — bind session
//   current_codebase()              — read selection
//   search(query, topK?)            — POST /search to selected codebase
//
// Admin HTTP endpoints (used by cfcode CLI):
//   POST   /admin/register   {slug, indexed_path}
//   DELETE /admin/register/:slug
//   GET    /admin/codebases
//
// Naming convention: per-codebase user workers are deployed as
// `cfcode-codebase-<slug>` inside the dispatch namespace.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const USER_WORKER_PREFIX = "cfcode-codebase-";

type Fetcher = { fetch(req: Request): Promise<Response> };
type DispatchNamespace = { get(name: string): Fetcher };

type Env = {
  MCP_OBJECT: DurableObjectNamespace;
  REGISTRY: D1Database;
  DISPATCHER: DispatchNamespace;
};
type State = { slug: string | null };

async function ensureSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS codebase_registry (
    slug TEXT PRIMARY KEY,
    indexed_path TEXT NOT NULL,
    registered_at TEXT NOT NULL
  )`).run();
}

async function registerCodebase(db: D1Database, slug: string, indexedPath: string) {
  await ensureSchema(db);
  await db.prepare(
    `INSERT OR REPLACE INTO codebase_registry (slug, indexed_path, registered_at) VALUES (?, ?, ?)`
  ).bind(slug, indexedPath, new Date().toISOString()).run();
}

async function unregisterCodebase(db: D1Database, slug: string): Promise<number> {
  await ensureSchema(db);
  const result = await db.prepare(
    `DELETE FROM codebase_registry WHERE slug = ?`
  ).bind(slug).run() as { meta?: { changes?: number } };
  return result?.meta?.changes ?? 0;
}

async function listCodebases(db: D1Database): Promise<Array<{ slug: string; indexed_path: string; registered_at: string }>> {
  await ensureSchema(db);
  const rows = await db.prepare(
    `SELECT slug, indexed_path, registered_at FROM codebase_registry ORDER BY slug`
  ).all();
  return (rows.results || []) as Array<{ slug: string; indexed_path: string; registered_at: string }>;
}

export class CfcodeGateway extends McpAgent<Env, State> {
  server = new McpServer({ name: "cfcode-gateway", version: "1.0.0" });
  initialState: State = { slug: null };

  async init() {
    this.server.tool(
      "list_codebases",
      "List all indexed codebases registered with this gateway",
      {},
      async () => {
        const rows = await listCodebases(this.env.REGISTRY);
        if (rows.length === 0) return { content: [{ type: "text", text: "(no codebases registered)" }] };
        const text = rows.map(r => `- ${r.slug} :: ${r.indexed_path}`).join("\n");
        return { content: [{ type: "text", text: `${rows.length} codebase(s):\n${text}` }] };
      },
    );

    this.server.tool(
      "select_codebase",
      "Bind this MCP session to a codebase by slug. Subsequent search calls use it.",
      { slug: z.string() },
      async ({ slug }) => {
        // Verify slug exists in registry
        await ensureSchema(this.env.REGISTRY);
        const row = await this.env.REGISTRY.prepare(
          `SELECT slug FROM codebase_registry WHERE slug = ?`
        ).bind(slug).first();
        if (!row) {
          return { content: [{ type: "text", text: `ERROR: codebase "${slug}" is not registered. Use list_codebases to see available slugs.` }] };
        }
        this.setState({ slug });
        return { content: [{ type: "text", text: `selected: ${slug}` }] };
      },
    );

    this.server.tool(
      "current_codebase",
      "Show currently-selected codebase",
      {},
      async () => ({ content: [{ type: "text", text: this.state?.slug ?? "(none)" }] }),
    );

    this.server.tool(
      "search",
      "Semantic code search in the selected codebase. Call select_codebase first.",
      { query: z.string(), topK: z.number().int().min(1).max(50).optional() },
      async ({ query, topK }) => {
        const slug = this.state?.slug;
        if (!slug) {
          return { content: [{ type: "text", text: "ERROR: no codebase selected. Call select_codebase first." }] };
        }
        const userWorker = this.env.DISPATCHER.get(`${USER_WORKER_PREFIX}${slug}`);
        try {
          const res = await userWorker.fetch(new Request("https://internal/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, topK: topK || 10, repo_slug: slug }),
          }));
          const body = await res.json() as {
            ok: boolean;
            matches?: Array<{ chunk?: { file_path?: string; snippet?: string }; score?: number; id?: string }>;
            error?: string;
          };
          if (!body.ok) return { content: [{ type: "text", text: `ERROR from ${slug}: ${body.error || "unknown"}` }] };
          const matches = body.matches || [];
          const lines = [
            `${matches.length} match(es) in ${slug} for "${query}":`,
            ...matches.slice(0, 10).map((m, i) => {
              const fp = m.chunk?.file_path || "(unknown file)";
              const score = typeof m.score === "number" ? m.score.toFixed(3) : "?";
              const snippet = (m.chunk?.snippet || "").slice(0, 200).replace(/\n/g, " ");
              return `  ${i + 1}. [${score}] ${fp}\n     ${snippet}${snippet.length === 200 ? "..." : ""}`;
            }),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `ERROR dispatching to ${slug}: ${msg}` }] };
        }
      },
    );
  }
}

function json(v: unknown, status = 200) { return Response.json(v, { status }); }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-gateway", version: "1.0.0" });

    // MCP — both /mcp and /mcp/<anything> route here
    if (url.pathname.startsWith("/mcp")) {
      return CfcodeGateway.serve("/mcp").fetch(request, env, ctx);
    }

    // Admin: list codebases
    if (url.pathname === "/admin/codebases" && request.method === "GET") {
      const rows = await listCodebases(env.REGISTRY);
      return json({ ok: true, codebases: rows });
    }

    // Admin: register
    if (url.pathname === "/admin/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { slug?: string; indexed_path?: string };
      if (!body.slug || !body.indexed_path) return json({ ok: false, error: "slug and indexed_path required" }, 400);
      await registerCodebase(env.REGISTRY, body.slug, body.indexed_path);
      return json({ ok: true, slug: body.slug });
    }

    // Admin: unregister
    const m = url.pathname.match(/^\/admin\/register\/([^/]+)$/);
    if (m && request.method === "DELETE") {
      const changes = await unregisterCodebase(env.REGISTRY, m[1]);
      return json({ ok: true, slug: m[1], removed: changes });
    }

    // Admin: proxy any HTTP method/path to a registered codebase's user worker.
    // Used by `cfcode index` to send /ingest, by `cfcode reindex` for /incremental-ingest, etc.
    //   /admin/codebases/<slug>/<rest of path>
    const proxyMatch = url.pathname.match(/^\/admin\/codebases\/([^/]+)(\/.*)?$/);
    if (proxyMatch) {
      const [, slug, rest = "/"] = proxyMatch;
      const userWorker = env.DISPATCHER.get(`${USER_WORKER_PREFIX}${slug}`);
      const downstreamUrl = new URL(rest + url.search, "https://internal");
      try {
        const downstream = new Request(downstreamUrl, request);
        return await userWorker.fetch(downstream);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: `dispatch to ${slug} failed: ${msg}` }, 502);
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
