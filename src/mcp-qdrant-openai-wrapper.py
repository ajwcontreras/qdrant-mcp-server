#!/usr/bin/env python3
"""
MCP Server for Qdrant with OpenAI Embeddings

This script implements a Model Context Protocol (MCP) server that provides
semantic search capabilities using Qdrant vector database and OpenAI embeddings.
"""

import os
import sys
import json
import asyncio
import logging
import uuid
import re
import hashlib
from collections import Counter
from typing import List, Dict, Any, Optional

log_level = os.environ.get('MCP_LOG_LEVEL', 'INFO')
logging.basicConfig(
    level=getattr(logging, log_level.upper(), logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stderr)
    ]
)
logger = logging.getLogger(__name__)

try:
    from openai import AsyncOpenAI
    from qdrant_client import AsyncQdrantClient
    from qdrant_client.models import (
        Distance,
        VectorParams,
        SparseVectorParams,
        SparseIndexParams,
        SparseVector,
        Prefetch,
        Fusion,
        FusionQuery,
        Filter,
        FieldCondition,
        MatchValue,
        MatchAny,
    )
except ImportError as e:
    logger.error(f"Required package not installed: {e}")
    sys.exit(1)

# Namespace for predictable UUID generation based on string inputs
NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
DEFAULT_COLLECTION_NAME = "my-codebase-v2"
LEGACY_COLLECTION_NAME = "my-codebase"
DENSE_VECTOR_HYDE = "hyde_dense"
DENSE_VECTOR_CODE = "code_dense"
DENSE_VECTOR_SUMMARY = "summary_dense"
SPARSE_VECTOR_LEXICAL = "lexical_sparse"
SPARSE_HASH_BUCKETS = 1_000_003
SPARSE_HASH_VERSION = "sha256-mod-1000003-v1"
DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 20
DEFAULT_CANDIDATE_LIMIT = 50

MODEL_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}

