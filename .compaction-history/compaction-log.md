

---
## Compaction — 2026-05-09T18:30:18.047Z
**Session:** ses_218e0368affeFuKLjzW7k6JmBa

## Goal
- Complete the Workers AI migration: replace Vertex embedding with Cloudflare Workers AI REST API (`@cf/baai/bge-large-en-v1.5`, 1024 dims), clean up all ephemeral/ pollution, and rebuild all 11 codebase indexes cleanly.

## Constraints & Preferences
- Cloudflare-native only: Workers + Durable Objects + D1 + R2 + Vectorize.
- `compatibility_flags: ["nodejs_compat"]` required.
- Workers AI (no Vertex): zero OAuth, zero SA secrets, zero quota anxiety.
- Workers AI REST API via `fetch()` with `X-Auth-Email`/`X-Auth-Key` because `env.AI` binding doesn't propagate to DOs in WfP dispatch.
- Single-SA policy is now moot (no Vertex) but CLI SA resolution was removed entirely.
- Source path filter (`isSourcePath`) must exclude `ephemeral/`, `node_modules`, etc from both full and incremental indexing.
- `--shards 4 --batch 250` is the proven winning combo for Workers AI (no rate-limit issues).
- GitHub push pattern: `gh auth switch -u ajwcontreras && git push mine main && gh auth switch -u awilliamsevrylo`.
- User prefers minimal-diff, fast execution, exact verification.

## Progress
### Done
- **Single-SA lock** (committed `a02f5a8`):
  - `resolveSAFiles()` locked to `embedding-code-495015-2fa24eece6fa.json`.
  - `NUM_SAS=1` set in templates and all per-repo wrangler configs.
  - Redeployed `vibesdk-nightly` with NUM_SAS=1.
- **Plain search HyDE filter**: `/search` skips `chunk.kind === "hyde"`, over-fetches to compensate.
- **Source path filter**: shared `isSourcePath()` in `cloudflare-mcp/lib/files.mjs` applied to `buildDiffManifest()` so incremental excludes `ephemeral/`, `node_modules`, etc.
- **`cfcode reindex` flag forwarding**: `--shards`, `--batch`, `--queue` flags forwarded to `/incremental-ingest-sharded` and `/incremental-ingest`.
- **Council loop-breaker**: ran local council identifying false assumption that `--shards 1` is safer. Council recommended `--shards 16 --batch 100`; refined to `--shards 4 --batch 250` as winning combo.
- **Ephemeral/ audit**: script `ephemeral/audit-registered-ephemeral.mjs` found 5 affected repos; all wiped and rebuilt.
- **Workers AI migration** (committed `0934203`):
  - Removed ~220 lines of Vertex OAuth/embedding code (`parseSA`, `pemToAB`, `signJwt`, `googleToken`, `tokenCacheBySA`, `embedBatch` Vertex version).
  - Replaced with `aiEmbed()` using Workers AI REST API via `fetch()` with `X-Auth-Email`/`X-Auth-Key`.
  - Model: `@cf/baai/bge-large-en-v1.5`, 1024 dimensions, `$0.20/M tokens`.
  - Updated `Env` type: removed 13 Vertex fields (GEMINI_SERVICE_ACCOUNT_B64*, VERTEX_TOKEN_CACHE, NUM_SAS, GOOGLE_*), added `CF_API_KEY` and `CF_EMAIL`.
  - DO classes renamed: `IndexingShardV2`/`HydeShardV2` with legacy aliases (`IndexingShardDO extends IndexingShardV2`, etc).
  - Wrangler templates updated: v1+v2 migrations, AI binding, 1024d Vectorize, no NUM_SAS.
  - CLI: removed `resolveSAFiles()`, `saFilesB64()`; `setupSecrets` now sets `DEEPSEEK_API_KEY`, `CF_API_KEY`, `CF_EMAIL`.
- **All 11 codebases rebuilt cleanly** with Workers AI:
  - `mortgage-rag`: 425 chunks
  - `cf-docs-mcp`: 294 chunks
  - `cfpubsub-scaffold`: 692 chunks
  - `agent-council`: 971 chunks
  - `http-to-ssh`: 1,748 chunks
  - `reviewer-s-workbench`: 2,943 chunks
  - `qdrant-mcp-server`: 2,786 chunks
  - `lumae-upload-api`: 3,086 chunks
  - `income-scout-bun`: 6,255 chunks
  - `vibesdk-nightly`: 6,414 chunks
  - `lumae-fresh`: 11,037 chunks
- **Committed and pushed** both commits: `a02f5a8` (SA lock + filter + search fix + reindex flags), `0934203` (Workers AI migration).

### In Progress
- (none)

### Blocked
- (none)

