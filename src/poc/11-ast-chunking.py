#!/usr/bin/env python3
"""
POC 11: AST-aware chunking with Tree-sitter

Chunks code at function/class/method boundaries instead of arbitrary line splits.
Indexes into Vectorize+D1, reranks with bge-reranker-base, evals against golden queries.

Compares: AST chunks vs line-based chunks (both with Gemini 768d + reranker).
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import base64
import concurrent.futures
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import tree_sitter_python as tsp
import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser

# ── Config ──
CF_ACCOUNT = "776ba01baf2a9a9806fa0edb1b5ddc96"
CF_TOKEN = os.environ.get("CF_PATRICK_API_TOKEN", "")
GW_NAME = "code-search"
GCP_PROJECT = "evrylo"
EMBED_MODEL = "text-embedding-004"
SA_PATH = os.path.expanduser("~/Downloads/evrylo-d0067cf9218d.json")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
VECTORIZE_INDEX = "lumae-eval-ast"
D1_DB_NAME = "lumae-eval-ast-fts"
MAX_CHUNK_CHARS = 2000  # target chunk size
MIN_CHUNK_CHARS = 100   # don't create tiny chunks
MERGE_THRESHOLD = 800   # merge small siblings up to this
EMBED_BATCH = 20
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}

QUERIES_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_golden_queries.json"
RESULTS_PATH = Path(__file__).resolve().parents[2] / "benchmarks" / "lumae_eval_ast.json"

# ── Tree-sitter setup ──
PY_LANG = Language(tsp.language())
JS_LANG = Language(tsjs.language())
TS_LANG = Language(tsts.language_typescript())
TSX_LANG = Language(tsts.language_tsx())

LANG_MAP = {
    ".py": PY_LANG,
    ".js": JS_LANG, ".mjs": JS_LANG, ".cjs": JS_LANG, ".jsx": JS_LANG,
    ".ts": TS_LANG, ".tsx": TSX_LANG,
}

# Node types that represent meaningful code units
CHUNK_NODE_TYPES = {
    # Python
    "function_definition", "class_definition", "decorated_definition",
    # JavaScript/TypeScript
    "function_declaration", "class_declaration", "method_definition",
    "export_statement", "lexical_declaration", "variable_declaration",
    "arrow_function",
}

# Top-level nodes to keep together (imports, constants)
PREAMBLE_TYPES = {
    "import_statement", "import_from_statement",  # Python
    "import_declaration",  # JS/TS
    "expression_statement",  # top-level assignments
}


def cf_api(method, path, data=None, timeout=30):
    url = f"{CF_API}/{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": (e.read().decode() if e.fp else "")[:300]}


def embed_batch(texts):
    with open(SA_PATH) as f:
        sa = json.load(f)
    sa["region"] = "us-central1"
    sa_b64 = base64.b64encode(json.dumps(sa).encode()).decode()
    url = (f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT}/{GW_NAME}"
           f"/google-vertex-ai/v1/projects/{GCP_PROJECT}/locations/us-central1"
           f"/publishers/google/models/{EMBED_MODEL}:predict")
    payload = json.dumps({"instances": [{"content": t[:2048]} for t in texts]}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "User-Agent": "qdrant-mcp-indexer/1.0",
        "Authorization": f"Bearer {sa_b64}",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    return [p["embeddings"]["values"] for p in result["predictions"]]


def ast_chunk_file(rel_path: str, content: str) -> list[dict]:
    """Chunk a file using tree-sitter AST boundaries."""
    ext = os.path.splitext(rel_path)[1]
    lang = LANG_MAP.get(ext)
    if not lang:
        # Fallback to line-based for unsupported languages
        return line_chunk(rel_path, content)

    parser = Parser(lang)
    tree = parser.parse(content.encode("utf-8"))
    root = tree.root_node

    chunks = []
    preamble_lines = []  # imports/constants at top of file

    for child in root.children:
        node_text = content[child.start_byte:child.end_byte]
        start_line = child.start_point[0] + 1
        end_line = child.end_point[0] + 1

        if child.type in PREAMBLE_TYPES and len(node_text) < MERGE_THRESHOLD:
            preamble_lines.append(node_text)
            continue

        if child.type in CHUNK_NODE_TYPES or len(node_text) > MIN_CHUNK_CHARS:
            # Get function/class name for context
            name = ""
            for sub in child.children:
                if sub.type == "name" or sub.type == "identifier":
                    name = content[sub.start_byte:sub.end_byte]
                    break

            # If chunk is too large, split at method boundaries for classes
            if len(node_text) > MAX_CHUNK_CHARS and child.type in {"class_definition", "class_declaration"}:
                # Extract class header
                class_header = []
                methods = []
                for sub in child.children:
                    if sub.type in {"function_definition", "method_definition", "function_declaration"}:
                        methods.append(sub)
                    elif sub.type == "block" or sub.type == "class_body":
                        for block_child in sub.children:
                            if block_child.type in {"function_definition", "method_definition", "function_declaration"}:
                                methods.append(block_child)

                if methods:
                    # Chunk each method separately with class context
                    class_sig = content[child.start_byte:methods[0].start_byte].strip()
                    if len(class_sig) > 200:
                        class_sig = class_sig[:200] + "..."

                    for method in methods:
                        m_text = content[method.start_byte:method.end_byte]
                        m_start = method.start_point[0] + 1
                        m_end = method.end_point[0] + 1
                        m_name = ""
                        for s in method.children:
                            if s.type in {"name", "identifier"}:
                                m_name = content[s.start_byte:s.end_byte]
                                break

                        chunk_text = f"# Class: {name}\n{class_sig}\n\n{m_text}"
                        chunks.append({
                            "text": chunk_text,
                            "file": rel_path,
                            "start_line": m_start,
                            "end_line": m_end,
                            "symbol": f"{name}.{m_name}" if name and m_name else m_name or name,
                            "chunk_type": "method",
                        })
                    continue

            # Regular function/class chunk
            # Prepend file context
            context = f"# File: {rel_path}\n"
            if preamble_lines:
                context += "\n".join(preamble_lines[:5]) + "\n\n"

            chunk_text = context + node_text
            if len(chunk_text) > MAX_CHUNK_CHARS:
                chunk_text = chunk_text[:MAX_CHUNK_CHARS]

            chunks.append({
                "text": chunk_text,
                "file": rel_path,
                "start_line": start_line,
                "end_line": end_line,
                "symbol": name,
                "chunk_type": "class" if "class" in child.type else "function",
            })
        else:
            # Small top-level node — accumulate and merge
            preamble_lines.append(node_text)

    # Flush remaining preamble as one chunk
    if preamble_lines:
        text = f"# File: {rel_path}\n" + "\n".join(preamble_lines)
        if len(text) > MIN_CHUNK_CHARS:
            chunks.append({
                "text": text[:MAX_CHUNK_CHARS],
                "file": rel_path,
                "start_line": 1,
                "end_line": 1,
                "symbol": "",
                "chunk_type": "preamble",
            })

    return chunks if chunks else line_chunk(rel_path, content)


def line_chunk(rel_path: str, content: str) -> list[dict]:
    """Fallback line-based chunking for non-parseable files."""
    lines = content.splitlines(keepends=True)
    chunks = []
    current, clen, start = [], 0, 1
    for i, line in enumerate(lines, 1):
        current.append(line)
        clen += len(line)
        if clen >= 1500:
            chunks.append({"text": "".join(current), "file": rel_path,
                           "start_line": start, "end_line": i, "symbol": "", "chunk_type": "lines"})
            current, clen, start = [], 0, i + 1
    if current and len("".join(current).strip()) > MIN_CHUNK_CHARS:
        chunks.append({"text": "".join(current), "file": rel_path,
                       "start_line": start, "end_line": start + len(current) - 1,
                       "symbol": "", "chunk_type": "lines"})
    return chunks


def get_source_files():
    result = subprocess.run(["git", "ls-files", "--cached"], cwd=LUMAE_DIR,
                            capture_output=True, text=True, check=True)
    files = []
    for rp in result.stdout.splitlines():
        if any(p in rp for p in EXCLUDE_PATTERNS): continue
        ext = os.path.splitext(rp)[1]
        if ext not in {".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"}: continue
        full = os.path.join(LUMAE_DIR, rp)
        if os.path.isfile(full) and 50 < os.path.getsize(full) < 500_000:
            files.append(rp)
    return sorted(files)


def run():
    print("POC 11: AST-aware chunking + Vectorize+D1+Reranker\n")

    # ── Step 1: AST chunk all files ──
    print("  Step 1: AST chunking...")
    files = get_source_files()
    all_chunks = []
    ast_count = 0
    line_count = 0

    for rp in files:
        full = os.path.join(LUMAE_DIR, rp)
        try:
            content = open(full, "r", encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        chunks = ast_chunk_file(rp, content)
        for c in chunks:
            if c["chunk_type"] in {"function", "method", "class", "preamble"}:
                ast_count += 1
            else:
                line_count += 1
        all_chunks.extend(chunks)

    print(f"    {len(files)} files → {len(all_chunks)} chunks ({ast_count} AST, {line_count} line-based)")

    # Stats
    types = {}
    for c in all_chunks:
        t = c["chunk_type"]
        types[t] = types.get(t, 0) + 1
    print(f"    Types: {types}")
    avg_len = sum(len(c["text"]) for c in all_chunks) / max(len(all_chunks), 1)
    print(f"    Avg chunk size: {avg_len:.0f} chars")

    # ── Step 2: Create Vectorize + D1 ──
    print("\n  Step 2: Creating indexes...")
    cf_api("DELETE", f"vectorize/v2/indexes/{VECTORIZE_INDEX}")
    time.sleep(1)
    cf_api("POST", "vectorize/v2/indexes", {
        "name": VECTORIZE_INDEX, "config": {"dimensions": 768, "metric": "cosine"},
    })

    # Find or create D1
    dbs = cf_api("GET", "d1/database")
    d1_id = None
    if dbs.get("success"):
        for db in dbs.get("result", []):
            if db["name"] == D1_DB_NAME:
                d1_id = db["uuid"]
                break
    if not d1_id:
        res = cf_api("POST", "d1/database", {"name": D1_DB_NAME})
        d1_id = res["result"]["uuid"] if res.get("success") else None

    cf_api("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks_fts"})
    cf_api("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks"})
    cf_api("POST", f"d1/database/{d1_id}/query", {"sql": """CREATE TABLE chunks (
        id TEXT PRIMARY KEY, file TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
        symbol TEXT, chunk_type TEXT, content TEXT NOT NULL)"""})
    cf_api("POST", f"d1/database/{d1_id}/query", {
        "sql": "CREATE VIRTUAL TABLE chunks_fts USING fts5(content, file, symbol, tokenize='trigram')"})
    print(f"    Vectorize: {VECTORIZE_INDEX}, D1: {d1_id}")

    # ── Step 3: Embed + upsert (batched) ──
    print(f"\n  Step 3: Embedding {len(all_chunks)} chunks...")
    t0 = time.perf_counter()
    all_embeddings = [None] * len(all_chunks)

    def embed_range(start, end):
        texts = [f"File: {c['file']}\n{c['text']}" for c in all_chunks[start:end]]
        return start, embed_batch(texts)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = [ex.submit(embed_range, i, min(i + EMBED_BATCH, len(all_chunks)))
                   for i in range(0, len(all_chunks), EMBED_BATCH)]
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            s, embs = fut.result()
            for j, emb in enumerate(embs):
                all_embeddings[s + j] = emb
            done += len(embs)
            if done % 200 == 0:
                print(f"    {done}/{len(all_chunks)}...")
    print(f"    Embedded in {time.perf_counter() - t0:.0f}s")

    # Vectorize upsert
    print("  Upserting to Vectorize...")
    for i in range(0, len(all_chunks), 250):
        batch = all_chunks[i:i+250]
        batch_embs = all_embeddings[i:i+250]
        vectors = [{"id": f"{c['file']}:{c['start_line']}",
                     "values": emb,
                     "metadata": {"file": c["file"], "start": c["start_line"], "end": c["end_line"],
                                  "symbol": c.get("symbol", ""), "type": c.get("chunk_type", "")}}
                    for c, emb in zip(batch, batch_embs)]
        cf_api("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/upsert", {"vectors": vectors}, timeout=60)

    # D1 insert
    print("  Inserting to D1...")
    for i in range(0, len(all_chunks), 50):
        batch = all_chunks[i:i+50]
        stmts = [{"sql": "INSERT OR REPLACE INTO chunks (id,file,start_line,end_line,symbol,chunk_type,content) VALUES (?,?,?,?,?,?,?)",
                   "params": [f"{c['file']}:{c['start_line']}", c["file"], c["start_line"], c["end_line"],
                              c.get("symbol",""), c.get("chunk_type",""), c["text"][:5000]]}
                  for c in batch]
        cf_api("POST", f"d1/database/{d1_id}/query", stmts, timeout=30)
        fts_stmts = [{"sql": "INSERT OR REPLACE INTO chunks_fts (rowid,content,file,symbol) VALUES ((SELECT rowid FROM chunks WHERE id=?),?,?,?)",
                       "params": [f"{c['file']}:{c['start_line']}", c["text"][:5000], c["file"], c.get("symbol","")]}
                      for c in batch]
        cf_api("POST", f"d1/database/{d1_id}/query", fts_stmts, timeout=30)

    total_time = time.perf_counter() - t0
    print(f"\n    Total index time: {total_time:.0f}s")
    print(f"    D1 ID: {d1_id}")

    print(f"\n  \u2705 POC 11: INDEXED ({len(all_chunks)} AST chunks)")
    print(f"  D1_ID={d1_id}")
    print(f"  VECTORIZE={VECTORIZE_INDEX}")


if __name__ == "__main__":
    run()
