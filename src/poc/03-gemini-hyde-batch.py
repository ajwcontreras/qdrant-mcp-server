#!/usr/bin/env python3
"""
POC 3: Gemini Flash Lite HyDE generation at batch scale

Proves: We can efficiently generate HyDE questions for a batch of real code
chunks via concurrent Vertex AI calls, with error handling for individual
failures and fallback questions.

Input: 10 real chunks from lumae.ai codebase
Output: HyDE payloads in the shape the indexer expects

Pass criteria:
  - All 10 chunks get HyDE questions (Gemini or fallback)
  - At least 8/10 succeed via Gemini
  - Total wall time < 30 seconds (concurrency works)
  - Failed chunks get deterministic fallback questions
  - Output shape matches indexer's {point_id: {hyde_questions, hyde_text, hyde_model}}
"""

import concurrent.futures
import json
import os
import sys
import time
import urllib.request
import uuid

# ── Config ──
PROJECT = "evrylo"
REGION = "us-central1"
MODEL = "gemini-2.5-flash-lite"
ENDPOINT = (
    f"https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
    f"/locations/{REGION}/publishers/google/models/{MODEL}:generateContent"
)
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
QUESTION_COUNT = 12
NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
CONCURRENCY = 5

# Target codebase for real chunks
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"

SYSTEM_PROMPT = """You are building a RAG system for an autonomous coding agent. Given a code chunk, generate highly technical, targeted search queries and questions that an agentic tool would realistically ask to locate this specific logic within a massive codebase.

Generate questions that are grounded in identifiers, data keys, branches, external APIs, side effects, failure modes, and integration boundaries visible in the chunk. Prefer exact names over broad descriptions.

Good HyDE questions should cover a useful mix of:
- exact symbol/function/class lookup
- callers/callees and route/task/tool wiring
- payload/request/response schemas and important keys
- state mutation, persistence, cache, lock, retry, or concurrency behavior
- deletion/cleanup/idempotency and incremental-update mechanics
- error handling and edge cases
- tests or verification points

Do not invent project-specific facts that are not suggested by the code. Each question must be a complete natural-language sentence.

Return only strict JSON matching the requested schema."""

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "hyde_questions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"question": {"type": "STRING"}},
                "required": ["question"],
            },
        }
    },
    "required": ["hyde_questions"],
}


