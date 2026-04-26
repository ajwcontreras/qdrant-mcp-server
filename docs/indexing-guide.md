# Qdrant Codebase Indexing Scripts

This directory contains utility scripts for indexing the KinDash codebase into Qdrant vector database for semantic search and code discovery.

## Scripts Overview

## Recommended Setup Pass

Before a first full index, do a quick repository tree audit and identify files that are useful for agents versus files that are merely build output, vendored libraries, lockfiles, generated CSS, source maps, or minified bundles. The index should optimize for source-grounded retrieval, not byte coverage.

The Python indexer applies these guardrails by default:

- skips obvious dependency/build directories such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, and `vendor`;
- skips lockfiles, source maps, minified assets, logs, and known generated Tailwind CSS outputs;
- skips very large files and generated one-line `.css`, `.js`, `.json`, or `.xml` assets;
- hard-splits any remaining overlong single line so a file cannot create a huge 100KB+ chunk.

If a project has domain-specific generated files, add them to the exclusion rules before running an expensive embedding or HyDE pass.

### 1. `index-codebase-qdrant.cjs`
**Main indexing utility** - Comprehensive script for scanning and indexing all project files.

**Features:**
- Recursive file scanning with intelligent filtering
- File type categorization (React components, APIs, tests, etc.)
- Content analysis and metadata extraction
- Batch processing with configurable sizes
- Direct Qdrant API integration

**Usage:**
```bash
node scripts/index-codebase-qdrant.cjs [options]

Options:
  --clean     Clean existing index before indexing
  --dry-run   Show what would be indexed without actually indexing
  --verbose   Show detailed progress information
  --filter    File pattern filter (default: all supported files)
```

### 2. `index-with-mcp.cjs`
**MCP command generator** - Creates MCP Qdrant store commands for Claude Code execution.

**Features:**
- Generates MCP-compatible commands
- Enhanced semantic content extraction
- Metadata enrichment with file analysis
- Command serialization to JSON
- Optimized for Claude Code MCP integration

**Usage:**
```bash
node scripts/index-with-mcp.cjs [options]

Options:
  --verbose      Show detailed output
  --filter=PATH  Index only files matching PATH
  --max=N        Limit to N files (default: 50)
```

### 3. `batch-index-qdrant.cjs`
**Batch executor** - Processes multiple MCP commands in batches.

**Features:**
- Batch processing with configurable sizes
- Rate limiting between batches
- Progress tracking and error handling
- Support for both file-based and generated commands
- Comprehensive result reporting

**Usage:**
```bash
node scripts/batch-index-qdrant.cjs [commands-file]

# Uses qdrant-index-commands.json by default
# Generates core file commands if no file found
```

## File Type Categories

The indexing system recognizes and categorizes these file types:

| Extension | Category | Description |
|-----------|----------|-------------|
| `.ts`, `.tsx` | `typescript`, `typescript-react` | TypeScript source files |
| `.js`, `.jsx` | `javascript`, `javascript-react` | JavaScript source files |
| `.css`, `.scss` | `styles` | Stylesheet files |
| `.md`, `.mdx` | `documentation` | Documentation files |
| `.json`, `.yml` | `configuration` | Configuration files |
| `.prisma`, `.sql` | `database` | Database schema files |
| `.test.*`, `.spec.*` | `test` | Test files |

## Directory-Based Classification

Files are further classified by their directory structure:

- `/components/` → `component`
- `/pages/` → `page`
- `/api/` → `api`
- `/hooks/` → `hook`
- `/utils/` → `utility`
- `/contexts/` → `context`
- `/services/` → `service`
- `/middleware/` → `middleware`
- `/types/` → `types`
- `/__tests__/` → `test`

## Content Analysis Features

The scripts extract and index these content features:

### Code Patterns
- Import/export statements
- React hooks usage
- TypeScript interfaces and types
- API endpoints and routes
- Database models
- Authentication patterns
- Testing patterns

### Framework Detection
- React components and patterns
- Express.js server code
- Prisma database schemas
- Playwright test files
- Jest test suites

