# Handoff Prompt — qdrant-mcp-server / cfcode v2

**Date written:** 2026-05-01 (overnight session)
**Receiver:** Codex agent OR future Claude session — you do not know which. Read this whole document, then begin.
**User:** Andrew Williams (`andrew@evrylo.com`). Voice-to-text, fast, intense, no-glazing, push-back-when-wrong. He may have switched LLM providers between sessions due to usage limits, so do not assume any prior context survives.

This handoff is intentionally large (~40KB+) because it inlines all relevant project memory and recent session state. If you read this whole document, you should be able to proceed without consulting anything else, although the live files referenced are still authoritative if there's any conflict.

---

## TL;DR — Where we are, in 60 seconds

The repo `/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server` ships **`cfcode`**, a global CLI plus a Cloudflare-native stateful MCP gateway. One MCP URL (`https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`) routes to per-codebase Workers via Workers for Platforms dispatch namespace. **It works end-to-end against real lumae (608 chunks)** — verified inside Claude Code itself.

**Two phases shipped (30 POCs total):**
- Phase 26 (A1-E5): Cloudflare-native indexing pipeline + diff-driven incremental — 23 POCs PASS.
- Phase 27 (A-G): Stateful MCP gateway via Workers for Platforms — 7 POCs PASS.

**Phase 28 (HyDE quality pass) is in flight.** Per-chunk pipeline (DeepSeek HyDE → batch Vertex embed → Vectorize upsert) is built and proven. Lumae HyDE re-index at 50-chunk subset PASSED in 95s. Next step is the 28E dual-channel search + 28F lumae golden eval **decision gate**.

**Hard blocker before scaling HyDE to 10 codebases:** lumae golden eval (28F) must show MRR delta ≥ +0.05 vs dense-only. If not, drop HyDE and pivot to bge-reranker.

**You probably need to:** keep building 28E and 28F. See the "Specific next steps" section near the end.

---

## Who you are talking to

Andrew Williams, `andrew@evrylo.com`. Hard preferences:

- **Voice-to-text user** because of finger injuries. Transcriptions can be ambiguous, ask when unclear rather than guessing. Don't read aloud emojis or punctuation to him; speak natural.
- **Fast and intense.** Will interrupt mid-task with new directions. Acknowledge then finish current step UNLESS the interrupt is correcting a mistake.
- **No glazing.** Be objective. Push back when wrong. Flag cleanup debt proactively. He explicitly said: "I wanna improve."
- **Decisive, minimal-diff responses.** Skip preamble. Senior-engineer tone.
- **Never suggest stopping.** He decides when to stop. Don't ask "want to call it here?" or "should we save state?"
- **Architecturally strong** but accumulates debt. After build sessions proactively flag what needs hardening.
- **Writes scripts to FILES.** Inline heredocs in Bash calls are forbidden. Every script gets its own file in `cloudflare-mcp/poc/`, `cloudflare-mcp/scripts/`, `eval/`, or `ephemeral/`. He corrected this explicitly and strongly.

If audio mode is active in your environment (look for a persistent system reminder mentioning the `accessibility-audio-report` skill), prefix every response with a one-line `TLDR:` and immediately invoke `agent-speak` with that TLDR. The TLDR must be terse and high-signal: result + biggest blocker + next action.

---

## The architecture you're working in

