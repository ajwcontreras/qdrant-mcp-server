# AGENTS.md

Repository guidance for coding agents (Codex, Claude Code, etc) working in this repo.

This file is the **operational** counterpart to `CLAUDE.md` (which has the same content but different framing). If you're a Codex sub-agent, this is your primary entry point.

## What this repo ships

The active deliverable is **`cfcode`** — a global CLI plus a Cloudflare-native MCP gateway that turns any local git repo into a semantic-search MCP endpoint.

```
$ cfcode index ~/PROJECTS/myrepo                             # one command
$ cfcode mcp-url
https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp  # one URL forever
```

Drop the URL into `~/.claude.json` mcpServers. Any MCP-aware agent can now `select_codebase("myrepo")` and `search("how is auth implemented")`.

## User constraints (hard, non-negotiable)

- Voice-to-text user. Ask when transcription unclear.
- No glazing. Push back when wrong. Flag cleanup debt.
- Decisive minimal-diff responses.
- **Inline scripts FORBIDDEN.** Every script gets its own file.
- **No Cloudflare Workflows.** Use Workers + Queues + R2 + D1 + Vectorize + Durable Objects only.
- **Don't suggest stopping.** User decides when to stop.
- **POC discipline.** Read EXECUTION_PLAN.md. One POC at a time. Commit + push on PASS. Update plan + AGENT_HANDOFF_MASTER_PLAN.md.

## Commands

### cfcode CLI

```bash
cfcode --help
cfcode index <repo-path>
cfcode reindex <repo-path> [--base <ref>] [--target <ref>]
cfcode status [<repo-path>]
cfcode list
cfcode uninstall <repo-path>
cfcode mcp-url
```

### Type-check + deploy any worker

```bash
cd cloudflare-mcp/workers/<name>
npm install
npm run check                                    # tsc --noEmit
npx wrangler deploy --config wrangler.<...>.jsonc   # standalone
npx wrangler deploy --config wrangler.<...>.jsonc \
  --dispatch-namespace cfcode-codebases             # WfP user worker
```

### Run any POC smoke

```bash
node cloudflare-mcp/scripts/poc-NN-name-smoke.mjs
```

### Legacy local Qdrant MCP (still works)

```bash
venv/bin/python -m py_compile src/qdrant-openai-indexer.py src/mcp-qdrant-openai-wrapper.py
python3 src/qdrant-openai-indexer.py /path/to/code
python3 src/mcp-qdrant-openai-wrapper.py
npm run start    # background indexer (chokidar file watcher)
```

## Architecture map

```
LOCAL                                  CLOUDFLARE
┌──────────────┐                       ┌─────────────────────────┐
│  ~/bin/cfcode│  HTTPS                │  cfcode-gateway         │
│  CLI         │ ────────────────────► │  (Worker + McpAgent DO) │
│              │  /admin/register      │                         │
│              │  /admin/codebases/:slug/<rest>                  │
│              │                       │  D1 cfcode-gateway-     │
│              │                       │  registry (slug, path)  │
└──────────────┘                       │                         │
                                       │  env.DISPATCHER         │
       Claude Code etc                 │       ▼                 │
       ──────────────────► gateway/mcp │  ┌──────────────────┐  │
                                       │  │ cfcode-codebases │  │
                                       │  │ (dispatch ns)    │  │
                                       │  ├─ cfcode-codebase-│  │
                                       │  │    lumae-fresh   │  │
                                       │  ├─ cfcode-codebase-│  │
                                       │  │    <other repos> │  │
                                       │  └─────────┬────────┘  │
                                       │            ▼           │
                                       │  per-codebase R2 +     │
                                       │  D1 + Vectorize +      │
                                       │  Queue                 │
                                       └─────────────────────────┘
```

## Repo layout