### Dependencies
- External package imports
- Internal module dependencies
- Framework integrations

## Exclusion Rules

The following are automatically excluded from indexing:

### Directories
- `node_modules`
- `.git`
- `dist`, `build`
- Coverage and test results
- IDE configuration directories

### Files
- Lock files (`package-lock.json`, `yarn.lock`)
- Large files (> 1MB)
- Minified files (`.min.js`, `.min.css`)
- Source maps (`.map` files)
- Log files

## Workflow Examples

### 1. Initial Full Index
```bash
# Scan entire codebase
node scripts/index-codebase-qdrant.cjs --verbose

# Or generate MCP commands
node scripts/index-with-mcp.cjs --max=100
node scripts/batch-index-qdrant.cjs
```

### 2. Component-Only Index
```bash
# Index only React components
node scripts/index-with-mcp.cjs --filter=src/components --max=20
node scripts/batch-index-qdrant.cjs
```

### 3. API-Only Index
```bash
# Index only API files
node scripts/index-with-mcp.cjs --filter=src/api --max=15
node scripts/batch-index-qdrant.cjs
```

### 4. Incremental Updates
```bash
# Index specific areas after changes
node scripts/index-with-mcp.cjs --filter=src/pages --max=10
node scripts/batch-index-qdrant.cjs
```

## Semantic Search Capabilities

After indexing, you can perform semantic searches like:

### Component Discovery
- "React authentication components"
- "Button components with variants"
- "Navigation components with routing"
- "Error boundary components"

### API Discovery
- "Express API endpoints"
- "Task management APIs"
- "Authentication middleware"
- "Database query functions"

### Feature Discovery
- "JWT token handling"
- "Role-based access control"
- "File upload functionality"
- "Real-time features"

### Test Discovery
- "Unit tests for components"
- "E2E test scenarios"
- "API integration tests"
- "Authentication test helpers"

## Configuration

### Environment Variables
- `QDRANT_URL` - Qdrant server URL (default: http://localhost:6333)
- `COLLECTION_NAME` - Target collection (default: familymanager-codebase)

### Script Configuration
Modify the `CONFIG` object in `index-codebase-qdrant.cjs`:

```javascript
const CONFIG = {
  maxFileSize: 1024 * 1024, // 1MB limit
  batchSize: 10,             // Files per batch
  excludeDirs: [...],        // Directories to skip
  excludeFiles: [...],       // Files to skip
  fileTypes: {...}           // Supported file types
};
```

## Troubleshooting

### Common Issues

1. **Qdrant Connection Failed**
   ```bash
   # Check if Qdrant is running
   curl http://localhost:6333/collections
   
   # Start Qdrant if needed
   docker run -p 6333:6333 qdrant/qdrant
   ```

2. **Vector Configuration Error**
   ```bash
   # Delete and recreate collection with correct vector config
   curl -X DELETE http://localhost:6333/collections/familymanager-codebase
   ```

3. **Large File Warnings**
   - Files over 1MB are skipped by default
   - Adjust `maxFileSize` in CONFIG if needed
   - Check for accidentally committed large files

4. **MCP Tool Errors**
   - Ensure Claude Code is running with Qdrant MCP server
   - Check MCP server configuration in `.claude.json`
   - Verify collection exists and has correct vector naming

### Performance Tips

- Use `--filter` to limit scope for faster processing
- Process in smaller batches (`--max=20`) for testing
- Use `--dry-run` to preview without indexing
- Run incremental updates for specific directories

## Integration with Claude Code

These scripts are designed to work seamlessly with Claude Code's MCP integration:

1. Generate commands with `index-with-mcp.cjs`
2. Review generated `qdrant-index-commands.json`
3. Execute commands through Claude Code MCP
4. Use semantic search via `mcp__qdrant__qdrant-find`

## Future Enhancements

Potential improvements for the indexing system:

- **Incremental indexing** based on file modification times
- **Dependency graph analysis** for better relationship mapping
- **Code complexity metrics** integration
- **Custom embedding models** for domain-specific search
- **Integration with IDE extensions** for real-time indexing
- **Search result ranking** based on usage patterns
