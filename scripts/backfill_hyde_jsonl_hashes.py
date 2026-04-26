#!/usr/bin/env python3
"""Backfill content-addressed cache fields into existing HyDE JSONL files.

This is a no-network migration helper. It re-chunks a repository with the same
logic used by scripts/gemini_hyde_batch.py, matches records by legacy chunk id,
and writes content_hash/hyde_version into each JSONL record.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
GEMINI_BATCH_PATH = ROOT / "scripts" / "gemini_hyde_batch.py"


def load_gemini_batch_module():
    spec = importlib.util.spec_from_file_location("gemini_hyde_batch", GEMINI_BATCH_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import {GEMINI_BATCH_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_jsonl(path: Path) -> list[tuple[dict[str, Any] | None, str]]:
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            records.append((None, line))
            continue
        try:
            records.append((json.loads(line), line))
        except json.JSONDecodeError:
            records.append((None, line))
    return records


def write_jsonl_atomic(path: Path, lines: list[str]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    os.replace(tmp_path, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Repo used to generate the HyDE JSONL.")
    parser.add_argument("--input", type=Path, required=True, help="Existing HyDE JSONL file.")
    parser.add_argument("--output", type=Path, help="Output JSONL file. Defaults to in-place update.")
    parser.add_argument("--hyde-version", default=os.environ.get("HYDE_SCHEMA_VERSION", "gemini-hyde-questions-v3"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    module = load_gemini_batch_module()
    chunks = module.ensure_chunk_hashes(list(module.iter_repo_chunks(args.repo.resolve())))
    chunks_by_id = {str(chunk["id"]): chunk for chunk in chunks}

    output_path = args.output or args.input
    output_lines = []
    updated = 0
    missing = 0
    invalid = 0

    for record, raw_line in read_jsonl(args.input):
        if record is None:
            output_lines.append(raw_line)
            if raw_line.strip():
                invalid += 1
            continue
        chunk = chunks_by_id.get(str(record.get("id") or ""))
        if not chunk:
            missing += 1
            output_lines.append(json.dumps(record, ensure_ascii=False))
            continue
        if record.get("content_hash") != chunk["content_hash"]:
            record["content_hash"] = chunk["content_hash"]
            updated += 1
        if not record.get("hyde_version"):
            record["hyde_version"] = args.hyde_version
            updated += 1
        if not record.get("line_range") and chunk.get("line_range"):
            record["line_range"] = chunk["line_range"]
        output_lines.append(json.dumps(record, ensure_ascii=False))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_jsonl_atomic(output_path, output_lines)
    print(json.dumps({
        "input": str(args.input),
        "output": str(output_path),
        "repo": str(args.repo.resolve()),
        "records": len(output_lines),
        "repo_chunks": len(chunks_by_id),
        "updated_fields": updated,
        "missing_chunk_ids": missing,
        "invalid_lines": invalid,
    }))
    return 0 if invalid == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
