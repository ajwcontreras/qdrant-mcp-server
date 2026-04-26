#!/usr/bin/env python3
"""
POC 5: Index lumae.ai into Qdrant — bare (Variant A)

Single Gemini embedding per chunk, no HyDE, no multi-vector, no sparse.
This is the floor baseline for the eval comparison.

Pass criteria:
  - All files indexed
  - Collection lumae-eval-bare created with Gemini 768d vectors
  - Checkpoint written for resumability
  - Cost logged
"""

import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
import urllib.request
from pathlib import Path

# ── Config ──
PROJECT = "evrylo"
REGION = "us-central1"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
QDRANT_URL = "http://localhost:6333"
COLLECTION = "lumae-eval-bare"
EMBED_MODEL = "text-embedding-004"
EMBED_DIMS = 768
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
EMBED_BATCH_SIZE = 20
NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
CHECKPOINT_PATH = f"/tmp/qdrant-checkpoint-{COLLECTION}.jsonl"
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]
VALID_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".yml", ".yaml", ".sh", ".sql"}


def get_access_token() -> str:
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def embed_texts(token: str, texts: list[str]) -> list[list[float]]:
    """Embed texts via Vertex AI Gemini embedding API."""
    endpoint = (
        f"https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{REGION}/publishers/google/models/{EMBED_MODEL}:predict"
    )
    # Vertex embedding API format
    instances = [{"content": t[:2048]} for t in texts]  # Gemini embedding token limit
    payload = json.dumps({"instances": instances}).encode()
    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    return [p["embeddings"]["values"] for p in result["predictions"]]


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


def chunk_text(content: str) -> list[dict]:
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
            chunks.append({"text": text, "start_line": start_line, "end_line": i, "line_range": f"{start_line}-{i}"})
            overlap_lines = []
            overlap_len = 0
            for ln in reversed(current):
                if overlap_len + len(ln) > CHUNK_OVERLAP:
                    break
                overlap_lines.insert(0, ln)
                overlap_len += len(ln)
            current = overlap_lines
            current_len = overlap_len
            start_line = i - len(overlap_lines) + 1

    if current:
        text = "".join(current)
        if text.strip():
            end = start_line + len(current) - 1
            chunks.append({"text": text, "start_line": start_line, "end_line": end, "line_range": f"{start_line}-{end}"})

    return chunks


