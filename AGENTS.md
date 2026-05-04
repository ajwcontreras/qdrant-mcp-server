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

### E2E bench on a real codebase
```bash
node cloudflare-mcp/scripts/poc-31k-e2e-cfpubsub.mjs
```

### Bench resource lifecycle
Each bench: cleanup → provision → deploy → secrets → health check → build chunks → POST /ingest-sharded → poll /jobs/:id/status → write bench-<poc>.json → cleanup in finally{}.

**Streaming poll log** — POC 31K writes to `poll-log.jsonl` for background observation:
```jsonl
{"t": 4000, "code": "running/0", "hyde": "running/0", "status": "running"}
{"t": 12000, "code": "live/632", "hyde": "partial/7356", "status": "published"}
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

## Phase status (2026-05-02)

| Phase | Status | What it shipped |
|---|---|---|
| 26A1-26E5 | ✅ ALL PASS (23 POCs) | Cloudflare-native indexing + diff incremental |
| 27A-27G | ✅ ALL PASS (7 POCs) | Stateful MCP gateway via WfP dispatch |
| 28A-28D | ✅ PASS (4 POCs) | HyDE per-chunk pipeline + scaling proof |
| 31D-31K | ✅ ALL PASS (10 POCs) | Fire-and-forget DO alarm + 2-pop fan-out + council |
| 32 | ✅ COMPLETE | 11 CLI commands + HyDE worker port |
| 33A-33D | ✅ COMPLETE | File boosting, hyde search, AST chunking, DS rerank + eval |
| 34 | 🚧 NEXT | Fix cfpubsub gap, scale codebases, proper RRF |

### Phase 31 detail (the indexing architecture redesign)

**31D**: Alarm-driven fan-out to N shards. Proved DO alarm fires correctly and fans out to N shard instances with Promise.allSettled aggregation. 1/4/16 shards × 5-100 items, all published.

**31E**: R2-pull per shard. Each shard reads artifact from R2, filters by `i % shardCount === shardIndex`. Eliminates redundant artifact text from subrequest payloads.

**31F.1**: Vertex embedding inside a DO. Found the `atob()` PEM decoding bug — `atob()` was missing from `signJwt`, causing all Vertex calls from DOs to silently fail with 401.

**31F**: Code-only full pipeline. Vertex embed + Vectorize + D1 on alarm fan-out + R2-pull. 632/632 lumae chunks in ~8s.

**31G**: Full dual fan-out (code + hyde) with alarm + R2-pull + explicit DeepSeek batching (6/shard). 632/632 code, 97% hyde at 64 shards.

**31I**: Rate measurement POC. Empirically measured CF per-origin fetch cap (~6 for api.deepseek.com, nonexistent for Vertex). 100 parallel Vertex calls = 0 429s. 12 parallel DeepSeek calls = 2 clear batches of 6.

**31J**: 3-population attempt (QuestionGenDO + HydeEmbedDO + CodeShardDO). Failed — hyde embed shards polled D1 before questions existed, deadlocked on empty poll. Proved 2-pop is correct.

**31K**: Final architecture. 2-population dual fan-out. Fire-and-forget producer via DO alarm, 4 code shards + 64 hyde shards, R2-pull per shard, explicit DS batching, per-shard DO fetch timeout (120s), /hyde-enrich for gap fill. Council-reviewed by chatgpt+gemini+deepseek. 97% hyde completion on lumae, 91% on cfpubsub-scaffold.

**Key finding:** 4 SAs in parseSA fixed code completion from 75% to 100%. The 4th code shard was using SA index 3 which wasn't configured.

### Phase 32 detail (CLI commands + HyDE port)

11 CLI commands operational. HyDE worker ported to canonical worker.

### Phase 33 detail (Quality + eval)

File boosting for ranked results, hyde-aware search endpoint, AST chunking via regex boundary detection, DeepSeek listwise re-ranker (zero-shot), golden eval harness with 3-codebase benchmark.

## Production resources (live, do not delete)

- Gateway worker: `cfcode-gateway`
- Gateway D1: `cfcode-gateway-registry`
- Dispatch namespace: `cfcode-codebases`
- User workers: `cfcode-codebase-lumae-fresh`, `cfcode-codebase-cfpubsub-scaffold`, `cfcode-codebase-cf-docs-mcp`, `cfcode-codebase-qdrant-mcp-server`
- 4 codebases live, searchable through gateway
- 764 (lumae) + 767 (cfpubsub) + 294 (cf-docs-mcp) + 3897 (self-index) = 5722 total active chunks

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

### Cloudflare
- `.cfapikeys` (gitignored) at repo root:
  ```
  CF_GLOBAL_API_KEY=cfk_...
  CF_EMAIL=andrew@evrylo.com
  CF_ACCOUNT_ID=6bce4120096fa9f12ecda6efff1862d0
  CF_ORIGIN_CA_KEY=v1.0-...
  DEEPSEEK_API_KEY=sk-...
  ```
- NEVER print or commit secret values. NEVER hardcode in source or config.
- Account: Evrylo (6bce4120096fa9f12ecda6efff1862d0). Secondary: Patrick (776ba01b...).

### Vertex Service Accounts (in /Users/awilliamspcsevents/.config/cfcode/sas/, mode 0600)

| File | Project | Billing acct | SA index |
|---|---|---|---|
| `team (1).json` | `evrylo` | A | 0 |
| `underwriter-agent-479920-af2b45745dac.json` | `underwriter-agent-479920` | B | 1 |
| `big-maxim-331514-b90fae4428bc.json` | `big-maxim-331514` | C | 2 |
| `embedding-code-495015-2fa24eece6fa.json` | `embedding-code-495015` | C (same as SA3) | 3 |

NOTE: SA files were originally in ~/Downloads. Copied to ~/.config/cfcode/sas/ on 2026-05-01 because user clears Downloads frequently. Older POC scripts still reference ~/Downloads paths — update to .config path for new scripts.

Embed model: gemini-embedding-001 (1536d, RETRIEVAL_DOCUMENT)
HyDE model: deepseek-v4-flash (deepseek-chat deprecated 2026-07-24)
Fallback model: gemini-3.1-flash-lite-preview (Vertex :generateContent)

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
2. Read `LESSONS_LEARNED.md` — every critical bug and discovery.
3. Read `CLOUDFLARE_EXPERIMENTAL_FINDINGS.md` — empirical CF measurements.
4. Read `SETUP.md` — zero-to-indexed setup guide.
5. Read this file's "Debug loop" and "Common Failures" sections below.
6. Reference worker: `cloudflare-mcp/poc/31k-2pop-fixed/src/index.ts`.
7. Check `cloudflare-mcp/poc/27h-mcp-client-debug/connect.mjs` for a working SDK client smoke if MCP debugging.

---

## CF Platform Debug Loop

Every CF Worker debugging session follows this pattern. It was built from 5,000+ lines of POC testing across Phases 26-31.

```
1. Deploy: npx wrangler deploy --config <path>
2. Health check: curl <url>/health until 200
3. Secrets: echo "$VAL" | npx wrangler secret put <NAME> --config <path>
4. Tail errors: npx wrangler tail <worker> --format pretty --status error
5. If no errors, tail without --status error (DO logs may not be error-level)
6. Send test request, observe, fix, redeploy
```

Wrangler config MUST include `"observability": { "enabled": true, "head_sampling_rate": 1 }` or tail returns nothing. Reusable tail script: `cloudflare-mcp/scripts/tail-worker.sh <name> [--errors]`.

## Empirically Confirmed CF Platform Behavior

Every claim below is backed by POC measurement or CF docs search. Do not assume — validate.

### DO alarm handlers
- **CF docs**: 15-minute timeout (Agents SDK: "Alarm handler timeout — 15 minutes")
- **Measured**: 64 shard fan-outs completing in ~70s without timeout
- **Rule**: Safe for < 10 min work. Chain alarm via `setAlarm()` with progress checkpoints for longer.

### ctx.waitUntil
- **CF docs**: "up to 30 seconds after response is sent or client disconnects" (Workers Context API)
- **Measured**: code fan-out (8s) succeeded in .then(); hyde fan-out (70s) never started
- **Rule**: NEVER use for work > 30s. Use DO alarms or Queues.

### DO storage per-key limit
- **128KB hard limit**. `state.storage.put("key", largeBlob)` silently fails if value exceeds.
- **Hit this**: 2MB artifact JSONL in DO — alarm never scheduled, producer got 500.
- **Rule**: Store only config (artifact_key, counts). Reference data by key in R2.

### Per-isolate per-origin fetch concurrency
- **2019-09-19 CF changelog**: ~6 concurrent per origin per isolate
- **Measured on api.deepseek.com**: 12 calls → 2 batches of 6. 24 calls → 4 batches.
- **Measured on *.googleapis.com**: 100 parallel calls → zero batching, all simultaneous.
- **Rule**: The cap is origin-specific. Vertex/Google APIs appear exempt. DeepSeek is capped. Mitigate with more DO shards (each = own isolate = own pool of 6).

### Vertex AI embedding
- **Measured**: 100 parallel `gemini-embedding-001:predict` calls from single DO → zero 429s. Both SA1 and SA2 (different billing accounts).
- **Batch size**: 500 instances per `:predict` call works reliably.
- **Rule**: Not the bottleneck. Scale freely.

### Vectorize write throughput
- **Measured (POC 30G)**: Single index: 32 shards × 1000 vectors = 32K vectors in ~2.5s. ~5,178 vps headroom.
- **Rule**: Not the bottleneck. Crank batch sizes to 500-1000.

### Worker subrequest limits
- **Free**: 50/invocation. **Paid**: 10,000/invocation. **DO**: 1,000/request.
- **Rule**: Paid plan required for fan-out. 68 shards = 68 subrequests, well within limits.

### D1 limits
- D1 serializes writes per database. 64 concurrent shards doing INSERT OR REPLACE worked without contention.
- Batch statements: ~100/batch is reliable.
- **Rule**: Not the bottleneck at our scale.

### Workers memory
- **128MB hard limit** per isolate.
- 2MB JSONL parse per shard (68 × 2MB = 136MB total across isolates) is safe because each DO isolates separately.
- Never `await response.text()` on unbounded R2 objects.

### DO rules (anti-patterns)
- Use `extends DurableObject`, not `implements` (legacy — loses `this.ctx`, `this.env`).
- Use `this.env` inside platform classes, not a captured `env`.
- `blockConcurrencyWhile` only for schema/init, not request I/O.
- One alarm per DO; `setAlarm()` replaces prior.
- One DO per coordination atom; avoid global bottleneck DOs.

### Workers anti-patterns
- Floating `fetch()` promises.
- Module-level mutable request state.
- `Math.random()` for IDs/tokens → use `crypto.randomUUID()`.
- Destructuring `ctx.waitUntil` — loses binding.
- `ctx.passThroughOnException()` in app code.
- Hand-written `Env` interfaces when `wrangler types` is available.
- `any`, `@ts-ignore`, double-casts hiding binding errors.
- CF REST API from inside a Worker when a binding exists.
- Service-to-service via public URL when service/dispatch binding is available.

## Common Errors (each cost real time)

### D1 binding stale UUID
- **Symptom**: `wrangler deploy`: "database <uuid> was not found"
- **Cause**: Cleanup deleted the D1, config has old UUID
- **Fix**: Delete generated config, regenerate with fresh D1 ID

### Secrets wiped on deploy
- **Symptom**: "SA not configured" or Vertex 401 after redeploy
- **Cause**: `wrangler delete` + `wrangler deploy` loses secrets
- **Fix**: Re-run `wrangler secret put` after deploy. For WfP dispatch workers: `cloudflare-mcp/lib/wfp-secret.mjs` (wrangler doesn't support `--dispatch-namespace` on `secret put`).

### DO alarm never fires
- **Symptom**: Job stuck "running" forever, no orchestrator logs
- **Causes**: (1) `state.storage.put` > 128KB value silently failed. (2) DO fetch handler not reachable.
- **Fix**: Store only small configs. Debug with console.log in alarm handler.

### Wrangler picks wrong account
- **Symptom**: Resources in wrong CF account
- **Cause**: OAuth token in `~/.wrangler/config/default.toml` beats API key env vars
- **Fix**: `unset CLOUDFLARE_API_TOKEN`. Set `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`.
- **Check**: `npx wrangler whoami`

### The atob() PEM decoding bug
- **Bug**: `atob()` was MISSING from `signJwt` in newer POCs. PEM base64 string used as raw ASCII charCodes.
- **Correct pattern**: MUST have `const bin = atob(stripped_pem); const kb = new Uint8Array(bin.length); for (let i=0; i<bin.length; i++) kb[i] = bin.charCodeAt(i);`
- **Symptom**: Vertex returns 401/UNAUTHENTICATED with valid-looking JWT
- **Found by**: POC 31F.1 — isolated Vertex-in-DO test caught it in 5 minutes
- **Presence in canonical worker**: `cloudflare-mcp/workers/codebase/src/index.ts` — `pemToAB()` function at line 146 has correct `atob(b64)` call.

### DeepSeek API
- Model: `deepseek-v4-flash` (deepseek-chat deprecated 2026-07-24)
- Endpoint: `https://api.deepseek.com/chat/completions`
- Use `response_format: { type: "json_object" }` for structured HyDE output
- "No rate limits per user" per DeepSeek docs. CF per-origin cap of 6 still applies.
- System prompt (proven for HyDE): "You are a code search assistant. Given a code snippet, generate exactly 12 distinct natural-language questions that a developer might ask whose answer would be this snippet. Output ONLY a JSON object: {\"questions\": [\"q1\", ..., \"q12\"]}. No prose, no markdown."
- Batch 6 concurrent per shard. Wait for batch before next.

