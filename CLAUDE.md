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

## Active Architecture: cfcode (Phase 26 + 27 SHIPPED, Phase 28 IN FLIGHT)

```
Claude Code / Cursor / any MCP client
    │ ONE URL: https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp
    ▼
cfcode-gateway (Worker + McpAgent Durable Object)
    │ env.DISPATCHER.get(`cfcode-codebase-${slug}`)
    ▼
cfcode-codebases (dispatch namespace, Workers for Platforms)
    ├─ cfcode-codebase-lumae-fresh   ← live, 608 chunks searchable
    ├─ cfcode-codebase-<future>      ← added via `cfcode index <path>`
    └─ ...
        ▼
    per-codebase R2 + D1 + Vectorize + Queue
    Vertex gemini-embedding-001 (1536d) for embeddings
    DeepSeek v4-flash for HyDE (Phase 28, in development)
```

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
# 26-series (Cloudflare-native indexing pipeline) — all PASS, ledger only
node cloudflare-mcp/scripts/poc-26d3-full-lumae-job.mjs        # full lumae index
node cloudflare-mcp/scripts/poc-26e1-git-diff-manifest-smoke.mjs

# 27-series (stateful MCP gateway) — all PASS
node cloudflare-mcp/scripts/poc-27a-wfp-dispatch-smoke.mjs     # plain WfP
node cloudflare-mcp/scripts/poc-27g-lumae-via-gateway-smoke.mjs  # end-to-end

# 28-series (HyDE quality pass) — A-D PASS, E-G pending
node cloudflare-mcp/scripts/poc-28a-worker-deepseek-smoke.mjs
node cloudflare-mcp/scripts/poc-28d-lumae-hyde-reindex-smoke.mjs --limit=50
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

## Phase Status (as of 2026-05-01)

| Phase | Status | What it shipped |
|---|---|---|
| 26A1-26E5 | ✅ ALL PASS | Cloudflare-native indexing + diff-driven incremental |
| 27A-27G | ✅ ALL PASS | Stateful MCP gateway via Workers for Platforms |
| 28A-28D | ✅ PASS | HyDE per-chunk pipeline (Worker calls DeepSeek + batch Vertex), scaling proven |
| 28E-28F | 🚧 PENDING | Dual-channel search + RRF, golden eval **DECISION GATE** |
| 28G | 🔒 Gated | Scale to 9 more codebases (only if 28F shows MRR delta ≥ +0.05) |

**Decision rule:** Phase 28 lives or dies on POC 28F. If lumae golden eval doesn't show ≥ +0.05 MRR lift vs dense-only, drop HyDE and pivot to bge-reranker (had +0.227 MRR in earlier 240-query eval).

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

Vertex SA:  /Users/awilliamspcsevents/Downloads/team (1).json
Project:    evrylo
Embed model: gemini-embedding-001 (1536d, RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY)
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

1. Read `EXECUTION_PLAN.md` end-to-end. Every POC has explicit pass criteria.
2. Read `AGENT_HANDOFF_MASTER_PLAN.md` Progress Log. Per-timestamp status with commit hashes.
3. Read project memory at `~/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/`.
4. The two files that supersede everything else for current state: `project_session_2026-05-01_cfcode_v2.md` and `reference_cfcode_architecture.md`.
