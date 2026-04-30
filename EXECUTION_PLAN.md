# Execution Plan — POC-Driven Build

**Goal:** Build the best possible Cloudflare-native semantic code search. Eval-driven, every architectural choice measured.

**Test corpus:** lumae.ai (591 files, ~11K chunks)
**Golden queries:** 240 validated queries across 166 files, 6 query types

---

## Completed POCs

### POC 1 ✅ — Checkpoint JSONL format
### POC 2 ✅ — Gemini Flash Lite single HyDE call (1.73s, $0.0002/chunk)
### POC 3 ✅ — Gemini HyDE batch (7/7, 4.4s total, 5 concurrent)
### POC 4 ✅ — 240 golden queries (Flash Lite + Codex Spark validated line ranges)
### POC 5 ✅ — Qdrant bare (11K chunks, Gemini 768d, single vector)
### POC 7 ✅ — AI Search bare (356 files, auto-chunk, BGE/Qwen default embeddings, hybrid+trigram)
### POC 8 ✅ — AI Search + HyDE naive prepend (same config, HyDE questions in content)

### POC 9 ✅ — Eval: Qdrant bare vs AI Search bare

| Metric | Qdrant bare | AI Search bare | Delta |
|---|---|---|---|
| Recall@5 | 0.667 | **0.817** | +0.150 |
| Recall@10 | 0.787 | **0.858** | +0.071 |
| MRR | 0.509 | **0.660** | +0.150 |
| nDCG@10 | 0.542 | **0.664** | +0.122 |

**Verdict:** AI Search wins 4/4. Hybrid search (vector + BM25 trigram) beats pure vector.

### POC 9b ✅ — Eval: AI Search bare vs AI Search + HyDE (naive prepend)

| Metric | AI Search bare | + HyDE prepend | Delta |
|---|---|---|---|
| Recall@5 | 0.817 | **0.863** | +0.046 |
| Recall@10 | 0.858 | **0.900** | +0.042 |
| MRR | 0.660 | **0.725** | +0.066 |
| nDCG@10 | 0.664 | **0.737** | +0.073 |

**Verdict:** HyDE prepend helps but diminishing returns. Debugging queries regressed (-0.032) — embedding dilution.

---

## Key Discovery: AI Search Configuration

- `chunk: false` — disables auto-chunking, treats each upload as one unit
- `embedding_model: "google-ai-studio/gemini-embedding-001"` — Gemini 1536d embeddings
- Two-index architecture viable: pre-chunk locally, upload to separate instances

---

## POC 10 ✅ — Vectorize+D1 with Gemini 768d embeddings (172s total)
## POC 10b ✅ — Eval: Vec+D1 vs AI Search (Vec wins Recall, AI Search wins MRR)
## POC 10c ✅ — Eval: Vec+D1+Reranker vs AI Search — RERANKER WINS ALL 4 METRICS

| Metric | Vec+D1 | + Reranker | AI Search | Reranker Δ |
|---|---|---|---|---|
| Recall@5 | 0.804 | **0.833** | 0.817 | +0.029 |
| Recall@10 | **0.921** | 0.871 | 0.858 | -0.050 |
| MRR | 0.476 | **0.703** | 0.660 | **+0.227** |
| nDCG@10 | 0.534 | **0.717** | 0.664 | **+0.183** |

**Winning architecture: Vectorize (Gemini 768d) + D1 FTS5 (trigram) + bge-reranker-base**

---

## Remaining POCs — Quality Optimization

Council research (Gemini Pro + ChatGPT) identified 4 phases. Phase 1 (reranker) is done.

### POC 11: AST-aware chunking (Tree-sitter)

**Proves:** Does function/class-level chunking beat naive 1500-char line splits?

**Build:**
- Install tree-sitter with Python and JavaScript grammars
- Chunk at function/method/class boundaries
- Small functions: merge siblings up to token budget
- Large functions: split by AST blocks, repeat signature as context
- Upload to Vectorize with `chunk: false`, Gemini embeddings
- Rerank with bge-reranker-base

