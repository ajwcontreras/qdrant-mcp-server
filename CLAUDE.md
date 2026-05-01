# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other agents working in this repository.

## What This Is

This repo's primary deliverable is **`cfcode`** — a global CLI + Cloudflare-native MCP gateway that turns any local git repo into a semantically-searchable MCP endpoint. Drop ONE URL into your agent settings, run `cfcode index <repo>` once per repo, and any agent can `select_codebase` + `search`.

The repo also still contains the **legacy local Qdrant MCP** (`src/qdrant-openai-indexer.py`, `src/mcp-qdrant-openai-wrapper.py`) which is functional but no longer the active development direction.

## User Preferences (read every session)

- **Voice-to-text user.** Transcriptions can be ambiguous; ask when unclear, don't silently interpret.
- **Fast and intense.** Will interrupt mid-task with new directions. Acknowledge then finish current step UNLESS the interrupt corrects a mistake.
- **No glazing.** Be objective. Push back when wrong. Flag cleanup debt proactively.
- **Decisive, minimal-diff responses.** Skip preamble. Senior-engineer tone.
- **Never suggest stopping or "wrapping up."** User decides when to stop.
- **Inline scripts forbidden.** Every script — no matter how small — gets its own file in `cloudflare-mcp/poc/`, `cloudflare-mcp/scripts/`, `eval/`, or `ephemeral/`. Inline heredocs vanish from history.

## Active Architecture: cfcode (Phase 26+27+29+30 SHIPPED in source; production lumae still on pre-29 worker)

```
Claude Code / Cursor / any MCP client
    │ ONE URL: https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp
    ▼
cfcode-gateway (Worker + McpAgent Durable Object)
    │ env.DISPATCHER.get(`cfcode-codebase-${slug}`)
    ▼
cfcode-codebases (dispatch namespace, Workers for Platforms)
    ├─ cfcode-codebase-lumae-fresh   ← live, 608 chunks (still on legacy queue path)
    ├─ cfcode-codebase-<future>      ← added via `cfcode index <path>`
    └─ ...
        ▼
    per-codebase R2 + D1 + Vectorize + (legacy Queue or new sharded DO fan-out)
    Vertex gemini-embedding-001 (1536d, multi-SA round-robin)
    DeepSeek v4-flash for HyDE (separate fan-out target)
```

### Indexing pipeline shape (post-Phase 30)

The canonical worker (`cloudflare-mcp/workers/codebase/`) now exposes BOTH paths:
- `/ingest` — legacy queue-based path (still works; production lumae uses this)
- `/ingest-sharded` — new sharded DO fan-out, 12-15× faster (29F/30C proven)

Phase 30 architecture (in `poc/30c-dual-fanout/`, ready for canonical port):
- Producer fires TWO independent `Promise.allSettled` fan-outs at the request handler:
  - `CodeShardDO` (×N, deterministic IDs `cfcode:code-shard:N`) — pure code path
  - `HydeShardDO` (×M, deterministic IDs `cfcode:hyde-shard:M`) — pure HyDE path
- **No DO is dual-purpose. No combined mode anywhere.** (User directive 2026-05-01.)
- Code becomes searchable in ~8s independent of HyDE; HyDE finishes ~70s later.
- `parent_chunk_id` joins HyDE rows back to their parent code chunk in D1.

## Commands

### cfcode CLI (production)

```bash
cfcode --help
cfcode index <repo-path>                          # full-index a codebase
cfcode reindex <repo-path>                        # diff reindex (base=stored active_commit)
   [--base <ref>] [--target <ref>]
cfcode status [<repo-path>]                       # live worker state via gateway
cfcode list                                       # gateway D1 registry
cfcode uninstall <repo-path>                      # tear down resources + unregister
cfcode mcp-url                                    # print the single MCP URL
```

### POC smoke runs

