# Cloudflare-First MCP Code Search Execution Plan

Goal: replace the local Qdrant-first MCP with Cloudflare-hosted, unauthenticated remote MCP URLs per codebase. Qdrant can remain a legacy adapter, but the target runtime is Workers + R2 + D1 + Vectorize.

Core invariant:

- Chunking is content-addressed and resumable.
- HyDE is content-addressed and resumable.
- Embeddings are model/provider/dimension-specific projections over chunk and HyDE artifacts.
- MCP serving is independent from indexing jobs.
- Every stage writes machine-readable manifests and can be redone without recomputing upstream stages.

## Target Artifact Model

R2 stores append-only/source artifacts:

- `repos/{repoSlug}/snapshots/{snapshotId}/manifest.json`
- `repos/{repoSlug}/chunks/{chunkerVersion}/{chunkIdentity}.json`
- `repos/{repoSlug}/hyde/{hydeVersion}/{hydeModel}/{contentHash}.json`
- `repos/{repoSlug}/embeddings/{embeddingRunId}/manifest.json`
- `repos/{repoSlug}/publish/{publicationId}/manifest.json`

D1 stores queryable metadata:

- `codebases`
- `snapshots`
- `chunks`
- `hyde_artifacts`
- `embedding_runs`
- `vector_records`
- `publications`
- `chunks_fts` using SQLite FTS5 for lexical search

Vectorize stores model-specific indexes:

- `cfcode-{repoSlug}-{channel}-{dim}-{runHash}`
- separate indexes for `code`, `hyde`, and optionally `summary`
- metadata contains `repo_slug`, `chunk_identity`, `file`, `start_line`, `end_line`, `content_hash`, `chunker_version`, `embedding_run_id`

The MCP Worker exposes:

- `search`
- `collection_info`
- `get_chunk`
- `suggest_queries`

## POC Chain

### POC 01: Authless Worker MCP Hello ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — throwaway Worker deployed and deleted.

- [x] `wrangler deploy` returned `https://cfcode-poc-01-authless-mcp.frosty-butterfly-d821.workers.dev/mcp`.
- [x] MCP client listed `ping` and `echo`.
- [x] `ping` returned `pong`.
- [x] `wrangler delete --name cfcode-poc-01-authless-mcp --force` succeeded.

**Proves:** A Cloudflare Worker can expose an unauthenticated remote MCP endpoint at `/mcp` with `createMcpHandler`.

**Build:**
- `cloudflare-mcp/poc/01-authless-mcp-worker/`
- one `ping` tool
- script deploys throwaway Worker, lists tools through an MCP client, then deletes the Worker

**Pass criteria:**
- `wrangler deploy` returns a workers.dev URL
- MCP client lists `ping`
- `ping` returns `pong`
- `wrangler delete --name ...` succeeds

### POC 02: R2 Artifact Bucket Smoke ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — throwaway R2 bucket and Worker deployed, verified, and deleted.

- [x] Created `cfcode-poc-02-r2-artifacts`.
- [x] Deployed `https://cfcode-poc-02-r2-artifact.frosty-butterfly-d821.workers.dev`.
- [x] PUT artifact JSON returned sha256 key metadata.
- [x] GET returned exact JSON and sha256 metadata.
- [x] DELETE removed object.
- [x] Deleted Worker and R2 bucket.

**Proves:** Worker can write/read/delete content-addressed JSON artifacts in R2.

**Pass criteria:**
- PUT chunk JSON by sha256 key
- GET returns exact JSON
- DELETE removes object

### POC 03: D1 Metadata Smoke ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — throwaway D1 database and Worker deployed, verified, and deleted.

- [x] Created D1 database `cfcode-poc-03-d1-metadata`.
- [x] Generated Worker binding config from returned database UUID.
- [x] Inserted chunk metadata by `chunk_identity`.
- [x] Queried by `chunk_identity` and `repo_slug`.
- [x] Deleted Worker and D1 database.

**Proves:** D1 can store chunk metadata and query it by repo/path/content hash.

**Pass criteria:**
- migration applies remotely
- insert/query works through Worker binding
- batch insert works

### POC 04: D1 FTS5 Smoke ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — throwaway D1 FTS5 Worker verified and deleted.

