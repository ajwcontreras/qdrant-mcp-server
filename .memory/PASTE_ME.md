You are resuming on the cfcode project (Cloudflare-native per-codebase MCP code search).
The engine works. The Developer Experience needs building. Read this, then read the repo docs.

## CRITICAL CONTEXT (read these immediately)
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/.memory/HANDOFF.md — crash-recovery state
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/CLAUDE.md — agent guidance, Phase status, gotchas
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/EXECUTION_PLAN.md — POC ledger, Phase 31 entries at bottom
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/LESSONS_LEARNED.md — bugs, discoveries, architecture lessons
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/CLOUDLARE_EXPERIMENTAL_FINDINGS.md — 10 CF platform measurements
- /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/SETUP.md — zero-to-indexed guide

## WHAT'S DONE
The indexing engine is fully proven. 10-POC chain (31D→31K). The production-ready worker is at:
  cloudflare-mcp/poc/31k-2pop-fixed/src/index.ts

Key architecture: fire-and-forget producer via DO alarm, 4 code shards + 64 hyde shards,
R2-pull per shard, explicit DeepSeek concurrency batching (6/shard), per-fetch timeouts,
/hyde-enrich gap fill. Code searchable in ~10s, hyde in ~30-70s.

Proven on: lumae (632 chunks, 97% hyde), cfpubsub-scaffold (154 chunks, 91% hyde).
Council-reviewed by chatgpt+gemini+deepseek. All critical findings addressed.

Critical bugs found and fixed:
- atob() was MISSING from signJwt PEM decoding — silently killed Vertex auth
- ctx.waitUntil 30s cap — use DO alarms for >30s work
- DO storage 128KB per-key limit — store config, not artifacts
- CF per-origin fetch cap of 6 is REAL for api.deepseek.com, INEXISTENT for Vertex
- Vertex handles 100+ parallel calls from single DO with zero 429s

## WHAT'S NEXT (Phase 32 — Developer Experience)
The engine can index any repo. But every operation requires throwaway scripts.
The cfcode CLI needs these commands:

### Critical (build these first):
1. cfcode index <repo> — must use 31K fast path (currently calls old queue-based /ingest)
   Add --fast (code-only) and --shards N flags
2. cfcode logs <repo> — wrap wrangler tail with correct worker name
3. cfcode search <repo> "query" — handle Vectorize 45s consistency delay

### Important (next wave):
4. cfcode hyde-enrich <repo>
5. cfcode resources — list all deployed CF resources for this account
6. cfcode resources cleanup — remove orphaned resources
7. cfcode setup — one-command gateway deploy + namespace create

### Nice-to-have:
8. Progress bar during indexing
9. cfcode bench [--repo <path>]
10. cfcode index --shards N (custom shard count)

### Implementation notes:
- CLI entry: cloudflare-mcp/cli/cfcode.mjs
- Gateway lib: cloudflare-mcp/lib/gateway.mjs
- Shared libs: cloudflare-mcp/lib/ (env, exec, http, files, cf)
- Canonical worker port needed: cloudflare-mcp/workers/codebase/src/index.ts needs the 31K DO classes merged in
- Keep backward compatibility: old /ingest path must still work

## HOW TO VERIFY EVERYTHING STILL WORKS
```bash
# Quick smoke on 31K throwaway (creates + destroys resources):
CLOUDFLARE_API_KEY=$(grep CF_GLOBAL_API_KEY .cfapikeys | cut -d= -f2) \
CLOUDFLARE_EMAIL=$(grep CF_EMAIL .cfapikeys | cut -d= -f2) \
unset CLOUDFLARE_API_TOKEN \
node cloudflare-mcp/scripts/poc-31k-2pop-bench.mjs
```

## CREDENTIALS
.cfapikeys at repo root (gitignored): CF_GLOBAL_API_KEY, CF_EMAIL, CF_ACCOUNT_ID, DEEPSEEK_API_KEY
Vertex SA1: ~/.config/cfcode/sas/team (1).json (evrylo, billing A)
Vertex SA2: ~/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json (billing B)
Vertex SA3: ~/.config/cfcode/sas/big-maxim-331514-b90fae4428bc.json (billing C)
Vertex SA4: ~/.config/cfcode/sas/embedding-code-495015-2fa24eece6fa.json (billing C, same as SA3)

## 10 CRITICAL GOTCHAS (DO NOT REDISCOVER)
1. atob() MUST be called before charCodeAt on PEM keys
2. ctx.waitUntil capped at 30s — use DO alarms for >30s work
3. DO storage 128KB per-key limit — store config metadata, NOT artifact text
4. Secrets wiped on wrangler delete + wrangler deploy — always re-set after deploy
5. Wrangler config MUST include observability.enabled=true for tail to work
6. per-origin fetch cap of 6 for api.deepseek.com, nonexistent for Vertex
7. wrangler tail --search "text" can HIDE logs — use no filter first
8. D1 database_id in wrangler config goes stale after cleanup — regenerate
9. More DO shards = more concurrent DeepSeek (each shard = own isolate)
10. compatibility_flags: ["nodejs_compat"] REQUIRED

## AUDIO MCP
The user uses voice-to-text due to finger injuries. The audio MCP is configured on all agents.
Always speak first, then listen, then optionally write text.

## GIT PUSH
gh auth switch -u ajwcontreras && git push mine main && gh auth switch -u awilliamsevrylo

## SKILLS (global, installed)
cloudflare-master is the canonical CF skill. Load before any Worker task.
Accessibility-audio-report for voice. POC-driven-development for new pipelines.
Skills cleaned from 48→36 this session.
