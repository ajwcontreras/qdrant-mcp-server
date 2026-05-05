#!/usr/bin/env python3
"""
POC 12: AST chunks + OpenAI text-embedding-3-large (3072d) + D1 FTS5 + Reranker

Same pipeline as POC 11 but swaps Gemini 768d for OpenAI 3072d embeddings.
Isolates: embedding model quality (everything else held constant).
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
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
VECTORIZE_INDEX = "lumae-eval-openai-ast"
D1_DB_NAME = "lumae-eval-openai-ast-fts"
EMBED_MODEL = "text-embedding-3-large"
EMBED_DIM = 1536  # Vectorize max is 1536; OpenAI supports native dimension reduction
MAX_CHUNK_CHARS = 2000
MIN_CHUNK_CHARS = 100
MERGE_THRESHOLD = 800
EMBED_BATCH = 3  # small batches to stay under TPM limit
EXCLUDE_PATTERNS = ["migrations/versions", "__pycache__", ".min.", "node_modules", "vendor"]

CF_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}"
HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}

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

CHUNK_NODE_TYPES = {
    "function_definition", "class_definition", "decorated_definition",
    "function_declaration", "class_declaration", "method_definition",
    "export_statement", "lexical_declaration", "variable_declaration",
    "arrow_function",
}

PREAMBLE_TYPES = {
    "import_statement", "import_from_statement",
    "import_declaration",
    "expression_statement",
}


def cf_api_call(method, path, data=None, timeout=30):
    url = f"{CF_API}/{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": (e.read().decode() if e.fp else "")[:300]}


def openai_embed_batch(texts, max_retries=5):
    """Embed via OpenAI text-embedding-3-large with retry on 429."""
    url = "https://api.openai.com/v1/embeddings"
    payload = json.dumps({
        "model": EMBED_MODEL,
        "input": [t[:8191] for t in texts],
        "dimensions": EMBED_DIM,
    }).encode()
    for attempt in range(max_retries):
        req = urllib.request.Request(url, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_KEY}",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read())
            sorted_data = sorted(result["data"], key=lambda x: x["index"])
            return [d["embedding"] for d in sorted_data]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retries - 1:
                wait = 2 ** attempt + 1
                print(f"      429 rate limit, retry {attempt+1}/{max_retries} in {wait}s...")
                time.sleep(wait)
            else:
                raise


# ── AST chunking (identical to POC 11) ──

def ast_chunk_file(rel_path, content):
    ext = os.path.splitext(rel_path)[1]
    lang = LANG_MAP.get(ext)
    if not lang:
        return line_chunk(rel_path, content)

    parser = Parser(lang)
    tree = parser.parse(content.encode("utf-8"))
    root = tree.root_node
    chunks = []
    preamble_lines = []

    for child in root.children:
        node_text = content[child.start_byte:child.end_byte]
        start_line = child.start_point[0] + 1
        end_line = child.end_point[0] + 1

        if child.type in PREAMBLE_TYPES and len(node_text) < MERGE_THRESHOLD:
            preamble_lines.append(node_text)
            continue

        if child.type in CHUNK_NODE_TYPES or len(node_text) > MIN_CHUNK_CHARS:
            name = ""
            for sub in child.children:
                if sub.type in {"name", "identifier"}:
                    name = content[sub.start_byte:sub.end_byte]
                    break

            if len(node_text) > MAX_CHUNK_CHARS and child.type in {"class_definition", "class_declaration"}:
                methods = []
                for sub in child.children:
                    if sub.type in {"function_definition", "method_definition", "function_declaration"}:
                        methods.append(sub)
                    elif sub.type in {"block", "class_body"}:
                        for block_child in sub.children:
                            if block_child.type in {"function_definition", "method_definition", "function_declaration"}:
                                methods.append(block_child)

                if methods:
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
                            "text": chunk_text, "file": rel_path,
                            "start_line": m_start, "end_line": m_end,
                            "symbol": f"{name}.{m_name}" if name and m_name else m_name or name,
                            "chunk_type": "method",
                        })
                    continue

            context = f"# File: {rel_path}\n"
            if preamble_lines:
                context += "\n".join(preamble_lines[:5]) + "\n\n"
            chunk_text = context + node_text
            if len(chunk_text) > MAX_CHUNK_CHARS:
                chunk_text = chunk_text[:MAX_CHUNK_CHARS]
            chunks.append({
                "text": chunk_text, "file": rel_path,
                "start_line": start_line, "end_line": end_line,
                "symbol": name,
                "chunk_type": "class" if "class" in child.type else "function",
            })
        else:
            preamble_lines.append(node_text)

    if preamble_lines:
        text = f"# File: {rel_path}\n" + "\n".join(preamble_lines)
        if len(text) > MIN_CHUNK_CHARS:
            chunks.append({
                "text": text[:MAX_CHUNK_CHARS], "file": rel_path,
                "start_line": 1, "end_line": 1, "symbol": "", "chunk_type": "preamble",
            })
    return chunks if chunks else line_chunk(rel_path, content)


def line_chunk(rel_path, content):
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
    print("POC 12: AST chunks + OpenAI text-embedding-3-large (3072d)\n")

    global CF_TOKEN
    if not CF_TOKEN:
        r = subprocess.run(["zsh", "-c", "source ~/.zshrc && echo $CF_PATRICK_API_TOKEN"],
                           capture_output=True, text=True)
        CF_TOKEN = r.stdout.strip()
        HEADERS["Authorization"] = f"Bearer {CF_TOKEN}"

    # ── Step 1: AST chunk ──
    print("  Step 1: AST chunking...")
    files = get_source_files()
    all_chunks = []
    for rp in files:
        full = os.path.join(LUMAE_DIR, rp)
        try:
            content = open(full, "r", encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        all_chunks.extend(ast_chunk_file(rp, content))

    types = {}
    for c in all_chunks:
        t = c["chunk_type"]
        types[t] = types.get(t, 0) + 1
    print(f"    {len(files)} files -> {len(all_chunks)} chunks")
    print(f"    Types: {types}")

    # ── Step 2: Create Vectorize (3072d) + D1 ──
    print("\n  Step 2: Creating indexes...")
    cf_api_call("DELETE", f"vectorize/v2/indexes/{VECTORIZE_INDEX}")
    time.sleep(1)
    res = cf_api_call("POST", "vectorize/v2/indexes", {
        "name": VECTORIZE_INDEX, "config": {"dimensions": EMBED_DIM, "metric": "cosine"},
    })
    if not res.get("success"):
        print(f"    Vectorize create: {res}")
        return

    # Find or create D1
    dbs = cf_api_call("GET", "d1/database")
    d1_id = None
    if dbs.get("success"):
        for db in dbs.get("result", []):
            if db["name"] == D1_DB_NAME:
                d1_id = db["uuid"]
                break
    if not d1_id:
        res = cf_api_call("POST", "d1/database", {"name": D1_DB_NAME})
        d1_id = res["result"]["uuid"] if res.get("success") else None
        if not d1_id:
            print(f"    D1 create failed: {res}")
            return

    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks_fts"})
    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks"})
    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": """CREATE TABLE chunks (
        id TEXT PRIMARY KEY, file TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
        symbol TEXT, chunk_type TEXT, content TEXT NOT NULL)"""})
    cf_api_call("POST", f"d1/database/{d1_id}/query", {
        "sql": "CREATE VIRTUAL TABLE chunks_fts USING fts5(content, file, symbol, tokenize='trigram')"})
    print(f"    Vectorize: {VECTORIZE_INDEX} ({EMBED_DIM}d), D1: {d1_id}")

    # ── Step 3: Embed with OpenAI + upsert ──
    print(f"\n  Step 3: Embedding {len(all_chunks)} chunks with OpenAI {EMBED_MODEL}...")
    t0 = time.perf_counter()
    all_embeddings = [None] * len(all_chunks)

    def embed_range(start, end):
        texts = [f"File: {c['file']}\n{c['text']}" for c in all_chunks[start:end]]
        return start, openai_embed_batch(texts)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
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
            time.sleep(3.0)  # conservative rate limit cushion
    embed_time = time.perf_counter() - t0
    print(f"    Embedded in {embed_time:.0f}s")

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
        cf_api_call("POST", f"vectorize/v2/indexes/{VECTORIZE_INDEX}/upsert", {"vectors": vectors}, timeout=60)

    # D1 insert
    print("  Inserting to D1...")
    for i in range(0, len(all_chunks), 50):
        batch = all_chunks[i:i+50]
        stmts = [{"sql": "INSERT OR REPLACE INTO chunks (id,file,start_line,end_line,symbol,chunk_type,content) VALUES (?,?,?,?,?,?,?)",
                   "params": [f"{c['file']}:{c['start_line']}", c["file"], c["start_line"], c["end_line"],
                              c.get("symbol",""), c.get("chunk_type",""), c["text"][:5000]]}
                  for c in batch]
        cf_api_call("POST", f"d1/database/{d1_id}/query", stmts, timeout=30)
        fts_stmts = [{"sql": "INSERT OR REPLACE INTO chunks_fts (rowid,content,file,symbol) VALUES ((SELECT rowid FROM chunks WHERE id=?),?,?,?)",
                       "params": [f"{c['file']}:{c['start_line']}", c["text"][:5000], c["file"], c.get("symbol","")]}
                      for c in batch]
        cf_api_call("POST", f"d1/database/{d1_id}/query", fts_stmts, timeout=30)

    total_time = time.perf_counter() - t0
    print(f"\n    Total index time: {total_time:.0f}s")
    print(f"    D1 ID: {d1_id}")
    print(f"\n  INDEXED ({len(all_chunks)} AST chunks, OpenAI {EMBED_MODEL} {EMBED_DIM}d)")
    print(f"  D1_ID={d1_id}")
    print(f"  VECTORIZE={VECTORIZE_INDEX}")


if __name__ == "__main__":
    run()