**Isolates:** Chunking strategy (AST vs line-based), everything else held constant.

---

### POC 12: BM25F multi-field search

**Proves:** Does weighting identifier/path/signature fields higher than body text improve BM25 precision?

**Build:**
- D1 schema: separate columns for identifier_exact, identifier_subtokens, path, signature, decorators, body
- FTS5 with column weights: identifiers > path > signature > body
- camelCase/snake_case splitting for identifier subtokens

**Isolates:** BM25 tokenization and field weighting.

---

### POC 13: Two-index HyDE (code + questions, separate)

**Proves:** Does separating code embeddings from HyDE question embeddings beat the naive prepend and eliminate debugging query regression?

**Build:**
- Vectorize index A: clean code chunks only
- Vectorize index B: HyDE questions per chunk
- Query: search both, merge by chunk ID via RRF, then rerank

**Isolates:** HyDE architecture (prepend vs separate indexes).

---

### POC 14: Tuned RRF weights + query-type routing

**Proves:** Does biasing BM25 for symbol queries and vector for architectural queries improve per-type scores?

**Build:**
- Grid search: k ∈ {5, 10, 20, 30, 60}, BM25 weight ∈ {0.8, 1.0, 1.5, 2.0}
- Query-type classifier (lightweight, based on query structure)
- Per-type fusion weights

**Isolates:** Fusion parameters and query-type awareness.

---

## Dependency Graph

```
Done: POCs 1-5, 7-9, 9b

POC 10 (Gemini auto-chunk) — independent, run now
POC 11 (our chunks + Gemini) — independent, run now
  └─► POC 12 (two-index HyDE) — depends on POC 11's chunks
        └─► POC 13 (full comparison) — depends on 10, 11, 12
```

POCs 10 and 11 can run in parallel.

## Cost Estimate

| POC | Cost | Time |
|---|---|---|
| 10 (Gemini auto-chunk) | ~$0 (beta) | ~3 min |
| 11 (Gemini pre-chunk) | ~$0 (beta) | ~3 min |
| 12 (two-index) | ~$0 (beta) | ~5 min |
| 13 (eval comparison) | ~$0.02 (Gemini embed for Qdrant queries) | ~5 min |
| **Total remaining** | **~$0.02** | **~16 min** |

---

## POC 15: Google Embedding Smoke Benchmark ✅

**Status:** PASS — 2026-04-30 — local smoke command exited 0.

- [x] Auth token minted from `/Users/awilliamspcsevents/Downloads/team (1).json`.
- [x] 12 Google Vertex embedding configurations returned numeric vectors.
- [x] Best tiny-corpus score: `text-embedding-005`, 768 dimensions, query `RETRIEVAL_QUERY`, document `RETRIEVAL_DOCUMENT`, Recall@3 1.000, MRR 1.000, 2313 ms.
- [x] Runner-up high-quality Gemini option: `gemini-embedding-001`, 1536 dimensions, query `RETRIEVAL_QUERY`, document `RETRIEVAL_DOCUMENT`, Recall@3 1.000, MRR 1.000, 2580 ms.

**Proves:** Which Google Vertex embedding model, dimension, and query task type is the best first candidate for this repo's Qdrant code-search workload.

**Build:**
- `src/poc/15-google-embedding-smoke.mjs`
- Authenticates with a local Google service-account JSON.
- Calls Vertex `:predict` for Google text embedding models.
- Embeds labeled local code snippets as `RETRIEVAL_DOCUMENT`.
- Embeds natural-language code-search queries as `CODE_RETRIEVAL_QUERY` and `RETRIEVAL_QUERY`.
- Ranks snippets by cosine similarity and reports Recall@K, MRR, latency, and vector dimensions.

