# HANDOFF — crash-recovery prompt for next session
# Date: 2026-05-02 (build session — FINAL)
# Commit: 1f7762a (pushed to mine/main)
# Writer: Claude session with Andrew Williams

## TL;DR

Phase 31 indexing pipeline is DONE and PROVEN. Phase 32 DX is DONE — 11 CLI commands built, HyDE ported to canonical worker. The cfcode CLI is now a complete tool: index, search, logs, hyde-enrich, resources, setup. All committed and pushed.

Canonical worker at `workers/codebase/src/index.ts` now has HydeShardDO, /hyde-enrich endpoint, deepseek(), 4-SA support, and schema migrations. TypeScript passes clean.

## Current authoritative state

- **Last commit:** 5a8f35d on mine/main
- **CLAUDE.md:** Phase status current through 31K
- **AGENTS.md:** Same as CLAUDE.md (synced)
- **EXECUTION_PLAN.md:** POC ledger complete through Phase 31
- **AGENT_HANDOFF_MASTER_PLAN.md:** Per-event progress log
- **3 new docs at repo root:** SETUP.md, LESSONS_LEARNED.md, CLOUDFLARE_EXPERIMENTAL_FINDINGS.md
- **Production worker reference:** cloudflare-mcp/poc/31k-2pop-fixed/src/index.ts
- **Canonical worker:** cloudflare-mcp/workers/codebase/src/index.ts (still on old queue path, NOT updated)
- **Skills cleaned up:** 48→36 skills, cloudflare-master installed globally with code patterns

## What's done (Phase 31 + Phase 32 — COMPLETE)

**Phase 31 (complete):** 10-POC chain, atob fix, fire-and-forget, council review. See EXECUTION_PLAN.md.

**Phase 32 (complete — 11 CLI commands + HyDE worker port, all pushed):**
1. `cfcode index --fast` — /ingest-sharded, 15.6x faster. Supports `--shards N`, `--batch N`.
2. `cfcode search <repo> "query"` — semantic search, `--topK N`.
3. `cfcode logs <repo>` — live wrangler tail, `--errors` filter.
4. `cfcode resources` — list D1/R2/Vectorize/Queues via wrangler.
5. `cfcode search-active` — diagnostic D1 active rows by slug.
6. `cfcode setup` — health check gateway + registry + namespace.
7. `cfcode hyde-enrich <repo>` — post-index HyDE question gen, autodiscovers job_id from /collection_info.
8. **HyDE DO classes ported** to `workers/codebase/src/index.ts`: HydeShardDO, /hyde-enrich, deepseek(), 4-SA parseSAByIndex, D1 schema migrations. tsc passes.
9. `cfcode reindex` / `cfcode status` / `cfcode list` / `cfcode uninstall` / `cfcode mcp-url` — already existed.

### Deferred (Phase 33)
- `cfcode resources cleanup` — needs account-level CF API correlation
- `cfcode bench` — benchmark search quality
- Progress bar — cosmetic
- Worker deploy for hyde-enrich — needs wrangler.jsonc template update (HYDE_SHARD_DO binding + DEEPSEEK_API_KEY secret)

### Implementation notes
- CLI: cloudflare-mcp/cli/cfcode.mjs (11 commands, 8 added via Codex sub-agents)
- Canonical worker: cloudflare-mcp/workers/codebase/src/index.ts (~820 lines, HyDE added)
- Codex pattern: write AGENTS.md + prompt.txt → `codex exec -m gpt-5.3-codex-spark -s workspace-write --ephemeral` → review → commit
- Edcub0 might need fresh `npm install` in workers/codebase for wrangler to work

## How to verify the engine still works

```bash
# Quick smoke on the 31K throwaway (creates + destroys resources):
unset CLOUDFLARE_API_TOKEN
CLOUDFLARE_API_KEY=$(grep CF_GLOBAL_API_KEY .cfapikeys | cut -d= -f2)
CLOUDFLARE_EMAIL=$(grep CF_EMAIL .cfapikeys | cut -d= -f2)
node cloudflare-mcp/scripts/poc-31k-2pop-bench.mjs

# Full E2E on a small repo (persistent):
node cloudflare-mcp/scripts/poc-31k-e2e-cfpubsub.mjs
```

## Key file paths

| File | Purpose |
|------|---------|
| cloudflare-mcp/poc/31k-2pop-fixed/src/index.ts | Production-ready worker (all fixes) |
| cloudflare-mcp/poc/31i-rate-measure/src/index.ts | Rate measurement POC |
| cloudflare-mcp/poc/31f1-vertex-in-do/src/index.ts | atob bug isolation POC |
| cloudflare-mcp/workers/codebase/src/index.ts | Canonical worker (needs 31K port) |
| cloudflare-mcp/cli/cfcode.mjs | CLI entry (needs 31K updates) |
| cloudflare-mcp/lib/ | Shared libs |
| cloudflare-mcp/scripts/poc-31k-2pop-bench.mjs | Throwaway bench (lumae) |
| cloudflare-mcp/scripts/poc-31k-e2e-cfpubsub.mjs | E2E persistent index |
| cloudflare-mcp/scripts/tail-worker.sh | Reusable tail helper |
| cloudflare-mcp/scripts/watch-deploy.sh | Auto-redeploy on file change |

## Credential paths (unchanged)

- CF: .cfapikeys at repo root (CF_GLOBAL_API_KEY, CF_EMAIL, CF_ACCOUNT_ID, DEEPSEEK_API_KEY)
- Vertex SA1: /Users/awilliamspcsevents/.config/cfcode/sas/team (1).json (evrylo, billing A)
- Vertex SA2: /Users/awilliamspcsevents/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json (billing B)
- Vertex SA3: /Users/awilliamspcsevents/.config/cfcode/sas/big-maxim-331514-b90fae4428bc.json (billing C)
- Vertex SA4: /Users/awilliamspcsevents/.config/cfcode/sas/embedding-code-495015-2fa24eece6fa.json (billing C, same as SA3)

## Critical gotchas (do NOT rediscover these)

1. `atob()` MUST be called before `charCodeAt` on PEM keys — missing it silently kills Vertex auth
2. `ctx.waitUntil` capped at 30s — use DO alarms for >30s work
3. DO storage 128KB per-key limit — store config, NOT artifact text
4. Secrets wiped on `wrangler delete` + `wrangler deploy` — always re-set after deploy
5. Wrangler config MUST include `observability: { enabled: true, head_sampling_rate: 1 }` for tail to work
6. CF per-origin fetch cap of 6 is REAL for api.deepseek.com, INEXISTENT for Vertex
7. `wrangler tail` with `--search "search text"` can HIDE logs — use no filter first, then narrow
8. D1 database_id in wrangler config goes stale after cleanup — regenerate
9. Each DO shard gets its own isolate — more shards = more concurrent DeepSeek calls
10. The `compatibility_flags: ["nodejs_compat"]` is REQUIRED
