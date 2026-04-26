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

## Remaining POCs — Isolation Tests

Each POC isolates ONE variable to measure its impact.

### POC 10: AI Search with Gemini embeddings (auto-chunk)

**Proves:** Does swapping from Qwen 0.6B → Gemini 1536d improve retrieval with the same auto-chunking?

**Config:** Same as POC 7 but `embedding_model: "google-ai-studio/gemini-embedding-001"`

**Isolates:** Embedding model quality (Qwen vs Gemini), everything else held constant.

**Pass criteria:**
- Instance created with Gemini embeddings
- Same 356 files uploaded
- Eval against same 240 golden queries
- Compare: POC 7 scores (Qwen auto-chunk) vs POC 10 scores (Gemini auto-chunk)

---

### POC 11: AI Search with our chunking vs auto-chunking (same embeddings)

**Proves:** Does deterministic code-aware pre-chunking beat AI Search's recursive chunking?

**Config:** `chunk: false`, Gemini embeddings, upload pre-chunked files (function/symbol boundaries)

**Isolates:** Chunking strategy, embedding model held constant (both Gemini).

**Build:**
- Pre-chunk lumae.ai using the indexer's line-based chunking (1500 chars, 200 overlap)
- Upload each chunk as individual file with `chunk: false`
- Each file named: `{rel_path}__L{start}-{end}.md`

**Pass criteria:**
- All pre-chunks uploaded
- Eval against 240 golden queries
- Compare: POC 10 scores (Gemini auto-chunk) vs POC 11 scores (Gemini our-chunk)

---

### POC 12: Two-index HyDE (code + questions, separate)

**Proves:** Does a clean separation (code embeddings in one index, HyDE question embeddings in another, merged at query time) beat the naive prepend approach?

**Config:**
- Index A: `lumae-eval-code` — pre-chunked code only, `chunk: false`, Gemini embeddings
- Index B: `lumae-eval-hyde-qs` — HyDE questions only (one file per chunk), `chunk: false`, Gemini embeddings
- Query: hit both indexes, merge results by file+chunk_id

**Isolates:** HyDE architecture (prepend vs separate indexes)

**Build:**
- Reuse chunks from POC 11 for code index
- For HyDE index: upload just the questions per chunk, with metadata mapping to chunk ID
- Query Worker or script: `Promise.all([searchCodeIndex, searchHydeIndex])` → merge via RRF

**Pass criteria:**
- Both indexes created and populated
- Merged search returns results
- Eval against 240 golden queries
- Compare: POC 8 (naive prepend) vs POC 12 (two-index) — especially debugging queries

---

### POC 13: Full comparison matrix

**Proves:** Which combination wins across all dimensions.

**Eval matrix (all AI Search, all measured):**

| # | Embedding | Chunking | HyDE | Instance |
|---|---|---|---|---|
| 7 | Qwen auto | Auto | None | lumae-eval-bare |
| 8 | Qwen auto | Auto | Prepended | lumae-eval-hyde |
| 10 | Gemini | Auto | None | lumae-eval-gemini |
| 11 | Gemini | Our chunks | None | lumae-eval-gemini-prechunk |
| 12a | Gemini | Our chunks | Separate index | lumae-eval-code + lumae-eval-hyde-qs |

**Output:**
- 5-way comparison table
- Per-type breakdown
- Clear winner with confidence
- Recommendation: which config to productionize

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