**Input:** Local source files in this repo and `GOOGLE_APPLICATION_CREDENTIALS` or `/Users/awilliamspcsevents/Downloads/team (1).json`.

**Pass criteria:**
- Auth token is minted from the service account.
- At least two embedding configurations return numeric vectors.
- The script prints ranked retrieval metrics and exits 0.

**Run:** `GOOGLE_APPLICATION_CREDENTIALS="/Users/awilliamspcsevents/Downloads/team (1).json" node src/poc/15-google-embedding-smoke.mjs`

---

## POC 21: Google Embedding Token Cache For Full Indexing ✅

**Status:** PASS — 2026-04-30 — local live Vertex smoke command exited 0.

**Proves:** Full-repo Google embedding runs can reuse one Vertex OAuth token across many `gemini-embedding-001` one-input prediction calls.

**Build:**
- `cloudflare-mcp/scripts/poc-21-google-embedding-token-cache.mjs`
- Authenticates with `/Users/awilliamspcsevents/Downloads/team (1).json`.
- Embeds three representative code-search texts with `gemini-embedding-001` at 1536 dimensions.
- Uses an in-process token cache so only one OAuth token request is made.

**Input:** Google service-account JSON and live Vertex AI prediction endpoint.

**Pass criteria:**
- [x] One OAuth token request served all embedding calls — output `Token requests: 1`.
- [x] Three embedding calls returned numeric 1536-dimensional vectors — all outputs `length=1536`.
- [x] The script printed timing/norm evidence and exited 0 — norms `0.691349`, `0.687950`, `0.690907`; elapsed `534`, `198`, `213` ms.

**Run:** `node cloudflare-mcp/scripts/poc-21-google-embedding-token-cache.mjs`

---

## POC 22: Production Indexer Uses Cached Google Token ✅

**Status:** PASS — 2026-04-30 — bounded full-mode indexing and resume smoke exited 0.

**Proves:** `index-codebase.mjs` uses the POC 21 token cache during real indexing, so bounded full-mode runs do not mint one OAuth token per chunk.

**Build:**
- Update `cloudflare-mcp/scripts/index-codebase.mjs`.
- Add in-process Google token cache and token request accounting.
- Include token request count in `last-summary.json`.
- Run a bounded full-mode indexing smoke with a throwaway repo slug and no publish URL.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, Google service-account JSON, and live Vertex AI prediction endpoint.

**Pass criteria:**
- [x] Bounded full-mode indexing wrote at least one embedding artifact — first run `embeddings_written: 1`.
- [x] Summary reported `google_token_requests: 1` when embeddings were written.
- [x] Resume rerun wrote zero embeddings and reported `google_token_requests: 0` — second run `embeddings_written: 0`, `embeddings_skipped: 1`.

**Run:** `node cloudflare-mcp/scripts/index-codebase.mjs --repo /Users/awilliamspcsevents/PROJECTS/lumae-fresh --repo-slug lumae-fresh-token-smoke --mode full --limit 1 --resume`

---

## POC 23: Larger Bounded Full-Mode Index Smoke ✅

**Status:** PASS — 2026-04-30 — 10-file full-mode smoke and resume exited 0.

**Proves:** The production indexer can process a larger bounded full-mode sample with cached Google auth before the 663-file full redo.

**Build:**
- Reuse `cloudflare-mcp/scripts/index-codebase.mjs`.
- Run full mode over the first 10 tracked files using a throwaway repo slug.
- Do not publish to the live MCP endpoint.
- Rerun with `--resume` and verify no embedding work repeats.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, Google service-account JSON, and live Vertex AI prediction endpoint.

**Pass criteria:**
- [x] First bounded run wrote more than one chunk and at least one embedding — `chunk_count: 11`, `embeddings_written: 11`.
- [x] First bounded run reported `google_token_requests: 1`.
- [x] Resume run reported zero chunks, HyDE artifacts, and embeddings written — `chunks_written: 0`, `hyde_written: 0`, `embeddings_written: 0`.
- [x] Resume run reported `google_token_requests: 0`.

