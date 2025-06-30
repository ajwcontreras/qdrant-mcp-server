#!/usr/bin/env python3
"""
Qdrant OpenAI Indexer for KinDash Codebase

This script indexes the codebase into Qdrant using OpenAI embeddings.
It's designed to work with the MCP server wrapper for semantic code search.

Usage:
    python scripts/qdrant-openai-indexer.py [directory]
    
Environment variables:
    OPENAI_API_KEY - Required for generating embeddings
"""

import os
import sys
import json
import hashlib
import argparse
from pathlib import Path
from typing import List, Dict, Any, Optional
import logging
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams, PointStruct
except ImportError as e:
    logger.error(f"Required package not installed: {e}")
    logger.error("Please install: pip install openai qdrant-client")
    sys.exit(1)

# File extensions to index
VALID_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx', '.json', '.prisma', 
    '.md', '.mdx', '.css', '.scss', '.sql', '.sh', 
    '.yml', '.yaml', '.env.example'
}

# Directories to exclude
EXCLUDE_DIRS = {
    'node_modules', '.git', 'dist', 'build', '.next',
    'coverage', '.turbo', 'out', '.cache', '__pycache__',
    '.pytest_cache', '.vscode', '.idea', 'tmp', 'temp'
}

# Files to exclude
EXCLUDE_FILES = {
    '.DS_Store', 'package-lock.json', 'yarn.lock', 
    'pnpm-lock.yaml', '.gitignore', '.env'
}

