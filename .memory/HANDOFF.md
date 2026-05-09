# HANDOFF — crash-recovery prompt for next session
# Date: 2026-05-02 (build session)
# Commit: pending handoff verification commit after 4ffc315
# Writer: Claude session with Andrew Williams

## 2026-05-05 live task update

- Andrew reported accidental local `npx skills install` output in this repo: many root-level dot-directories for agent tools plus local `skills/` and `skills-lock.json`.
- Current work: clean only the accidental local skill-install artifacts from `/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server`.
- Initial inspection completed: `git status --short` shows untracked root dot-directories including `.adal/`, `.agents/`, `.aider-desk/`, `.augment/`, `.bob/`, `.codeartsdoer/`, `.codebuddy/`, `.codemaker/`, `.codestudio/`, `.commandcode/`, `.continue/`, `.cortex/`, `.council-docs/`, `.crush/`, `.devin/`, `.factory/`, `.forge/`, `.goose/`, `.iflow/`, `.junie/`, `.kilocode/`, `.kiro/`, `.kode/`, `.mcpjam/`, `.mux/`, `.neovate/`, `.openhands/`, `.pi/`, `.pochi/`, `.qoder/`, `.qwen/`, `.roo/`, `.rovodev/`, `.tabnine/`, `.trae/`, `.vibe/`, `.windsurf/`, `.zencoder/`, plus `skills/` and `skills-lock.json`.
- Decision: remove only clearly accidental untracked local install artifacts. Do not touch normal repo config, secrets, generated benchmark artifacts, or unrelated untracked POC/session files.
- Completed: removed the accidental local skill-install artifacts: all listed root dot-directories, `skills/`, and `skills-lock.json`.
- Verification: `find` for that exact artifact set at repo root returns nothing; `git status --short` no longer lists those directories/files.
- Remaining dirty state is unrelated pre-existing work/noise: `.memory/HANDOFF.md`, `README.md`, qdrant index state files, council briefs, benchmark outputs, POC generated wrangler configs, session artifacts, and retrieval POC scripts/tests.
- 2026-05-06 follow-up: Andrew asked to do the same cleanup "for this project." Current cwd resolves to the same `/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server` checkout. Re-ran the root artifact-set check; no accidental skill-install directories/files were present. Current `git status --short` only shows `.memory/HANDOFF.md` and `README.md` modified.

## 2026-05-07 live task update

