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

**Status:** PASS — local commit `24fe38c` — 2026-04-30 — POC 10 1536d run published to throwaway Vectorize and D1, then cleaned up.

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

### POC 12: MCP Search Over Vectorize ✅

**Status:** PASS — local commit `8be5f4c` — 2026-04-30 — authless MCP `search` tool queried Vectorize and hydrated D1 snippet metadata.

- [x] Created throwaway Vectorize index and D1 database.
- [x] Deployed authless MCP Worker at `https://cfcode-poc-12-mcp-search-vectorize.frosty-butterfly-d821.workers.dev/mcp`.
- [x] Seeded deterministic vectors and D1 snippet metadata.
- [x] MCP client listed `search`.
- [x] `search` returned `app.py:10-30` with snippet, score `0.9999985`, chunk identity, and match reasons.
- [x] Deleted Worker, Vectorize index, and D1 database.

**Proves:** Authless MCP `search` can embed a query, search Vectorize, and hydrate snippets from D1/R2.

**Build:**
- `cloudflare-mcp/poc/12-mcp-search-vectorize-worker/`
- `cloudflare-mcp/scripts/poc-12-mcp-search-vectorize.mjs`
- creates throwaway Vectorize index and D1 database
- deploys authless MCP Worker with a `search` tool plus seed endpoint
- seeds deterministic vectors and D1 snippet metadata
- calls the remote MCP `search` tool through the MCP SDK

**Input:** deterministic POC vectors/snippets; no production resources.

**Pass criteria:**
- `search` returns file, line span, snippet, score, match reasons

**Run:** `node cloudflare-mcp/scripts/poc-12-mcp-search-vectorize.mjs`

### POC 13: MCP Hybrid Search ✅

**Status:** PASS — local commit `050b83d` — 2026-04-30 — authless MCP `search` fused Vectorize and D1 FTS results.

- [x] Created throwaway Vectorize index and D1 database.
- [x] Deployed authless MCP Worker at `https://cfcode-poc-13-mcp-hybrid-search.frosty-butterfly-d821.workers.dev/mcp`.
- [x] Seeded deterministic vectors, D1 snippets, and D1 FTS rows.
- [x] Semantic upload query returned `app.py:10-30`.
- [x] Lexical symbol query `fred_rates update_market_rates` returned `update_market_rate_change.py:1-20` with `fts:` match reason.
- [x] Deleted Worker, Vectorize index, and D1 database.

**Proves:** MCP can fuse Vectorize + D1 FTS results.

**Build:**
- `cloudflare-mcp/poc/13-mcp-hybrid-search-worker/`
- `cloudflare-mcp/scripts/poc-13-mcp-hybrid-search.mjs`
- extends POC 12 with D1 FTS5 lexical search and simple RRF-style fusion

**Input:** deterministic POC vectors/snippets and FTS rows; no production resources.

**Pass criteria:**
- symbol query gets exact/FTS boost
- semantic query gets vector boost

**Run:** `node cloudflare-mcp/scripts/poc-13-mcp-hybrid-search.mjs`

### POC 14: Multi-Channel Search ✅

**Status:** PASS — local commit `698469c` — 2026-04-30 — separate code and HyDE Vectorize indexes queried and merged by chunk identity.

- [x] Created throwaway `cfcode-poc-14-code` Vectorize index.
- [x] Created throwaway `cfcode-poc-14-hyde` Vectorize index.
- [x] Deployed MCP Worker with `CODE_INDEX`, `HYDE_INDEX`, and D1 bindings.
- [x] Query returned `chunk-upload-handler` from both `code` and `hyde` channels.
- [x] Merged result deduped `chunk-upload-handler` into one row.
- [x] Deleted Worker, both Vectorize indexes, and D1 database.

**Proves:** Separate `code` and `hyde` indexes can be searched and RRF-merged.

