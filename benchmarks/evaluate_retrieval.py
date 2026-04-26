#!/usr/bin/env python3
import argparse
import asyncio
import importlib.util
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QUERIES = ROOT / "benchmarks" / "golden_queries.json"


def load_wrapper_module():
    path = ROOT / "src" / "mcp-qdrant-openai-wrapper.py"
    spec = importlib.util.spec_from_file_location("mcp_qdrant_openai_wrapper_bench", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_queries(path: Path) -> List[Dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def overlaps(result: Dict[str, Any], relevant: Dict[str, Any]) -> bool:
    if result.get("file") != relevant.get("file"):
        return False
    if "start_line" not in relevant or "end_line" not in relevant:
        return True
    result_start = result.get("start_line")
    result_end = result.get("end_line")
    if result_start is None or result_end is None:
        return False
    return int(result_start) <= int(relevant["end_line"]) and int(result_end) >= int(relevant["start_line"])


def matched_relevant_index(result: Dict[str, Any], relevant_items: List[Dict[str, Any]], used: set[int]) -> int | None:
    matches = [
        (index, int(item.get("grade", 1)))
        for index, item in enumerate(relevant_items)
        if index not in used and overlaps(result, item)
    ]
    if not matches:
        return None
    return max(matches, key=lambda item: item[1])[0]


def dcg(grades: List[int]) -> float:
    return sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))


def score_query(results: List[Dict[str, Any]], relevant_items: List[Dict[str, Any]], k: int) -> Dict[str, float]:
    top = results[:k]
    used_relevant: set[int] = set()
    grades = []
    for result in top:
        matched_index = matched_relevant_index(result, relevant_items, used_relevant)
        if matched_index is None:
            grades.append(0)
            continue
        used_relevant.add(matched_index)
        grades.append(int(relevant_items[matched_index].get("grade", 1)))
    found_ranks = [index + 1 for index, grade in enumerate(grades) if grade > 0]
    ideal_grades = sorted([int(item.get("grade", 1)) for item in relevant_items], reverse=True)[:k]
    ideal = dcg(ideal_grades)
    return {
        "recall_at_k": 1.0 if found_ranks else 0.0,
        "mrr": 1.0 / found_ranks[0] if found_ranks else 0.0,
        "ndcg_at_k": dcg(grades) / ideal if ideal else 0.0,
    }


def format_result(result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "rank": result.get("rank"),
        "file": result.get("file"),
        "line_range": result.get("line_range"),
        "start_line": result.get("start_line"),
        "end_line": result.get("end_line"),
        "score": result.get("score"),
        "raw_score": result.get("raw_score"),
        "match_reasons": result.get("match_reasons") or [],
        "signature": result.get("signature"),
        "symbols_defined": result.get("symbols_defined") or [],
    }


def load_worker_token(args: argparse.Namespace) -> str:
    if args.embedding_worker_token:
        return args.embedding_worker_token
    if args.embedding_worker_token_path:
        return Path(args.embedding_worker_token_path).expanduser().read_text(encoding="utf-8").strip()
    token_path = os.environ.get("EMBEDDING_WORKER_TOKEN_PATH")
    if token_path:
        return Path(token_path).expanduser().read_text(encoding="utf-8").strip()
    return os.environ.get("EMBEDDING_WORKER_TOKEN", "")


def install_worker_embeddings(server: Any, args: argparse.Namespace) -> None:
    worker_url = (args.embedding_worker_url or os.environ.get("EMBEDDING_WORKER_URL") or "").rstrip("/")
    if not worker_url:
        return
    token = load_worker_token(args)
    if not token:
        raise ValueError("--embedding-worker-url requires an embedding worker token")
    model = args.embedding_model or os.environ.get("OPENAI_EMBEDDING_MODEL") or "text-embedding-3-large"

    async def get_embeddings_via_worker(texts: List[str]) -> List[List[float]]:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                f"{worker_url}/embed-batch",
                headers={
                    "content-type": "application/json",
                    "user-agent": "qdrant-retrieval-benchmark/1.0",
                    "x-batch-token": token,
                },
                json={
                    "model": model,
                    "texts": texts,
                },
            )
        response.raise_for_status()
        data = response.json()
        embeddings = data.get("embeddings")
        if not data.get("ok") or not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise RuntimeError(f"Embedding Worker returned invalid payload: {str(data)[:500]}")
        return embeddings

    server.get_embeddings = get_embeddings_via_worker


async def run_benchmark(args: argparse.Namespace) -> Dict[str, Any]:
    if args.collection:
        os.environ["COLLECTION_NAME"] = args.collection
    if args.qdrant_url:
        os.environ["QDRANT_URL"] = args.qdrant_url
    wrapper = load_wrapper_module()
    server = wrapper.MCPServer()
    install_worker_embeddings(server, args)
    await server.initialize()
    queries = load_queries(Path(args.queries))
    per_query = []
    latencies = []
    for item in queries:
        started = time.perf_counter()
        response = await server._search(
            query=item["query"],
            limit=args.limit,
            candidate_limit=args.candidate_limit,
            include_snippet=False,
            include_graph=False,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        latencies.append(elapsed_ms)
        results = response.get("results", [])
        scores = score_query(results, item["relevant"], args.limit)
        per_query.append({
            "id": item["id"],
            "query": item["query"],
            "latency_ms": elapsed_ms,
            **scores,
            "top_files": [result.get("file") for result in results[: args.limit]],
            "top_results": [format_result(result) for result in results[: args.limit]],
        })
    count = len(per_query) or 1
    sorted_latencies = sorted(latencies)
    p95_index = min(len(sorted_latencies) - 1, max(0, math.ceil(len(sorted_latencies) * 0.95) - 1))
    return {
        "query_count": len(per_query),
        "collection": server.collection_name,
        "limit": args.limit,
        "candidate_limit": args.candidate_limit,
        "mean_recall_at_k": sum(item["recall_at_k"] for item in per_query) / count,
        "mean_mrr": sum(item["mrr"] for item in per_query) / count,
        "mean_ndcg_at_k": sum(item["ndcg_at_k"] for item in per_query) / count,
        "p95_latency_ms": sorted_latencies[p95_index] if sorted_latencies else 0.0,
        "queries": per_query,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate MCP Qdrant retrieval against golden queries.")
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--collection")
    parser.add_argument("--qdrant-url")
    parser.add_argument("--embedding-worker-url")
    parser.add_argument("--embedding-worker-token")
    parser.add_argument("--embedding-worker-token-path")
    parser.add_argument("--embedding-model")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--candidate-limit", type=int, default=50)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = asyncio.run(run_benchmark(args))
    text = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
