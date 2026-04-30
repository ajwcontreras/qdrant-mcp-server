# lumae-fresh MCP Code Search

Remote MCP code search for the indexed codebase at:

`/Users/awilliamspcsevents/PROJECTS/lumae-fresh`

MCP URL:

`https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`

Active publication: `pub-19e2c2bf4fdc8521e63af051f55d75a8`  
Active embedding run: `19e2c2bf4fdc8521e63af051f55d75a8`  
Vectorize index: `cfcode-lumae-hyde-1536-redo-b`  
Generated: 2026-04-30

## Try It In 30 Seconds

Claude Code:

```bash
claude mcp add --transport http lumae-fresh-code https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp -s user
```

Then ask:

> Where is borrower document upload handled?

## Connect Your Client

All configs point to:

`https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`

### Claude Code

```bash
claude mcp add --transport http lumae-fresh-code https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp -s user
```

### Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lumae-fresh-code": {
      "url": "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
    }
  }
}
```

### Cursor

File: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "lumae-fresh-code": {
      "url": "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
    }
  }
}
```

### Any MCP Client

```bash
curl -X POST https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"collection_info","arguments":{}}}'
```

## Incremental Reindex

Run from this repository:

```bash
node cloudflare-mcp/scripts/index-codebase.mjs \
  --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" \
  --repo-slug "lumae-fresh" \
  --mode incremental \
  --diff-base origin/main \
  --resume
```

This command must:

- detect changed, added, renamed, and deleted files from Git diffs;
- reuse unchanged chunk artifacts by `chunk_identity`;
- reuse HyDE artifacts by `content_hash + hyde_version + hyde_model`;
- create a new embedding run only for changed embedding inputs;
- publish to a new Vectorize index and switch active publication only after verification.

## Resume A Failed Index

```bash
node cloudflare-mcp/scripts/index-codebase.mjs \
  --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" \
  --repo-slug "lumae-fresh" \
  --resume
```

## Full Rebuild

```bash
node cloudflare-mcp/scripts/index-codebase.mjs \
  --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" \
  --repo-slug "lumae-fresh" \
  --mode full \
  --embedding-model gemini-embedding-001 \
  --dimensions 1536 \
  --resume
```

## Tools

- `search`: hybrid code search with snippets, line spans, scores, and match reasons.
- `collection_info`: active backend, indexed path, publication, and embedding metadata.
- `get_chunk`: fetch a chunk by identity.
- `suggest_queries`: generate follow-up search queries.