```
qdrant-mcp-server/
├── EXECUTION_PLAN.md                  # POC ledger — READ THIS FIRST
├── AGENT_HANDOFF_MASTER_PLAN.md       # Per-timestamp progress log
├── CLAUDE.md / AGENTS.md / README.md
├── .cfapikeys                         # gitignored — CF + DeepSeek
├── cloudflare-mcp/                    # ACTIVE
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

## Phase status (2026-05-01)

| Phase | Status | What it shipped |
|---|---|---|
| 26A1-26E5 | ✅ ALL PASS (23 POCs) | Cloudflare-native indexing + diff incremental |
| 27A-27G | ✅ ALL PASS (7 POCs) | Stateful MCP gateway via WfP dispatch |
| 28A-28D | ✅ PASS (4 POCs) | HyDE per-chunk pipeline + scaling proof |
| 28E-28F | 🚧 NEXT | Dual-channel search + RRF, golden eval gate |
| 28G | 🔒 GATED | Scale to 9 more codebases (only if 28F passes) |

## Production resources (live, do not delete)

- Worker: `cfcode-gateway`
- D1: `cfcode-gateway-registry`
- Dispatch namespace: `cfcode-codebases`
- User worker: `cfcode-codebase-lumae-fresh` (in namespace)
- Lumae's R2/D1/Vectorize/Queue: `cfcode-lumae-fresh-*`
- 608 chunks indexed, searchable through gateway

## Safety contracts (locked in by 2026-04-30 council review)

1. Vectorize metadata indexes (`repo_slug`, `file_path`, `active_commit`) created BEFORE any vector insert.
2. D1 `active = 1` is SOURCE OF TRUTH. Vectorize is eventually consistent. Always cross-check.
3. Queues are at-least-once. INSERT OR REPLACE everywhere. COUNT(*) for counters.
4. Soft-delete (D1 `active = 0`) before optional Vectorize `deleteByIds`.
5. Deterministic IDs: `chunk_id = sha256(file_path:chunk_index).slice(0, 16)`. HyDE: `${chunk_id}-h${i}`.
6. Cleanup removes Queue consumer bindings BEFORE deleting Workers/Queues.

## Critical gotchas

### MCP config: `~/.claude.json` not `~/.claude/settings.json`

```bash
# To install cfcode in Claude Code:
node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.mcpServers = c.mcpServers || {};
c.mcpServers.cfcode = { type: "http", url: "https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp" };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
# Then full quit + relaunch Claude Code.
```

### `wrangler secret put` doesn't support `--dispatch-namespace`

Use the multipart upload API directly. Working code: `cloudflare-mcp/lib/wfp-secret.mjs`.

### `McpAgent.serve()` expects DO binding name `MCP_OBJECT`

Match the convention. Custom names cause "Could not find McpAgent binding" at runtime.

### `agents@^0.12.0` requires `zod@^4.0.0`

Plus `compatibility_flags: ["nodejs_compat"]`, `lib: ["ES2022", "DOM"]`, `skipLibCheck: true`.

## Credential paths

- `.cfapikeys` (gitignored) at repo root — CF_GLOBAL_API_KEY, CF_EMAIL, CF_ACCOUNT_ID, CF_ORIGIN_CA_KEY, DEEPSEEK_API_KEY
- Vertex SA: `/Users/awilliamspcsevents/Downloads/team (1).json` (project=evrylo)
- NEVER print or commit secret values

## GitHub auth

Pushes go to `mine` (`https://github.com/ajwcontreras/qdrant-mcp-server.git`).

```bash
gh auth switch -u ajwcontreras
git push mine main
gh auth switch -u awilliamsevrylo  # ALWAYS switch back
```

## Handoff discipline (mandatory after every POC PASS)

1. Update EXECUTION_PLAN.md POC entry with `Status: PASS — <date>` + filled checkboxes.
2. Append AGENT_HANDOFF_MASTER_PLAN.md Progress Log entry: timestamp, work, files, next step, blockers.
3. Commit with `POC NN PASS:` prefix.
4. Push to mine via the auth-switch dance.

## Pre-existing legacy notes (still relevant for src/ and openai-batch-worker/)

The legacy local Qdrant pipeline used Qdrant collections `my-codebase` and `my-codebase-v2`. Vectors: `hyde_dense`, `code_dense`, `summary_dense`, sparse `lexical_sparse`. Deterministic UUID5 point IDs over (repo, path, chunk identity, chunker version). Don't use content_hash as point ID (collision risk). HyDE cache key: `content_hash + hyde_version + hyde_model`.

Tree-sitter not installed. Symbol extraction is regex.

## When stuck

1. Read `EXECUTION_PLAN.md` end-to-end.
2. Read `AGENT_HANDOFF_MASTER_PLAN.md` Progress Log (newest entries first).
3. Read project memory: `~/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/MEMORY.md`. The most current files are `project_session_2026-05-01_cfcode_v2.md` and `reference_cfcode_architecture.md`.
4. Check `cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs` for a working SDK client smoke if MCP debugging.
