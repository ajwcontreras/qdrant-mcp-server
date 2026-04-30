import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";

type Env = {
  REPO_SLUG?: string;
  ACTIVE_PUBLICATION_ID?: string;
  ACTIVE_EMBEDDING_RUN_ID?: string;
  VECTORIZE_INDEX?: string;
};

function createServer(env: Env) {
  const server = new McpServer({ name: `cfcode-${env.REPO_SLUG || "unknown"}`, version: "0.1.0" });
  server.tool("collection_info", "Describe the codebase served by this MCP URL.", {}, async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        backend: "cloudflare",
        repo_slug: env.REPO_SLUG,
        active_publication_id: env.ACTIVE_PUBLICATION_ID,
        active_embedding_run_id: env.ACTIVE_EMBEDDING_RUN_ID,
        vectorize_index: env.VECTORIZE_INDEX,
        auth: "none",
        mcp_route: "/mcp",
      }, null, 2),
    }],
  }));
  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    return createMcpHandler(createServer(env), { route: "/mcp" })(request, env, ctx);
  },
};
