#!/usr/bin/env python3
"""
POC 9b: Eval — AI Search bare vs AI Search + HyDE

240 golden queries against both AI Search variants.
Same eval metrics as POC 9.
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CF_ACCOUNT_ID = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_API_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_aisearch_comparison.json"
BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai-search/instances"
LIMIT = 10

VARIANTS = {
    "ai_search_bare": "lumae-eval-bare",
    "ai_search_hyde": "lumae-eval-hyde",
}


def search(instance_id: str, query: str, limit: int) -> list[dict]:
    url = f"{BASE_URL}/{instance_id}/search"
    payload = json.dumps({
        "messages": [{"role": "user", "content": query}],
        "ai_search_options": {
            "retrieval": {
                "retrieval_type": "hybrid",
                "fusion_method": "rrf",
                "max_num_results": limit,
            }
        }
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    results = []
    for chunk in result.get("result", {}).get("chunks", []):
        results.append({
            "file": chunk.get("item", {}).get("key", ""),
            "score": chunk.get("score", 0),
        })
    return results


def overlaps(result: dict, relevant: dict) -> bool:
    result_file = result.get("file", "")
    relevant_file = relevant.get("file", "")
    if result_file == relevant_file:
        return True
    if result_file.endswith(relevant_file) or relevant_file.endswith(result_file):
        return True
    if os.path.basename(result_file) == os.path.basename(relevant_file):
        return True
    return False


def score_query(results: list[dict], relevant_items: list[dict], k: int) -> dict:
    top = results[:k]
    found_at = []
    for rank, result in enumerate(top):
        for rel in relevant_items:
            if overlaps(result, rel):
                found_at.append(rank + 1)
                break

    recall_at_5 = 1.0 if any(r <= 5 for r in found_at) else 0.0
    recall_at_10 = 1.0 if found_at else 0.0
    mrr = 1.0 / found_at[0] if found_at else 0.0

    grades = []
    used = set()
    for result in top:
        matched = False
        for i, rel in enumerate(relevant_items):
            if i not in used and overlaps(result, rel):
                grades.append(int(rel.get("grade", 1)))
                used.add(i)
                matched = True
                break
        if not matched:
            grades.append(0)

    dcg = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(grades))
    ideal = sorted([int(r.get("grade", 1)) for r in relevant_items], reverse=True)[:k]
    idcg = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(ideal))
    ndcg = dcg / idcg if idcg > 0 else 0.0

    return {"recall_at_5": recall_at_5, "recall_at_10": recall_at_10, "mrr": mrr, "ndcg_at_10": ndcg}


def color(value: float) -> str:
    if value >= 0.8:
        return f"\033[92m{value:.3f}\033[0m"
    elif value >= 0.5:
        return f"\033[93m{value:.3f}\033[0m"
    else:
        return f"\033[91m{value:.3f}\033[0m"


def run():
    print("POC 9b: Eval — AI Search bare vs AI Search + HyDE\n")

    global CF_API_TOKEN
    if not CF_API_TOKEN:
        result = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                                capture_output=True, text=True)
        CF_API_TOKEN = result.stdout.strip()

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  {len(queries)} golden queries\n")

    all_scores = {v: [] for v in VARIANTS}
    all_latencies = {v: [] for v in VARIANTS}
    per_query = []

    for i, q in enumerate(queries):
        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        pq = {"id": q.get("id"), "query": q["query"], "type": q.get("type")}

        for variant_name, instance_id in VARIANTS.items():
            try:
                t0 = time.perf_counter()
                results = search(instance_id, q["query"], LIMIT)
                latency = (time.perf_counter() - t0) * 1000
                all_latencies[variant_name].append(latency)
                scores = score_query(results, q.get("relevant", []), LIMIT)
                all_scores[variant_name].append(scores)
                pq[variant_name] = scores
            except Exception as e:
                print(f"    {variant_name} error on query {i}: {e}")
                all_scores[variant_name].append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
                all_latencies[variant_name].append(0)
                pq[variant_name] = all_scores[variant_name][-1]

        per_query.append(pq)

    # Aggregate
    def mean(scores, key):
        vals = [s[key] for s in scores]
        return sum(vals) / len(vals) if vals else 0

    def p95(latencies):
        if not latencies:
            return 0
        s = sorted(latencies)
        return s[min(len(s) - 1, max(0, math.ceil(len(s) * 0.95) - 1))]

    metrics = ["recall_at_5", "recall_at_10", "mrr", "ndcg_at_10"]
    aggs = {}
    for v in VARIANTS:
        aggs[v] = {m: mean(all_scores[v], m) for m in metrics}
        aggs[v]["p95_latency_ms"] = p95(all_latencies[v])

    # Print
    print(f"\n{'='*70}")
    print(f"  EVAL: AI Search bare vs AI Search + HyDE ({len(queries)} queries, top-{LIMIT})")
    print(f"{'='*70}\n")

    header = f"  {'Metric':<20} {'Bare':>12} {'+ HyDE':>12} {'Delta':>10} {'Winner':>10}"
    print(header)
    print(f"  {'-'*64}")

    bare_wins = 0
    hyde_wins = 0

    for m in metrics:
        bare = aggs["ai_search_bare"][m]
        hyde = aggs["ai_search_hyde"][m]
        delta = hyde - bare
        winner = "+ HyDE" if delta > 0.01 else ("Bare" if delta < -0.01 else "Tie")
        if winner == "+ HyDE":
            hyde_wins += 1
        elif winner == "Bare":
            bare_wins += 1
        print(f"  {m:<20} {color(bare):>21} {color(hyde):>21} {delta:>+10.3f} {winner:>10}")

    bare_lat = aggs["ai_search_bare"]["p95_latency_ms"]
    hyde_lat = aggs["ai_search_hyde"]["p95_latency_ms"]
    print(f"  {'p95_latency_ms':<20} {bare_lat:>12.0f} {hyde_lat:>12.0f} {hyde_lat - bare_lat:>+10.0f} {'Bare' if bare_lat < hyde_lat else '+ HyDE':>10}")

    # Per-type
    print(f"\n  Per-type Recall@10:")
    types = {}
    for pq in per_query:
        t = pq.get("type", "unknown")
        if t not in types:
            types[t] = {v: [] for v in VARIANTS}
        for v in VARIANTS:
            types[t][v].append(pq.get(v, {}).get("recall_at_10", 0))

    print(f"  {'Type':<20} {'Bare':>10} {'+ HyDE':>10} {'Delta':>10} {'n':>6}")
    print(f"  {'-'*56}")
    for t in sorted(types.keys()):
        bare_r = sum(types[t]["ai_search_bare"]) / len(types[t]["ai_search_bare"])
        hyde_r = sum(types[t]["ai_search_hyde"]) / len(types[t]["ai_search_hyde"])
        delta = hyde_r - bare_r
        print(f"  {t:<20} {bare_r:>10.3f} {hyde_r:>10.3f} {delta:>+10.3f} {len(types[t]['ai_search_bare']):>6}")

    # Verdict
    print(f"\n{'='*70}")
    if hyde_wins > bare_wins:
        print(f"  VERDICT: AI Search + HyDE wins {hyde_wins}/{len(metrics)} metrics")
    elif bare_wins > hyde_wins:
        print(f"  VERDICT: AI Search bare wins {bare_wins}/{len(metrics)} metrics")
    else:
        print(f"  VERDICT: Tie ({bare_wins} vs {hyde_wins})")
    print(f"{'='*70}")

    # Save
    output = {"query_count": len(queries), "limit": LIMIT, "variants": aggs, "per_query": per_query}
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Results saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
