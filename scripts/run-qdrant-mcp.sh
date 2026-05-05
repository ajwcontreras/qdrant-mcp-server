#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server"
FALLBACK_ENV="/Users/awilliamspcsevents/PROJECTS/lumae-fresh/.env"

export QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
export QDRANT_AUTO_PROJECT_COLLECTION="${QDRANT_AUTO_PROJECT_COLLECTION:-true}"
export QDRANT_CODE_SEARCH_HOME="${QDRANT_CODE_SEARCH_HOME:-/Users/awilliamspcsevents/.qdrant-code-search}"
export OPENAI_EMBEDDING_MODEL="${OPENAI_EMBEDDING_MODEL:-text-embedding-3-large}"

if [[ -z "${OPENAI_API_KEY:-}" && -f "$FALLBACK_ENV" ]]; then
  key_line="$(grep -E '^OPENAI_API_KEY=' "$FALLBACK_ENV" | tail -n 1 || true)"
  if [[ -n "$key_line" ]]; then
    export OPENAI_API_KEY="${key_line#OPENAI_API_KEY=}"
  fi
fi

exec "$ROOT/venv/bin/python3" -u "$ROOT/src/mcp-qdrant-openai-wrapper.py"
