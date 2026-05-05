#!/usr/bin/env python3
"""
POC 12b: Eval — BM25F multi-field vs flat FTS5 vs AI Search

All three use same Vectorize AST index (Gemini 768d) + bge-reranker-base.
Only difference: D1 FTS5 schema (BM25F weighted fields vs flat single column).
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

VECTORIZE_INDEX = "lumae-eval-ast"  # same for both

# BM25F D1 (weighted multi-field)
BM25F_D1_ID = "871b0d47-00fc-44ca-b4c4-bf5847e34d42"

# Flat D1 (baseline from POC 11)
FLAT_D1_ID = "71b99e5f-817e-42f6-b96b-540e2cd9612f"

AISEARCH_INSTANCE = "lumae-eval-bare"

QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_bm25f.json"

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
LIMIT = 10
RRF_K = 60
RERANK_CANDIDATES = 30


def cf_api(method, path, data=None, timeout=30):
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
    result = cf_api("POST", "ai/run/@cf/baai/bge-reranker-base", {
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


def fts_query_flat(query_text, d1_id, limit):
    """Flat FTS5 query (baseline)."""
    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_q = " OR ".join(terms[:5]) if terms else query_text
    result = cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "SELECT c.id, c.file, c.start_line, c.end_line, c.content, rank FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
        "params": [fts_q, limit],
    })
    rows = []
    if result.get("success"):
        for r in result.get("result", [{}]):
            rows.extend(r.get("results", []))
    return rows


def fts_query_bm25f(query_text, d1_id, limit):
    """BM25F weighted multi-field query."""
    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_q = " OR ".join(terms[:5]) if terms else query_text
    result = cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": """SELECT c.id, c.file, c.start_line, c.end_line, c.body as content,
                  bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0) as rank
                  FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid
                  WHERE chunks_fts MATCH ?
                  ORDER BY bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0) LIMIT ?""",
        "params": [fts_q, limit],
    })
    rows = []
    if result.get("success"):
        for r in result.get("result", [{}]):
            rows.extend(r.get("results", []))
    return rows


def search_reranked(query_text, limit, d1_id, fts_fn):
    """Generic Vec+D1+Reranker search."""
    query_emb = embed_query(query_text)

    vec_result = cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/query", {
        "vector": query_emb, "topK": RERANK_CANDIDATES, "returnMetadata": "all",
    })
    vec_matches = vec_result.get("result", {}).get("matches", []) if vec_result.get("success") else []

    fts_rows = fts_fn(query_text, d1_id, RERANK_CANDIDATES)

    # RRF merge
    candidates = {}
    for rank, m in enumerate(vec_matches):
        f = m.get("metadata", {}).get("file", "")
        start = m.get("metadata", {}).get("start", 0)
        key = f"{f}:{start}"
        if key not in candidates:
            candidates[key] = {"file": f, "start_line": start, "end_line": m["metadata"].get("end"), "content": ""}
        candidates[key]["rrf_score"] = candidates[key].get("rrf_score", 0) + 1.0 / (RRF_K + rank + 1)

    for rank, row in enumerate(fts_rows):
        f = row.get("file", "")
        start = row.get("start_line", 0)
        key = f"{f}:{start}"
        if key not in candidates:
            candidates[key] = {"file": f, "start_line": start, "end_line": row.get("end_line"), "content": row.get("content", "")}
        elif not candidates[key].get("content"):
            candidates[key]["content"] = row.get("content", "")
        candidates[key]["rrf_score"] = candidates[key].get("rrf_score", 0) + 1.0 / (RRF_K + rank + 1)

    ranked = sorted(candidates.values(), key=lambda x: -x.get("rrf_score", 0))[:RERANK_CANDIDATES]

    # Fetch missing content
    for c in ranked:
        if not c.get("content"):
            res = cf_api("POST", f"d1/database/{d1_id}/query", {
                "sql": f"SELECT {'body' if d1_id == BM25F_D1_ID else 'content'} as content FROM chunks WHERE file = ? AND start_line = ? LIMIT 1",
                "params": [c["file"], c["start_line"]],
            })
            if res.get("success"):
                rows = res.get("result", [{}])[0].get("results", [])
                if rows:
                    c["content"] = rows[0].get("content", "")

    reranked = rerank(query_text, ranked)
    return [{"file": c["file"], "score": c.get("rerank_score", c.get("rrf_score", 0)),
             "start_line": c.get("start_line"), "end_line": c.get("end_line")}
            for c in reranked[:limit]]


def search_aisearch(query_text, limit):
    url = f"{CF_API}/ai-search/instances/{AISEARCH_INSTANCE}/search"
    payload = json.dumps({
        "messages": [{"role": "user", "content": query_text}],
        "ai_search_options": {"retrieval": {"retrieval_type": "hybrid", "fusion_method": "rrf", "max_num_results": limit}},
    }).encode()
    req = urllib.request.Request(url, data=payload, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return [{"file": c.get("item", {}).get("key", ""), "score": c.get("score", 0)}
            for c in result.get("result", {}).get("chunks", [])]


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


def color(v):
    if v >= 0.8: return f"\033[92m{v:.3f}\033[0m"
    if v >= 0.5: return f"\033[93m{v:.3f}\033[0m"
    return f"\033[91m{v:.3f}\033[0m"


def run():
    print("POC 12b: Eval — BM25F vs Flat FTS5 vs AI Search\n")

    global CF_TOKEN
    if not CF_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                           capture_output=True, text=True)
        CF_TOKEN = r.stdout.strip()
        HEADERS["Authorization"] = f"Bearer {CF_TOKEN}"

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries\n")

    variants = {"bm25f": [], "flat": [], "aisearch": []}
    per_query = []

    for i, q in enumerate(queries):
        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        pq = {"id": q.get("id"), "query": q["query"], "type": q.get("type")}

        # BM25F + Reranker
        try:
            vr = search_reranked(q["query"], LIMIT, BM25F_D1_ID, fts_query_bm25f)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["bm25f"].append(sc)
            pq["bm25f"] = sc
        except Exception as e:
            print(f"    BM25F error {i}: {e}")
            variants["bm25f"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            pq["bm25f"] = variants["bm25f"][-1]

        # Flat + Reranker
        try:
            vr = search_reranked(q["query"], LIMIT, FLAT_D1_ID, fts_query_flat)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["flat"].append(sc)
            pq["flat"] = sc
        except Exception as e:
            print(f"    Flat error {i}: {e}")
            variants["flat"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            pq["flat"] = variants["flat"][-1]

        # AI Search
        try:
            ar = search_aisearch(q["query"], LIMIT)
            sc = score_query(ar, q.get("relevant", []), LIMIT)
            variants["aisearch"].append(sc)
            pq["aisearch"] = sc
        except Exception as e:
            print(f"    AIS error {i}: {e}")
            variants["aisearch"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            pq["aisearch"] = variants["aisearch"][-1]

        per_query.append(pq)

    # Aggregate
    def mean(scores, key):
        return sum(s[key] for s in scores) / len(scores) if scores else 0

    metrics = ["recall_at_5", "recall_at_10", "mrr", "ndcg_at_10"]
    aggs = {}
    for v in variants:
        aggs[v] = {m: mean(variants[v], m) for m in metrics}

    print(f"\n{'='*80}")
    print(f"  BM25F vs Flat FTS5 vs AI Search  ({len(queries)} queries, top-{LIMIT})")
    print(f"{'='*80}\n")

    print(f"  {'Metric':<16} {'BM25F':>10} {'Flat':>10} {'AI Search':>10} {'BM25F-Flat Δ':>12}")
    print(f"  {'-'*58}")

    for m in metrics:
        b = aggs["bm25f"][m]
        f = aggs["flat"][m]
        a = aggs["aisearch"][m]
        delta = b - f
        print(f"  {m:<16} {color(b):>19} {color(f):>19} {color(a):>19} {delta:>+12.3f}")

    # Per-type MRR
    print(f"\n  Per-type MRR:")
    types = {}
    for pq in per_query:
        t = pq.get("type", "?")
        if t not in types: types[t] = {v: [] for v in variants}
        for v in variants:
            types[t][v].append(pq.get(v, {}).get("mrr", 0))
    print(f"  {'Type':<20} {'BM25F':>10} {'Flat':>10} {'AI Search':>10} {'n':>6}")
    print(f"  {'-'*60}")
    for t in sorted(types):
        bv = sum(types[t]["bm25f"]) / len(types[t]["bm25f"])
        fv = sum(types[t]["flat"]) / len(types[t]["flat"])
        av = sum(types[t]["aisearch"]) / len(types[t]["aisearch"])
        print(f"  {t:<20} {bv:>10.3f} {fv:>10.3f} {av:>10.3f} {len(types[t]['bm25f']):>6}")

    # Verdict
    print(f"\n{'='*80}")
    bw, fw = 0, 0
    for m in metrics:
        if aggs["bm25f"][m] > aggs["flat"][m] + 0.005: bw += 1
        elif aggs["flat"][m] > aggs["bm25f"][m] + 0.005: fw += 1
    if bw > fw:
        print(f"  VERDICT: BM25F wins {bw}/{len(metrics)} metrics over Flat FTS5")
    elif fw > bw:
        print(f"  VERDICT: Flat FTS5 wins {fw}/{len(metrics)} metrics over BM25F")
    else:
        print(f"  VERDICT: Tie ({bw} vs {fw})")
    print(f"{'='*80}")

    output = {"query_count": len(queries), "limit": LIMIT, "variants": aggs, "per_query": per_query}
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
