#!/usr/bin/env python3
"""
POC 12: BM25F multi-field D1 schema

Repopulates D1 with weighted FTS5 columns:
  - identifier (weight 10): function/class/method names + subtokens
  - path (weight 5): file path + path segments
  - signature (weight 3): first line of function/class (def/class/function/const)
  - body (weight 1): full chunk text

Same AST chunks from POC 11, same Vectorize index. Only D1 changes.
"""

import builtins
_orig_print = builtins.print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

import json
import os
import re
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
LUMAE_DIR = "/Users/awilliamspcsevents/evrylo/lumae.ai"
D1_DB_NAME = "lumae-eval-bm25f"
MAX_CHUNK_CHARS = 2000
MIN_CHUNK_CHARS = 100
MERGE_THRESHOLD = 800
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


def split_identifier(name):
    """Split camelCase/snake_case/PascalCase into subtokens."""
    if not name:
        return ""
    # snake_case
    parts = name.split("_")
    # camelCase/PascalCase
    expanded = []
    for part in parts:
        expanded.extend(re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|\b)|[A-Z]+|\d+', part))
    # Return original + subtokens
    tokens = [name] + [t.lower() for t in expanded if len(t) > 1]
    return " ".join(dict.fromkeys(tokens))  # dedupe preserving order


def extract_signature(text):
    """Extract the first meaningful line (def/class/function/const/export)."""
    for line in text.splitlines()[:5]:
        stripped = line.strip()
        if any(stripped.startswith(kw) for kw in [
            "def ", "class ", "function ", "async function ",
            "const ", "let ", "var ", "export ", "@"
        ]):
            return stripped[:200]
    return text.splitlines()[0].strip()[:200] if text else ""


def path_tokens(file_path):
    """Extract searchable tokens from file path."""
    parts = file_path.replace("/", " ").replace("\\", " ").replace("-", " ").replace("_", " ").replace(".", " ")
    return f"{file_path} {parts}"


# ── AST chunking (same as POC 11) ──

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
    print("POC 12: BM25F multi-field D1 schema\n")

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
    print(f"    {len(files)} files -> {len(all_chunks)} chunks")

    # ── Step 2: Create D1 with multi-field schema ──
    print("\n  Step 2: Creating BM25F D1...")

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

    # Drop and recreate
    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks_fts"})
    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": "DROP TABLE IF EXISTS chunks"})

    # Main table with separate columns
    cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": """CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        symbol TEXT,
        chunk_type TEXT,
        identifier TEXT,
        path_tokens TEXT,
        signature TEXT,
        body TEXT NOT NULL
    )"""})

    # FTS5 with column weights: identifier=10, path=5, signature=3, body=1
    cf_api_call("POST", f"d1/database/{d1_id}/query", {
        "sql": "CREATE VIRTUAL TABLE chunks_fts USING fts5(identifier, path_tokens, signature, body, tokenize='trigram')"
    })

    print(f"    D1: {d1_id} (BM25F: identifier*10, path*5, signature*3, body*1)")

    # ── Step 3: Populate with enriched fields ──
    print(f"\n  Step 3: Inserting {len(all_chunks)} chunks with multi-field data...")
    t0 = time.perf_counter()

    for i in range(0, len(all_chunks), 50):
        batch = all_chunks[i:i+50]

        stmts = []
        fts_stmts = []
        for c in batch:
            cid = f"{c['file']}:{c['start_line']}"
            ident = split_identifier(c.get("symbol", ""))
            ptokens = path_tokens(c["file"])
            sig = extract_signature(c["text"])
            body = c["text"][:5000]

            stmts.append({
                "sql": "INSERT OR REPLACE INTO chunks (id,file,start_line,end_line,symbol,chunk_type,identifier,path_tokens,signature,body) VALUES (?,?,?,?,?,?,?,?,?,?)",
                "params": [cid, c["file"], c["start_line"], c["end_line"],
                           c.get("symbol",""), c.get("chunk_type",""),
                           ident, ptokens, sig, body]
            })
            fts_stmts.append({
                "sql": "INSERT OR REPLACE INTO chunks_fts (rowid,identifier,path_tokens,signature,body) VALUES ((SELECT rowid FROM chunks WHERE id=?),?,?,?,?)",
                "params": [cid, ident, ptokens, sig, body]
            })

        cf_api_call("POST", f"d1/database/{d1_id}/query", {"batch": stmts}, timeout=30)
        cf_api_call("POST", f"d1/database/{d1_id}/query", {"batch": fts_stmts}, timeout=30)

        if (i + 50) % 500 == 0:
            print(f"    {min(i+50, len(all_chunks))}/{len(all_chunks)}...")

    elapsed = time.perf_counter() - t0
    print(f"    Done in {elapsed:.0f}s")

    # ── Verify ──
    res = cf_api_call("POST", f"d1/database/{d1_id}/query", {"sql": "SELECT COUNT(*) as cnt FROM chunks"})
    cnt = res.get("result", [{}])[0].get("results", [{}])[0].get("cnt", 0) if res.get("success") else 0

    # Sample: test BM25F ranking
    sample = cf_api_call("POST", f"d1/database/{d1_id}/query", {
        "sql": """SELECT c.id, c.symbol,
                  bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0) as score
                  FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid
                  WHERE chunks_fts MATCH ?
                  ORDER BY bm25(chunks_fts, 10.0, 5.0, 3.0, 1.0)
                  LIMIT 5""",
        "params": ["handleSubmit"]
    })
    print(f"\n  Sample BM25F query 'handleSubmit':")
    if sample.get("success"):
        for r in sample.get("result", [{}])[0].get("results", []):
            print(f"    {r.get('score', 0):.4f}  {r.get('symbol', '')}  ({r.get('id', '')})")

    print(f"\n  {cnt} chunks in D1")
    print(f"  D1_ID={d1_id}")
    print(f"\n  {'✅' if cnt == len(all_chunks) else '❌'} POC 12: BM25F D1 {'PASS' if cnt == len(all_chunks) else 'FAIL'}")


if __name__ == "__main__":
    run()
