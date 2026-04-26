# Global Project Registry

The code-search tool should be global and project-agnostic. Keep the tool source in this repo and keep project-specific state under:

```text
~/.qdrant-code-search/
  config.json
  projects/<project-slug>/project.json
  logs/
  evals/
  hyde/
```

`config.json` stores non-secret defaults:

- `qdrant_url`
- `worker_url`
- `worker_token_path`
- `embedding_model`
- `collection_suffix`

Secrets are not copied into the registry. The project wrapper reads the Worker token from `worker_token_path` at runtime and passes it only to the child indexer process.

## Commands

Initialize a repo:

```sh
npm run project -- init /path/to/repo --collection my-repo-v2
```

List registered projects:

```sh
npm run project -- list
```

Print environment for an MCP wrapper:

```sh
npm run project -- env /path/to/repo
```

Index a repo with Cloudflare Worker-routed HyDE and embeddings:

```sh
npm run project -- index /path/to/repo --batch-size 100
```

## Current Behavior

- The indexer uses `git ls-files` when the target repo is a Git checkout.
- Untracked files are not indexed.
- `node_modules`, build outputs, lockfiles, generated minified assets, and very large/generated files are filtered by the indexer.
- The project wrapper disables local OpenAI direct calls by setting dummy local keys and delegates both HyDE and embedding calls to the Worker configured in `~/.qdrant-code-search/config.json`.

## Why This Exists

Collections should be per project. A global hidden registry avoids hardcoding one repo path into scripts and makes evaluation across unrelated codebases repeatable:

- one repo path
- one collection name
- one Qdrant URL
- one Worker endpoint/token reference
- one place for future benchmark/eval files
