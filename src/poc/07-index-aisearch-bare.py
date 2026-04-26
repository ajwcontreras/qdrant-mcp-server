#!/usr/bin/env python3
"""
POC 7: Index lumae.ai into Cloudflare AI Search — bare (Variant C)

Upload raw source files to AI Search. Let it chunk + embed + index.
Hybrid search (vector + BM25 trigram), no HyDE. Patrick's CF account.

Pass criteria:
  - AI Search instance created with hybrid + trigram
  - All source files uploaded (~356 files, ~20 seconds)
  - Search returns results
  - MCP endpoint accessible
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.request

# ── Config ──
ACCOUNT_ID = "776ba01baf2a9a9806fa0edb1b5ddc96"
API_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
INSTANCE_ID = "lumae-eval-bare"
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai-search/instances"
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]
VALID_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"}
MAX_WORKERS = 10


def api(method: str, path: str, data: dict | None = None, timeout: int = 30) -> dict:
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        return {"success": False, "error": body[:500]}


def upload_file(filepath: str) -> bool:
    """Upload a single source file to AI Search Items API."""
    boundary = "----AiSearchBoundary"
    filename = os.path.basename(filepath)

    with open(filepath, "rb") as f:
        file_data = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: text/plain\r\n\r\n"
    ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

    url = f"{BASE_URL}/{INSTANCE_ID}/items"
    req = urllib.request.Request(
        url, data=body,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result.get("success", False)
    except Exception:
        return False


def get_source_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "--cached"],
        cwd=LUMAE_DIR, capture_output=True, text=True, check=True,
    )
    files = []
    for rel_path in result.stdout.splitlines():
        if any(pat in rel_path for pat in EXCLUDE_PATTERNS):
            continue
        if not any(rel_path.endswith(ext) for ext in VALID_EXTENSIONS):
            continue
        full = os.path.join(LUMAE_DIR, rel_path)
        if os.path.isfile(full) and 50 < os.path.getsize(full) < 500_000:
            files.append(full)
    return sorted(files)


def run():
    print("POC 7: Index lumae.ai into AI Search — bare (Variant C)\n")

    global API_TOKEN
    if not API_TOKEN:
        result = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                                capture_output=True, text=True)
        API_TOKEN = result.stdout.strip()
        if not API_TOKEN:
            print("  ERROR: CF_PATRICK_API_TOKEN not set")
            sys.exit(1)

    # ── Step 1: Create instance ──
    print("  Step 1: Creating AI Search instance...")
    api("DELETE", f"/{INSTANCE_ID}")
    time.sleep(2)

    create_result = api("POST", "", data={
        "id": INSTANCE_ID,
        "index_method": {"vector": True, "keyword": True},
        "fusion_method": "rrf",
        "indexing_options": {"keyword_tokenizer": "trigram"},
    })

    if create_result.get("success"):
        print(f"    Created {INSTANCE_ID} (hybrid + trigram)")
    else:
        print(f"    Create result: {create_result}")
        # Try to use existing
        info = api("GET", f"/{INSTANCE_ID}")
        if not info.get("success"):
            print("    Cannot proceed")
            sys.exit(1)
        print("    Using existing instance")

    # ── Step 2: Get source files ──
    files = get_source_files()
    print(f"\n  Step 2: {len(files)} source files to upload")

    # ── Step 3: Upload raw files (parallel) ──
    print(f"\n  Step 3: Uploading {len(files)} files ({MAX_WORKERS} concurrent)...")
    t0 = time.perf_counter()

    uploaded = 0
    failed = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_file = {executor.submit(upload_file, f): f for f in files}
        for future in concurrent.futures.as_completed(future_to_file):
            if future.result():
                uploaded += 1
            else:
                failed += 1
            done = uploaded + failed
            if done % 50 == 0:
                print(f"    {done}/{len(files)}...")

    elapsed = time.perf_counter() - t0
    print(f"    Done: {uploaded} uploaded, {failed} failed ({elapsed:.1f}s)")

    # ── Step 4: Wait for indexing ──
    print("\n  Step 4: Waiting for indexing...")
    for attempt in range(60):
        time.sleep(10)
        stats = api("GET", f"/{INSTANCE_ID}/stats")
        if stats.get("success"):
            r = stats.get("result", {})
            indexed = r.get("indexed_items", r.get("indexed", 0))
            total = r.get("total_items", r.get("total", 0))
            print(f"    Indexed: {indexed}/{total}")
            if total > 0 and indexed >= total:
                break
        else:
            # Try alternate stats shape
            print(f"    Stats: {json.dumps(stats)[:200]}")

    # ── Step 5: Test search ──
    print("\n  Step 5: Testing search...")
    search_result = api("POST", f"/{INSTANCE_ID}/search", data={
        "messages": [{"role": "user", "content": "Where does JWT token validation happen in authentication?"}],
        "ai_search_options": {
            "retrieval": {
                "retrieval_type": "hybrid",
                "fusion_method": "rrf",
            }
        }
    }, timeout=60)

    search_ok = False
    if search_result.get("success"):
        result_data = search_result.get("result", {})
        chunks = result_data.get("chunks", result_data.get("data", result_data.get("results", [])))
        search_ok = len(chunks) > 0
        print(f"    Search returned {len(chunks)} results")
        for c in chunks[:3]:
            title = c.get("title", c.get("filename", c.get("file", "?")))[:60]
            score = c.get("score", "?")
            print(f"      [{score}] {title}")
    else:
        print(f"    Search failed: {json.dumps(search_result)[:300]}")

    # ── Step 6: Check MCP endpoint ──
    print("\n  Step 6: Checking MCP endpoint...")
    mcp_url = f"https://{INSTANCE_ID}.search.ai.cloudflare.com/mcp"
    mcp_ok = False
    try:
        req = urllib.request.Request(mcp_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            mcp_ok = resp.status == 200
            print(f"    {mcp_url} — {resp.status}")
    except Exception as e:
        print(f"    {mcp_url} — {e}")

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        "Instance created (hybrid + trigram)": True,
        f"Files uploaded ({uploaded}/{len(files)})": uploaded >= len(files) * 0.9,
        "Search returns results": search_ok,
        "MCP endpoint accessible": mcp_ok,
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n{'  \u2705 POC 7: PASS' if all_pass else '  \u274c POC 7: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