## Key Decisions
- Workers AI REST API via `fetch()` chosen over `env.AI` binding because `env.AI` doesn't propagate to Durable Objects in Workers-for-Platforms dispatch namespace workers.
- DO classes renamed (`IndexingShardV2`/`HydeShardV2`) with legacy aliases to handle stale DO instances from pre-migration deploys.
- `X-Auth-Email`/`X-Auth-Key` headers used (not `Authorization: Bearer`) because Workers AI REST API requires Cloudflare Global API Key auth, not a scoped API token.
- Regex AST chunking retained over tree-sitter (native compile issue persists).
- `--shards 4 --batch 250` is the proven deployment combo for Workers AI at all chunk scales (294 to 11,037).
- Source path filter (`isSourcePath`) applied to incremental manifests to prevent future `ephemeral/` pollution.

## Next Steps
- Clean up temporary `cfcode-income-scout-bun-consumer` standalone worker (no longer needed since direct rebuild succeeded).
- Remove stale `wrangler.income-scout-bun-consumer.jsonc` from repo or mark as deprecated.
- Add query embedding cache (keyed by `sha256(model:query)` in D1/KV) to reduce Workers AI API calls for repeated queries.
- Add lexical fallback on Workers AI API failures.
- Re-index cfpubsub with AST chunks for better retrieval quality.
- Add golden queries for lumae and vibesdk-nightly.
- Fix cfpubsub weak query "how are workers registered".
- Add `cfcode resources cleanup`.
- Add progress bar to CLI.

## Critical Context
- Live MCP URL: `https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`.
- Gateway worker: `cfcode-gateway`.
- Dispatch namespace: `cfcode-codebases`.
- Account ID: `6bce4120096fa9f12ecda6efff1862d0`.
- Embedding model: `@cf/baai/bge-large-en-v1.5`, 1024 dimensions.
- Workers AI API endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`.
- Auth: `X-Auth-Email: $CF_EMAIL`, `X-Auth-Key: $CF_GLOBAL_API_KEY`.
- Workers AI rate limit for bge-large-en-v1.5: 1500 RPM (never hit at our scale with 4 shards/batch 250).
- WfP DO limitation: `env.AI` binding visible in `wrangler deploy` output and works in fetch handler, but not available inside DOs; REST API workaround confirmed working.
- DO class migration tags: v1 (`IndexingShardDO`, `HydeShardDO`), v2 (`IndexingShardV2`, `HydeShardV2`). Legacy aliases export both.
- `cfcode index --deploy` sometimes generates config with stale D1 ID; manual `wrangler deploy` before `cfcode index --full` resolves.
- Active commits for key repos: `vibesdk-nightly` at `d606aeb`, `income-scout-bun` at `8abb5f7`.
- Vertex SA directory no longer used for cfcode: `/Users/awilliamspcsevents/.config/cfcode/sas/` (containing `team (1).json`, `underwriter-agent-479920-af2b45745dac.json`, `big-maxim-331514-b90fae4428bc.json`, `embedding-code-495015-2fa24eece6fa.json`).
- Council/Judge Panel protocol loaded but not Mac Mini; local council runs now preferred.

## Relevant Files
- `.memory/HANDOFF.md`: current handoff/crash recovery.
- `cloudflare-mcp/workers/codebase/src/index.ts`: canonical worker; Workers AI REST API embed, V2 DO classes, legacy aliases.
- `cloudflare-mcp/cli/cfcode.mjs`: CLI; SA handling removed, `CF_API_KEY`/`CF_EMAIL` secret setup added, reindex flag forwarding.
- `cloudflare-mcp/lib/files.mjs`: source filtering with shared `isSourcePath()`, applied to `buildDiffManifest()`.
- `cloudflare-mcp/lib/cf.mjs`: Vectorize provisioning updated to `--dimensions=1024`.
- `cloudflare-mcp/lib/wfp-secret.mjs`: WfP secret upload helper (unchanged, still works).
- `cloudflare-mcp/workers/codebase/wrangler.namespace.template.jsonc`: V2 DOs, AI binding, no NUM_SAS, v1+v2 migrations, 1024d Vectorize.
- `cloudflare-mcp/workers/codebase/wrangler.template.jsonc`: standalone template, same updates.
- `cloudflare-mcp/workers/codebase/wrangler.income-scout-bun-consumer.jsonc`: temporary standalone consumer config (deprecated, should be cleaned up).
- `ephemeral/audit-registered-ephemeral.mjs`: script to audit registered repos for tracked `ephemeral/` files.
- `ephemeral/estimate-rebuild-chunks.mjs`: script to estimate chunk counts after source filter.
- `ephemeral/cfcode-index-reset-loop-breaker.md`: council evidence bundle for indexing pipeline loop-breaker.
- `.cfapikeys`: Cloudflare and DeepSeek credentials, gitignored (now sources `CF_GLOBAL_API_KEY` and `CF_EMAIL`).
</previous-summary>
