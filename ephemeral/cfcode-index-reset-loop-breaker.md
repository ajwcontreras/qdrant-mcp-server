# cfcode Index Reset Loop-Breaker Bundle — 2026-05-09

## Ask

We need a safer plan to wipe/rebuild cfcode indexes polluted by tracked `ephemeral/` folders without repeatedly discovering failures in production. Diagnose the false assumptions in the current approach and propose a minimal, evidence-first reset strategy.

## Environment

- Repo: `/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server`
- Product: `cfcode`, a Cloudflare Workers-for-Platforms code-search MCP system.
- Gateway URL: `https://cfcode-gateway.frosty-butterfly-d821.workers.dev/mcp`
- Dispatch namespace: `cfcode-codebases`
- User now wants only one Vertex SA used: `/Users/awilliamspcsevents/.config/cfcode/sas/embedding-code-495015-2fa24eece6fa.json`.
- `lumae-fresh` should be left alone.

## What Changed

### Source filter patch

`cloudflare-mcp/lib/files.mjs` now has shared `isSourcePath(f)`:

```js
const SKIP_PATTERN = /^(\.|node_modules|venv|__pycache__|dist|build|ephemeral|\.agents|\.github|\.cursor|\.venv|\.claude)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpg|jpeg|gif|svg|pdf|zip|tar|gz|pyc)$/i;

function isSourcePath(f) {
  return f && !SKIP_PATTERN.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules") && !f.includes("__pycache__");
}
```

`listSourceFiles()` uses this filter. `buildDiffManifest()` was patched to apply it to A/M/D/R paths so incremental excludes `ephemeral/` too.

### Single-SA patch

`cloudflare-mcp/cli/cfcode.mjs` `resolveSAFiles()` returns only `embedding-code-495015-2fa24eece6fa.json`, no fallback to the other local SA JSONs.

### Plain search patch

`cloudflare-mcp/workers/codebase/src/index.ts` `/search` now over-fetches and skips `chunk.kind === "hyde"`, because plain search was returning HyDE child rows with parent chunk IDs as file paths.

## Affected Codebases Found By Audit

Script: `ephemeral/audit-registered-ephemeral.mjs`.

Output:

```text
agent-council          HAS_EPHEMERAL  /Users/awilliamspcsevents/PROJECTS/agent-council          1
income-scout-bun       HAS_EPHEMERAL  /Users/awilliamspcsevents/PROJECTS/income-scout-bun       5
lumae-upload-api       HAS_EPHEMERAL  /Users/awilliamspcsevents/PROJECTS/lumae-upload-api       5
mortgage-rag           HAS_EPHEMERAL  /Users/awilliamspcsevents/mortgage-rag                   559
reviewer-s-workbench   HAS_EPHEMERAL  /Users/awilliamspcsevents/PROJECTS/reviewer-s-workbench   257
```

Clean or untouched:

```text
cf-docs-mcp clean
cfpubsub-scaffold clean
http-to-ssh clean
lumae-fresh clean
qdrant-mcp-server clean
vibesdk-nightly clean
```

## Rebuild Size Estimates After Excluding `ephemeral/`

Script: `ephemeral/estimate-rebuild-chunks.mjs`.

```text
agent-council          946
income-scout-bun       6033
lumae-upload-api       3086
mortgage-rag           425
reviewer-s-workbench   2943
```

## What Succeeded

- `mortgage-rag`: `cfcode uninstall` + `cfcode index --deploy --full --shards 1 --batch 25` succeeded: `425/425`.
- `agent-council`: same pattern succeeded: `946/946`.

## What Failed / Became Ambiguous

### income-scout-bun incremental attempts

Original incremental reindex:

```text
1652 records, 512 tombstones
partial: completed=900 failed=752 deactivated=569
```

Slow sharded retry initially ignored `--shards/--batch` because CLI did not forward flags to `/incremental-ingest-sharded`. Patched CLI to send `shard_count` and `batch_size`.

Slow sharded retry after patch:

```text
--shards 1 --batch 25
partial: completed=627 failed=1025 deactivated=826
```

Queue path attempt:

