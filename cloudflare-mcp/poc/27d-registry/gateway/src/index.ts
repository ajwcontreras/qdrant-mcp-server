// POC 27D: McpAgent gateway with D1 codebase registry.
// Adds register_codebase / list_codebases / unregister_codebase tools.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  MCP_OBJECT: DurableObjectNamespace;
  REGISTRY: D1Database;
};
type State = { slug: string | null };

async function ensureSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS codebase_registry (
    slug TEXT PRIMARY KEY,
    indexed_path TEXT NOT NULL,
    registered_at TEXT NOT NULL
  )`).run();
}

export class CfcodeRegistry extends McpAgent<Env, State> {
  server = new McpServer({ name: "cfcode-27d-registry", version: "0.1.0" });
  initialState: State = { slug: null };

  async init() {
    this.server.tool(
      "register_codebase",
      "Register a codebase by slug + indexed local path",
      { slug: z.string(), indexed_path: z.string() },
      async ({ slug, indexed_path }) => {
        await ensureSchema(this.env.REGISTRY);
        await this.env.REGISTRY.prepare(
          `INSERT OR REPLACE INTO codebase_registry (slug, indexed_path, registered_at) VALUES (?, ?, ?)`
        ).bind(slug, indexed_path, new Date().toISOString()).run();
        return { content: [{ type: "text", text: `registered: ${slug}` }] };
      },
    );

    this.server.tool(
      "list_codebases",
      "List all registered codebases",
      {},
      async () => {
        await ensureSchema(this.env.REGISTRY);
        const rows = await this.env.REGISTRY.prepare(
          `SELECT slug, indexed_path, registered_at FROM codebase_registry ORDER BY slug`
        ).all();
        const list = (rows.results || []).map(r => `- ${r.slug} :: ${r.indexed_path}`).join("\n");
        return { content: [{ type: "text", text: list || "(no codebases registered)" }] };
      },
    );

    this.server.tool(
      "unregister_codebase",
      "Remove a codebase from the registry",
      { slug: z.string() },
      async ({ slug }) => {
        await ensureSchema(this.env.REGISTRY);
        const result = await this.env.REGISTRY.prepare(
          `DELETE FROM codebase_registry WHERE slug = ?`
        ).bind(slug).run() as { meta?: { changes?: number } };
        const changes = result?.meta?.changes ?? 0;
        return { content: [{ type: "text", text: changes > 0 ? `unregistered: ${slug}` : `not found: ${slug}` }] };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cfcode-27d-registry" });
    if (url.pathname.startsWith("/mcp")) return CfcodeRegistry.serve("/mcp").fetch(request, env, ctx);
    return new Response("not found", { status: 404 });
  },
};
