// POC 27E gateway: search tool routes to selected codebase via dispatch.
// Tools:
//   select_codebase(slug)
//   current_codebase()
//   search(query)         — POSTs {query} to selected codebase's /search,
//                           returns matches in MCP response shape.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Fetcher = { fetch(req: Request): Promise<Response> };
type DispatchNamespace = { get(name: string): Fetcher };
type Env = {
  MCP_OBJECT: DurableObjectNamespace;
  DISPATCHER: DispatchNamespace;
};
type State = { slug: string | null };

export class CfcodeSearchGateway extends McpAgent<Env, State> {
  server = new McpServer({ name: "cfcode-27e-gateway", version: "0.1.0" });
  initialState: State = { slug: null };

  async init() {
    this.server.tool(
      "select_codebase",
      "Bind this MCP session to a codebase",
      { slug: z.string() },
      async ({ slug }) => {
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
      "Semantic code search in the selected codebase",
      { query: z.string(), topK: z.number().int().min(1).max(50).optional() },
      async ({ query, topK }) => {
        const slug = this.state?.slug;
        if (!slug) {
          return { content: [{ type: "text", text: "ERROR: no codebase selected. Call select_codebase first." }] };
        }
        const userWorker = this.env.DISPATCHER.get(`cfcode-poc-27e-user-${slug}`);
        try {
          const res = await userWorker.fetch(new Request("https://internal/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, topK }),
          }));
          const body = await res.json() as { ok: boolean; matches?: Array<Record<string, unknown>>; error?: string };
          if (!body.ok) {
            return { content: [{ type: "text", text: `ERROR from ${slug}: ${body.error || "unknown"}` }] };
          }
          // Render matches as a structured text payload (MCP content blocks)
          const matches = body.matches || [];
          const lines = [
            `${matches.length} match(es) in ${slug} for "${query}":`,
            ...matches.map((m, i) => `  ${i + 1}. [${m.score}] ${m.file_path} :: ${m.chunk_id}`),
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cfcode-27e-gateway" });
    if (url.pathname.startsWith("/mcp")) return CfcodeSearchGateway.serve("/mcp").fetch(request, env, ctx);
    return new Response("not found", { status: 404 });
  },
};
