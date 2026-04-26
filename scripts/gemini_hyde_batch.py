#!/usr/bin/env python3
"""Generate HyDE questions for code chunks with Gemini Vertex AI.

Input can be either:
- a JSON/JSONL file of chunk objects with id, rel_path, text, optional line_range; or
- a repository path, in which case this script reuses qdrant-openai-indexer.py
  chunking and file filtering.

Output is JSONL: one record per chunk.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import fnmatch
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "gemini-3.1-flash-lite-preview"
DEFAULT_PROJECT = "evrylo"
DEFAULT_LOCATION = "global"
DEFAULT_HYDE_VERSION = os.environ.get("HYDE_SCHEMA_VERSION", "gemini-hyde-questions-v3")
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
MAX_FILE_SIZE_BYTES = 1_000_000
LONG_LINE_GENERATED_THRESHOLD = 20_000
VALID_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".json", ".prisma",
    ".md", ".mdx", ".css", ".scss", ".sql", ".sh",
    ".yml", ".yaml", ".py", ".html", ".xml", ".txt",
}
EXCLUDED_DIR_NAMES = {
    ".git", ".next", ".venv", "__pycache__", "build", "coverage",
    "dist", "node_modules", "qdrant_storage", "vendor", "vendors",
}
EXCLUDED_FILE_NAMES = {
    "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
}
EXCLUDED_FILE_SUFFIXES = {".log", ".map", ".min.css", ".min.js"}
GENERATED_CSS_NAMES = {"tailwind.css", "pipeline_tailwind.css"}


def split_globs(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


INCLUDE_PATH_GLOBS = split_globs(os.environ.get("QDRANT_INCLUDE_GLOBS", ""))
EXCLUDE_PATH_GLOBS = split_globs(os.environ.get("QDRANT_EXCLUDE_GLOBS", ""))


def path_matches_any(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatch(path, pattern):
            return True
        if "/**/" in pattern and fnmatch.fnmatch(path, pattern.replace("/**/", "/")):
            return True
    return False


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hyde_cache_key(chunk_hash: str, hyde_version: str, model: str) -> str:
    return f"content:{chunk_hash}:hyde:{hyde_version}:model:{model}"


PROMPT = """You are building a RAG system for an autonomous coding agent.

Given code chunks, generate highly technical, targeted search questions that an agentic code-search tool would realistically ask to locate each exact chunk in a massive codebase.

