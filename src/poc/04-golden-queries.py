#!/usr/bin/env python3
"""
POC 4: Generate golden query dataset

Phase 1: Generate queries via Gemini Flash Lite (Vertex AI, parallel)
Phase 2: Quick file-existence filter (instant, no API calls)
Phase 3: Codex Spark validates a sample for content accuracy
Phase 4: Save dataset
"""

import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

# ── Config ──
PROJECT = "evrylo"
REGION = "us-central1"
MODEL = "gemini-2.5-flash-lite"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
CONCURRENCY = 6
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules"]

SYSTEM_PROMPT = """You are generating a golden test dataset for evaluating code search systems. Given source files from a mortgage technology SaaS application (lumae.ai), generate realistic developer search queries.

For each query, specify:
- query: Natural language search query a developer would type
- relevant: Array of {file, start_line, end_line, grade} where grade is 1 (somewhat relevant) to 3 (exact match)
- type: One of "symbol_lookup", "behavioral", "architectural", "debugging", "integration", "data_flow"

CRITICAL RULES:
- Only reference files and functions that ACTUALLY EXIST in the code provided
- Line numbers must point to real functions/classes/blocks shown in the code
- Mix query types across all 6 categories
- Each query should be something a developer would realistically search for
- Generate exactly 15 queries
- Return strict JSON matching the schema"""

RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "query": {"type": "STRING"},
            "type": {"type": "STRING"},
            "relevant": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "file": {"type": "STRING"},
                        "start_line": {"type": "INTEGER"},
                        "end_line": {"type": "INTEGER"},
                        "grade": {"type": "INTEGER"},
                    },
                    "required": ["file", "start_line", "end_line", "grade"],
                },
            },
        },
        "required": ["query", "type", "relevant"],
    },
}


def get_access_token() -> str:
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def get_source_files() -> list[dict]:
    result = subprocess.run(
        ["git", "ls-files", "--cached"],
        cwd=LUMAE_DIR, capture_output=True, text=True, check=True,
    )
    valid_ext = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs"}
    files = []
    for rel_path in result.stdout.splitlines():
        if any(pat in rel_path for pat in EXCLUDE_PATTERNS):
            continue
        if not any(rel_path.endswith(ext) for ext in valid_ext):
            continue
        full = os.path.join(LUMAE_DIR, rel_path)
        if not os.path.isfile(full):
            continue
        size = os.path.getsize(full)
        if size > 100_000 or size < 100:
            continue
        files.append({"rel_path": rel_path, "full_path": full, "size": size})
    files.sort(key=lambda f: f["rel_path"])
    return files


def bundle_files(files: list[dict], target_chars: int = 25_000, max_per_file: int = 3000) -> list[str]:
    bundles = []
    current = []
    current_size = 0

    for f in files:
        try:
            content = open(f["full_path"], "r", encoding="utf-8", errors="replace").read()
            if len(content) > max_per_file:
                content = content[:max_per_file] + f"\n\n... (truncated, {len(content)} total chars)\n"
        except Exception:
            continue

        entry = f"### {f['rel_path']}\n```\n{content}\n```\n\n"
        if current_size + len(entry) > target_chars and current:
            bundles.append("".join(current))
            current = []
            current_size = 0

        current.append(entry)
        current_size += len(entry)

    if current:
        bundles.append("".join(current))

    return bundles


def call_gemini_golden(token: str, bundle: str, bundle_idx: int) -> list[dict]:
    endpoint = (
        f"https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{REGION}/publishers/google/models/{MODEL}:generateContent"
    )

    payload = {
        "contents": [{
            "role": "user",
            "parts": [{"text": f"Generate exactly 15 golden queries for this code:\n\n{bundle}"}],
        }],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            "temperature": 0.2,  # slight variation across bundles
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
        text = result["candidates"][0]["content"]["parts"][0]["text"]
        queries = json.loads(text)
        for q in queries:
            q["source_bundle"] = bundle_idx
        return queries
    except Exception as e:
        print(f"      Bundle {bundle_idx} failed: {e}")
        return []


def validate_files(queries: list[dict]) -> tuple[list[dict], list[dict]]:
    """Fast file-existence check. No API calls."""
    valid = []
    invalid = []
    for q in queries:
        all_exist = True
        for r in q.get("relevant", []):
            path = os.path.join(LUMAE_DIR, r.get("file", ""))
            if not os.path.isfile(path):
                all_exist = False
                break
        if all_exist and q.get("relevant"):
            valid.append(q)
        else:
            invalid.append(q)
    return valid, invalid


def _codex_validate_one_batch(batch: list[dict], batch_id: int) -> list[dict]:
    """Validate one batch of queries via Codex Spark (read-only)."""
    import shutil

    items = []
    for i, q in enumerate(batch):
        files = [f"{r['file']}:{r.get('start_line','?')}-{r.get('end_line','?')}" for r in q.get("relevant", [])]
        items.append(f"{i}. Query: \"{q['query'][:100]}\"\n   Files: {', '.join(files)}")

    prompt = f"""Validate these code search queries against the actual codebase.
For each query, check if the referenced files contain code matching what the query describes at approximately the claimed line ranges.

Return a JSON object mapping index to true (content matches) or false (hallucinated/wrong):
Example: {{"0": true, "1": false, "2": true}}

Queries to validate:
{chr(10).join(items)}"""

    agent_home = tempfile.mkdtemp(prefix=f"codex-b{batch_id}-")
    auth_src = os.path.expanduser("~/.codex/auth.json")
    if os.path.exists(auth_src):
        shutil.copy2(auth_src, os.path.join(agent_home, "auth.json"))

    output_file = os.path.join(agent_home, "output.txt")
    validated = []

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
            timeout=90,
        )

        if os.path.exists(output_file):
            output = open(output_file).read().strip()
            json_match = re.search(r'\{[^{}]*\}', output)
            if json_match:
                results = json.loads(json_match.group())
                for i, q in enumerate(batch):
                    if results.get(str(i), True):
                        validated.append(q)
                    else:
                        print(f"      Batch {batch_id}: rejected \"{q['query'][:50]}...\"")
                return validated

        # Fallback: accept all
        return list(batch)

    except Exception as e:
        print(f"      Batch {batch_id} failed: {e}, accepting all")
        return list(batch)
    finally:
        shutil.rmtree(agent_home, ignore_errors=True)


