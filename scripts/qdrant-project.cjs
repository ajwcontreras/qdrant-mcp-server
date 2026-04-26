#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TOOL_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOME = path.join(os.homedir(), ".qdrant-code-search");
const DEFAULT_WORKER_URL = "https://qdrant-openai-batch.patrickrandallwilliams1992.workers.dev";
const DEFAULT_TOKEN_PATH = "/tmp/qdrant-openai-batch-token.txt";

function usage() {
  console.log(`Usage:
  node scripts/qdrant-project.cjs init <repo> [--collection name]
  node scripts/qdrant-project.cjs list
  node scripts/qdrant-project.cjs show <repo-or-slug>
  node scripts/qdrant-project.cjs env <repo-or-slug>
  node scripts/qdrant-project.cjs index <repo-or-slug> [--batch-size 100] [--collection name] [--hyde-jsonl path]

Environment:
  QDRANT_CODE_SEARCH_HOME   Default: ~/.qdrant-code-search
  QDRANT_WORKER_URL         Default: ${DEFAULT_WORKER_URL}
  QDRANT_WORKER_TOKEN_PATH  Default: ${DEFAULT_TOKEN_PATH}
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function homeDir() {
  return path.resolve(process.env.QDRANT_CODE_SEARCH_HOME || DEFAULT_HOME);
}

function ensureGlobalHome() {
  const root = homeDir();
  for (const dir of ["projects", "logs", "evals", "hyde"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const configPath = path.join(root, "config.json");
  if (!fs.existsSync(configPath)) {
    atomicWriteJson(configPath, {
      version: 1,
      qdrant_url: "http://localhost:6333",
      worker_url: process.env.QDRANT_WORKER_URL || DEFAULT_WORKER_URL,
      worker_token_path: process.env.QDRANT_WORKER_TOKEN_PATH || DEFAULT_TOKEN_PATH,
      embedding_model: "text-embedding-3-large",
      collection_suffix: "v2",
    });
  }
  return root;
}

function readConfig() {
  const root = ensureGlobalHome();
  return JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function slugBase(repoPath) {
  const base = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base || "repo";
}

function repoHash(repoPath) {
  return crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 8);
}

function defaultCollection(repoPath, config) {
  return `${slugBase(repoPath)}-${repoHash(repoPath)}-${config.collection_suffix || "v2"}`;
}

function projectPath(slug) {
  return path.join(homeDir(), "projects", slug, "project.json");
}

function readAllProjects() {
  const projectsRoot = path.join(ensureGlobalHome(), "projects");
  return fs.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(projectsRoot, entry.name, "project.json");
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    })
    .filter(Boolean);
}

function resolveProject(input) {
  const absolute = path.resolve(input);
  const projects = readAllProjects();
  return projects.find((project) => project.slug === input || path.resolve(project.repo_path) === absolute);
}

function requireProject(input) {
  const project = resolveProject(input);
  if (!project) {
    throw new Error(`Unknown project: ${input}. Run init first.`);
  }
  return project;
}

function tokenFromFile(tokenPath) {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Worker token file does not exist: ${tokenPath}`);
  }
  return fs.readFileSync(tokenPath, "utf8").trim();
}