```
LOCAL                                      CLOUDFLARE
┌──────────────┐                           ┌──────────────────────────┐
│ ~/bin/cfcode │  HTTPS                    │ cfcode-gateway           │
│              │ ────────────────────────► │ (Worker + McpAgent DO)   │
│ chunks repo  │  /admin/register          │                          │
│ uploads JSONL│  /admin/codebases/:slug/* │ D1: cfcode-gateway-      │
└──────────────┘                           │     registry             │
                                           │                          │
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

**Why this shape:**
- **One MCP URL** = drop into agent settings once, never edit again.
- **Workers for Platforms dispatch namespace** = adding a codebase = `wrangler deploy`, no gateway redeploy.
- **Per-codebase isolation** = each repo has its own R2/D1/Vectorize/Queue. Failures scoped.
- **McpAgent + DO** = per-MCP-session state holds the selected codebase slug.
- **DeepSeek + Vertex inside the Worker** = pure Cloudflare, no local processes.

---

## Repo layout

```
qdrant-mcp-server/
├── EXECUTION_PLAN.md                    # POC ledger — READ THIS FIRST
├── AGENT_HANDOFF_MASTER_PLAN.md         # Per-timestamp progress log
├── CLAUDE.md / AGENTS.md / README.md    # Agent + human guidance
├── .cfapikeys                           # gitignored — CF + DeepSeek secrets
├── cloudflare-mcp/                      # ACTIVE — cfcode v2
│   ├── cli/cfcode.mjs                   # global CLI entry (~/bin/cfcode → here)
│   ├── lib/                             # shared modules
│   │   ├── env.mjs                      # loadCfEnv, repoSlugFromPath, name conventions
│   │   ├── exec.mjs                     # run(), git()
│   │   ├── http.mjs                     # fetchJson, waitHealth, pollPublished
│   │   ├── files.mjs                    # listSourceFiles, buildFullChunks, buildDiffManifest, buildIncrementalArtifact
│   │   ├── cf.mjs                       # provisionResources, deployToNamespace, setNamespaceVertexSecret, teardownResources
│   │   ├── gateway.mjs                  # GATEWAY_URL, listCodebases, registerCodebase, unregisterCodebase, proxyToCodebase
│   │   ├── wfp-secret.mjs               # multipart upload API for WfP user worker secrets
│   │   └── state.mjs                    # ~/.config/cfcode legacy (kept but unused in v2)
│   ├── workers/
│   │   ├── codebase/                    # per-codebase user worker (deployed PER repo)
│   │   │   ├── src/index.ts             # ingest/incremental-ingest/queue consumer/search/git-state
│   │   │   ├── wrangler.template.jsonc       # standalone deploy template
│   │   │   ├── wrangler.namespace.template.jsonc # WfP namespace deploy template (no queue consumer)
│   │   │   ├── wrangler.lumae.jsonc          # lumae standalone (legacy, still deployed)
│   │   │   └── wrangler.lumae-namespace.jsonc # lumae as namespace user worker (current)
│   │   └── mcp-gateway/                 # the ONE MCP gateway worker
│   │       ├── src/index.ts             # McpAgent + tools + admin endpoints + dispatch routing
│   │       └── wrangler.template.jsonc
│   ├── poc/                             # 26+27+28 series throwaway smokes
│   ├── scripts/                         # POC smoke runners
│   └── sessions/                        # generated artifacts (mostly gitignored)
├── src/                                 # LEGACY: local Qdrant Python MCP — still works
├── openai-batch-worker/                 # LEGACY: older HyDE/embedding worker
├── benchmarks/                          # lumae golden eval results
└── ephemeral/                           # handoff prompts, agent bundles, scratch
```

---

## Naming conventions (memorize these)

For repo with slug `myrepo` (derived from path basename via `repoSlugFromPath` — lowercased, alnum+hyphens, ≤40 chars):

- User worker (in namespace): `cfcode-codebase-myrepo`
- R2 bucket: `cfcode-myrepo-artifacts`
- D1 db: `cfcode-myrepo`
- Vectorize index: `cfcode-myrepo`
- Queue: `cfcode-myrepo-work` + DLQ `cfcode-myrepo-work-dlq`

Gateway-side fixed:
- Worker: `cfcode-gateway`
- D1: `cfcode-gateway-registry`
- Dispatch namespace: `cfcode-codebases`

---

## What's live in production right now

- **Gateway URL (drop in MCP settings):** `https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`
- **Lumae user worker:** `cfcode-codebase-lumae-fresh` in dispatch namespace `cfcode-codebases`
- **D1 registry:** `cfcode-gateway-registry` — 1 entry: `lumae-fresh :: /Users/awilliamspcsevents/PROJECTS/lumae-fresh`
- **Lumae chunks:** 608 indexed, code-vector-only (no HyDE yet), all searchable
- **CLI globally available:** `~/bin/cfcode` → `/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/cloudflare-mcp/cli/cfcode.mjs`
- **MCP attached in Claude Code:** Yes, configured in `~/.claude.json` `mcpServers.cfcode`. Verified live in this session: `list_codebases`, `select_codebase`, `search` all return real lumae results.

To verify yourself (in a fresh terminal):

```bash
cfcode list                      # should print: lumae-fresh ...
curl -s https://cfcode-gateway.frosty-butterfly-d821.workers.dev/health
curl -s https://cfcode-gateway.frosty-butterfly-d821.workers.dev/admin/codebases | jq
```

---

## Phase status (2026-05-01 06:50 UTC)

| Phase | Status | Commit | Notes |
|---|---|---|---|
| 26A1-26E5 (23 POCs) | ✅ ALL PASS | `c3295cc` and earlier | Cloudflare-native indexing + diff incremental |
| 27A-27G (7 POCs) | ✅ ALL PASS | `bb593ea` end-to-end | Stateful MCP gateway via WfP dispatch |
| Step 1 — canonical worker | ✅ DEPLOYED | `2e7bc86` | Workers reorganized into `workers/codebase/` and `workers/mcp-gateway/` |
| Step 2 — cfcode CLI v1 | ✅ DEPLOYED | `a39cf82` | Symlinked to `~/bin/cfcode` |
| CLI integration with gateway | ✅ DEPLOYED | `60188fc` | CLI talks exclusively to gateway, gateway has admin proxy |
| Gitignore secrets | ✅ DONE | `024fcdd` | `.cfapikeys`, `.deepseekkey`, etc |
| 28A — Worker calls DeepSeek | ✅ PASS | `3dc8df3`, `1fae666` | v4-flash, 6s, prompt cache works |
| 28B — Batch Vertex embed 12 q | ✅ PASS | `5533d39` | 12×1536d in <3s |
| 28C — Per-chunk pipeline | ✅ PASS | `43a294e` | 13 vectors + 13 D1 rows in 15s |
| 28D — Lumae HyDE 50-chunk subset | ✅ PASS | `0e46c4a` | 47+564=611 vectors in 95s |
| 28E — Dual-channel search + RRF | 🚧 NEXT | — | Worker side; smoke against existing 28D fixture or fresh full lumae |
| 28F — Lumae golden eval | 🚧 GATE | — | DECISION POINT |
| 28G — Scale to 9 more codebases | 🔒 GATED | — | Only if 28F shows MRR delta ≥ +0.05 |

---

## Recent session timeline (chronological)

This session started ~2026-04-30 with POC 26E3 already PASS-pending and ran through to 2026-05-01 06:50 UTC. Major events in order:

1. **POC 26E3 PASS** — local incremental diff packager produces JSONL artifact (14 records, 60014 bytes). Pushed (`1ff6f71`).
2. **POC 26E4 PASS** — Worker `/incremental-ingest` deactivates stale chunks, queues whole-file re-embedding, advances git state. Pushed (`df07d77`).
3. **POC 26E5 PASS** — generated docs include diff reindex commands. The full 26-series is now closed.
4. **User wanted "global CLI as final thing".** Pivoted to plan-out productionization.
5. **Step 1 — canonical worker:** merged 26D1 + 26E4 endpoints into `cloudflare-mcp/worker/`, deployed to live lumae, verified 14-file incremental against real 608-chunk index works. Pushed (`2e7bc86`).
6. **Step 2 — cfcode CLI v1:** built `cli/cfcode.mjs` + `lib/{env,exec,http,files,cf,state}.mjs`, symlinked to `~/bin/cfcode`. Verified `list` and `status` against live lumae. Pushed (`a39cf82`).
7. **User pushed back on architecture:** asked for stateful MCP server (one URL, dynamic codebase selection). I proposed Workers for Platforms dispatch namespace. User chose dispatch namespace. Phase 27 began.
8. **Tidy reorg:** `cloudflare-mcp/worker/` → `cloudflare-mcp/workers/codebase/`, added `workers/mcp-gateway/`. Pushed (`764fd67`).
9. **27-series PLAN REVISION** committed (`9f753f1`).
10. **POC 27A PASS** — plain Workers for Platforms dispatch routing (`2ea6d56`).
11. **POC 27B PASS** — stateful MCP server via McpAgent. Discovered the `MCP_OBJECT` binding name convention. Pushed (`89e9dc4`).
12. **POC 27C PASS** — McpAgent gateway proxies into dispatch namespace (`4a0b00a`).
13. **POC 27D PASS** — list_codebases reads D1 registry (`6b584d8`).
14. **POC 27E PASS** — search round-trip through dispatch (`c3295cc`).
15. **POC 27F PASS** — production gateway deployed end-to-end (`8b8fc27`). Pivot from original 27F scope — built persistent gateway here, CLI integration moved to 27G.
16. **POC 27G PASS** — lumae searchable via gateway end-to-end (`bb593ea`). Discovered: `wrangler secret put` doesn't support `--dispatch-namespace`. Built `cloudflare-mcp/lib/wfp-secret.mjs` (multipart API).
17. **CLI integration with gateway** — refactored cfcode CLI to talk exclusively to gateway. Pushed (`60188fc`).
18. **MCP install bug** — first put `cfcode` in `~/.claude/settings.json` (wrong file). Debugged via MCP SDK client smoke (proved server works). Found Claude Code reads `mcpServers` from `~/.claude.json`. Moved entry, restart, verified working from inside Claude Code.
19. **User asked for HyDE quality pass.** Provided DeepSeek API key. Phase 28 began.
20. **Critical safety fix** — `.cfapikeys` was untracked but NOT gitignored. Fixed (`024fcdd`).
21. **PLAN REVISION 28-series** with HyDE-runs-on-Cloudflare correction (`31ca925`).
22. **POC 28A PASS** — Worker calls DeepSeek v4-flash for HyDE, 6s, prompt cache 256 hit (`3dc8df3`, `1fae666`).
23. **POC 28B PASS** — Worker batches 12 question Vertex embed in single call, <3s (`5533d39`).
24. **POC 28C PASS** — full per-chunk pipeline: parallel(DeepSeek HyDE || Vertex code embed) → Vertex batch embed 12 questions → upsert 13 vectors → D1 13 rows. 15s for one chunk. (`43a294e`).
25. **POC 28D PASS (50-chunk subset)** — pipeline scales at queue concurrency=25, 47 code + 564 hyde, 95s wall time. Pushed (`0e46c4a`).
26. **User stopped** before full 608-chunk run. Asked for resumability + separability of HyDE. Confirmed: HyDE will be a separate `cfcode hyde-enrich <repo>` command, idempotent, picks up missing-or-stale HyDE rows. Reranker = future search-time addition.
27. **You are here.** Next step is whichever of 28E, full 28D, or full integration the user greenlights.

---

## The handoff between us

You may not be the same agent that wrote this. If you are Codex, Claude is the prior author. If you are Claude, you may be a fresh session and not the same Claude as before. Treat this document as the source of truth.

Per the user's words: "this is for a Codex agent or it might be you, but I'm not sure. I know that I probably have to change agents because of my usage level."

So: read every section. Don't assume context. Verify state with `cfcode list`, `git log --oneline -10`, and the live gateway URL before taking any action.

---

## Specific next steps

### Where the user paused

POC 28D (50-chunk subset) PASSED. The user stopped me before the full 608-chunk run with: "Why is this taking so long? It's been fifteen minutes."

I gave them three options. They responded: "K. As long as you're gonna integrate this into the pipeline as a resumable thing, that will then just be a command that can be run by either the CLI or the MCP, whichever makes more sense, to either reindex." Then: "Take your time. Sorry for bothering you."

### Three honest paths forward

**Path A: Run the full 608-chunk lumae HyDE re-index (~20 min, ~$1).**

This enables the eval gate (28F) and gives a real number on whether HyDE helps. The smoke is `cloudflare-mcp/scripts/poc-28d-lumae-hyde-reindex-smoke.mjs` (no `--limit`). It creates throwaway resources, ingests, polls, cleans up — but the cleanup means we can't use those resources for 28E/28F. **You must keep the resources alive.** Easiest fix: edit the smoke to accept `--keep` and skip cleanup; or manually create a new persistent worker.

**Path B: Build POC 28E first (dual-channel search + RRF) using the existing 47-chunk index.**

But the resources from 28D got cleaned up. Re-deploy 28D worker, ingest 50 chunks again with --keep, then build 28E search on top. Smaller eval signal but cheaper.

**Path C: Skip the discrete POCs.** Hack HyDE directly into the canonical `workers/codebase/` worker, redeploy lumae with HyDE on, run eval against production. Riskier (touches live system) but faster path to a real number.

### My recommendation

Path A. Hard reasons:
- 20 minutes wall time, $1 cost — not enough to skip.
- The whole purpose of 28F is the eval gate — running it against 47 chunks gives noisy MRR numbers.
- Path C touches production lumae search, which the user is currently using (search worked from inside Claude Code in this session). Don't break that without a fallback.

Specific edits to make Path A work:

1. Edit `cloudflare-mcp/poc/28d-lumae-hyde-reindex/src/index.ts` to add a `/search` endpoint that supports both `kind=code` and `kind=hyde` filtering with RRF.
2. Modify smoke to either `--keep` resources, or restructure: provision once at start of session, run the smoke once with `--keep`, then run 28E search smoke against the same resources.
3. Wait ~20 min for full 608-chunk ingestion. While waiting, build 28E search-side code.
4. Run eval (28F) against the running index using `benchmarks/lumae_eval_bm25f.json` golden queries.

### If 28F shows MRR delta ≥ +0.05

Build POC 28G:
1. Migrate canonical `workers/codebase/src/index.ts` to support HyDE-enabled mode (probably: env var `ENABLE_HYDE=1`, queue consumer does HyDE generation if set).
2. Add `cfcode hyde-enrich <repo>` CLI command:
   - Query gateway for the codebase's chunks lacking HyDE
   - POST artifact for each chunk to `/hyde-enrich-ingest` endpoint
   - Worker: queue consumer generates HyDE for that chunk only (skips code embed), upserts hyde vectors + D1 rows
   - Resumable: re-run picks up where it left off
3. Deploy update to `cfcode-codebase-lumae-fresh`. Run `cfcode hyde-enrich /path/to/lumae`.
4. Get list of 9 more codebases from user. Run `cfcode index <path>` then `cfcode hyde-enrich <path>` for each. Total time ~3-4 hours.

### If 28F shows MRR delta < +0.05

Pivot. Skip 28G. Do this instead:
1. POC 28R (R for Reranker): add Workers AI binding `[ai]` to canonical worker. In `/search`, after Vectorize topK=30, call `@cf/baai/bge-reranker-base` to rerank top-10. The earlier eval showed +0.227 MRR with reranker — likely a bigger lift than HyDE for less complexity.
2. Re-run lumae golden eval. If reranker gives the lift, ship it to all codebases (no per-codebase migration — just redeploy canonical worker once).
3. Tear down the 28D throwaway resources.

---

## Files / commits / commands cheat sheet

### Critical files

```
EXECUTION_PLAN.md                         POC ledger, every PASS recorded with criteria
AGENT_HANDOFF_MASTER_PLAN.md              Per-timestamp progress log
CLAUDE.md                                 Agent guidance
AGENTS.md                                 Agent guidance (Codex-leaning)
README.md                                 Human-facing
.cfapikeys                                gitignored secrets
cloudflare-mcp/cli/cfcode.mjs             CLI entry
cloudflare-mcp/lib/wfp-secret.mjs         Multipart upload API helper
cloudflare-mcp/workers/codebase/src/index.ts        Per-codebase worker
cloudflare-mcp/workers/mcp-gateway/src/index.ts     Gateway worker
cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs MCP SDK debug client
benchmarks/lumae_eval_bm25f.json          240 golden queries (decision gate input)
```

### Recent commit chain (newest first)

```
0e46c4a POC 28D PASS: lumae HyDE fan-out scales (50-chunk subset)
43a294e POC 28C PASS: queue consumer does HyDE + embed + upsert per chunk
5533d39 POC 28B PASS: Worker batches 12 HyDE embeddings in single Vertex call
1fae666 POC 28A status update in plan
3dc8df3 POC 28A PASS: Worker calls DeepSeek v4-flash for HyDE
31ca925 PLAN REVISION 28-series: HyDE generation moves into Worker (pure Cloudflare)
024fcdd Gitignore secrets: .cfapikeys, .deepseekkey, .env.local, *.pem, *.key
60188fc Integrate cfcode CLI with gateway: ONE MCP URL, dynamic codebase routing
bb593ea POC 27G PASS: lumae searchable via gateway end-to-end
8b8fc27 POC 27F PASS: persistent production gateway deployed end-to-end
c3295cc POC 27E PASS: search tool round-trips through dispatch
6b584d8 POC 27D PASS: list_codebases reads D1 registry
4a0b00a POC 27C PASS: McpAgent gateway proxies into dispatch namespace
89e9dc4 POC 27B PASS: stateful MCP server via McpAgent persists session state
2ea6d56 POC 27A PASS: Workers for Platforms dispatch routes by name at runtime
9f753f1 PLAN REVISION: add 27-series POC chain for stateful MCP gateway
764fd67 Tidy: cloudflare-mcp/worker -> cloudflare-mcp/workers/codebase
a39cf82 Productionize step 2: cfcode global CLI
2e7bc86 Productionize step 1: canonical worker deployed to live lumae
```

### Common commands

```bash
# CLI
cfcode --help
cfcode list                                # gateway-side codebase list
cfcode status /Users/awilliamspcsevents/PROJECTS/lumae-fresh
cfcode mcp-url
cfcode index <path>                        # full-index a new codebase
cfcode reindex <path>                      # diff reindex
cfcode uninstall <path>

