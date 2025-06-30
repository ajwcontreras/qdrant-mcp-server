#!/usr/bin/env node

/**
 * Basic usage example for qdrant-mcp-server
 * 
 * This example shows how to:
 * 1. Index a codebase
 * 2. Search for code semantically
 * 3. Use the MCP server
 */

const { spawn } = require('child_process');
const path = require('path');

// Configuration
const config = {
  codebasePath: process.argv[2] || process.cwd(),
  qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
  openaiKey: process.env.OPENAI_API_KEY,
};

// Validate configuration
if (!config.openaiKey) {
  console.error('Error: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

console.log('Qdrant MCP Server - Basic Usage Example\n');
console.log('Configuration:');
console.log(`  Codebase: ${config.codebasePath}`);
console.log(`  Qdrant URL: ${config.qdrantUrl}`);
console.log(`  OpenAI Key: ${config.openaiKey.substring(0, 10)}...`);
console.log('\n');

// Step 1: Index the codebase
console.log('Step 1: Indexing codebase...');
const indexer = spawn('python3', [
  path.join(__dirname, '..', 'src', 'qdrant-openai-indexer.py'),
  config.codebasePath,
  '--batch-size', '10',
  '--verbose'
], {
  env: {
    ...process.env,
    OPENAI_API_KEY: config.openaiKey,
    QDRANT_URL: config.qdrantUrl,
  }
});

indexer.stdout.on('data', (data) => {
  console.log(`[Indexer] ${data}`);
});

indexer.stderr.on('data', (data) => {
  console.error(`[Indexer Error] ${data}`);
});

indexer.on('close', (code) => {
  if (code !== 0) {
    console.error(`Indexing failed with code ${code}`);
    process.exit(1);
  }
  
  console.log('\nIndexing complete!');
  console.log('\nStep 2: Starting MCP server...');
  
  // Step 2: Start the MCP server
  const mcpServer = spawn('python3', [
    path.join(__dirname, '..', 'src', 'mcp-qdrant-openai-wrapper.py')
  ], {
    env: {
      ...process.env,
      OPENAI_API_KEY: config.openaiKey,
      QDRANT_URL: config.qdrantUrl,
    }
  });
  
  mcpServer.stdout.on('data', (data) => {
    console.log(`[MCP Server] ${data}`);
  });
  
  mcpServer.stderr.on('data', (data) => {
    console.error(`[MCP Server Error] ${data}`);
  });
  
  // Example queries
  console.log('\nExample queries you can use in Claude:');
  console.log('  - "Find all authentication code"');
  console.log('  - "Show me error handling patterns"');
  console.log('  - "What files handle user permissions?"');
  console.log('  - "Find code similar to PaymentService"');
  console.log('\nPress Ctrl+C to stop the server');
});

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});