```bash
# 26-series (CF-native indexing) — all PASS
node cloudflare-mcp/scripts/poc-26d3-full-lumae-job.mjs
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs

# 27-series (stateful MCP gateway) — all PASS
node cloudflare-mcp/scripts/poc-27g-lumae-via-gateway-smoke.mjs

# 28-series (HyDE per-chunk pipeline) — A-D PASS; E-G superseded by Phase 30
node cloudflare-mcp/scripts/poc-28a-worker-deepseek-smoke.mjs

# 29-series (sharded DO fan-out for code-only) — ALL PASS, 12-15× speedup
node cloudflare-mcp/scripts/poc-29a-baseline-bench.mjs           # 6.04 cps baseline
node cloudflare-mcp/scripts/poc-29d-shard-fanout-bench.mjs       # 90.17 cps, 14.93×
node cloudflare-mcp/scripts/poc-29e-shard-tuning-bench.mjs       # tuning sweep
node cloudflare-mcp/scripts/poc-29f-canonical-port-smoke.mjs     # canonical worker port
node cloudflare-mcp/scripts/poc-29g-income-scout-bun-bench.mjs   # real codebase

# 30-series (HyDE in dual fan-out) — ALL PASS
node cloudflare-mcp/scripts/poc-30a-hyde-shard-bench.mjs         # 122 vps in shards
node cloudflare-mcp/scripts/poc-30b-hyde-enrich-bench.mjs        # /hyde-enrich resumable
node cloudflare-mcp/scripts/poc-30c-dual-fanout-bench.mjs        # dual fan-out (no combined)
node cloudflare-mcp/scripts/poc-30d-multi-repo-bench.mjs         # 4 codebases
node cloudflare-mcp/scripts/poc-30e-sa-scaling-bench.mjs         # 2-vs-3-vs-4 SAs
```

### Worker deploys

```bash
# Gateway (one-time setup or after gateway src changes)
cd cloudflare-mcp/workers/mcp-gateway
npx wrangler deploy --config wrangler.generated.jsonc

# Codebase user worker (lumae example, in namespace)
cd cloudflare-mcp/workers/codebase
npx wrangler deploy --config wrangler.lumae-namespace.jsonc \
   --dispatch-namespace cfcode-codebases
```

### MCP client smoke (raw streamable-http via SDK)

```bash
node cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs
# Connects to gateway, lists tools, calls list_codebases — proves protocol works
```

### Legacy Qdrant local MCP (still works, not active dev)

```bash
venv/bin/python -m py_compile src/qdrant-openai-indexer.py
python3 src/qdrant-openai-indexer.py /path/to/code
python3 src/mcp-qdrant-openai-wrapper.py
npm run start    # background indexer
```

## Repository Layout

```
qdrant-mcp-server/
├── EXECUTION_PLAN.md                 # Master POC plan, ledger of every PASS
├── AGENT_HANDOFF_MASTER_PLAN.md      # Per-event progress log with commit hashes
├── CLAUDE.md / AGENTS.md / README.md # This file + agent + human docs
├── .cfapikeys                        # GITIGNORED. CF + DeepSeek secrets
├── cloudflare-mcp/                   # ACTIVE — cfcode v2
│   ├── cli/cfcode.mjs                #   global CLI (~/bin/cfcode → here)
│   ├── lib/                          #   shared modules: env, exec, http, files, cf, gateway, wfp-secret
│   ├── workers/
│   │   ├── codebase/                 #   per-codebase user worker (deployed PER repo)
│   │   └── mcp-gateway/              #   the ONE MCP gateway worker
│   ├── poc/                          #   throwaway POCs, 26-28 series
│   ├── scripts/                      #   POC smoke runners
│   └── sessions/                     #   generated artifacts (mostly gitignored)
├── src/                              # LEGACY — local Qdrant Python MCP
├── openai-batch-worker/              # LEGACY — older HyDE/embedding worker
├── benchmarks/                       # lumae golden eval results
└── ephemeral/                        # handoff prompts, agent bundles, scratch
```

## Production Resources (live)

| Resource | Name | Purpose |
|---|---|---|
| Worker | `cfcode-gateway` | Stateful MCP gateway, McpAgent + DO |
| D1 | `cfcode-gateway-registry` | Codebase registry (slug, indexed_path) |
| Dispatch namespace | `cfcode-codebases` | Holds all per-codebase user workers |
| Worker (in ns) | `cfcode-codebase-lumae-fresh` | Lumae's per-codebase worker |
| R2 | `cfcode-lumae-fresh-artifacts` | Lumae's chunk artifacts |
| D1 | `cfcode-lumae-fresh-v2` | Lumae's chunks + jobs + git_state |
| Vectorize | `cfcode-lumae-fresh-v2` | Lumae's 1536d vectors |
| Queue | `cfcode-lumae-fresh-work` (+ DLQ) | Lumae's indexing queue |

## Safety Contracts (locked in by 2026-04-30 council review)

These are non-negotiable for any worker that touches the indexing or search path:

1. **Vectorize metadata indexes for `repo_slug`, `file_path`, `active_commit` MUST be created before any vector insert.** Limit is 10 metadata indexes per Vectorize index.
2. **D1 `active = 1` rows are SOURCE OF TRUTH** for search filtering. Vectorize is eventually consistent; ALWAYS cross-check Vectorize matches against D1.
3. **Queues are at-least-once.** Consumers MUST be idempotent. Use `INSERT OR REPLACE` everywhere. Use `COUNT(*)` for job counters, NOT `completed = completed + 1`.
4. **Soft-delete first** (D1 `active = 0`), THEN optional Vectorize `deleteByIds` (async, may lag seconds).
5. **Deterministic IDs.** `chunk_id = sha256(file_path:chunk_index).slice(0, 16)`. HyDE: `${chunk_id}-h${i}`.
6. **Cleanup MUST remove Queue consumer bindings before deleting Workers/Queues.**
7. **No Cloudflare Workflows.** Use Workers + Queues + R2 + D1 + Vectorize + Durable Objects only.

## Critical Gotchas (each cost real time)

### 1. MCP server config lives in `~/.claude.json`, NOT `~/.claude/settings.json`

Both files exist with similar shapes. Claude Code reads `mcpServers` from `~/.claude.json` only. To install:

```bash
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.mcpServers = c.mcpServers || {};
c.mcpServers.cfcode = { type: "http", url: "https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp" };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
# Then fully quit + relaunch Claude Code (NOT /reset, full process restart).
```

### 2. `wrangler secret put` does NOT support `--dispatch-namespace`

As of wrangler 4.87. To set a secret on a Workers-for-Platforms user worker, use `cloudflare-mcp/lib/wfp-secret.mjs` which calls the multipart upload API directly.

### 3. McpAgent default DO binding name MUST be `MCP_OBJECT`

`McpAgent.serve("/mcp")` looks up `env.MCP_OBJECT` by convention. Custom names cause `Could not find McpAgent binding for MCP_OBJECT` at runtime. Match the convention in wrangler config.

### 4. `agents` package + `zod` versions