- Patched `cfcode reindex --queue` to use `/incremental-ingest`.
- It queued job `inc-income-scout-bun-moxqeqp8` but no dispatch worker queue consumer existed.
- Tried to add consumer to WfP user worker; Wrangler says worker does not exist as standalone.
- Temporary standalone consumer was deployed and did drain slowly, but was deleted before destructive reset plan.

### reviewer-s-workbench full rebuild attempts

First full rebuild: `cfcode index --deploy --full --shards 1 --batch 25` printed `fetch failed` after POST. Status showed active publication row but job `running`, not published. `chunk_rows` around 1175 of 2943.

Second destructive full rebuild: `cfcode index --deploy --full --shards 1 --batch 10` printed `fetch failed` after POST. Current job:

```text
job_id: job-reviewer-s-workbench-moxvp42k
total: 2943
status: running
completed: 0
failed: 0
chunk_rows: 510 after 5 min
```

Interpretation: one long shard likely writes rows incrementally but the request/CLI times out before the shard returns and before job counters update. No direct 429 observed in job status; WfP user worker tail is unavailable via normal Wrangler tail.

## Current Suspected False Assumptions

1. Full `ingestSharded` can be used as a clean destructive rebuild for 3k-6k chunks under one SA. Evidence says the synchronous request path is too long/ambiguous.
2. `active_publication` row implies the job is valid. Evidence says active publication is inserted before shard completion, so partial/running jobs can look active.
3. Job `completed` counter gives live progress. Evidence says sharded full ingest updates `chunks` rows as it goes but does not update job counters until all shards return.
4. Queue fallback can consume from WfP user worker. Evidence says WfP user workers are not standalone Queue consumers; a separate standalone worker is needed if using queues.
5. Search-active output is enough to validate a rebuild. Evidence says it may show partial rows and unexpected prefixes; need exact counts and path prefix checks.

## Relevant Files

- `cloudflare-mcp/lib/files.mjs` — source filtering, full chunks, diff manifest, incremental artifact.
- `cloudflare-mcp/cli/cfcode.mjs` — CLI index/reindex/uninstall/search.
- `cloudflare-mcp/workers/codebase/src/index.ts` — Worker endpoints and indexing logic.
- `cloudflare-mcp/lib/cf.mjs` — resource provision/deploy/teardown.
- `cloudflare-mcp/lib/wfp-secret.mjs` — WfP secret upload.
- `cloudflare-mcp/workers/codebase/wrangler.namespace.template.jsonc` — WfP user-worker config; should not include queue consumers.

---

# COUNCIL DIAGNOSIS — 2026-05-09

## 1. Ranked Root Causes (Evidence from Source)

### #1 CRITICAL: `ingestSharded` blocks synchronously on ALL shards; no timeout insulation on DO subrequests
**File:** `cloudflare-mcp/workers/codebase/src/index.ts` lines 572–586

`ingestSharded` calls `await Promise.allSettled(shards.map(...))` **directly in the fetch handler**. It does **not** use the `doFetch()` helper (defined at line 79 with a 120 s timeout) that is already used by `/hyde-enrich`.

With `--shards 1 --batch 25` on 2 943 chunks, a **single `IndexingShardDO`** must process 118 sequential batches. Each batch = 1 Vertex embed call + 1 Vectorize upsert + 1 D1 batch. Wall time is ~45–120 s. The Gateway→User Worker→DO call chain times out before the shard returns, producing the observed `fetch failed`.

**The DO keeps running in the background** (hence `chunk_rows` climbs to 510 after 5 min), but the orchestrator never reaches line 603–605 to update job counters or status.

### #2 HIGH: Job counters are updated ONLY after all shards return; no incremental progress
**File:** `cloudflare-mcp/workers/codebase/src/index.ts` lines 603–605

```typescript
const status = totalErr === 0 ? "published" : (totalDone > 0 ? "partial" : "failed");
await env.DB.prepare(`UPDATE jobs SET completed = ?, failed = ?, status = ? WHERE job_id = ?`).bind(totalDone, totalErr, status, job_id).run();
```