class CodebaseIndexer:
    """Indexes codebase files into Qdrant with OpenAI embeddings"""
    
    def __init__(self, collection_name: str = "kindash-codebase-openai"):
        self.openai_api_key = os.environ.get("OPENAI_API_KEY")
        if not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")
            
        self.collection_name = collection_name
        self.qdrant_url = os.environ.get("QDRANT_URL", "http://localhost:6333")
        self.embedding_model = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
        
        # Initialize clients
        self.openai_client = OpenAI(api_key=self.openai_api_key)
        self.qdrant_client = QdrantClient(url=self.qdrant_url)
        
        # Statistics
        self.stats = {
            "files_processed": 0,
            "files_skipped": 0,
            "total_tokens": 0,
            "errors": 0
        }
        
        # Ensure collection exists
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
                logger.info(f"Collection {self.collection_name} created successfully")
            else:
                logger.info(f"Collection {self.collection_name} already exists")
                
                # Get collection info
                info = self.qdrant_client.get_collection(self.collection_name)
                logger.info(f"Current points: {info.points_count}")
                
        except Exception as e:
            logger.error(f"Failed to ensure collection: {e}")
            raise
    
    def _should_index_file(self, file_path: Path) -> bool:
        """Check if file should be indexed"""
        # Check extension
        if file_path.suffix not in VALID_EXTENSIONS:
            return False
            
        # Check if file is excluded
        if file_path.name in EXCLUDE_FILES:
            return False
            
        # Check file size (skip very large files)
        try:
            size = file_path.stat().st_size
            if size > 1024 * 1024:  # 1MB limit
                logger.warning(f"Skipping large file: {file_path} ({size} bytes)")
                return False
        except:
            return False
            
        return True
    
    def _collect_files(self, directory: Path) -> List[Path]:
        """Recursively collect all files to index"""
        files = []
        
        for item in directory.iterdir():
            # Skip excluded directories
            if item.is_dir() and item.name not in EXCLUDE_DIRS:
                files.extend(self._collect_files(item))
            elif item.is_file() and self._should_index_file(item):
                files.append(item)
                
        return files
    
    def _extract_content(self, file_path: Path, base_path: Path) -> str:
        """Extract semantic content from file"""
        try:
            content = file_path.read_text(encoding='utf-8')
            relative_path = file_path.relative_to(base_path)
            
            # Build semantic description
            description = f"File: {relative_path}\n"
            description += f"Type: {file_path.suffix[1:]} file\n"
            description += f"Directory: {relative_path.parent}\n\n"
            
            # Add file-specific context
            if file_path.suffix in ['.tsx', '.jsx']:
                # React components
                if 'export default' in content or 'export const' in content:
                    description += "React component file. "
                if 'useState' in content or 'useEffect' in content:
                    description += "Uses React hooks. "
                    
            elif file_path.suffix in ['.ts', '.js']:
                # TypeScript/JavaScript
                if 'class ' in content:
                    description += "Contains class definitions. "
                if 'interface ' in content:
                    description += "Contains TypeScript interfaces. "
                if 'app.get' in content or 'app.post' in content:
                    description += "API endpoint definitions. "
                    
            elif file_path.suffix == '.prisma':
                # Prisma schema
                description += "Database schema file. "
                if 'model ' in content:
                    models = [line.split()[1] for line in content.split('\n') if line.strip().startswith('model ')]
                    description += f"Models: {', '.join(models[:5])}. "
                    
            # Add first few lines of actual content
            lines = content.split('\n')[:20]
            description += "\nContent preview:\n"
            description += '\n'.join(lines)
            
            return description
            
        except Exception as e:
            logger.error(f"Failed to extract content from {file_path}: {e}")
            return ""
    
    def _create_metadata(self, file_path: Path, base_path: Path) -> Dict[str, Any]:
        """Create metadata for the file"""
        relative_path = file_path.relative_to(base_path)
        
        return {
            "file": str(relative_path),
            "type": file_path.suffix[1:] if file_path.suffix else "unknown",
            "directory": str(relative_path.parent),
            "size": file_path.stat().st_size,
            "modified": datetime.fromtimestamp(file_path.stat().st_mtime).isoformat(),
            "indexed_at": datetime.now().isoformat()
        }
    
    def _generate_file_id(self, file_path: Path, base_path: Path) -> str:
        """Generate deterministic ID for file"""
        relative_path = str(file_path.relative_to(base_path))
        return hashlib.md5(relative_path.encode()).hexdigest()
    
    def _batch_generate_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for multiple texts"""
        try:
            response = self.openai_client.embeddings.create(
                model=self.embedding_model,
                input=texts
            )
            
            # Update token count (estimate)
            for text in texts:
                self.stats["total_tokens"] += len(text.split()) * 1.3
                
            return [data.embedding for data in response.data]
            
        except Exception as e:
            logger.error(f"Failed to generate embeddings: {e}")
            raise
    
    def index_directory(self, directory: str, batch_size: int = 10):
        """Index all files in a directory"""
        base_path = Path(directory).resolve()
        
        if not base_path.exists():
            logger.error(f"Directory not found: {directory}")
            return
            
        logger.info(f"Indexing directory: {base_path}")
        
        # Collect files
        files = self._collect_files(base_path)
        logger.info(f"Found {len(files)} files to index")
        
        # Process in batches
        for i in range(0, len(files), batch_size):
            batch_files = files[i:i + batch_size]
            batch_contents = []
            batch_metadata = []
            batch_ids = []
            
            # Prepare batch
            for file_path in batch_files:
                content = self._extract_content(file_path, base_path)
                if content:
                    batch_contents.append(content)
                    batch_metadata.append(self._create_metadata(file_path, base_path))
                    batch_ids.append(self._generate_file_id(file_path, base_path))
                    self.stats["files_processed"] += 1
                else:
                    self.stats["files_skipped"] += 1
            
            if not batch_contents:
                continue
                
            try:
                # Generate embeddings
                logger.info(f"Generating embeddings for batch {i//batch_size + 1}/{(len(files) + batch_size - 1)//batch_size}")
                embeddings = self._batch_generate_embeddings(batch_contents)
                
                # Create points
                points = []
                for j, (embedding, metadata, point_id) in enumerate(zip(embeddings, batch_metadata, batch_ids)):
                    points.append(
                        PointStruct(
                            id=point_id,
                            vector=embedding,
                            payload=metadata
                        )
                    )
                
                # Upsert to Qdrant
                result = self.qdrant_client.upsert(
                    collection_name=self.collection_name,
                    points=points,
                    wait=True
                )
                
                logger.info(f"Indexed {len(points)} files")
                
            except Exception as e:
                logger.error(f"Failed to index batch: {e}")
                self.stats["errors"] += 1
                
        # Print statistics
        self._print_stats()
    
    def index_file(self, file_path: Path) -> bool:
        """Index a single file"""
        try:
            if not self._should_index_file(file_path):
                logger.info(f"Skipping file: {file_path}")
                return False
                
            # Get base path (parent directory)
            base_path = file_path.parent
            
            # Extract content and metadata
            content = self._extract_content(file_path, base_path)
            if not content:
                logger.warning(f"No content extracted from: {file_path}")
                return False
                
            metadata = self._create_metadata(file_path, base_path)
            file_id = self._generate_file_id(file_path, base_path)
            
            # Generate embedding
            logger.info(f"Generating embedding for: {file_path}")
            embeddings = self._batch_generate_embeddings([content])
            if not embeddings:
                logger.error(f"Failed to generate embedding for: {file_path}")
                return False
                
            # Store in Qdrant
            point = PointStruct(
                id=file_id,
                vector=embeddings[0],
                payload=metadata
            )
            
            self.qdrant_client.upsert(
                collection_name=self.collection_name,
                points=[point]
            )
            
            logger.info(f"Successfully indexed: {file_path}")
            self.stats['files_processed'] += 1
            return True
            
        except Exception as e:
            logger.error(f"Failed to index file {file_path}: {e}")
            self.stats['errors'] += 1
            return False
    
    def _print_stats(self):
        """Print indexing statistics"""
        logger.info("\n" + "="*50)
        logger.info("Indexing Complete!")
        logger.info("="*50)
        logger.info(f"Files processed: {self.stats['files_processed']}")
        logger.info(f"Files skipped: {self.stats['files_skipped']}")
        logger.info(f"Errors: {self.stats['errors']}")
        logger.info(f"Estimated tokens used: {self.stats['total_tokens']:,.0f}")
        
        # Estimate cost
        cost = (self.stats['total_tokens'] / 1_000_000) * 0.02  # $0.02 per 1M tokens
        logger.info(f"Estimated cost: ${cost:.4f}")
        
        # Get final collection info
        try:
            info = self.qdrant_client.get_collection(self.collection_name)
            logger.info(f"Total points in collection: {info.points_count}")
        except:
            pass

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Index codebase into Qdrant with OpenAI embeddings"
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Directory to index (default: current directory)"
    )
    parser.add_argument(
        "--collection",
        default="kindash-codebase-openai",
        help="Qdrant collection name"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=10,
        help="Batch size for processing files"
    )
    parser.add_argument(
        "--file",
        help="Index a single file (for background indexer)"
    )
    
    args = parser.parse_args()
    
    # Check for API key
    if not os.environ.get("OPENAI_API_KEY"):
        logger.error("OPENAI_API_KEY environment variable is required")
        logger.error("Export it with: export OPENAI_API_KEY='your-key-here'")
        sys.exit(1)
    
    # Create indexer
    indexer = CodebaseIndexer(collection_name=args.collection)
    
    if args.file:
        # Single file mode for background indexer
        file_path = Path(args.file)
        if file_path.exists() and file_path.is_file():
            success = indexer.index_file(file_path)
            sys.exit(0 if success else 1)
        else:
            logger.error(f"File not found: {args.file}")
            sys.exit(1)
    else:
        # Directory mode
        indexer.index_directory(args.directory, batch_size=args.batch_size)

if __name__ == "__main__":
    main()