`agents@^0.12.0` requires `zod@^4.0.0` (peer dep). Earlier zod 3.x conflicts. Add `lib: ["ES2022", "DOM"]` + `skipLibCheck: true` in tsconfig (for the `ai` peer's DOM types).

### 5. Compatibility flag

`compatibility_flags: ["nodejs_compat"]` required for the `agents` package.

### 6. CF Worker outbound fetch concurrency cap (≈6 per origin per isolate)

Discovered in 30A: each Worker isolate caps concurrent outbound fetches per origin to ~6. Hammering DeepSeek with `Promise.all` over 158 chunks-per-shard didn't run all 158 in parallel — they queued at 6-at-a-time, taking ~200s instead of ~7s. **Fix:** more shards (each shard = own isolate = own ~6-wide pool). 16 hyde shards × 6 concurrent = 96 effective DeepSeek concurrency, drops wall to ~28s on lumae.

### 7. NEVER write a "combined mode" DO

User directive (2026-05-01): no DO does both code AND HyDE in `Promise.all`. Code DO and HyDE DO are SEPARATE classes with separate `idFromName(...)` namespaces, fired as TWO `Promise.allSettled` populations from the producer. Each path becomes available on its own timeline (code in ~8s, HyDE in ~70s).

## Phase Status (as of 2026-05-01)

| Phase | Status | What it shipped |
|---|---|---|
| 26A1-26E5 | ✅ ALL PASS | Cloudflare-native indexing + diff-driven incremental |
| 27A-27G | ✅ ALL PASS | Stateful MCP gateway via Workers for Platforms |
| 28A-28D | ✅ PASS | HyDE per-chunk pipeline POCs (superseded by Phase 30) |
| 28E-28G | ⚪ SUPERSEDED by Phase 30 architecture |
| 29A-29G | ✅ ALL PASS | Sharded DO fan-out for code path. Lumae **6 → 90 cps (15×)**. Income-scout-bun **78.5 cps (12.99×)**. Canonical worker now has DO + `/ingest-sharded`. |
| 30A | ✅ PASS | HyDE+code parallel inside one shard (122 vps, but combined mode banned) |
| 30B | ✅ PASS | `/hyde-enrich` resumable endpoint — gap-fill works (`missing_hyde: 632 → 12 → 8`) |
| 30C | ✅ PASS | **Dual fan-out**: code shards + hyde shards as TWO independent `Promise.allSettled` populations. Lumae 632 chunks: code 8.3s, hyde 72.3s, e2e 73.3s. |
| 30D | ✅ PASS | 4 real codebases benched: cfpubsub-scaffold 28.7s, reviewer-s-workbench 69.1s, node-orchestrator 28.4s, launcher (process killed mid-run) |
| 30E | ✅ PASS (with finding) | 2 vs 3 vs 4 SAs on lumae. Wall time drops monotonically (74s → 54s → 47s) BUT hyde completion DROPS (97.9% → 69.3% → 56.7%). More SAs alone don't break past Vertex quota — they trade integrity for wall time. |

**Current production decision rule:** Default to `NUM_SAS=2, hyde_shard_count=16` for the dual fan-out (Run A in 30E) — best completion rate at acceptable wall time. `/hyde-enrich` cleans up the small (~2%) gap. Higher concurrency only helps if combined with longer Vertex retry windows or actual quota increase.

### Production cutover status

- **Canonical worker source (`workers/codebase/src/index.ts`)** has `IndexingShardDO`, `/ingest-sharded`, KV oauth cache (29F port). Backwards-compatible: legacy `/ingest` still works.
- **Production lumae user worker** (`cfcode-codebase-lumae-fresh`) is still running the PRE-29 worker — search works fine, but reindexes use slow queue path. Cutover requires redeploy + DO migration (additive).
- **`cfcode index` CLI** still calls `/ingest`, not `/ingest-sharded`. To benefit from the new path in production, CLI needs a one-line update + flag for sharded mode.

## Handoff Discipline

After every meaningful unit of progress:
1. Update `EXECUTION_PLAN.md` POC entry with `Status: PASS — <date>` + commit hash + filled checkboxes.
2. Append to `AGENT_HANDOFF_MASTER_PLAN.md` Progress Log: timestamp, completed work, files touched, exact next step, blockers.
3. Commit with `POC NN PASS:` or `PLAN REVISION:` prefix.
4. Push to `mine` (auth: switch to `ajwcontreras`, push, switch back to `awilliamsevrylo`).

## Environment Variables / Credential Paths

```
.cfapikeys at repo root (gitignored):
  CF_GLOBAL_API_KEY=cfk_...
  CF_EMAIL=andrew@evrylo.com
  CF_ACCOUNT_ID=6bce4120096fa9f12ecda6efff1862d0
  CF_ORIGIN_CA_KEY=v1.0-...
  DEEPSEEK_API_KEY=sk-...

Vertex Service Accounts (in /Users/awilliamspcsevents/.config/cfcode/sas/, mode 0600):
  team (1).json                                  → project=evrylo (billing A)            — SA1
  underwriter-agent-479920-af2b45745dac.json     → project=underwriter-agent-479920 (B)  — SA2
  big-maxim-331514-b90fae4428bc.json             → project=big-maxim-331514 (C)          — SA3
  embedding-code-495015-2fa24eece6fa.json        → project=embedding-code-495015 (C)     — SA4 (same billing as SA3)

NOTE: SA files were originally in ~/Downloads. Copied to ~/.config/cfcode/sas/ on
2026-05-01 because user clears Downloads frequently. Update bench scripts to use
the .config path. The original repo path `/Users/awilliamspcsevents/Downloads/team (1).json`
is still referenced in older POC scripts (29A/29D etc.) — those still work as long
as the file exists in Downloads, but new POCs should use the .config path.

Embed model: gemini-embedding-001 (1536d, RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY)
HyDE model:  deepseek-v4-flash (deepseek-chat is deprecated 2026-07-24)
```

Legacy (still configured for the Python local Qdrant MCP):
```
OPENAI_API_KEY              QDRANT_URL                COLLECTION_NAME
OPENAI_EMBEDDING_MODEL      OPENAI_HYDE_MODEL         HYDE_QUESTION_COUNT
CLOUDFLARE_AI_GATEWAY_URL   HYDE_WORKER_URL           EMBEDDING_WORKER_URL
HYDE_PRECOMPUTED_JSONL      DIGEST_SIDECAR_JSONL
```

## GitHub Auth

Pushes go to `mine` (`https://github.com/ajwcontreras/qdrant-mcp-server.git`). Default GH auth is `awilliamsevrylo`. To push:

```bash
gh auth switch -u ajwcontreras
git push mine main
gh auth switch -u awilliamsevrylo    # ALWAYS switch back
```

## When in Doubt

1. Read `EXECUTION_PLAN.md` end-to-end. Every POC has explicit pass criteria; Phase 29 + 30 are at the bottom with full evidence tables.
2. Read project memory at `~/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/`. Index in `MEMORY.md`.
3. Most recent state: `project_session_2026-05-01b_phase29_30.md` (created in this session).
4. Architecture map: `reference_cfcode_architecture.md` + `reference_shard_fanout.md`.
5. Latest handoff: `ephemeral/handoff-prompt-2026-05-01.md` (rewritten in this session).