# Smoke runs
node cloudflare-mcp/scripts/poc-28d-lumae-hyde-reindex-smoke.mjs --limit=50
node cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs    # MCP SDK debug

# Worker deploy
cd cloudflare-mcp/workers/mcp-gateway && npx wrangler deploy --config wrangler.generated.jsonc
cd cloudflare-mcp/workers/codebase && npx wrangler deploy --config wrangler.lumae-namespace.jsonc --dispatch-namespace cfcode-codebases

# GitHub auth dance (every push)
gh auth switch -u ajwcontreras
git push mine main
gh auth switch -u awilliamsevrylo

# Audio TLDR (if accessibility-audio-report skill is active)
agent-speak "TLDR: <one sentence>"
```

### Loading CF env vars from .cfapikeys (every script needs this)

```javascript
function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;          // critical — token auth conflicts with global key auth
  for (const line of fs.readFileSync(".cfapikeys", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim();
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    if (k.trim() === "DEEPSEEK_API_KEY") env._DEEPSEEK_API_KEY = v;
  }
  return env;
}
```

---

## Critical gotchas (each cost real time this session)

### 1. Claude Code MCP servers live in `~/.claude.json`, NOT `~/.claude/settings.json`

Two files exist with similar shapes. Only `~/.claude.json` is read by the MCP loader. The other holds permissions, theme, hook config.

**Symptom:** Adding `mcpServers.foo` to `~/.claude/settings.json`, restarting, getting NO `mcp-logs-foo` directory under `~/Library/Caches/claude-cli-nodejs/`.

**Fix:**

```bash
node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.mcpServers = c.mcpServers || {};
c.mcpServers.cfcode = { type: "http", url: "https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp" };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
# Then full quit + relaunch Claude Code.
```

### 2. `wrangler secret put` does NOT support `--dispatch-namespace`

As of wrangler 4.87.0. To set a secret on a Workers-for-Platforms user worker, use `cloudflare-mcp/lib/wfp-secret.mjs` which calls the multipart upload API directly. The script:

1. GETs the worker's content (returns multipart with the JS body)
2. Parses the multipart, extracts the JS body, finds entrypoint name from `cf-entrypoint` header
3. Constructs a new multipart upload with the same JS body + `bindings: [{type:"secret_text", ...}]` + `keep_bindings` for everything else
4. PUTs to `/accounts/.../workers/dispatch/namespaces/.../scripts/...`

**Caveat:** `keep_bindings` array MUST only include valid binding types. `browser_rendering` is NOT valid (returned 400 with code 10021 "unknown type browser_rendering"). Stick to: `plain_text`, `secret_text`, `kv_namespace`, `r2_bucket`, `d1`, `vectorize`, `queue`, `durable_object_namespace`, `service`.

### 3. McpAgent default DO binding name MUST be `MCP_OBJECT`

`McpAgent.serve("/mcp")` from the `agents` package looks up `env.MCP_OBJECT` by convention. Custom names cause `Could not find McpAgent binding for MCP_OBJECT` at runtime.

**Fix:** match the convention in wrangler config:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "MCP_OBJECT", "class_name": "MyAgentClass" }]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MyAgentClass"] }
]
```