- [x] Created FTS5 virtual table in remote D1.
- [x] Seeded code chunk lexical fields.
- [x] Symbol query `handle_upload borrower_file` ranked `upload-handler` first.
- [x] Body query `mortgage FRED rates` ranked `market-rates` first.
- [x] Deleted Worker and D1 database.

**Proves:** D1 FTS5 can provide lexical candidate search for code chunks.

**Pass criteria:**
- `chunks_fts` created
- identifier query ranks expected chunk first

### POC 05: Vectorize 1536d Index Smoke ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — 3072d rejected by Cloudflare, 1536d Worker-bound Vectorize verified and deleted.

- [x] Live 3072d create attempt failed with Cloudflare API dimension limit `[32, 1536]`.
- [x] Created `cfcode-poc-05-vectorize-1536` with cosine metric.
- [x] Deployed bound Worker at `https://cfcode-poc-05-vectorize-1536.frosty-butterfly-d821.workers.dev`.
- [x] Upserted deterministic 1536d code vectors.
- [x] Query returned `chunk-upload-handler` first with score `0.99999875`.
- [x] Deleted Worker and Vectorize index.

**Proves:** A throwaway Vectorize index can be created, bound, queried, and deleted at Cloudflare Vectorize's current maximum accepted dimension.

**Finding:** A live `wrangler vectorize create --dimensions=3072 --metric=cosine` attempt failed with Cloudflare API `vectorize.index.invalid_config - Dimensions must be in range: [32, 1536]`. The Cloudflare-first path must project Google embeddings to 1536 dimensions or lower instead of matching the legacy 3072d Qdrant collection.

**Pass criteria:**
- index created with cosine metric at 1536 dimensions
- one vector upserted
- query returns it
- index deleted

### POC 06: Google Embedding Worker Binding ✅

**Status:** PASS — local commit `cde935c` — 2026-04-30 — throwaway Worker minted Google OAuth from service-account secret, embedded through Vertex, and was deleted.

- [x] Service account JSON was loaded from local credentials without printing secret material.
- [x] Worker compiled with `tsc --noEmit`.
- [x] Worker deployed as `cfcode-poc-06-google-embedding`.
- [x] `GEMINI_SERVICE_ACCOUNT_B64` was set via `wrangler secret put`.
- [x] `/health` reported `gemini-embedding-001` at 1536 dimensions.
- [x] `/embed` returned a 1536-dimensional vector with finite norm `0.6958073319671106`.
- [x] Deleted Worker.

**Proves:** Worker-side Vertex service-account OAuth can produce Vectorize-compatible embeddings without local Python.

**Pass criteria:**
- `/embed` returns `gemini-embedding-001` 1536d vector
- no OpenAI env vars required

### POC 07: Snapshot Manifest Builder ✅

**Status:** PASS — local commit `c4a2de4` — 2026-04-30 — deterministic tracked-file manifest generated for `lumae-fresh`.

- [x] Read 663 tracked files from `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`.
- [x] Manifest recorded file path, byte size, and sha256 for every tracked file.
- [x] Total snapshot payload was 26,336,809 bytes.
- [x] Rerun in the same process produced the same snapshot ID `23c63e09629087a9681963d2600c55c2`.
- [x] Wrote `cloudflare-mcp/sessions/poc-07/snapshot-manifest.json` at 91,161 bytes.

**Proves:** Local script can produce a deterministic repo snapshot manifest without indexing.

**Build:**
- `cloudflare-mcp/scripts/poc-07-snapshot-manifest.mjs`
- reads `git ls-files` from `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`
- writes `cloudflare-mcp/sessions/poc-07/snapshot-manifest.json`

**Input:** local tracked file tree only; no Qdrant, no Cloudflare resources, no embeddings.

**Pass criteria:**
- manifest lists tracked files, file hashes, byte sizes
- rerun on unchanged repo produces same snapshot ID

**Run:** `node cloudflare-mcp/scripts/poc-07-snapshot-manifest.mjs`

### POC 08: Chunk Artifact Builder ✅

**Status:** PASS — local commit `0833d17` — 2026-04-30 — embedding-agnostic chunks generated from the POC 07 snapshot manifest.

