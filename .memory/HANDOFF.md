# HANDOFF — crash-recovery prompt for next session
# Date: 2026-05-02 (build session)
# Commit: f09924c (pushed to mine/main)
# Writer: Claude session with Andrew Williams

## TL;DR

Phase 31 indexing pipeline is DONE and PROVEN. 10-POC chain (31D→31K). Fire-and-forget producer via DO alarm, 4 code shards + 64 hyde shards, 97% hyde completion on lumae. Council-reviewed by chatgpt+gemini+deepseek. All documentation written.

**Phase 32 DX is in progress.** `cfcode index --fast` shipped. Using Codex sub-agents for mechanical CLI implementation.

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

## What's done (Phase 31 + Phase 32 start)

**Phase 31 (complete):**
1. **atob PEM decoding bug found and fixed** — line 66 of 31k-2pop-fixed/src/index.ts
2. **CF per-origin fetch cap measured** — 6 for api.deepseek.com, UNLIMITED for Vertex
3. **Fire-and-forget producer** — DO alarm driven, <2s response
4. **R2-pull per shard** — no artifact text in subrequest payloads
5. **Explicit DS batching** — 6 at a time per shard
6. **Per-shard DO fetch timeout** — 120s, prevents hung shards
7. **/hyde-enrich endpoint** — fills gap when hyde < 100%
8. **parseSA supports 4 SAs** — indexed array pattern
9. **Poll log streaming** — JSONL file for background observation
10. **Council review** — 3/4 providers, all findings addressed

**Phase 32 (in progress):**
1. **`cfcode index --fast`** — switches POST from `/ingest` to `/ingest-sharded` (15.6x faster). Also `--shards N`, `--batch N` flags. Backward compatible. Implemented by Codex sub-agent, committed at f09924c.

## What's NEXT (Phase 32 - Developer Experience)

The engine can index any repo at 100% code + 91-97% hyde. But every operation requires throwaway scripts. Next session needs to build:

### Critical (top priority)
1. **`cfcode index --fast` — DONE (f09924c)**. Also `--shards N`, `--batch N`. Backward compatible.
2. **`cfcode logs <repo>`** — wrap `wrangler tail` with correct worker name. Support `--errors` flag.
3. **`cfcode search <repo> "query"`** — handle Vectorize ~45s consistency delay. Format results with file paths and scores.

### Important (next wave)
4. **`cfcode hyde-enrich <repo>`** — wrap the /hyde-enrich endpoint
5. **`cfcode resources`** — list all deployed R2/D1/Vectorize/workers for this account
6. **`cfcode resources cleanup`** — remove orphaned resources (stale POC workers, old D1s)
7. **`cfcode setup`** — one-command gateway deploy + namespace create

### Nice-to-have
8. **Progress bar during index** — poll /jobs/:id/status with tqdm-style bar
9. **`cfcode bench [--repo <path>]`** — run standard benchmark with fresh resources
10. **`cfcode index --shards N`** — custom shard count override

### Implementation notes
- CLI entry: cloudflare-mcp/cli/cfcode.mjs
- Gateway lib: cloudflare-mcp/lib/gateway.mjs
- Shared libs: cloudflare-mcp/lib/ (env, exec, http, files, cf)
- The CLI currently sends JSONL artifact to gateway via HTTP POST. Same pattern works for the new endpoints.
- The canonical worker port (codebase/src/index.ts) still needs the 31K DO classes merged in. Backward compatibility: keep old `/ingest` path working, add new DO classes + `/ingest-sharded` update.

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
