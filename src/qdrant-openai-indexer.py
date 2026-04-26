#!/usr/bin/env python3
import os
import sys
import argparse
from pathlib import Path
from typing import List, Dict, Any
import logging
import hashlib
import concurrent.futures
import time
import subprocess
import uuid
import json
import threading
import httpx
import re
import fnmatch
from collections import Counter

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        Distance,
        VectorParams,
        SparseVectorParams,
        SparseIndexParams,
        SparseVector,
        PointStruct,
        Filter,
        FieldCondition,
        MatchValue,
        PointIdsList,
    )
    from tenacity import retry, wait_exponential, stop_after_attempt, retry_if_exception_type
except ImportError as e:
    logger.error(f"Required package not installed: {e}")
    sys.exit(1)

VALID_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx', '.json', '.prisma', 
    '.md', '.mdx', '.css', '.scss', '.sql', '.sh', 
    '.yml', '.yaml', '.py', '.html', '.xml', '.txt'
}

CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
MAX_FILE_SIZE_BYTES = 1_000_000
LONG_LINE_GENERATED_THRESHOLD = 20_000
NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
MAX_DELETE_PERCENT = 0.20 
DEFAULT_COLLECTION_NAME = "my-codebase-v2"
LEGACY_COLLECTION_NAME = "my-codebase"
HYDE_SCHEMA_VERSION = os.environ.get("HYDE_SCHEMA_VERSION", "gemini-flash-lite-hyde-questions-v3")
METADATA_SCHEMA_VERSION = "agentic-code-search-metadata-v1"
CHUNK_ID_VERSION = "path-index-v1"
SUMMARY_SCHEMA_VERSION = "deterministic-summary-v1"
DEFAULT_HYDE_MODEL = "gpt-5.4-nano"
DEFAULT_HYDE_QUESTION_COUNT = 12
DEFAULT_BLAST_KEY_PATH = "/Users/awilliamspcsevents/evrylo/lumae.ai/blastkey.txt"
MAX_EMBEDDING_TEXT_CHARS = 12_000
DENSE_VECTOR_HYDE = "hyde_dense"
DENSE_VECTOR_CODE = "code_dense"
DENSE_VECTOR_SUMMARY = "summary_dense"
SPARSE_VECTOR_LEXICAL = "lexical_sparse"
SPARSE_HASH_BUCKETS = 1_000_003
SPARSE_HASH_VERSION = "sha256-mod-1000003-v1"
EXCLUDED_DIR_NAMES = {
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "qdrant_storage",
    "vendor",
    "vendors",
}
EXCLUDED_FILE_NAMES = {
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}
EXCLUDED_FILE_SUFFIXES = {
    ".log",
    ".map",
    ".min.css",
    ".min.js",
}
GENERATED_CSS_NAMES = {
    "tailwind.css",
    "pipeline_tailwind.css",
}


def _split_globs(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


INCLUDE_PATH_GLOBS = _split_globs(os.environ.get("QDRANT_INCLUDE_GLOBS", ""))
EXCLUDE_PATH_GLOBS = _split_globs(os.environ.get("QDRANT_EXCLUDE_GLOBS", ""))


def _path_matches_any(path: str, patterns: List[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatch(path, pattern):
            return True
        if "/**/" in pattern and fnmatch.fnmatch(path, pattern.replace("/**/", "/")):
            return True
    return False

LANGUAGE_BY_EXTENSION = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".json": "json",
    ".prisma": "prisma",
    ".md": "markdown",
    ".mdx": "mdx",
    ".css": "css",
    ".scss": "scss",
    ".sql": "sql",
    ".sh": "shell",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".html": "html",
    ".xml": "xml",
    ".txt": "text",
}

SYMBOL_PATTERNS = {
    "python": [
        re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:", re.MULTILINE),
        re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:", re.MULTILINE),
    ],
    "javascript": [
        re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)", re.MULTILINE),
        re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>", re.MULTILINE),
        re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b", re.MULTILINE),
    ],
    "typescript": [
        re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)", re.MULTILINE),
        re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]", re.MULTILINE),
        re.compile(r"^\s*(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b", re.MULTILINE),
    ],
}

