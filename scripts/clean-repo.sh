#!/usr/bin/env bash
# cfcode repo cleanup — strip bloat, keep essentials.
set -euo pipefail
cd /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server

echo "=== Root junk ==="
rm -f .DS_Store
rm -f .qdrant-indexed-files.json .qdrant-indexer.log .qdrant-indexing-queue.json .qdrant-indexing-status.json
rm -f COUNCIL_DIGEST_ENRICHED_EMBEDDING_REQUEST.md COUNCIL_INCREMENTAL_INDEXING_SANITY_REQUEST.md
rm -f COUNCIL_JSON_EXTRACTION_ALGORITHMS_REQUEST.md COUNCIL_RESEARCH_NEXT_STEPS_BRIEF.md
rm -f COUNCIL_RETRIEVAL_IMPROVEMENT_REQUEST.md COUNCIL_RETRIEVAL_QUALITY_BRIEF.md
rm -f CLOUDFLARE_FIRST_EXECUTION_PLAN.md MEMORY.md CONTRIBUTING.md setup.py CHANGELOG.md
rm -rf .council-docs/

echo "=== ephemeral/ — keep only utility scripts ==="
cd ephemeral
for f in *.md *.txt normalize-agent-skills.mjs generate-handoff-*.mjs; do rm -f "$f"; done
cd ..

echo "=== scripts/ — keep only shell + JS, dump Python ==="
cd scripts
rm -rf __pycache__ || true
rm -f deepseek_hyde_batch.py deepseek_json_batch_sweep.py gemini_hyde_batch.py
rm -f gemini_hyde_quality_smoke.py generate_digest_sidecar.py
rm -f inspect_hyde_jsonl.py inspect_index_scope.py backfill_hyde_jsonl_hashes.py
cd ..

echo "=== src/ — dump legacy Python cruft ==="
cd src
rm -rf __pycache__ || true
rm -f qdrant-openai-indexer.py.bak-20260421164302
rm -f qdrant-background-indexer.cjs qdrant-indexer-control.cjs
cd ..

echo "=== POC dirs — strip .wrangler/ node_modules/ generated configs bench JSONs ==="
for pocdir in cloudflare-mcp/poc/*/; do
  rm -rf "${pocdir}.wrangler" 2>/dev/null || true
  rm -rf "${pocdir}node_modules" 2>/dev/null || true
  rm -f "${pocdir}wrangler.generated.jsonc" "${pocdir}wrangler.gen.jsonc" 2>/dev/null || true
  rm -f "${pocdir}bench-"*.json "${pocdir}poll-log.jsonl" 2>/dev/null || true
  rm -f "${pocdir}package-lock.json" 2>/dev/null || true
done

echo "=== cloudflare-mcp/sessions/ — dump eval artifacts ==="
rm -rf cloudflare-mcp/sessions/ 2>/dev/null || true

echo "=== benchmarks/ — dump eval output ==="
rm -rf benchmarks/ 2>/dev/null || true

echo "=== tests/ — dump legacy ==="
rm -rf tests/ 2>/dev/null || true

echo "=== openai-batch-worker/ — dump legacy ==="
rm -rf openai-batch-worker/ 2>/dev/null || true

echo ""
echo "Done. Remaining files:"
find . -maxdepth 1 -type f | sort
echo ""
echo "ephemeral/:" && ls ephemeral/
echo "scripts/:" && ls scripts/
