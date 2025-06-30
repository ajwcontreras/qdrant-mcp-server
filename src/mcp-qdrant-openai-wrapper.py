#!/usr/bin/env python3
"""
MCP Server for Qdrant with OpenAI Embeddings

This script implements a Model Context Protocol (MCP) server that provides
semantic search capabilities using Qdrant vector database and OpenAI embeddings.

Required environment variables:
- OPENAI_API_KEY: Your OpenAI API key
- QDRANT_URL: Qdrant server URL (default: http://localhost:6333)
- COLLECTION_NAME: Qdrant collection name (default: kindash-codebase-openai)
- OPENAI_EMBEDDING_MODEL: OpenAI embedding model (default: text-embedding-3-small)
"""

import os
import sys
import json
import asyncio
from typing import List, Dict, Any, Optional
import logging

# Configure logging with more detail for debugging
log_level = os.environ.get('MCP_LOG_LEVEL', 'INFO')
logging.basicConfig(
    level=getattr(logging, log_level.upper(), logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stderr)  # Log to stderr to avoid interfering with stdout
    ]
)
logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue
except ImportError as e:
    logger.error(f"Required package not installed: {e}")
    logger.error("Please install: pip install openai qdrant-client")
    sys.exit(1)

# MCP Protocol implementation
class MCPServer:
    """Minimal MCP server implementation for Qdrant operations"""
    
    def __init__(self):
        self.openai_api_key = os.environ.get("OPENAI_API_KEY")
        if not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")
            
        self.qdrant_url = os.environ.get("QDRANT_URL", "http://localhost:6333")
        self.collection_name = os.environ.get("COLLECTION_NAME", "kindash-codebase-openai")
        self.embedding_model = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
        
        # Initialize clients
        self.openai_client = OpenAI(api_key=self.openai_api_key)
        self.qdrant_client = QdrantClient(url=self.qdrant_url)
        
        # Verify collection exists
        self._ensure_collection()
        
    def _ensure_collection(self):
        """Ensure the Qdrant collection exists with correct configuration"""
        try:
            collections = self.qdrant_client.get_collections()
            collection_names = [c.name for c in collections.collections]
            
            if self.collection_name not in collection_names:
                logger.info(f"Creating collection: {self.collection_name}")
                self.qdrant_client.create_collection(
                    collection_name=self.collection_name,
                    vectors_config=VectorParams(
                        size=1536,  # text-embedding-3-small dimension
                        distance=Distance.COSINE
                    )
                )
            else:
                logger.info(f"Collection {self.collection_name} already exists")
        except Exception as e:
            logger.error(f"Failed to ensure collection: {e}")
            raise
    
    def get_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings using OpenAI API"""
        try:
            response = self.openai_client.embeddings.create(
                model=self.embedding_model,
                input=texts
            )
            return [data.embedding for data in response.data]
        except Exception as e:
            logger.error(f"Failed to generate embeddings: {e}")
            raise
    
    async def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle incoming MCP requests"""
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")
        
        try:
            if method == "initialize":
                return self._handle_initialize(request_id)
            elif method == "tools/list":
                return self._handle_tools_list(request_id)
            elif method == "tools/call":
                return await self._handle_tool_call(params, request_id)
            else:
                return self._error_response(request_id, f"Unknown method: {method}")
        except Exception as e:
            logger.error(f"Error handling request: {e}")
            return self._error_response(request_id, str(e))
    
    def _handle_initialize(self, request_id: Any) -> Dict[str, Any]:
        """Handle initialization request"""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "qdrant-openai-mcp",
                    "version": "1.0.0"
                }
            }
        }
    
    def _handle_tools_list(self, request_id: Any) -> Dict[str, Any]:
        """Return available tools"""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [
                    {
                        "name": "search",
                        "description": "Search for code using semantic similarity",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {
                                    "type": "string",
                                    "description": "Search query"
                                },
                                "limit": {
                                    "type": "number",
                                    "description": "Maximum number of results",
                                    "default": 10
                                },
                                "filter": {
                                    "type": "object",
                                    "description": "Optional metadata filters"
                                }
                            },
                            "required": ["query"]
                        }
                    },
                    {
                        "name": "store",
                        "description": "Store code snippet with embeddings",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "content": {
                                    "type": "string",
                                    "description": "Content to store"
                                },
                                "metadata": {
                                    "type": "object",
                                    "description": "Metadata for the content"
                                },
                                "id": {
                                    "type": "string",
                                    "description": "Optional unique ID"
                                }
                            },
                            "required": ["content"]
                        }
                    },
                    {
                        "name": "collection_info",
                        "description": "Get information about the collection",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    }
                ]
            }
        }
    
    async def _handle_tool_call(self, params: Dict[str, Any], request_id: Any) -> Dict[str, Any]:
        """Handle tool invocation"""
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        if tool_name == "search":
            result = await self._search(
                query=arguments.get("query"),
                limit=arguments.get("limit", 10),
                filter_dict=arguments.get("filter")
            )
        elif tool_name == "store":
            result = await self._store(
                content=arguments.get("content"),
                metadata=arguments.get("metadata", {}),
                point_id=arguments.get("id")
            )
        elif tool_name == "collection_info":
            result = await self._get_collection_info()
        else:
            return self._error_response(request_id, f"Unknown tool: {tool_name}")
        
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2)
                    }
                ]
            }
        }
    
    async def _search(self, query: str, limit: int = 10, filter_dict: Optional[Dict] = None) -> Dict[str, Any]:
        """Search for similar content"""
        try:
            # Generate embedding for query
            query_embedding = self.get_embeddings([query])[0]
            
            # Build filter if provided
            qdrant_filter = None
            if filter_dict:
                conditions = []
                for key, value in filter_dict.items():
                    conditions.append(FieldCondition(key=key, match=MatchValue(value=value)))
                if conditions:
                    qdrant_filter = Filter(must=conditions)
            
            # Search
            results = self.qdrant_client.search(
                collection_name=self.collection_name,
                query_vector=query_embedding,
                limit=limit,
                query_filter=qdrant_filter
            )
            
            # Format results
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "id": str(result.id),
                    "score": result.score,
                    "metadata": result.payload
                })
            
            return {
                "query": query,
                "count": len(formatted_results),
                "results": formatted_results
            }
            
        except Exception as e:
            logger.error(f"Search error: {e}")
            return {"error": str(e)}
    
    async def _store(self, content: str, metadata: Dict[str, Any], point_id: Optional[str] = None) -> Dict[str, Any]:
        """Store content with embeddings"""
        try:
            # Generate embedding
            embedding = self.get_embeddings([content])[0]
            
            # Generate ID if not provided
            if not point_id:
                import hashlib
                point_id = hashlib.md5(content.encode()).hexdigest()
            
            # Create point
            point = PointStruct(
                id=point_id,
                vector=embedding,
                payload=metadata
            )
            
            # Upsert to Qdrant
            self.qdrant_client.upsert(
                collection_name=self.collection_name,
                points=[point]
            )
            
            return {
                "id": point_id,
                "status": "stored",
                "metadata": metadata
            }
            
        except Exception as e:
            logger.error(f"Store error: {e}")
            return {"error": str(e)}
    
    async def _get_collection_info(self) -> Dict[str, Any]:
        """Get collection information"""
        try:
            info = self.qdrant_client.get_collection(self.collection_name)
            return {
                "name": self.collection_name,
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
                "config": {
                    "vector_size": info.config.params.vectors.size,
                    "distance": info.config.params.vectors.distance.value
                }
            }
        except Exception as e:
            logger.error(f"Collection info error: {e}")
            return {"error": str(e)}
    
    def _error_response(self, request_id: Any, message: str) -> Dict[str, Any]:
        """Create error response"""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32603,
                "message": message
            }
        }

