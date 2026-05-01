#!/bin/bash
# Auto-redeploy on file changes. Usage:
#   bash cloudflare-mcp/scripts/watch-deploy.sh <poc-dir> [worker-name]
# Example:
#   bash cloudflare-mcp/scripts/watch-deploy.sh cloudflare-mcp/poc/31f-code-vertex cfcode-poc-31f-codev
set -euo pipefail
POC_DIR="$1"
CFKEY=$(grep CF_GLOBAL_API_KEY .cfapikeys | cut -d= -f2)
CFEMAIL=$(grep CF_EMAIL .cfapikeys | cut -d= -f2)
export CLOUDFLARE_API_KEY="$CFKEY"
export CLOUDFLARE_EMAIL="$CFEMAIL"
unset CLOUDFLARE_API_TOKEN

echo "Watching $POC_DIR/src/ — auto-redeploy on change"
fswatch -o "$POC_DIR/src/" | while read _; do
  echo "--- $(date +%H:%M:%S) Change detected ---"
  cd "$POC_DIR"
  if npx tsc --noEmit 2>&1; then
    npx wrangler deploy --config wrangler.gen.jsonc 2>&1 | tail -3
    echo "deployed"
  else
    echo "typecheck failed"
  fi
  cd - > /dev/null
done