**Run:** `node cloudflare-mcp/scripts/index-codebase.mjs --repo /Users/awilliamspcsevents/PROJECTS/lumae-fresh --repo-slug lumae-fresh-full-smoke-10 --mode full --limit 10 --resume`

---

## POC 24: Default Source File Filtering ✅

**Status:** PASS — 2026-04-30 — full dry-run filter smoke exited 0.

**Proves:** Full-mode indexing skips agent/tooling metadata, dependency folders, generated outputs, and non-source assets by default.

**Build:**
- Update `cloudflare-mcp/scripts/index-codebase.mjs`.
- Add a conservative default `isIndexablePath` filter.
- Keep tracked file count and indexable file count visible in the plan.
- Allow override with `--include-non-source`.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh` git tracked files.

**Pass criteria:**
- [x] Full dry-run plan includes `indexable_file_count` — output reported `indexable_file_count: 602` out of `tracked_file_count: 663`.
- [x] First 10 selected files exclude `.agents/` and `.github/`.
- [x] First 10 selected files include source/documentation files only — examples include `1003ingest/parse_1003.py`, `README.md`, prompt `.txt`, and admin `.py` files.

**Run:** `node cloudflare-mcp/scripts/index-codebase.mjs --repo /Users/awilliamspcsevents/PROJECTS/lumae-fresh --repo-slug lumae-fresh-filter-smoke --mode full --limit 10 --resume --dry-run`

---

## POC 25: Post-Filter Bounded Full-Mode Embedding Smoke ✅

**Status:** PASS — 2026-04-30 — filtered 10-file embedding smoke and resume exited 0.

**Proves:** After source filtering, the production indexer can embed a representative 10-file full-mode sample and resume without repeated work.

**Build:**
- Reuse `cloudflare-mcp/scripts/index-codebase.mjs`.
- Run full mode over the first 10 filtered source/doc files using a throwaway repo slug.
- Do not publish to the live MCP endpoint.
- Rerun with `--resume`.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, Google service-account JSON, and live Vertex AI prediction endpoint.

**Pass criteria:**
- [x] First run selected filtered source/doc files, not `.agents` or `.github` — selected files included `1003ingest/parse_1003.py`, `README.md`, prompt `.txt`, and admin `.py`.
- [x] First run wrote more than 10 chunks and embeddings — `chunk_count: 19`, `embeddings_written: 19`.
- [x] First run reported `google_token_requests: 1`.
- [x] Resume run wrote zero chunks, HyDE artifacts, and embeddings — `chunks_written: 0`, `hyde_written: 0`, `embeddings_written: 0`.
- [x] Resume run reported `google_token_requests: 0`.

**Run:** `node cloudflare-mcp/scripts/index-codebase.mjs --repo /Users/awilliamspcsevents/PROJECTS/lumae-fresh --repo-slug lumae-fresh-filtered-smoke-10 --mode full --limit 10 --resume`

---

## POC 26: Full Filtered Lumae Publish — SUPERSEDED

**Status:** SUPERSEDED — 2026-04-30 — local sequential full indexing was stopped because it is the wrong architecture for a process people will follow.

**PIVOT NOTE:** The local controller can assume this machine has the repo and credentials, but the expensive indexing work must fan out on Cloudflare. A local one-request-at-a-time Vertex loop had already produced about 4,796 chunk/HyDE artifacts and 98 MB of local session data before being stopped. Cloudflare docs confirm Queues can autoscale consumers when `max_concurrency` is unset, with `max_batch_size`, retries, and DLQs; R2/D1/Vectorize are the right storage/publication primitives.

**Original proves:** The full filtered lumae codebase can be indexed with Google embeddings, published to the live Cloudflare MCP Worker, documented, resumed, and queried remotely.

**Build:**
- Reuse `cloudflare-mcp/scripts/index-codebase.mjs`.
- Run full mode over all indexable lumae files.
- Publish to `https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/ingest`.
- Generate docs for `https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`.
- Verify live MCP `search` and `collection_info`.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, Google service-account JSON, live Vertex AI, live Cloudflare Worker/D1/Vectorize.

**Pass criteria:**
- [ ] Full run indexes all filtered files and publishes vectors.
- [ ] Generated docs include the exact indexed path and MCP URL.
- [ ] Resume rerun does not regenerate chunks, HyDE artifacts, or embeddings.
- [ ] Live MCP `collection_info` returns the full-run active embedding ID.
- [ ] Live MCP `search` returns relevant lumae source results.

**Run:** `node cloudflare-mcp/scripts/index-codebase.mjs --repo /Users/awilliamspcsevents/PROJECTS/lumae-fresh --repo-slug lumae-fresh --mode full --resume --publish-url https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/ingest --mcp-url https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`

---

## POC 26A: Local Packager Uploads Source Artifacts To R2 — STOPPED

**Status:** STOPPED — 2026-04-30 — two failed runs in a row; split into POCs 26A1-26A4.

**Failure evidence:**
- Run 1 failed at TypeScript validation due `@cloudflare/workers-types` conflicting with default DOM libs.
- Run 2 failed after deploy with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, meaning endpoint/response validation was too broad for a combined resource/deploy/upload POC.
- Throwaway resources were cleaned up: Worker `cfcode-poc-26a-packager`, R2 bucket `cfcode-poc-26a-artifacts`, D1 database `cfcode-poc-26a-jobs`.
- Uncommitted POC 26A files were removed.

**Original proves:** This machine can package a filtered codebase snapshot and upload source/chunk inputs to Cloudflare R2 quickly, without doing embeddings locally.

**Build:**
- Add `cloudflare-mcp/poc/26-cloud-index-worker/`.
- Add a Worker endpoint `/jobs/start` that accepts repo metadata and a manifest upload plan.
- Local script reads `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, applies the POC 24 source filter, and uploads compressed JSONL artifacts to R2.
- D1 records one job row with repo path, slug, file counts, artifact keys, and status.