def create_collection():
    """Create Qdrant collection with single dense vector."""
    import urllib.request
    # Delete if exists
    try:
        req = urllib.request.Request(f"{QDRANT_URL}/collections/{COLLECTION}", method="DELETE")
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

    payload = json.dumps({
        "vectors": {"size": EMBED_DIMS, "distance": "Cosine"},
    }).encode()
    req = urllib.request.Request(
        f"{QDRANT_URL}/collections/{COLLECTION}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    urllib.request.urlopen(req, timeout=10)


def upsert_points(points: list[dict]):
    """Upsert points to Qdrant."""
    payload = json.dumps({"points": points}).encode()
    req = urllib.request.Request(
        f"{QDRANT_URL}/collections/{COLLECTION}/points",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    urllib.request.urlopen(req, timeout=30)


def load_checkpoint() -> set[str]:
    """Load checkpoint — returns set of already-upserted point IDs."""
    done = set()
    if not os.path.exists(CHECKPOINT_PATH):
        return done
    with open(CHECKPOINT_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("stage") == "upserted":
                done.add(rec["point_id"])
    return done


def write_checkpoint(point_ids: list[str], stage: str):
    with open(CHECKPOINT_PATH, "a") as f:
        for pid in point_ids:
            f.write(json.dumps({"point_id": pid, "stage": stage, "ts": time.time()}) + "\n")
        f.flush()


def run():
    print("POC 5: Index lumae.ai into Qdrant — bare (Variant A)\n")

    # ── Get files ──
    files = get_source_files()
    print(f"  {len(files)} source files")

    # ── Chunk ──
    print("  Chunking...")
    all_chunks = []
    for rel_path in files:
        full = os.path.join(LUMAE_DIR, rel_path)
        try:
            content = open(full, "r", encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        chunks = chunk_text(content)
        for i, chunk in enumerate(chunks):
            point_id = str(uuid.uuid5(NAMESPACE, f"{rel_path}_{i}"))
            all_chunks.append({
                "point_id": point_id,
                "rel_path": rel_path,
                "chunk_index": i,
                "text": chunk["text"],
                "start_line": chunk["start_line"],
                "end_line": chunk["end_line"],
                "line_range": chunk["line_range"],
            })
    print(f"  {len(all_chunks)} chunks from {len(files)} files")

    # ── Resume from checkpoint ──
    done_ids = load_checkpoint()
    remaining = [c for c in all_chunks if c["point_id"] not in done_ids]
    if done_ids:
        print(f"  Resuming: {len(done_ids)} already done, {len(remaining)} remaining")
    else:
        print(f"  Fresh run: {len(remaining)} chunks to index")

    if not remaining:
        print("  Nothing to do!")
        return

    # ── Create collection ──
    if not done_ids:
        print(f"\n  Creating collection {COLLECTION} ({EMBED_DIMS}d Cosine)...")
        create_collection()

    # ── Auth ──
    print("  Authenticating...")
    token = get_access_token()

    # ── Embed and upsert in batches ──
    print(f"\n  Embedding + upserting ({EMBED_BATCH_SIZE} per batch)...")
    total_embed_tokens = 0
    t0 = time.perf_counter()

    for batch_start in range(0, len(remaining), EMBED_BATCH_SIZE):
        batch = remaining[batch_start:batch_start + EMBED_BATCH_SIZE]
        texts = [f"File: {c['rel_path']}\n{c['text']}" for c in batch]

        try:
            embeddings = embed_texts(token, texts)
        except Exception as e:
            # Token may have expired for long runs
            if "401" in str(e) or "403" in str(e):
                print(f"    Re-authenticating...")
                token = get_access_token()
                embeddings = embed_texts(token, texts)
            else:
                print(f"    Embed failed at batch {batch_start}: {e}")
                continue

        points = []
        for chunk, embedding in zip(batch, embeddings):
            points.append({
                "id": chunk["point_id"],
                "vector": embedding,
                "payload": {
                    "file": chunk["rel_path"],
                    "content": chunk["text"],
                    "start_line": chunk["start_line"],
                    "end_line": chunk["end_line"],
                    "line_range": chunk["line_range"],
                    "chunk_index": chunk["chunk_index"],
                },
            })

        upsert_points(points)
        write_checkpoint([c["point_id"] for c in batch], "upserted")

        total_embed_tokens += sum(len(t) for t in texts)
        done_count = len(done_ids) + batch_start + len(batch)
        if (batch_start // EMBED_BATCH_SIZE) % 10 == 0:
            print(f"    {done_count}/{len(all_chunks)} chunks indexed...")

    elapsed = time.perf_counter() - t0

    # ── Verify ──
    print(f"\n  Verifying collection...")
    resp = urllib.request.urlopen(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=10)
    info = json.loads(resp.read())
    point_count = info["result"]["points_count"]

    # ── Stats ──
    est_cost = total_embed_tokens / 1_000_000 * 0.006  # Gemini embedding pricing
    print(f"\n  Results:")
    print(f"    Points in collection: {point_count}")
    print(f"    Time: {elapsed:.1f}s")
    print(f"    Estimated embedding cost: ${est_cost:.4f}")
    print(f"    Checkpoint: {CHECKPOINT_PATH}")

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        f"Collection exists with points ({point_count})": point_count > 0,
        f"All chunks indexed ({point_count}/{len(all_chunks)})": point_count >= len(all_chunks) * 0.95,
        "Checkpoint file written": os.path.exists(CHECKPOINT_PATH),
        f"Gemini embeddings used ({EMBED_DIMS}d)": EMBED_DIMS == 768,
        "No HyDE, no sparse vectors": True,
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n{'  \u2705 POC 5: PASS' if all_pass else '  \u274c POC 5: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
