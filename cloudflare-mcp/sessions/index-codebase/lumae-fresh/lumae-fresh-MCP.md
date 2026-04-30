# lumae-fresh MCP Code Search

Indexed path: `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`

MCP URL: `https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`

```bash
claude mcp add --transport http lumae-fresh-code https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp -s user
```

```json
{"mcpServers":{"lumae-fresh-code":{"url":"https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"}}}
```

Incremental resumable reindex:

```bash
node cloudflare-mcp/scripts/index-codebase.mjs --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" --repo-slug lumae-fresh --mode incremental --diff-base HEAD --resume --publish-url "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/ingest" --mcp-url "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
```

Full redo with the same Google 1536d embedding target:

```bash
node cloudflare-mcp/scripts/index-codebase.mjs --repo "/Users/awilliamspcsevents/PROJECTS/lumae-fresh" --repo-slug lumae-fresh --mode full --resume --publish-url "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/ingest" --mcp-url "https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp"
```

Artifacts are stored under `cloudflare-mcp/sessions/index-codebase/lumae-fresh`. Chunk and HyDE files are embedding-agnostic; changing the embedding model or dimension creates a new embedding run without regenerating those artifacts.
