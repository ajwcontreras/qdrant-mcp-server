#!/usr/bin/env python3
"""
POC 11: AI Search with our pre-chunking vs auto-chunking (Gemini embeddings)

Upload pre-chunked files with chunk:false. Isolates: chunking strategy.
Both this and POC 10 use Gemini embeddings — difference is only chunking.
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
INSTANCE_ID = "lumae-eval-gemini-prechunk"
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai-search/instances"
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
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


def upload_content(filename, content_bytes):
    boundary = "----Upload"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: text/plain\r\n\r\n").encode() + content_bytes + f"\r\n--{boundary}--\r\n".encode()
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
            files.append(rel_path)
    return sorted(files)


def chunk_file(rel_path):
    full = os.path.join(LUMAE_DIR, rel_path)
    try:
        content = open(full, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return []

    lines = content.splitlines(keepends=True)
    chunks = []
    current = []
    current_len = 0
    start_line = 1

    for i, line in enumerate(lines, 1):
        current.append(line)
        current_len += len(line)
        if current_len >= CHUNK_SIZE:
            text = "".join(current)
            chunks.append({"text": text, "start_line": start_line, "end_line": i, "rel_path": rel_path})
            overlap = []
            olen = 0
            for ln in reversed(current):
                if olen + len(ln) > CHUNK_OVERLAP: break
                overlap.insert(0, ln)
                olen += len(ln)
            current = overlap
            current_len = olen
            start_line = i - len(overlap) + 1

    if current:
        text = "".join(current)
        if text.strip():
            end = start_line + len(current) - 1
            chunks.append({"text": text, "start_line": start_line, "end_line": end, "rel_path": rel_path})
    return chunks


def run():
    print("POC 11: AI Search with our pre-chunking (Gemini embeddings)\n")

    global API_TOKEN
    if not API_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"], capture_output=True, text=True)
        API_TOKEN = r.stdout.strip()

    # Create instance: chunk:false + Gemini
    print("  Creating instance (chunk:false, Gemini embeddings)...")
    api("DELETE", f"/{INSTANCE_ID}")
    time.sleep(2)
    result = api("POST", "", data={
        "id": INSTANCE_ID,
        "index_method": {"vector": True, "keyword": True},
        "fusion_method": "rrf",
        "indexing_options": {"keyword_tokenizer": "trigram"},
        "chunk": False,
        "embedding_model": "google-ai-studio/gemini-embedding-001",
    })
    print(f"    chunk: {result.get('result', {}).get('chunk')}, embedding: {result.get('result', {}).get('embedding_model')}")

    # Pre-chunk
    files = get_source_files()
    print(f"\n  Pre-chunking {len(files)} files...")
    all_chunks = []
    for rel_path in files:
        all_chunks.extend(chunk_file(rel_path))
    print(f"    {len(all_chunks)} chunks")

    # Upload each chunk as a separate file
    print(f"\n  Uploading {len(all_chunks)} pre-chunks (10 concurrent)...")
    t0 = time.perf_counter()
    uploaded = failed = 0

    def upload_one(chunk):
        safe = chunk["rel_path"].replace("/", "_").replace(".", "_")
        filename = f"{safe}__L{chunk['start_line']}-{chunk['end_line']}.txt"
        header = f"# {chunk['rel_path']} (lines {chunk['start_line']}-{chunk['end_line']})\n\n"
        content = (header + chunk["text"]).encode("utf-8")
        return upload_content(filename, content)

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs = list(ex.map(upload_one, all_chunks))
    for ok in futs:
        if ok: uploaded += 1
        else: failed += 1

    elapsed = time.perf_counter() - t0
    print(f"    Done: {uploaded} uploaded, {failed} failed ({elapsed:.1f}s)")

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

    print(f"\n  \u2705 POC 11: READY FOR EVAL ({uploaded} chunks indexed)")


if __name__ == "__main__":
    run()