async def main():
    """Main entry point for the MCP server"""
    server = MCPServer()
    
    logger.info("MCP Qdrant OpenAI server started")
    
    # Use a thread pool executor to read from stdin without blocking the event loop
    import concurrent.futures
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    loop = asyncio.get_event_loop()
    
    def read_line():
        """Blocking read from stdin"""
        return sys.stdin.readline()
    
    while True:
        try:
            # Read line from stdin in a separate thread
            line = await loop.run_in_executor(executor, read_line)
            
            if not line:
                logger.info("EOF received, shutting down")
                break
            
            line = line.strip()
            if not line:
                continue
            
            # Parse JSON-RPC request
            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON: {e}, line: {line}")
                error_response = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32700,
                        "message": f"Parse error: {str(e)}"
                    }
                }
                sys.stdout.write(json.dumps(error_response) + '\n')
                sys.stdout.flush()
                continue
            
            logger.debug(f"Received request: {request}")
            
            # Handle request
            response = await server.handle_request(request)
            
            # Write response
            response_str = json.dumps(response)
            sys.stdout.write(response_str + '\n')
            sys.stdout.flush()
            logger.debug(f"Sent response: {response_str}")
            
        except Exception as e:
            logger.error(f"Error in main loop: {e}", exc_info=True)
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            sys.stdout.write(json.dumps(error_response) + '\n')
            sys.stdout.flush()
    
    # Cleanup
    executor.shutdown(wait=True)

if __name__ == "__main__":
    # Add a simple test mode
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        logger.info("Running in test mode")
        logger.info(f"Python version: {sys.version}")
        logger.info(f"OPENAI_API_KEY set: {'OPENAI_API_KEY' in os.environ}")
        logger.info(f"QDRANT_URL: {os.environ.get('QDRANT_URL', 'http://localhost:6333')}")
        logger.info(f"COLLECTION_NAME: {os.environ.get('COLLECTION_NAME', 'kindash-codebase-openai')}")
        
        try:
            server = MCPServer()
            logger.info("Server initialized successfully")
            sys.exit(0)
        except Exception as e:
            logger.error(f"Failed to initialize server: {e}")
            sys.exit(1)
    
    try:
        logger.info("Starting MCP Qdrant OpenAI server...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)