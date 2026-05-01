# cfcode — Cloudflare-native per-codebase MCP code search

This repo ships **`cfcode`**: a global CLI plus a stateful Cloudflare MCP gateway that turns any local git repository into a semantically-searchable MCP endpoint.

```bash
$ cfcode index ~/PROJECTS/myrepo                          # one command per repo
$ cfcode mcp-url
https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp
                                                          # one URL forever
```

Drop that URL into your agent's MCP settings once, never edit again. The gateway routes `select_codebase` + `search` to whichever per-codebase Worker corresponds to the slug you picked.

The repo also still contains a **legacy local Qdrant Python MCP server** (under `src/`) that predates `cfcode`. It works but is no longer the active development direction. See "Legacy Qdrant MCP" near the bottom.

## Why this exists

Existing code search tools either run locally (heavy on a laptop, hard to share) or require running your own vector DB. We wanted:

- **One MCP URL** for any number of codebases — drop into agent settings once
- **Pure Cloudflare** — no local processes after `cfcode index`
- **Per-codebase isolation** — each repo gets its own R2/D1/Vectorize/Queue
- **Dynamic dispatch** — adding a codebase = `wrangler deploy`, no gateway redeploy
- **Resumable, idempotent** — Queues are at-least-once, D1 is the source of truth
- **Eval-driven retrieval quality** — measured against 240 lumae golden queries

## Architecture (one picture)

```
LOCAL                                      CLOUDFLARE
┌──────────────┐                           ┌──────────────────────────┐
│ ~/bin/cfcode │  HTTPS                    │ cfcode-gateway           │
│              │ ────────────────────────► │ (Worker + McpAgent DO)   │
│ chunks files │  /admin/register          │ D1: cfcode-gateway-      │
│ uploads      │  /admin/codebases/:slug/* │     registry             │
└──────────────┘                           │                          │
                                           │  env.DISPATCHER          │
   Claude / Cursor / etc                   │       │                  │
   ──────────────────► /mcp                │       ▼                  │
                                           │ ┌────────────────────┐   │
                                           │ │ cfcode-codebases   │   │
                                           │ │ (dispatch ns, WfP) │   │
                                           │ ├─ cfcode-codebase-  │   │
                                           │ │    lumae-fresh     │   │
                                           │ ├─ cfcode-codebase-  │   │
                                           │ │    <other repos>   │   │
                                           │ └──────┬─────────────┘   │
                                           │        │                 │
                                           │        ▼                 │
                                           │ R2 + D1 + Vectorize +    │
                                           │ Queue (per codebase)     │
                                           │ Vertex gemini-embed-001  │
                                           │ DeepSeek v4-flash (HyDE) │
                                           └──────────────────────────┘
```

## CLI

```bash
cfcode index <repo-path>            # full-index a codebase
cfcode reindex <repo-path>          # diff reindex (base = stored active_commit)
   [--base <ref>] [--target <ref>]
cfcode status [<repo-path>]         # collection_info + git_state
cfcode list                         # gateway D1 registry
cfcode uninstall <repo-path>        # tear down resources + unregister
cfcode mcp-url                      # print the single MCP URL
cfcode --help
```

Future (Phase 28, planned):

```bash
cfcode hyde-enrich <repo>           # add HyDE questions to existing chunks
cfcode hyde-enrich <repo> --bump    # force regenerate (bumps hyde_version)
cfcode rerank <repo>                # enable bge-reranker on this codebase
```

## Install

### One-time on this machine

```bash
git clone https://github.com/ajwcontreras/qdrant-mcp-server.git
cd qdrant-mcp-server

# Symlink CLI globally
ln -sf "$PWD/cloudflare-mcp/cli/cfcode.mjs" ~/bin/cfcode
chmod +x cloudflare-mcp/cli/cfcode.mjs
```

### Credentials (`.cfapikeys` at repo root, gitignored)

```
CF_GLOBAL_API_KEY=cfk_...
CF_EMAIL=you@example.com
CF_ACCOUNT_ID=...
CF_ORIGIN_CA_KEY=v1.0-...   # optional
DEEPSEEK_API_KEY=sk-...      # for Phase 28 HyDE
```

