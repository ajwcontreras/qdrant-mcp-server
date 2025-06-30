# Qdrant Background Indexing for Claude Code

This system provides automatic background indexing of your codebase into Qdrant for semantic search capabilities within Claude Code.

## Overview

The background indexing system consists of several components:

1. **Background Indexer** (`qdrant-background-indexer.cjs`) - Main daemon that watches files and indexes them
2. **Control Script** (`qdrant-indexer-control.cjs`) - CLI for managing the indexer
3. **MCP Client** (`qdrant-mcp-client.cjs`) - Executes indexing commands via MCP
4. **Index Generator** (`index-with-mcp.cjs`) - Generates MCP commands for indexing

## Features

- 🔄 **Automatic File Watching** - Monitors project files for changes
- 📊 **Queue Management** - Processes files in batches with retry logic
- 💾 **State Persistence** - Remembers indexed files across restarts
- 📈 **Progress Tracking** - Real-time status and statistics
- 🔌 **MCP Integration** - Works with Claude Code's MCP servers
- ⚡ **Performance Optimized** - Batched processing with debouncing

## Quick Start

### Start the Background Indexer

```bash
# Start the indexer
npm run qdrant:start

# Check status
npm run qdrant:status

# Watch live progress
npm run qdrant:watch
```

### Control Commands

```bash
# Start/stop/restart
npm run qdrant:start
npm run qdrant:stop
npm run qdrant:indexer restart

# Monitor
npm run qdrant:status          # One-time status check
npm run qdrant:watch           # Live monitoring
npm run qdrant:indexer logs    # Tail logs

# Control indexing
npm run qdrant:indexer pause   # Pause indexing
npm run qdrant:indexer resume  # Resume indexing
npm run qdrant:indexer reindex # Force full reindex
npm run qdrant:indexer clear   # Clear all data
```

## How It Works

### 1. File Watching

The indexer watches for file changes using chokidar:
- **Included**: `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.json`, `*.prisma`, `*.md`, `*.css`
- **Excluded**: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, test files

### 2. Queue Processing

Files are processed in batches:
- Batch size: 10 files
- Delay between batches: 2 seconds
- Automatic retry on failure (max 3 attempts)
- Debouncing to avoid excessive processing

### 3. Indexing Process

For each file:
1. Read file content and metadata
2. Extract features and framework information
3. Generate MCP command with semantic information
4. Execute command via MCP or direct Qdrant API
5. Track indexing status

### 4. State Management

The indexer maintains several state files:
- `.qdrant-indexed-files.json` - List of indexed files
- `.qdrant-indexing-queue.json` - Current queue
- `.qdrant-indexing-status.json` - Statistics and status
- `.qdrant-indexer.pid` - Process ID for control
- `.qdrant-indexer.log` - Indexer logs

## Configuration

Environment variables:
```bash
# Qdrant connection
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-api-key-if-needed

# Claude Code MCP socket (if available)
CLAUDE_CODE_MCP_SOCKET=/tmp/claude-code-qdrant.sock
```

## Manual Indexing

If you prefer manual control:

```bash
# Generate commands for all files
node scripts/index-with-mcp.cjs --max=3000

# Execute commands (simulation)
npm run index:execute

# Or use the MCP client directly
node scripts/qdrant-mcp-client.cjs qdrant-index-commands.json
```

## Monitoring

### Live Status Dashboard

```bash
npm run qdrant:watch
```

Shows:
- Current status (running/stopped)
- Progress bar with percentage
- Files indexed vs total
- Queue size
- Failed files count
- Processing rate (files/minute)
- Recent activity log

### One-time Status Check

```bash
npm run qdrant:status
```

### Logs

```bash
npm run qdrant:indexer logs
```

## Troubleshooting

### Indexer won't start

1. Check if already running: `npm run qdrant:status`
2. Check logs: `cat .qdrant-indexer.log`
3. Clear stale PID: `rm .qdrant-indexer.pid`

### Files not being indexed

1. Check file patterns in `INCLUDE_PATTERNS`
2. Verify file isn't in `EXCLUDE_PATTERNS`
3. Check queue: `cat .qdrant-indexing-queue.json`
4. Look for errors in logs

### High memory usage

1. Pause indexer: `npm run qdrant:indexer pause`
2. Reduce batch size in configuration
3. Clear queue and restart

### Reset everything

```bash
npm run qdrant:indexer clear
npm run qdrant:start
```

## Integration with Claude Code

The background indexer is designed to work seamlessly with Claude Code:

1. **Automatic Discovery** - Claude Code can use Qdrant MCP to search indexed files
2. **Semantic Search** - Find code by meaning, not just keywords
3. **Real-time Updates** - Changes are indexed automatically
4. **Context Enhancement** - Better code understanding and suggestions

## Performance Considerations

- Files > 1MB are skipped
- Test files are excluded by default
- Debouncing prevents rapid re-indexing
- Batch processing reduces system load
- State persistence avoids re-indexing

## Advanced Usage

### Custom File Patterns

Edit `INCLUDE_PATTERNS` and `EXCLUDE_PATTERNS` in `qdrant-background-indexer.cjs`

### Adjust Processing Speed

Modify configuration in the indexer:
```javascript
const CONFIG = {
  BATCH_SIZE: 10,        // Files per batch
  BATCH_DELAY: 2000,     // Delay between batches (ms)
  DEBOUNCE_DELAY: 500,   // File change debounce (ms)
  MAX_RETRIES: 3,        // Retry attempts
  RETRY_DELAY: 5000      // Retry delay (ms)
};
```

### Direct Qdrant API

The system can also use Qdrant's HTTP API directly if MCP is unavailable.

## Security Notes

- No sensitive files are indexed (`.env`, keys, etc.)
- Qdrant API key is optional for local instances
- All state files are local only
- Logs don't contain file contents

## Future Enhancements

- [ ] Real MCP server integration
- [ ] Embedding model integration
- [ ] Incremental updates
- [ ] Multiple collection support
- [ ] Web UI for monitoring
- [ ] Systemd service file
- [ ] Docker container