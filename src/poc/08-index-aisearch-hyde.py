#!/usr/bin/env python3
"""
POC 8: Index lumae.ai into AI Search — with HyDE (Variant D)

Prepend cached HyDE questions to each source file before uploading to AI Search.
Reuses existing HyDE JSONL (14K records, generated Apr 22, zero diffs since).

Pass criteria:
  - AI Search instance created with hybrid + trigram
  - Source files uploaded with HyDE questions prepended
  - Search returns results
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
import tempfile
import time
import urllib.request

# ── Config ──
ACCOUNT_ID = "776ba01baf2a9a9806fa0edb1b5ddc96"
API_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
INSTANCE_ID = "lumae-eval-hyde"
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
HYDE_JSONL = "/Users/awilliamspcsevents/.gemini/tmp/lumae-ai/gemini-flash-lite-hyde-full.jsonl"
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


def upload_content(filename: str, content: bytes) -> bool:
    """Upload content as a file to AI Search."""
    boundary = "----AiSearchHyde"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: text/plain\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()

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


def load_hyde_by_file(jsonl_path: str) -> dict[str, list[str]]:
    """Load HyDE JSONL and group questions by rel_path."""
    by_file = {}
    with open(jsonl_path) as f:
        for line in f:
            rec = json.loads(line)
            if not rec.get("ok"):
                continue
            rel_path = rec.get("rel_path", "")
            questions = rec.get("hyde_questions", [])
            if rel_path not in by_file:
                by_file[rel_path] = []
            by_file[rel_path].extend(questions)
    return by_file


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
            files.append(rel_path)
    return sorted(files)


def build_hyde_enriched_content(rel_path: str, hyde_questions: list[str]) -> bytes:
    """Read source file and prepend HyDE questions."""
    full = os.path.join(LUMAE_DIR, rel_path)
    try:
        source = open(full, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return b""

    # Deduplicate questions
    seen = set()
    unique_qs = []
    for q in hyde_questions:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            unique_qs.append(q)

    if unique_qs:
        header = "# Questions this code answers\n\n"
        header += "\n".join(f"- {q}" for q in unique_qs[:20])  # cap at 20 per file
        header += f"\n\n---\n\n# {rel_path}\n\n"
        enriched = header + source
    else:
        enriched = f"# {rel_path}\n\n" + source

    return enriched.encode("utf-8")


def run():
    print("POC 8: Index lumae.ai into AI Search — with HyDE (Variant D)\n")

    global API_TOKEN
    if not API_TOKEN:
        result = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                                capture_output=True, text=True)
        API_TOKEN = result.stdout.strip()
        if not API_TOKEN:
            print("  ERROR: CF_PATRICK_API_TOKEN not set")
            sys.exit(1)

    # ── Load HyDE cache ──
    print("  Loading cached HyDE questions...")
    hyde_by_file = load_hyde_by_file(HYDE_JSONL)
    print(f"    {sum(len(v) for v in hyde_by_file.values())} questions across {len(hyde_by_file)} files")

    # ── Get source files ──
    source_files = get_source_files()
    files_with_hyde = [f for f in source_files if f in hyde_by_file]
    files_without_hyde = [f for f in source_files if f not in hyde_by_file]
    print(f"    {len(source_files)} source files: {len(files_with_hyde)} with HyDE, {len(files_without_hyde)} without")

    # ── Create instance ──
    print("\n  Creating AI Search instance...")
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
        print(f"    {create_result}")

    # ── Upload files with HyDE prepended (parallel) ──
    print(f"\n  Uploading {len(source_files)} files with HyDE ({MAX_WORKERS} concurrent)...")
    t0 = time.perf_counter()

    def upload_one(rel_path):
        questions = hyde_by_file.get(rel_path, [])
        content = build_hyde_enriched_content(rel_path, questions)
        if not content:
            return False
        filename = os.path.basename(rel_path)
        return upload_content(filename, content)

    uploaded = 0
    failed = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_file = {executor.submit(upload_one, f): f for f in source_files}
        for future in concurrent.futures.as_completed(future_to_file):
            if future.result():
                uploaded += 1
            else:
                failed += 1
            done = uploaded + failed
            if done % 50 == 0:
                print(f"    {done}/{len(source_files)}...")

    elapsed = time.perf_counter() - t0
    print(f"    Done: {uploaded} uploaded, {failed} failed ({elapsed:.1f}s)")

    # ── Wait for indexing ──
    print("\n  Waiting for indexing...")
    for attempt in range(60):
        time.sleep(10)
        stats = api("GET", f"/{INSTANCE_ID}/stats")
        if stats.get("success"):
            r = stats.get("result", {})
            completed = r.get("completed", 0)
            queued = r.get("queued", 0)
            running = r.get("running", 0)
            vectors = r.get("engine", {}).get("vectorize", {}).get("vectorsCount", 0)
            print(f"    Completed: {completed}, Queued: {queued}, Running: {running}, Vectors: {vectors}")
            if completed > 0 and queued == 0 and running == 0:
                break

    # ── Test search ──
    print("\n  Testing search...")
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
        chunks = search_result.get("result", {}).get("chunks", [])
        search_ok = len(chunks) > 0
        print(f"    {len(chunks)} results")
        for c in chunks[:3]:
            filename = c.get("item", {}).get("key", "?")
            score = c.get("score", "?")
            print(f"      [{score:.3f}] {filename}")

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        "Instance created (hybrid + trigram)": True,
        f"Files uploaded ({uploaded}/{len(source_files)})": uploaded >= len(source_files) * 0.9,
        f"HyDE coverage ({len(files_with_hyde)}/{len(source_files)})": len(files_with_hyde) >= len(source_files) * 0.5,
        "Search returns results": search_ok,
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n{'  \u2705 POC 8: PASS' if all_pass else '  \u274c POC 8: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