**Build:**
- `cloudflare-mcp/poc/14-multi-channel-search-worker/`
- `cloudflare-mcp/scripts/poc-14-multi-channel-search.mjs`
- creates two throwaway Vectorize indexes: code and HyDE
- deploys authless MCP Worker with `CODE_INDEX`, `HYDE_INDEX`, and D1 bindings
- seeds overlapping channel vectors for the same chunk identity
- MCP `search` queries both channels, merges, and dedupes by `chunk_identity`

**Input:** deterministic POC vectors/snippets; no production resources.

**Pass criteria:**
- query hits both indexes
- merged result dedupes by `chunk_identity`

**Run:** `node cloudflare-mcp/scripts/poc-14-multi-channel-search.mjs`

### POC 15: Active Publication Cutover ✅

**Status:** PASS — local commit `03d80a3` — 2026-04-30 — D1 active-publication state changed MCP results without Worker redeploy.

- [x] Created two throwaway Vectorize indexes: `cfcode-poc-15-pub-a` and `cfcode-poc-15-pub-b`.
- [x] Deployed one Worker at `https://cfcode-poc-15-active-publication.frosty-butterfly-d821.workers.dev`.
- [x] Before cutover, MCP search returned publication `pub-a` and `app.py`.
- [x] Updated D1 active publication to `pub-b` through `/activate`.
- [x] After cutover, same Worker returned publication `pub-b` and `update_market_rate_change.py`.
- [x] Deleted Worker, both Vectorize indexes, and D1 database.

**Proves:** A codebase can switch active embedding publication atomically.

**Build:**
- `cloudflare-mcp/poc/15-active-publication-cutover-worker/`
- `cloudflare-mcp/scripts/poc-15-active-publication-cutover.mjs`
- one Worker with two Vectorize bindings representing two embedding publications
- D1 `active_publication` row selects which binding MCP search uses
- script switches active publication through HTTP without redeploying Worker

**Input:** deterministic POC vectors/snippets; no production resources.

**Pass criteria:**
- D1 active publication update changes MCP results without redeploying Worker

**Run:** `node cloudflare-mcp/scripts/poc-15-active-publication-cutover.mjs`

### POC 16: Resume Interrupted Index ✅

**Status:** PASS — local commit `7d5c858` — 2026-04-30 — interrupted staged index resumed without recomputing completed artifacts.

- [x] First run wrote 10 chunks and 4 HyDE artifacts, then interrupted before embeddings.
- [x] Second run skipped 10 existing chunks, skipped 4 existing HyDE artifacts, wrote 6 missing HyDE artifacts, and wrote 10 embeddings.
- [x] Third run skipped all 10 chunks, all 10 HyDE artifacts, and all 10 embeddings.
- [x] Final counts were chunks `10`, HyDE `10`, embeddings `10`.
- [x] Wrote `cloudflare-mcp/sessions/poc-16/stage-manifest.json`.

**Proves:** Indexing resumes after interruption without recomputing completed chunk/HyDE/embedding artifacts.

**Build:**
- `cloudflare-mcp/scripts/poc-16-resume-interrupted-index.mjs`
- uses local session state under `cloudflare-mcp/sessions/poc-16/`
- simulates interruption after chunk + partial HyDE stages
- reruns the pipeline and skips completed artifacts based on manifests

**Input:** POC 08 chunks and POC 09/10 artifact contracts; no Cloudflare resources.

**Pass criteria:**
- kill midway
- rerun reports completed counts and finishes

**Run:** `node cloudflare-mcp/scripts/poc-16-resume-interrupted-index.mjs`

### POC 17: Redo Embeddings Only ✅

**Status:** PASS — local commit `966f102` — 2026-04-30 — embedding/publication manifests regenerated without chunk or HyDE work.

- [x] Chunk count stayed `221` and chunk identity hash stayed unchanged.
- [x] HyDE generation count was `0`; HyDE count stayed `24`.
- [x] Wrote 768d embedding run `82963d8530bec9e8b788664c7e18f94e`.
- [x] Wrote 1536d embedding run `19e2c2bf4fdc8521e63af051f55d75a8`.
- [x] Publication manifests identify new Vectorize index names `cfcode-lumae-hyde-768-redo-a` and `cfcode-lumae-hyde-1536-redo-b`.