**Input:** Local lumae repo on this machine, Cloudflare credentials, R2 bucket, D1 database.

**Pass criteria:**
- [ ] R2 contains source/chunk input artifacts for a bounded sample.
- [ ] D1 job row records repo path, slug, artifact keys, and counts.
- [ ] Local script exits without calling Vertex.
- [ ] Job status endpoint returns machine-readable progress JSON.

**Run:** `node cloudflare-mcp/scripts/poc-26a-r2-packager-smoke.mjs`

---

## POC 26A1: Worker Toolchain Compiles With R2 And D1 Bindings ✅

**Status:** PASS — 2026-04-30 — local compile smoke exited 0.

**Proves:** The Cloudflare Worker TypeScript/package baseline for R2+D1 compiles before any remote resources are created.

**Build:**
- `cloudflare-mcp/poc/26a1-r2-d1-compile-worker/`
- Minimal Worker with `/health`, R2 binding type, and D1 binding type.
- No deploy and no Cloudflare resource creation.

**Input:** Local Node/npm toolchain.

**Pass criteria:**
- [x] `npm install` exited 0.
- [x] `npm run check` exited 0.
- [x] No Cloudflare resources were created — POC only ran local npm install/typecheck.

**Run:** `node cloudflare-mcp/scripts/poc-26a1-r2-d1-compile-smoke.mjs`

---

## POC 26A2: R2 Upload Endpoint Only ✅

**Status:** PASS — 2026-04-30 — R2 upload endpoint smoke exited 0 after adding deploy health polling.

**Proves:** A deployed Worker can accept a local artifact upload and store it in R2, without D1 or job state.

**Build:**
- Reuse the POC 26A1 Worker baseline.
- Add `/artifact/put` and `/artifact/head`.
- Provision only a throwaway R2 bucket and Worker.
- Verify the response content type before parsing JSON.