### Vertex AI integration
- SA JSON stored as `btoa(JSON.stringify(sa))` in env secret `GEMINI_SERVICE_ACCOUNT_B64[_N]`
- OAuth: RS256 JWT signed with SA private key → exchange at token URI → Bearer <token>
- Embedding: `gemini-embedding-001`, 1536 dims, `:predict` endpoint
- Text generation (fallback): `gemini-3.1-flash-lite-preview`, `:generateContent` endpoint
- Token cache: `Map<string, {token, expiresAt}>` per isolate, 3600s validity
- All 4 SAs at `~/.config/cfcode/sas/` (0600): team(1).json, underwriter-agent-479920-*, big-maxim-331514-*, embedding-code-495015-*

## Proven Architecture Patterns

### 2-population dual fan-out (POC 31K)
Fire-and-forget producer → DO alarm orchestrator → CodeShardDO + HydeShardDO in parallel. NOT 3-population (deadlocks on D1 polling order).

**Producer endpoint (returns <2s):**
```typescript
await env.DB.prepare("INSERT INTO jobs ...").bind(...).run();
const stub = env.ORCH_DO.get(env.ORCH_DO.idFromName(`orch:${jobId}`));
await stub.fetch("https://o/start", { body: JSON.stringify(cfg) });
return json({ ok: true, job_id: jobId, status: "running" });
```

**Orchestrator alarm (drives fan-out):**
```typescript
async alarm(): Promise<void> {
  const cfg = await this.ctx.storage.get<JobConfig>("config");
  if (!cfg) return;
  const [codeR, hydeR] = await Promise.all([
    Promise.allSettled(codeShards.map(idx => doFetch(stub, ...))),
    Promise.allSettled(hydeShards.map(idx => doFetch(stub, ...))),
  ]);
  // Aggregate results, update statuses
  await this.ctx.storage.delete("config");
}
```

**DO fetch timeout (prevents hung shards):**
```typescript
async function doFetch(s: DOStub, url: string, init: RequestInit, ms = 120000): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shard timeout")), ms);
    s.fetch(url, init).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}
```

**R2-pull per shard (no artifact text in subrequest payloads):**
```typescript
const obj = await this.env.ARTIFACTS.get(req.artifact_key);
const records = parseRecords(await obj.text()).filter((_, i) => i % req.shard_count === req.shard_index);
```

**DeepSeek batching (respects per-origin cap):**
```typescript
for (let i = 0; i < records.length; i += 6) {
  const batch = records.slice(i, i + 6);
  const outcomes = await Promise.allSettled(batch.map(async r => ({ record: r, questions: await deepseek(this.env, r.text) })));
  // Aggregate successes, count failures
}
```

**D1 incremental progress (client polls):**
```sql
UPDATE jobs SET completed = completed + ? WHERE job_id = ?
UPDATE jobs SET code_status = 'live', code_wall_ms = ? WHERE job_id = ?
UPDATE jobs SET hyde_status = 'live', hyde_completed = ? WHERE job_id = ?
```

## Resource Naming Convention
```
Worker:     cfcode-poc-<nn>-<desc>
D1:         cfcode-poc-<nn>-<desc>
R2:         cfcode-poc-<nn>-artifacts
Vectorize:  cfcode-poc-<nn>-vec
DO shards:  c:<jobId>:<idx>, h:<jobId>:<idx>
Orchestrator: orch:<jobId>
```

## Updating this document

When new CF platform behavior is discovered:
1. Add the finding to the "Empirically Confirmed" section with POC number
2. Add any new error pattern to "Common Errors"
3. Update the "Debug Loop" if a new step was needed
4. Update "Phase status" table
5. Commit with message: "docs: update CLAUDE.md — [what was discovered]"

## Reference Documents (in repo)
- `LESSONS_LEARNED.md` — full narrative of Phase 26-31
- `CLOUDFLARE_EXPERIMENTAL_FINDINGS.md` — 10 findings with CF docs citations
- `SETUP.md` — zero-to-indexed codebase guide
- `EXECUTION_PLAN.md` — complete POC ledger with commit hashes
- `cloudflare-mcp/poc/31k-2pop-fixed/src/index.ts` — reference architecture worker

## Pattern Decision Table

| Problem | Pattern | Why |
|---|---|---|
| Response fast, work 70s | Fire-and-forget + DO alarm | ctx.waitUntil capped at 30s |
| N shards need same artifact | R2-pull per shard | No redundant payloads, avoids 128KB limit |
| DeepSeek cap at 6/shard | More shards + explicit batching | Each isolate = own pool of 6 |
| Hung shard blocks orchestrator | doFetch with 120s timeout | Promise.race with clearTimeout |
| Shards report progress | D1 incremental UPDATE | Pollable, serialized for correctness |
| Many Vertex calls | Same SA pool, unlimited | Vertex handles 100+ concurrent |
| HyDE gap after fan-out | /hyde-enrich endpoint | Process remaining, idempotent |
| Debug deployed worker | wrangler tail + observability | Must be in wrangler config |

## cfpubsub-scaffold fork (POC 31B)

Forked into `cloudflare-mcp/poc/31b-scaffold-fork/`. Deployed as standalone pubsub broker to prove DeliveryShardDO fan-out. Fixes: unique resource naming (timestamp suffix), SSH/control-plane artifacts removed, observability enabled. 9 D1 migrations applied. Health verified.

---

# Phase 31 In-Depth: The atob PEM Bug

## What happened

The `atob()` function was MISSING from the `signJwt` function in newer POCs. The stripped PEM base64 string was used directly as raw ASCII `charCodeAt()` values without first being base64-decoded. This caused `crypto.subtle.importKey("pkcs8", ...)` to produce a valid `CryptoKey` object (no import error) that signed invalid JWTs. Vertex returned `UNAUTHENTICATED` without any indication the key was corrupted.