- [x] Read snapshot ID `23c63e09629087a9681963d2600c55c2`.
- [x] Selected 8 bounded source files from the snapshot manifest.
- [x] Generated 221 chunk artifacts with `chunk_identity`, `content_hash`, line spans, and text.
- [x] Chunk JSON has `embedding_agnostic: true` and no embedding values.
- [x] Rerun in the same process produced the same chunk identities.
- [x] Wrote `cloudflare-mcp/sessions/poc-08/chunk-manifest.json` with chunk identities hash `307c10b56b3b7c6560370312ae5bb6735d4e5f586da9f5bcee0e790a012cfe4a`.

**Proves:** Chunking produces stable, content-addressed artifacts independent of embeddings.

**Build:**
- `cloudflare-mcp/scripts/poc-08-chunk-artifact-builder.mjs`
- reads `cloudflare-mcp/sessions/poc-07/snapshot-manifest.json`
- writes chunk JSON artifacts under `cloudflare-mcp/sessions/poc-08/chunks/`
- writes `cloudflare-mcp/sessions/poc-08/chunk-manifest.json`

**Input:** POC 07 snapshot manifest plus local file contents for a bounded source-file sample.

**Pass criteria:**
- chunk JSON includes `chunk_identity`, `content_hash`, line span, text
- rerun reuses same identities

**Run:** `node cloudflare-mcp/scripts/poc-08-chunk-artifact-builder.mjs`

### POC 09: HyDE Artifact Builder ✅

**Status:** PASS — local commit `a70791c` — 2026-04-30 — resumable HyDE artifacts generated independently from embeddings.

- [x] Read 24 chunk artifacts from POC 08.
- [x] First run wrote 24 HyDE artifacts under `cloudflare-mcp/sessions/poc-09/hyde/`.
- [x] Second run skipped 24 existing HyDE artifacts.
- [x] HyDE artifact includes `hyde_key`, `content_hash`, `hyde_version`, `hyde_model`, and 3 questions.
- [x] HyDE artifact has `embedding_agnostic: true` and no embedding fields.
- [x] Wrote `cloudflare-mcp/sessions/poc-09/hyde-manifest.json` with HyDE keys hash `0b69afaa1e62aa19e58bf5a42c6558332a8e0a977d3f211a65a36eeafa2593a2`.

**Proves:** HyDE generation writes artifacts keyed by `content_hash + hyde_version + hyde_model`.

**Build:**
- `cloudflare-mcp/scripts/poc-09-hyde-artifact-builder.mjs`
- reads `cloudflare-mcp/sessions/poc-08/chunk-manifest.json`
- reads local chunk body artifacts from `cloudflare-mcp/sessions/poc-08/chunks/`
- writes HyDE JSON artifacts under `cloudflare-mcp/sessions/poc-09/hyde/`
- writes `cloudflare-mcp/sessions/poc-09/hyde-manifest.json`

**Input:** POC 08 chunk artifacts. This POC uses deterministic template HyDE so it proves artifact keys/resume semantics without adding live LLM variability.

**Pass criteria:**
- generated questions stored in R2/local artifacts
- rerun skips existing HyDE
- embedding model changes do not invalidate HyDE

**Run:** `node cloudflare-mcp/scripts/poc-09-hyde-artifact-builder.mjs`

### POC 10: Embedding Run Builder ✅

**Status:** PASS — local commit `7270369` — 2026-04-30 — two embedding projections generated over unchanged chunk/HyDE artifacts.

- [x] Read the same POC 08 chunk manifest and POC 09 HyDE manifest for both runs.
- [x] Wrote 768d code run `f46b2d31a0aefd809a5e05892a0ebf2d`.
- [x] Wrote 1536d HyDE run `85f6cbff932e6f849dbf35c6ab18685b`.
- [x] Each vector record includes `embedding_model`, `dimension`, `input_hash`, and `source_artifact`.
- [x] Upstream chunk identities hash and HyDE keys hash were unchanged after embedding generation.
- [x] Per-run manifests are separate and identify the active model/dimension/channel.

**Proves:** Embeddings can be regenerated for the same chunks/HyDE using a new model/dimension without changing upstream artifacts.

**Build:**
- `cloudflare-mcp/scripts/poc-10-embedding-run-builder.mjs`
- reads POC 08 chunk manifest and POC 09 HyDE manifest
- writes per-run vector JSON under `cloudflare-mcp/sessions/poc-10/runs/{embeddingRunId}/vectors/`
- writes embedding run manifests under `cloudflare-mcp/sessions/poc-10/runs/{embeddingRunId}/manifest.json`

