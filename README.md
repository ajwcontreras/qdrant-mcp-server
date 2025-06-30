# Qdrant MCP Server

A Model Context Protocol (MCP) server that provides semantic code search capabilities using Qdrant vector database and OpenAI embeddings.

## Features

- 🔍 **Semantic Code Search** - Find code by meaning, not just keywords
- 🚀 **Fast Indexing** - Efficient incremental indexing of large codebases
- 🤖 **MCP Integration** - Works seamlessly with Claude and other MCP clients
- 📊 **Background Monitoring** - Automatic reindexing of changed files
- 🎯 **Smart Filtering** - Respects .gitignore and custom patterns
- 💾 **Persistent Storage** - Embeddings stored in Qdrant for fast retrieval

## Installation

### Prerequisites

- Node.js 18+ 
- Python 3.8+
- Docker (for Qdrant) or Qdrant Cloud account
- OpenAI API key

### Quick Start

```bash
# Install the package
npm install -g @kindash/qdrant-mcp-server

# Or with pip
pip install qdrant-mcp-server

# Set up environment variables
export OPENAI_API_KEY="your-api-key"
export QDRANT_URL="http://localhost:6333"  # or your Qdrant Cloud URL
export QDRANT_API_KEY="your-qdrant-api-key"  # if using Qdrant Cloud

# Start Qdrant (if using Docker)
docker run -p 6333:6333 qdrant/qdrant

# Index your codebase
qdrant-indexer /path/to/your/code

# Start the MCP server
qdrant-mcp
```

## Configuration

### Environment Variables

Create a `.env` file in your project root:

```env
# Required
OPENAI_API_KEY=sk-...

# Qdrant Configuration
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=  # Optional, for Qdrant Cloud
QDRANT_COLLECTION_NAME=codebase  # Default: codebase

# Indexing Configuration
MAX_FILE_SIZE=1048576  # Maximum file size to index (default: 1MB)
BATCH_SIZE=10  # Number of files to process in parallel
EMBEDDING_MODEL=text-embedding-3-small  # OpenAI embedding model

# File Patterns
INCLUDE_PATTERNS=**/*.{js,ts,jsx,tsx,py,java,go,rs,cpp,c,h}
EXCLUDE_PATTERNS=**/node_modules/**,**/.git/**,**/dist/**
```

### MCP Configuration

Add to your Claude Desktop config (`~/.claude/config.json`):

```json
{
  "mcpServers": {
    "qdrant-search": {
      "command": "qdrant-mcp",
      "args": ["--collection", "my-codebase"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

## Usage

### Command Line Interface

```bash
# Index entire codebase
qdrant-indexer /path/to/code

# Index with custom patterns
qdrant-indexer /path/to/code --include "*.py" --exclude "tests/*"

# Index specific files
qdrant-indexer file1.js file2.py file3.ts

# Start background indexer
qdrant-control start

# Check indexer status
qdrant-control status

# Stop background indexer
qdrant-control stop
```

### In Claude

Once configured, you can use natural language queries:

- "Find all authentication code"
- "Show me files that handle user permissions"
- "What code is similar to the PaymentService class?"
- "Find all API endpoints related to users"
- "Show me error handling patterns in the codebase"

### Programmatic Usage

```python
from qdrant_mcp_server import QdrantIndexer, QdrantSearcher

# Initialize indexer
indexer = QdrantIndexer(
    openai_api_key="sk-...",
    qdrant_url="http://localhost:6333",
    collection_name="my-codebase"
)

# Index files
indexer.index_directory("/path/to/code")

# Search
searcher = QdrantSearcher(
    qdrant_url="http://localhost:6333",
    collection_name="my-codebase"
)

results = searcher.search("authentication logic", limit=10)
for result in results:
    print(f"{result.file_path}: {result.score}")
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude/MCP    │────▶│  MCP Server      │────▶│     Qdrant      │
│     Client      │     │  (Python)        │     │   Vector DB     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                           ▲
                               ▼                           │
                        ┌──────────────────┐              │
                        │  OpenAI API      │              │
                        │  (Embeddings)    │──────────────┘
                        └──────────────────┘
```

## Advanced Configuration

### Custom File Processors

```python
from qdrant_mcp_server import FileProcessor

class MyCustomProcessor(FileProcessor):
    def process(self, file_path: str, content: str) -> dict:
        # Custom processing logic
        return {
            "content": processed_content,
            "metadata": custom_metadata
        }

# Register processor
indexer.register_processor(".myext", MyCustomProcessor())
```

### Embedding Models

Support for multiple embedding providers:

```python
# OpenAI (default)
indexer = QdrantIndexer(embedding_provider="openai")

# Cohere
indexer = QdrantIndexer(
    embedding_provider="cohere",
    cohere_api_key="..."
)

# Local models (upcoming)
indexer = QdrantIndexer(
    embedding_provider="local",
    model_path="/path/to/model"
)
```

## Performance Optimization

### Batch Processing

```bash
# Process files in larger batches (reduces API calls)
qdrant-indexer /path/to/code --batch-size 50

# Limit concurrent requests
qdrant-indexer /path/to/code --max-concurrent 5
```

### Incremental Indexing

```bash
# Only index changed files since last run
qdrant-indexer /path/to/code --incremental

# Force reindex of all files
qdrant-indexer /path/to/code --force
```

### Cost Estimation

```bash
# Estimate indexing costs before running
qdrant-indexer /path/to/code --dry-run

# Output:
# Files to index: 1,234
# Estimated tokens: 2,456,789
# Estimated cost: $0.43
```

## Monitoring

### Web UI (Coming Soon)

```bash
# Start monitoring dashboard
qdrant-mcp --web-ui --port 8080
```

### Logs

```bash
# View indexer logs
tail -f ~/.qdrant-mcp/logs/indexer.log

# View search queries
tail -f ~/.qdrant-mcp/logs/queries.log
```

### Metrics

- Files indexed
- Tokens processed
- Search queries per minute
- Average response time
- Cache hit rate

## Troubleshooting

### Common Issues

**"Connection refused" error**
- Ensure Qdrant is running: `docker ps`
- Check QDRANT_URL is correct
- Verify firewall settings

**"Rate limit exceeded" error**
- Reduce batch size: `--batch-size 5`
- Add delay between requests: `--delay 1000`
- Use a different OpenAI tier

**"Out of memory" error**
- Process fewer files at once
- Increase Node.js memory: `NODE_OPTIONS="--max-old-space-size=4096"`
- Use streaming mode for large files

### Debug Mode

```bash
# Enable verbose logging
qdrant-mcp --debug

# Test connectivity
qdrant-mcp --test-connection

# Validate configuration
qdrant-mcp --validate-config
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/kindash/qdrant-mcp-server
cd qdrant-mcp-server

# Install dependencies
npm install
pip install -e .

# Run tests
npm test
pytest

# Run linting
npm run lint
flake8 src/
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built for the [Model Context Protocol](https://github.com/anthropics/model-context-protocol)
- Powered by [Qdrant](https://qdrant.tech/) vector database
- Embeddings by [OpenAI](https://openai.com/)
- Originally developed for [KinDash](https://github.com/steiner385/KinDash)

## Support

- 📧 Email: support@kindash.app
- 💬 Discord: [Join our community](https://discord.gg/kindash)
- 🐛 Issues: [GitHub Issues](https://github.com/kindash/qdrant-mcp-server/issues)
- 📖 Docs: [Full Documentation](https://docs.kindash.app/qdrant-mcp)