Contrast with the queue consumer path (lines 819–822) which updates `completed` after every single message. In the sharded path, a timed-out job stays `running / completed=0 / failed=0` forever, even though chunks are actively being written.

### #3 HIGH: `active_publication` is optimistically overwritten before any shard work begins
**File:** `cloudflare-mcp/workers/codebase/src/index.ts` lines 563–567

```typescript
await env.DB.prepare(`INSERT OR REPLACE INTO active_publication ...`).bind(...).run();
```

This runs **immediately** after the job row is created and **before** any shards are dispatched. If the request dies, the old publication is already gone and the new incomplete job is advertised as "active". Search returns a partially-built index with no signal that it is corrupt.

### #4 MEDIUM: `--shards 1` is the worst possible setting for large repos
The user chose `--shards 1` believing it was the "safest" setting. It is actually the most dangerous because it maximizes sequential work per DO instance. The proven small-repo settings (`--shards 1 --batch 25` for 425–946 chunks) do not scale linearly.

Shard math for the failed repos:

| repo | chunks | shards | batch | per-shard batches | est. wall time |
|---|---|---|---|---|---|
| reviewer-s-workbench | 2 943 | 1 | 25 | 118 | **> 90 s** |
| reviewer-s-workbench | 2 943 | 16 | 100 | 2 | **~5 s** |
| income-scout-bun | 6 033 | 1 | 25 | 242 | **> 180 s** |
| income-scout-bun | 6 033 | 32 | 100 | 2 | **~8 s** |
| income-scout-bun | 6 033 | 64 | 100 | 1 | **~3 s** |

### #5 LOW: CLI `fetchJson` has no explicit timeout or abort signal
**File:** `cloudflare-mcp/lib/http.mjs` line 2

Bare `fetch()` with no `AbortController`. Node.js `fetch()` has no default timeout, but TCP idle timeouts or CF edge keep-alive limits can still sever long connections.

---

## 2. Minimal Safe Reset Plan

### Principle
Do **not** change the architecture (no DO alarms, no queue refactor). Fix the parameterization so the existing `/ingest-sharded` endpoint finishes inside the implicit timeout window.

### Steps per affected codebase

1. `cfcode uninstall <repo-path>` — destroys the polluted worker + D1 + Vectorize + R2. This is the only way to guarantee zero stale chunks from `ephemeral/` files, because chunk IDs are deterministic over `(file_path, chunk_index)` and old ephemeral paths will not collide with new filtered paths.
2. `cfcode index <repo-path> --deploy --full --shards <N> --batch 100` — rebuild from scratch.

### Shard prescription

| repo | chunks | recommended flags |
|---|---|---|
| `reviewer-s-workbench` | 2 943 | `--shards 16 --batch 100` |
| `lumae-upload-api` | 3 086 | `--shards 16 --batch 100` |
| `income-scout-bun` | 6 033 | `--shards 32 --batch 100` |

Rationale: keep per-shard batches ≤ 4 (ideally ≤ 2). Each batch = 1 Vertex call, so a shard finishes in < 10 s. The orchestrator `Promise.allSettled` over 16–32 parallel DOs resolves in < 15 s total.

### Why not queue-based or DO-alarm?
- **Queue:** WfP user workers cannot have queue consumers in the current `wrangler.namespace.template.jsonc`. Adding them requires template changes and Wrangler deploy gymnastics. More moving parts.
- **DO alarm (POC 31K):** Proven but requires refactoring `ingestSharded` into a fire-and-forget producer + alarm orchestrator + R2-pull shards. Correct for a future phase, unnecessary for this reset if we just use enough shards.

---

## 3. Recommended Architecture Decision

**Use the existing full synchronous `/ingest-sharded` endpoint with higher shard counts.**

Do not introduce queues or DO alarms for this reset. The endpoint is not broken; the parameterization was. Once the indexes are clean, consider the following **two small patches** to prevent recurrence:

### Patch A: Lazy `active_publication` insert (prevents partial jobs from corrupting search)
In `ingestSharded`, move the `active_publication` `INSERT OR REPLACE` from lines 563–567 to **after** line 602, inside the `if (totalErr === 0)` branch. Partial or failed jobs should leave the previous publication intact.