### 4. `agents@^0.12.0` requires `zod@^4.0.0`

Earlier zod 3.x conflicts. Add `@cloudflare/workers-types` as dep AND set `lib: ["ES2022", "DOM"]` + `skipLibCheck: true` in tsconfig.json — the `ai` peer's types reference DOM `FileList`/`RequestCredentials`.

```json
{
  "dependencies": {
    "agents": "^0.12.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0",
    "@cloudflare/workers-types": "^4.20260501.0"
  }
}
```

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

Plus `compatibility_flags: ["nodejs_compat"]` in wrangler.

### 5. `.cfapikeys` was UNTRACKED but NOT gitignored before today

Pre-commit `024fcdd` added these entries to `.gitignore`:

```
.cfapikeys
.deepseekkey
.env.local
*.pem
*.key
```

If you ever encounter a fresh checkout where `.cfapikeys` was committed by accident, immediately rotate the keys (CF Dashboard → API Tokens, regenerate global API key) and use `git filter-repo` to scrub history.

### 6. DeepSeek model names

- `deepseek-v4-pro` is the **reasoning** model (526 reasoning tokens, 22s/call). DON'T use for HyDE.
- `deepseek-v4-flash` is the right pick for HyDE (~6s/call, still has minor reasoning baked in).
- Both still emit some `reasoning_tokens` per response, but flash is fast enough.

DeepSeek prompt caching: stable system prompt → second call returns `prompt_cache_hit_tokens > 0`. Pricing drops from $0.14/M to $0.0028/M when cached. Critical: keep system prompt LONG and IDENTICAL across calls.

### 7. Vertex `gemini-embedding-001` batching

Single `:predict` call accepts an `instances` array. We use this to embed 12 HyDE questions in one call (~3s) instead of 12 sequential calls (~12-20s).

```javascript
{
  instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
  parameters: { autoTruncate: true, outputDimensionality: 1536 },
}
```

### 8. Concatenation bug when appending to .cfapikeys

If the last line of `.cfapikeys` doesn't end in `\n` and you `cat >> .cfapikeys`, the new line gets glued to the previous one — silently corrupting `CF_ACCOUNT_ID=...DEEPSEEK_API_KEY=...`. ALWAYS prepend a newline when appending.

---

## Safety contracts (locked in by 2026-04-30 council review)

These are non-negotiable for any worker that touches indexing or search:

1. **Vectorize metadata indexes for `repo_slug`, `file_path`, `active_commit` MUST be created before any vector insert.** Limit: 10 metadata indexes per Vectorize index.
2. **D1 `active = 1` rows are SOURCE OF TRUTH** for search filtering. Vectorize is eventually consistent. ALWAYS cross-check.
3. **Queues are at-least-once.** Consumers MUST be idempotent. `INSERT OR REPLACE` everywhere. `COUNT(*)` for job counters, NOT `completed = completed + 1`.
4. **Soft-delete first** (D1 `active = 0`), THEN optional Vectorize `deleteByIds` (async, may lag seconds).
5. **Deterministic IDs.** `chunk_id = sha256(file_path:chunk_index).slice(0, 16)`. HyDE: `${chunk_id}-h${i}`.
6. **Cleanup MUST remove Queue consumer bindings before deleting Workers/Queues.** Otherwise queue refuses delete.
7. **No Cloudflare Workflows.** Workers + Queues + R2 + D1 + Vectorize + Durable Objects only.

---

## All memory files (inlined for self-contained handoff)

The following are the contents of every memory file under
`/Users/awilliamspcsevents/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/`
as of this handoff. If you have memory access, treat live files as authoritative; otherwise, this is your context.

### MEMORY.md (index)

```
- [2026-05-01 cfcode v2 session](project_session_2026-05-01_cfcode_v2.md) — Gateway shipped, CLI live, 28-series HyDE 4/7 PASS, decision pending at 28F gate
- [cfcode architecture](reference_cfcode_architecture.md) — Definitive map: gateway, dispatch namespace, per-codebase workers, CLI, lib structure, naming conventions
- [WfP gotchas](reference_wfp_gotchas.md) — Claude Code config in ~/.claude.json (not settings.json), wrangler secret put no namespace flag, McpAgent MCP_OBJECT binding
- [User feedback 2026-05-01](feedback_user_2026-05-01.md) — Cloudflare-native HyDE only, separable enrichment, CLI for writes/MCP for reads, speed reality
- [Project Goals](project_goals.md) — resumability, eval UX, remote VPS for persistent processes
- [Gemini Flash Lite via Vertex AI](reference_gemini_vertex.md) — direct REST call pattern for HyDE generation, from mortgage-rag
- [CF-native direction](project_cf_native_direction.md) — user moving all agents to Workers, search must be CF-native and remotely queryable
- [Launcher usage patterns](feedback_launcher_usage.md) — use file uploads not inline, smoke test before long runs
- [Session state 2026-04-29](project_session_state.md) — Older state across 5 repos: POC 1-12 results, lumae golden eval baseline numbers
- [Worker indexer](project_worker_indexer.md) — production indexer should be a CF Worker, not local script (now SHIPPED — see cfcode architecture)
- [Real use case](project_real_use_case.md) — giant employer codebase + personal projects, maximize quality not just "good enough"
- [Use 3.1 Pro not 2.5](feedback_gemini_models.md) — User wants gemini-3.1-pro-preview for generation
- [Azure keys and endpoints](reference_azure_keys.md) — Working OpenAI key on Alphalumae, Kudu SCM access, deploy patterns
- [No inline scripts](feedback_no_inline_scripts.md) — Always write scripts to files
- [DeepSeek API](reference_deepseek_api.md) — Direct API key (in .cfapikeys), v4-flash and v4-pro models, no rate limits
- [2026-04-30 Cloudflare MCP pivot](project_session_2026-04-30_cloudflare_mcp_pivot.md) — Snapshot during 26-series build (now SUPERSEDED by cfcode v2 memory)
```

