#!/usr/bin/env python3
"""
POC 4c: Fix golden query line ranges using Codex Spark

Spark reads the actual source files and corrects line ranges
for each query's relevant entries. 3 concurrent, batches of 10.
"""

import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
MAX_WORKERS = 3
BATCH_SIZE = 10


def fix_batch(batch: list[dict], batch_id: int) -> list[dict]:
    """Have Codex Spark fix line ranges for a batch of queries."""
    items = []
    for i, q in enumerate(batch):
        refs = []
        for r in q.get("relevant", []):
            refs.append(f"  file: {r['file']}, claimed lines: {r.get('start_line','?')}-{r.get('end_line','?')}")
        items.append(f"{i}. Query: \"{q['query'][:120]}\"\n" + "\n".join(refs))

    prompt = f"""For each query below, find the ACTUAL line range in the source files where the relevant code lives. Read each file and locate the function/class/block that the query describes.

Return a JSON object mapping query index to corrected line ranges:
{{"0": [{{"file": "path.py", "start_line": 45, "end_line": 82}}], "1": [{{"file": "other.py", "start_line": 10, "end_line": 30}}]}}

If the code doesn't exist in the file, return an empty array for that index.
Only return the JSON, nothing else.

Queries:
{chr(10).join(items)}"""

    agent_home = tempfile.mkdtemp(prefix=f"codex-fix-{batch_id}-")
    auth_src = os.path.expanduser("~/.codex/auth.json")
    if os.path.exists(auth_src):
        shutil.copy2(auth_src, os.path.join(agent_home, "auth.json"))

    output_file = os.path.join(agent_home, "output.txt")

    try:
        env = os.environ.copy()
        env["CODEX_HOME"] = agent_home
        subprocess.run(
            [
                "codex", "exec",
                "-m", "gpt-5.3-codex-spark",
                "-s", "read-only",
                "-C", LUMAE_DIR,
                "--ephemeral",
                "-o", output_file,
                prompt,
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=120,
        )

        if os.path.exists(output_file):
            output = open(output_file).read().strip()
            # Find JSON object in output
            json_match = re.search(r'\{[\s\S]*\}', output)
            if json_match:
                corrections = json.loads(json_match.group())
                fixed = 0
                for i, q in enumerate(batch):
                    corr = corrections.get(str(i))
                    if corr and isinstance(corr, list) and len(corr) > 0:
                        # Update line ranges from Spark's corrections
                        for j, new_ref in enumerate(corr):
                            if j < len(q["relevant"]):
                                old = q["relevant"][j]
                                if new_ref.get("start_line") and new_ref.get("end_line"):
                                    old["start_line"] = new_ref["start_line"]
                                    old["end_line"] = new_ref["end_line"]
                                    fixed += 1
                print(f"    Batch {batch_id}: fixed {fixed} line ranges")
                return batch

        print(f"    Batch {batch_id}: no corrections (keeping originals)")
        return batch

    except Exception as e:
        print(f"    Batch {batch_id}: failed ({e}), keeping originals")
        return batch
    finally:
        shutil.rmtree(agent_home, ignore_errors=True)


def run():
    print("POC 4c: Fix golden query line ranges via Codex Spark\n")

    queries = json.loads(QUERIES_PATH.read_text())
    print(f"  Loaded {len(queries)} queries from {QUERIES_PATH.name}")

    # Split into batches
    batches = []
    for i in range(0, len(queries), BATCH_SIZE):
        batches.append((queries[i:i + BATCH_SIZE], i // BATCH_SIZE))

    print(f"  {len(batches)} batches of {BATCH_SIZE}, {MAX_WORKERS} concurrent Spark agents\n")

    t0 = time.perf_counter()
    fixed_queries = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(fix_batch, batch, bid): bid
            for batch, bid in batches
        }
        for future in concurrent.futures.as_completed(futures):
            bid = futures[future]
            try:
                result = future.result()
                fixed_queries.extend(result)
            except Exception as e:
                print(f"    Batch {bid}: EXCEPTION ({e})")
                # Keep originals for this batch
                batch_queries = [b for b, i in batches if i == bid]
                if batch_queries:
                    fixed_queries.extend(batch_queries[0])

    elapsed = time.perf_counter() - t0
    print(f"\n  Done in {elapsed:.0f}s")

    # Re-sort by original order (futures complete out of order)
    id_order = {q["id"]: i for i, q in enumerate(queries)}
    fixed_queries.sort(key=lambda q: id_order.get(q.get("id"), 999999))

    # Save
    QUERIES_PATH.write_text(json.dumps(fixed_queries, indent=2) + "\n", encoding="utf-8")
    print(f"  Saved {len(fixed_queries)} queries back to {QUERIES_PATH.name}")


if __name__ == "__main__":
    run()