### Patch B: Use `doFetch` in `ingestSharded` and `incrementalIngestSharded`
Replace bare `stub.fetch(...)` with `doFetch(stub, ...)` so hung shards fail fast with a clear `"shard timeout"` error instead of an ambiguous client-side `fetch failed`.

### Patch C: Optional incremental counter from shards (nice-to-have)
Have `IndexingShardDO.processBatch` issue `UPDATE jobs SET completed = completed + ? WHERE job_id = ?` after each group. Adds D1 write contention; only do this if Patch A is insufficient for observability.

---

## 4. Concrete Smoke Tests / Pass Criteria

Run these **before** declaring any rebuild successful.

### 4a. POST-level pass criteria
- `res.ok === true` (HTTP 200)
- `res.status === "published"` or `"partial"` — **NOT** `"running"` after the POST returns
- `res.completed + res.failed === res.chunks`
- `res.wall_ms < 60_000` (should be < 15 s with correct shard count)

### 4b. Job-status pass criteria
```bash
node cloudflare-mcp/cli/cfcode.mjs status <repo-path>
# Or curl directly:
# GET /jobs/:job_id/status
```
- `job.status === "published"`
- `chunk_rows === job.completed`
- `job.failed === 0`

### 4c. Data-quality pass criteria
```bash
node cloudflare-mcp/cli/cfcode.mjs search-active <repo-path>
```
- Count matches the expected chunk count from `estimate-rebuild-chunks.mjs`
- **Zero** rows with `file_path` starting with `ephemeral/`
- **Zero** rows with `kind === "hyde"` (plain search should not surface HyDE children)

### 4d. Search-integration pass criteria
```bash
node cloudflare-mcp/cli/cfcode.mjs search <repo-path> "function" --topK 5
```
- Returns 5 results
- No `file_path` values that look like raw chunk IDs (the old HyDE-leak symptom)
- All `file_path` values are legitimate repo paths

---

## 5. Immediate Next 3 Commands

### Command 1 — Shard-math sanity check (local, zero risk)
```bash
node -e "
const totals = [
  ['reviewer-s-workbench', 2943],
  ['lumae-upload-api', 3086],
  ['income-scout-bun', 6033],
];
for (const [name, total] of totals) {
  console.log('--- ' + name + ' ---');
  for (const shards of [16, 32, 64]) {
    const perShard = Math.ceil(total / shards);
    const batches = Math.ceil(perShard / 100);
    console.log('  shards=' + shards + ' => perShard=' + perShard + ' batches=' + batches);
  }
}
"
```

### Command 2 — Uninstall and rebuild `reviewer-s-workbench` (smallest affected, 2.9k chunks)
```bash
node cloudflare-mcp/cli/cfcode.mjs uninstall ~/PROJECTS/reviewer-s-workbench
node cloudflare-mcp/cli/cfcode.mjs index ~/PROJECTS/reviewer-s-workbench --deploy --full --shards 16 --batch 100
```
**Expected:** POST returns in < 15 s with `status: "published"`, `completed: 2943`.

### Command 3 — Validate with smoke tests
```bash
node cloudflare-mcp/cli/cfcode.mjs status ~/PROJECTS/reviewer-s-workbench
node cloudflare-mcp/cli/cfcode.mjs search-active ~/PROJECTS/reviewer-s-workbench | wc -l
node cloudflare-mcp/cli/cfcode.mjs search ~/PROJECTS/reviewer-s-workbench "auth" --topK 5
```

If Command 2–3 pass, repeat the same pattern for `lumae-upload-api` (`--shards 16`) and `income-scout-bun` (`--shards 32`). If Command 2 still times out, escalate to **Patch B** (`doFetch` wrapper) and try `--shards 32` for reviewer-s-workbench as well.

---

## Appendix: Why the Incremental Path Failed for `income-scout-bun`

Incremental reindex is designed for **git diffs**, not **filter changes**. Even if it had succeeded, it would only deactivate paths present in the new artifact. Old chunks for `ephemeral/` files whose paths were excluded by the new filter would **remain active** because they never appeared in any diff manifest. Full uninstall + rebuild is the only way to purge them.
