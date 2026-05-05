#!/usr/bin/env node
// Use the official MCP SDK client to talk to our gateway exactly like
// Claude Code would. If this fails, the bug is in our server. If this works
// but Claude Code fails, the bug is in Claude Code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TARGET = process.argv[2] || "https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp";
console.log(`→ Connecting MCP SDK client to ${TARGET}`);

const transport = new StreamableHTTPClientTransport(new URL(TARGET));
const client = new Client({ name: "27h-debug", version: "0.1" }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log("✓ connected");
} catch (e) {
  console.error("❌ connect failed:", e?.message || e);
  if (e?.cause) console.error("  cause:", e.cause?.message || e.cause);
  process.exit(1);
}

try {
  const tools = await client.listTools();
  console.log(`✓ tools/list returned ${tools.tools.length} tools:`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);
} catch (e) {
  console.error("❌ tools/list failed:", e?.message || e);
  process.exit(1);
}

try {
  const r = await client.callTool({ name: "list_codebases", arguments: {} });
  console.log("✓ list_codebases →");
  for (const c of r.content || []) console.log(`  ${c.text}`);
} catch (e) {
  console.error("❌ list_codebases failed:", e?.message || e);
  process.exit(1);
}

try {
  const r = await client.callTool({ name: "select_codebase", arguments: { slug: "qdrant-mcp-server" } });
  const text = (r.content || []).map(c => c.text || "").join("\n");
  if (!/selected(?: codebase)?: qdrant-mcp-server/i.test(text)) throw new Error(text || "unexpected select_codebase response");
  console.log("✓ select_codebase(qdrant-mcp-server)");
} catch (e) {
  console.error("❌ select_codebase failed:", e?.message || e);
  process.exit(1);
}

try {
  const r = await client.callTool({ name: "search", arguments: { query: "how does cfcode search work", topK: 3 } });
  const text = (r.content || []).map(c => c.text || "").join("\n");
  if (!/result|score|file|path/i.test(text)) throw new Error(text.slice(0, 500) || "empty search response");
  console.log("✓ search(qdrant-mcp-server) returned results");
} catch (e) {
  console.error("❌ search failed:", e?.message || e);
  process.exit(1);
}

await client.close();
console.log("✅ MCP SDK client round-trip succeeded");