IMPORT_PATTERNS = {
    "python": [
        re.compile(r"^\s*import\s+(.+)$", re.MULTILINE),
        re.compile(r"^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$", re.MULTILINE),
    ],
    "javascript": [
        re.compile(r"^\s*import\s+.+?\s+from\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
        re.compile(r"^\s*import\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
        re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    ],
    "typescript": [
        re.compile(r"^\s*import\s+.+?\s+from\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
        re.compile(r"^\s*import\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
        re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    ],
}

HYDE_DEVELOPER_PROMPT = """You are building a RAG system for an autonomous coding agent. Given a code chunk, generate highly technical, targeted search queries and questions that an agentic tool would realistically ask to locate this specific logic within a massive codebase.

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

Return only strict JSON matching the requested schema. Each question should be specific enough that a semantic code search over HyDE question embeddings can retrieve this exact chunk."""

HYDE_EXAMPLE_CODE = """File: services/search_indexer.py

def sync_document_chunks(document_id, chunks, qdrant_client, embedding_client):
    existing = qdrant_client.scroll(
        collection_name="documents",
        scroll_filter=Filter(must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]),
        with_payload=["chunk_hash", "chunk_index"],
        with_vectors=False,
    )
    expected_ids = set()
    pending = []
    for index, text in enumerate(chunks):
        chunk_hash = sha256(text.encode("utf-8")).hexdigest()
        point_id = str(uuid5(INDEX_NAMESPACE, f"{document_id}:{index}"))
        expected_ids.add(point_id)
        if existing.get(point_id, {}).get("chunk_hash") == chunk_hash:
            continue
        pending.append({"id": point_id, "text": text, "chunk_hash": chunk_hash, "chunk_index": index})

    stale_ids = [point_id for point_id in existing if point_id not in expected_ids]
    if stale_ids:
        qdrant_client.delete(collection_name="documents", points_selector=PointIdsList(points=stale_ids), wait=True)

    vectors = embedding_client.embed_documents([item["text"] for item in pending])
    qdrant_client.upsert(
        collection_name="documents",
        points=[
            PointStruct(
                id=item["id"],
                vector=vector,
                payload={"document_id": document_id, "chunk_index": item["chunk_index"], "chunk_hash": item["chunk_hash"]},
            )
            for item, vector in zip(pending, vectors)
        ],
        wait=True,
    )
"""

HYDE_EXAMPLE_RESPONSE = {
    "hyde_questions": [
        {
            "question": "Where is sync_document_chunks called, and what object types are expected for qdrant_client.scroll/delete/upsert and embedding_client.embed_documents?"
        },
        {
            "question": "How does the document chunk indexer compare existing payload['chunk_hash'] against freshly computed sha256 hashes to skip unchanged chunks?"
        },
        {
            "question": "Find the Qdrant scroll filter that loads points by document_id without vectors and returns chunk_hash/chunk_index payload fields for incremental indexing."
        },
        {
            "question": "Where are deterministic uuid5 point IDs generated from document_id and chunk index, and what happens to IDs when chunk ordering changes?"
        },
        {
            "question": "Which cleanup logic deletes stale Qdrant point IDs with PointIdsList when a document shrinks or removes chunks?"
        },
        {
            "question": "What payload schema is written to the documents collection during qdrant_client.upsert, especially document_id, chunk_index, and chunk_hash?"
        },
        {
            "question": "How does the indexer avoid embedding unchanged chunks, and where are pending chunks batched before embedding_client.embed_documents is called?"
        },
        {
            "question": "What tests should cover idempotent reruns of sync_document_chunks, stale ID deletion, and chunk_hash mismatch re-embedding behavior?"
        }
    ]
}

MODEL_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}

class CodebaseIndexer:
    def __init__(self, collection_name: str = DEFAULT_COLLECTION_NAME):
        self.openai_api_key = self._resolve_openai_api_key()
        self.fallback_openai_api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        
        if not self.openai_api_key:
            raise ValueError("OpenAI API key is required via blastkey.txt or OPENAI_API_KEY")
            
        self.collection_name = collection_name
        self.use_v2_vectors = (
            os.environ.get("QDRANT_USE_V2_SCHEMA", "").strip().lower() in {"1", "true", "yes"}
            or self.collection_name != LEGACY_COLLECTION_NAME
        )
        self.qdrant_url = os.environ.get("QDRANT_URL", "http://localhost:6333")
        self.openai_base_url = (os.environ.get("CLOUDFLARE_AI_GATEWAY_URL") or os.environ.get("OPENAI_BASE_URL") or "").strip() or None
        self.embedding_model = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
        self.hyde_model = os.environ.get("OPENAI_HYDE_MODEL", DEFAULT_HYDE_MODEL)
        self.hyde_question_count = int(os.environ.get("HYDE_QUESTION_COUNT", DEFAULT_HYDE_QUESTION_COUNT))
        self.hyde_workers = int(os.environ.get("HYDE_WORKERS", "8"))
        self.hyde_worker_url = os.environ.get("HYDE_WORKER_URL", "").strip().rstrip("/")
        self.hyde_worker_token = os.environ.get("HYDE_WORKER_TOKEN", "").strip()
        self.hyde_worker_batch_size = int(os.environ.get("HYDE_WORKER_BATCH_SIZE", "20"))
        self.hyde_worker_requests = int(os.environ.get("HYDE_WORKER_REQUESTS", str(min(self.hyde_workers, 8))))
        self.hyde_worker_job_mode = os.environ.get("HYDE_WORKER_JOB_MODE", "").strip().lower() in {"1", "true", "yes"}
        self.hyde_worker_job_shard_size = int(os.environ.get("HYDE_WORKER_JOB_SHARD_SIZE", "250"))
        self.hyde_worker_job_poll_interval = float(os.environ.get("HYDE_WORKER_JOB_POLL_INTERVAL", "2"))
        self.hyde_worker_job_timeout = float(os.environ.get("HYDE_WORKER_JOB_TIMEOUT", "900"))
        self.hyde_precomputed_jsonl = os.environ.get("HYDE_PRECOMPUTED_JSONL", "").strip()
        self.precomputed_hydes = self._load_precomputed_hydes(self.hyde_precomputed_jsonl)
        self.digest_sidecar_jsonl = os.environ.get("DIGEST_SIDECAR_JSONL", "").strip()
        self.digest_by_file = self._load_digest_sidecar(self.digest_sidecar_jsonl)
        self.embedding_batch_size = int(os.environ.get("OPENAI_EMBEDDING_BATCH_SIZE", "32"))
        self.embedding_workers = int(os.environ.get("OPENAI_EMBEDDING_WORKERS", "4"))
        self.embedding_worker_url = os.environ.get("EMBEDDING_WORKER_URL", "").strip().rstrip("/")
        self.embedding_worker_token = os.environ.get("EMBEDDING_WORKER_TOKEN", "").strip()
        self.qdrant_upsert_batch_size = int(os.environ.get("QDRANT_UPSERT_BATCH_SIZE", "50"))
        self.vector_size = MODEL_DIMS.get(self.embedding_model, 3072)
        
        self.openai_client = self._build_openai_client(self.openai_api_key)
        self._openai_client_lock = threading.Lock()
        self.qdrant_client = QdrantClient(url=self.qdrant_url)
        if self.hyde_worker_url:
            logger.info(
                "HyDE generation will use Cloudflare Worker %s with batch_size=%s request_workers=%s.",
                self.hyde_worker_url,
                self.hyde_worker_batch_size,
                self.hyde_worker_requests,
            )
        if self.precomputed_hydes:
            logger.info(
                "Loaded %s precomputed HyDE records from %s.",
                len(self.precomputed_hydes),
                self.hyde_precomputed_jsonl,
            )
        if self.digest_by_file:
            logger.info(
                "Loaded digest sidecar for %s files from %s.",
                len(self.digest_by_file),
                self.digest_sidecar_jsonl,
            )
        if self.embedding_worker_url:
            logger.info("Embedding requests will be delegated to Cloudflare Worker %s.", self.embedding_worker_url)
        
        self.stats = {
            "files_scanned": 0,
            "files_skipped": 0,
            "chunks_skipped": 0,
            "chunks_upserted": 0,
            "line_payloads_backfilled": 0,
            "errors": 0,
            "embedding_batch_splits": 0,
            "embedding_single_fallbacks": 0,
            "hyde_worker_jobs": 0,
            "points_deleted": 0,
        }
        self._stats_lock = threading.Lock()
        self._ensure_collection()

    def _resolve_openai_api_key(self) -> str:
        blast_key_path = Path(os.environ.get("OPENAI_BLAST_KEY_PATH", DEFAULT_BLAST_KEY_PATH)).expanduser()
        if blast_key_path.is_file():
            try:
                blast_key = blast_key_path.read_text(encoding="utf-8").strip()
                if blast_key:
                    logger.info("Using OpenAI blast key from %s.", blast_key_path)
                    return blast_key
            except OSError as exc:
                logger.warning("Unable to read OpenAI blast key from %s: %s", blast_key_path, exc)
        return os.environ.get("OPENAI_API_KEY", "").strip()

    def _build_openai_client(self, api_key: str) -> OpenAI:
        client_kwargs: Dict[str, Any] = {
            "api_key": api_key,
            "http_client": httpx.Client(http2=True),
        }
        if self.openai_base_url:
            client_kwargs["base_url"] = self.openai_base_url
        logger.info("OpenAI client initialized (%s).", f"gateway={self.openai_base_url}" if self.openai_base_url else "direct OpenAI")
        return OpenAI(**client_kwargs)

    def _should_fallback_openai_key(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return any(
            marker in text
            for marker in (
                "insufficient_quota",
                "quota",
                "billing",
                "rate limit",
                "rate_limit",
                "429",
            )
        )

    def _switch_to_fallback_openai_key(self, exc: Exception) -> bool:
        if not self.fallback_openai_api_key or self.fallback_openai_api_key == self.openai_api_key:
            return False
        if not self._should_fallback_openai_key(exc):
            return False
        with self._openai_client_lock:
            if self.openai_api_key == self.fallback_openai_api_key:
                return True
            logger.warning("OpenAI blast key appears exhausted or rate limited; switching to OPENAI_API_KEY fallback.")
            self.openai_api_key = self.fallback_openai_api_key
            self.openai_client = self._build_openai_client(self.openai_api_key)
        return True

    def _call_openai_with_key_fallback(self, operation):
        try:
            return operation()
        except Exception as exc:
            if self._switch_to_fallback_openai_key(exc):
                return operation()
            raise
    
    def _ensure_collection(self):
        try:
            collections = self.qdrant_client.get_collections()
            collection_names = [c.name for c in collections.collections]
            if self.collection_name not in collection_names:
                if self.use_v2_vectors:
                    self.qdrant_client.create_collection(
                        collection_name=self.collection_name,
                        vectors_config={
                            DENSE_VECTOR_HYDE: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                            DENSE_VECTOR_CODE: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                            DENSE_VECTOR_SUMMARY: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                        },
                        sparse_vectors_config={
                            SPARSE_VECTOR_LEXICAL: SparseVectorParams(index=SparseIndexParams(on_disk=False)),
                        },
                    )
                else:
                    self.qdrant_client.create_collection(
                        collection_name=self.collection_name,
                        vectors_config=VectorParams(size=self.vector_size, distance=Distance.COSINE)
                    )
            self.qdrant_client.create_payload_index(self.collection_name, "file", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "content_hash", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "hyde_version", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "metadata_version", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "language", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "chunk_type", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "file_role", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "symbols_defined", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "path_tokens", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "slice_id", "keyword")
            self.qdrant_client.create_payload_index(self.collection_name, "digest_context_hash", "keyword")
        except Exception as e:
            logger.error(f"Ensuring collection failed: {e}")
            raise

    def _get_content_hash(self, text: str) -> str:
        return hashlib.sha256(text.encode('utf-8')).hexdigest()

    def _get_input_hash(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _hyde_cache_key(self, content_hash: str, hyde_version: str = None, hyde_model: str = None) -> str:
        return "content:{content_hash}:hyde:{hyde_version}:model:{hyde_model}".format(
            content_hash=content_hash,
            hyde_version=hyde_version or HYDE_SCHEMA_VERSION,
            hyde_model=hyde_model or self.hyde_model,
        )

    def _hyde_cache_key_any_model(self, content_hash: str, hyde_version: str = None) -> str:
        return "content:{content_hash}:hyde:{hyde_version}:model:*".format(
            content_hash=content_hash,
            hyde_version=hyde_version or HYDE_SCHEMA_VERSION,
        )

    def _truncate_digest_context(self, text: str, max_words: int = 120) -> str:
        words = str(text or "").strip().split()
        return " ".join(words[:max_words])

    def _digest_context_hash(self, digest: Dict[str, Any]) -> str:
        context = {
            "slice_id": digest.get("slice_id") or "",
            "module_purpose": digest.get("module_purpose") or "",
            "digest_version": digest.get("digest_version") or "",
            "digest_model": digest.get("digest_model") or "",
            "slice_content_hash": digest.get("slice_content_hash") or "",
        }
        return self._get_input_hash(json.dumps(context, sort_keys=True, ensure_ascii=False))

    def _load_digest_sidecar(self, jsonl_path: str) -> Dict[str, Dict[str, Any]]:
        if not jsonl_path:
            return {}
        path = Path(jsonl_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"DIGEST_SIDECAR_JSONL does not exist: {path}")
        digest_by_file: Dict[str, Dict[str, Any]] = {}
        failed = 0
        for line_number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                failed += 1
                continue
            slice_id = str(record.get("slice_id") or "").strip()
            files = record.get("files") or []
            if not slice_id or not isinstance(files, list):
                failed += 1
                continue
            digest = {
                "slice_id": slice_id,
                "module_purpose": self._truncate_digest_context(record.get("module_purpose") or ""),
                "digest_version": str(record.get("digest_version") or "unknown"),
                "digest_model": str(record.get("digest_model") or "unknown"),
                "slice_content_hash": str(record.get("slice_content_hash") or ""),
                "digest_source_line": line_number,
            }
            digest["digest_context_hash"] = self._digest_context_hash(digest)
            for rel_path in files:
                rel_path = str(rel_path).strip()
                if rel_path:
                    digest_by_file[rel_path] = digest
        if failed:
            logger.warning("Skipped %s invalid digest sidecar records from %s.", failed, path)
        return digest_by_file

    def _apply_digest_context(self, rel_path: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
        digest = self.digest_by_file.get(rel_path)
        if not digest:
            metadata["digest_context_hash"] = ""
            return metadata
        metadata.update({
            "slice_id": digest.get("slice_id") or "",
            "module_purpose": digest.get("module_purpose") or "",
            "digest_version": digest.get("digest_version") or "",
            "digest_model": digest.get("digest_model") or "",
            "slice_content_hash": digest.get("slice_content_hash") or "",
            "digest_context_hash": digest.get("digest_context_hash") or "",
        })
        return metadata

    def _detect_language(self, rel_path: str) -> str:
        return LANGUAGE_BY_EXTENSION.get(Path(rel_path).suffix.lower(), "unknown")

    def _pattern_language(self, language: str) -> str:
        if language.startswith("typescript"):
            return "typescript"
        if language.startswith("javascript"):
            return "javascript"
        return language

    def _path_tokens(self, rel_path: str) -> List[str]:
        tokens = re.split(r"[^A-Za-z0-9_]+", rel_path.replace(os.sep, "/"))
        return sorted({token.lower() for token in tokens if token})

    def _detect_file_role(self, rel_path: str, language: str) -> str:
        lower_path = rel_path.lower().replace(os.sep, "/")
        name = Path(lower_path).name
        if any(part in lower_path for part in ("/test/", "/tests/", "__tests__", ".test.", ".spec.")):
            return "test"
        if any(part in lower_path for part in ("/route", "/routes", "/api/", "controller")):
            return "route"
        if any(part in lower_path for part in ("model", "schema", "prisma")):
            return "model"
        if any(part in lower_path for part in ("config", ".env", "settings")) or language in {"json", "yaml"}:
            return "config"
        if language in {"typescriptreact", "javascriptreact", "html", "css", "scss"} or name.endswith((".tsx", ".jsx")):
            return "ui"
        if language in {"markdown", "mdx", "text"}:
            return "docs"
        if language in {"shell", "sql"}:
            return "script"
        if any(part in lower_path for part in ("service", "client", "adapter", "worker")):
            return "service"
        return "unknown"

    def _extract_symbols_defined(self, text: str, language: str) -> List[str]:
        pattern_language = self._pattern_language(language)
        symbols = []
        for pattern in SYMBOL_PATTERNS.get(pattern_language, []):
            for match in pattern.finditer(text):
                symbol = str(match.group(1)).strip()
                if symbol:
                    symbols.append(symbol)
        return sorted(dict.fromkeys(symbols))

    def _extract_imports(self, text: str, language: str) -> List[str]:
        pattern_language = self._pattern_language(language)
        imports = []
        for pattern in IMPORT_PATTERNS.get(pattern_language, []):
            for match in pattern.finditer(text):
                if pattern_language == "python" and pattern.pattern.lstrip().startswith("^\\s*from"):
                    imports.append(str(match.group(1)).strip())
                    continue
                raw = str(match.group(1)).strip()
                for part in raw.split(","):
                    value = part.strip().split(" as ")[0].strip()
                    if value:
                        imports.append(value)
        return sorted(dict.fromkeys(imports))

    def _extract_symbols_used(self, text: str, symbols_defined: List[str]) -> List[str]:
        identifiers = re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", text)
        excluded = {
            "and", "as", "async", "await", "break", "case", "catch", "class", "const",
            "continue", "def", "delete", "do", "elif", "else", "except", "export",
            "false", "finally", "for", "from", "function", "if", "import", "in",
            "interface", "let", "new", "none", "not", "null", "or", "pass", "return",
            "self", "static", "switch", "this", "throw", "true", "try", "type", "var",
            "while", "with", "yield",
        }
        defined = set(symbols_defined)
        values = []
        for identifier in identifiers:
            lowered = identifier.lower()
            if lowered in excluded or identifier in defined:
                continue
            if len(identifier) <= 1:
                continue
            values.append(identifier)
        return sorted(dict.fromkeys(values))[:80]

    def _extract_signature(self, text: str, symbols_defined: List[str]) -> str:
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if symbols_defined and any(symbol in stripped for symbol in symbols_defined):
                return stripped[:240]
            if re.match(r"(async\s+def|def|class|export|function|const|let|var|interface|type|enum)\b", stripped):
                return stripped[:240]
        return ""

    def _detect_chunk_type(self, rel_path: str, language: str, file_role: str, text: str, symbols_defined: List[str], signature: str) -> str:
        if file_role == "test":
            return "test"
        if file_role == "config":
            return "config"
        if language in {"markdown", "mdx"}:
            return "markdown"
        if language in {"html"}:
            return "template"
        if language in {"css", "scss"}:
            return "style"
        if re.search(r"(@app\.route|Blueprint\(|router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete))", text):
            return "route"
        if re.search(r"\bclass\b", signature):
            return "class"
        if re.search(r"\b(def|function)\b|=>", signature):
            return "function"
        if symbols_defined:
            return "symbol_block"
        return "module"

    def _infer_side_effects(self, text: str) -> List[str]:
        checks = [
            ("database", r"\b(commit|execute|insert|update|delete|save|query)\b"),
            ("network", r"\b(requests\.|httpx\.|fetch\(|axios\.|OpenAI\(|AsyncOpenAI\()"),
            ("filesystem", r"\b(open\(|write_text|read_text|unlink\(|rename\(|replace\()"),
            ("cache", r"\b(cache|redis|set_payload|upsert|delete_collection|create_collection)\b"),
            ("auth", r"\b(auth|token|login|logout|permission|session)\b"),
        ]
        return [name for name, pattern in checks if re.search(pattern, text, re.IGNORECASE)]

    def _build_chunk_metadata(self, rel_path: str, chunk_text: str, chunk: Dict[str, Any]) -> Dict[str, Any]:
        language = self._detect_language(rel_path)
        file_role = self._detect_file_role(rel_path, language)
        symbols_defined = self._extract_symbols_defined(chunk_text, language)
        imports = self._extract_imports(chunk_text, language)
        symbols_used = self._extract_symbols_used(chunk_text, symbols_defined)
        signature = self._extract_signature(chunk_text, symbols_defined)
        chunk_type = self._detect_chunk_type(rel_path, language, file_role, chunk_text, symbols_defined, signature)
        what_it_does = signature or f"{chunk_type} chunk from {rel_path}"
        return {
            "metadata_version": METADATA_SCHEMA_VERSION,
            "chunk_id_version": CHUNK_ID_VERSION,
            "summary_version": SUMMARY_SCHEMA_VERSION,
            "sparse_hash_version": SPARSE_HASH_VERSION,
            "language": language,
            "file_role": file_role,
            "chunk_type": chunk_type,
            "path_tokens": self._path_tokens(rel_path),
            "symbols_defined": symbols_defined,
            "symbols_used": symbols_used,
            "imports": imports,
            "signature": signature,
            "what_it_does": what_it_does,
            "when_to_use": f"Use this result when investigating {', '.join(symbols_defined[:3]) or Path(rel_path).name}.",
            "side_effects": self._infer_side_effects(chunk_text),
            **self._line_payload(chunk),
        }

    def _lexical_tokens(self, text: str) -> List[str]:
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|[0-9]+", text)
        expanded = []
        for token in tokens:
            lowered = token.lower()
            expanded.append(lowered)
            for part in re.split(r"[_\\-]+", lowered):
                if part and part != lowered:
                    expanded.append(part)
            camel_parts = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)|[0-9]+", token)
            for part in camel_parts:
                part = part.lower()
                if part and part != lowered:
                    expanded.append(part)
        return [token for token in expanded if len(token) > 1]

    def _make_sparse_vector(self, text: str) -> SparseVector:
        counts = Counter(self._lexical_tokens(text))
        if not counts:
            return SparseVector(indices=[], values=[])
        hashed: Dict[int, float] = {}
        for token, count in counts.items():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:8], "big") % SPARSE_HASH_BUCKETS
            hashed[index] = hashed.get(index, 0.0) + float(count)
        norm = sum(value * value for value in hashed.values()) ** 0.5 or 1.0
        indices = sorted(hashed)
        values = [hashed[index] / norm for index in indices]
        return SparseVector(indices=indices, values=values)

    def _code_embedding_text(self, item: Dict[str, Any]) -> str:
        metadata = item["metadata"]
        return "\n".join(
            part for part in [
                f"File: {item['rel_path']}",
                f"Language: {metadata.get('language')}",
                f"Role: {metadata.get('file_role')}",
                f"Chunk type: {metadata.get('chunk_type')}",
                f"Signature: {metadata.get('signature')}",
                f"Symbols: {', '.join(metadata.get('symbols_defined') or [])}",
                "Code:",
                item["text"],
            ] if part
        )

    def _summary_embedding_text(self, item: Dict[str, Any]) -> str:
        metadata = item["metadata"]
        return "\n".join(
            part for part in [
                f"File: {item['rel_path']}",
                f"Path tokens: {', '.join(metadata.get('path_tokens') or [])}",
                f"What it does: {metadata.get('what_it_does')}",
                f"When to use: {metadata.get('when_to_use')}",
                f"Module purpose: {metadata.get('module_purpose')}",
                f"Side effects: {', '.join(metadata.get('side_effects') or [])}",
                f"Imports: {', '.join(metadata.get('imports') or [])}",
                f"Symbols used: {', '.join((metadata.get('symbols_used') or [])[:40])}",
            ] if part
        )

    def _lexical_vector_text(self, item: Dict[str, Any]) -> str:
        metadata = item["metadata"]
        fields = [
            item["rel_path"],
            item["text"],
            metadata.get("signature") or "",
            " ".join(metadata.get("symbols_defined") or []),
            " ".join(metadata.get("symbols_used") or []),
            " ".join(metadata.get("imports") or []),
            " ".join(metadata.get("path_tokens") or []),
            metadata.get("what_it_does") or "",
        ]
        return "\n".join(fields)

    def _build_point_vector(
        self,
        item: Dict[str, Any],
        hyde_embedding: List[float],
        code_embedding: List[float] = None,
        summary_embedding: List[float] = None,
    ) -> Any:
        if not self.use_v2_vectors:
            return hyde_embedding
        return {
            DENSE_VECTOR_HYDE: hyde_embedding,
            DENSE_VECTOR_CODE: code_embedding or hyde_embedding,
            DENSE_VECTOR_SUMMARY: summary_embedding or hyde_embedding,
            SPARSE_VECTOR_LEXICAL: self._make_sparse_vector(self._lexical_vector_text(item)),
        }

    def _upsert_index_batch(self, batch: List[Dict[str, Any]], hydes_by_id: Dict[str, Dict[str, Any]]) -> None:
        hyde_texts = []
        for item in batch:
            hyde = hydes_by_id[item["id"]]
            item["metadata"]["hyde_questions"] = hyde["hyde_questions"]
            item["metadata"]["hyde_text"] = hyde["hyde_text"]
            if hyde.get("hyde_model"):
                item["metadata"]["hyde_model"] = hyde["hyde_model"]
            if hyde.get("hyde_source_id"):
                item["metadata"]["hyde_source_id"] = hyde["hyde_source_id"]
            hyde_embedding_text = f"File: {item['rel_path']}\nHyDE questions:\n{hyde['hyde_text']}"
            code_embedding_text = self._code_embedding_text(item)
            summary_embedding_text = self._summary_embedding_text(item)
            lexical_vector_text = self._lexical_vector_text(item)
            item["metadata"]["hyde_embedding_input_hash"] = self._get_input_hash(hyde_embedding_text)
            item["metadata"]["code_embedding_input_hash"] = self._get_input_hash(code_embedding_text)
            item["metadata"]["summary_embedding_input_hash"] = self._get_input_hash(summary_embedding_text)
            item["metadata"]["sparse_vector_input_hash"] = self._get_input_hash(lexical_vector_text)
            item["metadata"]["sparse_vector_version"] = SPARSE_HASH_VERSION
            hyde_texts.append(hyde_embedding_text)

        try:
            hyde_embeddings = self._generate_embeddings(hyde_texts)
            if self.use_v2_vectors:
                code_embeddings = self._generate_embeddings([self._code_embedding_text(item) for item in batch])
                summary_embeddings = self._generate_embeddings([self._summary_embedding_text(item) for item in batch])
            else:
                code_embeddings = [None] * len(batch)
                summary_embeddings = [None] * len(batch)

            points = [
                PointStruct(
                    id=item["id"],
                    vector=self._build_point_vector(item, hyde_embedding, code_embedding, summary_embedding),
                    payload=item["metadata"],
                )
                for item, hyde_embedding, code_embedding, summary_embedding
                in zip(batch, hyde_embeddings, code_embeddings, summary_embeddings)
            ]
            for start in range(0, len(points), self.qdrant_upsert_batch_size):
                point_batch = points[start:start + self.qdrant_upsert_batch_size]
                self.qdrant_client.upsert(self.collection_name, points=point_batch, wait=True)
                self.stats["chunks_upserted"] += len(point_batch)
        except Exception as e:
            logger.error(f"Batch failed: {e}")
            self.stats["errors"] += 1

    def _fetch_file_state(self, rel_path: str) -> Dict[str, Dict[str, str]]:
        """Returns {point_id: payload state} for a specific file."""
        existing = {}
        next_offset = None
        while True:
            results, next_offset = self.qdrant_client.scroll(
                collection_name=self.collection_name,
                scroll_filter=Filter(must=[FieldCondition(key="file", match=MatchValue(value=rel_path))]),
                limit=500,
                offset=next_offset,
                with_payload=[
                    "content_hash",
                    "hyde_version",
                    "metadata_version",
                    "digest_context_hash",
                    "start_line",
                    "end_line",
                    "line_range",
                ],
                with_vectors=False
            )
            for point in results:
                payload = point.payload or {}
                existing[str(point.id)] = {
                    "content_hash": payload.get("content_hash", ""),
                    "hyde_version": payload.get("hyde_version", ""),
                    "metadata_version": payload.get("metadata_version", ""),
                    "digest_context_hash": payload.get("digest_context_hash", ""),
                    "start_line": payload.get("start_line"),
                    "end_line": payload.get("end_line"),
                    "line_range": payload.get("line_range"),
                }
            if next_offset is None: break
        return existing

    def _fetch_indexed_files(self) -> List[str]:
        files = set()
        next_offset = None
        while True:
            points, next_offset = self.qdrant_client.scroll(
                collection_name=self.collection_name,
                limit=1000,
                offset=next_offset,
                with_payload=["file"],
                with_vectors=False,
            )
            for point in points:
                payload = point.payload or {}
                rel_path = payload.get("file")
                if rel_path:
                    files.add(str(rel_path))
            if next_offset is None:
                break
        return sorted(files)

    def _count_existing_points(self) -> int:
        try:
            result = self.qdrant_client.count(collection_name=self.collection_name, exact=True)
            return int(getattr(result, "count", 0) or 0)
        except Exception as exc:
            logger.warning("Unable to count existing Qdrant points before delete guard: %s", exc)
            return 0

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

    @retry(wait=wait_exponential(multiplier=1, min=2, max=60), stop=stop_after_attempt(5))
    def _request_embeddings(self, texts: List[str]) -> List[List[float]]:
        if self.embedding_worker_url:
            return self._request_embeddings_via_worker(texts)
        response = self._call_openai_with_key_fallback(
            lambda: self.openai_client.embeddings.create(model=self.embedding_model, input=texts)
        )
        return [emb.embedding for emb in response.data]

    def _request_embeddings_via_worker(self, texts: List[str]) -> List[List[float]]:
        if not self.embedding_worker_token:
            raise ValueError("EMBEDDING_WORKER_TOKEN is required when EMBEDDING_WORKER_URL is set")
        response = httpx.post(
            f"{self.embedding_worker_url}/embed-batch",
            headers={
                "content-type": "application/json",
                "user-agent": "qdrant-embedding-batch/1.0",
                "x-batch-token": self.embedding_worker_token,
            },
            json={
                "model": self.embedding_model,
                "texts": texts,
            },
            timeout=180,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Embedding Worker returned {response.status_code}: {response.text[:500]}")
        data = response.json()
        embeddings = data.get("embeddings")
        if not data.get("ok") or not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise RuntimeError(f"Embedding Worker returned invalid payload: {str(data)[:500]}")
        return embeddings

    def _generate_embeddings(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        texts = [self._sanitize_embedding_text(text) for text in texts]
        windows = [
            texts[start:start + self.embedding_batch_size]
            for start in range(0, len(texts), self.embedding_batch_size)
        ]
        if len(windows) <= 1 or self.embedding_workers <= 1:
            embeddings = []
            for window in windows:
                embeddings.extend(self._generate_embeddings_window(window))
            return embeddings

        results: List[List[List[float]]] = [[] for _ in windows]
        max_workers = min(self.embedding_workers, len(windows))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_index = {
                executor.submit(self._generate_embeddings_window, window): index
                for index, window in enumerate(windows)
            }
            for future in concurrent.futures.as_completed(future_to_index):
                results[future_to_index[future]] = future.result()
        return [embedding for window_result in results for embedding in window_result]

    def _sanitize_embedding_text(self, text: str) -> str:
        text = str(text or "")
        text = text.encode("utf-8", "replace").decode("utf-8", "replace")
        text = "".join(
            char if char in {"\n", "\t"} or ord(char) >= 32 else " "
            for char in text
        )
        text = re.sub(r"[ \t]+", " ", text).strip()
        if len(text) > MAX_EMBEDDING_TEXT_CHARS:
            head = text[: MAX_EMBEDDING_TEXT_CHARS // 2]
            tail = text[-MAX_EMBEDDING_TEXT_CHARS // 2 :]
            text = f"{head}\n\n[... embedding text truncated ...]\n\n{tail}"
        return text or "[empty embedding input]"

    def _minimal_embedding_fallback_text(self, text: str) -> str:
        digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
        preview = text[:1000]
        return (
            "Embedding fallback for code-search chunk.\n"
            f"Original text sha256: {digest}\n"
            "Preview:\n"
            f"{preview}"
        )

    def _generate_embeddings_window(self, texts: List[str]) -> List[List[float]]:
        try:
            return self._request_embeddings(texts)
        except Exception as exc:
            if len(texts) <= 1:
                self.stats["embedding_single_fallbacks"] += 1
                fallback_text = self._minimal_embedding_fallback_text(texts[0])
                logger.warning(
                    "Embedding request for one input failed after retries; using minimal fallback text sha256=%s: %s",
                    hashlib.sha256(texts[0].encode("utf-8", "replace")).hexdigest(),
                    exc,
                )
                return self._request_embeddings([fallback_text])
            midpoint = len(texts) // 2
            self.stats["embedding_batch_splits"] += 1
            logger.warning(
                "Embedding request for %s inputs failed after retries; splitting into %s and %s inputs: %s",
                len(texts),
                midpoint,
                len(texts) - midpoint,
                exc,
            )
            return (
                self._generate_embeddings_window(texts[:midpoint])
                + self._generate_embeddings_window(texts[midpoint:])
            )

    def _hyde_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "hyde_questions": {
                    "type": "array",
                    "description": "Targeted HyDE questions for locating this code chunk in a large codebase.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "A precise technical retrieval question for this code chunk.",
                            }
                        },
                        "required": ["question"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["hyde_questions"],
            "additionalProperties": False,
        }

    def _extract_response_text(self, response: Any) -> str:
        output_text = getattr(response, "output_text", None)
        if output_text:
            return str(output_text).strip()
        chunks = []
        for item in getattr(response, "output", []) or []:
            for content in getattr(item, "content", []) or []:
                text = getattr(content, "text", None)
                if text:
                    chunks.append(str(text))
        return "\n".join(chunks).strip()

    def _generate_hyde_questions(self, chunk_text: str, rel_path: str) -> List[str]:
        response = self._call_openai_with_key_fallback(
            lambda: self.openai_client.responses.create(
                model=self.hyde_model,
                input=[
                    {
                        "role": "developer",
                        "content": [{"type": "input_text", "text": HYDE_DEVELOPER_PROMPT}],
                    },
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": HYDE_EXAMPLE_CODE}],
                    },
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": json.dumps(HYDE_EXAMPLE_RESPONSE)}],
                    },
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": f"File: {rel_path}\n\n{chunk_text}"}],
                    },
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "hyde_questions_for_code",
                        "strict": True,
                        "schema": self._hyde_schema(),
                    },
                    "verbosity": "low",
                },
                reasoning={"effort": "none", "summary": "auto"},
                tools=[],
                store=False,
            )
        )
        data = json.loads(self._extract_response_text(response))
        questions = []
        for item in data.get("hyde_questions", []):
            question = str(item.get("question") or "").strip()
            if question:
                questions.append(question)
        return questions[: self.hyde_question_count]

    def _generate_hyde_payload(self, chunk_text: str, rel_path: str) -> Dict[str, Any]:
        try:
            questions = self._generate_hyde_questions(chunk_text, rel_path)
        except Exception as exc:
            logger.warning(f"HyDE question generation failed for {rel_path}: {exc}")
            questions = []
        return self._build_hyde_payload(questions, rel_path)

    def _build_hyde_payload(self, questions: List[str], rel_path: str) -> Dict[str, Any]:
        if not questions:
            questions = [f"Where is the code logic from {rel_path} implemented, and what surrounding functions or state does this chunk use?"]
        return {
            "hyde_questions": questions,
            "hyde_text": "\n".join(f"- {question}" for question in questions),
        }

    def _load_precomputed_hydes(self, jsonl_path: str) -> Dict[str, Dict[str, Any]]:
        if not jsonl_path:
            return {}
        path = Path(jsonl_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"HYDE_PRECOMPUTED_JSONL does not exist: {path}")
        hydes: Dict[str, Dict[str, Any]] = {}
        failed = 0
        for line_number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                failed += 1
                continue
            source_id = str(record.get("id") or "").strip()
            rel_path = str(record.get("rel_path") or "").strip()
            content_hash = str(record.get("content_hash") or "").strip()
            hyde_version = str(record.get("hyde_version") or HYDE_SCHEMA_VERSION)
            hyde_model = str(record.get("model") or self.hyde_model)
            questions = [str(q).strip() for q in record.get("hyde_questions", []) if str(q).strip()]
            if not source_id or not record.get("ok") or not questions:
                failed += 1
                continue
            hyde = self._build_hyde_payload(questions, rel_path)
            hyde["hyde_model"] = hyde_model
            hyde["hyde_version"] = hyde_version
            hyde["content_hash"] = content_hash
            hyde["hyde_source_id"] = source_id
            hyde["hyde_source_line"] = line_number
            hydes[source_id] = hyde
            if content_hash:
                hydes[self._hyde_cache_key(content_hash, hyde_version, hyde_model)] = hyde
                hydes.setdefault(self._hyde_cache_key_any_model(content_hash, hyde_version), hyde)
        if failed:
            logger.warning("Skipped %s invalid/non-ok precomputed HyDE records from %s.", failed, path)
        return hydes

    def _generate_hyde_payloads_precomputed(self, batch: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        hydes: Dict[str, Dict[str, Any]] = {}
        missing = []
        for item in batch:
            source_id = str(item.get("hyde_source_id") or "")
            content_hash = str(item.get("metadata", {}).get("content_hash") or "")
            hyde = self.precomputed_hydes.get(self._hyde_cache_key(content_hash)) if content_hash else None
            if not hyde and content_hash:
                hyde = self.precomputed_hydes.get(self._hyde_cache_key_any_model(content_hash))
            if not hyde:
                hyde = self.precomputed_hydes.get(source_id)
            if hyde:
                hydes[item["id"]] = hyde
            else:
                missing.append(source_id or item["rel_path"])
                hydes[item["id"]] = self._build_hyde_payload([], item["rel_path"])
        if missing:
            logger.warning("Missing %s precomputed HyDE records; using fallback questions. First missing: %s", len(missing), missing[:5])
        return hydes

    def _call_hyde_worker_batch(self, batch: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        if not self.hyde_worker_token:
            raise ValueError("HYDE_WORKER_TOKEN is required when HYDE_WORKER_URL is set")
        payload = {
            "items": [
                {"id": item["id"], "rel_path": item["rel_path"], "text": item["text"]}
                for item in batch
            ]
        }
        headers = {
            "content-type": "application/json",
            "user-agent": "qdrant-hyde-batch/1.0",
            "x-batch-token": self.hyde_worker_token,
        }
        last_error = None
        for attempt in range(1, 4):
            try:
                response = httpx.post(
                    f"{self.hyde_worker_url}/hyde-batch",
                    headers=headers,
                    json=payload,
                    timeout=180,
                )
                if response.status_code not in (200, 207):
                    raise RuntimeError(f"Worker returned {response.status_code}: {response.text[:500]}")
                data = response.json()
                results = {}
                for result in data.get("results", []):
                    item_id = str(result.get("id") or "")
                    rel_path = str(result.get("rel_path") or "")
                    questions = [str(q).strip() for q in result.get("hyde_questions", []) if str(q).strip()]
                    if not result.get("ok"):
                        logger.warning("HyDE Worker fallback for %s: %s", rel_path, result.get("error", "unknown error"))
                    if item_id:
                        results[item_id] = self._build_hyde_payload(questions, rel_path)
                return results
            except Exception as exc:
                last_error = exc
                if attempt < 3:
                    time.sleep(2 ** attempt)
        raise RuntimeError(f"HyDE Worker batch failed after retries: {last_error}")

    def _generate_hyde_payloads_via_worker(self, batch: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        if self.hyde_worker_job_mode:
            return self._generate_hyde_payloads_via_worker_job(batch)
        sub_batches = [
            batch[i:i + self.hyde_worker_batch_size]
            for i in range(0, len(batch), self.hyde_worker_batch_size)
        ]
        hydes: Dict[str, Dict[str, Any]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.hyde_worker_requests) as executor:
            future_to_sub_batch = {
                executor.submit(self._call_hyde_worker_batch, sub_batch): sub_batch
                for sub_batch in sub_batches
            }
            for future in concurrent.futures.as_completed(future_to_sub_batch):
                sub_batch = future_to_sub_batch[future]
                try:
                    hydes.update(future.result())
                except Exception as exc:
                    logger.warning("HyDE Worker sub-batch failed; using local fallback questions: %s", exc)
                    for item in sub_batch:
                        hydes[item["id"]] = self._build_hyde_payload([], item["rel_path"])
        for item in batch:
            hydes.setdefault(item["id"], self._build_hyde_payload([], item["rel_path"]))
        return hydes

    def _hyde_worker_headers(self) -> Dict[str, str]:
        if not self.hyde_worker_token:
            raise ValueError("HYDE_WORKER_TOKEN is required when HYDE_WORKER_URL is set")
        return {
            "content-type": "application/json",
            "user-agent": "qdrant-hyde-batch/1.0",
            "x-batch-token": self.hyde_worker_token,
        }

    def _request_hyde_worker_json(
        self,
        method: str,
        path: str,
        payload: Dict[str, Any] | None = None,
        timeout: float = 180,
    ) -> Dict[str, Any]:
        response = httpx.request(
            method,
            f"{self.hyde_worker_url}{path}",
            headers=self._hyde_worker_headers(),
            json=payload,
            timeout=timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Worker {method} {path} returned {response.status_code}: {response.text[:500]}")
        return response.json()

    def _generate_hyde_payloads_via_worker_job(self, batch: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        started = time.time()
        start_response = self._request_hyde_worker_json(
            "POST",
            "/jobs",
            {"batch_size": self.hyde_worker_batch_size},
        )
        job_id = str(start_response.get("job_id") or "")
        if not job_id:
            raise RuntimeError(f"Worker job did not return job_id: {start_response}")

        shards = [
            batch[i:i + self.hyde_worker_job_shard_size]
            for i in range(0, len(batch), self.hyde_worker_job_shard_size)
        ]
        logger.info("Created HyDE Worker job %s with %s shards for %s chunks.", job_id, len(shards), len(batch))
        for seq, shard in enumerate(shards):
            self._request_hyde_worker_json(
                "POST",
                f"/jobs/{job_id}/shards",
                {
                    "seq": seq,
                    "items": [
                        {"id": item["id"], "rel_path": item["rel_path"], "text": item["text"]}
                        for item in shard
                    ],
                },
            )

        self._request_hyde_worker_json("POST", f"/jobs/{job_id}/commit", {"expected_shards": len(shards)})
        self._request_hyde_worker_json("POST", f"/jobs/{job_id}/run", {})

        while True:
            status = self._request_hyde_worker_json("GET", f"/jobs/{job_id}/status", timeout=60)
            state = status.get("state") or {}
            job_status = str(state.get("status") or "")
            processed = int(state.get("processed_shards") or 0)
            failed = int(state.get("failed_shards") or 0)
            if job_status in {"done", "failed"} or processed + failed >= len(shards):
                break
            if time.time() - started > self.hyde_worker_job_timeout:
                raise TimeoutError(f"Timed out waiting for HyDE Worker job {job_id}: {state}")
            time.sleep(self.hyde_worker_job_poll_interval)

        hydes: Dict[str, Dict[str, Any]] = {}
        for seq, shard in enumerate(shards):
            try:
                result_payload = self._request_hyde_worker_json("GET", f"/jobs/{job_id}/results/{seq}", timeout=60)
                for result in result_payload.get("results", []):
                    item_id = str(result.get("id") or "")
                    rel_path = str(result.get("rel_path") or "")
                    questions = [str(q).strip() for q in result.get("hyde_questions", []) if str(q).strip()]
                    if not result.get("ok"):
                        logger.warning("HyDE Worker job fallback for %s: %s", rel_path, result.get("error", "unknown error"))
                    if item_id:
                        hydes[item_id] = self._build_hyde_payload(questions, rel_path)
            except Exception as exc:
                logger.warning("Unable to fetch HyDE Worker job result shard %s for job %s: %s", seq, job_id, exc)
                for item in shard:
                    hydes[item["id"]] = self._build_hyde_payload([], item["rel_path"])

        for item in batch:
            hydes.setdefault(item["id"], self._build_hyde_payload([], item["rel_path"]))
        self.stats["hyde_worker_jobs"] += 1
        return hydes

    def _split_long_line(self, line: str, line_number: int) -> List[Dict[str, Any]]:
        if len(line) <= CHUNK_SIZE:
            return [{"line_number": line_number, "text": line}]
        return [
            {"line_number": line_number, "text": line[start:start + CHUNK_SIZE]}
            for start in range(0, len(line), CHUNK_SIZE)
        ]

    def _chunk_text(self, text: str) -> List[Dict[str, Any]]:
        lines = text.split('\n')
        chunks = []
        current_chunk = []
        current_len = 0
        for line_number, line in enumerate(lines, start=1):
            for line_item in self._split_long_line(line, line_number):
                line_len = len(line_item["text"]) + 1
                if current_len + line_len > CHUNK_SIZE and current_chunk:
                    chunks.append(self._make_chunk_payload(current_chunk))
                    overlap_chunk = []
                    overlap_len = 0
                    for overlap_item in reversed(current_chunk):
                        l = overlap_item["text"]
                        if overlap_len + len(l) + 1 > CHUNK_OVERLAP: break
                        overlap_chunk.insert(0, overlap_item)
                        overlap_len += len(l) + 1
                    current_chunk = overlap_chunk
                    current_len = overlap_len
                current_chunk.append(line_item)
                current_len += line_len
        if current_chunk: chunks.append(self._make_chunk_payload(current_chunk))
        return chunks

    def _make_chunk_payload(self, line_items: List[Dict[str, Any]]) -> Dict[str, Any]:
        start_line = int(line_items[0]["line_number"])
        end_line = int(line_items[-1]["line_number"])
        return {
            "text": "\n".join(item["text"] for item in line_items),
            "start_line": start_line,
            "end_line": end_line,
            "line_range": f"{start_line}-{end_line}" if start_line != end_line else str(start_line),
        }

    def _line_payload(self, chunk: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "start_line": int(chunk["start_line"]),
            "end_line": int(chunk["end_line"]),
            "line_range": str(chunk["line_range"]),
        }

    def _line_payload_matches(self, previous: Dict[str, Any], chunk: Dict[str, Any]) -> bool:
        return (
            previous.get("start_line") == int(chunk["start_line"])
            and previous.get("end_line") == int(chunk["end_line"])
            and previous.get("line_range") == str(chunk["line_range"])
        )

    def _backfill_line_payload(self, point_id: str, chunk: Dict[str, Any]) -> None:
        self.qdrant_client.set_payload(
            collection_name=self.collection_name,
            payload=self._line_payload(chunk),
            points=[point_id],
            wait=True,
        )
        self.stats["line_payloads_backfilled"] += 1

    def _is_excluded_path(self, rel_path: str) -> bool:
        path = Path(rel_path)
        parts = set(path.parts)
        name = path.name.lower()
        lower_path = rel_path.replace(os.sep, "/").lower()
        normalized_path = rel_path.replace(os.sep, "/")
        if _path_matches_any(normalized_path, EXCLUDE_PATH_GLOBS):
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

    def _looks_generated_or_bundled(self, rel_path: str, content: str) -> bool:
        path = Path(rel_path)
        if len(content.encode("utf-8", "ignore")) > MAX_FILE_SIZE_BYTES:
            return True
        lines = content.split("\n")
        longest_line = max((len(line) for line in lines), default=0)
        if longest_line <= LONG_LINE_GENERATED_THRESHOLD:
            return False
        if path.suffix.lower() in {".css", ".js", ".json", ".xml"}:
            return True
        return False

    def _should_index_file(self, file_path: Path, base_path: Path, content: str | None = None) -> bool:
        rel_path = str(file_path.relative_to(base_path))
        normalized_path = rel_path.replace(os.sep, "/")
        if INCLUDE_PATH_GLOBS and not _path_matches_any(normalized_path, INCLUDE_PATH_GLOBS):
            return False
        if file_path.suffix not in VALID_EXTENSIONS:
            return False
        if self._is_excluded_path(rel_path):
            return False
        if content is not None and self._looks_generated_or_bundled(rel_path, content):
            return False
        return True

    def index_directory(self, directory: str, batch_size: int = 100):
        base_path = Path(directory).resolve()
        try:
            result = subprocess.run(["git", "ls-files", "--cached"], cwd=base_path, capture_output=True, text=True, check=True)
            files = [base_path / f for f in result.stdout.splitlines() if (base_path / f).suffix in VALID_EXTENSIONS]
        except Exception:
            files = [f for f in base_path.rglob("*") if f.is_file() and f.suffix in VALID_EXTENSIONS]
            
        files = [f for f in files if self._should_index_file(f, base_path)]
        current_file_set = set()

        all_stale_ids = []
        chunks_to_index = []
        
        logger.info(f"Analyzing {len(files)} files for incremental updates...")
        for file_path in files:
            try:
                content = file_path.read_text(encoding='utf-8')
                rel_path = str(file_path.relative_to(base_path))
                if not self._should_index_file(file_path, base_path, content):
                    self.stats["files_skipped"] += 1
                    continue
                current_file_set.add(rel_path)
                chunks = self._chunk_text(content)
                existing_state = self._fetch_file_state(rel_path)
                current_ids = set()
                
                for i, chunk in enumerate(chunks):
                    chunk_text = chunk["text"]
                    # STABLE ID (Path + Index)
                    point_id = str(uuid.uuid5(NAMESPACE, f"{rel_path}_{i}"))
                    content_hash = self._get_content_hash(chunk_text)
                    current_ids.add(point_id)
                    chunk_metadata = self._apply_digest_context(
                        rel_path,
                        self._build_chunk_metadata(rel_path, chunk_text, chunk),
                    )
                    
                    previous = existing_state.get(point_id) or {}
                    if (
                        previous.get("content_hash") == content_hash
                        and previous.get("hyde_version") == HYDE_SCHEMA_VERSION
                        and previous.get("metadata_version") == METADATA_SCHEMA_VERSION
                        and previous.get("digest_context_hash", "") == chunk_metadata.get("digest_context_hash", "")
                    ):
                        if not self._line_payload_matches(previous, chunk):
                            self._backfill_line_payload(point_id, chunk)
                        self.stats["chunks_skipped"] += 1
                        continue
                        
                    chunks_to_index.append({
                        "id": point_id,
                        "hyde_source_id": f"{rel_path}:{i}",
                        "text": chunk_text,
                        "rel_path": rel_path,
                        "metadata": {
                            "file": rel_path,
                            "content_hash": content_hash,
                            "hyde_version": HYDE_SCHEMA_VERSION,
                            "hyde_model": self.hyde_model,
                            "hyde_generation_input_hash": self._get_input_hash(f"{HYDE_SCHEMA_VERSION}\n{rel_path}\n{chunk_text}"),
                            "embedding_model": self.embedding_model,
                            "embedding_vector_size": self.vector_size,
                            "content": chunk_text,
                            **chunk_metadata,
                        }
                    })
                
                all_stale_ids.extend([pid for pid in existing_state if pid not in current_ids])
                self.stats["files_scanned"] += 1
            except Exception as e: logger.error(f"Failed {file_path}: {e}")

        missing_files = sorted(set(self._fetch_indexed_files()) - current_file_set)
        for missing_file in missing_files:
            all_stale_ids.extend(self._fetch_file_state(missing_file).keys())

        # Orphan Cleanup
        self._delete_stale_points(all_stale_ids)

        if not chunks_to_index:
            logger.info(f"Done: No changes. Skipped {self.stats['chunks_skipped']} chunks.")
            return

        logger.info(f"Indexing {len(chunks_to_index)} new/modified chunks...")
        if self.precomputed_hydes:
            for i in range(0, len(chunks_to_index), batch_size):
                batch = chunks_to_index[i:i+batch_size]
                hydes_by_id = self._generate_hyde_payloads_precomputed(batch)
                self._upsert_index_batch(batch, hydes_by_id)
        elif self.hyde_worker_url:
            for i in range(0, len(chunks_to_index), batch_size):
                batch = chunks_to_index[i:i+batch_size]
                hydes_by_id = self._generate_hyde_payloads_via_worker(batch)
                self._upsert_index_batch(batch, hydes_by_id)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.hyde_workers) as executor:
                for c in chunks_to_index:
                    c["hyde_future"] = executor.submit(self._generate_hyde_payload, c["text"], c["rel_path"])
                
                for i in range(0, len(chunks_to_index), batch_size):
                    batch = chunks_to_index[i:i+batch_size]
                    hydes_by_id = {}
                    for c in batch:
                        hyde = c["hyde_future"].result()
                        hydes_by_id[c["id"]] = hyde
                    self._upsert_index_batch(batch, hydes_by_id)
                
        logger.info(f"Finished: {self.stats}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default=".")
    parser.add_argument("--collection", default=DEFAULT_COLLECTION_NAME)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--hyde-jsonl", default="", help="Use precomputed HyDE JSONL records keyed by rel_path:chunk_index.")
    parser.add_argument("--digest-sidecar", default="", help="Use lightweight digest JSONL records to enrich payload and summary_dense.")
    args, _ = parser.parse_known_args()
    if args.hyde_jsonl:
        os.environ["HYDE_PRECOMPUTED_JSONL"] = args.hyde_jsonl
    if args.digest_sidecar:
        os.environ["DIGEST_SIDECAR_JSONL"] = args.digest_sidecar
    CodebaseIndexer(collection_name=args.collection).index_directory(args.directory, batch_size=args.batch_size)