Vertex AI service account JSON expected at `/Users/awilliamspcsevents/Downloads/team (1).json`. Update path in `cloudflare-mcp/cli/cfcode.mjs` if yours differs.

### Install the MCP gateway in Claude Code

```bash
node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.mcpServers = c.mcpServers || {};
c.mcpServers.cfcode = { type: "http", url: "https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp" };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
```

Then **fully quit + relaunch** Claude Code (NOT `/reset`). The MCP server connects at process startup.

**Gotcha:** `~/.claude.json` ≠ `~/.claude/settings.json`. Both files exist, only the former is read for MCP servers.

## Usage in Claude Code

Once the MCP gateway is registered, in any Claude Code session you have these tools:

```
mcp__cfcode__list_codebases
mcp__cfcode__select_codebase({ slug: "lumae-fresh" })
mcp__cfcode__current_codebase
mcp__cfcode__search({ query: "password reset email flow", topK: 5 })
```

Ask: "use cfcode list_codebases", then "select lumae-fresh and search for X".

## What's deployed right now

- **Gateway:** `https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`
- **One codebase indexed:** `lumae-fresh` (608 chunks, full-text searchable)
- **D1 registry:** 1 entry — `lumae-fresh`
- **Dispatch namespace:** `cfcode-codebases` with 1 user worker

## Phase status

| Phase | Status | What it shipped |
|---|---|---|
| 26A1-26E5 (23 POCs) | ✅ ALL PASS | Cloudflare-native indexing + diff incremental |
| 27A-27G (7 POCs) | ✅ ALL PASS | Stateful MCP gateway via Workers for Platforms |
| 28A-28D (4 POCs) | ✅ PASS | HyDE per-chunk pipeline + scaling proof |
| 29A-29G (7 POCs) | ✅ ALL PASS | Sharded DO fan-out: 6→90 cps (15× speedup) |
| 30A-30G (7 POCs) | ✅ ALL PASS | Dual fan-out code+HyDE, 97% completion |
| 31D-31K (10 POCs) | ✅ ALL PASS | Fire-and-forget, R2-pull, 64 hyde shards, council-reviewed |

**Current architecture (31K):** Fire-and-forget producer via DO alarm, 4 code shards + 64 hyde shards, R2-pull per shard, `/hyde-enrich` gap fill. Code searchable in ~10s, full pipeline ~30s for 600-chunk codebases.

Full setup guide: **[SETUP.md](SETUP.md)** — zero to indexed codebase in 14 steps.
Lessons learned: **[LESSONS_LEARNED.md](LESSONS_LEARNED.md)**
CF platform findings: **[CLOUDFLARE_EXPERIMENTAL_FINDINGS.md](CLOUDFLARE_EXPERIMENTAL_FINDINGS.md)** |

POC ledger with commit hashes: `EXECUTION_PLAN.md`. Per-event progress log: `AGENT_HANDOFF_MASTER_PLAN.md`.

## Repo layout

```
qdrant-mcp-server/
├── EXECUTION_PLAN.md                  # POC ledger
├── AGENT_HANDOFF_MASTER_PLAN.md       # Per-timestamp progress log
├── CLAUDE.md / AGENTS.md              # Agent guidance
├── .cfapikeys                         # gitignored secrets
├── cloudflare-mcp/                    # ACTIVE — cfcode v2
│   ├── cli/cfcode.mjs                 # global CLI entry
│   ├── lib/                           # env, exec, http, files, cf, gateway, wfp-secret
│   ├── workers/
│   │   ├── codebase/                  # per-codebase user worker
│   │   └── mcp-gateway/               # the ONE MCP gateway
│   ├── poc/                           # 26+27+28 series throwaway proofs
│   ├── scripts/                       # POC smoke runners
│   └── sessions/                      # generated artifacts (mostly gitignored)
├── src/                               # LEGACY: local Qdrant Python MCP
├── openai-batch-worker/               # LEGACY: older HyDE/embedding worker
├── benchmarks/                        # lumae golden eval results
└── ephemeral/                         # handoff prompts, scratch
```

