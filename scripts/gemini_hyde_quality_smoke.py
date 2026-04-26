#!/usr/bin/env python3
"""Smoke-test Gemini Vertex AI HyDE question quality on real code chunks."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types


ROOT = Path(__file__).resolve().parents[1]
MODEL = os.environ.get("GEMINI_HYDE_MODEL", "gemini-3.1-flash-lite-preview")
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "evrylo")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
QUESTION_COUNT = int(os.environ.get("GEMINI_HYDE_QUESTION_COUNT", "6"))


PROMPT = """You are building a RAG system for an autonomous coding agent.

Given code chunks, generate highly technical, targeted search questions that an agentic code-search tool would realistically ask to locate each exact chunk in a massive codebase.

Quality rules:
- Ground every question in identifiers, functions, classes, branches, payload keys, side effects, persistence, retries, fallback logic, line ranges, request/response contracts, or tests visible in the chunk.
- Prefer exact names from the code over broad summaries.
- Do not invent project-specific facts that are not visible in the chunk.
- Avoid generic questions like "what does this function do?".
- Every question must be a complete natural-language sentence.
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


def read_excerpt(rel_path: str, start_line: int, end_line: int) -> dict[str, Any]:
    lines = (ROOT / rel_path).read_text(encoding="utf-8").splitlines()
    return {
        "id": f"{rel_path}:{start_line}-{end_line}",
        "rel_path": rel_path,
        "line_range": f"{start_line}-{end_line}",
        "text": "\n".join(lines[start_line - 1:end_line]),
    }


def build_chunks() -> list[dict[str, Any]]:
    return [
        read_excerpt("src/qdrant-openai-indexer.py", 608, 637),
        read_excerpt("src/qdrant-openai-indexer.py", 1078, 1101),
        read_excerpt("openai-batch-worker/src/index.ts", 535, 595),
    ]


def validate_response(data: dict[str, Any], chunks: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    results = data.get("results")
    if not isinstance(results, list):
        return ["missing results array"]
    if len(results) != len(chunks):
        errors.append(f"expected {len(chunks)} results, got {len(results)}")
    for index, chunk in enumerate(chunks):
        if index >= len(results):
            break
        result = results[index]
        if result.get("id") != chunk["id"]:
            errors.append(f"result {index} id mismatch: {result.get('id')!r}")
        questions = result.get("hyde_questions")
        if not isinstance(questions, list) or len(questions) != QUESTION_COUNT:
            errors.append(f"{chunk['id']} expected {QUESTION_COUNT} questions, got {len(questions or [])}")
            continue
        for question_index, item in enumerate(questions):
            question = str(item.get("question", "")).strip() if isinstance(item, dict) else ""
            if len(question) < 40:
                errors.append(f"{chunk['id']} question {question_index} too short")
            if not question.endswith("?"):
                errors.append(f"{chunk['id']} question {question_index} is not a question")
    return errors


def main() -> int:
    chunks = build_chunks()
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    contents = (
        PROMPT
        + "\nReturn schema-valid JSON for these chunks:\n"
        + json.dumps(
            {
                "question_count_per_chunk": QUESTION_COUNT,
                "chunks": chunks,
            },
            ensure_ascii=False,
        )
    )
    response = client.models.generate_content(
        model=MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=8192,
            response_mime_type="application/json",
            response_schema=SCHEMA,
            thinking_config=types.ThinkingConfig(
                thinking_level=types.ThinkingLevel.MINIMAL,
            ),
        ),
    )
    data = json.loads(response.text)
    errors = validate_response(data, chunks)
    print(json.dumps({"model": MODEL, "errors": errors, "data": data}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
