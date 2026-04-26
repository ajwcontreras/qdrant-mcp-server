# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server providing semantic code search over Qdrant vector database with OpenAI embeddings. Two main Python scripts: an indexer that chunks codebases and stores multi-vector embeddings, and an MCP wrapper that serves hybrid search to Claude/MCP clients via stdio JSON-RPC.

## User Preferences

- **Voice-to-text user** — transcriptions can be ambiguous, ask when unclear.
- No glazing. Be objective, push back when wrong, flag cleanup debt proactively.
- Don't pivot mid-task on interruptions unless correcting a mistake. Finish what you're doing.
- Decisive, minimal-diff responses. Skip preamble.

## Commands

```bash
# Python — validate syntax (no test runner for Python yet beyond pytest)
venv/bin/python -m py_compile src/qdrant-openai-indexer.py
venv/bin/python -m py_compile src/mcp-qdrant-openai-wrapper.py

# Run indexer against a directory
python3 src/qdrant-openai-indexer.py /path/to/code

# Run MCP server (stdio, used by Claude Desktop)
python3 src/mcp-qdrant-openai-wrapper.py

# Node.js
npm test          # Jest (JS tests only)
npm run lint      # ESLint
npm run format    # Prettier

# Background indexer control
npm run start     # Start background file watcher
npm run stop      # Stop it
npm run status    # Check status

# Cloudflare Worker (openai-batch-worker/)
cd openai-batch-worker && npx wrangler deploy
```

## Architecture

### Two main entry points (both Python, no shared module — they duplicate constants)

1. **`src/qdrant-openai-indexer.py`** (~1550 lines) — `CodebaseIndexer` class
   - Discovers files via `git ls-files` + extension/size/path filtering
   - Chunks by lines (1500 chars, 200 overlap)
   - Extracts metadata: language, symbols (regex, not AST), imports, file_role, chunk_type, side_effects
   - Generates HyDE questions per chunk (12 targeted developer questions via OpenAI/Worker/precomputed JSONL)
   - Produces 4 vectors per chunk: `hyde_dense`, `code_dense`, `summary_dense`, `lexical_sparse`
   - Incremental: skips unchanged chunks by content_hash + hyde_version + metadata_version
   - Stale point cleanup with 20% safety cap
   - Supports Cloudflare Workers delegation for HyDE generation and embeddings

2. **`src/mcp-qdrant-openai-wrapper.py`** (~660 lines) — `MCPServer` class
   - Implements MCP protocol over stdio (JSON-RPC 2.0)
   - Exposes `search` and `collection_info` tools
   - Hybrid retrieval: Prefetch across all 4 vector channels → RRF fusion
   - Deterministic reranking with symbol/signature/path boosts
   - Returns: snippets, match_reasons, confidence, line_ranges, suggested follow-up queries
   - Graceful fallback to legacy single-vector `my-codebase` collection

### Supporting components

- **`src/qdrant-indexer-control.cjs`** — CLI for start/stop/status of background indexer
- **`src/qdrant-background-indexer.cjs`** — chokidar-based file watcher, triggers reindex on changes
- **`openai-batch-worker/`** — Cloudflare Worker for delegated HyDE/embedding generation (TypeScript)
- **`scripts/`** — Utility scripts for batch enrichment, benchmarks, project management

### Collections

- **`my-codebase-v2`** (target) — Named vectors: hyde_dense, code_dense, summary_dense + sparse lexical_sparse
- **`my-codebase`** (legacy) — Single unnamed dense vector, still supported by MCP wrapper

### Key constants shared between both Python files

Vector names, sparse hash config, collection names, and UUID namespace are duplicated. If you change one, change both.

## Handoff Discipline

Read `AGENT_HANDOFF_MASTER_PLAN.md` before making indexing, retrieval, benchmark, or enrichment changes. Update it after every meaningful unit of progress with timestamp, completed work, files touched, exact next step, and blockers.

## Environment Variables

```
OPENAI_API_KEY              # Required
QDRANT_URL                  # Default: http://localhost:6333
COLLECTION_NAME             # Default: my-codebase-v2
OPENAI_EMBEDDING_MODEL      # Default: text-embedding-3-large
OPENAI_HYDE_MODEL            # Default: gpt-5.4-nano
HYDE_QUESTION_COUNT          # Default: 12
CLOUDFLARE_AI_GATEWAY_URL    # Optional: embedding cache/routing
HYDE_WORKER_URL              # Optional: Cloudflare Worker for HyDE
EMBEDDING_WORKER_URL         # Optional: Cloudflare Worker for embeddings
HYDE_PRECOMPUTED_JSONL       # Optional: skip HyDE LLM calls
DIGEST_SIDECAR_JSONL         # Optional: metadata enrichment
```

## Design Constraints (from prior sessions)

- Point IDs use `uuid5(NAMESPACE, f"{rel_path}:{chunk_index}")` — NOT content_hash (would collide on duplicate code)
- HyDE cache key: `content_hash + hyde_version + hyde_model` — allows reuse across renames
- Line ranges are positional, excluded from semantic metadata hashes
- No Cloudflare Workflows — use DO alarms/R2/KV only if separately approved
- Max 20% stale point deletion per run (safety guard)
- Tree-sitter not installed; symbol extraction uses regex patterns
- Don't run expensive full reindex unless chunk text or embedding inputs actually changed
