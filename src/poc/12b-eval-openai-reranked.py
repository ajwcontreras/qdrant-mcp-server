#!/usr/bin/env python3
"""
POC 12b: Eval — OpenAI 3072d AST+Reranker vs Gemini 768d AST+Reranker vs AI Search

Compares embedding model quality with everything else held constant.
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

CF_ACCOUNT = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
GW_NAME = "code-search"
GCP_PROJECT = "evrylo"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")

# OpenAI index
OPENAI_VECTORIZE = "lumae-eval-openai-ast"
OPENAI_D1_ID = None  # filled at runtime
OPENAI_D1_NAME = "lumae-eval-openai-ast-fts"

# Gemini index (from POC 11)
GEMINI_VECTORIZE = "lumae-eval-ast"
GEMINI_D1_ID = "71b99e5f-817e-42f6-b96b-540e2cd9612f"

AISEARCH_INSTANCE = "lumae-eval-bare"

QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_openai_vs_gemini.json"

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


def embed_openai(text):
    url = "https://api.openai.com/v1/embeddings"
    payload = json.dumps({"model": "text-embedding-3-large", "input": text[:8191], "dimensions": 1536}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_KEY}",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    return result["data"][0]["embedding"]


def embed_gemini(text):
    with open(SA_PATH) as f:
        sa = json.load(f)
    sa["region"] = "us-central1"
    sa_b64 = base64.b64encode(json.dumps(sa).encode()).decode()
    url = (f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT}/{GW_NAME}"
           f"/google-vertex-ai/v1/projects/{GCP_PROJECT}/locations/us-central1"
           f"/publishers/google/models/text-embedding-004:predict")
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


def search_vec_d1_reranked(query_text, limit, vectorize_idx, d1_id, embed_fn):
    """Generic Vectorize+D1+Reranker search."""
    query_emb = embed_fn(query_text)

    vec_result = cf_api("POST", f"vectorize/v2/indexes/{vectorize_idx}/query", {
        "vector": query_emb, "topK": RERANK_CANDIDATES, "returnMetadata": "all",
    })
    vec_matches = vec_result.get("result", {}).get("matches", []) if vec_result.get("success") else []

    # D1 FTS5
    terms = [w for w in query_text.split() if len(w) > 2 and w.lower() not in {
        "the", "and", "for", "how", "does", "what", "where", "when", "which", "that", "this", "with", "from",
    }]
    fts_query = " OR ".join(terms[:5]) if terms else query_text
    fts_result = cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "SELECT c.id, c.file, c.start_line, c.end_line, c.content, rank FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
        "params": [fts_query, RERANK_CANDIDATES],
    })
    fts_rows = []
    if fts_result.get("success"):
        for r in fts_result.get("result", [{}]):
            fts_rows.extend(r.get("results", []))

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
                "sql": "SELECT content FROM chunks WHERE file = ? AND start_line = ? LIMIT 1",
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
    print("POC 12b: Eval — OpenAI 3072d vs Gemini 768d vs AI Search\n")

    global CF_TOKEN, OPENAI_D1_ID
    if not CF_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                           capture_output=True, text=True)
        CF_TOKEN = r.stdout.strip()
        HEADERS["Authorization"] = f"Bearer {CF_TOKEN}"

    # Resolve OpenAI D1 ID
    dbs = cf_api("GET", "d1/database")
    if dbs.get("success"):
        for db in dbs.get("result", []):
            if db["name"] == OPENAI_D1_NAME:
                OPENAI_D1_ID = db["uuid"]
                break
    if not OPENAI_D1_ID:
        print("ERROR: OpenAI D1 database not found. Run POC 12 first.")
        sys.exit(1)
    print(f"  OpenAI D1: {OPENAI_D1_ID}")

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries\n")

    variants = {"openai_reranked": [], "gemini_reranked": [], "aisearch": []}
    latencies = {"openai_reranked": [], "gemini_reranked": [], "aisearch": []}
    per_query = []

    for i, q in enumerate(queries):
        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        pq = {"id": q.get("id"), "query": q["query"], "type": q.get("type")}

        # OpenAI+Reranker
        try:
            t0 = time.perf_counter()
            vr = search_vec_d1_reranked(q["query"], LIMIT, OPENAI_VECTORIZE, OPENAI_D1_ID, embed_openai)
            lat = (time.perf_counter() - t0) * 1000
            latencies["openai_reranked"].append(lat)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["openai_reranked"].append(sc)
            pq["openai_reranked"] = sc
        except Exception as e:
            print(f"    OpenAI error {i}: {e}")
            variants["openai_reranked"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["openai_reranked"].append(0)
            pq["openai_reranked"] = variants["openai_reranked"][-1]

        # Gemini+Reranker
        try:
            t0 = time.perf_counter()
            vr = search_vec_d1_reranked(q["query"], LIMIT, GEMINI_VECTORIZE, GEMINI_D1_ID, embed_gemini)
            lat = (time.perf_counter() - t0) * 1000
            latencies["gemini_reranked"].append(lat)
            sc = score_query(vr, q.get("relevant", []), LIMIT)
            variants["gemini_reranked"].append(sc)
            pq["gemini_reranked"] = sc
        except Exception as e:
            print(f"    Gemini error {i}: {e}")
            variants["gemini_reranked"].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            latencies["gemini_reranked"].append(0)
            pq["gemini_reranked"] = variants["gemini_reranked"][-1]

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

    print(f"\n{'='*90}")
    print(f"  OpenAI 3072d vs Gemini 768d vs AI Search  ({len(queries)} queries, top-{LIMIT})")
    print(f"{'='*90}\n")

    print(f"  {'Metric':<16} {'OpenAI 3072d':>14} {'Gemini 768d':>14} {'AI Search':>14} {'OAI-Gem Δ':>10}")
    print(f"  {'-'*68}")

    for m in metrics:
        oai = aggs["openai_reranked"][m]
        gem = aggs["gemini_reranked"][m]
        ais = aggs["aisearch"][m]
        delta = oai - gem
        print(f"  {m:<16} {color(oai):>23} {color(gem):>23} {color(ais):>23} {delta:>+10.3f}")

    ol = aggs["openai_reranked"]["p95_latency_ms"]
    gl = aggs["gemini_reranked"]["p95_latency_ms"]
    al = aggs["aisearch"]["p95_latency_ms"]
    print(f"  {'p95_latency':<16} {ol:>14.0f} {gl:>14.0f} {al:>14.0f}")

    # Per-type breakdown
    print(f"\n  Per-type MRR:")
    types = {}
    for pq in per_query:
        t = pq.get("type", "?")
        if t not in types: types[t] = {v: [] for v in variants}
        for v in variants:
            types[t][v].append(pq.get(v, {}).get("mrr", 0))
    print(f"  {'Type':<20} {'OpenAI':>10} {'Gemini':>10} {'AI Search':>10} {'n':>6}")
    print(f"  {'-'*60}")
    for t in sorted(types):
        ov = sum(types[t]["openai_reranked"]) / len(types[t]["openai_reranked"])
        gv = sum(types[t]["gemini_reranked"]) / len(types[t]["gemini_reranked"])
        av = sum(types[t]["aisearch"]) / len(types[t]["aisearch"])
        print(f"  {t:<20} {ov:>10.3f} {gv:>10.3f} {av:>10.3f} {len(types[t]['openai_reranked']):>6}")

    # Verdict
    print(f"\n{'='*90}")
    ow, gw = 0, 0
    for m in metrics:
        if aggs["openai_reranked"][m] > aggs["gemini_reranked"][m] + 0.01: ow += 1
        elif aggs["gemini_reranked"][m] > aggs["openai_reranked"][m] + 0.01: gw += 1
    if ow > gw:
        print(f"  VERDICT: OpenAI 3072d wins {ow}/{len(metrics)} metrics over Gemini 768d")
    elif gw > ow:
        print(f"  VERDICT: Gemini 768d wins {gw}/{len(metrics)} metrics over OpenAI 3072d")
    else:
        print(f"  VERDICT: Tie ({ow} vs {gw})")
    print(f"{'='*90}")

    output = {"query_count": len(queries), "limit": LIMIT, "variants": aggs, "per_query": per_query}
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