class MCPServer:
    def __init__(self):
        self.openai_api_key = os.environ.get("OPENAI_API_KEY")
        if not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")
            
        self.qdrant_url = os.environ.get("QDRANT_URL", "http://localhost:6333")
        self.collection_name = os.environ.get("COLLECTION_NAME", DEFAULT_COLLECTION_NAME)
        self.embedding_model = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
        self.openai_base_url = (os.environ.get("CLOUDFLARE_AI_GATEWAY_URL") or os.environ.get("OPENAI_BASE_URL") or "").strip() or None
        self.vector_size = MODEL_DIMS.get(self.embedding_model, 3072)
        self.use_v2_vectors = (
            os.environ.get("QDRANT_USE_V2_SCHEMA", "").strip().lower() in {"1", "true", "yes"}
            or self.collection_name != LEGACY_COLLECTION_NAME
        )
        
        client_kwargs = {"api_key": self.openai_api_key}
        if self.openai_base_url:
            client_kwargs["base_url"] = self.openai_base_url
        self.openai_client = AsyncOpenAI(**client_kwargs)
        logger.info("OpenAI async client initialized (%s).", f"gateway={self.openai_base_url}" if self.openai_base_url else "direct OpenAI")
        self.qdrant_client = AsyncQdrantClient(url=self.qdrant_url)
        
    async def initialize(self):
        await self._ensure_collection()

    async def _ensure_collection(self):
        try:
            collections = await self.qdrant_client.get_collections()
            collection_names = [c.name for c in collections.collections]
            
            if self.collection_name not in collection_names:
                logger.info(f"Creating collection: {self.collection_name} with dim {self.vector_size}")
                if self.use_v2_vectors:
                    await self.qdrant_client.create_collection(
                        collection_name=self.collection_name,
                        vectors_config={
                            DENSE_VECTOR_HYDE: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                            DENSE_VECTOR_CODE: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                            DENSE_VECTOR_SUMMARY: VectorParams(size=self.vector_size, distance=Distance.COSINE),
                        },
                        sparse_vectors_config={
                            SPARSE_VECTOR_LEXICAL: SparseVectorParams(index=SparseIndexParams(on_disk=False)),
                        },
                    )
                else:
                    await self.qdrant_client.create_collection(
                        collection_name=self.collection_name,
                        vectors_config=VectorParams(
                            size=self.vector_size,
                            distance=Distance.COSINE
                        )
                    )
            else:
                logger.info(f"Collection {self.collection_name} already exists")
        except Exception as e:
            logger.error(f"Failed to ensure collection: {e}")
            raise
    
    async def get_embeddings(self, texts: List[str]) -> List[List[float]]:
        try:
            response = await self.openai_client.embeddings.create(
                model=self.embedding_model,
                input=texts
            )
            return [data.embedding for data in response.data]
        except Exception as e:
            logger.error(f"Failed to generate embeddings: {e}")
            raise

    def _lexical_tokens(self, text: str) -> List[str]:
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|[0-9]+", text or "")
        expanded = []
        for token in tokens:
            lowered = token.lower()
            expanded.append(lowered)
            for part in re.split(r"[_\\-]+", lowered):
                if part and part != lowered:
                    expanded.append(part)
            camel_parts = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)|[0-9]+", token)
            for part in camel_parts:
                part = part.lower()
                if part and part != lowered:
                    expanded.append(part)
        return [token for token in expanded if len(token) > 1]

    def _make_sparse_vector(self, text: str) -> SparseVector:
        counts = Counter(self._lexical_tokens(text))
        if not counts:
            return SparseVector(indices=[], values=[])
        hashed: Dict[int, float] = {}
        for token, count in counts.items():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:8], "big") % SPARSE_HASH_BUCKETS
            hashed[index] = hashed.get(index, 0.0) + float(count)
        norm = sum(value * value for value in hashed.values()) ** 0.5 or 1.0
        indices = sorted(hashed)
        values = [hashed[index] / norm for index in indices]
        return SparseVector(indices=indices, values=values)

    def _build_qdrant_filter(self, filter_dict: Optional[Dict]) -> Optional[Filter]:
        conditions = self._filter_conditions(filter_dict)
        return Filter(must=conditions) if conditions else None

    def _filter_conditions(self, filter_dict: Optional[Dict]) -> List[FieldCondition]:
        if not filter_dict:
            return []
        conditions = []
        for key, value in filter_dict.items():
            if isinstance(value, list):
                conditions.append(FieldCondition(key=key, match=MatchAny(any=value)))
            else:
                conditions.append(FieldCondition(key=key, match=MatchValue(value=value)))
        return conditions

    async def _exact_candidates(self, query_terms: List[str], filter_dict: Optional[Dict], candidate_limit: int) -> List[Dict[str, Any]]:
        if not query_terms:
            return []
        candidates = {}
        base_conditions = self._filter_conditions(filter_dict)
        exact_terms = query_terms[:40]
        for key in ("symbols_defined", "path_tokens"):
            scroll_filter = Filter(
                must=[
                    *base_conditions,
                    FieldCondition(key=key, match=MatchAny(any=exact_terms)),
                ]
            )
            points, _ = await self.qdrant_client.scroll(
                collection_name=self.collection_name,
                scroll_filter=scroll_filter,
                limit=candidate_limit,
                with_payload=True,
                with_vectors=False,
            )
            for point in points:
                candidates[str(point.id)] = {
                    "id": str(point.id),
                    "score": 1.0,
                    "payload": point.payload or {},
                    "source": key,
                }
                if len(candidates) >= candidate_limit:
                    return list(candidates.values())
        return list(candidates.values())

    def _query_terms(self, query: str) -> List[str]:
        return sorted(set(self._lexical_tokens(query)))

    def _match_reasons(self, query_terms: List[str], payload: Dict[str, Any]) -> List[str]:
        reasons = []
        symbols = {str(item).lower() for item in payload.get("symbols_defined") or []}
        path_tokens = {str(item).lower() for item in payload.get("path_tokens") or []}
        signature = str(payload.get("signature") or "").lower()
        content = str(payload.get("content") or "").lower()
        if symbols.intersection(query_terms):
            reasons.append("exact_symbol")
        if path_tokens.intersection(query_terms):
            reasons.append("path_token")
        if any(term in signature for term in query_terms):
            reasons.append("signature")
        if any(term in content for term in query_terms[:20]):
            reasons.append("lexical_content")
        if payload.get("hyde_questions"):
            reasons.append("semantic_hyde")
        return reasons or ["semantic_similarity"]

    def _rerank_score(self, base_score: float, reasons: List[str], payload: Dict[str, Any], query_terms: List[str]) -> float:
        score = float(base_score or 0.0)
        boosts = {
            "exact_symbol": 0.35,
            "signature": 0.20,
            "path_token": 0.15,
            "lexical_content": 0.08,
        }
        for reason in reasons:
            score += boosts.get(reason, 0.0)
        query_mentions_test = bool({"test", "tests", "spec", "coverage"}.intersection(query_terms))
        if payload.get("file_role") == "test":
            score += 0.10 if query_mentions_test else -0.08
        if payload.get("chunk_type") in {"function", "class", "route"}:
            score += 0.05
        return score

    def _confidence(self, score: float, reasons: List[str]) -> str:
        if score >= 0.75 or "exact_symbol" in reasons:
            return "high"
        if score >= 0.45:
            return "medium"
        return "low"

    def _suggested_next_queries(self, payload: Dict[str, Any]) -> List[str]:
        suggestions = []
        symbols = [str(item) for item in payload.get("symbols_defined") or [] if str(item).strip()]
        for symbol in symbols[:2]:
            suggestions.append(f"Find callers of {symbol}")
            suggestions.append(f"Find tests covering {symbol}")
        if payload.get("file"):
            suggestions.append(f"Show outline for {payload.get('file')}")
        return suggestions[:4]

    def _file_skeleton(self, payload: Dict[str, Any]) -> str:
        symbols = payload.get("symbols_defined") or []
        signature = payload.get("signature") or ""
        if signature:
            return str(signature)
        if symbols:
            return ", ".join(str(symbol) for symbol in symbols[:8])
        return ""
    
    async def handle_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")
        
        if request_id is None:
            # It's a notification
            logger.debug(f"Received notification: {method}")
            return None
        
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
                                    "default": DEFAULT_SEARCH_LIMIT
                                },
                                "candidate_limit": {
                                    "type": "number",
                                    "description": "Candidate count per retrieval channel before fusion/reranking",
                                    "default": DEFAULT_CANDIDATE_LIMIT
                                },
                                "include_snippet": {
                                    "type": "boolean",
                                    "description": "Whether to include source snippet content in each result",
                                    "default": True
                                },
                                "include_graph": {
                                    "type": "boolean",
                                    "description": "Reserved for graph sidecar context; currently returns compact placeholders",
                                    "default": True
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
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        if tool_name == "search":
            result = await self._search(
                query=arguments.get("query"),
                limit=arguments.get("limit", DEFAULT_SEARCH_LIMIT),
                filter_dict=arguments.get("filter"),
                candidate_limit=arguments.get("candidate_limit", DEFAULT_CANDIDATE_LIMIT),
                include_snippet=arguments.get("include_snippet", True),
                include_graph=arguments.get("include_graph", True),
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
    
    async def _search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        filter_dict: Optional[Dict] = None,
        candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
        include_snippet: bool = True,
        include_graph: bool = True,
    ) -> Dict[str, Any]:
        try:
            if not query:
                return {"error": "query is required"}
            limit = max(1, min(int(limit or DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT))
            candidate_limit = max(limit, min(int(candidate_limit or DEFAULT_CANDIDATE_LIMIT), 200))
            embeddings = await self.get_embeddings([query])
            query_embedding = embeddings[0]
            qdrant_filter = self._build_qdrant_filter(filter_dict)
            retrieval_channels = ["legacy_dense"]

            if self.use_v2_vectors:
                retrieval_channels = [
                    DENSE_VECTOR_HYDE,
                    DENSE_VECTOR_CODE,
                    DENSE_VECTOR_SUMMARY,
                    SPARSE_VECTOR_LEXICAL,
                ]
                results = await self.qdrant_client.query_points(
                    collection_name=self.collection_name,
                    prefetch=[
                        Prefetch(query=query_embedding, using=DENSE_VECTOR_HYDE, limit=candidate_limit),
                        Prefetch(query=query_embedding, using=DENSE_VECTOR_CODE, limit=candidate_limit),
                        Prefetch(query=query_embedding, using=DENSE_VECTOR_SUMMARY, limit=max(limit, candidate_limit // 2)),
                        Prefetch(query=self._make_sparse_vector(query), using=SPARSE_VECTOR_LEXICAL, limit=candidate_limit),
                    ],
                    query=FusionQuery(fusion=Fusion.RRF),
                    limit=candidate_limit,
                    query_filter=qdrant_filter,
                )
            else:
                results = await self.qdrant_client.query_points(
                    collection_name=self.collection_name,
                    query=query_embedding,
                    limit=candidate_limit,
                    query_filter=qdrant_filter,
                )
            
            query_terms = self._query_terms(query)
            candidate_records = {
                str(result.id): {
                    "id": str(result.id),
                    "score": result.score,
                    "payload": result.payload or {},
                    "source": "hybrid" if self.use_v2_vectors else "legacy_dense",
                }
                for result in results.points
            }
            for exact in await self._exact_candidates(query_terms, filter_dict, candidate_limit):
                existing = candidate_records.get(exact["id"])
                if existing:
                    existing["score"] = max(existing["score"], exact["score"])
                    existing["source"] = f"{existing['source']}+{exact['source']}"
                else:
                    candidate_records[exact["id"]] = exact

            formatted_results = []
            for record in candidate_records.values():
                payload = record["payload"]
                reasons = self._match_reasons(query_terms, payload)
                if record["source"] != "hybrid" and record["source"] != "legacy_dense":
                    reasons.insert(0, record["source"])
                rerank_score = self._rerank_score(record["score"], reasons, payload, query_terms)
                item = {
                    "id": record["id"],
                    "score": rerank_score,
                    "raw_score": record["score"],
                    "confidence": self._confidence(rerank_score, reasons),
                    "match_reasons": reasons,
                    "file": payload.get("file"),
                    "start_line": payload.get("start_line"),
                    "end_line": payload.get("end_line"),
                    "line_range": payload.get("line_range"),
                    "chunk_type": payload.get("chunk_type"),
                    "language": payload.get("language"),
                    "file_role": payload.get("file_role"),
                    "signature": payload.get("signature"),
                    "symbols_defined": payload.get("symbols_defined") or [],
                    "what_it_does": payload.get("what_it_does"),
                    "file_skeleton": self._file_skeleton(payload),
                    "suggested_next_queries": self._suggested_next_queries(payload),
                    "metadata": payload,
                }
                if include_snippet:
                    item["snippet"] = payload.get("content")
                if include_graph:
                    item["graph_context"] = {
                        "calls": payload.get("calls") or [],
                        "called_by": payload.get("called_by") or [],
                        "tests": payload.get("tests") or [],
                    }
                formatted_results.append(item)

            formatted_results.sort(key=lambda item: item["score"], reverse=True)
            formatted_results = formatted_results[:limit]
            for index, item in enumerate(formatted_results, start=1):
                item["rank"] = index

            return {
                "query": query,
                "count": len(formatted_results),
                "strategy": {
                    "schema": "agentic-hybrid-v1" if self.use_v2_vectors else "legacy-dense-v1",
                    "collection": self.collection_name,
                    "retrieval": retrieval_channels,
                    "fusion": "rrf" if self.use_v2_vectors else "none",
                    "rerank": "deterministic-v1",
                    "candidate_limit": candidate_limit,
                    "limit": limit,
                },
                "results": formatted_results
            }
        except Exception as e:
            logger.error(f"Search error: {e}")
            return {"error": str(e)}
    
    async def _get_collection_info(self) -> Dict[str, Any]:
        try:
            info = await self.qdrant_client.get_collection(self.collection_name)
            
            vectors_count = getattr(info, 'vectors_count', None)
            points_count = getattr(info, 'points_count', None)
            
            vector_size = None
            distance = None
            dense_vectors = []
            sparse_vectors = []
            try:
                if hasattr(info.config.params, 'vectors') and hasattr(info.config.params.vectors, 'size'):
                    vector_size = info.config.params.vectors.size
                    distance = info.config.params.vectors.distance.value
                    dense_vectors = ["default"]
                elif hasattr(info.config.params, 'vectors') and isinstance(info.config.params.vectors, dict):
                    dense_vectors = sorted(info.config.params.vectors.keys())
                    first = next(iter(info.config.params.vectors.values()), None)
                    if first is not None:
                        vector_size = getattr(first, "size", None)
                        dist = getattr(first, "distance", None)
                        distance = getattr(dist, "value", str(dist)) if dist is not None else None
                sparse_config = getattr(info.config.params, "sparse_vectors", None)
                if isinstance(sparse_config, dict):
                    sparse_vectors = sorted(sparse_config.keys())
            except Exception:
                pass
                
            return {
                "name": self.collection_name,
                "vectors_count": vectors_count,
                "points_count": points_count,
                "schema": "agentic-hybrid-v1" if self.use_v2_vectors else "legacy-dense-v1",
                "config": {
                    "vector_size": vector_size,
                    "distance": distance,
                    "dense_vectors": dense_vectors,
                    "sparse_vectors": sparse_vectors,
                    "default_limit": DEFAULT_SEARCH_LIMIT,
                    "max_limit": MAX_SEARCH_LIMIT,
                },
                "capabilities": {
                    "line_ranges": True,
                    "hybrid_search": self.use_v2_vectors,
                    "exact_symbol_candidates": True,
                    "deterministic_rerank": True,
                    "graph_sidecar": False,
                },
            }
        except Exception as e:
            logger.error(f"Collection info error: {e}")
            return {"error": str(e)}
    
    def _error_response(self, request_id: Any, message: str) -> Dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32603,
                "message": message
            }
        }

async def process_stdio():
    server = MCPServer()
    await server.initialize()
    logger.info("MCP Qdrant OpenAI server started")
    
    loop = asyncio.get_event_loop()
    
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    
    while True:
        try:
            line_bytes = await reader.readline()
            if not line_bytes:
                logger.info("EOF received, shutting down")
                break
                
            line = line_bytes.decode('utf-8').strip()
            if not line:
                continue
                
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
            response = await server.handle_request(request)
            
            if response:
                response_str = json.dumps(response)
                sys.stdout.write(response_str + '\n')
                sys.stdout.flush()
                logger.debug(f"Sent response: {response_str}")
                
        except Exception as e:
            logger.error(f"Error in main loop: {e}", exc_info=True)
            
async def main():
    try:
        await process_stdio()
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        logger.info("Running in test mode")
        sys.exit(0)
    
    asyncio.run(main())