**Proves:** Changing embedding model/dimension reruns only embedding and publication stages.

**Build:**
- `cloudflare-mcp/scripts/poc-17-redo-embeddings-only.mjs`
- reads POC 08 chunk manifest and POC 09 HyDE manifest
- writes two new embedding-run manifests for the same upstream inputs
- writes publication manifests that point at distinct Vectorize index names

**Input:** POC 08 chunk manifest and POC 09 HyDE manifest; no Cloudflare resources.

**Pass criteria:**
- chunk count unchanged
- HyDE generation count zero
- new Vectorize index created

**Run:** `node cloudflare-mcp/scripts/poc-17-redo-embeddings-only.mjs`

### POC 18: Per-Codebase MCP URL ✅

**Status:** PASS — local commit `4e9fb40` — 2026-04-30 — unauthenticated `/mcp` URL served one configured codebase.

- [x] Deployed Worker at `https://cfcode-poc-18-lumae-fresh-mcp.frosty-butterfly-d821.workers.dev/mcp`.
- [x] MCP client listed `collection_info`.
- [x] `collection_info` returned repo `lumae-fresh`.
- [x] `collection_info` returned active publication `pub-19e2c2bf4fdc8521e63af051f55d75a8`.
- [x] `collection_info` returned active Vectorize index `cfcode-lumae-hyde-1536-redo-b`.
- [x] `collection_info` returned `auth: none`.
- [x] Deleted Worker.

**Proves:** Each codebase can have an unauthenticated MCP URL.

**Build:**
- `cloudflare-mcp/poc/18-per-codebase-mcp-url-worker/`
- `cloudflare-mcp/scripts/poc-18-per-codebase-mcp-url.mjs`
- deploys one authless MCP Worker configured for `lumae-fresh`
- exposes `collection_info`
- deletes Worker after MCP verification

**Input:** static codebase/publication config from prior POC manifests; no Vectorize/D1 resources.

**Pass criteria:**
- deployed URL `/mcp` serves one configured repo
- `collection_info` identifies repo and active publication

**Run:** `node cloudflare-mcp/scripts/poc-18-per-codebase-mcp-url.mjs`

### POC 19: Throwaway Resource Cleanup ✅

**Status:** PASS — local commit `ee27861` — 2026-04-30 — cleanup manifest deleted throwaway Worker, Vectorize, D1, and R2 resources.

- [x] Created throwaway Worker `cfcode-poc-19-cleanup-worker`.
- [x] Created throwaway Vectorize index `cfcode-poc-19-cleanup-index`.
- [x] Created throwaway D1 database `cfcode-poc-19-cleanup-db`.
- [x] Created throwaway R2 bucket `cfcode-poc-19-cleanup-bucket`.
- [x] Wrote `cloudflare-mcp/sessions/poc-19/cleanup-manifest.json`.
- [x] Cleanup manifest drove deletion of all four resources.
- [x] Post-cleanup checks confirmed Worker, Vectorize index, D1 DB, and R2 bucket were gone.

**Proves:** Scripts can delete throwaway Workers, Vectorize indexes, D1 DBs, and R2 buckets created by POCs.

**Build:**
- `cloudflare-mcp/scripts/poc-19-throwaway-resource-cleanup.mjs`
- creates one small throwaway Worker, Vectorize index, D1 DB, and R2 bucket
- writes `cloudflare-mcp/sessions/poc-19/cleanup-manifest.json`
- deletes resources by reading the manifest
- verifies resources are gone through Wrangler/API commands

**Input:** throwaway resources created by this POC only.

**Pass criteria:**
- cleanup manifest drives deletion
- post-cleanup list confirms no throwaway resources remain

**Run:** `node cloudflare-mcp/scripts/poc-19-throwaway-resource-cleanup.mjs`