### project_session_2026-05-01_cfcode_v2.md (current state)

```markdown
## Snapshot

Date: 2026-05-01 (overnight session)
Repo: /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server
Branch: main
Last commit (28-series): 0e46c4a (POC 28D PASS)

## What's Live in Production

- Gateway (single MCP URL): https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp
- Lumae user worker: cfcode-codebase-lumae-fresh in dispatch namespace cfcode-codebases
- D1 registry: cfcode-gateway-registry
- Dispatch namespace: cfcode-codebases (1 user worker registered)
- CLI: cfcode symlinked to ~/bin/cfcode
- MCP attached in Claude Code: Yes, configured in ~/.claude.json

## Phase Progress

- Phase 26 (A1-E5): Cloudflare-native indexing pipeline with diff-driven incremental — 23 POCs PASS.
- Phase 27 (A-G): Stateful MCP gateway via Workers for Platforms dispatch namespace — 7 POCs PASS.
- Phase 28 (A-G): HyDE quality pass via DeepSeek + Vertex inside the Worker. 4 of 7 POCs PASS.
  - 28A PASS: Worker calls DeepSeek v4-flash for HyDE.
  - 28B PASS: Worker batches 12 questions in one Vertex call.
  - 28C PASS: Per-chunk pipeline 15s for one chunk.
  - 28D PASS (50-chunk subset): Pipeline scales at queue concurrency=25, 47 code + 564 hyde, 95s.
  - 28E PENDING: Worker dual-channel search + RRF.
  - 28F GATE: Lumae golden eval — MRR delta vs dense-only.
  - 28G PENDING: scale to 9 more codebases (only if 28F passes).

## Architectural Decisions Made This Session

1. Workers for Platforms (paid, $25/mo) over static service bindings.
2. McpAgent from `agents` package for the gateway. DO binding MUST be `MCP_OBJECT`.
3. Per-codebase isolation preserved.
4. HyDE generation runs IN the Worker, not local.
5. HyDE enrichment will be a separate, resumable, idempotent CLI command.
6. MCP gateway is read-only. Long-running write operations are CLI-only.

## Gotchas Discovered + Fixed

1. Claude Code MCP servers live in ~/.claude.json, NOT ~/.claude/settings.json.
2. wrangler secret put does NOT support --dispatch-namespace. Use multipart upload API.
3. McpAgent.serve() defaults to DO binding name MCP_OBJECT.
4. .cfapikeys was UNTRACKED but NOT gitignored. Fixed.
5. deepseek-v4-pro is the reasoning model (slow). For HyDE use deepseek-v4-flash.

## Active Cost State

- DeepSeek 75% off discount expires within 24 hours of 2026-04-30.
- v4-flash regular: $0.14/M input cache miss, $0.28/M output.
- Estimated full lumae HyDE re-index cost: ~$0.50-1.
- Estimated 10 codebases worth (~6000 chunks): $5-10.

## Resources Currently on Cloudflare

Persistent (production):
- Worker cfcode-gateway
- D1 cfcode-gateway-registry
- Dispatch namespace cfcode-codebases
- User worker cfcode-codebase-lumae-fresh (in namespace)
- Lumae R2/D1/Vectorize/Queue: cfcode-lumae-fresh-*

Throwaway (cleanup ran in finally):
- 28A/B/C/D POC workers all deleted, resources cleaned.

## Files Touched / Created (28-series)

cloudflare-mcp/poc/28a-worker-deepseek/
cloudflare-mcp/poc/28b-batch-embed-questions/
cloudflare-mcp/poc/28c-consumer-pipeline/
cloudflare-mcp/poc/28d-lumae-hyde-reindex/
cloudflare-mcp/scripts/poc-28a-worker-deepseek-smoke.mjs
cloudflare-mcp/scripts/poc-28b-batch-embed-questions-smoke.mjs
cloudflare-mcp/scripts/poc-28c-consumer-pipeline-smoke.mjs
cloudflare-mcp/scripts/poc-28d-lumae-hyde-reindex-smoke.mjs
EXECUTION_PLAN.md (Phase 28 plan with status updates)
```

### reference_cfcode_architecture.md (definitive map)