## Root cause

A PEM-encoded RSA private key looks like:
```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQ...    ← base64(PKCS#8 DER bytes)
-----END PRIVATE KEY-----
```

After stripping BEGIN/END markers and whitespace, you have a base64 string. The correct flow is:
```
stripped_base64_pem → atob() → charCodeAt() loop → Uint8Array → crypto.subtle.importKey
```

## The buggy version (31C, 31F, 31G — FIXED in 31K)
```typescript
// BUG: PEM base64 string used directly as raw key bytes — NO atob() call
const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
const kb = new Uint8Array(pem.length);
for (let i = 0; i < pem.length; i++) kb[i] = pem.charCodeAt(i); // copies ASCII chars, not DER bytes!
const key = await crypto.subtle.importKey("pkcs8", kb.buffer, ...);
```

## The fix (31K line 66)
```typescript
const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
const bin = atob(pem);  // ← THIS LINE WAS MISSING
const kb = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i);
const key = await crypto.subtle.importKey("pkcs8", kb.buffer, ...);
```

## How it was discovered

POC 31F (code-only DO fan-out) deployed and passed smoke on SA0 (evrylo). When scaled across multiple SAs, SA2+ consistently failed. The pattern was SA-dependent because longer keys have more bytes that look like valid ASCII → more corruption per byte. POC 31F.1 (Vertex-in-DO isolated test) caught it in 5 minutes. 

This is the single most important POC methodology lesson: isolate external dependencies FIRST. The `atob` bug would have been nearly impossible to diagnose in the full pipeline.

## Presence in canonical worker

The canonical worker at `cloudflare-mcp/workers/codebase/src/index.ts` has the correct `pemToAB()` function at line 146:
```typescript
function pemToAB(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(b64);  // ← correct
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
```
This function was present from the beginning of the canonical worker; the bug was only in POC code where the inline signJwt didn't inherit the correct pattern.

---

# Phase 31 In-Depth: Per-Origin Fetch Cap Discovery

## The measurement (POC 31I)

A single DO fired N parallel `fetch()` calls to `api.deepseek.com/chat/completions` from one isolate. Results:

| N | Batches observed | Wall time |
|---|---|---|
| 3 | 1 batch × 3 | ~800ms |
| 6 | 1 batch × 6 | ~800ms |
| 12 | 3 batches: 6+4+2 | ~1.8s |
| 24 | 7 batches: 6+5+1+5+4+2+1 | ~3.5s |

The cap manifests as batch windows ~600ms apart. This is NOT a DeepSeek API limit — DeepSeek docs say "no rate limits per user." It is a Cloudflare Workers platform limit documented in the 2019-09-19 changelog.

## The Vertex contrast

Same test against `*.googleapis.com` endpoints (Vertex AI `:predict`): 100 parallel calls, ALL completed simultaneously with zero 429s, zero batching. Vertex is effectively unlimited at our scale.

## Production implication

More hyde shards = more CF isolates = more total DeepSeek concurrency. 64 hyde shards × 6 concurrent per shard = 384 effective concurrent DeepSeek calls. This is why 31K uses 64 hyde shards instead of 30C's 16. The tradeoff: more shards = more DO instances (minor cost) but dramatically faster HyDE generation.

---

# Phase 31 In-Depth: Fire-and-Forget Evolution

The producer pattern evolved through 3 attempts:

**30C (works, slow):** Producer `await Promise.all([codeFanout, hydeFanout])` then returns. HTTP response takes 73s. Code search becomes available at 8s but client can't tell.

**30F Attempt 1 (ctx.waitUntil):** Producer returns `{ job_id }` immediately. Both fan-outs fire via `ctx.waitUntil()`. Code fan-out (8s) completed in .then(). HyDE fan-out (70s) never started — `.then()` killed by 30s waitUntil cap.

**30F Attempt 2 (DO Alarm + artifact_text in storage):** Orchestrator DO stores full input via `state.storage.put()`, schedules alarm. But `artifact_text` was 2MB — exceeded DO storage 128KB limit. Storage put silently failed, alarm never fired, producer returned 500.

**31K (works, fast):** Orchestrator DO stores only config (~500 bytes — artifact_key, shard counts, etc). Alarm handler reads artifact from R2, parses in memory, fans out. Producer returns in <2s. R2-pull per shard eliminates artifact from subrequest payloads.

## The council review (2026-05-01)

31K code was reviewed by 3 AI providers via the launcher (chatgpt, gemini, deepseek). Key findings:

**CRITICAL (fixed):**
- parseSA only supported 2 SAs → extended to 4 via indexed array (fixed in 31K line ~50)
- `status = "published"` always set regardless of errors → now derived from error counts
- doFetch timer leaked on resolve (Promise.race pattern) → replaced with explicit clearTimeout

**HIGH (acknowledged, POC code):**
- Hand-written Env interface → accepted for POC, canonical uses `wrangler types`
- R2 `await obj.text()` on unbounded data → safe at current scale (2MB artifacts)
- Module-level tokenCache → safe for ephemeral POC DOs, would need refactor for production

**Production cutover:** 31K patterns ported to canonical worker in commit `701a437`. The canonical `pemToAB()` function already had correct `atob()` — only POC code was affected.

## Helper Scripts Reference

### tail-worker.sh — Reusable log streaming
```bash
bash cloudflare-mcp/scripts/tail-worker.sh <worker-name> [--errors] [--search <text>] [timeout_secs]
```
Watches wrangler tail output for a deployed worker. Automatically reads CF credentials from .cfapikeys.

### watch-deploy.sh — Auto-redeploy on source change
```bash
bash cloudflare-mcp/scripts/watch-deploy.sh <poc-dir> [worker-name]
```
Requires `fswatch` (brew install fswatch). Watches src/ directory for changes, runs tsc --noEmit, and wrangler deploy if clean.

### wfp-secret.mjs — Set secrets on WfP dispatch workers
```javascript
import { setNamespaceWorkerSecret } from "./cloudflare-mcp/lib/wfp-secret.mjs";
await setNamespaceWorkerSecret({ namespaceName: "cfcode-codebases", scriptName: "cfcode-codebase-lumae-fresh", secretName: "GEMINI_SERVICE_ACCOUNT_B64", secretValue: b64String });
```
Wrangler's `secret put` doesn't support `--dispatch-namespace`. This calls the Cloudflare multipart upload API directly. Fetches existing script content, adds secret_text binding, re-PUTs with keep_bindings to preserve other bindings.
---

# Reference: Lessons Learned and Experimental Findings

The following content is the full text of `LESSONS_LEARNED.md` and `CLOUDFLARE_EXPERIMENTAL_FINDINGS.md`, preserved inline for agent context. The canonical standalone files remain at repo root.

# LESSONS_LEARNED.md

Lessons from building `cfcode` — a Cloudflare-native semantic code-search MCP gateway.
Written 2026-05-01 after shipping Phase 31K (28 POCs across Phases 26–31).
For anyone picking this project up cold.

---

## 1. Critical Bugs Found

### 1.1 The `atob()` PEM Decoding Bug — Missing Function Call

**The real story:** `atob()` was MISSING from the `signJwt` function in newer POCs.
The stripped PEM string was used as raw ASCII `charCodeAt()` values directly — without
first being base64-decoded.

**Root cause:** A PEM-encoded RSA private key looks like:
```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQ...    <-- base64(PKCS#8 DER bytes)
-----END PRIVATE KEY-----
```

After stripping the BEGIN/END markers and whitespace, you have a base64 string.
The correct flow is: `stripped_base64_pem → atob() → charCodeAt() loop → Uint8Array → importKey`.

The buggy version skipped `atob()`:
```typescript
// BUG: PEM base64 string used directly as raw key bytes — NO atob() call
const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
const kb = new Uint8Array(pem.length);
for (let i = 0; i < pem.length; i++) kb[i] = pem.charCodeAt(i);  // ASCII codes of BASE64 chars, not DER bytes!
const key = await crypto.subtle.importKey("pkcs8", kb.buffer, ...);
```

This produced a `CryptoKey` (no import error — `importKey` accepts any buffer), but
the key signed invalid JWTs. Vertex rejected them with `UNAUTHENTICATED`.

**The fix (line 66 of `31k-2pop-fixed/src/index.ts`, comment `// <-- ATOB FIX`):**
```typescript
const bin = atob(pem);                                             // <-- ADDED: base64-decode the PEM
const kb = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i);   // now extracts DER bytes correctly
```

**Why it was not caught earlier:**
- The 30-series code used `pemToAB()` helper which correctly called `atob()`.
- When 31-series rewrote `signJwt` inline, `atob()` was accidentally omitted.
- `crypto.subtle.importKey("pkcs8", ...)` does not validate the buffer is valid DER —
  it silently creates a `CryptoKey` from arbitrary bytes.
- Vertex rejects with `UNAUTHENTICATED` — indistinguishable from expired token,
  wrong SA, or rate limit. The error message is the same.

