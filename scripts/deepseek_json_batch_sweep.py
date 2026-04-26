#!/usr/bin/env python3
"""Measure browser-backed DeepSeek JSON batch reliability through Launcher API."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import hashlib
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_API_BASE = "https://intel-launcher.ajwc.cc"


def git_files(repo: Path, roots: list[str]) -> list[str]:
    result = subprocess.run(["git", "ls-files", *roots], cwd=repo, text=True, capture_output=True, check=True)
    return [line for line in result.stdout.splitlines() if line.strip()]


def collect_items(repo: Path, count: int, chars_per_item: int, roots: list[str], offset: int = 0) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    source_items: list[dict[str, str]] = []
    for rel_path in git_files(repo, roots):
        if rel_path.endswith(("dom-parser-bundle.txt", ".map", ".log")):
            continue
        path = repo / rel_path
        if path.suffix not in {".ts", ".js", ".html", ".json", ".svelte"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for start in range(0, min(len(text), chars_per_item * 8), chars_per_item):
            snippet = text[start:start + chars_per_item]
            if snippet.strip():
                source_items.append({
                    "file": rel_path,
                    "text": snippet,
                })
    selected = source_items[offset:offset + count]
    for item in selected:
        items.append({
            "id": f"item_{len(items):03d}",
            "file": item["file"],
            "text": item["text"],
        })
    return items


def write_items_file(path: Path, items: list[dict[str, str]]) -> None:
    lines = [
        "Each section below is one item. The id after ## is mandatory and must appear exactly once in the output.",
    ]
    for item in items:
        lines.append(f"\n## {item['id']} {item['file']}\n{item['text']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def prompt_for_count(count: int) -> str:
    last_id = f"item_{count - 1:03d}"
    return f'''Analyze the attached {count} code items.
Return JSON only, no markdown and no prose.

Few-shot output shape:
{{
  "entries": [
    {{
      "id": "item_000",
      "file": "workers/api/src/index.ts",
      "file_role": "source",
      "important_symbols": ["generateCode"],
      "routes": ["POST /api/transform"],
      "domain_terms": ["schema inference", "sandbox execution"],
      "developer_queries": [
        "Where is generateCode implemented and how does it call the model?",
        "Where does the transform route execute generated code in the sandbox?"
      ]
    }},
    {{
      "id": "item_001",
      "file": "workers/ui/src/lib/json-sampling.ts",
      "file_role": "ui",
      "important_symbols": ["sampleForInference"],
      "routes": [],
      "domain_terms": ["JSON sampling"],
      "developer_queries": [
        "Where does the UI truncate JSONL at a complete line boundary?",
        "Where does sampleForInference distinguish arrays from JSONL objects?"
      ]
    }}
  ],
  "missing_ids": []
}}

Hard requirements:
- entries must contain exactly {count} objects.
- entries must include exactly one object for every attached id from item_000 through {last_id}.
- entries must be in ascending id order.
- each developer_queries array must contain exactly two grounded questions.
- missing_ids must be [] if all ids are present.
- If a snippet is uninformative, still create a concise entry for that id.
'''


def encode_multipart(fields: dict[str, str], file_path: Path) -> tuple[bytes, str]:
    boundary = "----qdrantDeepSeek" + hashlib.sha256(str(time.time()).encode()).hexdigest()[:12]
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode(),
            b"\r\n",
        ])
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode(),
        b"Content-Type: text/plain; charset=utf-8\r\n\r\n",
        file_path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def extract_json(text: str) -> tuple[Any, str]:
    try:
        return json.loads(text), "direct"
    except Exception:
        pass
    candidates = []
    for fence in re.finditer(r"```(?:json)?\s*(.*?)```", text, re.S | re.I):
        candidates.append(fence.group(1))
    for open_ch, close_ch in [("{", "}"), ("[", "]")]:
        start = text.find(open_ch)
        if start < 0:
            continue
        depth = 0
        in_string = False
        escaped = False
        for index, char in enumerate(text[start:], start):
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            else:
                if char == '"':
                    in_string = True
                elif char == open_ch:
                    depth += 1
                elif char == close_ch:
                    depth -= 1
                    if depth == 0:
                        candidates.append(text[start:index + 1])
                        break
    for candidate in candidates:
        try:
            return json.loads(candidate), "extracted"
        except Exception:
            try:
                return json.loads(repair_invalid_json_escapes(candidate)), "repaired_escapes"
            except Exception:
                continue
    raise ValueError("no parseable JSON object or array found")


def repair_invalid_json_escapes(text: str) -> str:
    """Escape backslashes inside JSON strings unless they already form a valid JSON escape."""
    valid_escapes = {'"', "\\", "/", "b", "f", "n", "r", "t", "u"}
    result: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if not in_string:
            result.append(char)
            if char == '"':
                in_string = True
            continue
        if escaped:
            if char in valid_escapes:
                result.append(char)
            else:
                result.append("\\")
                result.append(char)
            escaped = False
            continue
        if char == "\\":
            result.append("\\")
            escaped = True
            continue
        result.append(char)
        if char == '"':
            in_string = False
    if escaped:
        result.append("\\")
    return "".join(result)


def call_launcher_once(api_base: str, provider: str, file_path: Path, prompt: str, session_id: str, timeout: int) -> dict[str, Any]:
    body, content_type = encode_multipart({"prompt": prompt, "provider": provider, "sessionId": session_id}, file_path)
    request = urllib.request.Request(
        api_base.rstrip("/") + "/runs/parallel",
        data=body,
        headers={"Content-Type": content_type},
        method="POST",
    )
    started = time.time()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.load(response)
    data["_elapsed_seconds"] = time.time() - started
    return data


def call_launcher(
    api_base: str,
    provider: str,
    file_path: Path,
    prompt: str,
    session_id: str,
    timeout: int,
    attempts: int,
    hard_timeout_seconds: int,
) -> dict[str, Any]:
    last_error = None
    started = time.time()
    deadline = started + hard_timeout_seconds if hard_timeout_seconds > 0 else None
    for attempt in range(1, attempts + 1):
        if deadline is not None:
            remaining = deadline - time.time()
            if remaining <= 0:
                last_error = f"hard timeout after {hard_timeout_seconds}s"
                break
            attempt_timeout = max(1, min(timeout, int(remaining)))
        else:
            attempt_timeout = timeout
        try:
            response = call_launcher_once(api_base, provider, file_path, prompt, f"{session_id}-try{attempt}", attempt_timeout)
        except Exception as exc:
            last_error = str(exc)
            if attempt < attempts:
                delay = 2 if attempt == 1 else 5
                if deadline is None or time.time() + delay < deadline:
                    time.sleep(delay)
            continue
        failed = int(response.get("summary", {}).get("failed", 1) or 0)
        if failed == 0:
            return response
        last_error = json.dumps(response.get("providers") or response, ensure_ascii=False)[:1000]
        if attempt < attempts:
            delay = 2 if attempt == 1 else 5
            if deadline is None or time.time() + delay < deadline:
                time.sleep(delay)
    return {
        "_elapsed_seconds": time.time() - started,
        "summary": {"success": 0, "failed": 1},
        "providers": [{
            "name": provider,
            "status": "failed",
            "durationMs": None,
            "error": last_error or "launcher request failed",
            "reply": "",
        }],
    }


def parse_reply_entries(reply: str) -> tuple[list[dict[str, Any]], str]:
    parsed, parse_mode = extract_json(reply)
    entries = parsed.get("entries") if isinstance(parsed, dict) else parsed
    if not isinstance(entries, list):
        raise ValueError("parsed JSON did not contain an entries array")
    dict_entries = [entry for entry in entries if isinstance(entry, dict)]
    return dict_entries, parse_mode


def evaluate_entries(entries: list[dict[str, Any]], parse_mode: str, expected_count: int) -> dict[str, Any]:
    ids = [entry.get("id") for entry in entries] if isinstance(entries, list) else []
    expected = {f"item_{index:03d}" for index in range(expected_count)}
    return {
        "parse_ok": True,
        "parse_mode": parse_mode,
        "entry_count": len(ids),
        "unique_id_count": len(set(ids)),
        "missing_count": len(expected - set(ids)),
        "extra_count": len(set(ids) - expected),
        "first_missing": sorted(expected - set(ids))[:10],
        "validish_count": sum(
            1 for entry in entries or []
            if isinstance(entry, dict)
            and entry.get("id")
            and entry.get("file")
            and isinstance(entry.get("developer_queries"), list)
        ),
    }


def evaluate_reply(reply: str, expected_count: int) -> dict[str, Any]:
    try:
        entries, parse_mode = parse_reply_entries(reply)
    except Exception as exc:
        return {"parse_ok": False, "parse_error": str(exc)}
    return evaluate_entries(entries, parse_mode, expected_count)


def write_run_entries(
    args: argparse.Namespace,
    result: dict[str, Any],
    reply: str,
    items: list[dict[str, str]],
) -> None:
    if not result.get("parse_ok"):
        return
    try:
        entries, parse_mode = parse_reply_entries(reply)
    except Exception as exc:
        result["entries_write_error"] = str(exc)
        return
    by_id = {item["id"]: item for item in items}
    records: list[dict[str, Any]] = []
    for entry in entries:
        local_id = str(entry.get("id") or "")
        source = by_id.get(local_id, {})
        global_id = f"run{int(result['run_index']):03d}_{local_id}"
        record = {
            "id": global_id,
            "run_index": result["run_index"],
            "local_id": local_id,
            "source_file": source.get("file") or entry.get("file"),
            "source_text_hash": hashlib.sha256((source.get("text") or "").encode("utf-8")).hexdigest(),
            "parse_mode": parse_mode,
            "provider": result.get("provider"),
            "entry": entry,
        }
        records.append(record)
    entries_path = args.output_dir / f"deepseek-items-{result['count_requested']}-run{int(result['run_index']):02d}-entries.jsonl"
    entries_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    result["entries_path"] = str(entries_path)
    result["entries_written"] = len(records)


def run_one(args: argparse.Namespace, count: int, run_index: int = 0, offset: int = 0) -> dict[str, Any]:
    items = collect_items(args.repo.resolve(), count, args.chars_per_item, args.roots.split(","), offset)
    suffix = f"{count}" if run_index == 0 else f"{count}-run{run_index:02d}"
    input_path = args.output_dir / f"deepseek-items-{suffix}.txt"
    write_items_file(input_path, items)
    response = call_launcher(
        args.api_base,
        args.provider,
        input_path,
        prompt_for_count(len(items)),
        f"deepseek-json-sweep-{count}-run{run_index}-{int(time.time())}",
        args.timeout,
        args.attempts,
        args.hard_timeout_seconds,
    )
    provider = (response.get("providers") or [{}])[0]
    reply = provider.get("reply") or ""
    reply_path = args.output_dir / f"deepseek-items-{suffix}-reply.txt"
    reply_path.write_text(reply, encoding="utf-8")
    raw_path = args.output_dir / f"deepseek-items-{suffix}-response.json"
    raw_path.write_text(json.dumps(response, indent=2), encoding="utf-8")
    result = {
        "count_requested": count,
        "run_index": run_index,
        "offset": offset,
        "items_sent": len(items),
        "input_bytes": input_path.stat().st_size,
        "provider": provider.get("name"),
        "status": provider.get("status"),
        "duration_ms": provider.get("durationMs"),
        "elapsed_seconds": response.get("_elapsed_seconds"),
        "reply_chars": len(reply),
        "error": provider.get("error"),
        "input_path": str(input_path),
        "reply_path": str(reply_path),
        "raw_response_path": str(raw_path),
    }
    if provider.get("status") == "success":
        result.update(evaluate_reply(reply, len(items)))
        write_run_entries(args, result, reply, items)
    return result


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def merge_entries(results: list[dict[str, Any]], output_path: Path) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with output_path.open("w", encoding="utf-8") as merged:
        for result in sorted(results, key=lambda item: int(item.get("run_index") or 0)):
            entries_path = result.get("entries_path")
            if not entries_path:
                continue
            path = Path(entries_path)
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    merged.write(line + "\n")
                    written += 1
    return written


def run_parallel_load(args: argparse.Namespace) -> list[dict[str, Any]]:
    count = int(args.load_count)
    parallel = int(args.load_parallel)
    total_to_run = int(args.load_runs or parallel)
    next_run = int(args.load_start_run)
    final_run = next_run + total_to_run - 1
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as executor:
        futures: dict[concurrent.futures.Future[dict[str, Any]], int] = {}
        while next_run <= final_run and len(futures) < parallel:
            offset = (next_run - 1) * count
            futures[executor.submit(run_one, args, count, next_run, offset)] = next_run
            next_run += 1
        while futures:
            done, _ = concurrent.futures.wait(futures, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                futures.pop(future)
                result = future.result()
                results.append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
                append_jsonl(args.results_jsonl, result)
                if next_run <= final_run:
                    offset = (next_run - 1) * count
                    futures[executor.submit(run_one, args, count, next_run, offset)] = next_run
                    next_run += 1
    if args.merged_entries_jsonl:
        written = merge_entries(results, args.merged_entries_jsonl)
        print(json.dumps({"merged_entries_jsonl": str(args.merged_entries_jsonl), "entries_written": written}), flush=True)
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/Users/awilliamspcsevents/PROJECTS/dynamic-workers"))
    parser.add_argument("--counts", default="25,50,80,120")
    parser.add_argument("--chars-per-item", type=int, default=1200)
    parser.add_argument("--roots", default="workers/api/src,workers/ui/src")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--provider", default="deepseek")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument(
        "--hard-timeout-seconds",
        type=int,
        default=240,
        help="Total wall-clock cap per request across all attempts. Use 0 to disable.",
    )
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/deepseek-json-sweep"))
    parser.add_argument("--results-jsonl", type=Path, default=Path("/tmp/deepseek-json-sweep/results.jsonl"))
    parser.add_argument("--load-parallel", type=int, default=0, help="Run N requests in parallel instead of sequential counts.")
    parser.add_argument("--load-count", type=int, default=35, help="Items per request for --load-parallel.")
    parser.add_argument("--load-runs", type=int, default=0, help="Total request count for --load-parallel. Defaults to --load-parallel.")
    parser.add_argument("--load-start-run", type=int, default=1, help="One-based run index to start from for resumable retries.")
    parser.add_argument("--merged-entries-jsonl", type=Path, default=None, help="Merge parsed per-run entries into this JSONL path.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.results_jsonl.parent.mkdir(parents=True, exist_ok=True)
    if args.load_parallel:
        run_parallel_load(args)
        return 0
    counts = [int(value) for value in args.counts.split(",") if value.strip()]
    with args.results_jsonl.open("a", encoding="utf-8") as handle:
        for count in counts:
            result = run_one(args, count)
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            handle.flush()
            print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