```markdown
## One-line summary

cfcode indexes a local git repo into per-codebase Cloudflare resources (R2/D1/Vectorize/Queue), routes search through a single stateful MCP gateway worker via Workers for Platforms dispatch namespace.

## Single MCP URL (drop into agent settings once)

https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp

Drop into ~/.claude.json mcpServers (NOT ~/.claude/settings.json):

  "mcpServers": {
    "cfcode": { "type": "http", "url": "..." }
  }

## Components

### Local

- ~/bin/cfcode → symlink to cloudflare-mcp/cli/cfcode.mjs
- .cfapikeys (gitignored) — CF_GLOBAL_API_KEY, CF_EMAIL, CF_ACCOUNT_ID, DEEPSEEK_API_KEY
- ~/Downloads/team (1).json — Vertex AI service account (project=evrylo)

### Repo layout

cloudflare-mcp/
  cli/cfcode.mjs                  CLI entry
  lib/                            shared modules
    env.mjs                       loadCfEnv, repoSlugFromPath, name conventions
    exec.mjs                      run(), git()
    http.mjs                      fetchJson, waitHealth, pollPublished
    files.mjs                     listSourceFiles, buildFullChunks, buildDiffManifest, buildIncrementalArtifact
    cf.mjs                        provisionResources, deployToNamespace, setNamespaceVertexSecret, teardownResources
    gateway.mjs                   GATEWAY_URL, listCodebases, registerCodebase, unregisterCodebase, proxyToCodebase
    wfp-secret.mjs                multipart upload API for WfP user worker secrets
    state.mjs                     ~/.config/cfcode legacy
  workers/
    codebase/                     per-codebase worker (deployed PER repo)
      src/index.ts                ingest/incremental-ingest/queue consumer/search/git-state/etc
      wrangler.template.jsonc     standalone deploy template
      wrangler.namespace.template.jsonc  WfP namespace deploy template (no queue consumer)
      wrangler.lumae.jsonc        lumae standalone (legacy)
      wrangler.lumae-namespace.jsonc  lumae as namespace user worker (current)
    mcp-gateway/                  the ONE MCP gateway
      src/index.ts                McpAgent + tools + admin endpoints + dispatch routing
      wrangler.template.jsonc
  poc/                            26+27+28 series throwaway smokes
  scripts/                        all POC smoke runner scripts

## Names + conventions

For repo with slug `myrepo`:
- User worker (in namespace): cfcode-codebase-myrepo
- R2 bucket: cfcode-myrepo-artifacts
- D1 db: cfcode-myrepo
- Vectorize index: cfcode-myrepo
- Queue: cfcode-myrepo-work + DLQ cfcode-myrepo-work-dlq

Gateway-side fixed:
- Worker: cfcode-gateway
- D1: cfcode-gateway-registry
- Dispatch namespace: cfcode-codebases

## Data flow at runtime (search)

Claude Code → MCP /mcp (streamable HTTP) → cfcode-gateway worker → McpAgent DO (one per session, holds {slug}) → tool: search(query, topK) → env.DISPATCHER.get(`cfcode-codebase-${slug}`) → user worker /search → Vertex embed query (RETRIEVAL_QUERY, 1536d) → Vectorize.query(values, topK, returnMetadata: "all") → For each match: D1 chunks WHERE active=1 cross-check → Return matches with snippet/file_path/score → render as MCP content blocks

## Data flow at index time

$ cfcode index ~/PROJECTS/myrepo
1. CLI provisions resources (idempotent — wrangler create with allowFailure)
2. CLI deploys worker into namespace via `wrangler deploy --dispatch-namespace cfcode-codebases`
3. CLI sets Vertex SA secret via multipart upload API (lib/wfp-secret.mjs)
4. CLI POST /admin/register {slug, indexed_path} to gateway → D1 row
5. CLI builds chunks locally (4KB max per file, deterministic chunk_id)
6. CLI POST /admin/codebases/<slug>/ingest {jsonl} to gateway → user worker /ingest
7. User worker /ingest:
   - R2 put(artifact)
   - D1 INSERT job
   - Queue.send() per chunk
8. Queue consumer (per chunk, max_concurrency=25):
   - R2.get artifact
   - Vertex embed code (RETRIEVAL_DOCUMENT)
   - Vectorize.upsert
   - D1 INSERT chunk row (active=1)
   - UPDATE jobs SET completed=COUNT(*) FROM chunks WHERE job_id=? AND active=1
9. CLI polls /jobs/<id>/status until status=published

## MCP tools (gateway)

- list_codebases() — D1 registry rows
- select_codebase(slug) — verifies in registry, sets DO state.slug
- current_codebase() — reads state.slug
- search(query, topK?) — proxies to selected codebase via dispatcher

## Admin HTTP (gateway, used by CLI)

- GET  /admin/codebases — list registry
- POST /admin/register {slug, indexed_path} — INSERT OR REPLACE
- DELETE /admin/register/:slug
- * /admin/codebases/:slug/<rest> — proxies to user worker via dispatcher

## CLI commands

cfcode index <repo-path>              # full-index a codebase
cfcode reindex <repo-path>             # diff reindex (base=stored active_commit)
   [--base <ref>] [--target <ref>]
cfcode status [<repo-path>]            # collection_info + git_state
cfcode list                            # gateway D1 registry
cfcode uninstall <repo-path>           # tear down resources + unregister
cfcode mcp-url                         # print gateway MCP URL
cfcode --help

Future (28-series, planned not built):
cfcode hyde-enrich <repo>              # only-missing-or-stale HyDE
cfcode hyde-enrich <repo> --bump       # force regenerate (bumps hyde_version)
cfcode rerank <repo>                   # enable bge-reranker on this codebase
```

### reference_wfp_gotchas.md

```markdown
## 1. Claude Code MCP config lives in ~/.claude.json, NOT ~/.claude/settings.json

Two files exist with similar shapes. Claude Code reads mcpServers from ~/.claude.json only.

Symptom: Adding mcpServers.foo to ~/.claude/settings.json, restarting Claude Code, getting NO mcp-logs-foo directory.

Fix: Put the entry in ~/.claude.json.

## 2. wrangler secret put does NOT support --dispatch-namespace

As of wrangler 4.87.0. The --name flag exists but assumes the worker is standalone.

Fix: Use the Cloudflare API multipart upload endpoint directly:

PUT /accounts/:account/workers/dispatch/namespaces/:ns/scripts/:script
multipart/form-data:
  metadata: {
    "main_module": "<entrypoint>",
    "bindings": [{"type": "secret_text", "name": "MY_SECRET", "text": "..."}],
    "keep_bindings": [list of valid binding types]
  }
  <entrypoint.js>: <script body>

Implementation: cloudflare-mcp/lib/wfp-secret.mjs

Caveat on keep_bindings: must only include valid binding type strings.
browser_rendering is NOT valid (returned 400 with code 10021).
Stick to: plain_text, secret_text, kv_namespace, r2_bucket, d1, vectorize,
queue, durable_object_namespace, service.

## 3. McpAgent default DO binding name MUST be MCP_OBJECT

The McpAgent.serve("/mcp") helper from the agents package looks up MCP_OBJECT by default.

Fix: Match the convention in wrangler.jsonc:
  "durable_objects": {
    "bindings": [{ "name": "MCP_OBJECT", "class_name": "MyAgentClass" }]
  }

compatibility_flags: ["nodejs_compat"] also required.

## 4. McpAgent + zod versions matter

agents@^0.12.0 requires zod@^4.0.0 (peer dep).
Add @cloudflare/workers-types as dev dep.
Set lib: ["ES2022", "DOM"] + skipLibCheck: true in tsconfig.

## 5. The streamable-http MCP wire format

Every MCP request is a POST to /mcp with body { jsonrpc: "2.0", id, method, params }
and headers:
  content-type: application/json
  accept: application/json, text/event-stream
  mcp-session-id: <id>     (after initialize, subsequent calls)

Server returns either JSON or SSE depending on its mood. SSE responses look like:
  event: message
  data: {"result":{...},"jsonrpc":"2.0","id":1}

## 6. The McpClient SDK works fine

If your custom HTTP smoke fails but you suspect the server is good, drop in
the @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport.

If this works but Claude Code doesn't load it, the bug is config (see #1) not server.
```

### feedback_user_2026-05-01.md

```markdown
## Don't put HyDE generation locally — Cloudflare-only

User's correction: "The hypothetical question Generation needs to fully happen on CloudFront [Cloudflare], though nothing local."

Implication: Any future "expensive per-chunk" work (HyDE, reranking, AST chunking) lives in the Worker queue consumer, not the CLI. CLI is thin: build chunks, POST artifact, poll for status.

## HyDE must be re-doable independently of chunks

User: "The hypothetical embedding can be redone, you know, unchanged, and the reranker stuff can be done too."

Design:
- Chunks table has kind enum (code, hyde).
- HyDE rows have parent_chunk_id linkage.
- hyde_version + hyde_model columns track when HyDE was generated.
- A hyde-enrich job type finds chunks lacking HyDE (or with stale hyde_version) and processes only those.
- Resumable: crash mid-way, re-run cfcode hyde-enrich, picks up the gap.
- Reindexing chunks does NOT delete HyDE rows automatically (HyDE is parent-linked).

## CLI vs MCP for write operations

- Reads (list/select/search) → MCP gateway. Sub-second, suitable for agent-mid-conversation.
- Writes (index/reindex/hyde-enrich/uninstall) → CLI. Long-running, manual triggers, terminal flow.

Don't expose long-running write operations as MCP tools. Agents will hang waiting on minutes-long jobs.

## Speed mandate for fan-out

User: "Make sure that the speed of this is basically almost instant because it's fanning out so fast. DeepSeek has no rate limits basically."

Reality: "Almost instant" is aspirational. Real per-chunk time is ~5-15s.
Queue concurrency 25 means ~600 chunks in ~20 minutes wall time.

How to apply: Don't promise "seconds" for full re-index. Be honest: "minutes per codebase, runs as background job."

## .cfapikeys pattern

Format:
  CF_GLOBAL_API_KEY=cfk_...
  CF_EMAIL=andrew@evrylo.com
  CF_ACCOUNT_ID=...
  DEEPSEEK_API_KEY=sk-...

Critical: When appending to .cfapikeys programmatically, prepend a newline.
Don't use cat >> .cfapikeys without ensuring the previous line ends in \n.

## "Make sure resources stay tidy"

User: "Just keep the worker resources tidy organized and all that."

Applied: cloudflare-mcp/worker/ → cloudflare-mcp/workers/codebase/.
Added cloudflare-mcp/workers/mcp-gateway/. Shared lib in cloudflare-mcp/lib/.
CLI in cloudflare-mcp/cli/.

## "Take your time. Sorry for bothering you."

When user pauses or redirects, do not panic. Verify state is clean
(commit any in-flight work, confirm no orphan CF resources), then ask for direction.
Don't keep grinding on a path the user is reconsidering.
```