**Input:** Five filtered lumae files packaged by this machine.

**Pass criteria:**
- [x] Worker deploy URL was discovered and `/health` returned JSON after bounded polling.
- [x] `/artifact/put` stored a JSONL artifact in R2 — key `jobs/lumae-fresh-poc-26a2/046f19fac98c9b4c.jsonl`.
- [x] `/artifact/head` reported artifact exists and byte size matched upload — `4277` bytes.
- [x] Throwaway Worker and R2 bucket were cleaned up.

**Run:** `node cloudflare-mcp/scripts/poc-26a2-r2-upload-smoke.mjs`

---

## POC 26A3: D1 Job Row Endpoint Only ✅

**Status:** PASS — 2026-04-30 — D1 job row endpoint smoke exited 0.

**Proves:** A deployed Worker can create and read D1 job rows, without R2 artifact upload.

**Build:**
- Minimal Worker with `/jobs/start` and `/jobs/:id/status`.
- Provision only a throwaway D1 database and Worker.
- Worker creates schema itself on request.

**Input:** Repo slug, indexed path, artifact key, and file counts from this machine.

**Pass criteria:**
- [x] Worker deploy URL was discovered and `/health` returned JSON.
- [x] `/jobs/start` inserted a D1 row — job ID `83c982af-587d-4295-b07c-31270bd6f20b`.
- [x] `/jobs/:id/status` returned the inserted repo path, slug, artifact key, count, and status.
- [x] Throwaway Worker and D1 database were cleaned up.

**Run:** `node cloudflare-mcp/scripts/poc-26a3-d1-job-smoke.mjs`

---

## POC 26A4: Combined Local Packager To R2 And D1 ✅

**Status:** PASS — 2026-04-30 — combined R2+D1 packager smoke exited 0 after one TypeScript narrowing fix.

**Proves:** The two proven endpoints compose: this machine packages files once, Worker stores the artifact in R2, and D1 records the job.

**Build:**
- Combine POC 26A2 and POC 26A3 only after both pass.
- Provision Worker, R2 bucket, and D1 database.
- Upload bounded lumae package and record one job.

**Input:** Five filtered lumae files on this machine.

**Pass criteria:**
- [x] R2 contains source/chunk input artifact for the bounded sample — key `jobs/lumae-fresh-poc-26a4/8ecfd6b98112df8e.jsonl`, size `8731` bytes.
- [x] D1 job row records repo path, slug, artifact key, and counts — job `31e45bf0-ab3d-432b-8148-6ede2accbc22`, `file_count: 5`.
- [x] Local script exits without calling Vertex — `Vertex calls: 0`.
- [x] Job status endpoint returns machine-readable progress JSON — `job`, `artifact`, and `progress` objects all validated.
- [x] Throwaway resources are cleaned up — Worker, R2 bucket, and D1 database cleanup all passed.

**Run:** `node cloudflare-mcp/scripts/poc-26a4-packager-r2-d1-smoke.mjs`

---

## POC 26B: Queue Fan-Out Embeds Chunks In Parallel ✅

**Status:** PASS — 2026-04-30 — bounded Queue fan-out embedding smoke exited 0.

**Proves:** Cloudflare Queues can fan out embedding tasks across many Worker isolates and write embedding artifacts/results without local sequential work.

**Build:**
- Add a Queue producer bound to `/jobs/enqueue`.
- Add a Queue consumer Worker with `max_batch_size` tuned small enough for Vertex rate limits and `max_concurrency` unset unless live limits require throttling.
- Consumer reads chunk/HyDE input from R2, calls Vertex `gemini-embedding-001` at 1536 dimensions, writes embedding result to R2, and updates D1 counters.
- Configure retries and a DLQ for failed chunk messages.

**Input:** POC 26A job artifacts and queue messages for a bounded sample.