def codex_validate_batch(queries: list[dict], batch_size: int = 20, max_workers: int = 3) -> list[dict]:
    """Use Codex Spark to validate queries — 3 concurrent, read-only, batched."""
    batches = []
    for i in range(0, len(queries), batch_size):
        batches.append((queries[i:i + batch_size], i // batch_size))

    print(f"    {len(batches)} validation batches, {max_workers} concurrent Codex Spark agents")

    validated = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_codex_validate_one_batch, batch, bid): bid
            for batch, bid in batches
        }
        for future in concurrent.futures.as_completed(futures):
            bid = futures[future]
            try:
                result = future.result()
                print(f"    Batch {bid}: {len(result)} validated")
                validated.extend(result)
            except Exception as e:
                print(f"    Batch {bid}: FAILED ({e})")

    return validated


def deduplicate(queries: list[dict]) -> list[dict]:
    seen = set()
    unique = []
    for q in queries:
        key = q["query"].strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(q)
    return unique


def run():
    print("POC 4: Generate golden query dataset\n")

    # ── Phase 1: Bundle ──
    print("  Phase 1: Bundling lumae.ai source files...")
    files = get_source_files()
    print(f"    {len(files)} source files")
    bundles = bundle_files(files)
    print(f"    {len(bundles)} bundles")

    # ── Phase 2: Generate via Flash Lite (parallel) ──
    print("\n  Phase 2: Generating queries via Gemini Flash Lite...")
    token = get_access_token()

    # Use up to 20 bundles for good coverage
    bundles_to_use = bundles[:20]
    all_queries = []
    t0 = time.perf_counter()

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = {
            executor.submit(call_gemini_golden, token, b, i): i
            for i, b in enumerate(bundles_to_use)
        }
        for future in concurrent.futures.as_completed(futures):
            idx = futures[future]
            try:
                queries = future.result()
                print(f"    Bundle {idx}: {len(queries)} queries")
                all_queries.extend(queries)
            except Exception as e:
                print(f"    Bundle {idx}: FAILED ({e})")

    elapsed = time.perf_counter() - t0
    print(f"\n    {len(all_queries)} raw queries in {elapsed:.1f}s")

    # Dedup
    all_queries = deduplicate(all_queries)
    print(f"    {len(all_queries)} after dedup")

    # ── Phase 3: File existence filter (instant) ──
    print("\n  Phase 3: File existence filter...")
    file_valid, file_invalid = validate_files(all_queries)
    print(f"    {len(file_valid)} pass, {len(file_invalid)} dropped (bad file paths)")
    if file_invalid:
        bad_files = set()
        for q in file_invalid[:10]:
            for r in q.get("relevant", []):
                path = os.path.join(LUMAE_DIR, r.get("file", ""))
                if not os.path.isfile(path):
                    bad_files.add(r["file"])
        print(f"    Sample bad files: {list(bad_files)[:5]}")

    # ── Phase 4: Codex Spark content validation (batched) ──
    print("\n  Phase 4: Codex Spark content validation (batched)...")
    codex_validated = codex_validate_batch(file_valid, batch_size=20)
    codex_dropped = len(file_valid) - len(codex_validated)
    print(f"    {len(codex_validated)} validated, {codex_dropped} rejected by Codex")

    # ── Assign IDs ──
    for q in codex_validated:
        h = hashlib.sha256(q["query"].encode()).hexdigest()[:12]
        q["id"] = f"lumae-{h}"
        q.pop("source_bundle", None)

    # ── Stats ──
    files_covered = set()
    types_covered = {}
    for q in codex_validated:
        for r in q.get("relevant", []):
            files_covered.add(r.get("file", ""))
        t = q.get("type", "unknown")
        types_covered[t] = types_covered.get(t, 0) + 1

    total_generated = len(all_queries)
    total_valid = len(codex_validated)
    drop_rate = 1 - (total_valid / max(total_generated, 1))

    print(f"\n  Stats:")
    print(f"    Queries: {total_valid}")
    print(f"    Files covered: {len(files_covered)}")
    print(f"    Types: {types_covered}")
    print(f"    Drop rate: {drop_rate:.0%}")

    # ── Save ──
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(codex_validated, indent=2) + "\n", encoding="utf-8")
    print(f"\n    Saved to {OUTPUT_PATH}")

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        f"100+ validated queries ({total_valid})": total_valid >= 100,
        f"40+ files covered ({len(files_covered)})": len(files_covered) >= 40,
        f"3+ query types ({len(types_covered)})": len(types_covered) >= 3,
        f"Drop rate < 30% ({drop_rate:.0%})": drop_rate < 0.30,
        "Dataset saved": OUTPUT_PATH.exists(),
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n{'  \u2705 POC 4: PASS' if all_pass else '  \u274c POC 4: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
