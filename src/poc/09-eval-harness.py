#!/usr/bin/env python3
"""
POC 9: Eval harness — compare Qdrant bare vs AI Search bare

Runs 240 golden queries against both variants, scores Recall@5, Recall@10,
MRR, nDCG@10, p95 latency. Prints human-readable comparison table.
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
import uuid
from pathlib import Path

# ── Config ──
QDRANT_URL = "http://localhost:6333"
QDRANT_COLLECTION = "lumae-eval-bare"
CF_ACCOUNT_ID = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_INSTANCE_ID = "lumae-eval-bare"
CF_API_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_results.json"

# Vertex AI for query embeddings (Qdrant needs them)
PROJECT = "evrylo"
REGION = "us-central1"
EMBED_MODEL = "text-embedding-004"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")

LIMIT = 10  # top-K for scoring


def get_access_token() -> str:
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def embed_query(token: str, text: str) -> list[float]:
    endpoint = (
        f"https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{REGION}/publishers/google/models/{EMBED_MODEL}:predict"
    )
    payload = json.dumps({"instances": [{"content": text[:2048]}]}).encode()
    req = urllib.request.Request(
        endpoint, data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["predictions"][0]["embeddings"]["values"]


def search_qdrant(query_embedding: list[float], limit: int) -> list[dict]:
    """Search Qdrant bare collection."""
    payload = json.dumps({
        "vector": query_embedding,
        "limit": limit,
        "with_payload": ["file", "start_line", "end_line", "line_range", "content"],
    }).encode()
    req = urllib.request.Request(
        f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/search",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    results = []
    for point in result.get("result", []):
        p = point.get("payload", {})
        results.append({
            "file": p.get("file", ""),
            "start_line": p.get("start_line"),
            "end_line": p.get("end_line"),
            "score": point.get("score", 0),
            "snippet": (p.get("content", ""))[:200],
        })
    return results


def search_aisearch(query: str, limit: int) -> list[dict]:
    """Search AI Search instance."""
    global CF_API_TOKEN
    if not CF_API_TOKEN:
        result = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                                capture_output=True, text=True)
        CF_API_TOKEN = result.stdout.strip()

    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai-search/instances/{CF_INSTANCE_ID}/search"
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
        headers={
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())

    results = []
    for chunk in result.get("result", {}).get("chunks", []):
        # AI Search returns item.key as filename
        filename = chunk.get("item", {}).get("key", "")
        score = chunk.get("score", 0)
        text = chunk.get("text", "")

        # Try to extract line info from chunk text (we formatted as markdown headers)
        start_line = None
        end_line = None

        results.append({
            "file": filename,
            "start_line": start_line,
            "end_line": end_line,
            "score": score,
            "snippet": text[:200],
        })
    return results


def overlaps(result: dict, relevant: dict) -> bool:
    """Check if a search result overlaps with a golden relevant entry."""
    # File match (AI Search returns just filename, golden has relative path)
    result_file = result.get("file", "")
    relevant_file = relevant.get("file", "")

    # Handle AI Search returning just filename vs full relative path
    if result_file != relevant_file:
        # Check if one ends with the other
        if not (result_file.endswith(relevant_file) or relevant_file.endswith(result_file)):
            # Also check basename match
            if os.path.basename(result_file) != os.path.basename(relevant_file):
                return False

    # If no line ranges in result (AI Search case), file match is enough
    if result.get("start_line") is None or result.get("end_line") is None:
        return True

    # If golden has line ranges, check overlap
    if "start_line" in relevant and "end_line" in relevant:
        return (int(result["start_line"]) <= int(relevant["end_line"]) and
                int(result["end_line"]) >= int(relevant["start_line"]))

    return True


def score_query(results: list[dict], relevant_items: list[dict], k: int) -> dict:
    """Score a query's results against golden relevant items."""
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

    # nDCG@K
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

    return {
        "recall_at_5": recall_at_5,
        "recall_at_10": recall_at_10,
        "mrr": mrr,
        "ndcg_at_10": ndcg,
    }


def color(value: float) -> str:
    """ANSI color based on metric value."""
    if value >= 0.8:
        return f"\033[92m{value:.3f}\033[0m"  # green
    elif value >= 0.5:
        return f"\033[93m{value:.3f}\033[0m"  # yellow
    else:
        return f"\033[91m{value:.3f}\033[0m"  # red


