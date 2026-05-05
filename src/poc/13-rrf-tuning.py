#!/usr/bin/env python3
"""
POC 13: RRF weight tuning grid search

Grid search over:
  - k ∈ {5, 10, 20, 30, 60}
  - BM25 weight ∈ {0.5, 0.8, 1.0, 1.5, 2.0}
  - Vector weight ∈ {0.5, 0.8, 1.0, 1.5, 2.0}

Uses cached search results from POC 12b to avoid re-querying APIs.
If no cache, runs live against existing AST Vectorize + BM25F D1 + reranker.

Also tests per-query-type routing: symbol queries bias BM25, architectural bias vector.
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import base64
import json
import math
import os
import subprocess
import time
import urllib.request
from pathlib import Path

CF_ACCOUNT = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
GW_NAME = "code-search"
GCP_PROJECT = "evrylo"
EMBED_MODEL = "text-embedding-004"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")

VECTORIZE_INDEX = "lumae-eval-ast"
D1_ID = "871b0d47-00fc-44ca-b4c4-bf5847e34d42"  # BM25F

QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
CACHE_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_rrf_cache.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_rrf_tuning.json"

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
LIMIT = 10
RERANK_CANDIDATES = 30


def cf_api_call(method, path, data=None, timeout=30):
    url = f"{CF_API}/{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": (e.read().decode() if e.fp else "")[:300]}


def embed_query(text):
    with open(SA_PATH) as f:
        sa = json.load(f)
    sa["region"] = "us-central1"
    sa_b64 = base64.b64encode(json.dumps(sa).encode()).decode()
    url = (f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT}/{GW_NAME}"
           f"/google-vertex-ai/v1/projects/{GCP_PROJECT}/locations/us-central1"
           f"/publishers/google/models/{EMBED_MODEL}:predict")
    payload = json.dumps({"instances": [{"content": text[:2048]}]}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "User-Agent": "qdrant-mcp-eval/1.0",
        "Authorization": f"Bearer {sa_b64}",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    return result["predictions"][0]["embeddings"]["values"]


def rerank(query, candidates):
    if not candidates:
        return candidates
    contexts = [{"text": c.get("content", c.get("file", ""))[:500]} for c in candidates]
    result = cf_api_call("POST", "ai/run/@cf/baai/bge-reranker-base", {
        "query": query, "contexts": contexts,
    }, timeout=15)
    if not result.get("success"):
        return candidates
    scores = result.get("result", {}).get("response", [])
    for s in scores:
        idx = s.get("id", 0)
        if idx < len(candidates):
            candidates[idx]["rerank_score"] = s.get("score", 0)
    candidates.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
    return candidates


def fetch_raw_results(query_text):
    """Fetch raw ranked lists from Vectorize and D1 (before RRF merge)."""
    query_emb = embed_query(query_text)

    vec_result = cf_api_call("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/query", {
        "vector": query_emb, "topK": RERANK_CANDIDATES, "returnMetadata": "all",
    })
    vec_matches = []
    if vec_result.get("success"):
        for m in vec_result.get("result", {}).get("matches", []):
            vec_matches.append({
                "file": m.get("metadata", {}).get("file", ""),
                "start": m.get("metadata", {}).get("start", 0),
                "end": m.get("metadata", {}).get("end"),
                "score": m.get("score", 0),
            })

    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_q = " OR ".join(terms[:5]) if terms else query_text
    fts_result = cf_api_call("POST", f"d1/database/{D1_ID}/query", {
        "sql": """SELECT c.id, c.file, c.start_line, c.end_line, c.body as content,
                  bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0) as rank
                  FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid
                  WHERE chunks_fts MATCH ?
                  ORDER BY bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0) LIMIT ?""",
        "params": [fts_q, RERANK_CANDIDATES],
    })
    fts_rows = []
    if fts_result.get("success"):
        for r in fts_result.get("result", [{}]):
            for row in r.get("results", []):
                fts_rows.append({
                    "file": row.get("file", ""),
                    "start": row.get("start_line", 0),
                    "end": row.get("end_line"),
                    "content": row.get("content", ""),
                    "rank": row.get("rank", 0),
                })

    return {"vec": vec_matches, "fts": fts_rows}


def rrf_merge_and_rerank(query_text, raw, k, vec_weight, bm25_weight):
    """Merge with parameterized RRF, then rerank."""
    candidates = {}

    for rank, m in enumerate(raw["vec"]):
        key = f"{m['file']}:{m['start']}"
        if key not in candidates:
            candidates[key] = {"file": m["file"], "start_line": m["start"], "end_line": m.get("end"), "content": ""}
        candidates[key]["rrf_score"] = candidates[key].get("rrf_score", 0) + vec_weight / (k + rank + 1)

    for rank, row in enumerate(raw["fts"]):
        key = f"{row['file']}:{row['start']}"
        if key not in candidates:
            candidates[key] = {"file": row["file"], "start_line": row["start"], "end_line": row.get("end"), "content": row.get("content", "")}
        elif not candidates[key].get("content"):
            candidates[key]["content"] = row.get("content", "")
        candidates[key]["rrf_score"] = candidates[key].get("rrf_score", 0) + bm25_weight / (k + rank + 1)

    ranked = sorted(candidates.values(), key=lambda x: -x.get("rrf_score", 0))[:RERANK_CANDIDATES]

    # Fetch missing content
    for c in ranked:
        if not c.get("content"):
            res = cf_api_call("POST", f"d1/database/{D1_ID}/query", {
                "sql": "SELECT body as content FROM chunks WHERE file = ? AND start_line = ? LIMIT 1",
                "params": [c["file"], c["start_line"]],
            })
            if res.get("success"):
                rows = res.get("result", [{}])[0].get("results", [])
                if rows:
                    c["content"] = rows[0].get("content", "")

    reranked = rerank(query_text, ranked)
    return [{"file": c["file"], "score": c.get("rerank_score", c.get("rrf_score", 0)),
             "start_line": c.get("start_line"), "end_line": c.get("end_line")}
            for c in reranked[:LIMIT]]


def overlaps(result, relevant):
    rf, gf = result.get("file", ""), relevant.get("file", "")
    if rf == gf: return True
    if rf.endswith(gf) or gf.endswith(rf): return True
    if os.path.basename(rf) == os.path.basename(gf): return True
    return False


def score_query(results, relevant_items, k):
    top = results[:k]
    found_at = []
    for rank, r in enumerate(top):
        for rel in relevant_items:
            if overlaps(r, rel):
                found_at.append(rank + 1)
                break
    recall5 = 1.0 if any(r <= 5 for r in found_at) else 0.0
    recall10 = 1.0 if found_at else 0.0
    mrr = 1.0 / found_at[0] if found_at else 0.0
    grades = []
    used = set()
    for r in top:
        matched = False
        for i, rel in enumerate(relevant_items):
            if i not in used and overlaps(r, rel):
                grades.append(int(rel.get("grade", 1)))
                used.add(i)
                matched = True
                break
        if not matched:
            grades.append(0)
    dcg = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(grades))
    ideal = sorted([int(r.get("grade", 1)) for r in relevant_items], reverse=True)[:k]
    idcg = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(ideal))
    return {"recall_at_5": recall5, "recall_at_10": recall10, "mrr": mrr, "ndcg_at_10": dcg / idcg if idcg else 0}


def run():
    print("POC 13: RRF weight tuning grid search\n")

    global CF_TOKEN
    if not CF_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                           capture_output=True, text=True)
        CF_TOKEN = r.stdout.strip()
        HEADERS["Authorization"] = f"Bearer {CF_TOKEN}"

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries")

    # ── Phase 1: Fetch and cache raw results ──
    if CACHE_PATH.exists():
        print(f"  Loading cached raw results from {CACHE_PATH.name}")
        cache = json.loads(CACHE_PATH.read_text())
    else:
        print(f"  Fetching raw results (Vectorize + D1)...")
        cache = {}
        for i, q in enumerate(queries):
            if (i + 1) % 20 == 0:
                print(f"    [{i + 1}/{len(queries)}]...")
            try:
                raw = fetch_raw_results(q["query"])
                cache[str(i)] = raw
            except Exception as e:
                print(f"    Error {i}: {e}")
                cache[str(i)] = {"vec": [], "fts": []}
        CACHE_PATH.write_text(json.dumps(cache) + "\n")
        print(f"  Cached to {CACHE_PATH.name}")

    # ── Phase 2: Grid search (offline, uses cache + reranker) ──
    k_values = [5, 10, 20, 30, 60]
    weight_combos = [
        (1.0, 0.5),   # vec-heavy
        (1.0, 0.8),
        (1.0, 1.0),   # equal (baseline)
        (1.0, 1.5),   # bm25-heavy
        (1.0, 2.0),   # bm25-dominant
        (0.5, 1.0),   # bm25-only-ish
        (1.5, 1.0),   # vec-heavy
        (2.0, 1.0),   # vec-dominant
    ]

    print(f"\n  Grid: {len(k_values)} k × {len(weight_combos)} weight combos = {len(k_values) * len(weight_combos)} configs")
    print(f"  Each config: 240 queries × reranker call\n")

    best_mrr = 0
    best_config = None
    all_results = []

    for k in k_values:
        for vec_w, bm25_w in weight_combos:
            scores = []
            for i, q in enumerate(queries):
                raw = cache.get(str(i), {"vec": [], "fts": []})
                try:
                    results = rrf_merge_and_rerank(q["query"], raw, k, vec_w, bm25_w)
                    sc = score_query(results, q.get("relevant", []), LIMIT)
                    scores.append(sc)
                except Exception:
                    scores.append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})

            avg_mrr = sum(s["mrr"] for s in scores) / len(scores)
            avg_r5 = sum(s["recall_at_5"] for s in scores) / len(scores)
            avg_r10 = sum(s["recall_at_10"] for s in scores) / len(scores)
            avg_ndcg = sum(s["ndcg_at_10"] for s in scores) / len(scores)

            config = {"k": k, "vec_w": vec_w, "bm25_w": bm25_w,
                       "mrr": avg_mrr, "recall_at_5": avg_r5, "recall_at_10": avg_r10, "ndcg_at_10": avg_ndcg}
            all_results.append(config)

            if avg_mrr > best_mrr:
                best_mrr = avg_mrr
                best_config = config

            print(f"    k={k:>2} vec={vec_w:.1f} bm25={bm25_w:.1f}  MRR={avg_mrr:.3f}  R@5={avg_r5:.3f}  R@10={avg_r10:.3f}  nDCG={avg_ndcg:.3f}")

    # ── Phase 3: Query-type routing test ──
    print(f"\n  Testing query-type routing with best k={best_config['k']}...")

    # Find best weights per type
    type_queries = {}
    for i, q in enumerate(queries):
        t = q.get("type", "?")
        if t not in type_queries:
            type_queries[t] = []
        type_queries[t].append((i, q))

    type_best = {}
    for qtype, qs in type_queries.items():
        best_type_mrr = 0
        best_type_weights = (1.0, 1.0)
        for vec_w, bm25_w in weight_combos:
            type_scores = []
            for i, q in qs:
                raw = cache.get(str(i), {"vec": [], "fts": []})
                try:
                    results = rrf_merge_and_rerank(q["query"], raw, best_config["k"], vec_w, bm25_w)
                    sc = score_query(results, q.get("relevant", []), LIMIT)
                    type_scores.append(sc)
                except Exception:
                    type_scores.append({"mrr": 0})
            avg = sum(s["mrr"] for s in type_scores) / len(type_scores)
            if avg > best_type_mrr:
                best_type_mrr = avg
                best_type_weights = (vec_w, bm25_w)
        type_best[qtype] = {"vec_w": best_type_weights[0], "bm25_w": best_type_weights[1], "mrr": best_type_mrr}

    print(f"\n  Per-type optimal weights (k={best_config['k']}):")
    print(f"  {'Type':<20} {'Vec W':>8} {'BM25 W':>8} {'MRR':>8}")
    print(f"  {'-'*48}")
    for t in sorted(type_best):
        tb = type_best[t]
        print(f"  {t:<20} {tb['vec_w']:>8.1f} {tb['bm25_w']:>8.1f} {tb['mrr']:>8.3f}")

    # Compute routed MRR (each query uses its type's best weights)
    routed_scores = []
    for i, q in enumerate(queries):
        t = q.get("type", "?")
        tw = type_best.get(t, {"vec_w": 1.0, "bm25_w": 1.0})
        raw = cache.get(str(i), {"vec": [], "fts": []})
        try:
            results = rrf_merge_and_rerank(q["query"], raw, best_config["k"], tw["vec_w"], tw["bm25_w"])
            sc = score_query(results, q.get("relevant", []), LIMIT)
            routed_scores.append(sc)
        except Exception:
            routed_scores.append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})

    routed_mrr = sum(s["mrr"] for s in routed_scores) / len(routed_scores)
    routed_r10 = sum(s["recall_at_10"] for s in routed_scores) / len(routed_scores)

    # ── Summary ──
    baseline = {"mrr": 0.769, "recall_at_10": 0.904}  # POC 11b result

    print(f"\n{'='*80}")
    print(f"  RRF Tuning Results")
    print(f"{'='*80}\n")
    print(f"  Baseline (k=60, equal weights):  MRR={baseline['mrr']:.3f}  R@10={baseline['recall_at_10']:.3f}")
    print(f"  Best uniform config:             MRR={best_config['mrr']:.3f}  R@10={best_config['recall_at_10']:.3f}")
    print(f"    k={best_config['k']}  vec_w={best_config['vec_w']:.1f}  bm25_w={best_config['bm25_w']:.1f}")
    print(f"  Query-type routed:               MRR={routed_mrr:.3f}  R@10={routed_r10:.3f}")
    print(f"\n  Δ uniform:  MRR {best_config['mrr'] - baseline['mrr']:+.3f}")
    print(f"  Δ routed:   MRR {routed_mrr - baseline['mrr']:+.3f}")
    print(f"{'='*80}")

    output = {
        "baseline": baseline,
        "best_uniform": best_config,
        "routed_mrr": routed_mrr,
        "routed_recall_at_10": routed_r10,
        "type_weights": type_best,
        "grid_results": all_results,
    }
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(f"\n  Saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
