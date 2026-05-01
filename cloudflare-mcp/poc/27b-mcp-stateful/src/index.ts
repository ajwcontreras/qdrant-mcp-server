// POC 27B: stateful MCP server via McpAgent (DO-backed).
// Two tools: set_value(s) writes state, get_value() reads it back.
// Proves session state persists across MCP tool calls.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = { MCP_OBJECT: DurableObjectNamespace };
type State = { value: string | null };

export class CfcodeMcp extends McpAgent<Env, State> {
  server = new McpServer({ name: "cfcode-27b", version: "0.1.0" });
  initialState: State = { value: null };

  async init() {
    this.server.tool(
      "set_value",
      "Set the per-session value",
      { value: z.string() },
      async ({ value }) => {
        this.setState({ value });
        return { content: [{ type: "text", text: `value set to: ${value}` }] };
      },
    );

    this.server.tool(
      "get_value",
      "Get the current per-session value",
      {},
      async () => {
        const v = this.state?.value ?? "(unset)";
        return { content: [{ type: "text", text: `current value: ${v}` }] };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cfcode-27b" });
    if (url.pathname.startsWith("/mcp")) {
      return CfcodeMcp.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },
};