def run():
    print("POC 9: Eval harness — Qdrant bare vs AI Search bare\n")

    # Load queries
    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  Loaded {len(queries)} golden queries")

    # Auth for Qdrant embeddings
    print("  Authenticating for Gemini embeddings...")
    token = get_access_token()

    # Resolve CF token
    global CF_API_TOKEN
    if not CF_API_TOKEN:
        result = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                                capture_output=True, text=True)
        CF_API_TOKEN = result.stdout.strip()

    # ── Run queries against both variants ──
    qdrant_scores = []
    aisearch_scores = []
    qdrant_latencies = []
    aisearch_latencies = []
    per_query = []

    for i, q in enumerate(queries):
        query_text = q["query"]
        relevant = q.get("relevant", [])

        if (i + 1) % 20 == 0:
            print(f"  [{i + 1}/{len(queries)}]...")

        # Qdrant: need to embed query first
        try:
            t0 = time.perf_counter()
            query_emb = embed_query(token, query_text)
            qdrant_results = search_qdrant(query_emb, LIMIT)
            qdrant_latency = (time.perf_counter() - t0) * 1000
            qdrant_latencies.append(qdrant_latency)
            qdrant_score = score_query(qdrant_results, relevant, LIMIT)
            qdrant_scores.append(qdrant_score)
        except Exception as e:
            if "401" in str(e) or "403" in str(e):
                token = get_access_token()
                t0 = time.perf_counter()
                query_emb = embed_query(token, query_text)
                qdrant_results = search_qdrant(query_emb, LIMIT)
                qdrant_latency = (time.perf_counter() - t0) * 1000
                qdrant_latencies.append(qdrant_latency)
                qdrant_score = score_query(qdrant_results, relevant, LIMIT)
                qdrant_scores.append(qdrant_score)
            else:
                print(f"    Qdrant error on query {i}: {e}")
                qdrant_scores.append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
                qdrant_latencies.append(0)
                qdrant_score = qdrant_scores[-1]

        # AI Search: query text directly
        try:
            t0 = time.perf_counter()
            aisearch_results = search_aisearch(query_text, LIMIT)
            aisearch_latency = (time.perf_counter() - t0) * 1000
            aisearch_latencies.append(aisearch_latency)
            aisearch_score = score_query(aisearch_results, relevant, LIMIT)
            aisearch_scores.append(aisearch_score)
        except Exception as e:
            print(f"    AI Search error on query {i}: {e}")
            aisearch_scores.append({"recall_at_5": 0, "recall_at_10": 0, "mrr": 0, "ndcg_at_10": 0})
            aisearch_latencies.append(0)
            aisearch_score = aisearch_scores[-1]

        per_query.append({
            "id": q.get("id"),
            "query": query_text,
            "type": q.get("type"),
            "qdrant": qdrant_score,
            "aisearch": aisearch_score,
        })

    # ── Aggregate ──
    def mean(scores, key):
        vals = [s[key] for s in scores]
        return sum(vals) / len(vals) if vals else 0

    def p95(latencies):
        if not latencies:
            return 0
        s = sorted(latencies)
        idx = min(len(s) - 1, max(0, math.ceil(len(s) * 0.95) - 1))
        return s[idx]

    metrics = ["recall_at_5", "recall_at_10", "mrr", "ndcg_at_10"]
    qdrant_agg = {m: mean(qdrant_scores, m) for m in metrics}
    aisearch_agg = {m: mean(aisearch_scores, m) for m in metrics}
    qdrant_agg["p95_latency_ms"] = p95(qdrant_latencies)
    aisearch_agg["p95_latency_ms"] = p95(aisearch_latencies)

    # ── Print comparison ──
    print(f"\n{'='*70}")
    print(f"  EVAL RESULTS: {len(queries)} queries, top-{LIMIT}")
    print(f"{'='*70}\n")

    header = f"  {'Metric':<20} {'Qdrant bare':>14} {'AI Search':>14} {'Delta':>10} {'Winner':>10}"
    print(header)
    print(f"  {'-'*68}")

    qdrant_wins = 0
    aisearch_wins = 0

    for m in metrics:
        q_val = qdrant_agg[m]
        a_val = aisearch_agg[m]
        delta = a_val - q_val
        winner = "AI Search" if delta > 0.01 else ("Qdrant" if delta < -0.01 else "Tie")
        if winner == "AI Search":
            aisearch_wins += 1
        elif winner == "Qdrant":
            qdrant_wins += 1

        delta_str = f"{'+' if delta >= 0 else ''}{delta:.3f}"
        print(f"  {m:<20} {color(q_val):>23} {color(a_val):>23} {delta_str:>10} {winner:>10}")

    # Latency
    q_lat = qdrant_agg["p95_latency_ms"]
    a_lat = aisearch_agg["p95_latency_ms"]
    print(f"  {'p95_latency_ms':<20} {q_lat:>14.0f} {a_lat:>14.0f} {a_lat - q_lat:>+10.0f} {'Qdrant' if q_lat < a_lat else 'AI Search':>10}")

    # ── Per-type breakdown ──
    print(f"\n  Per-type Recall@10:")
    types = {}
    for pq in per_query:
        t = pq.get("type", "unknown")
        if t not in types:
            types[t] = {"qdrant": [], "aisearch": []}
        types[t]["qdrant"].append(pq["qdrant"]["recall_at_10"])
        types[t]["aisearch"].append(pq["aisearch"]["recall_at_10"])

    print(f"  {'Type':<20} {'Qdrant':>10} {'AI Search':>10} {'n':>6}")
    print(f"  {'-'*50}")
    for t in sorted(types.keys()):
        q_r = sum(types[t]["qdrant"]) / len(types[t]["qdrant"])
        a_r = sum(types[t]["aisearch"]) / len(types[t]["aisearch"])
        print(f"  {t:<20} {q_r:>10.3f} {a_r:>10.3f} {len(types[t]['qdrant']):>6}")

    # ── Verdict ──
    print(f"\n{'='*70}")
    if aisearch_wins > qdrant_wins:
        print(f"  VERDICT: AI Search wins {aisearch_wins}/{len(metrics)} metrics")
    elif qdrant_wins > aisearch_wins:
        print(f"  VERDICT: Qdrant bare wins {qdrant_wins}/{len(metrics)} metrics")
    else:
        print(f"  VERDICT: Tie ({qdrant_wins} vs {aisearch_wins})")
    print(f"{'='*70}")

    # ── Save ──
    output = {
        "query_count": len(queries),
        "limit": LIMIT,
        "variants": {
            "qdrant_bare": qdrant_agg,
            "aisearch_bare": aisearch_agg,
        },
        "per_query": per_query,
    }
    RESULTS_PATH.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\n  Results saved to {RESULTS_PATH.name}")


if __name__ == "__main__":
    run()