**Pass criteria:**
- [x] Queue receives one message per embedding task for a bounded sample — job `fe6fb860-f1a3-4d2d-8cf1-3d6a63c1d129`, `Queued messages: 3`.
- [x] Worker consumer processes messages without local embedding calls — `Completed embeddings: 3`, `Local Vertex calls: 0`.
- [x] R2 contains embedding result artifacts — `Result artifacts: 3`, each result object had metadata for the job.
- [x] D1 counters show queued, processing, completed, failed, and retry-ready state — final `completed: 3`, `failed: 0`, `status: embedded`.
- [x] DLQ configured for the passing sample and throwaway main/DLQ queues were cleaned up.

**Run:** `node cloudflare-mcp/scripts/poc-26b-queue-fanout-embed-smoke.mjs`

---

## POC 26C: Queue Publication Upserts To Vectorize And D1 — STOPPED

**Status:** STOPPED — 2026-04-30 — two failed runs in a row; split into POCs 26C1-26C4.

**Failure evidence:**
- Run 1 proved Queue publication messages, Vectorize upserts, D1 chunks, and active metadata, but failed the Vectorize search visibility assertion (`searchFindsPublishedChunk: FAIL`).
- Run 2 failed at setup because the previous run left Queue names temporarily bound to the Worker (`Queue name 'cfcode-poc-26c-publication' is already taken`).
- Throwaway Worker/Queue/DLQ/R2/Vectorize/D1 resources were manually cleaned up. Queue consumer binding had to be removed before Worker/Queue deletion; the remote R2 object had to be deleted with `wrangler r2 object delete ... --remote`.
- Uncommitted POC 26C files were removed.

**Proves:** Cloudflare-side publication can batch completed embedding artifacts into Vectorize and D1 without local upload loops.

**Build:**
- Add publication queue messages that reference embedding result artifact keys.
- Consumer batches Vectorize `upsert` calls and D1 snippet/metadata writes.
- D1 tracks publication counters and active embedding run metadata.
- MCP Worker reads active run metadata from D1 instead of hardcoded wrangler vars.

**Input:** POC 26B embedding artifacts.

**Pass criteria:**
- [ ] Completed embedding artifacts are published to Vectorize.
- [ ] D1 contains chunk metadata/snippets for published vectors.
- [ ] Active run metadata is stored in D1.
- [ ] MCP `collection_info` reads active run from D1.
- [ ] MCP `search` returns newly published sample chunks.

**Run:** `node cloudflare-mcp/scripts/poc-26c-cloud-publication-smoke.mjs`

---

## POC 26C1: Queue Consumer Binding Cleanup Proof ✅

**Status:** PASS — 2026-04-30 — Queue consumer cleanup smoke exited 0.

**Proves:** A throwaway Queue consumer Worker can be cleanly unbound and deleted before Queue/DLQ deletion, preventing stale queue-name failures.

**Build:**
- Add a minimal Worker with Queue producer/consumer config.
- Add a smoke script that creates Queue/DLQ, deploys the Worker, removes the consumer binding with `wrangler queues consumer remove`, deletes Worker/Queue/DLQ, and verifies the names can be recreated.

**Input:** Cloudflare credentials from `.cfapikeys`.

**Pass criteria:**
- [x] Worker deploys as a Queue consumer — `/health` returned JSON for `cfcode-poc-26c1-queue-cleanup`.
- [x] Consumer binding is removed explicitly before deletion — `wrangler queues consumer remove cfcode-poc-26c1-queue cfcode-poc-26c1-queue-cleanup` passed.
- [x] Worker, Queue, and DLQ delete cleanly.
- [x] Queue name can be recreated after cleanup — `cfcode-poc-26c1-queue` was recreated after deletion.

**Run:** `node cloudflare-mcp/scripts/poc-26c1-queue-cleanup-smoke.mjs`

---

## POC 26C2: R2 Embedding Artifact Publication Input Only ✅