- Andrew asked to continue the `vibesdk-nightly`/cfcode hardening work and restrict Vertex usage to one approved SA only: `/Users/awilliamspcsevents/.config/cfcode/sas/embedding-code-495015-2fa24eece6fa.json`.
- Changed `cloudflare-mcp/cli/cfcode.mjs` `resolveSAFiles()` to return only that preferred SA file; no fallback to the other local SA JSONs.
- Changed `cloudflare-mcp/workers/codebase/wrangler.namespace.template.jsonc`, `wrangler.template.jsonc`, and `wrangler.vibesdk-nightly.namespace.jsonc` to `NUM_SAS=1`.
- Deployed `cfcode-codebase-vibesdk-nightly` to dispatch namespace `cfcode-codebases`; current deployed version after search fix: `9a2a41c5-f44c-4097-830a-b83a99ec0a8a`.
- Ran `cfcode index /Users/awilliamspcsevents/PROJECTS/vibesdk-nightly --full`; CLI confirmed `sa: 1` and refreshed secrets. Client printed `fetch failed`, but Worker accepted/published the job.
- Active `vibesdk-nightly` job is now `job-vibesdk-nightly-mov6z98v`, active commit `d606aebb161ee7de05abe052e231239dfd7fcc12`, active_at `2026-05-07T07:56:01.621Z`.
- Found plain `/search` was returning HyDE child rows whose `file_path` was actually the parent `chunk_id`. Fixed `search()` to over-fetch and skip `chunk.kind === "hyde"`; hybrid remains the HyDE-aware endpoint.
- Verification after deploy: plain search for `executeInference function parameters env metadata schema` returns `worker/agents/inferutils/core.ts`; hybrid returns `worker/agents/inferutils/core.ts` and `worker/agents/inferutils/infer.ts`; sandbox hybrid query returns sandbox/toolkit paths.
- Known tradeoff: with one SA only, query-time Vertex embedding can transiently 429. Retried sandbox hybrid after cooldown and it passed. Next hardening should add query embedding cache and lexical fallback on Vertex 429.
- Follow-up check: Andrew correctly flagged another agent may already have fixed parts of this. Current code already has Vertex OAuth token caching (`VERTEX_TOKEN_CACHE` + per-isolate token cache), Vertex retry/backoff, and `cfcode index` auto-delegates to incremental when registered. Current code does not yet show query embedding vector caching, lexical fallback for query 429s, or recovery from `fetch failed` after `/ingest-sharded` accepts a job.
- New task: Andrew asked to reindex `income-scout-bun`. `cfcode list` shows it registered at `/Users/awilliamspcsevents/PROJECTS/income-scout-bun`; next step is `cfcode reindex` on that path and verify status/search.
- Reindex attempt 1: `cfcode reindex /Users/awilliamspcsevents/PROJECTS/income-scout-bun` partialed at 900/1652 chunks, 752 failed, 569 deactivated. Active publication did not advance; git state stayed at `aa4d87a1`.
- Reindex slow attempt exposed CLI bug: `--shards`/`--batch` were not forwarded by `cmdReindex`; patched `cloudflare-mcp/cli/cfcode.mjs` to include `shard_count` and `batch_size` in `/incremental-ingest-sharded` body.
- Reindex slow attempt 2 with `--shards 1 --batch 25` still partialed at 627/1652 chunks, 1025 failed, 826 deactivated. This is likely single-SA Vertex quota pressure. Repeating incremental is risky because tombstones/deactivations happen before full success.
- Slow queue path: patched `cfcode reindex --queue` to call `/incremental-ingest`; queued job `inc-income-scout-bun-moxqeqp8`. Dispatch user worker could not consume queue directly; Wrangler reported no consumers and could not attach consumer to WfP user worker.
- Deployed temporary standalone consumer worker `cfcode-income-scout-bun-consumer` using `wrangler.income-scout-bun-consumer.jsonc`, shared D1/R2/Vectorize/Queue, no DO bindings, `max_batch_size=1`, `max_concurrency=1`; set `GEMINI_SERVICE_ACCOUNT_B64` from approved `embedding-code-495015` SA.
- Queue is draining slowly. Latest observed `inc-income-scout-bun-moxqeqp8`: `completed=23`, `failed=22`, `status=publishing`, `total=1652`. Failed count increments on failed attempts; queue retries may still later complete chunks.
- Andrew decided to stop trying to incrementally repair polluted indexes and instead wipe/rebuild indexes for registered repos that have tracked `ephemeral/` files, excluding `lumae-fresh` unless evidence says otherwise. First step: patch incremental filtering to exclude skipped paths like `ephemeral/`, then identify affected registered codebases.
- Andrew explicitly authorized destructive reset now. Scope: wipe/rebuild only affected registered repos with tracked `ephemeral/` pollution; do not touch `lumae-fresh`. `mortgage-rag` rebuilt cleanly 425/425; `agent-council` rebuilt cleanly 946/946. `reviewer-s-workbench` previous rebuild is not trusted (`running`, partial rows), so wipe/rebuild it again. Remaining: `reviewer-s-workbench`, `income-scout-bun`, `lumae-upload-api`.
- `reviewer-s-workbench` destructive rebuild restarted with `--shards 1 --batch 10`, job `job-reviewer-s-workbench-moxvp42k`, total 2943. Client printed `fetch failed`, but row count is increasing: observed `chunk_rows=420`, then `510` after 5 minutes. Job counters remain `completed=0/status=running` until the long single shard returns. No direct 429 observed; WfP tail still unavailable. Do not start more large rebuilds concurrently while this one drains under single-SA quota.
- Andrew pasted the Council/Judge Panel development loop protocol. Stop further destructive rebuild attempts until a loop-breaker council reviews the current false assumptions and proposes a safer reset strategy. Next immediate step: create a focused evidence bundle under `ephemeral/`, run council from `intelmini`, then revise plan.
- Correction: Andrew said not to use the Mac Mini right now. Remote council attempt was aborted after `gemini-3-pro` failed immediately. Keep `ephemeral/cfcode-index-reset-loop-breaker.md` as local evidence, but do not run council on `intelmini` unless explicitly requested.
- Andrew then authorized local council because the CLI is now memory-efficient. Local council loop-breaker ran with gpt-5.5, deepseek-v4-pro, claude, kimi-k2-thinking; Round 2 timed out/partial, but Round 1 had strong consensus: the false assumption was that `--shards 1 --batch 10/25` is safer. It is worse for large repos because one DO processes hundreds of sequential batches, the gateway/user-worker request times out, chunks continue writing, and job aggregation never runs. Council recommendation: rebuild affected medium/large repos with enough shards to finish inside request window: reviewer/lumae-upload-api `--shards 16 --batch 100`, income-scout-bun `--shards 32 --batch 100`. Also active_publication is currently optimistic and job counters are not live progress.
- Council loop-breaker: false assumption was `--shards 1 --batch 10` is safer. Actually more shards (4-8) let each shard finish inside request window. Also `active_publication` is optimistic; `job.completed` is not live progress; `--shards 1` on large repos makes one DO run too long and exceed request timeout.
- Reviewer rebuilt cleanly at `--shards 4 --batch 250`: 2943/2943 published, search verified.
- Lumae-upload-api rebuilt cleanly at `--shards 4 --batch 250`: 3086/3086 published.
- Income-scout-bun (6109 chunks) repeatedly partialed under direct ingestSharded (1000-1511 failures). Deployed standalone queue consumer (`cfcode-income-scout-bun-consumer`), max_batch_size=1, max_concurrency=1. Queued `cfcode index --full --queue`. Job `job-income-scout-bun-moy07jjr` is draining slowly via consumer; observed 24/6111 completed initially with transient failures that queue will retry. Expected completion in hours at this pace.