function commandInit(args) {
  const repoInput = args._[1];
  if (!repoInput) throw new Error("init requires a repo path");
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path does not exist: ${repoPath}`);
  const config = readConfig();
  const slug = `${slugBase(repoPath)}-${repoHash(repoPath)}`;
  const collection = args.collection || defaultCollection(repoPath, config);
  const project = {
    version: 1,
    slug,
    repo_path: repoPath,
    collection,
    qdrant_url: config.qdrant_url,
    worker_url: config.worker_url,
    worker_token_path: config.worker_token_path,
    embedding_model: config.embedding_model,
    use_v2_schema: true,
    tracks_git_files_only: true,
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(projectPath(slug), project);
  console.log(JSON.stringify(project, null, 2));
}

function commandList() {
  for (const project of readAllProjects()) {
    console.log(`${project.slug}\t${project.collection}\t${project.repo_path}`);
  }
}

function commandShow(args) {
  const input = args._[1];
  if (!input) throw new Error("show requires a repo path or slug");
  console.log(JSON.stringify(requireProject(input), null, 2));
}

function commandEnv(args) {
  const input = args._[1];
  if (!input) throw new Error("env requires a repo path or slug");
  const project = requireProject(input);
  console.log(`export QDRANT_URL=${shellQuote(project.qdrant_url)}`);
  console.log(`export COLLECTION_NAME=${shellQuote(project.collection)}`);
  console.log("export QDRANT_USE_V2_SCHEMA=true");
  console.log(`export OPENAI_EMBEDDING_MODEL=${shellQuote(project.embedding_model)}`);
  console.log(`export HYDE_WORKER_URL=${shellQuote(project.worker_url)}`);
  console.log(`export EMBEDDING_WORKER_URL=${shellQuote(project.worker_url)}`);
  console.log(`export HYDE_WORKER_TOKEN="$(cat ${shellQuote(project.worker_token_path)})"`);
  console.log(`export EMBEDDING_WORKER_TOKEN="$(cat ${shellQuote(project.worker_token_path)})"`);
}

function commandIndex(args) {
  const input = args._[1];
  if (!input) throw new Error("index requires a repo path or slug");
  const project = requireProject(input);
  const token = tokenFromFile(project.worker_token_path);
  const env = { ...process.env };
  delete env.OPENAI_BASE_URL;
  delete env.CLOUDFLARE_AI_GATEWAY_URL;
  delete env.AI_GATEWAY_TOKEN;
  delete env.CF_AIG_TOKEN;
  env.OPENAI_API_KEY = "disabled-local-openai-key";
  env.OPENAI_BLAST_KEY_PATH = "/tmp/disabled-blastkey-for-qdrant";
  env.QDRANT_URL = project.qdrant_url;
  env.QDRANT_USE_V2_SCHEMA = "true";
  env.OPENAI_EMBEDDING_MODEL = project.embedding_model;
  if (Array.isArray(project.include_globs) && project.include_globs.length > 0) {
    env.QDRANT_INCLUDE_GLOBS = project.include_globs.join(",");
  }
  if (Array.isArray(project.exclude_globs) && project.exclude_globs.length > 0) {
    env.QDRANT_EXCLUDE_GLOBS = project.exclude_globs.join(",");
  }
  env.HYDE_WORKER_URL = project.worker_url;
  env.HYDE_WORKER_TOKEN = token;
  env.HYDE_WORKER_BATCH_SIZE = env.HYDE_WORKER_BATCH_SIZE || "20";
  env.HYDE_WORKER_REQUESTS = env.HYDE_WORKER_REQUESTS || "6";
  env.EMBEDDING_WORKER_URL = project.worker_url;
  env.EMBEDDING_WORKER_TOKEN = token;
  env.OPENAI_EMBEDDING_BATCH_SIZE = env.OPENAI_EMBEDDING_BATCH_SIZE || "32";
  env.OPENAI_EMBEDDING_WORKERS = env.OPENAI_EMBEDDING_WORKERS || "6";
  env.QDRANT_UPSERT_BATCH_SIZE = env.QDRANT_UPSERT_BATCH_SIZE || "100";
  const batchSize = String(args["batch-size"] || 100);
  const collection = args.collection || project.collection;
  const commandArgs = [
    path.join(TOOL_ROOT, "src/qdrant-openai-indexer.py"),
    project.repo_path,
    "--collection",
    collection,
    "--batch-size",
    batchSize,
  ];
  if (args["hyde-jsonl"]) {
    commandArgs.push("--hyde-jsonl", path.resolve(args["hyde-jsonl"]));
  }
  const result = spawnSync(
    path.join(TOOL_ROOT, "venv/bin/python"),
    commandArgs,
    { cwd: TOOL_ROOT, env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status || 0);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === "help" || args.help) {
      usage();
      return;
    }
    ensureGlobalHome();
    if (command === "init") return commandInit(args);
    if (command === "list") return commandList(args);
    if (command === "show") return commandShow(args);
    if (command === "env") return commandEnv(args);
    if (command === "index") return commandIndex(args);
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