### project_goals.md

```markdown
Three goals beyond the v2 multi-vector architecture:

1. Resumable indexing — partial progress (HyDE generated but not embedded,
   embedded but not upserted) should survive crashes and pick up where they left off.

2. Eval harness UX — needs to be easy to run, easy to interpret. Gating factor for
   proving the multi-vector approach beats legacy.

3. Remote VPS for persistent processes — user doesn't want Docker containers and Qdrant
   running locally. Goal: remote VPS hosts Qdrant, background indexer, and any
   long-lived processes. (cfcode v2 actually achieved this via Cloudflare-native architecture.)

How to apply:
- Always consider crash-recovery when proposing indexing changes.
- When touching benchmarks, bias toward simplicity and clear output.
- When discussing infra, assume Cloudflare-native, not localhost.
```

### reference_deepseek_api.md

```markdown
DeepSeek API:
- Key: in .cfapikeys as DEEPSEEK_API_KEY
- Base URL (OpenAI format): https://api.deepseek.com
- Base URL (Anthropic format): https://api.deepseek.com/anthropic
- No rate limits per user's explicit statement

Models:
| Model | Pricing (input/output per 1M) | Notes |
| deepseek-v4-flash | $0.0028 cache hit / $0.14 miss / $0.28 output | Fast, cheap. RIGHT for HyDE. |
| deepseek-v4-pro | discounted to $0.003625 / $0.435 / $0.87 (75% off thru 2026-05-01) | Reasoning model. ~22s/call. WRONG for HyDE. |
| deepseek-chat | deprecated 2026-07-24 | Use v4-flash instead |
| deepseek-reasoner | deprecated 2026-07-24 | Use v4-pro instead |

Usage pattern (Worker fetch):
  fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: STABLE_LONG_PROMPT },
        { role: "user", content: variableInput },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });

The first call returns prompt_cache_miss_tokens. Subsequent calls with the same
system prompt return prompt_cache_hit_tokens > 0 — pricing drops 50x.
```

### reference_gemini_vertex.md

```markdown
Vertex AI gemini-embedding-001 from Cloudflare Worker:

PROJECT = "evrylo"
REGION = "us-central1"
MODEL = "gemini-embedding-001"

URL: https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict

Auth: JWT signed with service account private key, exchanged at oauth2.googleapis.com/token for access_token. Cache token until expiry.

Body:
  instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
  parameters: { autoTruncate: true, outputDimensionality: 1536 }

For query embedding use task_type: "RETRIEVAL_QUERY" instead.

Batching: instances[] can hold many texts. We send 12 HyDE questions per batch (returns in <3s).
Vertex max instances per call is 250 per docs but we haven't tested at that scale.

Service account JSON: /Users/awilliamspcsevents/Downloads/team (1).json
Set on Worker as base64-encoded GEMINI_SERVICE_ACCOUNT_B64 secret.
For namespace user workers: use cloudflare-mcp/lib/wfp-secret.mjs (multipart API).
```

### project_real_use_case.md

```markdown
User was hired at a company with a massive codebase. Building this code search system serves two purposes:

1. Work: Needs agents to navigate the employer's giant codebase. Trying to convince them to modernize but in the meantime needs search that works NOW.

2. Personal: Wants it for all personal projects (lumae.ai, launcher, workbench, etc.)

User is a maximizer — wants best possible retrieval quality, not just "good enough." HyDE enrichment isn't optional, it's the goal. The eval baseline proves the floor works; now push the ceiling.

How to apply: Don't optimize for "acceptable" quality. Optimize for the best retrieval possible on the Cloudflare-native stack. The user will deploy this against codebases with 10K+ files where recall differences compound.
```

### project_cf_native_direction.md

```markdown
User is moving toward running all agents natively on Cloudflare Workers, not on local machines. Motivation: agents consume too many threads and resources locally. Expects this transition ~6 months out.

This explains the strong preference for Cloudflare-native search infrastructure.
The code search system needs to be queryable from Workers-based agents, not just local Claude Desktop.

How to apply: When designing the code search architecture, prioritize Workers bindings and HTTP APIs over stdio. The MCP server should be a remote Worker, not a local process. (cfcode v2 achieved this.)
```

### project_worker_indexer.md

```markdown
The indexer should be a Cloudflare Worker, not a Python script running locally.

Status: SHIPPED in cfcode v2. The indexing pipeline lives entirely in Cloudflare Workers + Queues + R2 + D1 + Vectorize. The local CLI is a thin client that reads files, chunks them, and POSTs to the gateway.

Why: CF-to-CF calls are near-zero latency. A Worker can Promise.all() 6000+ index calls and complete in seconds vs 10+ minutes from local.
```

### feedback_no_inline_scripts.md

```markdown
NEVER write inline Python or shell scripts inside Bash tool calls. Every script gets its own file in poc/, eval/, scripts/, or ephemeral/.

Why: Inline scripts vanish from conversation history, can't be committed to git, can't be resumed if interrupted, and can't be reviewed later. The user wants a traceable story of what was done — the script file IS the documentation.

How to apply: Write the file first with Write tool, then run it with `node path/to/script.mjs` or `python3 path/to/script.py` in Bash. Commit the script alongside its results. This applies even for "quick one-off" analysis — there's no such thing as too small for a file.
```

### feedback_launcher_usage.md

```markdown
When using the launcher API for golden test data or any large generation task, always upload digest files as file attachments rather than inlining content in the JSON prompt. The API supports multipart file upload (-F file=@path).

Use: curl -F 'file=@/path/to/digest.md' -F 'prompt=...' -F 'providers=gemini'

Before running long provider loops (4 providers × 30 queries each), do a quick smoke test with one provider and a small prompt first. Verify the API call works, the response parses, and the output shape is correct before committing to a 10-minute run.
```

### feedback_gemini_models.md

```markdown
Use gemini-3.1-pro-preview on the global Vertex AI endpoint for all generation tasks (golden query generation, LLM-as-judge, HyDE if needed). NOT gemini-2.5-pro.

User considers 2.5 Pro outdated. Corrected multiple times. The 3.1 Pro Preview is on the global endpoint:
https://aiplatform.googleapis.com/v1beta1/projects/evrylo/locations/global/publishers/google/models/gemini-3.1-pro-preview:generateContent

Needs thinkingConfig: {thinkingBudget: 1024} and maxOutputTokens: 8000 for schema-enforced responses.

For embeddings, gemini-embedding-001 on regional endpoint is fine.
```

### reference_azure_keys.md (background, less relevant for cfcode)

