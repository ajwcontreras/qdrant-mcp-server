#!/usr/bin/env python3
"""
POC 10c: Eval — Vectorize+D1 WITH reranker vs AI Search native

Same as 10b but adds bge-reranker-base cross-encoder after RRF merge.
Tests whether reranking closes the MRR gap (0.476 → target 0.65+).
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
import sys
import time
import urllib.request
from pathlib import Path

CF_ACCOUNT = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
GW_NAME = "code-search"
GCP_PROJECT = "evrylo"
EMBED_MODEL = "text-embedding-004"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
VECTORIZE_INDEX = "lumae-eval-gemini-vec"
D1_ID = "8dc8a00f-6f35-4687-847b-80f64f414ba6"
AISEARCH_INSTANCE = "lumae-eval-bare"

QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_reranked.json"

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
LIMIT = 10
RRF_K = 60
RERANK_CANDIDATES = 30  # fetch more, rerank, return top 10


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


def rerank(query: str, candidates: list[dict]) -> list[dict]:
    """Rerank candidates using bge-reranker-base via Workers AI."""
    if not candidates:
        return candidates

    # Build contexts from chunk content (fetch from D1 if needed)
    contexts = []
    for c in candidates:
        # Use whatever text we have — file path + chunk content
        text = c.get("content", c.get("file", ""))
        contexts.append({"text": text[:500]})  # reranker has 512 token limit

    result = cf_api("POST", "ai/run/@cf/baai/bge-reranker-base", {
        "query": query,
        "contexts": contexts,
    }, timeout=15)

    if not result.get("success"):
        return candidates  # fallback to original order

    scores = result.get("result", {}).get("response", [])
    for s in scores:
        idx = s.get("id", 0)
        if idx < len(candidates):
            candidates[idx]["rerank_score"] = s.get("score", 0)

    # Sort by rerank score descending
    candidates.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
    return candidates


def search_vectorize_d1_reranked(query_text, limit):
    """Search Vectorize + D1 FTS5, RRF merge, then rerank top candidates."""
    query_emb = embed_query(query_text)

    # Vectorize — fetch more candidates for reranking
    vec_result = cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/query", {
        "vector": query_emb, "topK": RERANK_CANDIDATES, "returnMetadata": "all",
    })
    vec_matches = vec_result.get("result", {}).get("matches", []) if vec_result.get("success") else []

    # D1 FTS5
    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_query = " OR ".join(terms[:5]) if terms else query_text
    fts_result = cf_api("POST", f"d1/database/{D1_ID}/query", {
        "sql": "SELECT c.id, c.file, c.start_line, c.end_line, c.content, rank FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
        "params": [fts_query, RERANK_CANDIDATES],
    })
    fts_rows = []
    if fts_result.get("success"):
        for r in fts_result.get("result", [{}]):
            fts_rows.extend(r.get("results", []))

    # RRF merge — collect unique candidates with content
    candidates = {}  # file:start -> {file, start, end, content, rrf_score}

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

    # Sort by RRF score, take top candidates for reranking
    ranked = sorted(candidates.values(), key=lambda x: -x.get("rrf_score", 0))[:RERANK_CANDIDATES]

    # Fetch content for candidates that don't have it (from Vectorize matches)
    for c in ranked:
        if not c.get("content"):
            # Quick D1 lookup
            res = cf_api("POST", f"d1/database/{D1_ID}/query", {
                "sql": "SELECT content FROM chunks WHERE file = ? AND start_line = ? LIMIT 1",
                "params": [c["file"], c["start_line"]],
            })
            if res.get("success"):
                rows = res.get("result", [{}])[0].get("results", [])
                if rows:
                    c["content"] = rows[0].get("content", "")

    # Rerank
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
    print("POC 10c: Eval — Vec+D1+Reranker vs AI Search\n")

    global CF_TOKEN
    if not CF_TOKEN:
        import subprocess
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"], capture_output=True, text=True)
        CF_TOKEN = r.stdout.strip()
        HEADERS["Authorization"] = f"Bearer {CF_TOKEN}"

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries\n")

    variants = {"vec_d1_reranked": [], "aisearch": []}
    latencies = {"vec_d1_reranked": [], "aisearch": []}
    per_query = []

    for i, q in enumerate(queries):
        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        pq = {"id": q.get("id"), "query": q["query"], "type": q.get("type")}

        # Vec+D1+Reranker
        try:
            t0 = time.perf_counter()
            vr = search_vectorize_d1_reranked(q["query"], LIMIT)
            lat = (time.perf_counter() - t0) * 1000
            latencies["vec_d1_reranked"].append(lat)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["vec_d1_reranked"].append(sc)
            pq["vec_d1_reranked"] = sc
        except Exception as e:
            print(f"    Vec error {i}: {e}")
            variants["vec_d1_reranked"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["vec_d1_reranked"].append(0)
            pq["vec_d1_reranked"] = variants["vec_d1_reranked"][-1]

        # AI Search
        try:
            t0 = time.perf_counter()
            ar = search_aisearch(q["query"], LIMIT)
            lat = (time.perf_counter() - t0) * 1000
            latencies["aisearch"].append(lat)
            sc = score_query(ar, q.get("relevant", []), LIMIT)
            variants["aisearch"].append(sc)
            pq["aisearch"] = sc
        except Exception as e:
            print(f"    AIS error {i}: {e}")
            variants["aisearch"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["aisearch"].append(0)
            pq["aisearch"] = variants["aisearch"][-1]

        per_query.append(pq)

    # Aggregate
    def mean(scores, key):
        return sum(s[key] for s in scores) / len(scores) if scores else 0
    def p95(lats):
        if not lats: return 0
        s = sorted(lats)
        return s[min(len(s) - 1, max(0, math.ceil(len(s) * 0.95) - 1))]

    metrics = ["recall_at_5", "recall_at_10", "mrr", "ndcg_at_10"]
    aggs = {}
    for v in variants:
        aggs[v] = {m: mean(variants[v], m) for m in metrics}
        aggs[v]["p95_latency_ms"] = p95(latencies[v])

    # Previous results for comparison
    prev_no_rerank = {"recall_at_5": 0.804, "recall_at_10": 0.921, "mrr": 0.476, "ndcg_at_10": 0.534}

    print(f"\n{'='*80}")
    print(f"  Vec+D1+Reranker vs AI Search vs Vec+D1 (no rerank, previous)")
    print(f"  {len(queries)} queries, top-{LIMIT}")
    print(f"{'='*80}\n")

    print(f"  {'Metric':<16} {'Vec+D1':>10} {'+ Rerank':>10} {'AI Search':>10} {'Rerank Δ':>10}")
    print(f"  {'-'*56}")

    for m in metrics:
        prev = prev_no_rerank[m]
        reranked = aggs["vec_d1_reranked"][m]
        ais = aggs["aisearch"][m]
        delta = reranked - prev
        print(f"  {m:<16} {color(prev):>19} {color(reranked):>19} {color(ais):>19} {delta:>+10.3f}")

    vl = aggs["vec_d1_reranked"]["p95_latency_ms"]
    al = aggs["aisearch"]["p95_latency_ms"]
    print(f"  {'p95_latency':<16} {'—':>10} {vl:>10.0f} {al:>10.0f}")

    # Per-type
    print(f"\n  Per-type Recall@10 (reranked):")
    types = {}
    for pq in per_query:
        t = pq.get("type", "?")
        if t not in types: types[t] = {v: [] for v in variants}
        for v in variants:
            types[t][v].append(pq.get(v, {}).get("recall_at_10", 0))
    print(f"  {'Type':<20} {'Reranked':>10} {'AI Search':>10} {'n':>6}")
    print(f"  {'-'*50}")
    for t in sorted(types):
        vr = sum(types[t]["vec_d1_reranked"]) / len(types[t]["vec_d1_reranked"])
        ar = sum(types[t]["aisearch"]) / len(types[t]["aisearch"])
        print(f"  {t:<20} {vr:>10.3f} {ar:>10.3f} {len(types[t]['vec_d1_reranked']):>6}")

    # Verdict
    print(f"\n{'='*80}")
    vw, aw = 0, 0
    for m in metrics:
        if aggs["vec_d1_reranked"][m] > aggs["aisearch"][m] + 0.01: vw += 1
        elif aggs["aisearch"][m] > aggs["vec_d1_reranked"][m] + 0.01: aw += 1
    if vw > aw:
        print(f"  VERDICT: Vec+D1+Reranker wins {vw}/{len(metrics)} metrics")
    elif aw > vw:
        print(f"  VERDICT: AI Search wins {aw}/{len(metrics)} metrics")
    else:
        print(f"  VERDICT: Tie ({vw} vs {aw})")
    print(f"{'='*80}")

    output = {"query_count": len(queries), "limit": LIMIT, "variants": aggs, "per_query": per_query,
              "previous_no_rerank": prev_no_rerank}
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
