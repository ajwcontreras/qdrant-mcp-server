# cfcode Setup Guide

Complete setup from zero to indexed codebase. No ambiguity. Follow in order.

## Prerequisites

```bash
# Node.js 20+
node --version  # must be >= 20

# npm
npm --version

# Wrangler CLI (Cloudflare Workers)
npm install -g wrangler
wrangler --version  # should be >= 4.0

# git
git --version

# jq (for JSON parsing in scripts, optional)
brew install jq  # macOS
```

## 1. Cloudflare Account

Sign up at https://dash.cloudflare.com/sign-up. You need:

- **Workers Paid plan** ($5/month) — required for D1, Durable Objects, and 10K subrequests
- **Workers for Platforms** ($25/month) — required for the dispatch namespace that holds per-codebase workers

Once created, note your:
- Account ID: found at `https://dash.cloudflare.com` → right sidebar
- Email: your Cloudflare login email

Create an API token at https://dash.cloudflare.com/profile/api-tokens:
- Template: "Edit Cloudflare Workers"
- Account Resources: your account
- Zone Resources: All zones

Save the token as `CLOUDFLARE_API_TOKEN`. Alternatively, get your Global API Key from https://dash.cloudflare.com/profile/api-tokens and use `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`.

## 2. Vertex AI Service Accounts (Google Cloud)

The pipeline uses Vertex AI `gemini-embedding-001` for embedding code chunks. You need at least one Google Cloud service account with Vertex AI access.

### Single SA setup (minimum)

1. Go to https://console.cloud.google.com
2. Create a project (or use existing)
3. Enable Vertex AI API:
   ```bash
   gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
   ```
4. Create a service account:
   ```bash
   gcloud iam service-accounts create cfcode-vertex \
     --project=YOUR_PROJECT_ID \
     --display-name="cfcode Vertex AI"
   ```
5. Grant Vertex AI user role:
   ```bash
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
     --member="serviceAccount:cfcode-vertex@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/aiplatform.user"
   ```
6. Create and download a JSON key:
   ```bash
   gcloud iam service-accounts keys create ~/cfcode-sa.json \
     --iam-account=cfcode-vertex@YOUR_PROJECT_ID.iam.gserviceaccount.com
   ```
7. **Store the JSON securely.** The key file is your credential. Mode 0600 recommended:
   ```bash
   chmod 600 ~/cfcode-sa.json
   ```

### Multiple SAs (for higher throughput)

Create 2-4 SA keys following the same pattern. Each SA gets its own GCP project for independent Vertex quotas. (SA3 and SA4 can share a billing account — quotas are per-project.)

Store all SA JSONs in a dedicated directory:
```bash
mkdir -p ~/.config/cfcode/sas
chmod 700 ~/.config/cfcode/sas
cp ~/cfcode-sa.json ~/.config/cfcode/sas/
# repeat for additional SAs
```

## 3. DeepSeek API Key (for HyDE question generation)

1. Sign up at https://platform.deepseek.com
2. Create an API key at https://platform.deepseek.com/api_keys
3. Save the key (starts with `sk-`)

No subscription needed — pay-per-token. With prompt caching (`deepseek-v4-flash`), one full codebase HyDE pass costs ~$0.50-1.

## 4. Local Configuration

### `.cfapikeys` file

Create at the repo root (gitignored):

```
CF_GLOBAL_API_KEY=cfk_your_global_api_key_here
CF_EMAIL=you@example.com
CF_ACCOUNT_ID=your_32_char_account_id
DEEPSEEK_API_KEY=sk-your_deepseek_key_here
```

**Alternative:** Use environment variables instead:
```bash
export CLOUDFLARE_API_KEY=cfk_...
export CLOUDFLARE_EMAIL=you@example.com
export CLOUDFLARE_ACCOUNT_ID=...
export DEEPSEEK_API_KEY=sk-...
```

### SA key paths

The CLI and bench scripts reference SA keys by path. Update these paths in the scripts or use the standard locations:
- SA1: `~/.config/cfcode/sas/team (1).json`
- SA2: `~/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json`

For your own SAs, edit the references in `cloudflare-mcp/cli/cfcode.mjs` and the bench scripts.

## 5. Clone and Install

```bash
git clone https://github.com/ajwcontreras/qdrant-mcp-server.git
cd qdrant-mcp-server

npm install

# Symlink the CLI
mkdir -p ~/bin
ln -sf "$PWD/cloudflare-mcp/cli/cfcode.mjs" ~/bin/cfcode
chmod +x cloudflare-mcp/cli/cfcode.mjs

# Verify
cfcode --help
```

## 6. Deploy the Gateway (one-time)

The MCP gateway is a single Cloudflare Worker that routes all MCP traffic. Deploy once, never touch again.

```bash
cd cloudflare-mcp/workers/mcp-gateway
npm install
npx wrangler deploy --config wrangler.generated.jsonc
```

Note the URL — it'll be `https://cfcode-gateway.<your-subdomain>.workers.dev/mcp`.

