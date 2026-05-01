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
