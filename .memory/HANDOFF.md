# HANDOFF — crash-recovery prompt for next session
# Date: 2026-05-02 (build session)
# Commit: 1b7cc3a (pushed to mine/main)
# Writer: Claude session with Andrew Williams

## TL;DR

Phase 31 indexing pipeline DONE. Phase 32 DX DONE (11 CLI commands + HyDE worker port).
**Phase 33 retrieval quality DONE** — 4 improvements shipped + golden eval harness + 3-codebase benchmark.
Canonical worker has file-type boosting, hyde-boosted search, /search-rerank, HydeShardDO.
AST chunking via regex (12 languages, function/class boundaries). 20 golden queries across 3 codebases.
4 codebases live in gateway, all searchable.

## Current authoritative state

- **Last commit:** 1b7cc3a on mine/main
- **CLAUDE.md:** Phase status through 33D
- **EXECUTION_PLAN.md:** POC ledger through Phase 33D
- **4 codebases live in gateway:** lumae-fresh, cfpubsub-scaffold, cf-docs-mcp, qdrant-mcp-server
- **Canonical worker:** cloudflare-mcp/workers/codebase/src/index.ts (~920 lines, all Phase 32+33 features)
- **CLI:** cloudflare-mcp/cli/cfcode.mjs (11 commands, `--fast`, `--hybrid`, `--rerank` flags)
- **Eval harness:** cloudflare-mcp/scripts/eval-harness.mjs
- **Golden queries:** cloudflare-mcp/sessions/golden-{cfpubsub,cf-docs-mcp,qdrant-mcp-server}.json
- **Research:** .memory/research-papers-retrieval-quality.md (29 papers, 4 categories)
- **Skill:** cloudflare-master installed globally with code patterns

## What's done (Phase 31 + 32 + 33)

**Phase 31 (complete):** 10-POC chain, atob fix, fire-and-forget, council review.

**Phase 32 (complete — 11 CLI commands + HyDE worker port, all pushed):**
1. `cfcode index --fast` (--shards N, --batch N)
2. `cfcode search --hybrid --rerank --topK N`
3. `cfcode logs --errors`
4. `cfcode resources`
5. `cfcode search-active`
6. `cfcode setup`
7. `cfcode hyde-enrich`
8. HydeShardDO, /hyde-enrich, deepseek(), 4-SA parseSAByIndex in canonical worker
9. Wrangler template with HYDE_SHARD_DO binding

**Phase 33 (complete — 4 improvements + eval):**
1. **33A File-type boosting:** json/toml/yaml 0.5x, .config.ts 0.6x, .test.ts 0.7x. Deployed.
2. **33B HyDE-boosted search:** /search-hybrid aggregates hyde scores into parent code chunks. Previously unranked implementation files now surface. Deployed.
3. **33C AST-aware chunking:** Regex boundary detection for 12 languages. cfpubsub 59→693 chunks. cf-docs-mcp 294 chunks. Self-index 3897 chunks. Deployed.
4. **33D DeepSeek reranking:** /search-rerank zero-shot listwise. Fallback-safe. Deployed.
5. **Golden eval harness:** Recall@K, MRR, nDCG@10. 20 golden queries across 3 codebases.
6. **3-codebase benchmark:** cf-docs-mcp Recall@5=1.000, qdrant-mcp-server Recall@5=0.900, cfpubsub Recall@5=0.600.

## Deployed codebases (4 live)
| Codebase | Chunks | Search | HyDE | AST |
|----------|--------|--------|------|-----|
| lumae-fresh | 764 | ✓ | ✓ | — |
| cfpubsub-scaffold | 767 | ✓ | ✓ | — (old index) |
| cf-docs-mcp | 294 | ✓ | — | ✓ |
| qdrant-mcp-server | 3897 | ✓ | — | ✓ |

## Eval Summary
| Codebase | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 |
|----------|---------|----------|-----------|-----|---------|
| cfpubsub-scaffold | 5 | 0.600 | 0.800 | 0.207 | 0.349 |
| cf-docs-mcp | 5 | **1.000** | **1.000** | **0.617** | **0.715** |
| qdrant-mcp-server | 10 | **0.900** | **0.900** | **0.592** | **0.666** |

Cfpubsub "workers registered" query is the major gap (Recall=0.0, answer file never surfaces).

## What's NEXT (Phase 34)
- Fix cfpubsub "workers registered" gap — commands-runtime.ts should rank for "workers registered"
- Re-index cfpubsub with AST chunks, measure eval delta
- HyDE-enrich cf-docs-mcp and qdrant-mcp-server, measure eval delta
- Scale to 6-9 more codebases for broader eval coverage
- Dual-channel proper RRF (k=60) instead of simple aggregation
- cfcode bench command wrapping eval harness
- Progress bar during indexing

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