## 7. Deploy the Dispatch Namespace

```bash
# Create the dispatch namespace (one-time)
npx wrangler dispatch-namespace create cfcode-codebases
```

## 8. Index a Codebase

```bash
# Full index with HyDE (the full pipeline)
cfcode index ~/PROJECTS/myrepo

# Code-only (fast, no HyDE questions)
cfcode index ~/PROJECTS/myrepo --no-hyde

# Check status
cfcode status myrepo
```

What happens during `cfcode index`:
1. CLI walks the repo, builds ~1.5K-char chunks per file, creates a JSONL artifact
2. CLI uploads the artifact to the gateway
3. Gateway creates CF resources (R2 bucket, D1 database, Vectorize index)
4. Gateway deploys a per-codebase worker in the dispatch namespace
5. Worker processes chunks: Vertex embed → Vectorize + D1 insert
6. Worker generates HyDE questions via DeepSeek → Vertex embed → Vectorize + D1 insert
7. Code chunks become searchable in ~10s; HyDE completes in ~30-70s

## 9. Install the MCP Gateway in Your Agent

### Claude Code

```bash
node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.mcpServers = c.mcpServers || {};
c.mcpServers.cfcode = { type: "http", url: "https://cfcode-gateway.<your-subdomain>.workers.dev/mcp" };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
```

Then **fully quit + relaunch** Claude Code. NOT `/reset` — full process restart.

**Gotcha:** MCP config lives in `~/.claude.json`, NOT `~/.claude/settings.json`. Both files exist.

### Cursor / Other MCP Clients

Add to your MCP configuration:
```json
{
  "mcpServers": {
    "cfcode": {
      "type": "http",
      "url": "https://cfcode-gateway.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

## 10. Usage

Once the gateway is registered, you have these MCP tools:
```
list_codebases
select_codebase({ slug: "myrepo" })
search({ query: "how is auth implemented", topK: 5 })
current_codebase
```

In Claude Code: "list my codebases" → "select myrepo" → "search for password reset flow"

## 11. Reindexing

```bash
# Reindex after code changes (diff-based, only processes changed files)
cfcode reindex ~/PROJECTS/myrepo

# Regenerate HyDE questions for existing chunks
# (useful after updating the HyDE model or fixing generation bugs)
curl -X POST https://cfcode-gateway.<your-subdomain>.workers.dev/admin/codebases/myrepo/hyde-enrich \
  -H "content-type: application/json" \
  -d '{"job_id": "rehyde-1", "artifact_key": "path/to/artifact.jsonl"}'
```

## 12. Uninstall a Codebase

```bash
cfcode uninstall ~/PROJECTS/myrepo
# Tears down per-codebase Worker, R2, D1, Vectorize, removes from registry
```

## 13. Troubleshooting

### Worker deploy fails with D1 binding error
The D1 database ID in `wrangler.gen.jsonc` is stale. Delete the generated config and re-run `cfcode index`. It'll regenerate with fresh resource IDs.

### Search returns no results
Vectorize is eventually consistent — new vectors take 30-60s to become queryable. Wait, then retry. Also check `cfcode status` to confirm chunks are published.

### Vertex API 401 / UNAUTHENTICATED
Your SA key is invalid or the JWT signing is broken. Verify the SA JSON has `private_key` and `client_email` fields. Check that Vertex AI API is enabled on the GCP project.

### DeepSeek API 400
The model `deepseek-v4-flash` with `response_format: { type: "json_object" }` requires a valid system prompt. If you changed the prompt, verify it produces valid JSON.

### `ctx.waitUntil` work doesn't complete
`ctx.waitUntil` has a 30-second cap after the response is sent. Long-running work (>30s) must use Durable Object alarms or Cloudflare Queues, not `waitUntil`.

### DO storage `put` silently fails
DO storage has a 128KB per-key value limit. Storing large objects (like full artifact JSONL) will silently fail. Reference data by key and store config only.

### Wrangler picks wrong account
If you have multiple Cloudflare accounts, wrangler may pick the wrong one. Check with `npx wrangler whoami`. Force the correct account with:
```bash
CLOUDFLARE_API_KEY=$CF_GLOBAL_API_KEY CLOUDFLARE_EMAIL=$CF_ACCOUNT_EMAIL npx wrangler deploy
```
Or set `account_id` in your wrangler config.

## 14. Benchmarks

To reproduce the Phase 31 benchmarks against the lumae test corpus:

```bash
# Code-only indexing (no HyDE)
node cloudflare-mcp/scripts/poc-31f-code-vertex-bench.mjs

# Full dual fan-out (code + HyDE)  
node cloudflare-mcp/scripts/poc-31k-2pop-bench.mjs

# Rate limit measurements
node cloudflare-mcp/scripts/poc-31i-rate-measure-smoke.mjs

# E2E on a specific codebase
node cloudflare-mcp/scripts/poc-31k-e2e-cfpubsub.mjs
```

Each script creates throwaway resources, runs the benchmark, writes results to a bench JSON file, and cleans up. No production resources touched.
