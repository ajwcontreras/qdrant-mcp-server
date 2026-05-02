# Research Paper Survey — Retrieval Quality for Code Search
# Generated 2026-05-02 by 4 Codex sub-agents in parallel categories
# 29 papers total across 4 research areas

## 1. Code-Specific Embedding & Retrieval (8 papers)

| Paper | Year | Venue | Key Insight | Relevance to cfcode |
|-------|------|-------|-------------|---------------------|
| CodeSearchNet Challenge | 2019 | arXiv | 6M-function, 6-language corpus with expert labels exposes semantic matching gaps | Shows why index quality + query hardening is needed when query wording drifts |
| CoSQA | 2021 | ACL-IJCNLP | Real web-style NL queries + contrastive learning significantly improve query-code matching | Supports adding real user-like query corpora before indexing |
| CodeXGLUE | 2021 | arXiv | Unified benchmark exposing task transfer gaps across code understanding + retrieval | Multi-task evaluation reduces false confidence from one narrow benchmark |
| Impact of Multiple Source Code Representations | 2024 | JSS | AST+CFG/PDG multi-view models improve code tasks vs AST-only | Strong path for lightweight AST+CFG feature channels alongside token embeddings |
| Language Agnostic Code Embeddings | 2024 | NAACL | Code embeddings have separable language-specific and agnostic components; removing artifacts improves MRR | Vector normalization strategies for cross-language/mixed-tech repos |
| CoRNStack | 2025 | ICLR | Large contrastive code corpus with hard negatives improves retrieval and reranking quality | Move from generic to mined hard negatives in training/reranking |
| cAST: Structural Chunking via AST | 2025 | arXiv | AST-aware split-then-merge chunking preserves semantically coherent code units | Directly applicable to chunking policy — function/class-level boundaries |
| CoIR: Comprehensive Code IR Benchmark | 2024 | arXiv | SOTA systems still face significant difficulty across many retrieval settings | Multi-task evaluation and regression checks by domain/query type |

## 2. Query Understanding & HyDE Improvements (8 papers)

| Paper | Year | Venue | Key Insight | Relevance to cfcode |
|-------|------|-------|-------------|---------------------|
| Query2doc | 2023 | EMNLP | LLM-generated pseudo-documents appended to query boost sparse+dense retrieval | Reduces NL query drift by enriching queries before vector search |
| InPars-v2 | 2023 | arXiv | Synthetic query-document pairs from open LLMs + reranker build stronger retrievers | Build repo-specific retrievers without expensive labeled data |
| Rewriting the Code (GAR-style) | 2024 | ACL | Code-style normalization of generated snippets before matching improves retrieval | Generated code snippets often mismatch repository style — normalize before matching |
| PERC: Plan-As-Query | 2024 | COLING | Extracts code into algorithmic plans (pseudocode) and retrieves via plan matching | Query code by intent/logic rather than brittle keyword overlap |
| Intent-Enhanced Feedback for Code Search | 2025 | IST | Intent-aware feedback from top results expands and re-ranks queries | Pseudo-relevance feedback applied to code search — narrows intent gaps |
| IRCoT | 2023 | ACL | Interleaves retrieval with CoT reasoning at each step | Blueprint for multi-hop code queries (find call sites → trace error path) |
| DMQR-RAG | 2024 | arXiv | Multiple query rewrites at different granularities, adaptively fused | Covers different interpretations of short code questions |
| Zero-shot LLM Re-Ranker with Risk Minimization | 2024 | EMNLP | Risk-aware optimization improves zero-shot LLM reranking stability | LLM-based reranker after vector retrieval to reduce noisy chunks |

## 3. Re-Ranking & Result Fusion (5 papers)

| Paper | Year | Venue | Key Insight | Relevance to cfcode |
|-------|------|-------|-------------|---------------------|
| Reciprocal Rank Fusion (original) | 2009 | SIGIR | Rank-based reciprocal scoring robust to score-scale mismatch across channels | Direct match for dense+keyword hybrid fusion without score calibration |
| MMMORRF | 2025 | SIGIR | Modality-aware weighted RRF with adaptive components for differing channel reliability | Blueprint for learned/adaptive fusion weights across retrieval channels |
| LLMs as Re-Ranking Agents (RankGPT) | 2023 | EMNLP | LLM passage ranking matches or exceeds supervised rerankers in zero-shot | LLM-based reranking layer for noisy/short queries without labeled data |
| ColBERTv2 | 2022 | NAACL | Token-level late interaction with compression — high relevance signals, low overhead | Higher-fidelity reranking for code where identifiers/field names matter beyond vectors |
| MMR (Maximal Marginal Relevance) | 1998 | SIGIR | Balances relevance against novelty — reduces redundant top results | Avoids returning near-duplicate code snippets or generated variants |

## 4. Hybrid & Sparse-Dense Retrieval (8 papers)

| Paper | Year | Venue | Key Insight | Relevance to cfcode |
|-------|------|-------|-------------|---------------------|
| SparseEmbed | 2023 | SIGIR | Learned sparse retriever injects contextual embeddings into lexical term weighting | Sparse channel retaining exact token matches (API names, symbols) + semantic understanding |
| SPLADE-v3 | 2024 | arXiv | Upgraded SPLADE pipeline improving sparse ranking over BM25 + dense baselines | Strengthens lexical channel for code identifiers and exact phrases |
| SPLATE | 2024 | SIGIR | Adapts ColBERT token-level late interaction into sparse candidate-generation | Bridge from ColBERT token-matching to efficient sparse-index serving |
| Efficient Inverted Indexes for Learned Sparse | 2024 | SIGIR | Inverted-index organization specialized for learned sparse vectors | Production index layer for learned-sparse embeddings at scale |
| ColBERT-serve | 2025 | ECIR | Memory-mapped serving for ColBERT with hybrid scoring + multi-stage pruning | Reusable architecture for token-level late-interaction at production scale |
| DAT: Dynamic Alpha Tuning | 2025 | arXiv | Per-query weighting between sparse+BM25 and dense via effectiveness-aware normalization | Avoids brittle fixed fusion weights — identifier-rich vs intent-rich queries |
| SPLADE-Code (Learned Sparse Retrieval for Code) | 2026 | arXiv | Learned expansion tokens bridge lexical and semantic mismatch in code retrieval | Closest match to cfcode's problem: code search needing both semantic drift coverage and exact lexical matching |
| UniCoR: Modality Collaboration for Hybrid Code Retrieval | 2026 | ICSE | Studies hybrid code retrieval fusion inefficiencies, proposes modality collaboration for cross-language | Mixed-language repos + NL+code queries need robust hybrid fusion strategies |

## Top 5 Most Actionable for cfcode

1. **SPLADE-Code (2026)** — Learned sparse for code. Most directly applicable to our exact problem.
2. **cAST (2025)** — AST-aware chunking. Fix our current truncation-at-4KB approach.
3. **RRF (2009) + MMMORRF (2025)** — Dual-channel fusion without score calibration. Already have code+hyde vectors.
4. **LLMs as Re-Ranking Agents / RankGPT (2023)** — Zero-shot LLM reranking. Could add as post-retrieval filter.
5. **DAT (2025)** — Dynamic per-query weighting. Fix config-file-vs-implementation ranking problems.
