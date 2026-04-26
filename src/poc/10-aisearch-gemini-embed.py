#!/usr/bin/env python3
"""
POC 10: AI Search with Gemini embeddings (auto-chunk)

Same as POC 7 but with google-ai-studio/gemini-embedding-001 instead of default Qwen.
Isolates: embedding model quality. Everything else held constant.
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

ACCOUNT_ID = "776ba01baf2a9a9806fa0edb1b5ddc96"
API_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
INSTANCE_ID = "lumae-eval-gemini"
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai-search/instances"
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]
VALID_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"}


def api(method, path, data=None, timeout=30):
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body,
        headers={"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": (e.read().decode() if e.fp else "")[:500]}


def upload_file(filepath):
    boundary = "----Upload"
    filename = os.path.basename(filepath)
    with open(filepath, "rb") as f:
        file_data = f.read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: text/plain\r\n\r\n").encode() + file_data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{BASE_URL}/{INSTANCE_ID}/items", data=body,
        headers={"Authorization": f"Bearer {API_TOKEN}", "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read()).get("success", False)
    except Exception:
        return False


def get_source_files():
    result = subprocess.run(["git", "ls-files", "--cached"], cwd=LUMAE_DIR, capture_output=True, text=True, check=True)
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
    print("POC 10: AI Search with Gemini embeddings (auto-chunk)\n")

    global API_TOKEN
    if not API_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"], capture_output=True, text=True)
        API_TOKEN = r.stdout.strip()

    # Create instance with Gemini embeddings
    print("  Creating instance with Gemini embeddings...")
    api("DELETE", f"/{INSTANCE_ID}")
    time.sleep(2)
    result = api("POST", "", data={
        "id": INSTANCE_ID,
        "index_method": {"vector": True, "keyword": True},
        "fusion_method": "rrf",
        "indexing_options": {"keyword_tokenizer": "trigram"},
        "embedding_model": "google-ai-studio/gemini-embedding-001",
    })
    print(f"    {result.get('success', False)} — embedding_model: {result.get('result', {}).get('embedding_model', '?')}")

    # Upload
    files = get_source_files()
    print(f"\n  Uploading {len(files)} files (10 concurrent)...")
    t0 = time.perf_counter()
    uploaded = failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(upload_file, f): f for f in files}
        for fut in concurrent.futures.as_completed(futs):
            if fut.result(): uploaded += 1
            else: failed += 1
            if (uploaded + failed) % 50 == 0:
                print(f"    {uploaded + failed}/{len(files)}...")
    print(f"    Done: {uploaded} uploaded, {failed} failed ({time.perf_counter() - t0:.1f}s)")

    # Wait for indexing
    print("\n  Waiting for indexing...")
    for _ in range(60):
        time.sleep(10)
        stats = api("GET", f"/{INSTANCE_ID}/stats")
        if stats.get("success"):
            r = stats.get("result", {})
            c, q, run = r.get("completed", 0), r.get("queued", 0), r.get("running", 0)
            v = r.get("engine", {}).get("vectorize", {}).get("vectorsCount", 0)
            print(f"    Completed: {c}, Running: {run}, Vectors: {v}")
            if c > 0 and q == 0 and run == 0:
                break

    print("\n  \u2705 POC 10: READY FOR EVAL")


if __name__ == "__main__":
    run()
