#!/usr/bin/env python3
"""
POC 4b: Gemini golden query smoke test — Flash Lite vs Flash vs Pro

Sends the same code bundle to all 3 Gemini tiers via Vertex AI REST
to compare golden query quality. Uses file-style structured output.
"""

import concurrent.futures
import json
import os
import sys
import time
import urllib.request

PROJECT = "evrylo"
REGION = "us-central1"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"

MODELS = {
    "flash-lite": "gemini-2.5-flash-lite",
    "flash": "gemini-2.5-flash",
    "pro": "gemini-2.5-pro",
}

EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules"]

SYSTEM_PROMPT = """You are generating a golden test dataset for evaluating code search systems. Given source files from a mortgage technology SaaS application (lumae.ai), generate realistic developer search queries.

For each query, specify:
- query: Natural language search query a developer would type
- relevant: Array of {file, start_line, end_line, grade} where grade is 1-3
- type: One of "symbol_lookup", "behavioral", "architectural", "debugging", "integration", "data_flow"

CRITICAL RULES:
- Only reference files and functions that ACTUALLY EXIST in the code provided
- Line numbers must point to real functions/classes/blocks
- Mix query types: exact symbol names, behavioral descriptions, architectural questions, debugging scenarios
- Generate exactly 15 queries
- Return strict JSON array only"""

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


def build_bundle(max_chars: int = 30_000) -> str:
    """Build a code bundle from lumae.ai — pick diverse, interesting files."""
    import subprocess
    result = subprocess.run(
        ["git", "ls-files", "--cached"],
        cwd=LUMAE_DIR, capture_output=True, text=True, check=True,
    )
    valid_ext = {".py", ".js"}
    # Prioritize core app files, not tests
    priority_prefixes = [
        "auth.py", "app.py", "pipeline_api.py", "admin_portal.py",
        "file_analysis/__init__.py", "upload_portal.py", "workflow.py",
        "services/", "backend/api/", "utils/",
    ]

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
        # Score by priority
        score = 0
        for prefix in priority_prefixes:
            if rel_path.startswith(prefix) or rel_path == prefix:
                score = 10
                break
        files.append((score, rel_path, full))

    files.sort(key=lambda x: (-x[0], x[1]))

    bundle_parts = []
    total = 0
    for _, rel_path, full_path in files:
        try:
            content = open(full_path, "r", encoding="utf-8", errors="replace").read()
            if len(content) > 3000:
                content = content[:3000] + f"\n\n... (truncated, {len(content)} total chars)\n"
        except Exception:
            continue
        entry = f"### {rel_path}\n```\n{content}\n```\n\n"
        if total + len(entry) > max_chars:
            break
        bundle_parts.append(entry)
        total += len(entry)

    return "".join(bundle_parts)


def call_gemini(token: str, model_id: str, bundle: str) -> dict:
    """Call Gemini via Vertex AI REST. Returns {queries, latency, error}."""
    endpoint = (
        f"https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{REGION}/publishers/google/models/{model_id}:generateContent"
    )

    # Pro doesn't support thinkingBudget: 0, and may not support responseSchema
    # Use structured output for flash-lite/flash, plain JSON instruction for pro
    use_structured = "lite" in model_id or ("flash" in model_id and "pro" not in model_id)

    gen_config = {"temperature": 0.0}
    if use_structured:
        gen_config["responseMimeType"] = "application/json"
        gen_config["responseSchema"] = RESPONSE_SCHEMA
        gen_config["thinkingConfig"] = {"thinkingBudget": 0}

    user_text = f"Generate exactly 15 golden queries for this code:\n\n{bundle}"
    if not use_structured:
        user_text += "\n\nReturn ONLY a JSON array matching this schema: [{query, type, relevant: [{file, start_line, end_line, grade}]}]"

    payload = {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": gen_config,
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        elapsed = time.perf_counter() - t0

        text = result["candidates"][0]["content"]["parts"][0]["text"]
        # Try to parse as JSON array
        import re
        match = re.search(r'\[[\s\S]*\]', text)
        if match:
            queries = json.loads(match.group())
        else:
            queries = json.loads(text)

        return {"queries": queries, "latency": elapsed, "error": None}
    except Exception as e:
        elapsed = time.perf_counter() - t0
        return {"queries": [], "latency": elapsed, "error": str(e)}


def validate_files(queries: list[dict]) -> tuple[int, int]:
    """Check how many queries reference files that actually exist."""
    valid = 0
    invalid = 0
    for q in queries:
        all_exist = True
        for r in q.get("relevant", []):
            path = os.path.join(LUMAE_DIR, r.get("file", ""))
            if not os.path.isfile(path):
                all_exist = False
                break
        if all_exist and q.get("relevant"):
            valid += 1
        else:
            invalid += 1
    return valid, invalid


def run():
    print("POC 4b: Gemini golden query smoke test\n")

    print("  Building code bundle...")
    bundle = build_bundle(max_chars=30_000)
    file_count = bundle.count("### ")
    print(f"    {len(bundle)} chars, {file_count} files\n")

    print("  Authenticating...")
    token = get_access_token()

    # Run all 3 models in parallel
    print("  Sending to 3 Gemini tiers (parallel)...\n")

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(call_gemini, token, model_id, bundle): tier
            for tier, model_id in MODELS.items()
        }
        for future in concurrent.futures.as_completed(futures):
            tier = futures[future]
            results[tier] = future.result()

    # Display results
    for tier in ["flash-lite", "flash", "pro"]:
        r = results[tier]
        print(f"  === {tier} ({MODELS[tier]}) ===")
        if r["error"]:
            print(f"    ERROR: {r['error']}")
            print(f"    Latency: {r['latency']:.1f}s\n")
            continue

        queries = r["queries"]
        valid, invalid = validate_files(queries)
        types = {}
        files_referenced = set()
        for q in queries:
            types[q.get("type", "?")] = types.get(q.get("type", "?"), 0) + 1
            for ref in q.get("relevant", []):
                files_referenced.add(ref.get("file", ""))

        print(f"    Queries: {len(queries)}")
        print(f"    Latency: {r['latency']:.1f}s")
        print(f"    File validation: {valid} valid, {invalid} invalid ({valid/(valid+invalid)*100:.0f}% accuracy)")
        print(f"    Files referenced: {len(files_referenced)}")
        print(f"    Types: {types}")
        print(f"    Sample queries:")
        for q in queries[:3]:
            files = [ref["file"] for ref in q.get("relevant", [])]
            print(f"      [{q.get('type','?')}] \"{q['query'][:80]}\"")
            print(f"        → {files}")
        print()

    # Summary comparison
    print("  === COMPARISON ===")
    print(f"  {'Tier':<12} {'Queries':>8} {'Valid%':>8} {'Files':>8} {'Latency':>10}")
    print(f"  {'-'*50}")
    for tier in ["flash-lite", "flash", "pro"]:
        r = results[tier]
        queries = r["queries"]
        valid, invalid = validate_files(queries)
        total = valid + invalid
        files_referenced = set()
        for q in queries:
            for ref in q.get("relevant", []):
                files_referenced.add(ref.get("file", ""))
        pct = f"{valid/total*100:.0f}%" if total else "N/A"
        print(f"  {tier:<12} {len(queries):>8} {pct:>8} {len(files_referenced):>8} {r['latency']:>8.1f}s")


if __name__ == "__main__":
    run()