## TL;DR

Phase 31 indexing pipeline DONE. Phase 32 DX DONE (11 CLI commands + HyDE worker port).
**Phase 33 retrieval quality DONE** — 4 improvements shipped + golden eval harness + 3-codebase benchmark.
Canonical worker has file-type boosting, hyde-boosted search, /search-rerank, HydeShardDO.
AST chunking via regex (12 languages, function/class boundaries). 20 golden queries across 3 codebases.
4 codebases live in gateway, all searchable.

## Current authoritative state

- **Last pushed commit:** 4ffc315 on mine/main
- **MCP gateway fix:** `cloudflare-mcp/workers/mcp-gateway/src/index.ts` changed MCP `search` to use the proven gateway admin proxy; deployed to `cfcode-gateway` and SDK-smoked PASS.
- **CLAUDE.md:** Phase status through 33D
- **EXECUTION_PLAN.md:** POC ledger through Phase 33D
- **Latest indexed codebase:** `vibesdk-nightly` at `/Users/awilliamspcsevents/PROJECTS/vibesdk-nightly`.
- **vibesdk-nightly status:** Git initialized locally with baseline commit `d606aeb`; latest full index published job `job-vibesdk-nightly-mov6z98v` using only the approved `embedding-code-495015` SA. Plain and hybrid search verified after deploy.
- **Gateway codebases:** includes lumae-fresh, cfpubsub-scaffold, cf-docs-mcp, qdrant-mcp-server, vibesdk-nightly, and other previously indexed repos (`cfcode list` is authoritative).
- **Canonical worker:** cloudflare-mcp/workers/codebase/src/index.ts (~920 lines, all Phase 32+33 features)
- **CLI:** cloudflare-mcp/cli/cfcode.mjs (11 commands, `--fast`, `--hybrid`, `--rerank` flags)
- **Eval harness:** cloudflare-mcp/scripts/eval-harness.mjs
- **Golden queries:** cloudflare-mcp/sessions/golden-{cfpubsub,cf-docs-mcp,qdrant-mcp-server}.json
- **Research:** .memory/research-papers-retrieval-quality.md (29 papers, 4 categories)
- **MCP install status:** Claude (`~/.claude.json`), Codex (`~/.codex/config.toml` + legacy `config.json`), and OpenCode (`~/.config/opencode/opencode.json`) point at `https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`.
- **Skill install status:** `cloudflare-master`, `cloudflare-codebase-mcp-indexing`, and `poc-driven-development` are symlinked from canonical `~/.agents/skills` into Claude, Codex, and both OpenCode skill dirs.
- **Live MCP smoke:** `node cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs` connects, lists tools, lists 4 codebases, selects `qdrant-mcp-server`, and runs `search` successfully.

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

## 2026-05-09 live task: Replace Vertex AI embedding with Workers AI

Replaced all Vertex AI embedding code in `cloudflare-mcp/workers/codebase/src/index.ts` with Cloudflare Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024d).
- Removed: KVLike type, all ENV Vertex fields (GEMINI_*, GOOGLE_*, VERTEX_TOKEN_CACHE, NUM_SAS), GoogleSA type, all OAuth code (tokenCache, parseSA, pemToAB, b64url, signJwt, bumpMetric, googleToken), sharded SA functions (tokenCacheBySA, parseSAByIndex, parseSAB64, saFromArray, tokenForSA), old embed/embedBatch.
- Added: `AI` binding to Env type, `EMBED_MODEL` constant, new `embed()` (backward-compat signature with optional _taskType) and `embedBatch()` (backward-compat with _sa param ignored).
- Cleaned: ShardBatchReq (removed sa_index, gemini_sas), ShardResult (removed sa_index), IngestShardedReq (removed num_sas, gemini_sas), all DO processors (use EMBED_MODEL/1024d, embedBatch with 0), ingest/incremental/hydeEnrich endpoints (SA code removed), search endpoints (task_type removed), metrics (kv_bound removed).
- **STATUS: DONE — `npm run check` (tsc --noEmit) passes clean**.

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
- Approved Vertex SA for cfcode: /Users/awilliamspcsevents/.config/cfcode/sas/embedding-code-495015-2fa24eece6fa.json
- Do not use the other local SA files for cfcode unless Andrew explicitly reverses this; user suspects those keys may be compromised/tampered with.

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
