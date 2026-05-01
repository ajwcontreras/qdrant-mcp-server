#!/bin/bash
# Reusable wrangler tail helper. Usage:
#   bash cloudflare-mcp/scripts/tail-worker.sh <worker-name> [--errors] [--search <text>] [timeout_secs]
# Examples:
#   bash cloudflare-mcp/scripts/tail-worker.sh cfcode-poc-31d-afan
#   bash cloudflare-mcp/scripts/tail-worker.sh cfcode-poc-31d-afan --errors
#   bash cloudflare-mcp/scripts/tail-worker.sh cfcode-poc-31d-afan --search "orch" 60
set -euo pipefail
WORKER="$1"; shift
FORMAT="pretty"
STATUS=""
SEARCH=""
TIMEOUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --errors) STATUS="--status error"; shift ;;
    --search) SEARCH="--search $2"; shift 2 ;;
    *) TIMEOUT="$1"; shift ;;
  esac
done

CFKEY=$(grep CF_GLOBAL_API_KEY /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/.cfapikeys | cut -d= -f2)
CFEMAIL=$(grep CF_EMAIL /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/.cfapikeys | cut -d= -f2)

CMD="CLOUDFLARE_API_KEY=$CFKEY CLOUDFLARE_EMAIL=$CFEMAIL unset CLOUDFLARE_API_TOKEN && npx wrangler tail $WORKER --format $FORMAT $STATUS $SEARCH"

echo "tail: $WORKER"
if [ -n "$TIMEOUT" ]; then
  timeout "$TIMEOUT" bash -c "$CMD" 2>&1 || true
else
  bash -c "$CMD" 2>&1
fi
