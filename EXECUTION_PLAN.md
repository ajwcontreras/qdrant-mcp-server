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
