# Lumae Fresh — Cloudflare MCP Code Search

## Indexed Path

`/Users/awilliamspcsevents/PROJECTS/lumae-fresh`

## MCP URL

```
https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp
```

## Install — Claude Code

Add to `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lumae-code-search": {
      "type": "url",
      "url": "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
    }
  }
}
```

## Install — Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lumae-code-search": {
      "type": "url",
      "url": "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
    }
  }
}
```

## Install — Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "lumae-code-search": {
      "url": "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
    }
  }
}
```

## Verify — curl

```bash
curl -s https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/collection_info | jq .
curl -s -X POST https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/search \
  -H "content-type: application/json" \
  -d '{"query": "flask routes chat", "topK": 5}' | jq .matches[].chunk.file_path
```

## Full Redo

```bash
node cloudflare-mcp/scripts/poc-26d3-full-lumae-job.mjs
```

## Resume / Retry

Re-running the full job command is safe — the Worker uses deterministic chunk IDs
and INSERT OR REPLACE, so already-published chunks are overwritten idempotently.

## Incremental Reindex (Planned — POC 26E)

```bash
# Not yet implemented. Will use git diff manifests for whole-file reprocessing.
node cloudflare-mcp/scripts/poc-26e-incremental-reindex.mjs --diff-base HEAD~1
```

## Architecture

- **Embeddings:** Google Vertex `gemini-embedding-001` at 1536 dimensions
- **Vector store:** Cloudflare Vectorize (`cfcode-lumae-fresh-v2`)
- **Metadata:** Cloudflare D1 (`cfcode-lumae-fresh-v2`)
- **Artifacts:** Cloudflare R2 (`cfcode-lumae-fresh-artifacts`)
- **Fan-out:** Cloudflare Queues (`cfcode-lumae-fresh-work`)
- **Auth:** None (unauthenticated MCP endpoint)

## Notes

- v1 incremental reindexing will reprocess whole changed files, not sub-file chunks.
- Vectorize deletes are eventually consistent — stale vectors may appear briefly in search results.
- D1 `active = 1` rows are the authoritative source of truth for search filtering.

Generated: 2026-04-30T17:23:58.114Z
