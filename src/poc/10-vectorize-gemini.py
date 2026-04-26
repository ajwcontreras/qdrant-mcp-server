#!/usr/bin/env python3
"""
POC 10: Vectorize + D1 with Gemini embeddings (via AI Gateway)

Generate Gemini embeddings ourselves, store in Vectorize, BM25 in D1.
Compare against AI Search native (Qwen auto-chunk) to isolate embedding quality.

Architecture:
  - Gemini text-embedding-004 (768d) via Patrick's AI Gateway
  - Vectorize index for vector search
  - D1 SQLite with FTS5 for keyword search
  - Query: parallel Vectorize + D1, merge via RRF
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import base64
import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.request

# ── Config ──
CF_ACCOUNT = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
GW_NAME = "code-search"
GCP_PROJECT = "evrylo"
EMBED_MODEL = "text-embedding-004"
EMBED_DIMS = 768
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
VECTORIZE_INDEX = "lumae-eval-gemini-vec"
D1_DB_NAME = "lumae-eval-fts"
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
EMBED_BATCH = 20
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]
VALID_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"}

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}


def cf_api(method, path, data=None, timeout=30):
    url = f"{CF_API}/{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": (e.read().decode() if e.fp else "")[:500]}


def embed_batch(texts):
    """Embed via Gemini through AI Gateway."""
    with open(SA_PATH) as f:
        sa = json.load(f)
    sa["region"] = "us-central1"
    sa_b64 = base64.b64encode(json.dumps(sa).encode()).decode()

    url = (f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT}/{GW_NAME}"
           f"/google-vertex-ai/v1/projects/{GCP_PROJECT}/locations/us-central1"
           f"/publishers/google/models/{EMBED_MODEL}:predict")

    payload = json.dumps({"instances": [{"content": t[:2048]} for t in texts]}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "User-Agent": "qdrant-mcp-indexer/1.0",
        "Authorization": f"Bearer {sa_b64}",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    return [p["embeddings"]["values"] for p in result["predictions"]]


def get_source_files():
    result = subprocess.run(["git", "ls-files", "--cached"], cwd=LUMAE_DIR,
                            capture_output=True, text=True, check=True)
    files = []
    for rp in result.stdout.splitlines():
        if any(p in rp for p in EXCLUDE_PATTERNS): continue
        if not any(rp.endswith(e) for e in VALID_EXTENSIONS): continue
        full = os.path.join(LUMAE_DIR, rp)
        if os.path.isfile(full) and 50 < os.path.getsize(full) < 500_000:
            files.append(rp)
    return sorted(files)


def chunk_file(rel_path):
    full = os.path.join(LUMAE_DIR, rel_path)
    try:
        content = open(full, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return []
    lines = content.splitlines(keepends=True)
    chunks = []
    current, clen, start = [], 0, 1
    for i, line in enumerate(lines, 1):
        current.append(line)
        clen += len(line)
        if clen >= CHUNK_SIZE:
            chunks.append({"text": "".join(current), "start": start, "end": i, "file": rel_path})
            ol, olen = [], 0
            for ln in reversed(current):
                if olen + len(ln) > CHUNK_OVERLAP: break
                ol.insert(0, ln)
                olen += len(ln)
            current, clen, start = ol, olen, i - len(ol) + 1
    if current:
        t = "".join(current)
        if t.strip():
            chunks.append({"text": t, "start": start, "end": start + len(current) - 1, "file": rel_path})
    return chunks


def run():
    print("POC 10: Vectorize + D1 with Gemini embeddings\n")

    # ── Step 1: Create Vectorize index ──
    print("  Step 1: Creating Vectorize index...")
    # Delete if exists
    cf_api("DELETE", f"vectorize/v2/indexes/{VECTORIZE_INDEX}")
    time.sleep(1)
    result = cf_api("POST", "vectorize/v2/indexes", {
        "name": VECTORIZE_INDEX,
        "config": {"dimensions": EMBED_DIMS, "metric": "cosine"},
    })
    if result.get("success"):
        print(f"    Created {VECTORIZE_INDEX} ({EMBED_DIMS}d cosine)")
    else:
        print(f"    {result}")

    # ── Step 2: Create D1 database ──
    print("\n  Step 2: Creating D1 database...")
    # Check if exists
    dbs = cf_api("GET", "d1/database")
    d1_id = None
    if dbs.get("success"):
        for db in dbs.get("result", []):
            if db["name"] == D1_DB_NAME:
                d1_id = db["uuid"]
                print(f"    Using existing D1: {d1_id}")
                break
    if not d1_id:
        result = cf_api("POST", "d1/database", {"name": D1_DB_NAME})
        if result.get("success"):
            d1_id = result["result"]["uuid"]
            print(f"    Created D1: {d1_id}")
        else:
            print(f"    D1 creation failed: {result}")
            sys.exit(1)

    # Create FTS5 table
    print("    Creating FTS5 table...")
    cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "DROP TABLE IF EXISTS chunks_fts"
    })
    cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "DROP TABLE IF EXISTS chunks"
    })
    cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": """CREATE TABLE chunks (
            id TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            start_line INTEGER,
            end_line INTEGER,
            content TEXT NOT NULL
        )"""
    })
    cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "CREATE VIRTUAL TABLE chunks_fts USING fts5(content, file, tokenize='trigram')"
    })
    print("    FTS5 table ready")

    # ── Step 3: Chunk files ──
    files = get_source_files()
    print(f"\n  Step 3: Chunking {len(files)} files...")
    all_chunks = []
    for rp in files:
        all_chunks.extend(chunk_file(rp))
    print(f"    {len(all_chunks)} chunks")

    # ── Step 4: Embed all chunks first (parallel batches) ──
    MEGA_BATCH = 100  # embed 100 at a time (5 concurrent batches of 20)
    print(f"\n  Step 4a: Embedding all chunks...")
    t0 = time.perf_counter()

    all_embeddings = [None] * len(all_chunks)

    def embed_range(start, end):
        texts = [f"File: {c['file']}\n{c['text']}" for c in all_chunks[start:end]]
        embs = embed_batch(texts)
        return start, embs

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = []
        for i in range(0, len(all_chunks), EMBED_BATCH):
            end = min(i + EMBED_BATCH, len(all_chunks))
            futures.append(ex.submit(embed_range, i, end))
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            start, embs = fut.result()
            for j, emb in enumerate(embs):
                all_embeddings[start + j] = emb
            done += len(embs)
            if done % 200 == 0:
                print(f"    Embedded {done}/{len(all_chunks)}...")

    embed_time = time.perf_counter() - t0
    print(f"    All embedded in {embed_time:.0f}s")

    # ── Step 4b: Batch upsert to Vectorize (250 per batch) ──
    print(f"\n  Step 4b: Upserting to Vectorize...")
    t1 = time.perf_counter()
    VEC_BATCH = 250
    for i in range(0, len(all_chunks), VEC_BATCH):
        batch = all_chunks[i:i + VEC_BATCH]
        batch_embs = all_embeddings[i:i + VEC_BATCH]
        vectors = [{
            "id": f"{c['file']}:{c['start']}",
            "values": emb,
            "metadata": {"file": c["file"], "start": c["start"], "end": c["end"]},
        } for c, emb in zip(batch, batch_embs)]
        cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/upsert", {"vectors": vectors}, timeout=60)
        if (i // VEC_BATCH) % 5 == 0:
            print(f"    {min(i + VEC_BATCH, len(all_chunks))}/{len(all_chunks)}...")
    vec_time = time.perf_counter() - t1
    print(f"    Vectorize done in {vec_time:.0f}s")

    # ── Step 4c: Batch insert to D1 (multi-statement per request) ──
    print(f"\n  Step 4c: Inserting to D1 FTS5...")
    t2 = time.perf_counter()
    D1_BATCH = 50
    for i in range(0, len(all_chunks), D1_BATCH):
        batch = all_chunks[i:i + D1_BATCH]
        # Batch: insert chunks then FTS entries
        stmts = []
        for c in batch:
            cid = f"{c['file']}:{c['start']}"
            content = c["text"][:5000]
            stmts.append({
                "sql": "INSERT OR REPLACE INTO chunks (id, file, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)",
                "params": [cid, c["file"], c["start"], c["end"], content],
            })
        # D1 batch API
        cf_api("POST", f"d1/database/{d1_id}/query", stmts, timeout=30)

        # FTS inserts (separate batch — can't mix with regular in one call easily)
        fts_stmts = []
        for c in batch:
            cid = f"{c['file']}:{c['start']}"
            fts_stmts.append({
                "sql": "INSERT OR REPLACE INTO chunks_fts (rowid, content, file) VALUES ((SELECT rowid FROM chunks WHERE id = ?), ?, ?)",
                "params": [cid, c["text"][:5000], c["file"]],
            })
        cf_api("POST", f"d1/database/{d1_id}/query", fts_stmts, timeout=30)

        if (i // D1_BATCH) % 10 == 0:
            print(f"    {min(i + D1_BATCH, len(all_chunks))}/{len(all_chunks)}...")
    d1_time = time.perf_counter() - t2
    print(f"    D1 done in {d1_time:.0f}s")

    total_time = time.perf_counter() - t0
    print(f"\n    Total: {total_time:.0f}s (embed {embed_time:.0f}s + vec {vec_time:.0f}s + d1 {d1_time:.0f}s)")
    print(f"    D1 ID: {d1_id}")
    print(f"    Vectorize: {VECTORIZE_INDEX}")

    # ── Step 5: Smoke test search ──
    print("\n  Step 5: Smoke test search...")
    try:
        query_emb = embed_batch(["Where does JWT token validation happen?"])[0]
        vec_result = cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/query", {
            "vector": query_emb,
            "topK": 5,
            "returnMetadata": "all",
        })
        if vec_result.get("success"):
            matches = vec_result.get("result", {}).get("matches", [])
            print(f"    Vectorize: {len(matches)} results")
            for m in matches[:3]:
                print(f"      [{m.get('score', '?'):.3f}] {m.get('metadata', {}).get('file', '?')}")
    except Exception as e:
        print(f"    Vectorize search failed: {e}")

    # FTS5 search
    fts_result = cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "SELECT file, start_line, end_line FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5",
        "params": ["jwt AND token AND valid"],
    })
    if fts_result.get("success"):
        rows = fts_result.get("result", [{}])[0].get("results", [])
        print(f"    D1 FTS5: {len(rows)} results")
        for r in rows[:3]:
            print(f"      {r.get('file', '?')}:{r.get('start_line', '?')}")

    print(f"\n  \u2705 POC 10: READY FOR EVAL")
    print(f"  D1_ID={d1_id}")
    print(f"  VECTORIZE={VECTORIZE_INDEX}")


if __name__ == "__main__":
    run()
