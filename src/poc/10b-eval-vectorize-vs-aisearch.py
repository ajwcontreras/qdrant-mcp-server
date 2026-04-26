#!/usr/bin/env python3
"""
POC 10b: Eval — Vectorize+D1 (Gemini 768d) vs AI Search native (Qwen auto-chunk)

Queries both systems with 240 golden queries, scores, compares.
Vectorize+D1 does client-side RRF merge. AI Search does server-side RRF.
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
import sys
import time
import urllib.request
from pathlib import Path

# ── Config ──
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
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_vectorize_vs_aisearch.json"

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
LIMIT = 10
RRF_K = 60  # standard RRF constant


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


def search_vectorize_d1(query_text, limit):
    """Search Vectorize + D1 FTS5, merge via RRF."""
    # Embed query
    query_emb = embed_query(query_text)

    # Vectorize search
    vec_result = cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/query", {
        "vector": query_emb, "topK": limit * 3, "returnMetadata": "all",
    })
    vec_matches = vec_result.get("result", {}).get("matches", []) if vec_result.get("success") else []

    # D1 FTS5 search — extract key terms
    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_query = " OR ".join(terms[:5]) if terms else query_text
    fts_result = cf_api("POST", f"d1/database/{D1_ID}/query", {
        "sql": "SELECT c.id, c.file, c.start_line, c.end_line, rank FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
        "params": [fts_query, limit * 3],
    })
    fts_rows = []
    if fts_result.get("success"):
        for r in fts_result.get("result", [{}]):
            fts_rows.extend(r.get("results", []))

    # RRF merge
    scores = {}  # file -> score
    file_meta = {}  # file -> {start, end}

    for rank, m in enumerate(vec_matches):
        f = m.get("metadata", {}).get("file", "")
        if f:
            scores[f] = scores.get(f, 0) + 1.0 / (RRF_K + rank + 1)
            if f not in file_meta:
                file_meta[f] = {"start": m["metadata"].get("start"), "end": m["metadata"].get("end")}

    for rank, row in enumerate(fts_rows):
        f = row.get("file", "")
        if f:
            scores[f] = scores.get(f, 0) + 1.0 / (RRF_K + rank + 1)
            if f not in file_meta:
                file_meta[f] = {"start": row.get("start_line"), "end": row.get("end_line")}

    ranked = sorted(scores.items(), key=lambda x: -x[1])[:limit]
    return [{"file": f, "score": s, "start_line": file_meta.get(f, {}).get("start"),
             "end_line": file_meta.get(f, {}).get("end")} for f, s in ranked]


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
    print("POC 10b: Eval — Vectorize+D1 (Gemini) vs AI Search (Qwen)\n")

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries\n")

    variants = {"vectorize_gemini": [], "aisearch_qwen": []}
    latencies = {"vectorize_gemini": [], "aisearch_qwen": []}
    per_query = []

    for i, q in enumerate(queries):
        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        pq = {"id": q.get("id"), "query": q["query"], "type": q.get("type")}

        # Vectorize + D1
        try:
            t0 = time.perf_counter()
            vr = search_vectorize_d1(q["query"], LIMIT)
            lat = (time.perf_counter() - t0) * 1000
            latencies["vectorize_gemini"].append(lat)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["vectorize_gemini"].append(sc)
            pq["vectorize_gemini"] = sc
        except Exception as e:
            print(f"    Vec error {i}: {e}")
            variants["vectorize_gemini"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["vectorize_gemini"].append(0)
            pq["vectorize_gemini"] = variants["vectorize_gemini"][-1]

        # AI Search
        try:
            t0 = time.perf_counter()
            ar = search_aisearch(q["query"], LIMIT)
            lat = (time.perf_counter() - t0) * 1000
            latencies["aisearch_qwen"].append(lat)
            sc = score_query(ar, q.get("relevant", []), LIMIT)
            variants["aisearch_qwen"].append(sc)
            pq["aisearch_qwen"] = sc
        except Exception as e:
            print(f"    AIS error {i}: {e}")
            variants["aisearch_qwen"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["aisearch_qwen"].append(0)
            pq["aisearch_qwen"] = variants["aisearch_qwen"][-1]

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

    # Print
    print(f"\n{'='*72}")
    print(f"  Vectorize+D1 (Gemini 768d) vs AI Search (Qwen 1024d auto-chunk)")
    print(f"  {len(queries)} queries, top-{LIMIT}")
    print(f"{'='*72}\n")

    print(f"  {'Metric':<20} {'Vec+D1 Gemini':>14} {'AI Search':>14} {'Delta':>10} {'Winner':>12}")
    print(f"  {'-'*70}")

    vw, aw = 0, 0
    for m in metrics:
        vv = aggs["vectorize_gemini"][m]
        av = aggs["aisearch_qwen"][m]
        d = vv - av
        w = "Vec+D1" if d > 0.01 else ("AI Search" if d < -0.01 else "Tie")
        if w == "Vec+D1": vw += 1
        elif w == "AI Search": aw += 1
        print(f"  {m:<20} {color(vv):>23} {color(av):>23} {d:>+10.3f} {w:>12}")

    vl, al = aggs["vectorize_gemini"]["p95_latency_ms"], aggs["aisearch_qwen"]["p95_latency_ms"]
    print(f"  {'p95_latency_ms':<20} {vl:>14.0f} {al:>14.0f} {vl-al:>+10.0f} {'AI Search' if vl > al else 'Vec+D1':>12}")

    # Per-type
    print(f"\n  Per-type Recall@10:")
    types = {}
    for pq in per_query:
        t = pq.get("type", "?")
        if t not in types: types[t] = {v: [] for v in variants}
        for v in variants:
            types[t][v].append(pq.get(v, {}).get("recall_at_10", 0))
    print(f"  {'Type':<20} {'Vec+D1':>10} {'AI Search':>10} {'Delta':>10} {'n':>6}")
    print(f"  {'-'*56}")
    for t in sorted(types):
        vr = sum(types[t]["vectorize_gemini"]) / len(types[t]["vectorize_gemini"])
        ar = sum(types[t]["aisearch_qwen"]) / len(types[t]["aisearch_qwen"])
        print(f"  {t:<20} {vr:>10.3f} {ar:>10.3f} {vr-ar:>+10.3f} {len(types[t]['vectorize_gemini']):>6}")

    print(f"\n{'='*72}")
    if vw > aw:
        print(f"  VERDICT: Vectorize+D1 (Gemini) wins {vw}/{len(metrics)} metrics")
    elif aw > vw:
        print(f"  VERDICT: AI Search (Qwen native) wins {aw}/{len(metrics)} metrics")
    else:
        print(f"  VERDICT: Tie ({vw} vs {aw})")
    print(f"{'='*72}")

    output = {"query_count": len(queries), "limit": LIMIT, "variants": aggs, "per_query": per_query}
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