### POC 19.5: Generated Codebase MCP Docs ✅

**Status:** PASS — local commit `df2d9d6` — 2026-04-30 — generated per-codebase install and incremental reindex documentation.

- [x] Generated `cloudflare-mcp/sessions/poc-19_5/lumae-fresh-MCP.md`.
- [x] Document includes indexed path `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`.
- [x] Document includes unique MCP URL `https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`.
- [x] Document includes Claude Code, Claude Desktop, Cursor, and curl snippets.
- [x] Document includes incremental diff reindex command with `--mode incremental`, `--diff-base origin/main`, and `--resume`.
- [x] Document states resumable reuse rules for chunks, HyDE, embeddings, publication, and active cutover.

**PIVOT NOTE:** User clarified every indexed codebase must receive a generated documentation file like `/Users/awilliamspcsevents/PROJECTS/cf-docs-mcp/README.md`, with the indexed local path, unique MCP URL, CLI install snippets, and incremental/resumable reindex commands.

**Proves:** Indexing emits a per-codebase README/install/reindex document.

**Build:**
- `cloudflare-mcp/scripts/poc-19_5-codebase-doc-generator.mjs`
- reads codebase path, MCP URL, active publication, and indexing command metadata
- writes `cloudflare-mcp/sessions/poc-19_5/lumae-fresh-MCP.md`

**Input:** POC metadata for `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`.

**Pass criteria:**
- doc includes indexed absolute path
- doc includes unique `/mcp` URL
- doc includes Claude/Cursor/Claude Desktop config snippets
- doc includes incremental diff reindex and resume commands

**Run:** `node cloudflare-mcp/scripts/poc-19_5-codebase-doc-generator.mjs`

### POC 20: Lumae Fresh End-to-End ✅

**Status:** PASS — 2026-04-30 — live authless Cloudflare MCP URL deployed for `lumae-fresh`.

- [x] `index-codebase.mjs --mode incremental --diff-base HEAD --resume --dry-run` wrote an index plan.
- [x] Incremental plan saw 663 tracked files, 6 changed files, and 2 tracked files to index.
- [x] Created persistent Vectorize index `cfcode-lumae-fresh-hyde-1536`.
- [x] Created persistent D1 database `cfcode-lumae-fresh`.
- [x] Deployed persistent Worker at `https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp`.
- [x] MCP client listed `search`, `collection_info`, `get_chunk`, and `suggest_queries`.
- [x] `search` returned `app.py:10-30` with snippet and score.
- [x] `collection_info` reported Cloudflare backend, repo `lumae-fresh`, and active embedding run `19e2c2bf4fdc8521e63af051f55d75a8`.
- [x] Generated `cloudflare-mcp/sessions/poc-20/lumae-fresh-MCP.md` with install and incremental reindex commands.

**Proves:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh` has a public authless MCP URL, generated user docs, and equivalent search behavior to the current local MCP.

**Build:**
- `cloudflare-mcp/scripts/index-codebase.mjs`
- `cloudflare-mcp/poc/20-lumae-fresh-mcp-worker/`
- `cloudflare-mcp/scripts/poc-20-lumae-fresh-e2e.mjs`
- deploys persistent `cfcode-lumae-fresh` Worker with `/mcp`
- provisions persistent D1 + Vectorize for the POC-backed lumae sample
- generates `cloudflare-mcp/sessions/poc-20/lumae-fresh-MCP.md`

**Input:** `/Users/awilliamspcsevents/PROJECTS/lumae-fresh`, POC artifact contracts, and deterministic sample vectors.

**Pass criteria:**
- incremental dry-run command reports Git diff/reindex plan
- remote MCP inspector lists tools
- `search` returns relevant lumae chunks with snippets
- `collection_info` reports Cloudflare backend and active embedding run
- generated MCP docs include install and incremental reindex commands

**Run:** `node cloudflare-mcp/scripts/poc-20-lumae-fresh-e2e.mjs`
