# AGENTS.md

Repository guidance for coding agents working in this repo.

## Commands

```bash
npm run index
npm run project
npm run status
npm run start
npm run stop
npm test
```

Python implementation files should be checked with the local venv when available:

```bash
venv/bin/python -m py_compile src/qdrant-openai-indexer.py src/mcp-qdrant-openai-wrapper.py
```

## Handoff Discipline

- Read `AGENT_HANDOFF_MASTER_PLAN.md` before making indexing, retrieval, benchmark, or enrichment changes.
- After every meaningful unit of progress, update `AGENT_HANDOFF_MASTER_PLAN.md` with timestamp, completed work, files touched, exact next step, and blockers.
- Update handoff state atomically using a temp file plus rename when scripting.
- Do not assume running MCP or indexer processes reflect the current source. Restart or inspect process state after edits.

## Current Architecture Direction

- Legacy collection: `my-codebase`.
- Target collection: `my-codebase-v2`.
- Target vectors: `hyde_dense`, `code_dense`, `summary_dense`, and sparse `lexical_sparse`.
- Retrieval should fuse dense, sparse, symbol/path, and deterministic reranking signals.
- Agent-facing MCP responses should include snippets, match reasons, confidence, line spans, and suggested follow-up queries where available.

## Incremental Indexing Rules

- Do not use `content_hash` as the Qdrant point ID. Identical code copied across different files would collide.
- Use a stable logical `chunk_identity` for point IDs, typically via deterministic UUID/hash over repo, path, chunk kind, symbol or route identity, and chunker version.
- Store raw `chunk_identity` in payload for debugging and migration.
- Use `content_hash + hyde_version + hyde_model` as the HyDE cache key so moved/renamed identical chunks can reuse generated questions.
- Keep line ranges positional. Do not include `start_line`, `end_line`, or `line_range` in semantic metadata hashes.
- For line-only chunking, avoid over-engineering fake stable identities. Re-key HyDE JSONL/cache by content hash first, then move to AST identities when AST chunking is real.
- Prefer shadow/new collection migrations over in-place point ID rewrites.

## DeepSeek Enrichment Findings

- `scripts/deepseek_json_batch_sweep.py` is the batch enrichment runner used in the session.
- Safe production default observed: about 35 entries per DeepSeek request.
- Seven concurrent launcher requests worked in testing, but provider/platform failures still need retry handling.
- Use hard timeouts around provider calls. A 210 second timeout was added during the session to prevent hangs.
- Prefer deterministic JSON repair for parse issues before asking another LLM to repair model output.
- Treat enrichment quality as unproven until sampled. Parseability and count are not enough.

## Dynamic Workers Benchmark Context

- `dynamic-workers` was used as a benchmark target for digest and enrichment experiments.
- Digest sidecar integration worked mechanically, but `dynamic-workers-digest-summary-v1` did not beat the Flash baseline in the sampled metrics.
- The suspected next fixes are better file-role filtering, exact symbol boosts, downweighting generated/test/demo/battle-result chunks, and stronger query-time reranking.

## User Constraints

- Cloudflare Workflows were explicitly ruled out for the worker indexing architecture in this context.
- Use Durable Objects alarms, R2, KV, and optionally Queues only if separately approved.
- The system should become script-first with machine-readable outputs, not only agent-orchestrated markdown instructions.
- Do not run expensive full reindexing unless the change genuinely requires new chunk text or new embedding inputs.