def get_access_token() -> str:
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def call_gemini_hyde(token: str, chunk_text: str, rel_path: str) -> dict:
    """Call Gemini for HyDE questions. Returns parsed questions or raises."""
    payload = {
        "contents": [{
            "role": "user",
            "parts": [{"text": f"Generate exactly {QUESTION_COUNT} HyDE questions for this code chunk:\n\nFile: {rel_path}\n\n{chunk_text}"}],
        }],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            "temperature": 0.0,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    text = result["candidates"][0]["content"]["parts"][0]["text"]
    data = json.loads(text)
    questions = [
        item["question"].strip()
        for item in data.get("hyde_questions", [])
        if isinstance(item, dict) and item.get("question", "").strip()
    ]
    return questions[:QUESTION_COUNT]


def fallback_questions(rel_path: str) -> list[str]:
    return [f"Where is the code logic from {rel_path} implemented, and what surrounding functions or state does this chunk use?"]


def build_hyde_payload(questions: list[str], rel_path: str, model: str) -> dict:
    return {
        "hyde_questions": questions,
        "hyde_text": "\n".join(f"- {q}" for q in questions),
        "hyde_model": model,
    }


def chunk_text(content: str, chunk_size: int = 1500, overlap: int = 200) -> list[dict]:
    """Simple line-based chunking matching the indexer's approach."""
    lines = content.splitlines(keepends=True)
    chunks = []
    current = []
    current_len = 0
    start_line = 1

    for i, line in enumerate(lines, 1):
        current.append(line)
        current_len += len(line)
        if current_len >= chunk_size:
            text = "".join(current)
            chunks.append({"text": text, "start_line": start_line, "end_line": i})
            # Overlap: keep last few lines
            overlap_lines = []
            overlap_len = 0
            for ln in reversed(current):
                if overlap_len + len(ln) > overlap:
                    break
                overlap_lines.insert(0, ln)
                overlap_len += len(ln)
            current = overlap_lines
            current_len = overlap_len
            start_line = i - len(overlap_lines) + 1

    if current:
        text = "".join(current)
        if text.strip():
            chunks.append({"text": text, "start_line": start_line, "end_line": start_line + len(current) - 1})

    return chunks


def find_source_files(base_dir: str, max_files: int = 10) -> list[str]:
    """Find Python/JS/TS files in the repo, return relative paths."""
    import subprocess
    result = subprocess.run(
        ["git", "ls-files", "--cached"],
        cwd=base_dir, capture_output=True, text=True, check=True,
    )
    valid_ext = {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs"}
    files = []
    for f in result.stdout.splitlines():
        if any(f.endswith(ext) for ext in valid_ext):
            full = os.path.join(base_dir, f)
            if os.path.isfile(full) and os.path.getsize(full) < 50_000:
                files.append(f)
    # Pick a diverse set
    files.sort()
    step = max(1, len(files) // max_files)
    return files[::step][:max_files]


def run():
    print("POC 3: Gemini Flash Lite HyDE batch generation\n")

    # ── Find real chunks ──
    print(f"  Finding source files in {LUMAE_DIR}...")
    source_files = find_source_files(LUMAE_DIR, max_files=10)
    print(f"    Found {len(source_files)} files")

    # Take first chunk from each file
    chunks = []
    for rel_path in source_files:
        full_path = os.path.join(LUMAE_DIR, rel_path)
        content = open(full_path, "r", encoding="utf-8", errors="replace").read()
        file_chunks = chunk_text(content)
        if file_chunks:
            point_id = str(uuid.uuid5(NAMESPACE, f"{rel_path}_0"))
            chunks.append({
                "point_id": point_id,
                "rel_path": rel_path,
                "text": file_chunks[0]["text"],
            })

    print(f"    Prepared {len(chunks)} chunks from {len(source_files)} files")
    for c in chunks:
        print(f"      {c['rel_path']} ({len(c['text'])} chars)")

    # ── Auth ──
    print("\n  Authenticating...")
    token = get_access_token()

    # ── Batch HyDE generation with concurrency ──
    print(f"\n  Generating HyDE questions ({CONCURRENCY} concurrent)...")
    results = {}  # point_id -> hyde_payload
    gemini_successes = 0
    gemini_failures = 0
    per_chunk_latency = []

    start_total = time.perf_counter()

    def process_chunk(chunk):
        t0 = time.perf_counter()
        try:
            questions = call_gemini_hyde(token, chunk["text"], chunk["rel_path"])
            elapsed = time.perf_counter() - t0
            return chunk["point_id"], questions, MODEL, elapsed, None
        except Exception as e:
            elapsed = time.perf_counter() - t0
            return chunk["point_id"], None, None, elapsed, str(e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = {executor.submit(process_chunk, c): c for c in chunks}
        for future in concurrent.futures.as_completed(futures):
            chunk = futures[future]
            point_id, questions, model, elapsed, error = future.result()
            per_chunk_latency.append(elapsed)

            if questions and len(questions) > 0:
                gemini_successes += 1
                results[point_id] = build_hyde_payload(questions, chunk["rel_path"], model)
                print(f"    \u2705 {chunk['rel_path']}: {len(questions)} questions ({elapsed:.1f}s)")
            else:
                gemini_failures += 1
                fb = fallback_questions(chunk["rel_path"])
                results[point_id] = build_hyde_payload(fb, chunk["rel_path"], "fallback")
                print(f"    \u26a0\ufe0f  {chunk['rel_path']}: fallback ({elapsed:.1f}s) — {error}")

    total_time = time.perf_counter() - start_total

    # ── Validate output shape ──
    shape_ok = True
    for pid, payload in results.items():
        if not isinstance(payload.get("hyde_questions"), list):
            shape_ok = False
        if not isinstance(payload.get("hyde_text"), str):
            shape_ok = False
        if not isinstance(payload.get("hyde_model"), str):
            shape_ok = False

    all_have_questions = all(len(p["hyde_questions"]) > 0 for p in results.values())
    fallback_nonempty = all(
        len(p["hyde_questions"]) > 0
        for p in results.values()
        if p["hyde_model"] == "fallback"
    )

    # ── Show sample output ──
    sample = next(iter(results.values()))
    print(f"\n  Sample output ({sample['hyde_model']}):")
    for i, q in enumerate(sample["hyde_questions"][:3], 1):
        print(f"    {i}. {q}")
    if len(sample["hyde_questions"]) > 3:
        print(f"    ... +{len(sample['hyde_questions']) - 3} more")

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        f"All {len(chunks)} chunks have HyDE questions": all_have_questions,
        f"Gemini success >= 80% ({gemini_successes}/{len(chunks)})": gemini_successes >= len(chunks) * 0.8,
        f"Total wall time < 30s ({total_time:.1f}s)": total_time < 30.0,
        "Fallback questions are non-empty": fallback_nonempty or gemini_failures == 0,
        "Output shape matches indexer format": shape_ok,
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n  Timing: {total_time:.1f}s total, {sum(per_chunk_latency)/len(per_chunk_latency):.1f}s avg/chunk")
    print(f"  Cost estimate: ~${len(chunks) * 0.0002:.4f} ({len(chunks)} chunks × $0.0002/chunk)")

    print(f"\n{'  \u2705 POC 3: PASS' if all_pass else '  \u274c POC 3: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