**Input:** POC 08 chunk artifacts and POC 09 HyDE artifacts. This POC uses deterministic local vectors so it proves redoable projection semantics without provider variability.

**Pass criteria:**
- two embedding runs over same chunks produce separate manifests
- vectors include `embedding_model`, `dimension`, `input_hash`, `source_artifact`

**Run:** `node cloudflare-mcp/scripts/poc-10-embedding-run-builder.mjs`

### POC 11: Vectorize Publication ✅

**Status:** PASS — 2026-04-30 — POC 10 1536d run published to throwaway Vectorize and D1, then cleaned up.

- [x] Created throwaway Vectorize index `cfcode-poc-11-vectorize-publication` at 1536 dimensions.
- [x] Created throwaway D1 database `cfcode-poc-11-vectorize-publication`.
- [x] Deployed Worker with both Vectorize and D1 bindings.
- [x] Published 12 vectors from embedding run `85f6cbff932e6f849dbf35c6ab18685b`.
- [x] D1 `vector_records` count matched the published Vectorize IDs.
- [x] Vectorize query returned the expected vector after bounded visibility polling.
- [x] Wrote `cloudflare-mcp/sessions/poc-11/publication-manifest.json` with active HyDE index mapping.
- [x] Deleted Worker, Vectorize index, and D1 database.

**Proves:** An embedding run can publish to Vectorize and record vector IDs in D1.

**Build:**
- `cloudflare-mcp/poc/11-vectorize-publication-worker/`
- `cloudflare-mcp/scripts/poc-11-vectorize-publication.mjs`
- creates throwaway Vectorize index and D1 database
- deploys Worker with Vectorize + D1 bindings
- publishes the POC 10 1536d HyDE vector run
- writes `cloudflare-mcp/sessions/poc-11/publication-manifest.json`

**Input:** POC 10 1536d embedding run `85f6cbff932e6f849dbf35c6ab18685b`.

**Pass criteria:**
- D1 `vector_records` rows match Vectorize IDs
- publication manifest identifies active indexes

**Run:** `node cloudflare-mcp/scripts/poc-11-vectorize-publication.mjs`

### POC 12: MCP Search Over Vectorize

**Proves:** Authless MCP `search` can embed a query, search Vectorize, and hydrate snippets from D1/R2.

**Pass criteria:**
- `search` returns file, line span, snippet, score, match reasons

### POC 13: MCP Hybrid Search

**Proves:** MCP can fuse Vectorize + D1 FTS results.

**Pass criteria:**
- symbol query gets exact/FTS boost
- semantic query gets vector boost

### POC 14: Multi-Channel Search

**Proves:** Separate `code` and `hyde` indexes can be searched and RRF-merged.

**Pass criteria:**
- query hits both indexes
- merged result dedupes by `chunk_identity`

### POC 15: Active Publication Cutover

**Proves:** A codebase can switch active embedding publication atomically.

**Pass criteria:**
- D1 active publication update changes MCP results without redeploying Worker

### POC 16: Resume Interrupted Index

**Proves:** Indexing resumes after interruption without recomputing completed chunk/HyDE/embedding artifacts.

**Pass criteria:**
- kill midway
- rerun reports completed counts and finishes

### POC 17: Redo Embeddings Only

**Proves:** Changing embedding model/dimension reruns only embedding and publication stages.

**Pass criteria:**
- chunk count unchanged
- HyDE generation count zero
- new Vectorize index created

### POC 18: Per-Codebase MCP URL

**Proves:** Each codebase can have an unauthenticated MCP URL.

**Pass criteria:**
- deployed URL `/mcp` serves one configured repo
- `collection_info` identifies repo and active publication

### POC 19: Throwaway Resource Cleanup

**Proves:** Scripts can delete throwaway Workers, Vectorize indexes, D1 DBs, and R2 buckets created by POCs.

**Pass criteria:**
- cleanup manifest drives deletion
- post-cleanup list confirms no throwaway resources remain

### POC 20: Lumae Fresh End-to-End

**Proves:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh` has a public authless MCP URL with equivalent search behavior to the current local MCP.

**Pass criteria:**
- remote MCP inspector lists tools
- `search` returns relevant lumae chunks with snippets
- `collection_info` reports Cloudflare backend and active embedding run
