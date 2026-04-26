#!/usr/bin/env python3
"""Generate a deterministic lightweight digest sidecar for indexing experiments.

This is intentionally not the full codebase-digest workflow. It creates the
minimal sidecar recommended by the Gemini/DeepSeek council: slice_id, files,
and one compact module_purpose sentence.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import fnmatch
import hashlib
import json
import os
import subprocess
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


VALID_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".json", ".prisma",
    ".md", ".mdx", ".css", ".scss", ".sql", ".sh",
    ".yml", ".yaml", ".py", ".html", ".xml", ".txt",
}
DEFAULT_LAUNCHER_API_BASE = "https://intel-launcher.ajwc.cc"


def split_globs(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def path_matches_any(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatch(path, pattern):
            return True
        if "/**/" in pattern and fnmatch.fnmatch(path, pattern.replace("/**/", "/")):
            return True
    return False


def git_files(repo: Path) -> list[str]:
    result = subprocess.run(["git", "ls-files", "--cached"], cwd=repo, text=True, capture_output=True, check=True)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def should_include(rel_path: str, include_globs: list[str], exclude_globs: list[str]) -> bool:
    normalized = rel_path.replace(os.sep, "/")
    if include_globs and not path_matches_any(normalized, include_globs):
        return False
    if exclude_globs and path_matches_any(normalized, exclude_globs):
        return False
    if Path(normalized).suffix not in VALID_EXTENSIONS:
        return False
    parts = set(Path(normalized).parts)
    if parts & {".git", ".next", ".venv", "__pycache__", "build", "coverage", "dist", "node_modules", "vendor", "vendors"}:
        return False
    name = Path(normalized).name.lower()
    if name in {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"}:
        return False
    if name.endswith((".log", ".map", ".min.css", ".min.js")):
        return False
    return True


def slice_for_path(rel_path: str) -> str:
    parts = Path(rel_path.replace(os.sep, "/")).parts
    if not parts:
        return "root"
    if parts[0] in {"apps", "packages", "workers", "services"} and len(parts) >= 2:
        return "/".join(parts[:2])
    if parts[0] == "src" and len(parts) >= 2:
        return "/".join(parts[:2])
    if len(parts) == 1:
        return "root"
    return parts[0]


def file_role(rel_path: str) -> str:
    lower = rel_path.lower()
    if any(part in lower for part in ("/test/", "/tests/", "__tests__", ".test.", ".spec.", "-test/")):
        return "tests"
    if any(part in lower for part in ("/docs/", "readme", ".md")):
        return "docs"
    if any(part in lower for part in ("wrangler", "package.json", "tsconfig", "config", ".yml", ".yaml", ".json")):
        return "configuration"
    if any(part in lower for part in ("worker", "handler", "route", "api", "server")):
        return "runtime code"
    return "source code"


def compact_module_purpose(slice_id: str, files: list[str]) -> str:
    roles = Counter(file_role(path) for path in files)
    extensions = Counter(Path(path).suffix.lstrip(".") or "no-extension" for path in files)
    top_roles = ", ".join(role for role, _ in roles.most_common(3))
    top_exts = ", ".join(ext for ext, _ in extensions.most_common(3))
    readable_slice = slice_id.replace("/", " ")
    return (
        f"{slice_id} groups {top_roles or 'source files'} for the {readable_slice} area; "
        f"primary file types are {top_exts or 'mixed'}."
    )[:320]


def read_preview(repo: Path, rel_path: str, max_chars: int, max_lines: int) -> str:
    try:
        text = (repo / rel_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    text = "\n".join(line.rstrip() for line in text.splitlines()[:max_lines])
    return text[:max_chars]


def build_slice_upload_text(
    repo: Path,
    record: dict[str, Any],
    sample_files: int,
    preview_chars: int,
    preview_lines: int,
) -> str:
    files = list(record["files"])
    sampled_files = files[:sample_files]
    previews = []
    for rel_path in sampled_files:
        preview = read_preview(repo, rel_path, preview_chars, preview_lines)
        if preview:
            previews.append(f"### {rel_path}\n{preview}")
    payload = {
        "slice_id": record["slice_id"],
        "files": sampled_files,
        "file_count": len(files),
        "deterministic_fallback": record["module_purpose"],
    }
    return (
        f"Slice metadata:\n{json.dumps(payload, ensure_ascii=False)}\n\n"
        f"Sample snippets:\n{chr(10).join(previews) if previews else '[no snippets]'}"
    )


def stage_slice_upload_file(
    repo: Path,
    record: dict[str, Any],
    staging_dir: Path,
    sample_files: int,
    preview_chars: int,
    preview_lines: int,
) -> Path:
    safe_name = re_safe_filename(record["slice_id"])
    file_path = staging_dir / f"{safe_name}.txt"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(
        build_slice_upload_text(repo, record, sample_files, preview_chars, preview_lines),
        encoding="utf-8",
    )
    return file_path


def re_safe_filename(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in value)
    return safe.strip("-") or "slice"


def build_launcher_prompt() -> str:
    return (
        "You are generating compact module context for a code-search embedding sidecar.\n"
        "Return JSON only with this exact schema: "
        "{\"module_purpose\":\"one concrete sentence under 45 words\"}.\n"
        "The sentence must be grounded only in the attached file paths and snippets. "
        "Do not mention that this is a slice or an embedding. Do not invent product facts.\n\n"
    )


def parse_module_purpose(reply: str) -> str:
    text = str(reply or "").strip()
    if not text:
        return ""
    if "```" in text:
        parts = text.split("```")
        text = max(parts, key=len).strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return ""
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return ""
    purpose = str(data.get("module_purpose") or "").strip()
    words = purpose.split()
    return " ".join(words[:60])


def encode_multipart(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = "----qdrant-digest-{digest}".format(
        digest=hashlib.sha256(str(file_path).encode("utf-8")).hexdigest()[:16]
    )
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
            str(value).encode("utf-8"),
            b"\r\n",
        ])
    chunks.extend([
        f"--{boundary}\r\n".encode("utf-8"),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'.encode("utf-8"),
        b"Content-Type: text/plain; charset=utf-8\r\n\r\n",
        file_path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def call_launcher_api(
    api_base: str,
    provider: str,
    prompt: str,
    upload_path: Path,
    session_id: str,
    attempts: int,
    timeout: int,
) -> str:
    endpoint = api_base.rstrip("/") + "/runs/parallel"
    last_response: Any = None
    for attempt in range(1, attempts + 1):
        request_data, content_type = encode_multipart(
            {
                "prompt": prompt,
                "provider": provider,
                "sessionId": session_id,
            },
            "file",
            upload_path,
        )
        request = urllib.request.Request(
            endpoint,
            data=request_data,
            headers={"Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
        except Exception as exc:
            last_response = {"transport_error": str(exc)}
        else:
            last_response = data
            providers = data.get("providers") or []
            failed = data.get("summary", {}).get("failed", 1)
            if not failed and providers and providers[0].get("status") == "success":
                return str(providers[0].get("reply") or "")
        if attempt < attempts:
            time.sleep(2 if attempt == 1 else 5)
    raise RuntimeError("launcher provider degraded: " + json.dumps(last_response, ensure_ascii=False)[:1000])


def enrich_record_with_launcher(
    repo: Path,
    record: dict[str, Any],
    api_base: str,
    provider: str,
    attempts: int,
    timeout: int,
    staging_dir: Path,
    sample_files: int,
    preview_chars: int,
    preview_lines: int,
) -> dict[str, Any]:
    upload_path = stage_slice_upload_file(repo, record, staging_dir, sample_files, preview_chars, preview_lines)
    prompt = build_launcher_prompt()
    session_id = "qdrant-digest-{slice_hash}".format(
        slice_hash=hashlib.sha256(record["slice_id"].encode("utf-8")).hexdigest()[:12]
    )
    try:
        reply = call_launcher_api(api_base, provider, prompt, upload_path, session_id, attempts, timeout)
        purpose = parse_module_purpose(reply)
    except Exception as exc:
        record["module_purpose_error"] = str(exc)[:500]
        return record
    if purpose:
        record["module_purpose"] = purpose[:360]
        record["module_purpose_source"] = f"launcher:{provider}"
    else:
        record["module_purpose_error"] = "launcher reply did not contain parseable module_purpose"
    return record


def enrich_records_with_launcher(
    repo: Path,
    records: list[dict[str, Any]],
    api_base: str,
    provider: str,
    attempts: int,
    timeout: int,
    concurrency: int,
    limit: int | None,
    staging_dir: Path,
    sample_files: int,
    preview_chars: int,
    preview_lines: int,
) -> list[dict[str, Any]]:
    selected = records[:limit] if limit is not None else records
    by_slice = {record["slice_id"]: record for record in records}
    max_workers = min(max(1, concurrency), 7, len(selected) or 1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                enrich_record_with_launcher,
                repo,
                dict(record),
                api_base,
                provider,
                attempts,
                timeout,
                staging_dir,
                sample_files,
                preview_chars,
                preview_lines,
            ): record["slice_id"]
            for record in selected
        }
        for future in concurrent.futures.as_completed(futures):
            slice_id = futures[future]
            by_slice[slice_id].update(future.result())
    return records


def content_hash_for_files(repo: Path, files: list[str]) -> str:
    digest = hashlib.sha256()
    for rel_path in sorted(files):
        digest.update(rel_path.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update((repo / rel_path).read_bytes())
        except OSError:
            pass
        digest.update(b"\0")
    return digest.hexdigest()


def build_records(repo: Path, include_globs: list[str], exclude_globs: list[str]) -> list[dict[str, Any]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for rel_path in git_files(repo):
        if should_include(rel_path, include_globs, exclude_globs):
            grouped[slice_for_path(rel_path)].append(rel_path)
    records = []
    for slice_id, files in sorted(grouped.items()):
        files = sorted(files)
        module_purpose = compact_module_purpose(slice_id, files)
        records.append({
            "slice_id": slice_id,
            "files": files,
            "module_purpose": module_purpose,
            "module_purpose_source": "deterministic",
            "digest_version": "deterministic-module-purpose-v1",
            "digest_model": "deterministic",
            "slice_content_hash": content_hash_for_files(repo, files),
        })
    return records


def write_jsonl_atomic(path: Path, records: list[dict[str, Any]]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    os.replace(tmp_path, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--include-globs", default=os.environ.get("QDRANT_INCLUDE_GLOBS", ""))
    parser.add_argument("--exclude-globs", default=os.environ.get("QDRANT_EXCLUDE_GLOBS", ""))
    parser.add_argument("--launcher-api-base", default=os.environ.get("LAUNCHER_API_BASE", ""))
    parser.add_argument("--provider", default=os.environ.get("LAUNCHER_DIGEST_PROVIDER", "gemini"))
    parser.add_argument("--launcher-attempts", type=int, default=3)
    parser.add_argument("--launcher-timeout", type=int, default=240)
    parser.add_argument("--launcher-concurrency", type=int, default=1)
    parser.add_argument("--launcher-limit", type=int, help="Only enrich the first N slices; useful for smoke tests.")
    parser.add_argument("--launcher-staging-dir", type=Path, default=Path("/tmp/qdrant-digest-launcher-slices"))
    parser.add_argument("--slice-sample-files", type=int, default=5)
    parser.add_argument("--slice-preview-chars", type=int, default=1200)
    parser.add_argument("--slice-preview-lines", type=int, default=80)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.repo.resolve()
    records = build_records(repo, split_globs(args.include_globs), split_globs(args.exclude_globs))
    if args.launcher_api_base:
        records = enrich_records_with_launcher(
            repo,
            records,
            args.launcher_api_base or DEFAULT_LAUNCHER_API_BASE,
            args.provider,
            args.launcher_attempts,
            args.launcher_timeout,
            args.launcher_concurrency,
            args.launcher_limit,
            args.launcher_staging_dir,
            args.slice_sample_files,
            args.slice_preview_chars,
            args.slice_preview_lines,
        )
    write_jsonl_atomic(args.output, records)
    print(json.dumps({
        "repo": str(repo),
        "output": str(args.output),
        "slices": len(records),
        "files": sum(len(record["files"]) for record in records),
        "launcher_enriched": sum(1 for record in records if str(record.get("module_purpose_source", "")).startswith("launcher:")),
        "launcher_errors": sum(1 for record in records if record.get("module_purpose_error")),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
