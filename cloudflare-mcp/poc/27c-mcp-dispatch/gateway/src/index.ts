// POC 27C gateway: McpAgent on DO + dispatch namespace.
// Tools:
//   select_codebase(slug)   — bind the session to a codebase
//   current_codebase()       — read which codebase is selected
//   proxy_call(method, path) — call selected codebase's user worker via dispatch
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

export class CfcodeGateway extends McpAgent<Env, State> {
  server = new McpServer({ name: "cfcode-27c-gateway", version: "0.1.0" });
  initialState: State = { slug: null };

  async init() {
    this.server.tool(
      "select_codebase",
      "Bind this MCP session to a codebase by slug",
      { slug: z.string() },
      async ({ slug }) => {
        this.setState({ slug });
        return { content: [{ type: "text", text: `selected codebase: ${slug}` }] };
      },
    );

    this.server.tool(
      "current_codebase",
      "Return the currently-selected codebase slug",
      {},
      async () => ({
        content: [{ type: "text", text: `current codebase: ${this.state?.slug ?? "(none)"}` }],
      }),
    );

    this.server.tool(
      "proxy_call",
      "Call the selected codebase's user worker through the dispatch namespace",
      { method: z.string(), path: z.string(), body: z.any().optional() },
      async ({ method, path, body }) => {
        const slug = this.state?.slug;
        if (!slug) return { content: [{ type: "text", text: "ERROR: no codebase selected. Call select_codebase first." }] };
        const userWorker = this.env.DISPATCHER.get(`cfcode-poc-27c-user-${slug}`);
        const url = new URL(path, "https://internal");
        const init: RequestInit = { method };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
          init.headers = { "content-type": "application/json" };
        }
        try {
          const res = await userWorker.fetch(new Request(url, init));
          const text = await res.text();
          return { content: [{ type: "text", text: `${res.status}: ${text}` }] };
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
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cfcode-27c-gateway" });
    if (url.pathname.startsWith("/mcp")) return CfcodeGateway.serve("/mcp").fetch(request, env, ctx);
    return new Response("not found", { status: 404 });
  },
};