```markdown
Azure Webapps:
- lumaeai (Production Flask app with FAISS indexes) — lumae.ai, www.lumae.ai
- Alphalumae (lumae-EastUS2) — has working OpenAI key

Azure Container Apps:
- lumae-web-dev-app (lumae-dev-rg) — evrylo.daleloan.com — Dev container (NO FAISS files)

Working OpenAI key:
az webapp config appsettings list --name Alphalumae --resource-group lumae-EastUS2 -o json | python3 -c "import sys,json;[print(s['value']) for s in json.load(sys.stdin) if s['name']=='OPENAI_API_KEY']"

Azure OpenAI Endpoints (no text-embedding-3-large deployed):
- LumaeOpenAI (lumae) — gpt-4.1, gpt-4o-mini, o3-mini, text-embedding-ada-002
- LumaeEUS2 (lumae-EastUS2) — same

Kudu SCM access: see project memory for full command.

CF Global API Key (Evrylo):
In .cfapikeys: CF_GLOBAL_API_KEY, CF_EMAIL=andrew@evrylo.com
```

### project_session_state.md (older, 2026-04-29)

This is the snapshot from BEFORE the cfcode v2 work. Keep for reference but the cfcode v2 memory supersedes the architecture sections. The eval numbers are still authoritative for understanding what HyDE and reranker each contributed in the legacy local Qdrant pipeline:

```markdown
## Qdrant MCP Server — Code Search POC Chain (legacy)

### Winning Architecture (Updated 2026-04-29)

Vectorize (Gemini 768d) + D1 FTS5 (BM25F weighted) + bge-reranker-base + AST chunking

Best result on 240 golden queries (lumae.ai corpus):
- MRR: 0.776 (BM25F) / 0.769 (flat FTS5) / 0.660 (AI Search)
- nDCG@10: 0.776 / 0.761 / 0.664
- Recall@5: 0.875 / 0.871 / 0.817
- Recall@10: 0.921 / 0.904 / 0.858

### Completed POCs (14 total)

POC 1-10c: All proven (checkpoint, HyDE, golden queries, indexing, eval)
POC 11: AST chunking — Tree-sitter, 5717 chunks, +0.066 MRR over line-based
POC 11b: AST eval — MRR 0.769, wins all 4 metrics over AI Search
POC 12: BM25F multi-field D1 schema — identifier×10, path×5, signature×3, body×1
POC 12b: BM25F eval — MRR 0.776, wins 3/4 over flat FTS5

### Key Files (legacy)

- src/poc/11-ast-chunking.py, 11b-eval-ast-reranked.py — AST POCs
- src/poc/12-bm25f-multifield.py, 12b-eval-bm25f.py — BM25F POCs
- benchmarks/lumae_eval_ast_reranked.json — AST eval results
- benchmarks/lumae_eval_bm25f.json — BM25F eval results (240 queries)

### Eval baselines (POC 9b/10c)

| Variant | Recall@5 | Recall@10 | MRR | nDCG@10 |
| Vec+D1 dense | 0.804 | 0.921 | 0.476 | 0.534 |
| + bge-reranker | 0.833 | 0.871 | 0.703 | 0.717 |
| + HyDE prepend | 0.863 | 0.900 | 0.725 | 0.737 |
| + AST + BM25F | 0.875 | 0.921 | 0.776 | 0.776 |

These baselines are the reference for whether 28F gate passes. Reranker delivered +0.227 MRR, HyDE prepend +0.066. The current cfcode v2 ships only "Vec+D1 dense" — meaning we're shipping the WORST variant of what we've already proven. Phase 28 closes the gap.
```

### project_session_2026-04-30_cloudflare_mcp_pivot.md (snapshot during 26-series, now superseded by cfcode v2)

```markdown
## Critical user constraints

- POC-driven development. One POC at a time.
- If a POC has two failed runs in a row, stop, revert that POC's changes, split into 4 smaller POCs, update EXECUTION_PLAN.md, resume.
- Do not use Cloudflare Workflows.
- Cloudflare docs change often — verify against live docs.
- For GitHub pushes: temporarily switch gh auth to ajwcontreras, push, switch back to awilliamsevrylo.
- Never print or commit .cfapikeys or the Google service account.

## Council review findings to preserve

Gemini Pro, ChatGPT, and Claude reviewed the architecture through Launcher API on 2026-04-30. Converged findings:

- Cloudflare Queues are at-least-once; consumers must be idempotent.
- Use deterministic chunk/vector IDs.
- D1 is the source of truth for job completion, resume skip, active chunks, and search filtering.
- Vectorize upserts/deletes are eventually visible.
- Soft-delete stale chunks in D1 before async Vectorize deleteByIds.
- Cross-check MCP search results against D1 active rows.
- Create Vectorize metadata indexes before inserting vectors. Live docs confirm 10-property limit.
- Whole-file reprocessing for changed files is a sane v1 incremental strategy.
- Renames should be tombstone old-path plus new-path whole-file add.
```

---

## How to start your work

### Step 0: Verify you have access

```bash
cd /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server
ls -la                       # confirm repo present
git log --oneline -10        # confirm commit chain
cat .cfapikeys | head -1     # confirm secrets exist (DON'T print full)
cfcode list                  # confirm CLI works + gateway live
curl -s https://cfcode-gateway.frosty-butterfly-d821.workers.dev/health
```

### Step 1: Read the current state

```bash
# The 5 most important docs to read in order:
cat README.md                                           # human-facing snapshot
cat AGENTS.md                                           # agent-facing operational
cat CLAUDE.md                                           # detailed agent + architecture
head -200 EXECUTION_PLAN.md                             # POC status
sed -n '1,30p' AGENT_HANDOFF_MASTER_PLAN.md             # latest progress log entry
```

### Step 2: Pick a path

Per the user's last message, the work in flight is Phase 28. The user paused before the full lumae HyDE re-index. Three options (see "Specific next steps" above) — present them to the user, get a direction, then execute.

### Step 3: Execute in POC discipline

Per the project's rules:
1. ONE POC at a time. Never combine.
2. Pass criteria written before code.
3. Commit + push on every PASS.
4. Update EXECUTION_PLAN.md POC entry with `Status: PASS — <date>` + filled checkboxes.
5. Append AGENT_HANDOFF_MASTER_PLAN.md Progress Log entry with timestamp.
6. After two consecutive errors on the same POC, revert and split into 4 smaller POCs.

### Step 4: Audio mode (if active)

If the system reminder mentions `accessibility-audio-report` skill or you see other agents using `agent-speak`, audio mode is active. Every response must:
- Start with a one-line `TLDR: <result>. <next step>.`
- Immediately invoke `agent-speak "TLDR: ..."` in the background.
- Keep speech high-signal. Don't read code or long lists aloud.

---

## End of handoff

This document is comprehensive but the live files are authoritative if anything conflicts:

```
/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/EXECUTION_PLAN.md
/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/AGENT_HANDOFF_MASTER_PLAN.md
/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/CLAUDE.md
/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/AGENTS.md
/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/README.md
/Users/awilliamspcsevents/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/MEMORY.md  (and the files it indexes)
```

The single most actionable thing: read `EXECUTION_PLAN.md` end-to-end. Every POC has explicit pass criteria and an evidence trail. The 28-series entries (POC 28A through 28G) tell you exactly what the user wants and why each gate exists.

**Current decision pending from user:** Path A (run full 608-chunk lumae HyDE), Path B (build 28E search on 47-chunk index), or Path C (skip discrete POCs, hack HyDE into canonical worker). My recommendation in the body of this handoff is Path A.

Good luck. Don't glaze. Push back when you're confident he's wrong. Commit + push every PASS. Use the audio TLDR pattern if accessibility mode is on. The user's name is Andrew.
