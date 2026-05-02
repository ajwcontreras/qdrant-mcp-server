// AST-aware chunking via regex-based boundary detection.
// Falls back to 4KB truncation when no boundaries found.
// Tree-sitter would be ideal but node-gyp can't compile natively on this machine.

const LANGUAGE_MAP = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "bash", ".bash": "bash",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
};

const BOUNDARY_PATTERNS = {
  javascript: [
    /^export\s+(async\s+)?function\s+\w+/m,
    /^(export\s+)?(async\s+)?function\s+\w+/m,
    /^(export\s+)?class\s+\w+/m,
    /^\s*(static\s+)?(async\s+)?\w+\s*\([^)]*\)\s*\{/m,
    /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/m,
    /^(export\s+)?interface\s+\w+/m,
    /^(export\s+)?type\s+\w+\s*=/m,
  ],
  typescript: [
    /^export\s+(async\s+)?function\s+\w+/m,
    /^(export\s+)?(async\s+)?function\s+\w+/m,
    /^(export\s+)?class\s+\w+/m,
    /^\s*(static\s+)?(async\s+)?\w+\s*\([^)]*\)\s*\{/m,
    /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/m,
    /^(export\s+)?interface\s+\w+/m,
    /^(export\s+)?type\s+\w+\s*=/m,
    /^(export\s+)?enum\s+\w+/m,
  ],
  python: [
    /^(async\s+)?def\s+\w+/m,
    /^class\s+\w+/m,
  ],
  go: [
    /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/m,
    /^type\s+\w+\s+struct/m,
    /^type\s+\w+\s+interface/m,
  ],
  rust: [
    /^(pub\s+)?fn\s+\w+/m,
    /^(pub\s+)?struct\s+\w+/m,
    /^(pub\s+)?enum\s+\w+/m,
    /^(pub\s+)?impl\b/m,
    /^(pub\s+)?trait\s+\w+/m,
  ],
  java: [
    /^\s*(public|private|protected|static|final|abstract|synchronized)*\s+(class|interface|enum)\s+\w+/m,
    /^\s*(public|private|protected|static|final|abstract|synchronized)*\s+[\w<>\[\]]+\s+\w+\s*\(/m,
  ],
  php: [
    /^\s*(public|private|protected|static)\s+function\s+\w+/m,
    /^\s*function\s+\w+/m,
    /^\s*class\s+\w+/m,
  ],
  ruby: [
    /^\s*def\s+\w+/m,
    /^\s*class\s+\w+/m,
    /^\s*module\s+\w+/m,
  ],
  bash: [
    /^\s*\w+\s*\(\)\s*\{/m,
    /^\s*function\s+\w+/m,
  ],
};

const MAX_CHUNK_CHARS = 4000;

function detectLanguage(filePath) {
  const ext = (filePath || "").split(".").pop();
  if (!ext) return null;
  const key = "." + ext.toLowerCase();
  return LANGUAGE_MAP[key] || null;
}

function findBoundaries(text, lang) {
  const patterns = BOUNDARY_PATTERNS[lang] || [];
  const lines = text.split("\n");
  const boundaries = [0]; // always start at line 0
  let lineOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const searchText = text.slice(lineOffset);

    for (const pattern of patterns) {
      const m = searchText.match(pattern);
      if (m && m.index === 0) {
        boundaries.push(lineOffset);
        break; // one boundary per line
      }
    }
    lineOffset += line.length + 1; // +1 for newline
  }

  boundaries.push(text.length); // end boundary
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

export function astChunk(text, filePath) {
  const lang = detectLanguage(filePath);
  if (!lang && !BOUNDARY_PATTERNS[lang]) return null; // unsupported, caller falls back

  const boundaries = findBoundaries(text, lang);
  if (boundaries.length <= 2) return null; // no meaningful boundaries found

  const chunks = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    let chunk = text.slice(start, end).trim();
    if (!chunk) continue;

    // Cap at max chars
    if (chunk.length > MAX_CHUNK_CHARS) chunk = chunk.slice(0, MAX_CHUNK_CHARS);
    if (!chunk) continue;

    chunks.push({ start, end, text: chunk });
  }

  return chunks.length > 1 ? chunks : null; // require at least 2 chunks to be meaningful
}
