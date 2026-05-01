# lumae-fresh — Cloudflare MCP Code Search

## Indexed Path

`/Users/awilliamspcsevents/PROJECTS/lumae-fresh`

## MCP URL

```
https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp
```

## Current State

- **Active commit:** `poc-26d4-resume`
- **Last manifest ID:** `(none — no incremental job has run on this codebase yet)`

## Install — Claude Code

Add to `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lumae-fresh-code-search": {
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
    "lumae-fresh-code-search": {
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
    "lumae-fresh-code-search": {
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

Re-index the entire codebase from scratch (overwrites all chunks idempotently via deterministic IDs):

```bash
node cloudflare-mcp/scripts/poc-26d3-full-lumae-job.mjs
```

## Incremental Diff Reindex

Reindex only files that changed between two git refs. v1 reprocesses **whole changed files** (no sub-file chunk diffing) and tombstones deleted/renamed paths.

```bash
# 1. Generate diff manifest between two refs
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs --diff-base <base-ref> --diff-target HEAD

# 2. Package changed files (whole-file) + tombstones into a JSONL artifact
node cloudflare-mcp/scripts/poc-26e3-incremental-packager-smoke.mjs

# 3. Apply the artifact via /incremental-ingest (deactivates stale chunks,
#    queues re-embedding, advances stored git state on completion)
node cloudflare-mcp/scripts/poc-26e4-cloud-incremental-diff-smoke.mjs
```

Example with explicit refs:

```bash
# Reindex everything that changed since main
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs --diff-base main --diff-target HEAD
```

## Resume / Retry

Re-running any of the above commands is safe — the Worker uses deterministic chunk IDs and `INSERT OR REPLACE`, so already-published chunks are overwritten idempotently. Cloudflare Queues are at-least-once; the consumer is idempotent.

## Status Polling

```bash
# Per-job status (replace JOB_ID)
curl -s https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/jobs/JOB_ID/status | jq .

# Active publication metadata (active commit, vectorize index, etc.)
curl -s https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/collection_info | jq .

# Git state for this codebase (active commit, last applied manifest)
curl -s https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/git-state/lumae-fresh | jq .
```

## Architecture

- **Embeddings:** Google Vertex `gemini-embedding-001` at 1536 dimensions
- **Vector store:** Cloudflare Vectorize
- **Metadata:** Cloudflare D1 (authoritative for active rows / search filtering)
- **Artifacts:** Cloudflare R2
- **Fan-out:** Cloudflare Queues (at-least-once; consumer is idempotent)
- **Auth:** None (unauthenticated MCP endpoint)

## Important Notes for Agents

- **v1 incremental reprocesses whole changed files**, not sub-file chunks. A 1-line edit re-embeds the entire file.
- **Renames** are handled as tombstone(old path) + whole-file add(new path).
- **Deletes** are handled as tombstones — old chunks are soft-deleted (`active = 0`) in D1; Vectorize `deleteByIds` is async and may lag for seconds.
- **D1 `active = 1` rows are the authoritative source of truth.** The Worker cross-checks every Vectorize match against D1 before returning search results, so stale Vectorize entries do not appear.
- **Vectorize is eventually consistent** — newly indexed chunks may take up to ~60s to appear in search after publication.

Generated: 2026-05-01T04:18:21.974Z