**Status:** PASS — 2026-04-30 — R2 publication artifact smoke exited 0.

**Proves:** A Worker can store bounded embedding publication artifacts in R2 and expose deterministic artifact status without Queue or Vectorize.

**Build:**
- Add `/publication/artifact/start` and `/artifact/head`.
- Store deterministic 1536-dimensional embedding JSONL records in R2.
- No Queue, D1, or Vectorize.

**Input:** Three deterministic embedding records generated by this machine.

**Pass criteria:**
- [x] R2 artifact is stored remotely — key `publication/lumae-fresh-poc-26c2/3fc18a8e0bdf810a.jsonl`, size `90685` bytes.
- [x] `/artifact/head` returns JSON with expected key, size, and metadata — `repo_slug: lumae-fresh`, publication ID matched.
- [x] Remote R2 object is deleted before bucket cleanup — `wrangler r2 object delete ... --remote` passed, then bucket cleanup passed.

**Run:** `node cloudflare-mcp/scripts/poc-26c2-r2-publication-artifact-smoke.mjs`

---

## POC 26C3: Vectorize Visibility After Upsert

**Proves:** Vectorize upserts become query-visible for deterministic 1536-dimensional vectors with bounded polling.

**Build:**
- Add a Worker with only Vectorize binding.
- `/publish` upserts deterministic vectors directly.
- `/search` queries until the expected ID is visible.

**Input:** Three deterministic embedding vectors.

**Pass criteria:**
- [ ] Vectorize index is created at 1536 dimensions.
- [ ] Worker upserts all vectors.
- [ ] Search returns the expected vector ID within the bounded polling window.
- [ ] Worker and Vectorize index are cleaned up.

**Run:** `node cloudflare-mcp/scripts/poc-26c3-vectorize-visibility-smoke.mjs`

---

## POC 26C4: Combined Queue Publication To Vectorize And D1

**Proves:** After cleanup and Vectorize visibility are separately proven, Queue publication can read R2 embedding artifacts, upsert Vectorize, write D1 chunk metadata, and expose MCP-style collection/search endpoints.

**Build:**
- Combine POC 26C1 cleanup, POC 26C2 R2 artifact input, and POC 26C3 Vectorize visibility.
- Queue consumer publishes records into Vectorize and D1.
- Endpoints expose `collection_info` and `search`.

**Input:** Three deterministic embedding records.

**Pass criteria:**
- [ ] Publication Queue receives one message per embedding record.
- [ ] Vectorize contains published vectors and search returns the expected chunk.
- [ ] D1 contains chunk metadata/snippets for published vectors.
- [ ] `collection_info` reads active run metadata from D1.
- [ ] All throwaway resources are cleaned up with explicit Queue consumer removal and remote R2 object deletion.

**Run:** `node cloudflare-mcp/scripts/poc-26c4-cloud-publication-smoke.mjs`

---

## POC 26D: Full Cloudflare Job Runs Lumae End-To-End

**Proves:** With this machine as the packager/controller, Cloudflare completes full filtered lumae indexing quickly via fan-out and the final MCP URL works.

**Build:**
- Local controller uploads full filtered lumae artifacts to R2 and starts the job.
- Cloudflare Queues fan out embedding and publication.
- Status endpoint polls D1 counters until complete.
- Generated docs include indexed local path, MCP URL, full redo command, incremental redo command, and job/status URLs.

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, live Cloudflare R2/D1/Queues/Vectorize/Worker, Google service-account Worker secret.

**Pass criteria:**
- [ ] Full filtered lumae job completes from Cloudflare status endpoint.
- [ ] Runtime and throughput are reported.
- [ ] Resume/retry command skips completed chunks.
- [ ] Generated docs include local path and unique MCP URL.
- [ ] Live MCP `search` returns relevant full-codebase results.

**Run:** `node cloudflare-mcp/scripts/poc-26d-full-cloud-job-lumae.mjs`