## Costs

This is the actual minimum spend to run cfcode for one codebase:

- **Workers Paid plan:** $5/mo (required base)
- **Workers for Platforms:** $25/mo flat (includes 20M requests, 60M CPU-ms, 1000 scripts)
- **Vectorize, R2, D1:** Within free / paid plan inclusions for typical usage
- **Vertex AI (Gemini embeddings):** Pay-per-use, ~free for ~1M chunks
- **DeepSeek (HyDE, Phase 28):** ~$0.50-1 per codebase HyDE pass at v4-flash with prompt cache

For just-Andrew personal use that's $30/mo flat plus pennies of usage. If you stop indexing new codebases the steady-state cost is read-only and tiny.

## Safety contracts

These are non-negotiable for any worker that touches indexing or search:

1. **Vectorize metadata indexes** for `repo_slug`, `file_path`, `active_commit` MUST be created before any vector insert.
2. **D1 `active = 1` is source of truth** for search filtering. Vectorize is eventually consistent.
3. **Queues are at-least-once.** Consumers MUST be idempotent. `INSERT OR REPLACE`. `COUNT(*)` for counters.
4. **Soft-delete first** (D1 `active = 0`), then optional async Vectorize `deleteByIds`.
5. **Deterministic IDs** — `chunk_id = sha256(file_path:chunk_index).slice(0, 16)`.
6. **Cleanup removes Queue consumer bindings** before deleting Workers/Queues.

## Phase 28 (HyDE) decision rule

HyDE adds ~12 generated questions per chunk, each embedded as its own Vectorize entry, so search hits paraphrases not just exact code. Cost: ~$0.50-1 per codebase.

POC 28F is the **decision gate**. If lumae golden eval shows MRR delta ≥ +0.05 vs dense-only, ship HyDE. Otherwise pivot to bge-reranker (had +0.227 MRR in earlier 240-query eval, may be a better lift for less complexity).

## Legacy: local Qdrant MCP (still functional)

The original deliverable was a Python MCP server backed by a local Qdrant instance, with HyDE, AST chunking, BM25F, and reranker proven across POC 1-12.

```bash
# Index
python3 src/qdrant-openai-indexer.py /path/to/code

# MCP server (stdio, used by Claude Desktop)
python3 src/mcp-qdrant-openai-wrapper.py

# Background indexer
npm run start    # chokidar file watcher → triggers reindex
npm run status
npm run stop
```

Required env vars (legacy):

```
OPENAI_API_KEY              QDRANT_URL                   COLLECTION_NAME
OPENAI_EMBEDDING_MODEL      OPENAI_HYDE_MODEL            HYDE_QUESTION_COUNT
CLOUDFLARE_AI_GATEWAY_URL   HYDE_WORKER_URL              EMBEDDING_WORKER_URL
HYDE_PRECOMPUTED_JSONL      DIGEST_SIDECAR_JSONL
```

Collections:
- `my-codebase` — single unnamed dense vector (legacy default)
- `my-codebase-v2` — named vectors: `hyde_dense`, `code_dense`, `summary_dense`, sparse `lexical_sparse`

Lumae golden eval results (POC 9b/10c):

| Variant | Recall@5 | Recall@10 | MRR | nDCG@10 |
|---|---|---|---|---|
| Vec+D1 dense | 0.804 | 0.921 | 0.476 | 0.534 |
| + bge-reranker | 0.833 | 0.871 | **0.703** | **0.717** |
| + HyDE prepend | 0.863 | 0.900 | 0.725 | 0.737 |
| + AST + BM25F | 0.875 | 0.921 | **0.776** | **0.776** |

The **cfcode v2** pipeline currently ships only the dense variant (no reranker, no HyDE yet, no AST, no BM25F). Phase 28 closes the gap.

## Contributing

This is a personal-use repo. PRs not expected. Issues / questions: open a GitHub issue.

## License

MIT.