Quality rules:
- Ground every question in identifiers, functions, classes, branches, payload keys, side effects, persistence, retries, fallback logic, line ranges, request/response contracts, or tests visible in the chunk.
- Prefer exact names from the code over broad summaries.
- Do not invent project-specific facts that are not visible in the chunk.
- Avoid generic questions like "what does this function do?".
- Every question must be a complete natural-language question ending in '?'.
- Return exactly the requested number of questions for each input chunk.
- Preserve input ids exactly and preserve result order.
"""


SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "results": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "hyde_questions": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "question": {"type": "STRING"},
                            },
                            "required": ["question"],
                            "propertyOrdering": ["question"],
                        },
                    },
                },
                "required": ["id", "hyde_questions"],
                "propertyOrdering": ["id", "hyde_questions"],
            },
        }
    },
    "required": ["results"],
    "propertyOrdering": ["results"],
}


def is_excluded_path(rel_path: str) -> bool:
    path = Path(rel_path)
    parts = set(path.parts)
    name = path.name.lower()
    lower_path = rel_path.replace(os.sep, "/").lower()
    normalized_path = rel_path.replace(os.sep, "/")
    if path_matches_any(normalized_path, EXCLUDE_PATH_GLOBS):
        return True
    if parts & EXCLUDED_DIR_NAMES:
        return True
    if name in EXCLUDED_FILE_NAMES:
        return True
    if any(name.endswith(suffix) for suffix in EXCLUDED_FILE_SUFFIXES):
        return True
    if name in GENERATED_CSS_NAMES and "/static/" in f"/{lower_path}":
        return True
    return False


def looks_generated_or_bundled(rel_path: str, content: str) -> bool:
    path = Path(rel_path)
    if len(content.encode("utf-8", "ignore")) > MAX_FILE_SIZE_BYTES:
        return True
    longest_line = max((len(line) for line in content.split("\n")), default=0)
    return longest_line > LONG_LINE_GENERATED_THRESHOLD and path.suffix.lower() in {".css", ".js", ".json", ".xml"}


def should_index_file(file_path: Path, base_path: Path, content: str | None = None) -> bool:
    rel_path = str(file_path.relative_to(base_path))
    normalized_path = rel_path.replace(os.sep, "/")
    if INCLUDE_PATH_GLOBS and not path_matches_any(normalized_path, INCLUDE_PATH_GLOBS):
        return False
    if file_path.suffix not in VALID_EXTENSIONS:
        return False
    if is_excluded_path(rel_path):
        return False
    if content is not None and looks_generated_or_bundled(rel_path, content):
        return False
    return True


def split_long_line(line: str, line_number: int) -> list[dict[str, Any]]:
    if len(line) <= CHUNK_SIZE:
        return [{"line_number": line_number, "text": line}]
    return [
        {"line_number": line_number, "text": line[start:start + CHUNK_SIZE]}
        for start in range(0, len(line), CHUNK_SIZE)
    ]


def make_chunk_payload(line_items: list[dict[str, Any]]) -> dict[str, Any]:
    start_line = int(line_items[0]["line_number"])
    end_line = int(line_items[-1]["line_number"])
    return {
        "text": "\n".join(item["text"] for item in line_items),
        "start_line": start_line,
        "end_line": end_line,
        "line_range": f"{start_line}-{end_line}" if start_line != end_line else str(start_line),
    }


def chunk_text(text: str) -> list[dict[str, Any]]:
    chunks = []
    current_chunk = []
    current_len = 0
    for line_number, line in enumerate(text.split("\n"), start=1):
        for line_item in split_long_line(line, line_number):
            line_len = len(line_item["text"]) + 1
            if current_len + line_len > CHUNK_SIZE and current_chunk:
                chunks.append(make_chunk_payload(current_chunk))
                overlap_chunk = []
                overlap_len = 0
                for overlap_item in reversed(current_chunk):
                    text_part = overlap_item["text"]
                    if overlap_len + len(text_part) + 1 > CHUNK_OVERLAP:
                        break
                    overlap_chunk.insert(0, overlap_item)
                    overlap_len += len(text_part) + 1
                current_chunk = overlap_chunk
                current_len = overlap_len
            current_chunk.append(line_item)
            current_len += line_len
    if current_chunk:
        chunks.append(make_chunk_payload(current_chunk))
    return chunks


def iter_repo_chunks(repo: Path, limit: int | None = None) -> Iterable[dict[str, Any]]:
    result = subprocess.run(["git", "ls-files", "--cached"], cwd=repo, capture_output=True, text=True, check=True)
    yielded = 0
    for rel_path in result.stdout.splitlines():
        file_path = repo / rel_path
        if not should_index_file(file_path, repo):
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            continue
        if not should_index_file(file_path, repo, content):
            continue
        for chunk_index, chunk in enumerate(chunk_text(content)):
            if limit is not None and yielded >= limit:
                return
            yield {
                "id": f"{rel_path}:{chunk_index}",
                "rel_path": rel_path,
                "line_range": chunk["line_range"],
                "text": chunk["text"],
                "content_hash": content_hash(chunk["text"]),
            }
            yielded += 1


def load_input_chunks(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    chunks: list[dict[str, Any]] = []
    if path.suffix == ".jsonl":
        for line in text.splitlines():
            if line.strip():
                chunks.append(json.loads(line))
    else:
        data = json.loads(text)
        if isinstance(data, dict) and "chunks" in data:
            data = data["chunks"]
        if not isinstance(data, list):
            raise ValueError("Input JSON must be a list or an object with a chunks array")
        chunks = list(data)
    return chunks[:limit] if limit is not None else chunks


def ensure_chunk_hashes(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for chunk in chunks:
        if not chunk.get("content_hash"):
            chunk["content_hash"] = content_hash(str(chunk.get("text") or ""))
    return chunks


def load_done_cache(output_path: Path, hyde_version: str, model: str) -> tuple[set[str], set[str]]:
    if not output_path.exists():
        return set(), set()
    done_ids = set()
    done_cache_keys = set()
    for line in output_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        if item.get("ok") and item.get("id"):
            done_ids.add(str(item["id"]))
            item_hash = str(item.get("content_hash") or "").strip()
            item_version = str(item.get("hyde_version") or hyde_version)
            item_model = str(item.get("model") or model)
            if item_hash:
                done_cache_keys.add(hyde_cache_key(item_hash, item_version, item_model))
    return done_ids, done_cache_keys


def make_client(project: str, location: str):
    from google import genai

    return genai.Client(vertexai=True, project=project, location=location)


def build_contents(batch: list[dict[str, Any]], question_count: int) -> str:
    payload = {
        "question_count_per_chunk": question_count,
        "chunks": [
            {
                "id": str(item["id"]),
                "rel_path": str(item.get("rel_path") or ""),
                "line_range": str(item.get("line_range") or ""),
                "text": str(item.get("text") or ""),
            }
            for item in batch
        ],
    }
    return PROMPT + "\nReturn schema-valid JSON for these chunks:\n" + json.dumps(payload, ensure_ascii=False)


def validate_result(data: dict[str, Any], batch: list[dict[str, Any]], question_count: int) -> dict[str, list[str]]:
    errors_by_id: dict[str, list[str]] = {}
    results = data.get("results")
    if not isinstance(results, list):
        return {str(item["id"]): ["missing results array"] for item in batch}
    by_id = {str(result.get("id")): result for result in results if isinstance(result, dict)}
    for item in batch:
        item_id = str(item["id"])
        errors: list[str] = []
        result = by_id.get(item_id)
        if not result:
            errors.append("missing result")
            errors_by_id[item_id] = errors
            continue
        questions = result.get("hyde_questions")
        if not isinstance(questions, list) or len(questions) != question_count:
            errors.append(f"expected {question_count} questions, got {len(questions or [])}")
        for index, question_item in enumerate(questions or []):
            question = str(question_item.get("question", "")).strip() if isinstance(question_item, dict) else ""
            if len(question) < 40:
                errors.append(f"question {index} too short")
            if not question.endswith("?"):
                errors.append(f"question {index} does not end with '?'")
        if errors:
            errors_by_id[item_id] = errors
    return errors_by_id


def normalize_question(question: str) -> str:
    question = " ".join(str(question or "").strip().split())
    if question and question[-1] not in "?!":
        question = question.rstrip(".:;") + "?"
    return question


def validate_question_item(question: Any, index: int, errors: list[str]) -> str:
    if not isinstance(question, str):
        errors.append(f"question {index} must be a string")
        return ""
    normalized = normalize_question(question)
    if len(normalized) < 40:
        errors.append(f"question {index} too short")
    if not normalized.endswith("?"):
        errors.append(f"question {index} does not end with '?'")
    return normalized


def parse_worker_payload(batch: list[dict[str, Any]], model: str | None = None) -> dict[str, Any]:
    return {
        **({"model": model} if model else {}),
        "items": [
            {
                "id": str(item["id"]),
                "rel_path": str(item.get("rel_path") or ""),
                "text": str(item.get("text") or ""),
            }
            for item in batch
        ]
    }


def validate_worker_response(data: dict[str, Any], batch: list[dict[str, Any]], question_count: int) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    errors_by_id: dict[str, list[str]] = {}
    normalized_by_id: dict[str, list[str]] = {}
    results = data.get("results")
    if not isinstance(results, list):
        return ({str(item["id"]): ["missing results array"] for item in batch},
                {str(item["id"]): [] for item in batch})
    by_id = {str(result.get("id")): result for result in results if isinstance(result, dict)}
    for item in batch:
        item_id = str(item["id"])
        errors: list[str] = []
        result = by_id.get(item_id)
        if not result:
            errors.append("missing result")
            errors_by_id[item_id] = errors
            normalized_by_id[item_id] = []
            continue
        questions_raw = result.get("hyde_questions")
        if not isinstance(questions_raw, list):
            errors.append("hyde_questions must be a list of strings")
            errors_by_id[item_id] = errors
            normalized_by_id[item_id] = []
            continue
        questions = [
            validate_question_item(question, index, errors)
            for index, question in enumerate(questions_raw)
        ]
        questions = [question for question in questions if question]
        if not questions:
            errors.append("expected at least one valid question")
        errors_by_id[item_id] = errors
        normalized_by_id[item_id] = questions
    return errors_by_id, normalized_by_id


def request_worker_batch(
    worker_url: str,
    batch: list[dict[str, Any]],
    worker_token: str | None,
    question_count: int,
    model: str | None,
    hyde_version: str,
    attempts: int,
    timeout: int = 120,
) -> list[dict[str, Any]]:
    payload = parse_worker_payload(batch, model)
    endpoint = worker_url.rstrip("/") + "/hyde-batch"
    request_data = json.dumps(payload).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "user-agent": "qdrant-hyde-batch/1.0",
    }
    if worker_token:
        headers["x-batch-token"] = worker_token
    last_error = ""
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(endpoint, data=request_data, headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
            data = json.loads(body)
            if data.get("ok") is False:
                raise RuntimeError(data.get("error") or data)
            errors_by_id, normalized_by_id = validate_worker_response(data, batch, question_count)
            records = []
            for item in batch:
                item_id = str(item["id"])
                result = next((r for r in data.get("results", []) if str(r.get("id")) == item_id), {}) if isinstance(data.get("results"), list) else {}
                questions = normalized_by_id.get(item_id, [])
                records.append({
                    "id": item_id,
                    "rel_path": item.get("rel_path"),
                    "line_range": item.get("line_range"),
                    "content_hash": item.get("content_hash"),
                    "hyde_version": hyde_version,
                    "ok": not errors_by_id.get(item_id),
                    "hyde_questions": questions,
                    "hyde_text": "\n".join(f"- {question}" for question in questions),
                    "model": result.get("model") or model or "worker-route",
                    "active_key": result.get("active_key"),
                    "errors": errors_by_id.get(item_id, []),
                })
            return records
        except Exception as exc:
            last_error = str(exc)
            if attempt < attempts:
                time.sleep(min(2 * attempt, 10))
    return [
        {
            "id": str(item["id"]),
            "rel_path": item.get("rel_path"),
            "line_range": item.get("line_range"),
            "content_hash": item.get("content_hash"),
            "hyde_version": hyde_version,
            "ok": False,
            "hyde_questions": [],
            "hyde_text": "",
            "model": model or "worker-route",
            "errors": [last_error or "unknown worker request error"],
        }
        for item in batch
    ]


def generate_batch(
    batch: list[dict[str, Any]],
    *,
    model: str,
    project: str,
    location: str,
    use_worker: bool = False,
    worker_url: str | None = None,
    worker_token: str | None = None,
    question_count: int,
    max_output_tokens: int,
    attempts: int,
    hyde_version: str,
) -> list[dict[str, Any]]:
    if use_worker:
        if not worker_url:
            return [{
                "id": str(item["id"]),
                "rel_path": item.get("rel_path"),
                "line_range": item.get("line_range"),
                "ok": False,
                "hyde_questions": [],
                "hyde_text": "",
                "model": "worker-route",
                "errors": ["worker mode requested but no worker URL was provided"],
            } for item in batch]
        return request_worker_batch(worker_url, batch, worker_token, question_count, model, hyde_version, attempts)
    last_error = ""
    for attempt in range(1, attempts + 1):
        try:
            from google.genai import types

            client = make_client(project, location)
            response = client.models.generate_content(
                model=model,
                contents=build_contents(batch, question_count),
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=max_output_tokens,
                    response_mime_type="application/json",
                    response_schema=SCHEMA,
                    thinking_config=types.ThinkingConfig(
                        thinking_level=types.ThinkingLevel.MINIMAL,
                    ),
                ),
            )
            data = json.loads(response.text)
            errors_by_id = validate_result(data, batch, question_count)
            output_by_id = {str(result.get("id")): result for result in data.get("results", [])}
            records = []
            for item in batch:
                item_id = str(item["id"])
                result = output_by_id.get(item_id) or {"hyde_questions": []}
                questions = [
                    normalize_question(str(question.get("question", "")))
                    for question in result.get("hyde_questions", [])
                    if isinstance(question, dict) and normalize_question(str(question.get("question", "")))
                ]
                if len(questions) == question_count and errors_by_id.get(item_id):
                    fixed_data = {"results": [{"id": item_id, "hyde_questions": [{"question": q} for q in questions]}]}
                    if not validate_result(fixed_data, [item], question_count).get(item_id):
                        errors_by_id.pop(item_id, None)
                records.append({
                    "id": item_id,
                    "rel_path": item.get("rel_path"),
                    "line_range": item.get("line_range"),
                    "content_hash": item.get("content_hash"),
                    "hyde_version": hyde_version,
                    "ok": item_id not in errors_by_id,
                    "hyde_questions": questions,
                    "hyde_text": "\n".join(f"- {question}" for question in questions),
                    "model": model,
                    "errors": errors_by_id.get(item_id, []),
                })
            return records
        except Exception as exc:
            last_error = str(exc)
            if attempt < attempts:
                time.sleep(min(2 * attempt, 10))
    return [
        {
            "id": str(item["id"]),
            "rel_path": item.get("rel_path"),
            "line_range": item.get("line_range"),
            "content_hash": item.get("content_hash"),
            "hyde_version": hyde_version,
            "ok": False,
            "hyde_questions": [],
            "hyde_text": "",
            "model": model,
            "errors": [last_error or "unknown generation error"],
        }
        for item in batch
    ]


def chunks_in_batches(chunks: list[dict[str, Any]], batch_size: int) -> list[list[dict[str, Any]]]:
    return [chunks[index:index + batch_size] for index in range(0, len(chunks), batch_size)]


def append_records(output_path: Path, records: list[dict[str, Any]]) -> None:
    with output_path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Input JSON/JSONL chunk file")
    source.add_argument("--repo", type=Path, help="Repository to chunk using qdrant-openai-indexer.py logic")
    parser.add_argument("--output", type=Path, required=True, help="Output JSONL path")
    parser.add_argument("--use-worker", action="store_true", help="Use Cloudflare Worker endpoint for generation instead of local Vertex.")
    parser.add_argument("--worker-url", default=os.environ.get("GEMINI_HYDE_WORKER_URL"), help="Worker base URL (example: https://.../hyde-batch route is appended).")
    parser.add_argument("--worker-token", default=os.environ.get("BATCH_AUTH_TOKEN"), help="Token for Worker auth (Authorization header / x-batch-token).")
    parser.add_argument("--model", default=os.environ.get("GEMINI_HYDE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--hyde-version", default=DEFAULT_HYDE_VERSION)
    parser.add_argument("--project", default=os.environ.get("GOOGLE_CLOUD_PROJECT", DEFAULT_PROJECT))
    parser.add_argument("--location", default=os.environ.get("GOOGLE_CLOUD_LOCATION", DEFAULT_LOCATION))
    parser.add_argument("--batch-size", type=int, default=3)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--question-count", type=int, default=6)
    parser.add_argument("--max-output-tokens", type=int, default=8192)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--no-resume", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.use_worker and not args.worker_url:
        raise ValueError("worker mode requires --worker-url or GEMINI_HYDE_WORKER_URL")
    if args.repo:
        chunks = list(iter_repo_chunks(args.repo.resolve(), args.limit))
    else:
        chunks = load_input_chunks(args.input, args.limit)
    chunks = ensure_chunk_hashes(chunks)

    done_ids, done_cache_keys = (set(), set()) if args.no_resume else load_done_cache(args.output, args.hyde_version, args.model)
    pending = []
    id_resume_hits = 0
    content_cache_hits = 0
    for chunk in chunks:
        if str(chunk["id"]) in done_ids:
            id_resume_hits += 1
            continue
        if hyde_cache_key(str(chunk["content_hash"]), args.hyde_version, args.model) in done_cache_keys:
            content_cache_hits += 1
            continue
        pending.append(chunk)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    batches = chunks_in_batches(pending, max(1, args.batch_size))

    print(json.dumps({
        "model": args.model,
        "chunks_total": len(chunks),
        "chunks_done": id_resume_hits,
        "content_cache_hits": content_cache_hits,
        "chunks_pending": len(pending),
        "batches": len(batches),
        "batch_size": args.batch_size,
        "workers": args.workers,
        "output": str(args.output),
    }))

    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        future_to_batch = {
            executor.submit(
                generate_batch,
                batch,
                model=args.model,
                project=args.project,
                location=args.location,
                use_worker=args.use_worker,
                worker_url=args.worker_url,
                worker_token=args.worker_token,
                question_count=args.question_count,
                max_output_tokens=args.max_output_tokens,
                attempts=args.attempts,
                hyde_version=args.hyde_version,
            ): batch
            for batch in batches
        }
        for completed, future in enumerate(concurrent.futures.as_completed(future_to_batch), start=1):
            records = future.result()
            failures += sum(1 for record in records if not record.get("ok"))
            append_records(args.output, records)
            print(json.dumps({
                "completed_batches": completed,
                "total_batches": len(batches),
                "records": len(records),
                "failures_total": failures,
            }), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
