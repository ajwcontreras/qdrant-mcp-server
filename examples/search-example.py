#!/usr/bin/env python3
"""
Example of programmatic usage of qdrant-mcp-server for semantic code search
"""

import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
import openai
from typing import List, Dict
import json


class CodeSearcher:
    """Simple semantic code searcher using Qdrant"""
    
    def __init__(self, qdrant_url: str = "localhost", collection_name: str = "codebase"):
        self.client = QdrantClient(url=qdrant_url)
        self.collection_name = collection_name
        self.openai_client = openai.OpenAI()
        
    def search(self, query: str, limit: int = 10) -> List[Dict]:
        """Search for code semantically similar to the query"""
        
        # Generate embedding for query
        response = self.openai_client.embeddings.create(
            model="text-embedding-3-small",
            input=query
        )
        query_embedding = response.data[0].embedding
        
        # Search in Qdrant
        results = self.client.search(
            collection_name=self.collection_name,
            query_vector=query_embedding,
            limit=limit,
            with_payload=True
        )
        
        # Format results
        formatted_results = []
        for result in results:
            formatted_results.append({
                "file_path": result.payload.get("file_path", "Unknown"),
                "content": result.payload.get("content", "")[:200] + "...",
                "score": result.score,
                "language": result.payload.get("language", "Unknown"),
                "functions": result.payload.get("functions", []),
                "classes": result.payload.get("classes", [])
            })
            
        return formatted_results
    
    def search_by_function(self, function_name: str) -> List[Dict]:
        """Search for files containing a specific function"""
        
        # Search with function-specific query
        query = f"function named {function_name} implementation code"
        results = self.search(query, limit=20)
        
        # Filter by function name in metadata
        filtered = []
        for result in results:
            if function_name.lower() in [f.lower() for f in result.get("functions", [])]:
                filtered.append(result)
                
        return filtered
    
    def find_similar_code(self, file_path: str) -> List[Dict]:
        """Find code similar to a given file"""
        
        # Read the file content
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            print(f"Error reading file: {e}")
            return []
            
        # Search for similar code
        return self.search(content[:1000], limit=10)  # Use first 1000 chars


def main():
    """Example usage"""
    
    # Check for API key
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY environment variable is required")
        sys.exit(1)
        
    # Initialize searcher
    searcher = CodeSearcher(
        qdrant_url=os.getenv("QDRANT_URL", "localhost"),
        collection_name="codebase"
    )
    
    print("Qdrant Code Search Example\n")
    
    # Example 1: Basic semantic search
    print("Example 1: Semantic search for 'authentication'")
    print("-" * 50)
    results = searcher.search("user authentication and login", limit=5)
    for i, result in enumerate(results, 1):
        print(f"{i}. {result['file_path']} (score: {result['score']:.3f})")
        print(f"   Language: {result['language']}")
        print(f"   Preview: {result['content'][:100]}...")
        print()
    
    # Example 2: Search by function name
    print("\nExample 2: Search for function 'validateUser'")
    print("-" * 50)
    results = searcher.search_by_function("validateUser")
    for result in results:
        print(f"- {result['file_path']}")
        print(f"  Functions: {', '.join(result['functions'][:3])}")
        
    # Example 3: Find similar code
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
        print(f"\nExample 3: Find code similar to {file_path}")
        print("-" * 50)
        results = searcher.find_similar_code(file_path)
        for i, result in enumerate(results[:5], 1):
            print(f"{i}. {result['file_path']} (similarity: {result['score']:.3f})")
    
    # Example 4: Pattern search
    print("\nExample 4: Search for error handling patterns")
    print("-" * 50)
    results = searcher.search("try catch error handling exception logging", limit=5)
    for result in results:
        print(f"- {result['file_path']}")
        if result['classes']:
            print(f"  Classes: {', '.join(result['classes'][:3])}")
            
    print("\nSearch complete!")


if __name__ == "__main__":
    main()