**Discovery path:** POC 31F.1 (standalone Vertex-in-DO) deployed and passed smoke against
one SA credential. POC 31G (dual fan-out with multiple SAs) produced 401s for SAs 2+
while SA0 worked. POC 31I (rate-measure) ruled out Vertex quota as the cause. SA-dependent
failure (some SAs work, others don't) pointed to key material, not auth or protocol.

**Commit evidence:** `9592b54` (POC 31K PASS), `0c3a479` (Phase 31-series). The fix
appears in `31k-2pop-fixed/src/index.ts:66` with the inline comment `// <-- ATOB FIX`.

---

## 2. Cloudflare Platform Discoveries

Each section: what CF docs say, what we measured empirically, and reconciliation.

### 2.1 Per-Origin Outbound Fetch Concurrency Cap = 6

**CF docs say:** The 2019-09-19 Workers changelog enforces a per-incoming-request
limit of 6 concurrent outgoing `fetch()` requests. Fetches after the 6th are delayed
until prior fetches complete. Total subrequests remain capped at 50 (Free) / 10,000
(Paid).

**What we measured (POC 31I):**
- Firing 12 parallel DeepSeek calls from one DO produced 2 sequential batches of 6.
  Batch window: ~600ms spread per batch. Wall time: ~1.2s for 12 calls.
- Firing 24 produced 4 batches of 6. Wall time: ~2.4s.
- Firing N calls to the SAME origin = ceil(N/6) sequential batches.
- Calls to DIFFERENT origins do NOT share the cap. R2, D1, and Vectorize bindings
  are NOT subject to this cap (they use internal bindings, not fetch()).

**Source (CF docs):** https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/#2019-09-19
"a Worker can make up to 6 concurrent outgoing `fetch()` requests."

**Reconciliation:** The cap is per-origin within a single isolate, not global.
Each DO shard gets its own cap. 64 shards × 6 concurrent = 384 effective
DeepSeek concurrency. Phase 31K uses this to keep HyDE wall time low.

**Evidence:** `cloudflare-mcp/poc/31i-rate-measure/src/index.ts:119-163` (deepseekRpm).

### 2.2 Durable Object Alarm Handler: 15-Minute Timeout (NOT Unbounded)

**CF docs say:** The Agents SDK docs (durable execution / Why fibers exist) list
three reasons Durable Objects get evicted:
1. Inactivity timeout (~70–140 seconds with no incoming requests)
2. Code updates / runtime restarts (1–2x per day)
3. Alarm handler timeout — **15 minutes**

**Source (CF docs):** https://developers.cloudflare.com/agents/api-reference/durable-execution/#why-fibers-exist
"When eviction happens mid-work, the upstream HTTP connection ... is severed permanently."

**What we tested:** POC 31D fire-and-forget fan-out with synthetic payloads ran alarm
handlers for 30-120s to completion. POC 31H tested with real Vertex/DeepSeek calls
and the alarm handler completed in ~90s. Our workload stays well under 15 minutes.

**Reconciliation:** DO alarm handlers are not unbounded. For our indexing workload
(code-only ~8s, HyDE ~60-90s, e2e ~90s), the 15-minute limit is not a concern.
This would become relevant for very large codebases (>5000 chunks) where the
fan-out might approach 10+ minutes. At that scale, consider Workflows instead
of a single alarm handler.

**Evidence:** `cloudflare-mcp/poc/31d-alarm-fanout/src/index.ts` (alarm handler),
POC 31K OrchestratorDO.alarm() completing ~90s fan-outs. Commit `0c3a479`.

### 2.3 `ctx.waitUntil`: 30-Second Post-Response Cap

**CF docs say:** The Workers `ctx.waitUntil()` docs explicitly state:
"waitUntil has a 30-second time limit. The Worker's lifetime is extended for up
to 30 seconds after the response is sent or the client disconnects."
If Promises have not settled after 30 seconds, they are cancelled.

**Source (CF docs):** https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil

**What we measured (POC 30F):** The producer returned `{ ok: true }` in ~8s
(code fan-out completed). The HyDE fan-out ran inside a `ctx.waitUntil()` promise.
The HyDE fan-out took ~70s. The HTTP response was sent at ~8s, triggering the
30s countdown. At ~38s (8s + 30s), the `waitUntil` timer expired and the HyDE
promise was cancelled. Result: code went live, HyDE never completed.

**What works instead:** Durable Object alarm handler (see 2.2). The producer
stores config, sets a DO alarm for +100ms, returns immediately. The alarm handler
runs the full fan-out with no `waitUntil` dependency. Producer returns in <1s.
Fan-out completes in its own request lifetime (up to 15 min).

**Reconciliation:** `ctx.waitUntil` is for analytics, cache writes, webhooks —
work that finishes in <30s after the response. It is NOT for multi-minute
fan-outs. The fix is architectural: decouple response from work via DO alarm.

**Evidence:** `cloudflare-mcp/poc/30f-fire-forget/src/index.ts:2-13` (doc comment
explaining failure). POC 31D-31K use alarm pattern.

### 2.4 DO Key-Value Storage: 128 KiB per-Key Limit

**CF docs say:** The Durable Objects limits page states: for key-value backed
DO storage, **value size is 128 KiB (131,072 bytes)**. Key size is 2 KiB.

**Source (CF docs):** https://developers.cloudflare.com/durable-objects/platform/limits/#key-value-backed-durable-objects-general-limits

**Our empirical finding (POC 30F / POC 31C):**
- 632-chunk lumae JSONL artifact = ~500 KB → exceeds 128 KB.
- Even 154-chunk cfpubsub-scaffold JSONL artifact = ~120 KB, right at the limit.
- `ctx.storage.put("artifact", jsonlText)` crashed with storage limit errors.

**The fix (R2-pull pattern, POC 31E):**
- Producer writes the JSONL artifact to R2 (no size limit per object).
- Orchestrator DO stores only `{ job_id, artifact_key, shard_count }` — sub-1KB config.
- Each shard DO independently reads from R2 and filters: `records[i % shardCount === shardIndex]`.
- R2 has no per-key size limit and is optimized for multi-reader access.

**Reconciliation:** DO key-value storage is for configuration, counters, and
small state — NOT for artifact payloads. R2 is purpose-built for large objects.

**Evidence:** POC 31C was split when this limit was discovered during design.
POC 31E proved the R2-pull alternative. `31k-2pop-fixed/src/index.ts:125` (CodeShardDO
reads from ARTIFACTS binding).

### 2.5 DO-to-DO Subrequest Limit: 1,000 per Invocation

**CF docs say:** The 2021-07-16 changelog states Workers can make up to
1,000 subrequests to Durable Objects within a single request invocation
(up from 50).

**Source (CF docs):** https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/#2021-07-16

**What we tested:** 30C orchestrates 4 code shards + 16 hyde shards = 20
DO-to-DO fetch calls per fan-out, well within the 1,000 limit. Even at
64 hyde shards + 4 code shards = 68 calls, no issue.

**Reconciliation:** Not a bottleneck for our architecture. Would matter if
we went to hundreds of shards, but the per-origin fetch cap (6) is reached
long before the subrequest count limit.

---

## 3. Architecture Lessons

### 3.1 Two-Population (31K) vs Three-Population (31J): Why Simpler Won

**Three-population architecture (31J):**
- Population 1: `CodeShardDO` — Vertex code embed → Vectorize + D1
- Population 2: `QuestionGenDO` — DeepSeek generate questions → D1 `hyde_questions` table
- Population 3: `HydeEmbedDO` — poll D1 for `embedded=0` questions → Vertex embed → Vectorize + D1

**Two-population architecture (31K, final):**
- Population 1: `CodeShardDO` — Vertex code embed → Vectorize + D1
- Population 2: `HydeShardDO` — DeepSeek generate + Vertex embed → Vectorize + D1 (all in one DO)

**Why 3-pop failed (POC 31J):**

1. **D1 as stitch-point between populations is fragile.** Population 2 writes to
   `hyde_questions`; Population 3 polls for `embedded=0`. D1 writes are eventually
   consistent — Population 3 sees stale state. The polling loop either burns CPU
   retrying or misses records. What should Population 3 do with records whose
   embedding fails? Now you have abandoned rows — orphan management problem.

2. **DeepSeek unbounded shard count breaks the Vertex bottleneck illusion.**
   Population 2 (question generation only) could use unlimited shards for
   DeepSeek parallelism. But Population 3's Vertex shards still hit the
   per-isolate 6-concurrency fetch cap. The decoupling looks elegant on paper
   but the Vertex pass is the slow leg regardless.

3. **No measured speed benefit.** Despite the theoretical decoupling advantage,
   31J and 31K delivered equivalent wall time. The D1 polling overhead + orphan
   management offset any parallelism gain.

4. **Idempotency burden doubles.** Three populations mean three separate idempotent
   write paths, an extra D1 table (`hyde_questions`), extra indexes, and extra
   cleanup logic.

**Why 2-pop won:** The `HydeShardDO` keeps DeepSeek + Vertex in one DO. With
64 shards × 6 concurrent DS calls each = 384 effective DeepSeek concurrency,
the DeepSeek phase completes in ~3 batches. Questions accumulate in-memory, then
Vertex embedding fires in batched `:predict` calls on the accumulated questions.
Single failure mode per shard. Natural pipelining.

**User constraint respected:** "no combined mode in any DO." CodeShardDO and
HydeShardDO are separate classes, separate `idFromName()` namespaces, separate
`Promise.allSettled` populations in the orchestrator. What we eliminated was
splitting the HyDE path across two DO types — that was the unnecessary complexity.

**Evidence:** `31j-3pop/src/index.ts` (322 lines, 3 DO classes + 4 D1 tables).
`31k-2pop-fixed/src/index.ts` (285 lines, 3 DO classes + 2 D1 tables).
Commit `9592b54` — 2-pop 97.0% hyde at 64 shards.

### 3.2 Fire-and-Forget Pattern Evolution

**Phase 27-30C: Synchronous in request handler.**
Producer calls shard fan-out inside the HTTP request handler (via `Promise.all` or
`Promise.allSettled`). Client waits for full fan-out to complete. A 90s fan-out =
90s client wait. If the HTTP client disconnects, the isolate may be recycled,
abandoning partial work.

```
POST /ingest → write R2 → Promise.allSettled(shards) → aggregate → return 200
                                                                    (blocked 90s)
```

**Phase 30F: `ctx.waitUntil` attempt — FAILED.**
Producer fires fan-out inside `ctx.waitUntil()`, returns 200 immediately.
Fan-out continues after response. But the 30-second `waitUntil` post-response
cap (see 2.3) killed the HyDE path at ~38s (8s response + 30s cap < 70s HyDE wall).
Code completed; HyDE was abandoned mid-flight.

```
POST /ingest → ctx.waitUntil(Promise.allSettled(shards)) → return 200 (at 8s)
                 HyDE (70s) killed at ~38s                       client happy
```

**Phase 31K: Durable Object alarm — WORKS.**
Producer writes R2 artifact, inserts D1 job row, gets OrchestratorDO stub,
sends `/start` (stores config + sets alarm for +100ms), returns 200 immediately.
The OrchestratorDO.alarm() handler runs both fan-outs to completion independently
of the HTTP request lifecycle. Client polls `/jobs/:id/status`.

```
POST /ingest-sharded → write R2 → INSERT job row →
  OrchestratorDO.start (store config, set alarm +100ms) → return 200 (<1s)

OrchestratorDO.alarm() → read config from DO storage →
  Promise.all([codeFanout, hydeFanout]) → aggregate in D1
```

This required three separate POCs to prove:
- **31D:** Alarm fires and synthetic fan-out completes (`31d-alarm-fanout/`).
- **31E:** R2-pull works from alarm-launched shards (`31e-r2pull-fanout/`).
- **31F:** Real Vertex embedding works inside DO, atob bug caught (`31f1-vertex-in-do/`).

**Evidence:** 30F doc comment (lines 2-13), 31K OrchestratorDO.alarm() (lines 202-231).
Commits `1e61eaa` (30C), `0c3a479` (31D-E-F), `9592b54` (31K).

### 3.3 R2-Pull Benefits

The R2-pull pattern replaced the earlier approach of the producer partitioning
records and sending per-shard payloads in each DO fetch body.

**How it works:** Producer writes the full JSONL artifact to R2 once.
Each shard DO independently calls `this.env.ARTIFACTS.get(artifactKey)` and
filters its records: `records.filter((_, i) => i % shardCount === shardIndex)`.

**Benefits over per-shard payloads:**
1. **No payload size limits in DO-to-DO fetch.** The 500KB artifact as a fetch
   body to 64 shards simultaneously would stress the serialization boundary.
   R2 read is optimized for large-object access.
2. **Independent shard startup.** Shards don't wait for the producer to prepare
   their data. They self-serve from R2. If the orchestrator re-fires a failed shard,
   it re-reads from R2 — no need to re-send payloads.
3. **Deterministic filtering.** `i % shard_count === shard_index` is a pure
   function — every record processed exactly once, zero coordination.
4. **Retry-friendly.** Failed shard retry is just `doFetch(shard, "/process", ...)` —
   shard re-reads from R2 and reprocesses. No state tracking of "which shard has which data."

**Evidence:** POC 31E proved R2-pull at scale. `31k-2pop-fixed/src/index.ts:125-126`
(CodeShardDO), line 156-157 (HydeShardDO). Commit `0c3a479`.

---

## 4. POC Methodology Wins

### 4.1 How Splitting 31C into 31D-E-F Caught Three Bugs Independently

**Original plan:** POC 31C was to be one monolithic "build the full scaffold indexer" —
alarm fan-out + R2-pull + Vertex embedding + DeepSeek HyDE + Vectorize/D1, all in one POC.

**What actually happened:** 31C hit the DO storage 128KB limit during design.
Rather than work around it in a large codebase, we split into five focused POCs:

| POC | Proved | Discovered |
|-----|--------|------------|
| 31D | Alarm-driven fan-out with synthetic payloads | Alarm pattern works; DO-to-DO fetch reliable |
| 31E | R2-pull per shard with D1 counters | R2 reads from shard DOs are fast; modulo filtering correct |
| 31F.1 | Vertex embedding inside a DO (standalone) | Vertex API reachable from DO; OAuth token cache works |
| 31F | Code-only path (Vertex + Vectorize + D1) in DO | Full code path works |
| 31G | Dual fan-out (code + hyde) combined | `atob` PEM bug surfaced (multi-SA) |

**Why this mattered:**

- The **128KB storage limit** was caught in 31C's design phase before code was written.
- The **atob PEM bug** was caught in 31F.1/31F when testing Vertex inside a DO in
  isolation. In a monolithic 31C, the error would have appeared as "Vertex 401 for
  some shards" with R2, Vectorize, D1, and DeepSeek all confounding variables.
- The **alarm pattern viability** was proven in 31D with synthetic data — if the alarm
  didn't fire, we'd know it was a DO lifecycle issue, not a Vertex auth issue.
- Each POC had exactly ONE failure mode. Commit and push on each PASS created a
  recoverable checkpoint chain.

**Evidence:** Commit `0c3a479` message: "Phase 31-series POCs: alarm-driven DO fan-out,
R2-pull per shard, fire-and-forget producer." The five commits span 31D through 31G.

### 4.2 The Two-Error Rule in Action

Across all phases (26–31), the POC discipline enforced: **split any POC that can
fail in more than two independent ways.** Examples:

- **26C split (26C1-C4):** Queue consumer with combined R2 + Vectorize failed twice.
  Splitting isolated: cleanup proof (26C1), R2 proof (26C2), Vectorize proof (26C3),
  combined (26C4). 26C1 discovered a critical CF platform behavior (must unbind Queue
  consumers before deleting Workers) that would have blocked all cleanup scripts.

- **26D split (26D0-D4):** Council review mandated a safety preflight. The preflight
  caught D1-as-source-of-truth, duplicate message idempotency, and Vectorize metadata
  index ordering — all became non-negotiable safety contracts.

- **29D pivot:** Original plan (round-robin → batch → crank concurrency) was
  collapsed into one architectural change (sharded DO fan-out) when the user pointed
  at cfpubsub-scaffold's shard pattern. Right kind of pivot — the POC plan was wrong,
  and correcting before building saved weeks.

**Commit evidence:** `4041db5` (26A split), `ddec9d6` (26D safety preflight),
`80df58f` (29 plan revision).

---

## 5. What NOT to Do

### 5.1 DO NOT Store Artifact Text in DO Key-Value Storage

**Anti-pattern:** `ctx.storage.put("artifact", jsonlText)`

**Why it fails:** DO KV storage has a 128 KiB per-key limit (see 2.4).
A 600-chunk JSONL artifact is ~500 KB — well over the limit. Even 154 chunks
(~120 KB) is right at the boundary.

**What crashed:** POC 31C design phase caught this. POC 30F's original approach
(in-memory artifact text passed to shards) was compatible but fragile.

**What to do instead:** Store artifact in R2. Shard DOs read from R2 independently.
The orchestrator stores only `{ job_id, artifact_key, ...config }` — <1KB.

**Evidence:** `30f-fire-forget/src/index.ts:469-472` (R2 put). 
`31k-2pop-fixed/src/index.ts:251` (R2 put). Commit `0c3a479`.

### 5.2 DO NOT Use `ctx.waitUntil` for Fan-Outs That Exceed 30 Seconds

**Anti-pattern:**
```typescript
ctx.waitUntil(Promise.all([codeFanout, hydeFanout]));
return Response.json({ ok: true });
```

**Why it fails:** `ctx.waitUntil` has a 30-second post-response cap (see 2.3).
If the fan-out takes 90s (HyDE for 600 chunks), the HyDE path is cancelled at
~38s. Code completes; HyDE silently fails. No error to catch — the promise is
cancelled, not rejected.

**What failed:** POC 30F — code went live (8s), HyDE abandoned mid-flight (70s).

**What to do instead:** Durable Object alarm (see 3.2). Producer stores config,
sets alarm, returns immediately. Alarm handler runs fan-out in its own lifetime.

**Evidence:** `30f-fire-forget/src/index.ts:2-13` (doc comment describing the failure).
Commit `9592b54` (31K with alarm pattern).

### 5.3 DO NOT Use a Single Pool DO for Vertex Embedding Serialization

**Anti-pattern (attempted in POC 31H):** Create one `EmbedPoolDO` that all
hyde shards call for Vertex embedding. The pool DO serializes Vertex calls.

**Why it fails:** A single DO is a single isolate. Each isolate has the ~6
concurrent outbound fetch cap (see 2.1). The pool DO becomes a bottleneck —
it can fire only ~6 Vertex calls concurrently while 64 shards wait in queue.
The serialization eliminates all parallelism.

**What happened:** POC 31H proved the pool "works" (no errors) but was
measurably slower — ~15s added queueing delay vs per-shard Vertex.

**What to do instead:** Let each hyde shard call Vertex directly. With N SAs
round-robin across M shards, each SA gets called by M/N shards, each firing
~6 concurrent Vertex calls. Effective concurrency = M * 6 (cross-barrier)
or N * 6 (per-SA), depending on whether Vertex throttles per-SA. Our
measurements show Vertex does NOT throttle per-SA at our scale (see 2.1 note).

**Evidence:** `31h-hyde-pool/src/index.ts` (pool pattern). POC 31K removed it
in favor of per-shard Vertex calls. Commit `9592b54`.

### 5.4 DO NOT Build a 3-Population Architecture with D1 as Stitch Point

**Anti-pattern (attempted in POC 31J):** Population 2 writes DeepSeek questions
to D1. Population 3 polls D1 for `embedded=0` questions.

**Why it fails (see 3.1 for details):**
- D1 write-read eventual consistency: Population 3 sees stale state.
- Polling loop burns CPU or misses records.
- Orphan management: what happens to questions whose embedding fails?
- Zero measured speed benefit vs 2-pop.

**What to do instead:** Keep HyDE self-contained in one DO type (DeepSeek →
Vertex → Vectorize + D1). Equivalent speed, simpler schema, one failure mode.

**Evidence:** `31j-3pop/src/index.ts` (322 lines, 4 D1 tables).
`31k-2pop-fixed/src/index.ts` (285 lines, 2 D1 tables). Commit `9592b54`.

### 5.5 DO NOT Use Service Bindings or RPC for Shard DO Invocation from Inside Another DO

**Why it fails:** Service bindings are only available in module-level Worker
fetch handlers. Inside a DO, you cannot use `env.CODE_DO.method()`. You must
use `env.CODE_DO.get(id).fetch(url, init)` — the stub-based fetch pattern.

**What to do:** Every shard DO implements a `fetch()` handler that routes to
an internal method (e.g., `POST /process`). The orchestrator uses
`doFetch(stub, "https://s/process", { method: "POST", body })` with a
wrapper that adds configurable timeout (120s default).

**Evidence:** `31k-2pop-fixed/src/index.ts:36-41` (doFetch helper),
lines 209, 214 (orchestrator calling shards via stub.fetch()).

---

## 6. Production Cutover Checklist

Moving POC 31K architecture into the canonical worker at
`cloudflare-mcp/workers/codebase/src/index.ts` and deploying to production
`cfcode-codebase-lumae-fresh` (dispatch namespace `cfcode-codebases`).

### 6.1 Source Changes (canonical worker)

- [ ] Add `OrchestratorDO` class with alarm-driven fan-out (`31k-2pop-fixed/src/index.ts:197-232`)
- [ ] Add `CodeShardDO` class with R2-pull + Vertex embed + Vectorize/D1 (lines 122-150)
- [ ] Add `HydeShardDO` class with R2-pull + DeepSeek + Vertex embed + Vectorize/D1 (lines 153-194)
- [ ] Add `/ingest-sharded` producer endpoint (lines 239-257): write R2, insert job, fire alarm, return
- [ ] Add `/hyde-enrich` endpoint for gap-filling (lines 260-282)
- [ ] Add `/jobs/:id/status` endpoint (lines 258-259)
- [ ] Apply `atob` PEM fix in `signJwt` (line 66: `const bin = atob(pem)` with charCodeAt loop)
- [ ] Add `parseSA(idx, env)` supporting all 4 SAs (lines 53-60)
- [ ] Add `embed(env, sa, texts)` with 3-retry exponential backoff (lines 84-100)
- [ ] Add `deepseek(env, text)` with 4-retry backoff (lines 105-119)
- [ ] Add `doFetch(s, url, init, ms)` DO stub wrapper with 120s timeout (lines 36-41)
- [ ] Keep legacy `/ingest` (queue-based) functional for backwards compatibility
- [ ] Keep `/search`, `/health`, `/metrics` endpoints unchanged

### 6.2 Wrangler Config Changes

- [ ] Add DO bindings: `CODE_DO`, `HYDE_DO`, `ORCH_DO` with `new_sqlite_classes`
- [ ] Verify R2 binding `ARTIFACTS` → `cfcode-lumae-fresh-artifacts` exists
- [ ] Add env vars: `CODE_SHARD_COUNT=4`, `HYDE_SHARD_COUNT=64`, `CODE_BATCH_SIZE=500`,
  `HYDE_BATCH_SIZE=500`, `NUM_SAS=4`, `HYDE_QUESTIONS=12`,
  `HYDE_MODEL=deepseek-v4-flash`, `HYDE_VERSION=v2`
- [ ] Verify `compatibility_flags: ["nodejs_compat"]`
- [ ] Set `GEMINI_SERVICE_ACCOUNT_B64_3` and `GEMINI_SERVICE_ACCOUNT_B64_4` secrets via
  `cloudflare-mcp/lib/wfp-secret.mjs` (wrangler `secret put` does NOT support
  `--dispatch-namespace` — we learned this in Phase 27)
- [ ] Verify `DEEPSEEK_API_KEY` and `GEMINI_SERVICE_ACCOUNT_B64[_2]` secrets still valid
- [ ] Add `limits.subrequests = 10000` (Paid plan default; for large fan-outs)

### 6.3 Safety Contracts (Must Be Enforced)

From Phase 26D safety preflight. These are non-negotiable:

1. **Vectorize metadata indexes** (`repo_slug`, `file_path`, `active_commit`) must exist
   BEFORE any shard inserts vectors.
2. **D1 `active = 1` is SOURCE OF TRUTH.** Vectorize is eventually consistent.
   Always cross-check search results against D1.
3. **Queues are at-least-once.** `INSERT OR REPLACE` everywhere. `COUNT(*)` for counters.
4. **Soft-delete first** (D1 `active = 0`), then optionally `deleteByIds` from Vectorize.
5. **Deterministic IDs:** `chunk_id = sha256(file_path:chunk_index).slice(0, 16)`.
   HyDE: `${chunk_id}-h${i}`.
6. **Cleanup removes Queue consumer bindings BEFORE deleting Workers/Queues.**

### 6.4 Deploy Sequence

1. **Update source** in `workers/codebase/src/index.ts` with all 31K additions
2. **Run `npm run check`** (tsc --noEmit) — ensure no type errors
3. **Deploy to throwaway namespace worker** first, run POC 31K smoke to verify
4. **Set new secrets** on production user worker via `wfp-secret.mjs`
5. **Deploy canonical** to `cfcode-codebases` namespace as `cfcode-codebase-lumae-fresh`
6. **Smoke search** via gateway to confirm existing 608 chunks still queryable
7. **Run full re-index** via `/ingest-sharded` on lumae-fresh
8. **Verify** code and hyde completion counts, search quality unchanged or improved
9. **Update `cfcode index` CLI** (`cli/cfcode.mjs`) to call `/ingest-sharded`
   instead of `/ingest` (one-line URL change + shard count flag)

### 6.5 Rollback Plan

- [ ] Keep a copy of the current production worker source before modifying
- [ ] The legacy `/ingest` path remains functional — if sharded path fails,
  CLI still works via queue
- [ ] DO bindings are additive — removing `CODE_DO`, `HYDE_DO`, `ORCH_DO`
  from config reverts to pre-31K behavior
- [ ] D1 schema additions are `IF NOT EXISTS` — no data loss on rollback

### 6.6 Monitoring After Cutover

- [ ] `/jobs/:id/status` exposes `code_status`, `hyde_status`, `completed`,
  `hyde_completed`
- [ ] Set up `wrangler tail` on production worker for first few re-indexes
- [ ] Alert on `code_status = 'partial'` or `hyde_status = 'partial'` —
  indicates shard failures that need `/hyde-enrich` gap-fill
- [ ] Monitor per-SA Vertex errors: a single SA going 401 while others work =
  PEM rotation or key material issue (the atob bug taught us this)

---

## Appendix: Key Commit References

| Commit | POC/Phase | What |
|--------|-----------|------|
| `4041db5` | 26A | Split POC after failures — birth of staircase discipline |
| `ddec9d6` | 26D | Safety preflight: 6 non-negotiable safety contracts |
| `fa78322` | 26C | Cleanup ordering: must unbind Queue consumer before delete |
| `80df58f` | 29 | Plan pivot to sharded DO fan-out |
| `9f354be` | 29G | Real codebase: 78.5 cps, 12.99x baseline |
| `ac835aa` | 30B | `/hyde-enrich` resumable gap-filling |
| `1e61eaa` | 30C/30D | Dual fan-out: code 8.3s + hyde 72.3s, e2e 73.3s |
| `0c3a479` | 31D-E-F | Alarm fan-out + R2-pull + Vertex-in-DO staircase |
| `9592b54` | 31K | 2-pop dual fan-out: 632/632 code, 97.0% hyde at 64 shards |
| `c0b1c13` | 31K E2E | Real codebase: cfpubsub-scaffold 154/154 code (100%), 1680/1848 hyde (90.9%) |
| `24d640f` | freeze | Checkpoint before documentation sweep |
# Cloudflare Platform Experimental Findings

Repository: `qdrant-mcp-server` / `cfcode`  
Date: 2026-05-01  
Scope: Cross-referenced CF docs against POC measurements (POCs 28A–31K)  
Methodology: For each finding, CF docs are quoted verbatim, POC data points cited, and reconciliation provided.

---

## 1. Per-Isolate Per-Origin Fetch Concurrency Cap (~6)

**What CF docs say:**

> "Each Worker invocation can have up to six connections simultaneously waiting for response headers."  
> — [Workers Platform Limits > Simultaneous Open Connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)

> "For each incoming request, a Worker can make up to 6 concurrent outgoing `fetch()` requests."  
> — [Workers Changelog 2019-09-19](https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/#2019-09-19)

Key nuance from docs: The limit applies during the "waiting for response headers" phase. Once response headers arrive, that connection slot is freed. A Worker can have many open connections — only 6 can be in the initial headers-pending state. If a 7th is attempted, it is **queued** until one resolves. The runtime also has automatic deadlock avoidance: if a fetch is queue-blocked and the Worker isn't consuming earlier response bodies, the runtime cancels the LRU request to unblock.

**What we measured:**

POC 31I (`cloudflare-mcp/poc/31i-rate-measure/src/index.ts`) fires N parallel `fetch()` calls to `https://www.google.com/generate_204` from inside a Durable Object. The `fetchConcurrency` handler times each request and uses batch-detection (gap > 500ms = new batch). Preserved output observed batches of size ~6 in DO-context runs.

Our production indexing architecture (POCs 30C, 30F, 31K) never fans out more than ~4-6 concurrent outbound fetches per shard DO instance. The sharding pattern (`CODE_SHARD_DO` and `HYDE_SHARD_DO` per shard index) inherently works within the 6-concurrency cap.

**Reconciliation:** Match. The cap is real and enforced. Our architecture avoids it by sharding work across many DO instances rather than trying to blast many concurrent fetches from a single handler.

**Production implication:** No change needed. Our DO-per-shard fan-out pattern is a correct structural response to this limit. Each shard DO makes at most one Vertex fetch per batch iteration, and at most 6 DeepSeek calls concurrent (batch size 6 in POC 31K HydeShardDO). We comfortably stay under the cap.

---

## 2. Vertex Embedding Rate Limits (Effectively None at Our Scale)

**What CF docs say:**

Google Vertex AI rate limits are per-service-account, per-model, per-region. The `gemini-embedding-001` model (now `text-embedding-005`) has default quotas of ~1,500 requests per minute (RPM) per service account. Google's docs show these are soft quotas raisable on request. Cloudflare docs do not cover Vertex limits (it's a Google product).

**What we measured:**

POC 31I (`/vertex-rpm` endpoint) fires N parallel Vertex calls through a single SA. We observed zero `429` responses at n=20 parallel with the `gemini-embedding-001` model and `outputDimensionality=1` (minimum).

POC 31K E2E: 632 code chunks across 4 code shards, each using one of 2 SA accounts. 1848 HyDE vectors across 16 HyDE shards, also across 2 SA accounts. The poll-log (`31k-2pop-fixed/poll-log.jsonl`) shows 100% code completion in ~10 seconds and 90.9% HyDE completion in ~36 seconds with zero Vertex rate-limit errors.

POC 30C 4-codebase benchmark: ran lumae (20,000+ chunks including HyDE) across 4 SA accounts. Zero Vertex-quota-related failures.

**Reconciliation:** At our scale (hundreds to low-thousands of chunks per re-index, 2-4 SA accounts), Vertex rate limits are effectively irrelevant. We are CPU-bound by DeepSeek inference (100-300ms per HyDE chunk) far before we hit any Vertex quota wall. Google's default RPM quotas are ~1,500 per SA, and we batch embeddings (100 texts per Vertex call), so 1,500 batch calls = 150,000 individual embeddings per minute — our entire corpus is ~20,000 vectors.

**Production implication:** Vertex rate limits are not a bottleneck. Continue using 2-4 SA accounts for horizontal fan-out (paralyzing OAuth token acquisition, not RAM). Monitor if we scale past 10+ codebases with simultaneous re-indexes.

---

## 3. Durable Object Alarm Handler Time Limit (15 Minutes)

**What CF docs say:**

> "Alarm handler timeout — 15 minutes"  
> — [Agents SDK > Durable Execution > Why Fibers Exist](https://developers.cloudflare.com/agents/api-reference/durable-execution/#why-fibers-exist)

> "Durable Object Alarm — 15 min" (under Duration limits)  
> — [Workers Platform Limits > Duration](https://developers.cloudflare.com/workers/platform/limits/#duration)

> "The `alarm()` handler has guaranteed at-least-once execution and will be retried upon failure using exponential backoff, starting at two second delays for up to six retries."  
> — [Durable Objects API > Base Class > alarm](https://developers.cloudflare.com/durable-objects/api/base/#alarm)

**What we measured:**

POC 30F (`cloudflare-mcp/poc/30f-fire-forget/src/index.ts`) evolved from `ctx.waitUntil` (which failed on HyDE ~70s workloads) to alarm-driven fan-out. The `JobOrchestratorDO.alarm()` method calls `runDualFanout`, which launches both code and HyDE fan-outs via `Promise.allSettled` across all shard DOs. In POC 31K, the total wall time for full re-index was ~36 seconds — well within the 15-minute alarm budget.

POC 31K poll-log shows the orchestrator alarm completing in ~36 seconds from alarm fire to `"status":"published"`. Even with far larger codebases (lumae is ~20K chunks), the E2E re-index completes in ~3-5 minutes, well under the 15-minute cap.

**Reconciliation:** Match. The 15-minute alarm timeout is generous for our workload. Even the largest codebase we've tested (lumae with HyDE, ~20K vectors) completes within 5 minutes. If a single alarm handler ever exceeded 15 minutes, CF docs note that retries use exponential backoff.

**Production implication:** The DO alarm pattern is correct for our fan-out orchestrator. One concern: the alarm handler runs inside a single DO's request lifetime. If we ever need >15 minutes of work, we'd need to split into multiple alarms (checkpoint-and-continue). Currently not needed.

---

## 4. `ctx.waitUntil` Time Limit (30 Seconds Post-Response)

**What CF docs say:**

> "The Worker's lifetime is extended for up to 30 seconds after the response is sent or the client disconnects. This time limit is shared across all `waitUntil()` calls within the same request — if any Promises have not settled after 30 seconds, they are cancelled."  
> — [Workers Runtime APIs > Context > waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

> "Use waitUntil for work after the response. There are two common pitfalls: destructuring ctx and exceeding the 30-second waitUntil time limit after the response is sent."  
> — [Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-waituntil-for-work-after-the-response)

**What we measured:**

POC 30F's first version used `ctx.waitUntil` to drive the dual fan-out after the producer returned. This failed: the producer returned in <100ms, but the HyDE phase (~70 seconds in the 30C benchmark) never completed because `waitUntil` cancels after 30 seconds. The comment in `30f-fire-forget/src/index.ts` lines 2-13 documents this explicitly:

> "First attempt used ctx.waitUntil to drive the dual fan-out after the producer returned. That hit the ~30s waitUntil cap — code went live but HyDE (70s) never completed because the orchestrator was killed before its .then() ran."

The fix (POC 30F v2, refined in 31K) moves the fan-out into a `JobOrchestratorDO.alarm()` handler, which runs in its own DO request lifetime with a 15-minute budget — independent of the producer's `waitUntil` window.

**Reconciliation:** Confirmed empirically. `ctx.waitUntil` is genuinely limited to 30 seconds post-response. Our measured failure mode matched the documented behavior exactly.

**Production implication:** Never use `ctx.waitUntil` for work lasting more than 30 seconds. Our alarm-driven DO fan-out pattern is the correct structural fix. For fire-and-forget semantics where the producer must return fast, hand off to a DO alarm. For always-reliable delivery, use Queues.

---

## 5. Durable Object Storage Per-Key Value Size Limit (128 KiB)

**What CF docs say:**

> "Value size — 128 KiB (131072 bytes)"  
> — [Durable Objects Platform Limits > Key-value Backed General Limits](https://developers.cloudflare.com/durable-objects/platform/limits/#key-value-backed-durable-objects-general-limits)

This is for the key-value storage backend (`this.ctx.storage.put/get`). The SQLite-backed storage has different limits (2 MB row size max). Key size limit: 2 KiB (2048 bytes).

**What we measured:**

Our `JobOrchestratorDO` (POC 30F and 31K) stores a `StoredJob` / `JobConfig` object via `this.ctx.storage.put("config", cfg)`. These objects contain:
- `job_id` (string, ~36 chars)
- `artifact_key` (string, ~64 chars)
- `repo_slug` (string, ~32 chars)
- Several integer config values (shards, batch sizes, etc.)

Total serialized size: < 1KB. Well within the 128 KiB limit.

The orchestrator deletes the config after the alarm completes (`this.ctx.storage.delete("config")`), so storage pressure is transient.

**Reconciliation:** Not a bottleneck at our scale. Our DO storage usage is minimal (config objects only).

**Production implication:** If we ever needed to store per-DO state larger than 128 KiB (e.g., caching chunk text in DO storage), we should use R2 instead. Current architecture uses R2 for artifact storage and DO storage only for tiny job configs — correct.

---

## 6. Durable Object Subrequest Limits (1,000 per Invocation, Free Plan)

**What CF docs say:**

> "Workers can now make up to 1000 subrequests to Durable Objects from within a single request invocation, up from the prior limit of 50."  
> — [Workers Changelog 2021-07-16](https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/#2021-07-16)

> "Subrequests per invocation — 50 (Free) / 10,000 (up to 10M) (Workers Paid)"  
> — [Workers Platform Limits > Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

Note: The 1,000 number is from the 2021 changelog for DO-to-DO calls specifically. The general Workers subrequest limit is now 10,000 on paid plans (2026 era).

**What we measured:**

POC 31K's `OrchestratorDO.alarm()` makes exactly `code_shards + hyde_shards` DO-to-DO fetches (4 + 16 = 20 in the default config). Each shard DO internally makes R2 fetch (1), Vertex calls (N batches), Vectorize upserts (N batches), and D1 batch statements (N batches). Total subrequests per alarm invocation: well under 100.

POC 30G Vectorize bench: worst case was 32 shards × 1 producer fetch = 32 DO-to-DO calls plus N Vectorize upserts per shard. Total subrequests < 200.

**Reconciliation:** We are three orders of magnitude below the limit. Even at 64 shards with 50 API calls each, we'd be at 3,200 — still below 10,000.

**Production implication:** Not a concern. The shard pattern is efficient: each shard DO does its own internal I/O without crossing back to the orchestrator. We'd need to be doing something pathological (like a nested fan-out within a fan-out) to hit this. Continue using DO-to-DO service binding calls (not public `fetch()` to worker URLs) to stay on the internal-fast-path.

---

## 7. Workers HTTP Duration (No Hard Limit While Client Connected)

**What CF docs say:**

> "There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing, making subrequests, and setting timeouts."  
> — [Workers Platform Limits > Duration](https://developers.cloudflare.com/workers/platform/limits/#duration)

However, non-HTTP triggers have hard limits: Cron Triggers (15 min), DO Alarms (15 min), Queue Consumers (15 min).

> "Cloudflare updates the Workers runtime a few times per week. The runtime gives in-flight requests a 30-second grace period to finish."  
> — Same page, note block.

**What we measured:**

Our producer endpoint (`/ingest-sharded`) returns in ~50ms in POC 31K. The long-running work is moved to the DO alarm handler (15 min budget). We never rely on keeping an HTTP client connected for minutes.

Our search endpoints (in the gateway worker) handle MCP tool calls — short-lived HTTP requests that complete in <1 second. No long-polling.

**Reconciliation:** Docs are accurate. HTTP Workers have effectively unlimited duration. We leverage this in the gateway but it's not critical for indexing (which uses alarms). The 30-second grace period during runtime updates is a footgun for very-long-running HTTP handlers.

**Production implication:** Our architecture is correct. Long-running indexing work goes to DO alarms, not HTTP handlers. Search is fast. If we ever needed a very-long-running HTTP handler (e.g., streaming a large SSE feed), the no-hard-limit property is valuable, but we'd need to be aware of the 30-second grace period during deploys.

---

## 8. Vectorize Write Throughput (~5,178 vps Headroom from POC 30G)

**What CF docs say:**

Cloudflare does not publish explicit Vectorize upsert rate limits. The [Vectorize Pricing page](https://developers.cloudflare.com/vectorize/platform/pricing/) bills on queried vector dimensions, not on write rate. The [Insert Vectors guide](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) discusses `upsert()` usage but no rate limits.

**What we measured:**

POC 30G (`cloudflare-mcp/poc/30g-vectorize-bench/`) is a synthetic Vectorize-only benchmark — no Vertex, no DeepSeek, no D1. It fans out N shard DOs, each upserting 1,000 random 1536-dim vectors in configurable batch sizes. Results from `bench-30g.json`:

| Shards | Batch | Vectors | Wall (ms) | **vps** | p50 (ms) | p95 (ms) |
|--------|-------|---------|-----------|---------|----------|----------|
| 1      | 100   | 1,000   | 22,014    | 45.43   | 1,827    | 5,019    |
| 4      | 100   | 4,000   | 12,436    | 321.65  | 1,263    | 1,619    |
| 8      | 100   | 8,000   | 11,546    | 692.88  | 982      | 1,936    |
| 16     | 100   | 16,000  | 14,281    | 1,120.37| 1,148    | 2,344    |
| 32     | 100   | 32,000  | 17,756    | 1,802.21| 1,364    | 3,018    |
| 16     | 200   | 16,000  | 11,789    | 1,357.20| 1,298    | 7,134    |
| **16** | **1,000** | **16,000** | **3,090** | **5,177.99** | **1,949** | **3,021** |

The peak configuration (16 shards × 1,000 vectors/shard, batch=1,000) achieved **5,178 vectors/sec** with no errors. Total vectors written: 16,000 in 3.09 seconds wall clock.

**Reconciliation:** Vectorize is not our bottleneck. The `run.log` notes: "Vectorize NOT the bottleneck — 5178 vps headroom." Compare with our production E2E peak: POC 30C lumae at ~122 vps (including Vertex + DeepSeek). That's a **42x safety margin**. The true bottleneck is DeepSeek inference latency (~100-300ms per HyDE chunk) and Vertex embedding latency (~80-200ms per batch of 100).

**Production implication:** We can comfortably scale Vectorize writes without concern. The optimal batch size for Vectorize appears to be large (500-1,000 vectors per upsert). In production, our batch sizes are constrained by embedding model limits (Vertex max is ~250 instances per call for `text-embedding-005`), so Vectorize throughput is never the gating factor.

---

## 9. D1 Batch Statement Limits

**What CF docs say:**

> "Maximum SQL statement length — 100,000 bytes (100 KB)"  
> "Maximum bound parameters per query — 100"  
> "Maximum SQL query duration — 30 seconds"  
> "Queries per Worker invocation — 1000 (Workers Paid) / 50 (Free)"  
> — [D1 Platform Limits](https://developers.cloudflare.com/d1/platform/limits/)

> "Limits for individual queries apply to each individual statement contained within a batch statement. For example, the maximum SQL statement length of 100 KB applies to each statement inside a `db.batch()`."

> "Each individual D1 database is inherently single-threaded, and processes queries one at a time."  
> "If your average query takes 1 ms, you can run approximately 1,000 queries per second. If your average query takes 100 ms, you can run 10 queries per second."

**What we measured:**

Our D1 batch usage in POC 31K (`CodeShardDO.process` and `HydeShardDO.process`):

```typescript
// Per batch of N records (N = batch_size, typ. 100 or 500):
const stmts = group.map((r, i) => this.env.DB.prepare(
  `INSERT OR REPLACE INTO chunks (...) VALUES (?,?,?,?,...)`
).bind(r.chunk_id, ...));  // ~8 bound parameters per row
await this.env.DB.batch(stmts);  // One batch call with N statements
```

Batch sizes observed:
- Code batch: 500 records → 500 prepared statements per batch, ~8 params each
- HyDE batch: 500 records → 500 prepared statements per batch, ~12 params each

Each statement is ~250 bytes SQL text (well under 100KB), ~8-12 bound parameters (well under 100). A batch of 500 statements takes ~50-200ms wall clock in our measurements (included in `d1_ms` totals in shard results).

The POC 30F shard results show typical D1 batch latency around 50-120ms for hundreds of INSERTs. POC 31K uses `INSERT OR REPLACE` (idempotent by design — Safety Contract 4).

**Reconciliation:** We are within all D1 limits. No batch exceeds the parameter or statement-length caps. The single-threaded nature of D1 means high-concurrency writes from many shard DOs will serialize at the database level. This is why our shard DOs use `db.batch()` internally (amortizing per-statement overhead) but we don't fan out hundreds of parallel batches from a single handler.

**Production implication:** 
- **Batch size sweet spot**: 100-500 statements per batch. Larger batches risk hitting the 30-second query duration limit (though our batches complete in <200ms).
- **D1 single-threaded concurrency**: This is the real D1 limit. Many shard DOs writing simultaneously will queue at the D1 level. Our current scale (4-16 shards, each writing every ~200ms) is fine. Monitoring needed if we scale to 64+ shards.
- **Use `INSERT OR REPLACE` everywhere**: Already done. Ensures at-least-once queue re-delivery is safe (Safety Contract 3).

---

## 10. Worker Subrequest Limits (10,000 for Paid)

**What CF docs say:**

> "Subrequests per invocation — 50 (Workers Free) / 10,000 (up to 10M) (Workers Paid)"  
> — [Workers Platform Limits > Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

> "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1."

There's a separate internal-services subrequest cap (1,000 for Free, matches configured limit for Paid). But service bindings (DO-to-DO) bypass public-fetch subrequest counting.

**What we measured:**

Counting subrequests in a typical POC 31K re-index of 632 chunks:

- Producer: 1 R2 put + 1 D1 INSERT + 1 DO fetch = 3 subrequests
- Orchestrator alarm: 4 code-shard DO fetches + 16 hyde-shard DO fetches = 20 subrequests
- Per code shard: 1 R2 get + ~2 Vertex calls + ~2 Vectorize upserts + ~2 D1 batches = ~7 per shard
- Per hyde shard: 1 R2 get + ~10 DeepSeek calls + ~4 Vertex calls + ~4 Vectorize upserts + ~4 D1 batches = ~23 per shard

Total: 3 + 20 + (4×7) + (16×23) = 3 + 20 + 28 + 368 = **~419 subrequests** for a full re-index.

Even the largest codebase (lumae, ~20K chunks at 64 shards) would be: 3 + (64+64) + (64×20) + (64×40) = 3 + 128 + 1280 + 2560 = ~**3,971 subrequests** — well under 10,000.

**Reconciliation:** We are ~25x under the paid-plan subrequest limit at our largest scale. We'd need a codebase generating >250,000 chunks to hit the 10,000 subrequest cap.

**Production implication:** Not a concern. The shard-DO pattern is subrequest-efficient because each DO handles its own I/O internally. We should continue preferring service bindings (`DO.get(id).fetch()`) over public URLs for DO-to-DO calls, as service bindings don't count as public-fetch subrequests.

---

## Summary Matrix

| # | Finding | CF Docs Limit | Measured | Safe Margin |
|---|---------|---------------|----------|-------------|
| 1 | Fetch concurrency per invocation | 6 simultaneous | 4-6 per shard DO | Matched by design |
| 2 | Vertex RPM | ~1,500/SA (Google default) | 0 observed 429s | Orders of magnitude |
| 3 | DO alarm timeout | 15 min | ~36s (31K), ~5min (lumae) | 180x min |
| 4 | `ctx.waitUntil` timeout | 30s post-response | Confirmed failure at 70s | Architectural fix applied |
| 5 | DO storage value size | 128 KiB | <1 KB (config objects) | 128x |
| 6 | DO subrequests per invocation | 1,000 (Free) / 10,000 (Paid) | <100 per alarm | 100x+ |
| 7 | HTTP Worker duration | No hard limit | N/A (not relied on) | N/A |
| 8 | Vectorize upsert throughput | No published limit | 5,178 vps peak | 42x over prod needs |
| 9 | D1 batch limits | 100KB stmt / 100 params / 30s | ~250B stmt / ~10 params / <200ms | 400x / 10x / 150x |
| 10 | Worker subrequests per invocation | 10,000 (Paid) | ~419 typical, ~4K worst-case | 25x min |

## Architecture Validation

All 10 findings validate the current `cfcode` architecture:

1. **DO-per-shard fan-out** correctly works within the 6-fetch-concurrency cap.
2. **Multi-SA OAuth** is unnecessary for rate limits but useful for redundancy.
3. **DO alarm pattern** (30F/31K) correctly replaces `ctx.waitUntil` for >30s work.
4. **DO storage for configs only** avoids the 128KB per-key limit.
5. **Service bindings** keep DO-to-DO calls off the subrequest counter.
6. **D1 `INSERT OR REPLACE`** with batched writes stays within all D1 limits.
7. **Vectorize is proven not the bottleneck** — focus optimization on Vertex/DeepSeek latency.
