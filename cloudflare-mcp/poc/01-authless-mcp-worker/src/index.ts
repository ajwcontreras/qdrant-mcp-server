import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "cfcode-poc-01-authless-mcp",
    version: "0.1.0",
  });

  server.tool("ping", "Check whether the throwaway MCP Worker is alive.", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  server.tool(
    "echo",
    "Echo a short message through the throwaway MCP Worker.",
    { message: z.string().max(200) },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    }),
  );

  return server;
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    const server = createServer();
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};
