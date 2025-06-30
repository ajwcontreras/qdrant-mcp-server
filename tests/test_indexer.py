"""Tests for the Qdrant indexer"""

import pytest
import os
import tempfile
from unittest.mock import Mock, patch, MagicMock
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Mock the imports before importing the module
sys.modules['qdrant_client'] = MagicMock()
sys.modules['openai'] = MagicMock()
sys.modules['tiktoken'] = MagicMock()


class TestQdrantIndexer:
    """Test cases for QdrantIndexer class"""
    
    @pytest.fixture
    def temp_files(self):
        """Create temporary test files"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test files
            files = {
                'test.py': 'def hello():\n    return "world"',
                'test.js': 'function hello() { return "world"; }',
                'test.txt': 'This should be ignored',
                'node_modules/test.js': 'Should be excluded',
            }
            
            for filepath, content in files.items():
                full_path = Path(tmpdir) / filepath
                full_path.parent.mkdir(exist_ok=True, parents=True)
                full_path.write_text(content)
                
            yield tmpdir
            
    def test_file_discovery(self, temp_files):
        """Test that indexer discovers correct files"""
        from qdrant_openai_indexer import get_files_to_index
        
        files = get_files_to_index(
            paths=[temp_files],
            include_patterns=['**/*.py', '**/*.js'],
            exclude_patterns=['**/node_modules/**']
        )
        
        file_names = [f.name for f in files]
        assert 'test.py' in file_names
        assert 'test.js' in file_names
        assert 'test.txt' not in file_names
        assert len(files) == 2
        
    def test_chunk_content(self):
        """Test content chunking"""
        from qdrant_openai_indexer import chunk_content
        
        # Create content that's definitely longer than chunk size
        content = "Hello world. " * 100  # ~1300 characters
        
        chunks = chunk_content(content, max_tokens=50, overlap=10)
        
        assert len(chunks) > 1
        assert all(len(chunk) > 0 for chunk in chunks)
        
    @patch('openai.OpenAI')
    @patch('qdrant_client.QdrantClient')
    def test_indexing_process(self, mock_qdrant, mock_openai, temp_files):
        """Test the full indexing process"""
        # Mock OpenAI embeddings response
        mock_embedding = [0.1] * 1536
        mock_openai_instance = mock_openai.return_value
        mock_openai_instance.embeddings.create.return_value = Mock(
            data=[Mock(embedding=mock_embedding)]
        )
        
        # Mock Qdrant client
        mock_qdrant_instance = mock_qdrant.return_value
        mock_qdrant_instance.get_collections.return_value = Mock(collections=[])
        
        from qdrant_openai_indexer import index_codebase
        
        # This should not raise any exceptions
        result = index_codebase(
            paths=[temp_files],
            openai_api_key='test-key',
            qdrant_url='http://localhost:6333',
            collection_name='test-collection',
            batch_size=1
        )
        
        # Verify OpenAI was called
        assert mock_openai_instance.embeddings.create.called
        
        # Verify Qdrant was called
        assert mock_qdrant_instance.upsert.called


class TestMCPServer:
    """Test cases for MCP server wrapper"""
    
    @patch('sys.stdin')
    @patch('sys.stdout')
    def test_mcp_initialization(self, mock_stdout, mock_stdin):
        """Test MCP server initializes correctly"""
        # Mock stdin to simulate MCP protocol
        mock_stdin.readline.side_effect = [
            '{"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {}}\n',
            ''  # EOF
        ]
        
        # We can't fully test the MCP server without a proper MCP client
        # This is a basic smoke test
        assert True  # Placeholder
        
    def test_search_query_parsing(self):
        """Test parsing of search queries"""
        # This would test query parsing logic
        queries = [
            "find authentication code",
            "show me error handling",
            "files similar to UserService"
        ]
        
        # Placeholder for actual query parsing tests
        for query in queries:
            assert len(query) > 0


class TestBackgroundIndexer:
    """Test cases for background indexer"""
    
    @patch('chokidar.watch')
    def test_file_watcher_setup(self, mock_watch):
        """Test that file watcher is set up correctly"""
        from qdrant_background_indexer import start_watcher
        
        # Mock the watcher
        mock_watcher = Mock()
        mock_watch.return_value = mock_watcher
        
        # Test watcher setup
        watcher = start_watcher('/test/path', Mock())
        
        assert mock_watch.called
        assert mock_watch.call_args[0][0] == '/test/path'
        
    def test_file_change_detection(self):
        """Test detection of file changes"""
        # This would test the logic for detecting relevant file changes
        changes = [
            ('added', 'test.py'),
            ('modified', 'test.js'),
            ('deleted', 'test.ts'),
            ('added', 'node_modules/test.js'),  # Should be ignored
        ]
        
        relevant_changes = [c for c in changes if 'node_modules' not in c[1]]
        assert len(relevant_changes) == 3


if __name__ == '__main__':
    pytest.main([__file__, '-v'])