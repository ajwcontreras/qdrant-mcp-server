#!/usr/bin/env python3
"""
POC 2: Gemini Flash Lite returns valid HyDE questions via Vertex AI REST

Proves: The Vertex AI REST call pattern produces usable HyDE questions for a
code chunk — structured JSON, correct schema, questions are specific enough
for semantic search. No SDK — pure urllib.request.

Input: One hardcoded code chunk from this repo
Output: Validates response shape, question count, and quality

Pass criteria:
  - Vertex AI endpoint returns 200
  - Response parses as JSON matching schema
  - Returns exactly N questions (where N = requested count, default 12)
  - At least half the questions contain an identifier or keyword from the chunk
  - Latency < 10 seconds
  - No SDK imports — pure urllib.request
"""

import json
import os
import re
import sys
import time
import urllib.request

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

# ── System prompt (same as indexer's HYDE_DEVELOPER_PROMPT) ──
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

Do not invent project-specific facts that are not suggested by the code. Avoid generic questions such as "what does this function do?" or "how does error handling work?" Do not ask only high-level architectural questions. Each question should be plausible as a search query an autonomous coding agent would issue while debugging or extending this exact chunk.

Each question must be a complete natural-language sentence. Do not end questions with dangling punctuation or raw code/schema fragments. It is fine to mention short exact identifiers or payload keys, but do not paste unfinished JSON/dict literals into questions.

Return only strict JSON matching the requested schema."""

# ── Test chunk: real code from this repo's indexer ──
TEST_CHUNK = """File: src/qdrant-openai-indexer.py

    def _delete_stale_points(self, stale_ids: List[str]) -> None:
        if not stale_ids:
            return
        existing_count = self._count_existing_points()
        if existing_count > 0 and len(stale_ids) / existing_count > MAX_DELETE_PERCENT:
            raise RuntimeError(
                f"Refusing to delete {len(stale_ids)} stale points from {existing_count} existing points; "
                f"exceeds MAX_DELETE_PERCENT={MAX_DELETE_PERCENT:.0%}."
            )
        logger.info(f"Cleaning up {len(stale_ids)} stale points...")
        for i in range(0, len(stale_ids), 500):
            self.qdrant_client.delete(self.collection_name, points_selector=PointIdsList(points=stale_ids[i:i+500]), wait=True)
            self.stats["points_deleted"] += len(stale_ids[i:i+500])
"""

# Identifiers/keywords we expect to see in good HyDE questions
EXPECTED_IDENTIFIERS = {
    "_delete_stale_points", "stale_ids", "MAX_DELETE_PERCENT",
    "_count_existing_points", "PointIdsList", "points_deleted",
    "collection_name", "qdrant_client", "delete", "stale",
    "batch", "500", "RuntimeError", "cleanup",
}


def get_access_token() -> str:
    """Get GCP access token from service account."""
    from google.oauth2 import service_account
    import google.auth.transport.requests

    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def call_gemini(token: str, chunk_text: str, question_count: int) -> dict:
    """Call Gemini Flash Lite via Vertex AI REST. Returns parsed JSON."""
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"Generate exactly {question_count} HyDE questions for this code chunk:\n\n{chunk_text}"}],
            }
        ],
        "systemInstruction": {
            "parts": [{"text": SYSTEM_PROMPT}],
        },
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "hyde_questions": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "question": {"type": "STRING"}
                            },
                            "required": ["question"],
                        },
                    }
                },
                "required": ["hyde_questions"],
            },
            "temperature": 0.0,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        status = resp.status
        result = json.loads(resp.read())

    return {"status": status, "body": result}


def extract_questions(body: dict) -> list[str]:
    """Extract question strings from Gemini response."""
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    data = json.loads(text)
    return [
        item["question"].strip()
        for item in data.get("hyde_questions", [])
        if isinstance(item, dict) and item.get("question", "").strip()
    ]


def count_identifier_hits(questions: list[str], identifiers: set[str]) -> int:
    """Count how many questions reference at least one expected identifier."""
    hits = 0
    for q in questions:
        q_lower = q.lower()
        for ident in identifiers:
            if ident.lower() in q_lower:
                hits += 1
                break
    return hits


def run():
    print("POC 2: Gemini Flash Lite returns valid HyDE questions via Vertex AI REST\n")

    # ── Auth ──
    print("  Authenticating via service account...")
    try:
        token = get_access_token()
        auth_ok = True
        print(f"    Token obtained ({len(token)} chars)")
    except Exception as e:
        auth_ok = False
        print(f"    FAILED: {e}")

    if not auth_ok:
        print("\n-- Pass Criteria --")
        print("  \u274c Auth failed — cannot proceed")
        print("\n  \u274c POC 2: FAIL")
        sys.exit(1)

    # ── Call Gemini ──
    print(f"  Calling Gemini Flash Lite ({MODEL}) via Vertex AI REST...")
    start = time.perf_counter()
    try:
        result = call_gemini(token, TEST_CHUNK, QUESTION_COUNT)
        latency = time.perf_counter() - start
        status_ok = result["status"] == 200
        print(f"    Status: {result['status']} ({latency:.2f}s)")
    except Exception as e:
        latency = time.perf_counter() - start
        status_ok = False
        result = {"body": {}}
        print(f"    FAILED ({latency:.2f}s): {e}")

    # ── Parse response ──
    parse_ok = False
    questions = []
    if status_ok:
        try:
            questions = extract_questions(result["body"])
            parse_ok = True
            print(f"    Parsed {len(questions)} questions")
        except Exception as e:
            print(f"    Parse FAILED: {e}")

    # ── Show questions ──
    if questions:
        print("\n  Generated questions:")
        for i, q in enumerate(questions, 1):
            print(f"    {i:2d}. {q}")

    # ── Quality check ──
    count_ok = len(questions) == QUESTION_COUNT
    identifier_hits = count_identifier_hits(questions, EXPECTED_IDENTIFIERS)
    quality_ok = identifier_hits >= QUESTION_COUNT // 2
    latency_ok = latency < 10.0

    # ── Verify no Gemini/Vertex SDK imports (google-auth for service account is fine) ──
    import ast as _ast
    _tree = _ast.parse(open(__file__).read())
    _banned = {"google.genai", "vertexai"}
    no_sdk = True
    for node in _ast.walk(_tree):
        if isinstance(node, _ast.Import):
            for alias in node.names:
                if any(alias.name.startswith(b) for b in _banned):
                    no_sdk = False
        elif isinstance(node, _ast.ImportFrom) and node.module:
            if any(node.module.startswith(b) for b in _banned):
                no_sdk = False

    # ── Pass Criteria ──
    print("\n-- Pass Criteria --")
    checks = {
        "Vertex AI returns 200": status_ok,
        "Response parses as JSON with schema": parse_ok,
        f"Exactly {QUESTION_COUNT} questions returned": count_ok,
        f"Identifier coverage >= 50% ({identifier_hits}/{len(questions)})": quality_ok,
        f"Latency < 10s ({latency:.2f}s)": latency_ok,
        "No SDK imports (pure urllib)": no_sdk,
    }

    all_pass = True
    for label, ok in checks.items():
        status = "\u2705" if ok else "\u274c"
        print(f"  {status} {label}")
        if not ok:
            all_pass = False

    print(f"\n{'  \u2705 POC 2: PASS' if all_pass else '  \u274c POC 2: FAIL'}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    run()
